#!/usr/bin/env bash
# MCPRelay ingress-host hardening (run as root). Idempotent; backs up what it
# edits and prints every change. Mitigations only. An unsupported/unpatched OS
# still needs an OS upgrade (see the security review).
#
#   vps-harden.sh
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
log() { echo "[vps-harden] $*"; }
stamp=$(date +%Y%m%d%H%M%S)

# 1. Local privilege-escalation surface of SUID helpers the host does not need.
#    pkexec (PwnKit CVE-2021-4034 on unpatched polkit): drop SUID.
if [ -u /usr/bin/pkexec ]; then chmod u-s /usr/bin/pkexec; log "pkexec: SUID removed"; fi
#    sudo (Baron Samedit CVE-2021-3156 on unpatched sudo): only root/wheel may run it,
#    so compromised service accounts (mcprelay, caddy, mcptunnel) cannot exploit it.
if [ -e /usr/bin/sudo ] && [ "$(stat -c '%a %G' /usr/bin/sudo)" != "4110 wheel" ]; then
  chgrp wheel /usr/bin/sudo && chmod 4110 /usr/bin/sudo; log "sudo: executable by root and wheel only"
fi

# 2. Kernel attack surface for unprivileged users.
cat > /etc/sysctl.d/90-mcprelay-hardening.conf <<'EOF'
# MCPRelay hardening: close common unprivileged kernel-exploit paths.
user.max_user_namespaces = 0
kernel.unprivileged_bpf_disabled = 1
kernel.kptr_restrict = 2
kernel.dmesg_restrict = 1
EOF
sysctl -q -p /etc/sysctl.d/90-mcprelay-hardening.conf && log "sysctl hardening applied"

# 3. sshd global options (must precede any Match block).
cfg=/etc/ssh/sshd_config
cp -p "$cfg" "$cfg.harden-$stamp"
set_opt() { # key value
  if grep -qE "^$1 " "$cfg"; then sed -i "0,/^$1 .*/s//$1 $2/" "$cfg"
  else sed -i "0,/^Match /s//$1 $2\n&/" "$cfg"; grep -qE "^$1 " "$cfg" || sed -i "1i $1 $2" "$cfg"; fi
}
set_opt X11Forwarding no
set_opt PermitRootLogin prohibit-password
# Terrapin (CVE-2023-48795): drop chacha20-poly1305; keep AEAD/CTR ciphers.
set_opt Ciphers aes256-gcm@openssh.com,aes128-gcm@openssh.com,aes256-ctr,aes192-ctr,aes128-ctr
if sshd -t; then systemctl reload sshd; log "sshd: X11Forwarding no, PermitRootLogin prohibit-password, Terrapin-safe ciphers"
else cp -p "$cfg.harden-$stamp" "$cfg"; echo "sshd config test failed; restored" >&2; exit 1; fi

# 4. LLMNR responder listens on all interfaces; not needed on a server.
if [ -f /etc/systemd/resolved.conf ] && ! grep -q '^LLMNR=no' /etc/systemd/resolved.conf; then
  cp -p /etc/systemd/resolved.conf /etc/systemd/resolved.conf.harden-$stamp
  sed -i 's/^#\?LLMNR=.*/LLMNR=no/' /etc/systemd/resolved.conf
  grep -q '^LLMNR=no' /etc/systemd/resolved.conf || echo 'LLMNR=no' >> /etc/systemd/resolved.conf
  systemctl restart systemd-resolved && log "LLMNR disabled"
fi
log "done"
