# MCPRelay Runbook

Placeholders: `<vps-host>`, `<mcp-domain>`, `<node>` (e.g. `win01`), `<port>` (e.g. `18101`). Real values stay outside Git.

## VPS (as root)

Build the gateway bundle on a dev machine, then copy it together with `config/vps/` and `scripts/vps-install.sh` to the host:

```bash
scripts/build-gateway-bundle.sh out/
bash vps-harden.sh                                     # host hardening (once, then after OS changes)
bash vps-install.sh --domain <mcp-domain> --bundle mcp-gateway-*.tar.gz \
  --config-dir config --node <node>:<port>:<node>.pub:<node>.token \
  --allow-client <chatgpt-connector-client-id>
```

On the first ChatGPT connection, omit `--allow-client`: the edge then accepts any client and prints a warning. After connecting, read the connector's CIMD `client_id` from the gateway log ("Issuing access/refresh token pair to client ..."). Re-run with `--allow-client <that id>`. Re-creating the connector in ChatGPT yields a new id; add it the same way.

After on-host tests (`tests/oauth-e2e.py`), remove their clients and tokens:

```bash
bash vps-revoke.sh --keep-client <chatgpt-connector-client-id>
bash vps-revoke.sh --all          # emergency: every client must re-authorize
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

## Windows node (packaged app)

Build on a dev machine (needs git, npm, Windows):

```powershell
powershell -ExecutionPolicy Bypass -File packaging\windows\build.ps1      # -> dist\MCPRelay
```

Install on the node as the user who should own the ChatGPT session (no admin rights):

```powershell
powershell -ExecutionPolicy Bypass -File dist\MCPRelay\install.ps1 -NodeName <node> -VpsHost <vps-host> `
  -RemotePort <port> -PublicUrl https://<mcp-domain> [-KnownHostsFile <pinned known_hosts>]
```

What the installer does:
- installs to `%LOCALAPPDATA%\Programs\MCPRelay` and adds a Start Menu shortcut;
- enables start with Windows (`HKCU\...\Run`, starts hidden in the tray);
- writes per-user state to `%APPDATA%\MCPRelay` (ACL: user + SYSTEM), generating what is missing: `bridge.token`, `node_ed25519`, and `known_hosts` (TOFU; verify the printed fingerprint).

Register the node on the VPS with its public key and bridge token. Copy them over your own SSH session:

```bash
vps-install.sh ... --node <node>:<port>:node_ed25519.pub:bridge.token
```

Operate the app from the tray icon: green = connected, yellow = starting/connecting, red = stopped/not configured.
- Closing the window hides it to the tray; **Quit** stops the capability server and the tunnel.
- Logs: `%LOCALAPPDATA%\MCPRelay\logs\mcprelay.log`.
- File-tool roots default to the user profile. Set `"allowedDirs": "C:\\Users\\me;D:\\work"` in `%APPDATA%\MCPRelay\config.json` to change them, then use Restart services. Shell commands are not confined; they run as the user.
- Self-healing:
  - the server or tunnel exiting → restarted with backoff;
  - the server not answering 3 health checks → restarted;
  - resume from sleep or network change → tunnel reconnect;
  - an app crash → the app restarts itself.

VPS self-healing:
- units use `Restart=always` with no start limit;
- `mcprelay-watchdog.timer` restarts the gateway or Caddy when running but unresponsive (2 failed checks, 90 s start grace);
- Caddy retries the gateway connection for 15 s;
- the gateway retries the node connection (connect only, never a sent request) for ~15 s.
- Uninstall: `%LOCALAPPDATA%\Programs\MCPRelay\uninstall.ps1 [-RemoveState]`.

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
