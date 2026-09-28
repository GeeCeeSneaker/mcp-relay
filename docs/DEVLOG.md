# Development Log

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
