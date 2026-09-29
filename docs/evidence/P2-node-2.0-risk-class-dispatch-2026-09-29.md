# Evidence — node server v2.0.0: fixed risk-class tools (ADR-0007), 2026-09-29

## Change

The server now exposes five fixed tools:
- `list_capabilities`;
- `invoke_read`, `invoke_write`, `invoke_destructive` and `invoke_exec`.

The 16 capabilities are unchanged and run through their class tool. On Windows, PowerShell 7 is the default shell when installed.

## Results

| Check | Result |
|---|---|
| Local smoke, legacy + modern era, destructive suite (27 checks each) | ALL PASS |
| Class enforcement | `invoke_read` → `remove_path` and `invoke_write` → `start_process` are refused, and the target file is untouched |
| Argument validation | missing, unknown and wrong-typed arguments are explained with the schema; `"-1"` is coerced to `-1` |
| Default shell | the catalog advertises PowerShell 7.6.6, and `start_process` without `shell` runs `pwsh.exe` |
| Audit log | entries carry `cls`; refused calls are logged as `wrong_class`; no arguments are logged; size stays within the cap (16 KiB test cap) |
| Windows extended checks (`compare-ext.mjs`) | ALL PASS: Chinese I/O, 20k-line output, REPL, tree kill, junction-safe search |
| Command latency, default shell | median ~0.98 s with PowerShell 7 vs ~0.65 s with 5.1 (the Owner prefers 7) |
| `tools/list` size | 5.3 KB, down from ~17 full tool definitions; the catalog is 9.5 KB, fetched once per conversation |

Live check through the public gateway (on-host OAuth probe, gateway not restarted):
- the gateway lists `gateway_status` plus the five `win01_*` class tools, and the annotations pass through unchanged:

  | Tool | readOnly | destructive | openWorld |
  |---|---|---|---|
  | `list_capabilities`, `invoke_read` | true | — | — |
  | `invoke_write` | false | false | — |
  | `invoke_destructive` | — | true | — |
  | `invoke_exec` | — | true | true |

- `invoke_read` runs `node_status`, and `invoke_exec` runs a command in PowerShell 7.6.6;
- a cross-class call and an invalid argument are refused with guidance.

## Migration note

Right after the install, the audit log shows one `start_process` call with `unknown_tool`. It came from a ChatGPT conversation still using the connector's cached pre-2.0 tool list. That list must be refreshed once: use Refresh where the UI offers it, otherwise delete and re-add the connector. After that, capability changes need no refresh.
