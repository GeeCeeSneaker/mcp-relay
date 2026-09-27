# WO-0005 — P5 Linux Parity

- Status: `PREAUTHORIZED`
- Dependency: stable node/runtime/config contract; may begin compatibility probe before P4 completes

## Objective
Add Linux nodes using the same public MCP/gateway/tunnel contract.

## Required outcomes
- accepted local capability runtime on Linux;
- same tunnel/config semantics where practical;
- systemd/native lifecycle;
- install/uninstall/update path;
- representative file/read-write/terminal/process E2E;
- reboot/reconnect;
- Windows regression unaffected.

## Acceptance
Full `AT-LINUX` plus resource/minimalism check.

## Design rule
Do not build a cross-platform framework first. Extract shared code only where Windows/Linux implementations demonstrate real commonality.
