# MCPRelay

MCPRelay is a self-hosted remote MCP relay for exposing capabilities of computers we own to remote AI agents through a single authenticated MCP endpoint.

The initial product goal is concrete: **allow ChatGPT to connect to MCPRelay and operate a Windows computer with capabilities comparable to the current Desktop Commander remote workflow, without relying on a third-party relay service.**

The project is private/self-use first. Windows is the first implementation target; Linux parity is planned after the Windows path is proven.

## Current architecture hypothesis

```text
ChatGPT / other MCP client
        |
     HTTPS + OAuth
        |
      Caddy                 VPS
        |
   MCP Gateway
        |
  127.0.0.1:<node-port>
        |
   rathole-server
        |
   encrypted outbound tunnel
        |
   rathole-client           Windows node
        |
   Supergateway
        |
   Desktop Commander
        |
   local OS / files / processes / terminal
```

This is a hypothesis to be validated, not architecture that must be preserved at all costs. Every permanent component must justify its existence. The first implementation work order is specifically intended to prove or disprove this minimal stack.

## Non-negotiable project rules

1. **Minimal solution first.** No component, abstraction, protocol, service, database, UI, VPN, policy layer or orchestration layer is added without a concrete demonstrated need.
2. **Repository is the source of truth.** Material instructions, scope changes, implementation handoffs and review decisions must be recorded in GitHub/repository documents.
3. **Reviewer does not operate machines.** Unless the Owner gives explicit authorization for a specific action, the Project Manager/Reviewer may inspect repository state, PRs, issues, CI and submitted evidence, but must not operate the developer's local machine, Windows services, VPS, shell or deployment environment.
4. **Implementer does not self-approve.** Implementation may be reported as candidate-ready; only independent review may mark work verified.
5. **Exact-head review.** Acceptance is tied to an exact commit/PR head and its evidence/CI, not to an informal statement that work is finished.
6. **No secrets in Git.** Passwords, tokens, private keys, cookies, private endpoints containing credentials and raw sensitive local-machine data must never be committed.
7. **Use existing software before writing infrastructure.** Custom MCP transports, tunnels, auth servers and control planes require explicit evidence that mature existing components are insufficient.

## Project documents

- `docs/project/PROJECT_CHARTER.md` — purpose, boundaries and success criteria.
- `docs/project/ENGINEERING_PRINCIPLES.md` — mandatory engineering/minimalism rules.
- `docs/project/SYSTEM_ARCHITECTURE.md` — current architecture hypothesis and interfaces.
- `docs/project/DEVELOPMENT_MANAGEMENT.md` — roles, change control, handoff and review governance.
- `docs/project/WORK_ORDER_PROTOCOL.md` — canonical task flow.
- `docs/project/ROADMAP.md` — staged delivery plan.
- `docs/project/CURRENT_EXECUTION_PLAN.md` — only the currently authorized work.
- `docs/project/RESOURCE_BUDGETS.md` — PC/VPS resource budgets and measurement rules.
- `docs/adr/ADR-0001-MINIMAL-REMOTE-MCP-ARCHITECTURE.md` — current architecture decision record.
- `docs/work_orders/WO-0001-WINDOWS-CHATGPT-E2E-POC.md` — first implementation work order.
- `docs/DEVLOG.md` — durable development/review log.

## Development flow

`Work Order -> implementation branch/PR -> tests/evidence -> CANDIDATE_READY -> exact-head independent review -> VERIFIED or REOPENED`

Chat discussion can shape decisions, but significant executable work must be written into the repository before it is treated as authorized project work.
