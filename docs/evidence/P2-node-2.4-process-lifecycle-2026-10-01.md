# Evidence — Node server 2.4.0: process lifecycle and declared targets (ADR-0008)

- Date: 2026-10-01
- Host: Owner's Windows 11 PC (Node v24.15.0), server started from the repo on a test port with its own token and targets file.
- Linux: covered by CI (`tests/process-lifecycle.mjs` on ubuntu-latest).

## Requirement acceptance (§6) → checks

| # | Requirement | Check in `tests/process-lifecycle.mjs` | Windows result |
|---|---|---|---|
| 1 | Read the identity of an existing process not started by MCP-Relay | process_info reads the identity of a process MCPRelay did not start | PASS |
| 2 | Stop it when the identity matches | stop_process stops it (graceful where possible, force only when allowed) | PASS (forced: a detached process has no console or window, so `graceful_unavailable` first, as designed) |
| 3 | Refuse to stop on mismatch | stop_process refuses PID alone / a mismatching identity | PASS |
| 4 | A reused PID is never hit | a reused PID is never hit (stale ref) | PASS |
| 5 | Restart from an explicit profile | target_restart (start, restart with expect_ref, stale expect_ref) | PASS (graceful Ctrl+C) |
| 6 | New PID and verified identity | target_restart facts: `new.ref`, `new_identity_verified`, `health_check: passed` | PASS |
| 7 | No shell `Stop-Process` / `taskkill` | all stops go through the helper (process handle) or signals | PASS |
| 8 | `start_process` / `force_terminate(handle)` unchanged | `tests/mcp-smoke.mjs`, both protocol eras; `tests/compare-ext.mjs` | ALL CHECKS PASSED |
| 9 | No registry, scheduler or background service | none added; targets file is read-only configuration | by design |

Lifecycle run: 18/18 PASS (graceful stop of a spawned process by Ctrl+C; a process ignoring Ctrl+C/Ctrl+Break gets `stop_timeout` and survives until `force=true`; restart 3.8 s including health check).

## Job Object (tray supervisor)

A stand-in for the server (node, running the helper as a normal child) was put in a job with `KILL_ON_JOB_CLOSE`, the helper started a resident, and the job was terminated:

| Job flags | Resident in a job | After job termination |
|---|---|---|
| `KILL_ON_JOB_CLOSE` (tray 1.2.0) | yes (breakaway left Node's inner job only, helper reported success) | killed, exit code = job's (0x4D) |
| `KILL_ON_JOB_CLOSE \| BREAKAWAY_OK` (tray 1.3.0) | no | alive, still serving |

Hence the helper reports `in_job` from `IsProcessInJob` instead of trusting the breakaway result, and the server reports `outlives_node`.

## Helper details verified

- Creation-time key equals `Win32_Process.CreationDate` at microsecond precision (`list_processes` and `process_info` give the same ref).
- Command line and working directory read for the user's processes; a spawned child inherits only NUL/log handles (an earlier build leaked the helper's stdout pipe and made the caller wait forever).
- Children inherit "ignore Ctrl+C" from their parent; the helper clears it before spawning, after which Ctrl+C reaches the program (`got SIGINT`).
- Startup cost: ~0.3 s per helper call, ~0.6 s to inspect all processes.
