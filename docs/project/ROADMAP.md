# MCPRelay Roadmap

The roadmap is intentionally staged so that each phase earns the right to add the next layer. Dates are not frozen; gates are evidence-based.

## M0 — Governance/bootstrap

Status: **ACTIVE -> bootstrap complete when initial documents and WO-0001 are committed**.

Deliverables:
- project charter/governance;
- minimum architecture hypothesis;
- resource budgets;
- first end-to-end Work Order.

No runtime implementation belongs in M0.

## M1 — Minimal Windows end-to-end proof

Goal: prove one real Windows node can be reached through our VPS from ChatGPT/standard remote MCP path using the minimum candidate component chain.

Required proof:
- Desktop Commander local tools exposed through Supergateway;
- encrypted outbound reverse tunnel to VPS;
- VPS gateway exposes one authenticated HTTPS MCP endpoint;
- representative directory/file read and harmless command invocation reach the Windows node;
- actual resource usage recorded;
- no public inbound MCP port on the Windows node.

Manual configuration is acceptable. Packaging/fleet management is explicitly deferred.

## M2 — Reliability and boundary hardening

Only after M1 PASS.

Focus:
- reconnect/restart behavior;
- service lifecycle;
- secret/config handling;
- stable node/backend naming;
- narrow ingress/network exposure;
- regression tests for failures observed in M1;
- resource regression check.

Do not add a management UI or control-plane database.

## M3 — Windows packaging

Only after the runtime chain is stable.

Goal: a self-contained Windows package with minimal configuration and one service lifecycle.

Expected properties:
- pinned runtime/dependencies;
- no prerequisite Docker Desktop;
- no `@latest` dependency install at runtime;
- simple enrollment/config;
- install/uninstall/update/restart documented and tested.

The package format is not frozen until M1/M2 evidence defines the real requirements.

## M4 — Multi-node Windows

Goal: add multiple Windows devices without architecture changes.

Focus:
- per-node identity/backend mapping;
- collision-free MCP tool namespace/presentation;
- offline-node behavior;
- simple add/remove procedure.

Only build fleet-management automation that repeated manual operation proves is necessary.

## M5 — Linux parity

Goal: reuse the same gateway/tunnel/MCP contract on Linux.

Prefer shared application components/config semantics; use systemd for lifecycle where appropriate. Do not create a separate Linux architecture.

## M6 — Optional operational UX

Not authorized by default.

A CLI, web UI, central registry, auto-update controller or richer observability may be proposed only if multi-node operation demonstrates a recurring operational problem that cannot be solved cleanly by small scripts/configuration.

## Architecture reconsideration triggers

Revisit a previously rejected layer only on evidence. Examples:

- WireGuard: multiple non-MCP services genuinely need private cross-device networking.
- ToolHive/heavier gateway: the minimal gateway cannot satisfy required standard MCP auth/aggregation semantics.
- Custom relay: mature tunnel components demonstrably cannot support required MCP connection behavior.
- Database/control plane: static/config-derived node mapping becomes an actual operational bottleneck.
