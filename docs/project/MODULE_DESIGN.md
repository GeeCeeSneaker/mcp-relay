# Module Design

This document defines **logical responsibilities and interfaces**, not mandatory process count. Multiple responsibilities may be implemented by configuration around an existing component. Do not create project-owned daemons merely to match this document.

## M1 — Local Capability Runtime

### Purpose
Expose Desktop Commander capabilities locally through a network transport that can be carried by the reverse tunnel.

### Candidate implementation
`Desktop Commander (stdio) -> Supergateway (Streamable HTTP)`.

### Inputs/outputs
- Input: local process environment and upstream Desktop Commander configuration.
- Output: loopback-only MCP HTTP endpoint.

### Required behavior
- pinned compatible versions;
- endpoint not exposed publicly/LAN by default;
- `tools/list` and representative tool calls succeed;
- stdout/stderr/protocol framing remain valid during repeated calls;
- no project-owned capability reimplementation.

### Acceptance
See AT-LOCAL in `ACCEPTANCE_TEST_PLAN.md`.

## M2 — Reverse Connectivity

### Purpose
Carry the local MCP endpoint from NATed node to a VPS loopback backend through an outbound authenticated/encrypted connection.

### Candidate implementation
`rathole client/server`.

### Required behavior
- node initiates connection;
- authenticated encryption;
- stable per-node backend mapping;
- reconnect after interruption;
- VPS backend binds loopback whenever supported;
- no general VPN requirement.

### Substitution rule
Team may replace rathole with a comparably narrow reverse-tunnel implementation if compatibility/reliability evidence requires it and the replacement does not add a new control plane/trust boundary. Record comparison and update ADR/DEVLOG.

## M3 — MCP Gateway and Authentication

### Purpose
Present one standard remote MCP surface, authenticate the remote client and route/aggregate one or more node backends.

### Candidate implementation
`R0Wi/mcp-gateway` is the first candidate, not a protected choice.

### Required behavior
- works with current ChatGPT remote MCP auth/discovery flow;
- supports current standard Streamable HTTP behavior required by clients;
- backend routing is deterministic;
- unauthenticated call cannot invoke node tools;
- multi-node representation remains understandable and collision-free.

### Substitution rule
A different gateway is autonomous if it replaces the same single responsibility and does not add persistent databases/services beyond what it intrinsically needs. Adding a custom auth server, custom MCP protocol, enterprise policy layer or separate control plane is escalation territory.

## M4 — Public TLS Ingress

### Purpose
Own public HTTPS certificate/termination and minimal reverse proxying.

### Candidate implementation
Caddy.

### Required behavior
- valid public TLS;
- automatic certificate lifecycle where applicable;
- only intended MCP/auth paths routed;
- no application logic.

The team may remove Caddy if the accepted gateway provides equally simple robust TLS/certificate handling and removing Caddy reduces total operational complexity.

## M5 — Configuration and Node Provisioning

### Purpose
Make deployments reproducible while keeping user-facing configuration minimal.

### v1 design
Start with native component config templates and a pinned component manifest. Do **not** immediately invent a unified configuration abstraction.

When Windows packaging/multi-node work proves repeated manual duplication, introduce the smallest project-owned configuration/provisioning layer necessary. Expected user-visible facts are approximately:
- node name;
- VPS hostname/port;
- generated node/tunnel credential;
- gateway/backend mapping;
- optional Desktop Commander configuration.

For self-use v1, static files plus a small provisioning script are acceptable. No central device database is required.

## M6 — Node Lifecycle and Packaging

### Purpose
Install/run/restart/uninstall the node predictably.

### Windows
Expected implementation: self-contained package with pinned runtime/dependencies plus native Windows service management or a very small proven service wrapper.

Required operations:
- install/configure;
- start/stop/status;
- restart after reboot;
- uninstall without deleting unrelated user data;
- version display.

No Electron UI or Docker Desktop dependency.

### Linux
Same logical node chain; use systemd/native packaging/scripts where practical. Do not fork the architecture.

## M7 — VPS Deployment

### Purpose
Reproducibly install/configure the public stack.

### v1 design
Prefer a small set of static configuration files plus one install/update script or a minimal Compose file **only if containers actually reduce complexity on the target VPS**. Docker is not mandatory.

Must support:
- install/update/restart/status;
- certificate/domain configuration;
- node backend additions/removals;
- secret files outside Git;
- version inventory.

Do not introduce Kubernetes, service discovery or a database for static small-fleet routing.

## M8 — Diagnostics and Evidence

### Purpose
Allow an operator/developer to identify which boundary is failing without a monitoring platform.

Minimum diagnostics:
- public endpoint/auth reachability check;
- gateway->backend reachability check;
- tunnel connection status/log location;
- local capability endpoint check;
- component/version listing;
- resource snapshot helper if useful.

Prefer shell/PowerShell scripts and native component logs. A custom always-on diagnostics daemon is not part of v1.

## M9 — Multi-node Presentation

This is a logical gateway/config concern, not necessarily a new service.

The team must experimentally choose the simplest standards-compatible approach:
1. one aggregated endpoint with namespaced tools/resources; or
2. stable per-node MCP routes under the same domain; or
3. another gateway-native mechanism.

Choice criteria: ChatGPT compatibility, unambiguous node selection, no tool-name collisions, minimum configuration/code. Do not build a fleet control plane to solve namespacing.

## Expected repository shape

The team may adjust paths, but the repository should remain understandable without a framework:

```text
config/             # sanitized native templates/examples
scripts/            # small install/provision/diagnostic scripts
packaging/windows/  # when M3 starts
packaging/linux/    # when Linux phase starts
tests/              # project-owned deterministic checks
docs/evidence/      # small sanitized milestone evidence
components.lock     # or equivalent exact version record
docs/               # design/governance/work packages
```

Do not create `src/` until MCPRelay actually owns runtime application code.
