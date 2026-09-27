# ADR-0001 — Minimal Remote MCP Architecture

- Date: 2026-09-27
- Status: `PROVISIONALLY_ACCEPTED / MUST_BE_VALIDATED_BY_WO-0001`
- Change class: C3 initial architecture baseline

## Context

We need a self-hosted replacement for the practical value of Desktop Commander's hosted remote path: remote agents, especially ChatGPT, should be able to invoke tools on computers we own. We already have a VPS. The system should be secure at public ingress, simple to deploy to multiple devices later and extremely light on PC/VPS resources.

The initial service is private/self-use, so fine-grained multi-user authorization is not the current problem. The main security requirement is authenticated/encrypted public access without exposing the local PC directly.

## Decision

Use the smallest current component chain that assigns one responsibility per layer:

### Windows node
- Desktop Commander — local tools;
- Supergateway — stdio -> Streamable HTTP adaptation;
- rathole client — authenticated/encrypted outbound reverse tunnel.

### VPS
- rathole server — reverse-tunnel termination and loopback backend exposure;
- lightweight MCP gateway candidate — MCP aggregation/authentication for remote clients;
- Caddy — TLS/certificate/public reverse proxy.

The initial lightweight gateway candidate is `R0Wi/mcp-gateway`; it is not considered proven until WO-0001 verifies the actual client/auth path.

## Why no WireGuard

WireGuard is valuable when we need a general private network across multiple services/devices. MCPRelay currently needs only one application path. A narrow reverse tunnel provides NAT traversal, encryption, authentication, keepalive/reconnect behavior without virtual interfaces, routing tables and peer-network management.

WireGuard may be reconsidered if multiple non-MCP services later need stable private addressing.

## Why not a custom persistent connection

A custom WebSocket/device relay would require us to own framing, authentication, reconnect/backoff, heartbeat, connection state, device routing and protocol evolution. Existing reverse-tunnel software already solves these commodity problems.

## Why not ToolHive/HAProxy/local Caddy

They do not solve a requirement that the minimum chain cannot currently satisfy. Adding them duplicates gateway/TLS/routing responsibilities or increases deployment burden.

## Consequences

Positive:
- node requires no public inbound port;
- no general VPN;
- commodity infrastructure is delegated to existing projects;
- Windows/Linux can share most of the chain later;
- VPS remains low-resource.

Trade-offs:
- several small processes instead of one custom monolith;
- gateway compatibility is an external dependency risk;
- VPS terminates the public application trust boundary in the initial private-use model.

## Validation/stop rule

WO-0001 must prove the architecture end to end. If the lightweight gateway or any component fails a core acceptance criterion, stop at the failed boundary and document the evidence.

Do not preserve this ADR by adding compensating layers. Replace/amend the decision with the smallest architecture that the observed failure actually requires.
