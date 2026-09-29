# Evidence — node server v1.2.0 (self-describing tools, audit log) and ingress host rebuild, 2026-09-29

## Scope

Owner-approved follow-ups after v1.1.0, with the constraint that logs stay small:

1. **Environment context in tool descriptions.** File tools end with the node name, OS and the allowed roots. Shell tools end with the default shell, working directory, and a note that commands run with the user's full rights and are not confined to the roots.
2. **Risk annotations.** Every tool carries a `title` and MCP `ToolAnnotations`:

   | Class | Tools | Hints |
   |---|---|---|
   | Read-only | node_status, list_directory, read_file, get_file_info, search_files, read_process_output, list_sessions, list_processes | `readOnlyHint` |
   | Write, non-destructive | create_directory | `idempotentHint` |
   | Destructive | write_file, edit_block, move_file, remove_path, force_terminate | `destructiveHint` |
   | Destructive, open-world | start_process, interact_with_process | `destructiveHint`, `openWorldHint` |

3. **Call audit log.**
   - One JSON line per tool call: `{t, tool, ok, ms, err?}`. `err` is a class: `unknown_tool`, `tool_error`, `invalid_params`, `timeout` or `exception`.
   - No arguments, paths, commands or output are logged.
   - Writes are asynchronous and serialized, and an audit failure never fails a call.
   - Rotation at 1 MiB into one `.1` file caps disk use at about 2 MiB, roughly 13,000 calls. `MCPRELAY_AUDIT_MAX_BYTES` overrides the cap.
   - The tray app 1.1.0 enables it at `%LOCALAPPDATA%\MCPRelay\logs\audit.log`. Without `MCPRELAY_AUDIT_LOG` it is off.

Other log caps:
- the tray app log now rotates at 2 MB (was 5 MB), ≤ 4 MB total;
- VPS journald is capped by `vps-install.sh` at 200 MB / 7 days, keeping 2 GB free.

## Results

| Check | Result |
|---|---|
| Local smoke, both eras, destructive suite, `MCPRELAY_AUDIT_MAX_BYTES=4096` | PASS. Audit files 2467 + 4091 bytes (each ≤ cap); no fixture paths or file contents in the log |
| Smoke: annotations on all 16 node tools; `remove_path` destructive, `read_file` read-only, `start_process` destructive + open-world | PASS |
| Smoke: descriptions contain the allowed root and the shell context | PASS |
| CI | audit log enabled with a 16 KiB cap, so rotation runs on every CI run |
| Live, through the public gateway (on-host OAuth probe) | 17 tools; titles, hints and description notes pass through unchanged; `node_status` reports 1.2.0 and the audit path |

## Ingress host rebuild

- The Owner reinstalled the VPS on a currently supported LTS OS. This closes the end-of-life-OS residual risk from the security review.
- The rebuild followed the RUNBOOK:
  1. pin the new host key;
  2. apply all OS updates and reboot;
  3. run `vps-harden.sh` and `vps-install.sh`.
- Script changes it needed:
  - SSH unit name `ssh`/`sshd`;
  - admin group `sudo`/`wheel` for the sudo restriction;
  - sshd hardening as a `00-` drop-in when `sshd_config.d` is included, verified with `sshd -T`;
  - the journald cap.
- The node's tunnel reconnected on its own once its pinned host key was updated; no app restart was needed.
- `tests/oauth-e2e.py` passed on the new host. Test clients and tokens were removed afterwards with `vps-revoke.sh`.
- The gateway key, password and OAuth grants are new, so the ChatGPT connector must be re-added. That also refreshes ChatGPT's cached tool list with the new annotations.
