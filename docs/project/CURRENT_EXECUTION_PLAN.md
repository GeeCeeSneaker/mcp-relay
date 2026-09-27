# Current Execution Plan

> This file answers only: what is authorized now, why, what evidence is required, and what is blocked. Long-term work belongs in `ROADMAP.md`.

## Current phase

**M1 preparation / WO-0001 — Windows -> VPS -> ChatGPT minimal end-to-end PoC**

Current implementation status: `NOT_STARTED`.
Current review status: `PENDING_IMPLEMENTATION`.

## Current objective

Prove or falsify the smallest candidate architecture using existing components before investing in packaging, fleet management or Linux support.

Candidate chain:

```text
ChatGPT
 -> HTTPS/TLS
 -> Caddy
 -> candidate MCP Gateway + auth
 -> VPS loopback per-node backend
 -> rathole-server
 -> encrypted reverse tunnel
 -> rathole-client
 -> Supergateway
 -> Desktop Commander
 -> Windows test operation
```

## Authorized work

Only WO-0001 is authorized for runtime implementation.

The implementer may:
- create the minimal repository/config/test skeleton required by WO-0001;
- pin and configure the approved candidate components;
- run local/VPS compatibility and end-to-end tests within its execution authorization;
- produce sanitized evidence/resource measurements;
- open a PR and submit an exact candidate head for review.

## Explicitly not authorized in WO-0001

- WireGuard;
- ToolHive/HAProxy;
- custom WebSocket/tunnel/auth/MCP server;
- Windows installer/service wrapper beyond what is strictly necessary to run the PoC;
- Linux implementation;
- multi-node implementation;
- web UI/device dashboard;
- database/control plane;
- automatic updater;
- broad permission/RBAC system.

## Critical compatibility gate

The current lightweight gateway candidate must be tested against the actual remote-MCP authentication/client requirements. If it cannot support the required ChatGPT path with a bounded configuration change, **stop and report the incompatibility**. Do not silently add a heavier gateway or custom auth layer.

## Reviewer boundary

The Project Manager/Reviewer will inspect repository state, PR/Issue/CI and submitted evidence only. The Reviewer is not authorized to log into or operate the Windows node or VPS for this work order.

Missing local/runtime evidence is therefore a developer/Owner-validation blocker, not permission for the Reviewer to generate that evidence personally.

## Next review trigger

Review starts only when the implementer supplies:
- WO-0001 candidate status;
- PR number and exact head SHA;
- local test results;
- GitHub CI results if CI exists;
- sanitized end-to-end evidence;
- dependency versions;
- PC/VPS resource measurements;
- known deviations/blockers.

The next Work Order will be issued only after that review.
