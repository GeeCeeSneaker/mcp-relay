# System Architecture

## 1. Status

This document describes the **current minimum architecture hypothesis**. It is intentionally subject to replacement when WO-0001 produces evidence. It is not a requirement to preserve specific vendors/components when they fail the project goal.

## 2. External contract

Remote clients should see one stable endpoint:

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
| Caddy                               |
|   |                                 |
|   v                                 |
| MCP Gateway                         |
|   |                                 |
|   v                                 |
| 127.0.0.1:<per-node-backend-port>   |
|   |                                 |
| rathole-server                      |
+---|---------------------------------+
    | encrypted tunnel initiated by node
    v
+-------------- Windows node ---------+
| rathole-client                      |
|   |                                 |
|   v                                 |
| Supergateway                        |
|   | stdio                           |
|   v                                 |
| Desktop Commander                   |
|   |                                 |
| local files/processes/terminal      |
+-------------------------------------+
```

## 4. Component responsibilities

### Desktop Commander
Owns local MCP tools and local execution. We do not reimplement its file/process/terminal capability unless a concrete missing requirement appears.

### Supergateway
Adapts Desktop Commander's stdio MCP transport to Streamable HTTP for the tunnel/gateway path. It exists only while Desktop Commander does not provide the required HTTP endpoint directly.

### rathole
Provides outbound reverse tunneling, NAT traversal, encryption/authentication, heartbeat/reconnect primitives and a stable loopback backend on the VPS. It replaces the need for WireGuard or a custom WebSocket relay for the current single-application use case.

### MCP Gateway
Candidate responsibility: expose/aggregate backend MCP servers and provide a ChatGPT-compatible authentication flow. `R0Wi/mcp-gateway` is the current candidate, but WO-0001 must prove compatibility before it is treated as accepted architecture.

If the candidate fails, the implementation must stop and report the exact incompatibility. Substituting a heavier gateway or writing a custom one requires a new/updated Work Order.

### Caddy
Terminates public TLS and maintains certificates. It should not become an application platform.

## 5. Network boundaries

Initial target:

- Public VPS: TCP/443 for HTTPS MCP ingress.
- Public VPS: only the minimum rathole listener/control port(s) required for node tunnels.
- Per-node rathole backend ports bind to VPS loopback only where supported.
- Windows node: no public inbound MCP port and no router port-forward requirement.
- Supergateway should bind only to the local interface needed by rathole, preferably loopback.

## 6. Authentication/encryption

- Client -> VPS: HTTPS plus the authentication flow required by the selected MCP gateway/ChatGPT integration.
- Node -> VPS: rathole encrypted/authenticated transport (TLS/Noise or equivalent supported secure mode selected during implementation).
- Gateway -> rathole backend: loopback on the VPS; no second public auth layer is required for the initial private deployment.

Secrets are injected at deployment/runtime and must not be committed.

## 7. Multi-node shape

The expected extension is configuration, not architecture:

```text
node-01 -> VPS loopback backend A
node-02 -> VPS loopback backend B
node-03 -> VPS loopback backend C
```

The gateway owns how these are presented/namespaced to the remote MCP client. The exact namespace scheme is not frozen until one-node compatibility is proven.

## 8. Windows packaging direction

Do not implement packaging before the end-to-end stack works. Expected later direction is a self-contained node package containing pinned runtime/dependencies, a small config surface and one OS service entry. Online `npx @latest` installation is not a production target.

## 9. Linux direction

Linux should reuse the same application-level chain and configuration semantics wherever practical, replacing Windows service management with systemd only when the Windows contract is known. No separate Linux gateway architecture is planned.

## 10. Explicitly not in initial architecture

- WireGuard;
- ToolHive;
- HAProxy;
- Docker Desktop on nodes;
- local Caddy/TLS/OAuth on each node;
- Kubernetes;
- web admin UI;
- device database/control plane;
- custom WebSocket/device relay protocol.

These may be reconsidered only when an observed requirement justifies them.
