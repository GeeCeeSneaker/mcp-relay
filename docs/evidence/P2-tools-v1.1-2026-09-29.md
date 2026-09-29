# Evidence — Node capability server v1.1.0 (tool-set additions), 2026-09-29

Input: the Owner's improvement proposal (local document), P0 + five P1 items. The public summary follows; no identifiers.

## Changes (17 tools = `gateway_status` + 16 node tools)

| Item | Implementation |
|---|---|
| `node_status` (new) | version, PID, uptime, hostname, OS, arch, Node version, allowed roots, session counts. No environment and no credentials |
| `list_processes` (new) | system-wide, read-only, largest RSS first: pid, parent_pid, name, path, start_time, cpu_time, rss. Filters: `name` (validated substring), `pid`, `limit` (≤ 500). **Command lines are deliberately not returned** (they can carry secrets). Windows: CIM via PowerShell (~1 s per call). Linux: `/proc` |
| `remove_path` (new) | file / empty dir / `recursive=true`. Only strictly inside allowed roots. Refuses an allowed root, or a directory containing one. The parent is resolved but the entry itself is acted on, so **removing a symlink/junction removes only the link**. Recursive deletion is lstat-based and never follows links out of the roots |
| `read_file` | `offset < 0` returns the last `abs(offset)` lines (tail); positive offsets unchanged |
| `get_file_info` | `sha256: true` adds a streamed SHA-256 |

## Tests

`tests/mcp-smoke.mjs` gained 7 checks, run on Windows and Linux in CI:
- `node_status` fields present and no credential text (the bearer token is checked explicitly);
- the tail of a 100-line file is exactly lines 91–100, and positive offsets are unchanged;
- SHA-256 equals a locally computed reference (UTF-8 content including Chinese);
- `list_processes` works unfiltered, by pid (the server's own), by name, and with a limit, and returns no command lines;
- `remove_path` on a file, an empty dir, a non-empty dir (non-recursive fails, recursive succeeds), and outside the roots (refused);
- links: removing a junction/symlink leaves the target content intact, and recursive delete of a dir holding a link to an outside directory leaves that content intact;
- `--destructive-ok` only (CI and scratch roots): the allowed root itself is refused and still exists afterwards.

Results:
- **Local, scratch root, both protocol eras:** all pass, including the destructive root check.
- **Installed on the Owner's node:**
  - public edge, both eras: all pass, 17 tools listed;
  - `tests/compare-ext.mjs`: all pass.

## P0 (tool-list refresh) — what was actually wrong, and the acceptance run

The proposal attributed the stale ChatGPT tool list to the gateway's persistent backend client. Gateway logs show otherwise:
- the gateway always serves the node's current `tools/list`;
- ChatGPT fetched the list only when the connector was created, and did not re-fetch on refresh;
- it never subscribed to change notifications, so `list_changed` cannot reach it.

The proposal's acceptance sequence was run on the live system:

| Step | Gateway PID | Gateway `tools/list` |
|---|---|---|
| Before the node update | 1667046 | 14 tools |
| Node updated to v1.1.0; **gateway not restarted** | 1667046 | **17 tools, immediately** |

The node → gateway propagation is therefore complete. The ChatGPT connector cache is outside MCPRelay's control; `docs/RUNBOOK.md` has the procedure (re-add the connector; with CIMD its client id stays the same, so the OAuth allow-list is unchanged).
