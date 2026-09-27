# WO-0004 — P4 Multi-Node Windows

- Status: `PREAUTHORIZED`
- Dependency: stable packaged Windows node; may prototype namespacing earlier

## Objective
Operate at least two Windows nodes through the same VPS without architecture change.

## Required outcomes
- stable unique node identity/naming;
- deterministic backend mapping;
- simplest ChatGPT-compatible node selection/namespacing;
- add/remove node procedure;
- offline isolation;
- no cross-node misrouting/tool collision.

## Acceptance
Full `AT-MULTI-NODE`; adding/removing second node changes configuration/provisioning only, not application code.

## Design rule
Static/small-fleet configuration is preferred. Do not add a fleet database/control plane unless static configuration is proven operationally inadequate.
