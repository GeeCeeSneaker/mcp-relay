# Current Execution Plan

## Program status

The complete v1 program in `MASTER_IMPLEMENTATION_PLAN.md` is **AUTHORIZED**. Development does not stop after WO-0001 waiting for a new instruction.

Current earliest phase: `P0 -> P1`, with later phases available automatically when their entry/exit dependencies are satisfied.

## Current priority

1. Prove the highest-risk compatibility boundaries first: local MCP transport, reverse tunnel, gateway/auth and actual ChatGPT connectivity.
2. Reach a real Windows single-node end-to-end call before investing in packaging/platform work.
3. Once P1 works, stabilize/reproduce it, package Windows, add multi-node, then Linux, then run full v1 qualification.

## Development-team decision rule

The team should make ordinary engineering decisions itself. Do not wait for Project Manager approval to:
- fix bugs;
- refactor;
- add tests/docs/scripts;
- choose exact package versions;
- replace a failing candidate with an equivalent same-responsibility component;
- proceed to the next authorized phase after acceptance evidence passes.

Escalate only when `DEVELOPMENT_MANAGEMENT.md` Level-B/C triggers are crossed.

## Reviewer boundary

Reviewer monitors GitHub state and evidence, performs independent milestone/exact-head review, and may reprioritize/reopen work. Reviewer is not authorized to operate the Windows node or VPS without explicit Owner authorization.

## Immediate handoff to development team

Read the nine documents listed in README, then execute P0/P1. Existing WO-0001 is the first vertical-slice work package; WO-0002..WO-0006 define the rest of the program. The team may create its own finer-grained Issues/PRs.
