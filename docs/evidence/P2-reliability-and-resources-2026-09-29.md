# Evidence — Reliability (ADR-0006) and Resource Usage, 2026-09-29

- Public summary; no identifiers.
- System under test:
  - node server `node-runtime/server.mjs` 1.0.0 and tray app 1.0.0 on the Owner's Windows 11 workstation (real user profile);
  - VPS: gateway pinned + patches 0001/0002, Caddy 2.11.4, watchdog timer.
- The Desktop Commander stack has been removed (ADR-0004).

## Functional

- `tests/mcp-smoke.mjs` passes locally and through the public edge in both protocol generations.
- `tests/compare-ext.mjs` passes 10/10: UTF-8/Chinese output, large output, REPL, child-tree termination, allowed-roots enforcement, text search that does not follow junctions out of the roots.

## Fault injection

| Scenario | Result |
|---|---|
| Chaos run, 200 s, 1 call / 2 s. Faults: node server killed (t≈20 s), tunnel `ssh.exe` killed (t≈60 s), gateway restarted (t=100 s), Caddy restarted (t=140 s), VPS dropped the tunnel session (t=170 s) | **100/100 calls ok**. The pre-ADR-0006 run lost 4/90 |
| Gateway frozen (`SIGSTOP`) | watchdog replaced it; healthy 18 s after the freeze (manual watchdog runs; on the 1-min timer ≤ ~3 min) |
| Node server frozen (`NtSuspendProcess`) | tray app replaced it after 3 failed health checks; healthy 18 s after the freeze; the frozen process was reaped |
| **Unplanned:** a network-path reset closed every SSH connection from the node's IP during the soak | tunnel back in 2 s; **no call failed** (gateway connect-retry bridged the gap) |

## 30-minute soak (VPS-side client via the public edge, 1 call / 5 s)

- **360 calls, 0 failed.**
- `list_directory`: p50 204 ms / p95 229 ms / p99 273 ms / max 396 ms.
- `start_process echo` (PowerShell): p50 838 ms / p95 1529 ms / p99 1744 ms / max 1812 ms.

## Resource usage (sampled every 60 s; idle = 3 min before the soak, load = during the soak)

### Server side (VPS)

| Process | Memory (RSS) idle / load | CPU idle / load (% of one core) |
|---|---|---|
| mcp-gateway | 134 / 135 MiB | 0.8 % / 0.6 % |
| Caddy | 50 / 51 MiB (max 53) | 0.03 % / 0.04 % |
| sshd session for the tunnel | 5.4 / 5.4 MiB | 0.00 % / 0.02 % |
| **MCPRelay total** | **~190 MiB** (budget ≤ 200) | **< 1 %** |

Idle tunnel traffic (keepalives) was ~20 B/s. During the soak, the tunnel averaged ~0.8 KB/s up and ~0.3 KB/s down.

### Client side (Windows node)

| Process | Working set idle / load | Private | CPU idle / load |
|---|---|---|---|
| MCPRelay.exe (tray + supervisor) | 49 / 52 MiB | 31 MiB | 0.10 % / 0.12 % |
| node server | 61 / 72 MiB (max 75) | 72 MiB | 0.02 % / 0.22 % |
| ssh.exe (tunnel) | 11 / 11 MiB | 3 MiB | 0.00 % / 0.06 % |
| **MCPRelay total** | **~121 / ~135 MiB** (budget ≤ 300) | ~106 MiB | **< 0.5 %** |

For comparison, the previous Desktop Commander stack used 205 MiB working set for its two node processes alone, before the tray app and ssh.

Footprint: installed package 104 MiB (Node.js runtime ~80 MiB), 7 npm packages, cold start to ready 3–4 s.
