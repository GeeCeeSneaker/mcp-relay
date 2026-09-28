# Development Log

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
