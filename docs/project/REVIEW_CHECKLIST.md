# Independent Review Checklist

Use this checklist for substantial implementation PRs. It is intentionally short; do not turn review into a compliance framework.

## Contract
- [ ] Correct Work Order read first.
- [ ] Exact PR head SHA identified.
- [ ] Scope/non-goals respected.
- [ ] Any C2/C3 change was authorized before implementation.

## Minimalism
- [ ] New permanent components/processes are listed and justified.
- [ ] No duplicated responsibility across layers.
- [ ] No custom infrastructure where an accepted existing component suffices.
- [ ] Temporary spike code/config did not become permanent accidentally.
- [ ] No now-obsolete layer can be removed.

## Correctness / security boundary
- [ ] Public ingress/auth behavior matches the Work Order.
- [ ] Node is not unexpectedly publicly exposed.
- [ ] Secret handling is repository-safe.
- [ ] Failure/block conditions are fail-visible rather than silently bypassed.

## Evidence
- [ ] Local validation and GitHub CI are distinguished.
- [ ] Required E2E evidence is present and sanitized.
- [ ] Resource measurements are present when required.
- [ ] Evidence refers to the exact candidate version/config.

## Handoff
- [ ] DEVLOG updated.
- [ ] Current-state documents match HEAD.
- [ ] Known issues/deviations are explicit.
- [ ] Review decision is `PASS / PASS_WITH_CONDITIONS / REOPENED / FAIL`.

Reviewer must not generate missing runtime evidence by operating the local PC/VPS unless the Owner explicitly authorizes that specific action.
