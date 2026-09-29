# MCPRelay Project Charter

## 1. Mission

Build the smallest self-hosted system that lets remote AI agents securely invoke MCP capabilities on computers we own, without depending on a third-party relay service.

The initial functional target is **ChatGPT controlling a Windows PC through MCPRelay with practical capabilities comparable to the current Desktop Commander remote experience**: inspect files/directories, read/write permitted files, execute commands/processes and perform ordinary local development/administration tasks exposed by Desktop Commander.

The target is functional equivalence for our use case, not protocol/API compatibility with Desktop Commander's hosted relay.

## 2. Owner priorities

In priority order:

1. End-to-end functionality from ChatGPT to a local Windows machine.
2. Safe public ingress authentication and encrypted transport.
3. Minimal architecture, dependencies, code and operational burden.
4. Low idle CPU, memory, disk and bandwidth on both PC and VPS.
5. Simple Windows installation/configuration suitable for later deployment to multiple devices.
6. A shared design that can later support Linux without creating a second architecture.

Fine-grained local permission policy is not a first-stage goal because the service is initially private/self-use. The public ingress/authentication boundary must still be secure.

## 3. Initial scope

### In scope

- One self-controlled VPS as public ingress/relay.
- Windows node first.
- Standard remote MCP exposure suitable for ChatGPT.
- Desktop Commander as the initial local capability provider (replaced by the project-owned capability server on 2026-09-29, ADR-0004).
- Outbound-only node connectivity so the PC does not require public inbound ports.
- Encrypted node-to-VPS transport.
- Central TLS/authentication on VPS.
- Resource measurement on PC and VPS.
- Later multi-node and Linux support without changing the public client contract.

### Out of scope until demonstrated need exists

- General-purpose VPN/private network.
- Kubernetes or cluster orchestration.
- Desktop-side Docker requirement.
- Web management dashboard.
- RBAC/enterprise policy engine.
- Multi-tenant SaaS operation.
- Custom MCP transport or custom tunnel protocol.
- General remote desktop/video streaming.
- Automatic privilege escalation or a complex local sandbox.
- Broad monitoring/telemetry platform.

## 4. Product success criteria

The project reaches its initial product goal when all of the following are independently verified:

1. ChatGPT can connect to one stable public HTTPS MCP endpoint controlled by us.
2. The public endpoint enforces an accepted authentication flow and does not expose an unauthenticated MCP control path.
3. A Windows PC behind ordinary NAT can establish the connection without opening a public inbound MCP port.
4. ChatGPT can invoke representative local tools through the endpoint, including at minimum directory listing/file reading and a harmless command execution proof.
5. Loss/restart of the node-side connection can recover without manual network reconfiguration.
6. A second Windows node can later be added through configuration rather than architecture changes.
7. The system runs within the project resource budgets without requiring a VPS upgrade solely for MCPRelay.
8. Installation/configuration is reproducible and eventually packaged so a new Windows node requires only minimal enrollment/configuration.

## 5. Delivery strategy

The project intentionally uses vertical slices. First prove one node and one client end to end using existing components. Only after that proof should the project invest in service wrappers, packaging, multi-node management or Linux parity.

A failed dependency compatibility test is a useful result. The project must not hide a failed minimal design by silently adding layers.

## 6. Governance

Repository documents, Work Orders, Issues, PRs and exact-head review decisions are the canonical project record. Material scope/architecture changes require documented change control.
