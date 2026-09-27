# Development Management Handbook

This file is the long-lived governance entry point for MCPRelay. Repository state is authoritative over transient chat/terminal context.

## 1. Roles

### Owner

The Owner defines product goals, trust assumptions and project-level authorization. The Owner may change architecture/scope and may explicitly authorize local/deployment operations.

### Project Manager / Independent Reviewer

Responsibilities:

- maintain project charter/roadmap/current plan;
- write/freeze Work Orders and acceptance contracts;
- inspect repository commits, branches, PRs, Issues, CI and submitted evidence;
- perform exact-head independent review;
- issue `PASS / PASS_WITH_CONDITIONS / REOPENED / FAIL` decisions;
- publish the next authorized work.

**Permanent authority boundary:** without explicit Owner authorization for a specific action, the Reviewer must not operate the local PC/VPS or act as an implementer. This prohibition includes local shell/terminal commands, file edits outside GitHub, starting/stopping services, installing/upgrading software, changing firewall/network configuration, deploying to the VPS, or producing local runtime evidence personally.

Reading task execution state and evidence from the repository/PR/Issue/CI is authorized. Writing project management documents, review findings and Work Orders in the repository is authorized.

### Implementer / Development Agent

Responsibilities:

- implement only frozen/authorized Work Order scope;
- run required local tests/deployment probes when the execution environment grants it permission;
- submit code/config/docs/evidence;
- report exact commit SHA and CI status;
- disclose blockers, deviations and unresolved risks.

The Implementer does **not** decide that its own work is verified/accepted.

## 2. Repository as source of truth

Material work instructions must exist in `docs/work_orders/` and normally have a linked GitHub Issue/PR.

Important state must not exist only in chat, terminal history or an agent scratchpad. If a decision changes scope/architecture/acceptance criteria, the governing repository artifact must be updated.

## 3. Work lifecycle

Canonical flow:

```text
OPEN -> IN_PROGRESS -> REVIEW -> VERIFIED
          |              |
          v              v
       BLOCKED        REOPENED -> IN_PROGRESS
```

Implementers may move work to `IN_PROGRESS`, `BLOCKED` or `REVIEW`/candidate-ready. Only the independent Reviewer may mark a work order `VERIFIED` or issue formal PASS/FAIL review decisions.

`Implementation complete` is never synonymous with `Review passed`.

## 4. Change classes

### C0 — documentation/status only

No runtime/architecture change. Normal repository review discipline applies.

### C1 — implementation/configuration

Does not change the accepted public contract or architecture boundaries. Requires code/config + tests + DEVLOG + Work Order handoff as applicable.

### C2 — interface/operational contract

Changes public MCP behavior, authentication contract, node enrollment/config semantics, dependency role or resource acceptance contract. Requires governing docs and acceptance criteria update before implementation is treated as authorized.

### C3 — architecture/governance

Adds/replaces a core architecture layer, custom protocol, database/control plane, VPN, major trust-boundary change, lifecycle/governance change or platform boundary. Requires Owner/Project Manager authorization and ADR/management-document update before implementation.

## 5. Branch and PR discipline

After the initial governance bootstrap, implementation should normally occur on a dedicated branch and enter review through a PR.

A review decision must name the exact PR head SHA. If the head changes after review, the previous approval does not automatically carry forward.

Do not approve uncommitted worktree state or a developer's narrative in place of committed code/evidence.

## 6. Completion handoff

At candidate-ready handoff, the implementer must report at minimum:

- Work Order ID;
- exact commit SHA(s) and PR number;
- files/components changed;
- dependency versions changed/introduced;
- tests executed and results;
- local validation separately from GitHub Actions validation;
- end-to-end evidence required by the Work Order;
- resource measurements when required;
- DEVLOG update;
- implementation status: `CANDIDATE_READY` or `BLOCKED`;
- review status: `PENDING_REVIEW`;
- known open issues/deviations;
- explicit statement of any scope not completed.

Never report local tests as GitHub CI or vice versa.

## 7. Independent review

Reviewer checks, in order:

1. exact Work Order and scope;
2. exact PR/head SHA and diff;
3. architecture/minimalism impact;
4. correctness and protocol/auth boundaries;
5. tests and CI;
6. supplied runtime evidence/provenance;
7. resource budget impact;
8. documentation/handoff completeness.

Review decisions:

- `PASS` — acceptance criteria are satisfied at the exact reviewed head.
- `PASS_WITH_CONDITIONS` — accepted only with explicitly stated non-blocking follow-up; must not hide a missing core acceptance criterion.
- `REOPENED` — candidate is not accepted and a bounded remediation is required.
- `FAIL` — approach does not satisfy the contract or should be abandoned.

Substantial new work discovered during review should become a new Work Order rather than growing the current PR without bound.

## 8. Minimalism gate

Every PR review must identify:

- permanent processes/components added or removed;
- new runtime dependencies;
- duplicated responsibilities;
- custom code replacing existing infrastructure;
- temporary spike artifacts that should be deleted;
- whether the current milestone can be met with fewer layers.

Unnecessary complexity is a valid blocking review finding.

## 9. Security/repository hygiene

Never commit credentials, API tokens, OAuth secrets, private keys, cookies, real private configuration, sensitive machine inventories or raw local data captured only for testing.

Evidence must be sanitized while remaining sufficient to show what was tested.

## 10. Definition of Done

A milestone/work order is done only when:

- frozen acceptance criteria are met;
- implementation is committed;
- required tests/CI are green or explicitly dispositioned;
- required runtime evidence exists;
- resource budgets were checked when applicable;
- management/current-state docs are consistent with HEAD;
- DEVLOG is updated;
- independent exact-head review is PASS/PASS_WITH_CONDITIONS;
- the Work Order is marked VERIFIED by the Reviewer.
