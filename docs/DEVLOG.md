# Development Log

## 2026-10-05 — Node server v2.5.0: local Git operations (ADR-0009 / WO-0007)

- **What it adds:** 13 Git capabilities.
  - Reads through `invoke_read`: `git_status`, `git_diff`, `git_history`, `git_refs`, `git_worktrees`, `git_object_info`.
  - Changes through `invoke_write`: `git_fetch`, `git_checkout`, `git_ref_update`, `git_worktree_update`, `git_index_update`, `git_commit`, `git_integrate`.
  - A new module, `node-runtime/git.mjs`.
- **Owner decision: no separate `invoke_git` tool.** Its MCP annotations would have equalled `invoke_write`'s, and a new fixed tool forces every ChatGPT connector to be re-added. The write class is redefined as "changes without data loss". ADR-0009 is amended.
- **Contract:**
  - Every change takes the exact state it expects (HEAD, branch, ref value, index/worktree fingerprints from `git_status`); a stale state changes nothing (`stale_state`).
  - Ref and commit updates are atomic compare-and-swap.
  - Nothing is forced or discarded, and a ref change may not lose commits.
  - Merge, cherry-pick and revert conflicts are aborted and the previous state verified.
- **Hooks never run:** `core.hooksPath` points to a folder that does not exist, so even hooks kept in the repository content are skipped. External diff, textconv, fsmonitor and submodule recursion are off too.
- **Git behaviours found while implementing:**
  - checkout and merge overwrite ignored files by default; MCPRelay passes `--no-overwrite-ignore`;
  - `git worktree remove` silently deletes ignored files; MCPRelay refuses instead.
- **Tests:** `tests/git-ops.mjs` (25 checks) runs in CI on Windows and Linux. Existing suites are unchanged and green.
- **Pending:** the real ChatGPT Scheduled Task comparison (Owner). Until then ADR-0009 stays `PROPOSED` and WO-0007 `IN_PROGRESS`.
- Evidence: `docs/evidence/P2-node-2.5-local-git-2026-10-05.md`.

## 2026-10-01 — Node server v2.4.2: start-verification window follows health_timeout_s

- While declaring the first real target (the ADCP Controller): its launcher script runs a preparation step before starting Python. Normally this takes about 5 s; if the venv needs repair (`uv sync`, plus a lock wait of up to 30 s), much longer.
- The fixed 10 s window for finding the started process was too short for that case. It is now max(10 s, `health_timeout_s`).
- `targets_help` advises making `match` specific enough that preflight helper processes do not match (e.g. by `cwd`).

## 2026-10-01 — Node 2.4.0 deployed on the Owner's PC; server v2.4.1: how to declare a target

- **Deployed:** package `cfbeb80`, tray 1.3.0 and server 2.4.0.
- **Production check on the real tray:**
  - a program started with `spawn_process` reported `outlives_node: true`;
  - the node server was killed, the tray restarted it, and the program kept serving;
  - `target_restart` (temporary target, file removed afterwards) restarted it gracefully (Ctrl+C) with the health check passing.
- **Gap found by reading the catalog as an agent would:** with no targets declared, an agent could tell that the user must declare one, but not how.
- **Fix in 2.4.1:**
  - `list_capabilities` `environment.targets_help` gives the file, who edits it, the format with defaults and ranges, the rules, and a valid example (the test checks that the server accepts it);
  - `unknown_target`, `targets_invalid` and an empty `target_status` tell the agent to ask the user and point to `targets_help`;
  - a catalog note gives the restart workflow for declared and undeclared programs.

## 2026-10-01 — Node server v2.4.0 + tray 1.3.0: process lifecycle and declared targets (ADR-0008)

- **User requirement:** a scheduled ChatGPT reviewer must restart a long-running local controller that MCP-Relay did not start. A shell `Stop-Process` was blocked in the scheduled environment.
- **Owner decision:** general primitives plus user-declared targets, instead of three single-purpose tools.
  - New capabilities: `process_info`, `wait_for`, `target_status` (read); `stop_process`, `target_start`, `target_stop`, `target_restart` (destructive); `spawn_process` (exec).
  - Processes are named by `ref = pid@creation-time`, which is re-checked before every action, so a reused PID is never hit.
  - `list_processes` returns `ref`.
- **Found while designing:** the tray's Job Object killed every process the server started, including detached ones, whenever the server restarted.
  - The tray now allows breakaway, and the new Windows helper `mcprelay-proc.exe` starts programs outside the job.
  - A simulated tray confirmed it: without breakaway the resident died with the job; with it, it survived.
- Evidence: `docs/evidence/P2-node-2.4-process-lifecycle-2026-10-01.md`.

## 2026-09-29 — Node server v2.3.0: re-read the catalog on failure

- Owner request: tell calling agents that capabilities can change, and to re-read `list_capabilities` when a call fails.
- New next action `refresh_catalog` for `unknown_capability`, `wrong_class` and `invalid_args`.
- Every error carries the current `catalog_version`, and the catalog's usage text states that capabilities can change. No ChatGPT refresh is needed; the fixed tools' descriptions carry the same notice from the next refresh on.

## 2026-09-29 — T7 and T9 observed in real use; WO-0002 done

- **T7:** the node's network path failed for ~2 h 40 min. The tunnel retried with capped backoff and re-authenticated on its own once the path worked. The VPS logs show no attempt from the node in that window, so the fault was on the node's network side.
- **T9:** Windows resumed from sleep, and the app reconnected on resume and on network-available. The tunnel was up 85 s after resume, while the network was still coming up.
- The Owner declined staged repeats. WO-0002 (reliability and reproducibility) is done: T1–T9, chaos/soak, and the VPS rebuilt from the RUNBOOK.

## 2026-09-29 — Node server v2.2.0: agent-facing contract

Implements a review of the live system.
- Searches and listings stop at their own budgets with partial results; a timed-out call now aborts its work. Before this, a timed-out `search_files` kept running in the background.
- Opaque process handles are required for read/input/terminate.
- Stable error codes carry a next action (fix_args / ask_user / retry_later / stop). They replace the generic `exception` and `tool_error`.
- `catalog_version` covers the whole catalog.
- Audit lines gain boot/call ids and the PID for process operations; arguments are still never logged.
- AT-LOCAL and SYSTEM_REQUIREMENTS updated to the fixed risk-class interface.
- Evidence: `docs/evidence/P2-node-2.2-agent-contract-2026-09-29.md`.

## 2026-09-29 — Node server v2.1.0: guard lists; wider file roots

- **Owner decision:** file roots = user profile + the whole data drive, and system folders get a denylist.
- Guard lists apply inside the roots:
  - **protected** (never read or changed): MCPRelay credentials/config, SSH/GPG/cloud keys, OS and browser credential stores;
  - **read-only**: system folders, per-drive system entries, MCPRelay's program, logs and code.
- Both lists are extensible via config. Roots and lists are documented as a guardrail, not a security boundary: exec keeps full user rights.
- Fixed: `install.ps1` dropped Owner settings such as `allowedDirs` on reinstall; it now merges them. Tray app 1.2.0.
- Evidence: `docs/evidence/P2-node-2.1-guard-lists-2026-09-29.md`.

## 2026-09-29 — Node server v2.0.0: fixed risk-class tools (ADR-0007)

- Owner proposal adopted. Clients now see five fixed tools: `list_capabilities` plus `invoke_read`, `invoke_write`, `invoke_destructive` and `invoke_exec`, each carrying its class's MCP annotations.
- Capabilities can change without a ChatGPT refresh. Classes and arguments are enforced on the server.
- On Windows, PowerShell 7 is the default shell when installed; the detected shells are listed in the catalog.
- ChatGPT's Refresh control is missing on the Owner's plan. The RUNBOOK now covers both Refresh and re-add, and notes that chats opened before a re-add fail with "Resource not found".
- Evidence: `docs/evidence/P2-node-2.0-risk-class-dispatch-2026-09-29.md`.

## 2026-09-29 — Node server v1.2.0 and ingress host rebuild

- Tools describe themselves:
  - environment notes in descriptions (roots, shell, full-rights warning);
  - titles and MCP risk annotations (read-only / destructive / open-world).
- A call audit log (tool name, ok, duration, error class; never arguments) rotates at 1 MiB, so it stays ≤ 2 MiB. The tray app log cap dropped to 2 MB. VPS journald is capped at 200 MB / 7 days.
- The Owner reinstalled the VPS on a supported LTS OS. The VPS scripts now handle Debian/Ubuntu as well as RHEL-family hosts, and the host was rebuilt from the RUNBOOK. The ChatGPT connector must be re-added (new gateway secrets).
- Evidence: `docs/evidence/P2-tools-v1.2-and-host-rebuild-2026-09-29.md`.

## 2026-09-29 — T8 power cycle passed

- The Owner shut the PC down from the Start menu and powered it on (Windows Fast Startup, boot type 0x1). At logon the tray app autostarted hidden. The server and tunnel were up within 1 s, and the tunnel re-authenticated at the VPS with no manual step.
- Public OAuth + MCP checks passed after the power cycle.
- The interrupted reinstall was completed, so the installed server now matches `main` (4d3c179).
- Still open: a deliberate ≥ 60 s network outage (T7) and sleep/resume (T9).

## 2026-09-29 — Node server v1.1.0: 17-tool set

- Implemented the Owner's proposal:
  - `node_status`, `list_processes` (no command lines) and `remove_path` (strictly inside roots, root-protected, removes links without touching targets, recursive delete never follows links);
  - `read_file` tail;
  - `get_file_info` sha256.
- The smoke suite gained 7 checks (CI runs them on Windows and Linux, with the destructive root check only on throwaway runners).
- P0 was re-diagnosed: the gateway always serves the current list, and the stale list was ChatGPT's connector cache. Its acceptance run passed on the live system: with the gateway PID unchanged, the list went 14 → 17 tools right after the node update.

## 2026-09-29 — Own capability server live; reliability hardening (ADR-0004 accepted, ADR-0006)

- **Owner decisions:** adopt the project-owned server, PowerShell default, extra tools on demand, and reliability first.
- **Node:**
  - `node-runtime/server.mjs` 1.0.0 replaces Desktop Commander and the bridge;
  - per-call bounds, caps, `Connection: close`, and a clean exit on uncaught errors;
  - search does not follow links, and content search is literal (no user regex);
  - tray app 1.0.0: health-based restart of a hung server, self-restart on crash, 10 s × 3 SSH keepalive, `allowedDirs` config.
- **VPS:**
  - `Restart=always` with no start limit;
  - watchdog timer for unresponsive gateway/Caddy;
  - Caddy dial retry (15 s);
  - gateway patch 0002 (backend connect retries ~15 s);
  - sshd ClientAlive 10 s × 3.
- **Results:**
  - chaos run with 5 fault types: 100/100 calls ok;
  - frozen gateway and frozen node server were both recovered automatically;
  - 30-min soak: 360/360 calls ok, including an unplanned real network reset.
- **Resources:** VPS ~190 MiB and < 1 % CPU; node ~121 MiB (idle) to ~135 MiB (load) and < 0.5 % CPU.
- Evidence: `docs/evidence/P2-reliability-and-resources-2026-09-29.md`.

## 2026-09-29 — Option A deployed; desk prototype compared (ADR-0004/0005)

- A (ADR-0005): a 41-line gateway patch reuses one connected backend client, applied by `build-gateway-bundle.sh`. Public p50 went 0.70 s → 0.28 s (sustained 0.27 s). Fault run: 1/50 calls failed at the tunnel drop, then the client reconnected in ~2 s.
- Desk prototype (ADR-0004, PROPOSED) is ~230 lines on SDK v2 with DC-compatible tools, swapped in behind the tray app on the same public path.
  - It passed all smoke checks (both eras, local + public) and 9/9 extended checks. DC failed 2 of them: Chinese output was garbled, and force_terminate orphaned the child.
  - Footprint: 7 vs 547 packages, 60 vs 205 MiB idle, < 1 s vs 5–30 s start, file ops 15 vs 593 ms. Commands are slower with its PowerShell default.
- The tray app runs DC again. The Owner decides on ADR-0004. CI now also smoke-tests the prototype on Windows and Linux.

## 2026-09-28 — Performance: bridge 0.3.1 / 0.4.0

- The measurement (`tests/perf-probe.py`) found tunnel RTT 38 ms and 100% success, with per-call latency dominated by the gateway opening fresh backend sessions over the tunnel (2 sessions / 12 HTTP exchanges per public call).
- 0.3.1: JSON responses instead of one-event SSE, which fixes >1 MiB results (the gateway's httpx2 caps SSE events at 1 MiB).
- 0.4.0 (Owner chose option B): the bridge serves the sessionless 2026-07-28 protocol via the official SDK v2, alongside the 2025 path, so the gateway negotiates it with the node. Public per-call p50 went 1.5 s → 0.7 s (sustained 0.59 s). Both eras pass locally, publicly and in CI.
- The bridge is now ~390 lines (above ADR-0002's < 300 target) because of the second protocol leg; the remaining latency is gateway-internal (option A).

## 2026-09-28 — Full security review and fixes

The Owner requested a full review after P2/P3. Public summary: `docs/security/SECURITY_REVIEW_2026-09.md`. The full host-specific report is kept outside Git. Fixed:
- OAuth consent phishing: `/authorize` client allow-list at the edge, DCR not exposed, 10-min login session, ChatGPT-only redirect URIs;
- unused gateway routes hidden; security headers added;
- systemd sandboxing: gateway exposure score 8.2 → 1.4, Caddy 5.8 → 1.6;
- host hardening (`scripts/vps-harden.sh`): SUID helpers, sudo restriction, kernel sysctls, Terrapin-safe sshd, LLMNR off;
- vulnerable `sharp`/`uuid` pinned via overrides (`npm audit` 0);
- stale test grants revoked (`scripts/vps-revoke.sh`).

Residual risks for the Owner: unsupported ingress-host OS (reinstall recommended), real-identity/prompt-injection exposure, co-hosted root services, the legacy DSR relay still running, and the second VPS with password SSH.

## 2026-09-28 — P2/P3: tray app, real identity, recovery (ADR-0003)

- The Owner chose real-identity operation and asked for auto-start and recovery via a tray program without console windows.
- `MCPRelay.exe` (native WinForms, built with Windows' own csc) supervises the bridge and tunnel in Job Objects as the logged-in user. It restarts on exit, resume or network change, and hides to the tray on close.
- `packaging/windows` builds a self-contained package (pinned Node) and installs it per user. `scripts/node-tunnel.ps1` was removed.
- Security: the bridge now requires a bearer token (the gateway's backend credential), scrubbed from DC's environment. Caddy sends HSTS, frame-deny/CSP frame-ancestors, nosniff and no-referrer headers.
- Recovery T1–T6: 0.3–6.6 s. Network outage, reboot and sleep tests are pending with the Owner.
- Evidence: `docs/evidence/P2-P3-node-app-recovery.md`.

## 2026-09-28 — WO-0001 DEV_ACCEPTED: ChatGPT operates the Windows node

- The first ChatGPT connection authenticated via CIMD (the missing `iss` did not block it) and uses MCP 2026-07-28.
- Widget `resources/read` calls failed (gateway namespacing plus ~1.2 MB UI resources). Fixed by bridge 0.2.0, which strips widget metadata. The Owner confirmed widgets are unnecessary.
- The Owner validated AT-CHATGPT: command, directory listing, write and read all succeeded from ChatGPT, confirmed in gateway logs and DC tool history.
- WO-0001 is `DEV_ACCEPTED`; the handoff is recorded in the WO. Next: WO-0002 (P2).

## 2026-09-28 — P0-S3/S4/S5: tunnel, gateway and public ingress live

- The Owner cleaned the ingress host (only the Owner's unrelated panel service remains). No reverse proxy remained, so M4 is Caddy.
- `scripts/vps-install.sh` (idempotent, checksum-pinned uv/Caddy, host-generated secrets) deployed:
  - the gateway (pinned commit, bundle from `scripts/build-gateway-bundle.sh`);
  - Caddy with a Let's Encrypt certificate;
  - the forward-only `mcptunnel` account.
- AT-TUNNEL passed, including 7 negative checks on the node key. AT-PUBLIC passed via `tests/oauth-e2e.py`: RFC 9207 `iss` is absent, reported as WARN. The full public E2E smoke passed 14/14.
- The VPS stack uses ~189 MiB RSS.
- Next: AT-CHATGPT (Owner), then P2 (lifecycle, production DC profile, restart matrix).
- Evidence: `docs/evidence/P0-S3-S5-tunnel-gateway-public.md`. Runbook: `docs/RUNBOOK.md`.
- `check-public-hygiene.sh` gained an optional private deny-list via the `HYGIENE_DENYLIST` CI secret.

## 2026-09-28 — Public-repository hygiene tightened

The repository is public, and the Owner requires that no server information be published.
- Evidence now records generic findings only. Host-identifying and host-profiling details (provider/region, OS/patch state, SSH settings, co-hosted workloads, local machine build) were removed from `P0-S0` and `P0-S1`. The full inventory stays outside Git.
- `DEVELOPMENT_MANAGEMENT.md` §9 lists what must never be committed and requires placeholders in config.
- The new `scripts/check-public-hygiene.sh` CI job blocks public IPv4 literals, private keys, common token formats and non-noreply author emails.
- Audit: no IPs, hostnames, account names, key file names or domain were found anywhere in history or PR refs.

## 2026-09-27 — P0-S1/S2: local adapter decided (bridge replaces Supergateway)

- Added `tests/mcp-smoke.mjs`, a shared AT-LOCAL/TUNNEL/PUBLIC smoke client (official SDK).
- Tested Supergateway 4.0.0 on the Owner's Windows node:
  - stateless mode spawned a DC per call (~2.4 s each) and lost process state even within a session;
  - stateful mode lost state across connections;
  - both bound all interfaces and orphaned DC-started processes.
  ADR-0002 F3 is confirmed.
- Implemented `node-runtime/bridge.mjs`: one long-lived DC, loopback-only, JSON-RPC id remapping across sessions, DC auto-restart, `/healthz`. All AT-LOCAL checks pass, as do DC kill recovery (~3 s) and 3 concurrent clients. Idle node stack is ~196 MiB WS.
- Added `components.lock` and a CI workflow running AT-LOCAL on Windows and Linux. The Linux run doubles as an early P5 compatibility probe.
- Evidence: `docs/evidence/P0-S1-local-adapter.md`.
- Next: P0-S0/S3/S4 need Owner inputs (VPS access, DNS name).

## 2026-09-27 — P0 desk research and plan refinement (ADR-0002)

The development team checked every ADR-0001 candidate and ChatGPT's current remote-MCP requirements before writing config. Recorded in ADR-0002:
- ChatGPT supports OAuth only (no static keys or headers). The gateway must be a full OAuth 2.1 AS (DCR/CIMD, PKCE, RFC 8707/9728). `R0Wi/mcp-gateway` fits functionally and gives native per-backend namespacing for multi-node, but it is single-maintainer, so it is pinned by commit/digest.
- Supergateway 4.0.0 spawns a child per request (stateless/2026-07-28) or per session (stateful) and binds all interfaces. That likely breaks Desktop Commander's process state and the loopback requirement. The M1 requirement is now explicit: one shared, long-lived DC instance on loopback. A minimal SDK-only bridge is the pre-approved same-role fallback.
- Reverse-tunnel candidate order: OpenSSH reverse forward (no new process or public port) → rathole v0.5.0 (last tag 2023) → frp.
- Reuse an existing VPS :443 proxy if one is present. DC telemetry is disabled. Spikes isolate DC's user-home config. The Windows lifecycle must run as the interactive user.
- P0 is split into spikes S0–S5; WO-0001 now lists deliverables and Owner inputs.

## 2026-09-27 — Full v1 execution blueprint / autonomy correction

Owner clarified that project bootstrap must be sufficient for a competent development team to execute the whole project without waiting for Reviewer approval after each step.

Updated governance accordingly:
- `MASTER_IMPLEMENTATION_PLAN.md` now pre-authorizes P0-P6 from compatibility proof through Windows packaging, multi-node, Linux parity and v1 qualification;
- added full system requirements, module design and acceptance test matrix;
- changed governance from per-step Reviewer gating to bounded team autonomy with explicit architecture/risk escalation triggers;
- development team may decompose/reorder/parallelize work, fix/refactor, select equivalent same-responsibility components and proceed between pre-authorized phases based on recorded acceptance evidence;
- independent Reviewer still owns project verification and may reopen defects/over-complexity, but non-blocking review need not stop all engineering;
- Reviewer local/VPS execution prohibition remains unchanged;
- added WO-0002..WO-0006 so the whole v1 path exists in the repository from project start;
- retained continuous minimalism as a milestone and release acceptance requirement.

## 2026-09-27 — Project governance bootstrap

- Repository baseline before bootstrap: `main@9c2ff1c44eaf31afdb42037c7327f6734a58b6ad`.
- Established initial project charter, engineering principles, architecture hypothesis, development governance, work-order protocol, roadmap, current execution plan and resource budgets.
- Recorded ADR-0001 initial minimum architecture hypothesis.
- Established Reviewer boundary: repository/PR/Issue/CI/evidence review is authorized; local/VPS operation is not authorized unless Owner explicitly grants it for a specific action.
- Published WO-0001.
