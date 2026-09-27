# Work Package / Work Order Protocol

## 1. Purpose

Work Orders are durable handoff/checklist artifacts, **not mandatory Reviewer approval gates between every development step**.

`MASTER_IMPLEMENTATION_PLAN.md` pre-authorizes the v1 program. The development team may create finer-grained GitHub Issues/PRs as needed without waiting for new formal Work Orders.

## 2. Canonical use

Use `docs/work_orders/WO-XXXX-<name>.md` for milestone-size packages, cross-agent handoffs or architecture-sensitive work. Routine bugs/refactors may be GitHub Issues/PRs only.

## 3. Required fields

A Work Order should state objective, scope, dependencies, required behavior, non-goals, acceptance/evidence, resource expectations where relevant, escalation conditions and completion handoff.

## 4. Team autonomy

Within a pre-authorized Work Order/phase the team can independently:
- decompose tasks;
- reorder/parallelize work;
- select implementation details;
- fix defects;
- substitute equivalent same-responsibility dependencies;
- create/merge ordinary implementation PRs;
- mark the package `DEV_ACCEPTED` when acceptance evidence passes;
- proceed to dependent pre-authorized packages.

## 5. Escalation

Follow `DEVELOPMENT_MANAGEMENT.md` Authority Levels. Level-B/C decisions require escalation; do not hide architecture growth in a routine PR.

## 6. Review

Reviewer reads the governing requirements/package and inspects exact repository/PR/CI/evidence. Reviewer does not operate the developer's PC/VPS to compensate for missing evidence.

Reviewer outcomes: `PROJECT_VERIFIED / PASS_WITH_CONDITIONS / REOPENED / FAIL`.

## 7. Completion handoff template

```text
Development Status: DEV_ACCEPTED | BLOCKED
Independent Review: PENDING | PROJECT_VERIFIED | REOPENED | FAIL
Phase/WO:
PR(s):
Exact Head SHA:
Components/Versions:
Acceptance Tests:
GitHub CI:
Runtime/E2E Evidence:
Resource Evidence:
Minimalism Review:
Known Issues:
Architecture Deviations: NONE | ...
Next Actions:
```
