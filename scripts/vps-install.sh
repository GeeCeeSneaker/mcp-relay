#!/usr/bin/env bash
# MCPRelay VPS installer (M2 tunnel account, M3 gateway, M4 Caddy). Idempotent.
# Run as root on the VPS. Real values are passed at run time, never committed.
#
#   vps-install.sh --domain <mcp-domain> --bundle <mcp-gateway-*.tar.gz> \
#                  --config-dir <dir with repo config/vps> \
#                  --node <name>:<vps-port>:<node-pubkey-file>[:<bridge-token-file>] [--node ...] \
#                  [--gateway-user <name>] [--allow-client <oauth-client-id> ...]
#
# --allow-client pins which OAuth clients may start an authorization through
# the public edge (e.g. the Owner's ChatGPT connector CIMD URL). Without it the
# edge accepts any client (first-connection mode) and a warning is printed.
#
# Secrets (gateway encryption key, gateway login password) are generated on the
# host on first run and never printed. The password is stored root-only in
# /root/mcprelay-gateway-password for the Owner to read over their own SSH.
set -euo pipefail

UV_VERSION=0.12.19
UV_SHA256=23bf5552d220e0842b65c862097b2ebaeba0064b74eda5e565e77fd25969d8c8
CADDY_VERSION=2.11.4
CADDY_SHA512=8220d1f013b6f27510247b2360c9e0ca9f018feebd82515f07635318b34ff9777ccc8fd0b6e6f2486ce3a33fe389fbb7db12d05baa474f4587509fb4f5ebf1c9
PYTHON_VERSION=3.12

domain='' bundle='' cfg='' gw_user=owner
nodes=() clients=()
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) domain=$2; shift 2 ;;
    --bundle) bundle=$2; shift 2 ;;
    --config-dir) cfg=$2; shift 2 ;;
    --node) nodes+=("$2"); shift 2 ;;
    --gateway-user) gw_user=$2; shift 2 ;;
    --allow-client) clients+=("$2"); shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$domain" ] && [ -f "$bundle" ] && [ -d "$cfg" ] && [ ${#nodes[@]} -gt 0 ] || { echo "missing arguments" >&2; exit 2; }
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }

log() { echo "[vps-install] $*"; }
# Debian/Ubuntu name the unit ssh.service, RHEL-family sshd.service.
reload_sshd() { systemctl reload ssh 2>/dev/null || systemctl reload sshd; }
BIN=/opt/mcprelay/bin
mkdir -p "$BIN" /etc/mcprelay

# --- pinned binaries ---------------------------------------------------------
fetch() { # url sha-cmd expected dest-dir
  local tmp; tmp=$(mktemp -d)
  curl -fsSL --retry 3 -o "$tmp/a.tgz" "$1"
  echo "$3  $tmp/a.tgz" | $2 -c --quiet
  tar -xzf "$tmp/a.tgz" -C "$tmp"
  echo "$tmp"
}
if [ "$("$BIN/uv" --version 2>/dev/null | awk '{print $2}')" != "$UV_VERSION" ]; then
  log "install uv $UV_VERSION"
  t=$(fetch "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-x86_64-unknown-linux-gnu.tar.gz" sha256sum "$UV_SHA256")
  install -m 0755 "$t/uv-x86_64-unknown-linux-gnu/uv" "$BIN/uv"; rm -rf "$t"
fi
if ! "$BIN/caddy" version 2>/dev/null | grep -q "^v$CADDY_VERSION "; then
  log "install caddy $CADDY_VERSION"
  t=$(fetch "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION/caddy_${CADDY_VERSION}_linux_amd64.tar.gz" sha512sum "$CADDY_SHA512")
  install -m 0755 "$t/caddy" "$BIN/caddy"; rm -rf "$t"
fi

# --- accounts ----------------------------------------------------------------
mkuser() { # name home
  id "$1" >/dev/null 2>&1 || useradd --system --home-dir "$2" --create-home --shell /sbin/nologin "$1"
}
mkuser mcprelay /var/lib/mcprelay
mkuser caddy /var/lib/caddy
mkuser mcptunnel /var/lib/mcptunnel
chmod 0750 /var/lib/mcprelay /var/lib/caddy
chmod 0755 /var/lib/mcptunnel

# --- gateway -----------------------------------------------------------------
log "install gateway from $(basename "$bundle")"
rm -rf /opt/mcprelay/gateway/src && mkdir -p /opt/mcprelay/gateway/src
tar -xzf "$bundle" -C /opt/mcprelay/gateway/src
export UV_PYTHON_INSTALL_DIR=/opt/mcprelay/python UV_CACHE_DIR=/var/cache/mcprelay-uv
[ -x /opt/mcprelay/gateway/.venv/bin/python ] || "$BIN/uv" venv -q --python "$PYTHON_VERSION" /opt/mcprelay/gateway/.venv
"$BIN/uv" pip install -q --python /opt/mcprelay/gateway/.venv/bin/python --reinstall-package mcp-gateway /opt/mcprelay/gateway/src
chmod -R a+rX /opt/mcprelay

umask 077
[ -s /etc/mcprelay/gateway.key ] || openssl rand -base64 32 > /etc/mcprelay/gateway.key
[ -s /root/mcprelay-gateway-password ] || openssl rand -base64 24 | tr -d '/+=' | cut -c1-24 > /root/mcprelay-gateway-password
hash=$(/opt/mcprelay/gateway/.venv/bin/python -c 'import bcrypt,sys; print(bcrypt.hashpw(open(sys.argv[1]).read().strip().encode(), bcrypt.gensalt(12)).decode())' /root/mcprelay-gateway-password)
umask 022

backends=''
for n in "${nodes[@]}"; do
  IFS=: read -r name port _ tokfile <<<"$n"
  backends+="  $name:"$'\n'"    url: http://127.0.0.1:$port/mcp"$'\n'"    auth:"$'\n'
  if [ -n "${tokfile:-}" ]; then
    # Bridge bearer token: only the gateway may call the node's bridge.
    tok=$(tr -d '[:space:]' < "$tokfile")
    [ ${#tok} -ge 32 ] || { echo "bridge token in $tokfile is too short" >&2; exit 1; }
    backends+="      type: bearer"$'\n'"      token: \"$tok\""$'\n'
  else
    backends+="      type: none"$'\n'
  fi
done
python3 - "$cfg/gateway.template.yaml" /etc/mcprelay/gateway.yaml "$domain" "$gw_user" "$hash" "$backends" <<'PY'
import sys
src, dst, domain, user, pwhash, backends = sys.argv[1:]
t = open(src).read()
t = t.replace('<mcp-domain>', domain).replace('<gateway-user>', user).replace('<bcrypt-hash>', pwhash)
t = t.replace('<backends>\n', backends)
open(dst, 'w').write(t)
PY
allowlist=''
if [ ${#clients[@]} -gt 0 ]; then
  q=''
  for c in "${clients[@]}"; do
    case "$c" in https://*) ;; *) echo "--allow-client must be an https client_id URL" >&2; exit 2 ;; esac
    q+=" client_id=$c"
  done
  allowlist=$'\t@foreign_client {\n\t\tnot remote_ip 127.0.0.1 ::1\n\t\tpath /authorize\n\t\tnot query'"$q"$'\n\t}\n\trespond @foreign_client "OAuth client not allowed" 403\n'
else
  log "WARNING: no --allow-client given; any OAuth client may start an authorization"
fi
python3 - "$cfg/Caddyfile.template" /etc/mcprelay/Caddyfile "$domain" "$allowlist" <<'PY'
import sys
src, dst, domain, allowlist = sys.argv[1:]
t = open(src).read().replace('<mcp-domain>', domain).replace('<client-allowlist>\n', allowlist)
t = '\n'.join(l for l in t.split('\n') if '<acme-email>' not in l)
open(dst, 'w').write(t)
PY
/opt/mcprelay/bin/caddy validate --config /etc/mcprelay/Caddyfile --adapter caddyfile >/dev/null
# Operator tests on this host reach the public name via loopback (exempt above).
grep -q "mcprelay local ops" /etc/hosts || echo "127.0.0.1 $domain # mcprelay local ops" >> /etc/hosts
find /var/lib/mcprelay -maxdepth 1 -name 'gateway.db*' -exec chmod 0600 {} +
chown root:mcprelay /etc/mcprelay/gateway.yaml /etc/mcprelay/gateway.key
chmod 0640 /etc/mcprelay/gateway.yaml /etc/mcprelay/gateway.key
chmod 0644 /etc/mcprelay/Caddyfile
MCP_GATEWAY_ENCRYPTION_KEY_FILE=/etc/mcprelay/gateway.key \
  runuser -u mcprelay -- /opt/mcprelay/gateway/.venv/bin/mcp-gateway check -c /etc/mcprelay/gateway.yaml

# --- tunnel account (M2) -----------------------------------------------------
log "configure mcptunnel authorized_keys"
install -d -m 0700 -o mcptunnel -g mcptunnel /var/lib/mcptunnel/.ssh
ak=/var/lib/mcptunnel/.ssh/authorized_keys
: > "$ak.new"
for n in "${nodes[@]}"; do
  IFS=: read -r name port keyfile _ <<<"$n"
  key=$(awk 'NF>=2 && $1 ~ /^ssh-/ {print $1" "$2; exit}' "$keyfile")
  [ -n "$key" ] || { echo "no public key in $keyfile" >&2; exit 1; }
  echo "restrict,port-forwarding,permitlisten=\"127.0.0.1:$port\" $key mcprelay-node-$name" >> "$ak.new"
done
install -m 0600 -o mcptunnel -g mcptunnel "$ak.new" "$ak"; rm -f "$ak.new"

# The mcptunnel Match block is kept identical to the repo template. It is the
# last block in sshd_config (Match blocks run to end of file), so it is replaced
# by truncating at its first line and appending the template.
current_block=$(sed -n '/^Match User mcptunnel/,$p' /etc/ssh/sshd_config)
wanted_block=$(grep -v '^#' "$cfg/sshd-mcptunnel.conf" | sed '/^$/d')
if [ "$(printf '%s\n' "$current_block" | grep -v '^#' | sed '/^$/d')" != "$wanted_block" ]; then
  log "install sshd Match block for mcptunnel"
  cp -p /etc/ssh/sshd_config /etc/ssh/sshd_config.mcprelay-bak
  if grep -q '^Match User mcptunnel' /etc/ssh/sshd_config; then
    sed -i '/^Match User mcptunnel/,$d' /etc/ssh/sshd_config
    # drop the comment lines that preceded the old block
    sed -i -e :a -e '/^\n*$/{$d;N;ba' -e '}' /etc/ssh/sshd_config
    while tail -1 /etc/ssh/sshd_config | grep -q '^#'; do sed -i '$d' /etc/ssh/sshd_config; done
  fi
  { echo; cat "$cfg/sshd-mcptunnel.conf"; } >> /etc/ssh/sshd_config
  if ! sshd -t; then
    cp -p /etc/ssh/sshd_config.mcprelay-bak /etc/ssh/sshd_config
    echo "sshd config test failed; restored backup" >&2; exit 1
  fi
  reload_sshd
fi

# --- journal size cap ----------------------------------------------------------
# All service logs go to journald; cap them so logs never fill the disk.
install -d /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/mcprelay-size-limit.conf.new <<'EOF'
[Journal]
SystemMaxUse=200M
SystemKeepFree=2G
MaxRetentionSec=7day
EOF
if ! cmp -s /etc/systemd/journald.conf.d/mcprelay-size-limit.conf.new /etc/systemd/journald.conf.d/mcprelay-size-limit.conf; then
  mv /etc/systemd/journald.conf.d/mcprelay-size-limit.conf.new /etc/systemd/journald.conf.d/mcprelay-size-limit.conf
  systemctl restart systemd-journald; log "journald capped at 200M / 7 days"
else rm -f /etc/systemd/journald.conf.d/mcprelay-size-limit.conf.new; fi

# --- services ----------------------------------------------------------------
echo "$domain" > /etc/mcprelay/domain
install -m 0755 "$cfg/mcprelay-watchdog.sh" "$BIN/mcprelay-watchdog.sh"
install -m 0644 "$cfg/systemd/mcprelay-gateway.service" "$cfg/systemd/mcprelay-caddy.service" \
  "$cfg/systemd/mcprelay-watchdog.service" "$cfg/systemd/mcprelay-watchdog.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable -q mcprelay-gateway mcprelay-caddy
systemctl enable -q --now mcprelay-watchdog.timer
systemctl restart mcprelay-gateway mcprelay-caddy
sleep 3
systemctl is-active mcprelay-gateway mcprelay-caddy mcprelay-watchdog.timer
log "done"
