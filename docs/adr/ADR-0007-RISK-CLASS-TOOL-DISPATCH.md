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
