# ADR-0004 — Replace Desktop Commander with a Project-Owned Capability Server?

- Date: 2026-09-29
- Status: `PROPOSED — prototype evaluated; Owner decision pending`
- Change class: C3. It reverses the "no project-owned capability reimplementation" rule in `MODULE_DESIGN.md` M1.

## Context

The Owner asked why MCPRelay depends on Desktop Commander (DC) at all. DC being 2025-era only is **not** a reason: bridge 0.4.0 serves 2026-07-28 regardless, because the bridge ↔ DC stdio hop is local and costs milliseconds.

Other observed costs of DC:
- 547 npm packages / 185 MiB, including the two vulnerable transitive dependencies patched in the security review;
- third-party egress (remote feature flags, telemetry by default);
- 2–30 s start-up while it waits for flags;
- MCP-Apps widget metadata that had to be stripped;
- two processes (bridge + DC).

## Prototype

`prototype/desk/desk.mjs` (~230 lines, `@modelcontextprotocol/server` + `/node` only) is one process with:
- both protocol generations via the official SDK v2;
- loopback bind, bearer token scrubbed from children, file-tool root policy with symlink-safe checks;
- DC-compatible tool names/arguments: `list_directory`, `read_file`, `write_file`, `edit_block`, `create_directory`, `move_file`, `get_file_info`, `search_files`, `start_process`, `read_process_output`, `interact_with_process`, `force_terminate`, `list_sessions`;
- UTF-8 shell output and kill-the-whole-tree termination.

It was evaluated by swapping it in as the tray app's backend on the same public path. Full data: `docs/evidence/P2-A-and-desk-comparison-2026-09-29.md`.

## Summary of results

| | Desktop Commander + bridge | desk prototype |
|---|---|---|
| Smoke suite (both protocol eras, local + public) | pass | pass |
| Extended checks (9) | 7/9: **Chinese output garbled**, **force_terminate orphans child processes** | 9/9 |
| npm packages / node_modules | 547 / 185 MiB | 7 / 15 MiB |
| Node processes / idle memory | 2 / 205 MiB WS | 1 / 60 MiB WS |
| Cold start to ready | 4.6–7.6 s (up to ~30 s on first run) | < 1 s |
| File write+read+edit (local, median) | 593 ms | 15 ms |
| `echo` via default shell (local) | 201 ms (cmd.exe) | 561 ms (PowerShell) |
| `echo` via PowerShell (local) | 662 ms | 569 ms |
| Public tool call p50 (with A + B) | 277 ms | 266 ms |
| Public command call p50 | 328 ms (cmd) | 783 ms (PowerShell) |
| Third-party egress | flags (+ telemetry unless disabled) | none |

## Gaps in the prototype (production work if adopted)

- **Default shell:** PowerShell (capable, +~0.4 s per command) vs `cmd.exe` + `chcp 65001` (fast). Owner preference needed.
- **REPL:** no prompt detection; it returns after 0.4 s of quiet output, so interactive REPLs are slower to hand back (1.4 s vs 0.3 s).
- **Missing DC features:** PDF/Excel/Word readers, image reading, fuzzy `edit_block` diagnostics, ripgrep-speed search with search sessions, `list_processes`/`kill_process`, config tool, per-command blocklist.
- **Needs:** CI coverage (smoke runs in CI from this change on), Linux validation of process-group handling, and a security review of its own code.

## Options

1. Keep DC (status quo).
2. Adopt desk as the default capability server after the production work above, and remove DC (and the bridge's DC plumbing) after a trial period.
3. Keep both (rejected: two capability stacks contradict the minimalism rule).
