# MCPRelay

MCPRelay is a self-hosted remote MCP relay for exposing capabilities of computers we own to remote AI agents through a single authenticated MCP endpoint.

The v1 product goal is concrete: **ChatGPT can connect to our own MCPRelay endpoint and operate Windows/Linux machines with the practical local file/terminal/process capabilities currently obtained through Desktop Commander Remote, without depending on a third-party relay service.**

Windows is the first implementation target; Linux parity is part of the v1 program after the Windows runtime contract is proven.

## Current minimum architecture hypothesis

```text
ChatGPT / MCP client
        |
     HTTPS + auth
        |
   TLS ingress              VPS   (Caddy)
        |
   MCP Gateway + OAuth AS         (R0Wi/mcp-gateway, pinned + patches)
        |
  loopback backend
        |
   reverse tunnel server          (existing sshd, forward-only account)
        |
   encrypted outbound tunnel
        |
   reverse tunnel client    Node  (built-in ssh.exe)
        |
   capability server              (node-runtime/server.mjs, one process)
        |
 local files/processes/terminal
```

The node side is managed by a tray app (`app/windows`) that runs both processes as the logged-in user and restarts them.

Candidate ordering and the evidence behind it are in `docs/adr/ADR-0002-P0-DESK-RESEARCH-REFINEMENT.md`. Component names are provisional. Responsibilities and external contracts matter more than preserving a specific package. The development team may replace a candidate component with a simpler/equivalent component inside the same responsibility boundary when evidence justifies it; architecture/trust-boundary expansion requires escalation.

## Non-negotiable rules

1. **Minimal solution first.** Every permanent component/process/abstraction must solve a current demonstrated requirement.
2. **Repository is the durable authority.** Architecture, execution plan, important implementation decisions, PRs, CI/evidence and handoffs must be reconstructable from GitHub.
3. **Development team is autonomous inside the frozen execution envelope.** The team may decompose work, create Issues/PRs, adjust implementation order, fix defects, refactor and choose equivalent dependencies without waiting for per-step Reviewer approval.
4. **Escalate architecture, not routine engineering.** New public trust boundaries, persistent services/databases, custom protocols, VPN/control planes, materially broader machine exposure or Owner-risk actions require documented escalation.
5. **Reviewer does not operate machines.** Without explicit Owner authorization for a specific action, the Project Manager/Reviewer may inspect repository/PR/Issue/CI/evidence but must not operate the local PC or VPS.
6. **Project verification remains independent.** Team progress/merge decisions are not the same as final project acceptance; release candidates receive exact-head independent review.
7. **No secrets in Git.** Passwords, tokens, private keys, cookies and sensitive machine data never enter the repository.

## Start here

A new development team should read, in order:

1. `docs/project/PROJECT_CHARTER.md`
2. `docs/project/SYSTEM_REQUIREMENTS.md`
3. `docs/project/ENGINEERING_PRINCIPLES.md`
4. `docs/project/SYSTEM_ARCHITECTURE.md`
5. `docs/project/MODULE_DESIGN.md`
6. `docs/project/MASTER_IMPLEMENTATION_PLAN.md`
7. `docs/project/ACCEPTANCE_TEST_PLAN.md`
8. `docs/project/DEVELOPMENT_MANAGEMENT.md`
9. `docs/project/RESOURCE_BUDGETS.md`
10. `docs/adr/` (ADR-0001 baseline, ADR-0002 P0 refinement)

The entire v1 execution program in `MASTER_IMPLEMENTATION_PLAN.md` is pre-authorized. Phase Work Orders under `docs/work_orders/` are durable handoff/checklist artifacts, not gates requiring Reviewer permission between every step.
