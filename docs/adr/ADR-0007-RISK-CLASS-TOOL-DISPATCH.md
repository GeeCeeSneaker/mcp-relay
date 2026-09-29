# ADR-0007 — Fixed Risk-Class Tools with a Capability Catalog

- Date: 2026-09-29
- Status: `ACCEPTED` (Owner proposal: one call tool per risk class, plus a list of what is callable)
- Change class: C2 — interface change of the project-owned node server (M1). No new component.

## Problem

ChatGPT caches a connector's tool list when the connector is created. It ignores `notifications/tools/list_changed`, and the documented Refresh control is missing on the Owner's plan. Every change to the node's tools therefore meant deleting and re-adding the connector. Chats opened before the re-add stay bound to the old connector and fail with "Resource not found".

## Decision

The node server (v2.0.0) exposes a **fixed set of five tools**:

| Tool | MCP annotations | Runs |
|---|---|---|
| `list_capabilities` | read-only | returns the current catalog: each capability's name, class, `invoke_with`, description and argument schema, the node environment (OS, file roots, shells, working directory) and a `catalog_version` |
| `invoke_read` | read-only | node_status, list_directory, read_file, get_file_info, search_files, read_process_output, list_sessions, list_processes |
| `invoke_write` | non-destructive write | create_directory |
| `invoke_destructive` | destructive | write_file, edit_block, move_file, remove_path, force_terminate |
| `invoke_exec` | destructive, open-world | start_process, interact_with_process |

Calls use `invoke_<class>({capability, args})`. The capability implementations and their arguments are unchanged from v1.2.0.

Rules:
- **Classes are enforced on the server.** A capability runs only through its own class tool. Otherwise the client's per-tool confirmation (e.g. ChatGPT asking before destructive actions) could be bypassed through `invoke_read`. A refused call runs nothing, names the right tool, and is audited as `wrong_class`.
- **The server validates arguments.** The client no longer validates each capability's schema, so the server checks the arguments itself:
  - unknown keys, missing required keys, wrong types and enum values are rejected with the schema in the message, so the model can correct itself;
  - numeric and boolean strings are coerced.
- **No enums in the fixed schemas.** The class tools take `capability` as a free string, so adding a capability never makes the cached schema reject it. Their descriptions name the current capabilities only as a hint; `list_capabilities` is authoritative.
- **Shell environment.** On Windows, PowerShell 7 (`pwsh`) is the default shell when installed, otherwise Windows PowerShell 5.1. The detected shells and versions appear in the catalog and in `invoke_exec`'s description. Other shells are chosen with `args.shell`.

## Consequences

- Adding, removing or changing capabilities, and moving one to another existing class, needs **no client refresh**. Only a change to the five tools, e.g. a new class, needs a refresh or re-add.
- Confirmations are per class, not per capability. "Always allow" on `invoke_destructive` allows every destructive capability; the RUNBOOK advises against it.
- Each conversation makes one extra `list_capabilities` call. `tools/list` shrinks from ~17 full tool definitions to 5.
- Argument mistakes are caught by the server rather than the client, at the cost of an occasional extra round trip.
- Audit entries gain `cls`; `err` gains `unknown_capability`, `wrong_class` and `invalid_args`.
- Starting a command in PowerShell 7 takes about 0.3 s longer than in 5.1 on the Owner's PC (median ~1.0 s vs ~0.65 s). The Owner prefers 7.

## Rejected

- **A single generic `invoke` tool**: it would carry the most dangerous class's annotations, so every read would need a confirmation.
- **Keeping the 16 direct tools next to the class tools**: this doubles the tool count and gives the model two ways to do the same thing.

## Update 2026-09-29 — v2.2.0 (agent-facing contract)

- **Process handles.** `start_process` returns a PID and an opaque `handle`. `read_process_output`, `interact_with_process` and `force_terminate` require the handle; a PID is refused as an unknown argument. `list_sessions` shows PIDs only.
  - Reading output consumes it, so the handle also keeps one agent from taking another's output.
  - Handles work across connections.
  - This is operational safety between agents of the same user, not an access-control boundary.
- **Error codes.** Every failure returns `Error [<code>]: <message> (next: <action>)` plus `_meta["io.mcprelay/error"] = {code, action}`. The action is one of:
  - `fix_args`: change the arguments and retry;
  - `ask_user`: stop and ask the user (`protected_path`, `read_only_path`, `permission_denied`);
  - `retry_later` (`timeout`, `busy`);
  - `stop` (`internal_error`).

  The table is in the catalog (`errors.codes`), and audit `err` uses the same codes.
- **`catalog_version`** hashes the complete catalog, so it is identical for every filtered view. `view` names the returned subset.
- **Correlation.** Each result carries `_meta["io.mcprelay/call_id"] = <boot_id>-<call_id>`. Audit lines add `boot`, `call` and, for process operations, `pid`. Arguments and results are still never logged.
- **Cancellation.** Calls pass an AbortSignal that fires at the 120 s bound.
  - `search_files` and `list_directory` also have their own budgets (60 s / 30 s, plus 200 000 entries for search). At the budget they stop and return partial results marked `[partial: …]` instead of timing out.
  - Hashing stops reading when the call is aborted.

## Update 2026-09-29 — v2.3.0 (catalog refresh on failure)

- The Owner asked that callers be told capabilities can change, and that they should re-read the catalog when a call fails.
- A new next action, `refresh_catalog`: "capabilities may have changed: call list_capabilities again, then retry with the current names, classes and arguments".
  - It is used for `unknown_capability`, `wrong_class` and `invalid_args`.
  - Every error also carries the server's current `catalog_version`, in the text and in `_meta["io.mcprelay/error"]`, so a caller can see that its copy is stale.
- The catalog's `usage` says capabilities, classes and arguments can change at any time. Because the catalog is fetched fresh, this works without a ChatGPT tool-list refresh.
- The fixed tools' descriptions carry the same notice. ChatGPT picks up those descriptions only at its next tool-list refresh or connector re-add; until then, the catalog and the error messages carry the notice.
