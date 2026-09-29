# Module Design

This document defines **logical responsibilities and interfaces**, not mandatory process count. Multiple responsibilities may be implemented by configuration around an existing component. Do not create project-owned daemons merely to match this document.

## M1 — Local Capability Runtime

### Purpose
Provide the local tools (files, shell commands, long-running processes) as a loopback MCP endpoint that the reverse tunnel carries.

### Implementation (ADR-0004, accepted 2026-09-29)
`node-runtime/server.mjs` is a project-owned, single-process capability server.
- It is built on the official MCP TypeScript SDK v2 only (`@modelcontextprotocol/server` + `/node`; 7 npm packages).
- It serves 2026-07-28 natively and 2025-era clients through the SDK's stateless fallback.
- Tool names and arguments are compatible with Desktop Commander's.

History: Supergateway (rejected in P0-S1), then a bridge in front of Desktop Commander (P0–P2), then this server.

### Inputs/outputs
- Input: the interactive user's environment. `MCPRELAY_ALLOWED_DIRS` sets the file-tool roots (default: user home). `MCPRELAY_BRIDGE_TOKEN` is the gateway's bearer credential.
- Output: loopback-only MCP HTTP endpoint.

### Required behavior
- **The listener binds 127.0.0.1 only.** Every `/mcp` request needs the bearer token. The token is scrubbed from the environment of spawned commands.
- `tools/list` and representative tool calls succeed in both protocol generations.
- **One process owns all state.** Processes started with `start_process` stay addressable from later, independent requests.
- **File tools are confined to the allowed roots** (symlink/junction-safe). Shell commands run with the user's full rights (Owner decision: real identity).
- **Shell output is UTF-8** (default shell: PowerShell; `cmd.exe` on request). `force_terminate` kills the whole child tree.
- **Reliability:**
  - every call is bounded (120 s);
  - errors become tool errors, never a crash;
  - output, results and running sessions are capped;
  - `Connection: close` on every response, so no keep-alive connection can outlive a tunnel break;
  - an uncaught exception exits the process for a clean supervisor restart.
- No third-party egress.

Project-owned capability code is allowed here by ADR-0004. Keep it minimal: add tools only on demonstrated need.

### Acceptance
See AT-LOCAL in `ACCEPTANCE_TEST_PLAN.md`.

## M2 — Reverse Connectivity

### Purpose
Carry the local MCP endpoint from NATed node to a VPS loopback backend through an outbound authenticated/encrypted connection.

### Candidate implementation
Evaluate in this order (ADR-0002 F4):

1. **OpenSSH reverse forward.** Built-in Windows `ssh.exe` connects to the existing VPS `sshd` with `-N -R 127.0.0.1:<node port>:127.0.0.1:<local port>`, `ExitOnForwardFailure=yes` and `ServerAliveInterval`. It uses a dedicated forward-only VPS account and one key per node with `restrict,port-forwarding,permitlisten="127.0.0.1:<node port>"`. Reconnect comes from a restart loop (P1 script, later the M6 lifecycle manager).
2. `rathole` v0.5.0 (Noise transport).
3. `frp` (TLS + token).

Choose the first candidate that passes AT-TUNNEL.

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
`R0Wi/mcp-gateway` is the first candidate, not a protected choice. It is pinned to an exact commit or image digest because it is a low-adoption, single-maintainer project; review the diff before every upgrade.

### Client requirements (ChatGPT, verified from OpenAI docs 2026-09)
ChatGPT supports only OAuth for protected connectors. It cannot send static API keys or custom headers.

Required:
- RFC 9728 protected-resource metadata and RFC 8414 AS metadata;
- authorization code with PKCE `S256`;
- CIMD (preferred) or DCR;
- the RFC 8707 `resource` parameter bound into the token audience.

Recommended: the RFC 9207 `iss` response parameter.

Developer mode must be enabled on the Owner's ChatGPT account.

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
Reuse the reverse proxy already serving :443 on the VPS, if one exists, by adding one site/route. Otherwise use Caddy.

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
Expected implementation: a self-contained package with pinned runtime/dependencies plus a native OS-managed lifecycle.

That lifecycle must run **as the interactive user**. DC commands must have the user's identity, profile and environment, not LocalSystem/session 0 (ADR-0002 F7). Candidates:
- a per-user Scheduled Task (at logon, restart on failure);
- a service configured with the user's account;
- a very small proven wrapper.

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

First choice: option 1, using `R0Wi/mcp-gateway`'s native per-backend prefix (`win01_start_process`). Node names are short `[a-z0-9]` identifiers so prefixed tool names stay well within the 64-character tool-name limit.

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
