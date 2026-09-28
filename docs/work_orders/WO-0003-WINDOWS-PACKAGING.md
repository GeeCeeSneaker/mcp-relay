# WO-0003 — P3 Windows Packaging and Service Lifecycle

- Status: `IN_PROGRESS` (package + per-user install working; ADR-0003)
- Dependency: stable P2 runtime/config contract

## Objective
Make a new Windows node installable and operable with minimal manual setup.

## Required outcomes
- pinned self-contained distribution approach;
- install/config/start/stop/status/restart/uninstall;
- reboot auto-start/reconnect;
- version reporting;
- upgrade procedure;
- no Docker Desktop or mutable runtime `@latest` dependency resolution.

## Acceptance
Full `AT-WINDOWS-PACKAGE`, resource check and post-packaging minimalism review.

## Design rule
Do not build a GUI/launcher platform. Prefer native service manager or a very small proven wrapper. A custom supervisor requires demonstrated need.
