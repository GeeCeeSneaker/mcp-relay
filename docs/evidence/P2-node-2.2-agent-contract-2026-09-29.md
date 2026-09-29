# Evidence — node server v2.2.0: agent-facing contract, 2026-09-29

Source: a review of the live system. Every finding was checked against the code and the audit log before any change.

| # | Finding (verified) | Change |
|---|---|---|
| 1 | A `search_files` call hit the 120 s bound (`ms: 120009`, audit), and `withTimeout` (`Promise.race`) left the search running in the background | Every call gets an AbortSignal that fires at the bound. Search checks its limits before each directory and file (60 s, 200 000 entries) and returns partial results marked `[partial: …]`. `list_directory` stops after 30 s; hashing stops reading on abort |
| 2 | Concurrent callers could not be told apart in the audit log | Audit adds `boot` (per server process), `call` (per call) and `pid` (process operations). The same id is returned in `_meta["io.mcprelay/call_id"]`. Still no arguments or results |
| 3 | Process operations took a bare PID, so any agent could read, feed or kill another agent's process | `start_process` returns an opaque `handle`, and read/input/terminate require it. A PID is refused (`invalid_args`, unknown argument). `list_sessions` never shows handles. Handles work across connections |
| 4 | Failures ended up as generic `exception` / `tool_error` | Stable codes with a next action. The text is `Error [<code>]: … (next: …)`, plus `_meta["io.mcprelay/error"]`. The table is in the catalog, and audit `err` uses the same codes |
| 5 | `catalog_version` differed between filtered views (it hashed the view) | It now hashes the complete catalog; `view` names the subset |
| 6 | AT-LOCAL still required "DC-compatible tool names" in `tools/list` | AT-LOCAL and SYSTEM_REQUIREMENTS now describe the fixed class tools plus the catalog, handles, codes, guards and audit |

## Results

| Check | Result |
|---|---|
| Local smoke, legacy + modern era, destructive suite, guard test folders | 37/37 PASS each |
| New checks | handles required, PID refused, bad handle → `bad_handle`, `list_sessions` shows no handles, after terminate → `process_exited`; the codes `path_not_allowed`, `not_found`, `is_a_directory`, `no_match`, `protected_path` and `read_only_path` with their next action; one `catalog_version` across all 5 views; audit carries `boot`, `call` and the PID of `start_process` |
| `compare-ext.mjs` (Windows; REPL and tree kill now use handles) | ALL PASS |
| Search budget (test override 3 s, root = whole data drive) | content search: 3.09 s, returned `No matches` + `[partial: … time budget (3 s) after 866 entries …]`. Name search: 3.01 s, partial after 108 786 entries. The server answered `node_status` 28 ms later |

With the default 60 s budget, a whole-drive content search returns partial results after 60 s instead of the error it gave at 120 s.
