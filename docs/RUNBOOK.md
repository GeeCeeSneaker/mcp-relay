# MCPRelay Runbook (P1, manual)

Placeholders: `<vps-host>`, `<mcp-domain>`, `<node>` (e.g. `win01`), `<port>` (e.g. `18101`). Real values stay outside Git.

## VPS (as root)

Build the gateway bundle on a dev machine, then copy it together with `config/vps/` and `scripts/vps-install.sh` to the host:

```bash
scripts/build-gateway-bundle.sh out/
bash vps-install.sh --domain <mcp-domain> --bundle mcp-gateway-*.tar.gz \
  --config-dir config --node <node>:<port>:<node>.pub
```

The script is idempotent. It:
- installs uv and Caddy after verifying their checksums;
- creates `mcprelay`, `caddy` and `mcptunnel`;
- installs the gateway and renders `/etc/mcprelay/{gateway.yaml,Caddyfile}`;
- generates the gateway key and login password on first run;
- restricts the tunnel account, backing up sshd config and testing it with `sshd -t` before reloading;
- enables `mcprelay-gateway` and `mcprelay-caddy`.

The gateway login password is in `/root/mcprelay-gateway-password` (root-only). Read it over your own SSH session; never paste it into chats or tickets.

Status and logs:

```bash
systemctl status mcprelay-gateway mcprelay-caddy
journalctl -u mcprelay-gateway -u mcprelay-caddy -f
ss -ltn | grep -E ':(443|18000|181[0-9][0-9])\b'     # node ports appear while tunnels are up
curl -s http://127.0.0.1:<port>/healthz               # node bridge through its tunnel
```

## Windows node

```powershell
cd <repo>
npm ci --prefix node-runtime
node node-runtime\bridge.mjs --port 18001                      # terminal 1
powershell -File scripts\node-tunnel.ps1 -VpsHost <vps-host> -RemotePort <port> `
  -KeyFile $env:USERPROFILE\.ssh\mcprelay_node_<node> `
  -KnownHosts $env:USERPROFILE\.ssh\mcprelay_known_hosts       # terminal 2
```

Setup:
- The node key is a dedicated ed25519 key. Only its public half goes to the VPS (`--node`).
- `mcprelay_known_hosts` pins the VPS host key, so the tunnel runs with `StrictHostKeyChecking=yes`.
- Desktop Commander settings live in `%USERPROFILE%\.claude-server-commander\config.json`. Set `"telemetryEnabled": false`.

## Connect ChatGPT (Owner)

1. ChatGPT → Settings → Security and login → enable **Developer mode**.
2. Add a custom connector (app) with URL `https://<mcp-domain>/mcp`, authentication **OAuth**.
3. Log in on the gateway page with the gateway user and the password from `/root/mcprelay-gateway-password`, then approve.
4. Tools appear as `<node>_<tool>`.

## Tests

```bash
node tests/mcp-smoke.mjs --url http://127.0.0.1:18001/mcp --fixture <dir>                 # AT-LOCAL
/opt/mcprelay/gateway/.venv/bin/python tests/oauth-e2e.py --base https://<mcp-domain> \
  --user owner --password-file /root/mcprelay-gateway-password                             # AT-PUBLIC (on VPS)
```

## Rollback (VPS)

```bash
systemctl disable --now mcprelay-gateway mcprelay-caddy
rm -f /etc/systemd/system/mcprelay-{gateway,caddy}.service && systemctl daemon-reload
cp -p /etc/ssh/sshd_config.mcprelay-bak /etc/ssh/sshd_config && sshd -t && systemctl reload sshd
userdel -r mcptunnel; userdel -r mcprelay; userdel -r caddy
rm -rf /opt/mcprelay /etc/mcprelay /var/cache/mcprelay-uv /root/mcprelay-gateway-password
```
