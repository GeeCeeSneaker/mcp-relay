# System Requirements

## 1. Product boundary

MCPRelay is a private/self-hosted remote-MCP access system. It exposes the local capabilities of computers we own safely and simply to remote MCP clients.

Originally it transported Desktop Commander's tools. Since ADR-0004 it ships its own minimal capability server with DC-compatible tool names.

## 2. Functional requirements

### FR-1 Single remote MCP entry point
Remote clients connect to one stable HTTPS MCP endpoint controlled by us. Client configuration must not expose node-side tunnel details.

### FR-2 ChatGPT compatibility
The public endpoint must support the authentication/discovery/transport behavior required for ChatGPT remote MCP connection at the time of implementation. Compatibility must be proven with the real client, not inferred from documentation alone.

### FR-3 Outbound-only node connectivity
A node behind normal NAT/dynamic residential networking must work without router port forwarding or a public inbound MCP listener. The node initiates connectivity to the VPS.

### FR-4 Local capability transparency
The node capability server must provide, at minimum:
- file/directory inspection;
- file read/write/edit;
- terminal command execution;
- long-running process/output handling representative of normal Desktop Commander use.

Tool names and arguments stay compatible with Desktop Commander's, so clients and tests are unaffected. Further tools (e.g. PDF/Office readers) are added on demonstrated need (ADR-0004).

### FR-5 Encrypted/authenticated transport
Client->VPS uses HTTPS and accepted client authentication. Node->VPS uses authenticated encrypted transport. Public unauthenticated requests must not gain functional tool execution.

### FR-6 Node identity and routing
Each configured node has a stable unique name/ID. In multi-node mode, a remote client can select/identify the intended node without collisions. The exact presentation may be gateway namespace, separate routes/endpoints or another standard-compatible mechanism; choose the simplest proven option.

### FR-7 Reconnect and restart recovery
Tunnel/runtime interruption, node reboot and VPS process restart must recover without reconfiguring network topology. v1 should recover automatically once connectivity and processes are restored.

### FR-8 Windows packaging
A Windows user must be able to install/start/stop/uninstall the node from a self-contained, pinned release without installing Docker Desktop and without resolving mutable `latest` dependencies at every start.

### FR-9 Multi-node operation
Adding a second Windows node must require configuration/provisioning only, not application code or architecture changes.

### FR-10 Linux parity
Linux must use the same public MCP contract and substantially the same node configuration semantics. Platform differences should be limited primarily to packaging/service lifecycle and OS-specific Desktop Commander behavior.

### FR-11 Minimal operational diagnostics
Operators must be able to determine: public gateway up/down, node tunnel connected/disconnected, backend reachable/unreachable, and relevant component versions. Prefer native logs/status commands plus small scripts; do not build a monitoring platform.

### FR-12 Reproducible deployment
Repository plus documented secret provisioning must be sufficient to rebuild VPS and node deployments. Third-party component versions must be pinned/recorded.

## 3. Non-functional requirements

### NFR-1 Minimalism
The project minimizes permanent processes, custom code, configuration layers and resource usage. A working design with fewer owned components is preferred even when a larger platform offers more optional features.

### NFR-2 Resource efficiency
Initial architecture must fit the budgets in `RESOURCE_BUDGETS.md`; measured software overhead is optimized before hardware is scaled.

### NFR-3 Failure visibility
No silent fallback from authenticated to unauthenticated access, encrypted to plaintext public transport, intended node to another node, or configured backend to a different endpoint.

### NFR-4 Low operational burden
Normal operation must not require a continuously running custom control plane, database or message broker unless later evidence demonstrates need.

### NFR-5 Cross-platform portability
Project-owned orchestration/config should avoid Windows-only assumptions where a simple shared representation works, while avoiding premature abstraction before Linux implementation proves what is shared.

### NFR-6 Upgrade safety
Component upgrades are explicit, pinned and testable. Automatic unbounded dependency upgrades are not part of v1.

### NFR-7 Repository hygiene
Secrets and sensitive local-machine evidence never enter Git. Sanitized evidence must still identify exact versions/config shape/test outcomes.

## 4. v1 explicit non-requirements

Not required for v1 unless evidence forces reconsideration:
- general VPN/private LAN;
- enterprise RBAC/multi-tenancy;
- web administration dashboard;
- central fleet database;
- Kubernetes;
- remote GUI/video desktop;
- automatic privilege escalation;
- custom MCP/tunnel/auth protocol;
- high-scale fleet support beyond small private deployment.
