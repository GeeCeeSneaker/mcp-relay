# ADR-0002 — P0 Desk-Research Refinement of the Minimum Architecture

- Date: 2026-09-27
- Status: `ACCEPTED AS P0 WORKING PLAN / EACH DECISION VALIDATED BY THE P0 SPIKE NAMED BELOW`
- Change class: C1 refinement inside ADR-0001 (no new responsibility, no new trust boundary)
- Supersedes: nothing; refines ADR-0001 candidate ordering and required behavior

## Context

ADR-0001 named starting candidates (Caddy, `R0Wi/mcp-gateway`, rathole, Supergateway, Desktop Commander) without checking them against the real client or against each other. Before writing any config, the development team checked the current state (2026-09-27) of every candidate and of ChatGPT's remote-MCP requirements. Several findings change what P0 must prove first and the order in which candidates are tried.

Evidence is desk research (package sources, upstream docs, release metadata). Nothing here counts as runtime evidence; each item names the P0 spike that confirms or refutes it.

## Findings

### F1 — ChatGPT requires a full OAuth 2.1 authorization server (M3)

From OpenAI's MCP connector auth documentation:
- ChatGPT **cannot** present static API keys, custom headers or machine-to-machine grants. A no-auth connector would leave the public control path open, so OAuth is the only way to meet FR-5.
- Required: RFC 9728 protected-resource metadata, RFC 8414 AS metadata, authorization-code + PKCE `S256`, client registration via **CIMD (preferred) or DCR**, and the RFC 8707 `resource` parameter bound into the token audience.
- Recommended: RFC 9207 `iss` in the authorization response (`authorization_response_iss_parameter_supported`).
- Redirect URIs: `https://chatgpt.com/connector/oauth/{callback_id}` or `https://chatgpt.com/connector_platform_oauth_redirect`.
- Custom connectors require ChatGPT **Developer mode** (Settings → Security and login), which depends on the Owner's account plan.

**Update 2026-09-28 (P0-S4/S5):** the gateway passed AT-PUBLIC. The RFC 9207 `iss` response parameter is confirmed absent and is tracked until AT-CHATGPT.

Consequence: M3 must be a real OAuth AS. Writing our own is escalation (custom auth). So a gateway with a built-in, spec-compliant AS is the minimum.

### F2 — `R0Wi/mcp-gateway` fits M3 functionally and also solves M9 (multi-node)

It provides an OAuth 2.1 AS (DCR, CIMD incl. `private_key_jwt`, RFC 8414/9728/8707, PKCE S256, hashed rotating tokens), a single local login identity from YAML, Streamable HTTP proxying to multiple backends with **per-backend tool namespacing** (`<backend>_<tool>`), isolation of a down backend, and both MCP protocol eras (2025-11-25 handshake and 2026-07-28 sessionless).

Risks:
- It is a single-maintainer project with very low adoption, so supply-chain and abandonment risk is high. **Pin an exact commit or image digest and review the diff before every upgrade.**
- No RFC 9207 `iss` response parameter found in the source. ChatGPT says "should", not "must", so treat it as a P0-S5 test item.
- Python + SQLite (encrypted) + a small Svelte login/consent UI. The SQLite store and login page are intrinsic to an OAuth AS and are allowed under the M3 substitution rule. The `/ui/backends` admin page is incidental and must not become a project dependency.
- No ChatGPT-specific testing is claimed upstream (it targets Claude clients).

If it fails with ChatGPT, fix it with configuration first, then consider a small upstream patch. Only after that evaluate another OAuth-capable MCP gateway. A separate auth server in front of a non-OAuth gateway is escalation (it adds a responsibility).

### F3 — Supergateway v4 does not preserve Desktop Commander state (M1) — **highest technical risk**

Desktop Commander (DC) is a single-user **stateful** server. `start_process` / `read_process_output` / `interact_with_process` / `force_terminate` and terminal sessions live in the memory of one DC process. The FR-4 "long-running process/output handling" requirement depends on that.

Supergateway 4.0.0 source (`dist/gateways/*StreamableHttp*.js`, `lib/modernHttp.js`):
- **stateless mode spawns one child per HTTP POST**;
- **stateful mode spawns one child per legacy MCP session** and kills it on session timeout or close;
- under the 2026-07-28 sessionless protocol it also spawns a child per request, reusing one only for continuations (5 min);
- it listens with `app.listen(port)` and has no host option. That binds all interfaces, which violates M1's "loopback-only" requirement.

Expected consequences: a process started in call N is invisible in call N+1, there is a Node/DC cold start (~100 MiB and seconds) per request or session, and the adapter is exposed on the LAN. The same per-connection `createServer` pattern appears in the `mcp-proxy` npm package, so a like-for-like swap is unlikely to help.

Required M1 behavior is therefore made explicit: **exactly one long-lived DC process per node, shared by all requests and sessions and surviving gateway/tunnel reconnects, served on loopback only.**

**Update 2026-09-28 (bridge 0.4.0):** the bridge also serves the 2026-07-28 sessionless protocol through the official SDK v2 (`createMcpHandler`), which halved per-call latency via the gateway. The line count is ~390, above the < 300 target, because it now carries two protocol legs. It is still one process with no new runtime; see `docs/evidence/P2-performance-2026-09-28.md`.

**Update 2026-09-27 (P0-S1): confirmed.** Supergateway was rejected and `node-runtime/bridge.mjs` was adopted. See `docs/evidence/P0-S1-local-adapter.md`.

P0-S1 must confirm this empirically. If Supergateway fails, the same-role replacement is a **minimal project-owned stdio↔Streamable-HTTP bridge** built only on the official `@modelcontextprotocol/sdk`: one DC child, loopback bind, forward JSON-RPC requests/notifications, restart DC if it exits. This is transport adaptation between two standard MCP transports, not a custom protocol, and it removes a third-party process instead of adding one. It is autonomous (Level A) under the M1 substitution rule, provided that:
- it stays small (target < 300 lines, no framework);
- it reuses the Node runtime DC already requires;
- the size/role check is recorded in AT-MINIMALISM.

### F4 — The reverse tunnel may need no new component at all (M2)

- rathole: the last tagged release is **v0.5.0 (2023-10)**; newer builds are only a mutable `dev-latest` tag. Pinning v0.5.0 is possible but means a 3-year-old binary, and it adds a new public listener port on the VPS.
- frp: actively released (v0.71.0, 2026-08), TLS by default, token auth. It is heavier and adds a public port.
- **OpenSSH reverse forwarding** (`ssh -N -R 127.0.0.1:<port>:127.0.0.1:<local>`) uses the OpenSSH client already built into Windows 10/11 and the `sshd` already running on the VPS:
  - authenticated and encrypted;
  - adds **zero** new VPS processes and **zero** new public ports;
  - per-node isolation comes from a dedicated forward-only account and per-key `restrict,port-forwarding,permitlisten="127.0.0.1:<node port>"` in `authorized_keys`;
  - `ExitOnForwardFailure=yes` + `ServerAliveInterval` give fail-visible behavior;
  - the cost is that reconnect needs an external restart loop (P1: a small script; P3: the node lifecycle manager, which is needed anyway).

**Update 2026-09-28 (P0-S3): OpenSSH reverse forward accepted.** AT-TUNNEL passed, including negative checks. rathole/frp were not needed.

Candidate order for P0-S3 becomes: **(1) OpenSSH reverse forward, (2) rathole v0.5.0, (3) frp**. Choose the first one that passes AT-TUNNEL, including wrong-credential and recovery ≤ 60 s. This is a same-responsibility substitution that shrinks the architecture.

### F5 — Reuse existing VPS TLS ingress if present (M4)

The Owner's VPS already exists and may already run a reverse proxy on :443. If so, adding one site/route to the existing proxy is smaller than a second TLS stack. Deploy Caddy only if nothing suitable exists. P0-S0 inventories the VPS first.

### F6 — Desktop Commander has third-party egress and user-scoped state

- It sends telemetry to `telemetry.desktopcommander.app` / a Cloud Run proxy and fetches `desktopcommander.app/flags/...`. The node configuration must set `telemetryEnabled: false`, and P0-S1 records remaining outbound calls. The charter goal "without depending on a third-party relay" means DC must work with this egress blocked.
- Its config lives at `os.homedir()/.claude-server-commander/config.json` with no override variable. The Owner's machine already has a DC config from the current Desktop Commander usage. **Spikes run DC with an isolated `USERPROFILE`/`HOME`** so the Owner's live config is never modified. Whether production shares the user's DC config or uses a dedicated one is a P2 decision.

### F7 — Node lifecycle must run in the interactive user's context (M6, P3)

A Windows service runs as LocalSystem/a service account in session 0. DC commands would then run with the wrong identity, the wrong profile, and no access to the user's environment. The practical capability target ("like Desktop Commander today") implies **running as the logged-in user**, for example:
- a per-user Scheduled Task (at logon + restart-on-failure);
- or a service configured with the user's account.

P3 must choose between these with evidence. Until then, "native Windows service" in earlier documents means "native OS-managed lifecycle", not specifically the Service Control Manager.

## Decisions

1. M1 required behavior: one long-lived DC process per node, shared across requests and sessions, loopback-only listener, DC telemetry disabled. Test Supergateway first (P0-S1). Pre-approve the minimal SDK bridge as the same-role fallback.
2. M2 candidate order: OpenSSH reverse forward → rathole v0.5.0 → frp. The VPS backend binds loopback only.
3. M3: keep `R0Wi/mcp-gateway` as first candidate, pinned to an exact commit/digest. Its native namespacing is the first-choice M9 mechanism (`<node>_<tool>`).
4. M4: reuse an existing VPS reverse proxy if one exists, otherwise Caddy.
5. M6: the node runs as the interactive user. The lifecycle mechanism is chosen in P3.
6. A shared project-owned MCP smoke client (`tests/`) based on the official SDK drives AT-LOCAL, AT-TUNNEL and AT-PUBLIC with the same checks at every boundary. This is test tooling, not runtime.

## Consequences

- P0 now starts with the M1 statefulness spike. It is the most likely blocker and needs no VPS or Owner credentials.
- If F4(1) passes, the VPS stack is: existing sshd + gateway + existing or new TLS proxy. That is at most two MCPRelay-specific processes and no new public port besides 443.
- If F3's fallback is needed, the node stack is: DC + a small SDK bridge + `ssh.exe`. That is two Node processes and one OpenSSH client, with no third-party adapter.
- Owner inputs are required for VPS access, DNS and ChatGPT Developer mode. They are listed in WO-0001 and do not block local P0 work.
