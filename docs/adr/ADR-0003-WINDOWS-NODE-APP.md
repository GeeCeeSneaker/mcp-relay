# ADR-0003 — Windows Node App (tray + supervisor)

- Date: 2026-09-28
- Status: `ACCEPTED` (Owner request)
- Change class: C2 (Owner-directed product scope). Adds one project-owned node process, which replaces the P1 manual scripts.

## Context

After AT-CHATGPT, the Owner asked for:
1. auto-start and automatic recovery;
2. a program instead of terminal windows ("unlike DSR, no console window"), minimized to the system tray when its window is closed;
3. ChatGPT operating the PC with the Owner's **real user identity**.

ADR-0002 F7 already required the node lifecycle to run in the interactive user's context. M6 excluded an Electron UI.

## Decision

One small native WinForms app, `MCPRelay.exe` (`app/windows/MCPRelay.cs`), is the node's lifecycle manager:

- **Build:** compiled by the .NET Framework 4.x `csc.exe` that ships with Windows. There is no SDK, runtime download, Electron or Node GUI stack. Output is a ~28 KB exe, and CI compiles it on `windows-latest`.
- **Supervision:**
  - starts the bridge (`runtime\node\node.exe runtime\app\bridge.mjs`) and the OpenSSH reverse tunnel as hidden children;
  - restarts each on exit with backoff;
  - restarts the tunnel on resume from sleep and on network availability;
  - puts each child tree in its own **Job Object** (kill-on-close), so a restart or app exit never leaves orphaned Desktop Commander or shell processes.
- **Identity:** runs as the logged-in user via `HKCU\...\Run` (`--minimized`). The bridge inherits the real profile, so Desktop Commander uses the user's own `~/.claude-server-commander` config. This replaces the per-user Scheduled Task/service options considered in F7, because a tray UI needs the interactive session anyway.
- **UI:**
  - status for the bridge/DC, the tunnel and the public endpoint;
  - a live log (also written to `%LOCALAPPDATA%\MCPRelay\logs`, rotated at 5 MB);
  - Restart and "Start with Windows" controls;
  - closing the window hides it to the tray; Quit stops all children.
- **Packaging** (`packaging/windows/`):
  - `build.ps1` bundles the exe, a pinned SHA-256-verified Node.js, and the bridge with `npm ci --omit=dev`;
  - `install.ps1` installs per user without admin rights. It writes state to `%APPDATA%\MCPRelay` (ACL: user + SYSTEM) — config, generated bridge token, generated node SSH key, pinned VPS host key — and adds a Start Menu shortcut and autostart;
  - `uninstall.ps1` removes the install.
- **Bridge auth** (security, same change set):
  - the bridge requires a bearer token (`MCPRELAY_BRIDGE_TOKEN`), which the gateway sends as its backend credential;
  - the token is removed from the environment before Desktop Commander starts, so commands cannot read it.

## Consequences

- `scripts/node-tunnel.ps1` is deleted (superseded).
- Permanent node processes: `MCPRelay.exe` (~10–20 MiB), bridge node, Desktop Commander node, `ssh.exe`.
- Windows services were rejected: session 0 cannot show a tray icon, and DC would run with the wrong identity.
