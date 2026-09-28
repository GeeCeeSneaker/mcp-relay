# WO-0001 — P0/P1 Windows Single-Node End-to-End

- Status: `IN_PROGRESS`
- Priority: `P0`
- Program authority: pre-authorized under `MASTER_IMPLEMENTATION_PLAN.md`
- Refined by: ADR-0002 (2026-09-27)

## Objective
Select and validate the minimum component chain, then deliver one real Windows-node remote MCP path through our VPS. Include actual ChatGPT proof when account-side access is available.

## Required outcomes
- local Desktop Commander exposed by an accepted HTTP adapter, as **one long-lived shared instance on loopback**;
- outbound authenticated/encrypted reverse tunnel;
- public HTTPS MCP gateway/auth compatible with ChatGPT (OAuth 2.1: DCR/CIMD + PKCE);
- representative file/directory/read-write/terminal/process operations;
- versions, config, evidence and a resource snapshot recorded.

## Task breakdown
The P0 spike table in `MASTER_IMPLEMENTATION_PLAN.md` is authoritative. Deliverables per spike:

| Spike | Repository deliverables |
|---|---|
| P0-S1 local adapter | `runtime/node/` pinned package set (exact versions + lockfile); Supergateway statefulness evidence; bridge if required; `docs/evidence/P0-S1-*.md` |
| P0-S2 smoke client | `tests/mcp-smoke.mjs`: initialize, tools/list, dir listing, read, write/edit, `mcp-relay-ok` command, cross-session process state, optional bearer/OAuth token |
| P0-S0 VPS inventory | `docs/evidence/P0-S0-vps-inventory.md` (sanitized) |
| P0-S3 tunnel | `config/node/` + `config/vps/` templates, `scripts/` tunnel start loop, `authorized_keys` restriction template, evidence |
| P0-S4 gateway | pinned gateway install (commit/digest), `config/vps/gateway.example.yaml`, evidence |
| P0-S5 public + ChatGPT | ingress snippet/Caddyfile, AT-PUBLIC evidence, AT-CHATGPT result or `OWNER_VALIDATION_REQUIRED` |
| P1 close-out | `components.lock`, manual runbook `docs/RUNBOOK.md`, resource snapshot, handoff record |

## Owner inputs required (Level C: credentials/infrastructure/account)
These do not block P0-S1 and P0-S2.
1. SSH access to the VPS for deployment (host, account, and whether a dedicated forward-only account may be created).
2. A DNS name for the public endpoint (for example `mcp.<domain>`) pointing at the VPS, and confirmation that ports 443/80 may be used or shared with an existing proxy.
3. ChatGPT account with Developer mode, used for AT-CHATGPT. The Owner performs this validation or delegates it explicitly.

## Team autonomy
Candidate names in ADR-0001/0002 are starting points. If one fails, the team may choose a simpler or equivalent same-responsibility alternative and continue, provided the permanent architecture does not grow. Record the evidence and decision in ADR/DEVLOG.

## Non-goals
No installer, multi-node control plane, Linux, VPN, database (beyond the gateway's intrinsic store), web UI, custom protocol or enterprise policy layer.

## Acceptance
Pass `AT-LOCAL`, `AT-TUNNEL`, `AT-PUBLIC` and generic E2E. Record `AT-CHATGPT` as PASS or `OWNER_VALIDATION_REQUIRED`.

## Handoff
Use the template in `WORK_ORDER_PROTOCOL.md`. `DEV_ACCEPTED` allows the team to continue directly into WO-0002. Independent review may happen asynchronously.
