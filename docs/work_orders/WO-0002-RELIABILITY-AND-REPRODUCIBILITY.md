# WO-0002 — P2 Reliability and Reproducibility

- Status: `IN_PROGRESS` (T1-T6 pass; T8 power cycle pass 2026-09-29; chaos/soak pass (ADR-0006); deliberate T7 outage and T9 sleep/resume pending Owner)
- Dependency: WO-0001 generic E2E path works

## Objective
Turn the working vertical slice into a stable reproducible chain without creating a platform.

## Required outcomes
- deterministic start/stop/status for node/VPS components;
- reconnect/restart behavior validated;
- native config templates + secret-placement rules;
- minimal diagnostics for each boundary;
- CI/static checks for project-owned scripts/config;
- clean deployment runbook;
- spike-only artifacts removed.

## Acceptance
`AT-RECOVERY` applicable pre-packaging cases + `AT-REPRODUCIBILITY` for VPS/one Windows node; resource/minimalism evidence updated.

## Autonomy
Team chooses scripts/config layout and may simplify/remove components. New always-on project service/database/control plane is escalation.
