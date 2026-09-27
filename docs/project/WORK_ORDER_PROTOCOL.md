# Repository Work-Order Protocol

## 1. Purpose

All material development/deployment/research instructions for MCPRelay must flow through the repository. Chat can discuss decisions, but executable project work is not considered authorized until it is represented by a repository Work Order or an explicit amendment to one.

## 2. Canonical path

```text
docs/work_orders/WO-XXXX-<short-name>.md
```

Work Orders remain in Git after completion. Do not rewrite history to hide failed approaches.

## 3. Required fields

Every Work Order must state:

- Work Order ID;
- Status;
- Priority;
- Change Class;
- objective;
- governing documents/context;
- baseline/dependencies;
- required tasks;
- explicit non-goals;
- required tests/evidence;
- resource measurement requirements where relevant;
- acceptance criteria;
- expected repository artifacts;
- blocking/stop conditions;
- completion handoff requirements.

## 4. Status semantics

- `OPEN` — authorized and not started.
- `IN_PROGRESS` — implementation active.
- `BLOCKED` — implementer cannot proceed within the frozen contract.
- `REVIEW` — candidate submitted; exact commit/PR head must be named.
- `VERIFIED` — independent Reviewer accepted the exact candidate.
- `CANCELLED` — explicitly withdrawn.

Only the independent Reviewer may set `VERIFIED`.

## 5. Scope discipline

One Work Order should target one coherent objective. A compatibility failure must not trigger unbounded substitutions.

If a task would require:

- a new core component not already authorized;
- a new custom protocol/service;
- a trust-boundary change;
- a VPN/control plane/database/UI not in scope;
- a materially different public MCP/auth contract;

then stop, record evidence and request a Work Order amendment/new Work Order.

## 6. Developer completion protocol

Before moving to `REVIEW`, the implementer must:

1. update code/config/tests/docs required by the Work Order;
2. update `docs/DEVLOG.md`;
3. record exact dependency versions;
4. provide exact commit SHA/PR;
5. distinguish local runtime validation from GitHub Actions;
6. attach or commit sanitized evidence required for acceptance;
7. list unresolved issues and deviations;
8. set implementation status to candidate-ready and review status to pending.

Pushing code is not completion by itself.

## 7. Review cycle

The Reviewer must read the Work Order first, then review the exact candidate head. The Reviewer may accept, conditionally accept, reopen or fail the candidate.

If the head changes, only the delta plus any affected prior findings may be reviewed, but acceptance must always name the new exact head.

## 8. Relationship to Issues/PRs

GitHub Issue = active coordination/status surface.

Repository Work Order = durable canonical task contract.

PR = implementation candidate and exact review surface.

PR descriptions must reference the Work Order and Issue when applicable.

## 9. Reviewer execution boundary

Review is repository/evidence based. The Reviewer must not compensate for missing developer evidence by logging into/operating the local PC or VPS unless the Owner explicitly authorizes that specific action.
