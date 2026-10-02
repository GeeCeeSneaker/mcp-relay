# ADR-0008 — Identity-Checked Process Lifecycle and Declared Targets

- Date: 2026-10-01
- Status: `ACCEPTED` (Owner approved the design on 2026-10-01)
- Change class: C2 — new capabilities in the node server (M1), a small Windows helper built with the existing toolchain, and one tray setting. No new component, no new risk class (no connector re-add).

## Problem

A user of MCP-Relay runs a ChatGPT Scheduled Reviewer. The Reviewer diagnoses and deploys a long-running local controller, but it cannot restart that controller:
- `force_terminate` only works on processes started by `start_process` whose handle the caller still holds.
- For an existing process, all it has is a PID, so it falls back to a shell `Stop-Process`. The scheduled environment blocks that as a high-impact shell command.

The requirement asks for status, stop and restart of an existing process with fail-closed identity checks, protection against PID reuse, graceful-then-force stopping and structured results. It also rules out a daemon, a process registry and long-lived state.

Two more problems came up while designing this:
1. **Restarted processes died with the node server.** The tray puts the node server in a Job Object with `KILL_ON_JOB_CLOSE` and without `BREAKAWAY_OK`. Every process the server starts, detached or not, is killed when the tray restarts the server. A simulated tray confirmed this: the resident was killed with the job's exit code.
2. **An agent-supplied restart profile is arbitrary execution.** If the agent supplies the executable, arguments and environment, that is `start_process` by another name. ADR-0007 requires such a call to go through `invoke_exec`. Putting it in `invoke_destructive` would bypass the per-class confirmation.

## Decision

Build general primitives instead of three single-purpose tools, plus targets the user declares for unattended restarts.

1. **Process reference.** A process is named by `ref = "<pid>@<start>"`.
   - `start` is the creation time: microseconds since 1601 UTC on Windows; boot id plus start ticks on Linux.
   - `list_processes`, `process_info` and `spawn_process` return it.
   - Every action re-checks it. On Windows the helper checks the creation time on an open process handle and terminates through that same handle, so there is no gap between the check and the action.
   - A reused PID is reported as `identity_mismatch` and never acted on. A ref is self-validating, so the server stores nothing.
2. **Selector with fail-closed checks.** The identity fields are `ref`, `pid`, `name`, `executable`, `command_line`, `command_line_contains` and `cwd`.
   - Every given field must match. A field that cannot be read (e.g. access denied) counts as a mismatch.
   - An action needs exactly one match; otherwise it fails with `not_found` or `ambiguous_match`.
   - Stopping needs a strong identity: a ref, or the full executable path plus command line or cwd. PID or name alone is refused (`weak_identity`).
3. **Primitives** (new capabilities; the five fixed tools are unchanged):

   | Capability | Class | Purpose |
   |---|---|---|
   | `process_info` | read | Identity (executable, command line with secrets masked plus its sha256, cwd, start time, parent) and per-field checks |
   | `wait_for` | read | Bounded wait for `process_exited`, `port_open`, `http_ok` (this machine only) or `file_updated` |
   | `stop_process` | destructive | Verify the identity, try a graceful stop, then force only if `force=true` |
   | `spawn_process` | exec | Start a program without a shell, detached, with an optional log file; reports `outlives_node` |

   Graceful stopping:
   - **Windows:** Ctrl+C, then Ctrl+Break, to the process's own console. These are sent only when that console holds nothing but the target and its descendants. Otherwise `WM_CLOSE` goes to its visible windows. If no method applies, the call fails with `graceful_unavailable`.
   - **Linux:** SIGTERM (or SIGINT).

   The node server, its supervisor and critical system processes are refused (`protected_process`).
4. **Declared targets.**
   - The user declares long-running programs in a targets file:
     - default on Windows: `%APPDATA%\MCPRelay\targets.json`;
     - default on Linux: `~/.config/mcprelay/targets.json`;
     - `MCPRELAY_TARGETS` overrides it.
   - Each target has a match rule (a strong identity), a start spec, a stop policy, health probes and timeouts.
   - The file is protected (file capabilities cannot touch it) and is read on every call. It is configuration, not a registry: the server never writes it.
   - Capabilities:
     - `target_status` (read);
     - `target_start`, `target_stop` and `target_restart` (destructive): because the program is fixed by the user, these are narrower than a shell and need no exec confirmation.
   - Restart sequence:
     1. verify the running instance (optionally `expect_ref`);
     2. stop it per the declared policy;
     3. start it as declared;
     4. the started process or one of its children must match the target within 10 s;
     5. it must stay alive `min_alive_s` and pass every probe within `health_timeout_s`.
   - Calls on the same target are serialized. A partial outcome is reported and never rolled back: `stop_failed`, `stopped_not_started`, `exited_after_start`, `started_identity_mismatch`, `started_unhealthy`.
5. **Structured facts.**
   - Lifecycle results are JSON, also in `_meta["io.mcprelay/result"]`.
   - Errors carry the same facts after the `Error [<code>]` line.
   - The audit log adds `target` and `new_pid`; it still holds no arguments or command lines.
6. **Windows helper `mcprelay-proc.exe`** (`app/windows/mcprelay-proc.cs`, C# 5, built by the same .NET Framework `csc` as the tray). It inspects, stops and spawns processes.
   - Spawned processes get a windowless console of their own, so Ctrl+C can reach them later.
   - They inherit exactly their NUL and log handles (`PROC_THREAD_ATTRIBUTE_HANDLE_LIST`).
   - They break away from the supervisor job. The helper reports actual job membership, because a breakaway can succeed for Node's inner job while the process stays in the tray's.
7. **Tray:** the node server's job adds `JOB_OBJECT_LIMIT_BREAKAWAY_OK`. Only the helper asks for breakaway, so `start_process` sessions and ssh still die with the job as before.

Requirement codes map to node codes:

| Requirement | Node code (next action) |
|---|---|
| `PROCESS_NOT_FOUND` | `not_found` (fix_args) |
| `IDENTITY_MISMATCH`, `NEW_IDENTITY_MISMATCH` | `identity_mismatch` (ask_user) |
| `GRACEFUL_STOP_TIMEOUT` | `stop_timeout` (ask_user) |
| `FORCE_NOT_ALLOWED` | `graceful_unavailable` / `stop_timeout` (ask_user) |
| `START_FAILED` | `start_failed` (ask_user); `spawn_failed` / `process_exited` for `spawn_process` |
| `HEALTH_CHECK_FAILED` | `health_check_failed` (ask_user) |

New codes also include `weak_identity`, `ambiguous_match`, `unknown_target`, `already_running` (fix_args), `protected_process` and `targets_invalid` (ask_user), and `helper_missing` (stop).

## Consequences

- An agent can stop, start and restart a resident without a shell. Unattended automation uses `target_restart`, one destructive call that cannot run anything the user did not declare.
- Future "restart / check / wait for X" requests become a targets entry, a new `wait_for` condition, or a new target kind (e.g. a Windows service), not a new tool.
- On Windows, each lifecycle call starts the helper: about 0.3 s for one process and about 0.6 s to inspect all processes. A restart typically takes 3–4 s, including the health check.
- **The tray must be updated with the server.** With an old tray, `spawn_process` and targets still work, but report `outlives_node: false` with a warning.
- On Linux there is no pidfd from Node. The ref is re-checked right before every signal, which leaves a window of microseconds, not a handle-bound guarantee.
- Graceful stopping on Windows is not universal. A process without its own console or a visible window can only be force-stopped, and the result says so.

## Rejected

- **Three single-purpose tools from the requirement** (`managed_process_status`, `stop_managed_process`, `restart_managed_process`). They would cover this case only; the primitives plus targets cover it and the next ones.
- **Agent-supplied restart profile in the destructive class:** it is arbitrary execution, see Problem 2. It remains possible as `stop_process` + `spawn_process` (exec) + `wait_for`.
- **PowerShell `Add-Type` instead of a helper:** it adds 1–2 s per call, and terminating by PID leaves a gap between check and action.
- **WMI `Win32_Process.Create` to escape the job:** it cannot redirect output, and it starts the process outside the user's normal process tree.
