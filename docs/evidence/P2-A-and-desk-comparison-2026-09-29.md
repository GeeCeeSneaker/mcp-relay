# Evidence — Option A (gateway persistent client) and desk prototype comparison

- Date: 2026-09-29
- Public summary; no identifiers.
- Node: Owner's Windows 11 workstation, real profile, tray app.
- Path for public numbers: VPS-side client → public edge → Caddy → gateway → tunnel → node. Probe: `tests/perf-probe.py`, run on the VPS.

## Option A (ADR-0005)

| Public, via gateway | B only (bridge 0.4.0) | A + B |
|---|---|---|
| `list_directory` p50 / p95 | 700 / 745 ms | **277 / 402 ms** |
| `start_process echo` p50 | 769 ms | **328 ms** |
| `read_file` 64 KiB / 256 KiB / 1 MiB | 775 / 849 / 968 ms | **331 / 350 / 477 ms** |
| Sustained 1 call / 3 s (120 s) | p50 594 ms, 40/40 | **p50 266 ms, 40/40** |

Fault run (1 call / 2 s for 100 s; node bridge killed at ~20 s, tunnel `ssh.exe` killed at ~55 s): 50 calls, **1 failed** (first call after the tunnel drop). The gateway log shows the persistent client reconnecting ("persistent client connected (protocol 2026-07-28)") and service resumed within ~2 s.

## Desk prototype vs Desktop Commander (ADR-0004)

The desk prototype was swapped in as the tray app's backend (`bridgeScript` in the app config) on the identical public path, then swapped back.

### Functional

| Check | DC + bridge | desk |
|---|---|---|
| `tests/mcp-smoke.mjs` local, 2025 era / 2026-07-28 | pass / pass | pass / pass |
| `tests/mcp-smoke.mjs` public, 2025 era / 2026-07-28 | pass / pass | pass / pass |
| `tests/compare-ext.mjs`: Chinese command output | **FAIL** (GBK mojibake via cmd.exe) | pass |
| Chinese file name + content round trip | pass | pass |
| 20k-line output readable | pass | pass |
| Interactive REPL (`node -i`) | pass (0.3 s) | pass (1.4 s) |
| `force_terminate` kills child tree | **FAIL** (`ping.exe` orphaned) | pass |
| File tool outside allowed roots denied | pass | pass |

### Performance / footprint (local unless noted)

| Metric | DC + bridge | desk |
|---|---|---|
| `echo`, default shell (median) | 201 ms (cmd.exe) | 561 ms (PowerShell) |
| `echo`, PowerShell (median) | 662 ms | 569 ms |
| write + read + edit (median) | 593 ms | 15 ms |
| Public `list_directory` p50 (A + B) | 277 ms | 266 ms |
| Public `start_process echo` p50 | 328 ms | 783 ms |
| Public 1 MiB `read_file` | 477 ms | 378 ms |
| Public sustained p50 (120 s) | 266 ms, 40/40 | 256 ms, 40/40 |
| Node processes / idle WS / private | 2 / 205 MiB / 279 MiB | 1 / 60 MiB / 35 MiB |
| Cold start → healthy | 4.6–7.6 s | 0.8 s (app cold start) |
| npm packages / node_modules | 547 / 185 MiB | 7 / 15 MiB |
| `npm audit --omit=dev` | 0 (after overrides) | 0 |

The public numbers are dominated by the gateway (~220 ms). The largest user-visible difference is the default shell (cmd.exe vs PowerShell).
