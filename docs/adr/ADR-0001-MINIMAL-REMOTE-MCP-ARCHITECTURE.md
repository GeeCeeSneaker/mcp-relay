# ADR-0001 — Minimal Remote MCP Architecture

- Date: 2026-09-27
- Status: `PROVISIONALLY_ACCEPTED / VALIDATE AND SIMPLIFY THROUGH P0-P1`
- Change class: C3 initial architecture baseline

## Context

We need a self-hosted replacement for the practical value of Desktop Commander's hosted remote path: remote agents, especially ChatGPT, should be able to invoke tools on computers we own. We already have a VPS. The system should be secure at public ingress, simple to deploy to multiple devices later and extremely light on PC/VPS resources.

The initial service is private/self-use. Fine-grained enterprise authorization is not the current problem; authenticated public ingress, encrypted node transport and minimal operational burden are.

## Decision

Begin with one responsibility per layer:

### Node
- Desktop Commander — local file/process/terminal tools;
- Supergateway or equivalent narrow adapter — stdio -> Streamable HTTP when required;
- rathole or equivalent narrow reverse-tunnel client — outbound NAT traversal.

### VPS
- reverse-tunnel server — terminate node tunnel and expose local backend;
- lightweight MCP gateway — standard MCP aggregation/authentication/client compatibility;
- Caddy or equivalent minimal TLS termination — public HTTPS/certificate lifecycle if gateway does not already own this simply.

Candidate package names are starting points, **not protected architecture**. The development team may replace a candidate with an equivalent same-responsibility component when tests show better compatibility/simplicity and the number/trust scope of permanent services does not expand. Record the decision/evidence.

## Why no WireGuard initially

WireGuard is valuable when we need a general private network across multiple services/devices. MCPRelay currently needs one application path. A narrow reverse tunnel solves NAT traversal/encryption/keepalive without virtual interfaces, routes and peer-network administration.

Reconsider only when real non-MCP cross-device networking requirements appear.

## Why not a custom persistent connection

A custom relay would make us own framing, authentication, reconnect/backoff, heartbeat, device routing and protocol evolution. Existing tunnel software already solves this commodity problem. Custom protocol is architecture escalation.

## Why not ToolHive/HAProxy/local TLS stacks initially

They do not currently solve a requirement the minimum chain cannot satisfy and would duplicate gateway/routing/auth responsibilities. A later observed compatibility requirement can justify reconsideration, but the first response to incompatibility should be a same-role substitution, not stacking another layer.

## Why no control-plane database/UI initially

Small private fleets can be represented by static configuration plus small provisioning scripts. A database or web control plane is justified only after multi-node operation proves static management materially inadequate.

## Consequences

Positive:
- no node public inbound MCP port;
- no general VPN;
- commodity infrastructure delegated to existing projects;
- Windows/Linux can share application-level path;
- very low VPS/PC resource target;
- team can iterate component choices without reopening the whole architecture.

Trade-offs:
- several small third-party processes may exist instead of one custom monolith;
- external component compatibility must be validated empirically;
- VPS terminates the public application trust boundary in the private-use model.

## Validation and simplification rule

P0/P1 must prove the responsibilities end to end. When a candidate fails:
1. isolate the failing responsibility;
2. prefer configuration correction;
3. then test a simpler/equivalent same-role alternative;
4. do not compensate by adding parallel layers unless evidence shows a genuinely new responsibility.

At every milestone ask whether an adapter/proxy/service can now be removed because another accepted component absorbed its role.

Adding a VPN, database/control plane, custom protocol, separate auth service, materially broader public endpoint or other new responsibility requires architecture escalation under `DEVELOPMENT_MANAGEMENT.md`.
