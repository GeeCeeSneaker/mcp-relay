# WO-0001 — P0/P1 Windows Single-Node End-to-End

- Status: `IN_PROGRESS_READY`
- Priority: `P0`
- Program authority: pre-authorized under `MASTER_IMPLEMENTATION_PLAN.md`

## Objective
Select/validate the minimum component chain and deliver one real Windows-node remote MCP path through our VPS, with actual ChatGPT proof when account-side access is available.

## Required outcomes
- local Desktop Commander exposed by accepted HTTP adapter;
- outbound authenticated/encrypted reverse tunnel;
- public HTTPS MCP gateway/auth compatible with ChatGPT;
- representative file/directory/read-write/terminal/process operations;
- versions/config/evidence/resource snapshot recorded.

## Team autonomy
Candidate names in ADR-0001 are starting points. If one fails, the team may choose a simpler/equivalent same-responsibility alternative and continue, provided the permanent architecture does not grow. Record evidence/decision in ADR/DEVLOG.

## Non-goals
No installer, multi-node control plane, Linux, VPN, database, web UI, custom protocol or enterprise policy layer.

## Acceptance
Pass `AT-LOCAL`, `AT-TUNNEL`, `AT-PUBLIC` and generic E2E. Record `AT-CHATGPT` PASS or `OWNER_VALIDATION_REQUIRED`.

## Handoff
Use the template in `WORK_ORDER_PROTOCOL.md`. `DEV_ACCEPTED` allows the team to continue directly into WO-0002; independent review may occur asynchronously.
