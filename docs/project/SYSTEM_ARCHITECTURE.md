# System Architecture

## 1. Status

This document describes the **current minimum architecture hypothesis and responsibility boundaries**. Specific package choices are provisional. The project should preserve the external contract and security boundaries, not a particular vendor/component.

## 2. External contract

Remote clients should see one stable self-hosted MCP surface, initially:

```text
https://<our-domain>/mcp
```

The client should not need to know where a node is located, whether it is Windows/Linux, or how NAT traversal works.

## 3. Minimum data path

```text
ChatGPT / MCP client
        |
        | HTTPS + supported auth
        v
+---------------- VPS ----------------+
| TLS ingress                         |
|   |                                 |
|   v                                 |
| MCP Gateway                         |
|   |                                 |
|   v                                 |
| loopback/per-node backend           |
|   |                                 |
| reverse-tunnel server               |
+---|---------------------------------+
    | encrypted tunnel initiated by node
    v
+---------------- Node ---------------+
| reverse-tunnel client               |
|   |                                 |
|   v                                 |
| local MCP HTTP adapter              |
|   | stdio where needed              |
|   v                                 |
| Desktop Commander                   |
|   |                                 |
| local files/processes/terminal      |
+-------------------------------------+
```

The named starting candidates are Caddy, a lightweight MCP gateway, rathole, Supergateway and Desktop Commander. Candidate names do not create permanent architecture obligations.

ADR-0002 refines the candidate order from desk research:
- **Reverse tunnel:** OpenSSH reverse forwarding is tried first. It reuses the built-in Windows client and the existing VPS `sshd`, so it needs no new process and no new public port.
- **Local adapter:** Supergateway is tested first. Its per-request/per-session child model is expected to break Desktop Commander's process state; the fallback is a minimal SDK-only bridge.
- **TLS ingress:** reuse an existing VPS reverse proxy if one is already present.
- **Gateway auth:** the gateway must be a full OAuth 2.1 AS, because ChatGPT supports only OAuth for protected connectors.

## 4. Responsibility boundaries

### Desktop Commander / local capability provider
Owns local MCP tools and execution. MCPRelay should not reimplement file/process/terminal capabilities already supplied upstream.

### Local MCP HTTP adapter
Adapts upstream stdio MCP to Streamable HTTP only when the selected local provider does not expose the required HTTP transport itself. Starting candidate: Supergateway. Remove this layer if it becomes redundant.

### Reverse connectivity
Provides outbound NAT traversal, authenticated encryption, heartbeat/reconnect and a stable VPS-local backend. Starting candidate: rathole. It replaces the need for a general VPN for the current one-application requirement.

### MCP gateway/auth
Exposes one or more backend MCP servers through a client-compatible standard MCP/authentication surface. Starting candidate: `R0Wi/mcp-gateway`.

If a candidate fails, the development team should first isolate the failing responsibility, then try bounded configuration correction, then evaluate a simpler/equivalent **same-responsibility replacement**. This does not require per-step Reviewer approval if total permanent architecture/trust scope does not grow. Record the comparison and decision in ADR/DEVLOG.

Adding a separate auth service, custom MCP protocol, policy platform, control-plane database or other new responsibility is architecture escalation.

### Public TLS ingress
Owns public HTTPS/certificate lifecycle and minimal reverse proxying. Starting candidate: Caddy. If the accepted gateway can own TLS/certificate lifecycle more simply, removing Caddy is preferred over preserving an unnecessary layer.

## 5. Network boundaries

Initial target:
- public VPS: TCP/443 for HTTPS MCP ingress;
- public VPS: only the minimum reverse-tunnel listener/control port(s) required for node connectivity;
- per-node backend ports bind to VPS loopback where supported;
- node: no public inbound MCP port and no router port-forward requirement;
- local MCP HTTP adapter binds only to loopback/local interface required by the tunnel.

## 6. Authentication/encryption

- Client -> VPS: HTTPS plus the authentication flow required by the accepted MCP gateway/ChatGPT integration.
- Node -> VPS: authenticated encrypted reverse-tunnel transport.
- Gateway -> node backend: VPS loopback/local backend path; no duplicate public auth layer is required for the initial private deployment.

Secrets are injected at deployment/runtime and never committed.

## 7. Multi-node shape

Multi-node is expected to be a routing/configuration extension, not a new control-plane service:

```text
node-01 -> VPS backend A
node-02 -> VPS backend B
node-03 -> VPS backend C
```

The team must experimentally select the simplest ChatGPT-compatible presentation: gateway-native aggregation/namespacing, stable per-node routes, or another standard-compatible mechanism. Static/small-fleet configuration is preferred until proven inadequate.

## 8. Windows packaging direction

Do not package an unproven runtime. After P1/P2, produce a self-contained pinned Windows distribution with minimal user configuration and predictable service lifecycle. Normal packaged operation must not require Docker Desktop or mutable `npx @latest` resolution.

## 9. Linux direction

Linux reuses the same public gateway/tunnel/application contract. Platform differences should be confined primarily to packaging/service management and unavoidable OS-specific Desktop Commander behavior. No separate Linux gateway architecture is planned.

## 10. Explicitly absent unless evidence requires them

- general WireGuard/private LAN;
- ToolHive/enterprise policy platform;
- HAProxy as an additional routing layer;
- Docker Desktop on nodes;
- local TLS/OAuth stacks on every node;
- Kubernetes;
- web admin UI;
- device database/control plane;
- custom WebSocket/device relay protocol.

These are not permanently forbidden; they require an observed need and architecture escalation because each adds a new responsibility/operational surface.

## 11. Continuous simplification

At every milestone the team and Reviewer must ask whether any adapter/proxy/service can now be removed. The desired architecture is the fewest permanent layers that satisfy the current requirements and acceptance tests.