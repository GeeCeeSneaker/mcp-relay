# Development Log

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
