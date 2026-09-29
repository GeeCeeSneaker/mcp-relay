# P2 / P3 — Node App, Real Identity and Recovery Evidence

- Date: 2026-09-28
- Public summary per `DEVELOPMENT_MANAGEMENT.md` §9.
- Package: `dist/MCPRelay` built by `packaging/windows/build.ps1` (245 MiB). Contents: tray app 0.1.0, bridge 0.3.0, Node.js v24.21.0 (SHA-256 verified), Desktop Commander 0.2.51.
- Installed with `install.ps1` for the Owner's user (no admin rights).

## Real identity (Owner decision)

- `MCPRelay.exe`, the bridge `node.exe` and `ssh.exe` all run as the Owner's interactive user in session 1. No service account is involved.
- Desktop Commander uses the Owner's own config. File tools are limited to `allowedDirectories` (the user profile). **Shell commands are not limited by that setting and run with the user's full rights.** This is inherent in "real identity" and is covered in the security review.
- DC telemetry is set to `false` in the Owner's DC config; a backup was kept and no other key was touched.
- Full public E2E smoke through the installed app: **16/16 pass**. This includes two new checks:
  - an unauthenticated request to the bridge gets 401;
  - commands cannot read the bridge token (it is removed from DC's environment).

## No console windows

The app starts its children with `CreateNoWindow`. Their `conhost.exe` helpers are windowless, and the app window starts hidden in the tray (`--minimized` via `HKCU\...\Run`).

## AT-RECOVERY (pre-reboot cases)

Measured from the VPS by polling the node bridge through the tunnel (`wait-node.sh`), and from the public endpoint:

| # | Fault | Recovered by | Time |
|---|---|---|---|
| T1 | Desktop Commander process killed | bridge restarts DC | 6.6 s |
| T2 | bridge `node.exe` killed | app restarts bridge (job kills old DC tree; no orphans) | 6.3 s |
| T3 | tunnel `ssh.exe` killed | app restarts tunnel | 5.7 s |
| T4 | gateway restarted on VPS | systemd; OAuth+MCP re-verified | 4.8 s |
| T5 | Caddy restarted on VPS | systemd; OAuth+MCP re-verified | 0.3 s |
| T6 | VPS drops the tunnel session | app reconnects | 2.8 s |

All cases are well under the 60 s target.

Pending, needs the Owner:
- **T7 network outage:** not run by the development agent, because it required a temporary firewall change on a shared host.
  - Partially observed on 2026-09-29: an unplanned network-path reset dropped every SSH connection from the node's IP.
  - The tunnel was back in 2 s and no call failed (`P2-reliability-and-resources-2026-09-29.md`).
  - A deliberate ≥ 60 s outage is still open.
- **T9 sleep/resume:** still open.

**T8 Windows power cycle — PASS (2026-09-29, Owner-initiated, node server 1.1.0).**
- Shutdown was started from the Start menu. On power-on, Windows used Fast Startup (event 27, boot type 0x1).
- At logon the tray app was started hidden by the `HKCU\...\Run` entry. The server and tunnel came up within 1 s, and the tunnel authenticated at the VPS 1 s after the app started.
- Nothing was done by hand. Afterwards, public OAuth + MCP checks passed and the node answered through the tunnel.

Expected behavior for these:
- Dead connections are detected by `ServerAliveInterval 15 × 3` on the node and `ClientAliveInterval 15 × 3` on the VPS, which frees the stale listener in ≤ ~45 s.
- The app restarts the tunnel on resume and on network availability.

## Startup time

First start of DC under the real profile took ~30 s: DC waits for its remote feature-flag fetch on first run. Subsequent starts took 2–5 s (T1/T2).
