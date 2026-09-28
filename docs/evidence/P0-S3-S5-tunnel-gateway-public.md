# P0-S3 / S4 / S5 — Tunnel, Gateway and Public Ingress Evidence

- Date: 2026-09-28
- Public summary per `DEVELOPMENT_MANAGEMENT.md` §9. Host addresses, the domain and account details are not recorded.
- Node: Owner's Windows 11 workstation running `node-runtime/bridge.mjs` 0.1.0 + Desktop Commander 0.2.51 (isolated test profile).
- Ingress host: Linux VPS outside mainland China (see P0-S0).

## Deployed components (VPS)

| Role | Component | Version | Bind |
|---|---|---|---|
| M2 tunnel server | existing OpenSSH `sshd` + forward-only account `mcptunnel` | host OpenSSH | node ports on 127.0.0.1 only |
| M3 gateway | `R0Wi/mcp-gateway` | commit `59c1efd00e0c` (bundle sha256 `73ebe85f…d4add77`), Python 3.12 via uv 0.12.19 | 127.0.0.1:18000 |
| M4 TLS ingress | Caddy | 2.11.4 (sha512-verified) | :80, :443 |

- Installed with `scripts/vps-install.sh`, using the gateway bundle built by `scripts/build-gateway-bundle.sh`.
- Secrets (encryption key, login password) were generated on the host and never printed.
- No reverse proxy existed on the host after the Owner's cleanup, so M4 used the Caddy fallback (ADR-0002 F5).
- Let's Encrypt HTTP-01 issuance succeeded within seconds of first start.

## AT-TUNNEL — pass

Reverse forward: Windows `ssh.exe` → `mcptunnel` with `-R 127.0.0.1:18101:127.0.0.1:18001`, driven by `scripts/node-tunnel.ps1` (restart loop).

- VPS loopback → bridge `/healthz` through the tunnel: 79 ms.
- Full smoke suite (`tests/mcp-smoke.mjs`) through the tunnel: **14/14 pass**, including cross-connection process state.

Negative checks with the node's tunnel key:

| Attempt | Result |
|---|---|
| run a command | refused (`ForceCommand` nologin) |
| allocate a TTY | refused |
| `-L` to the gateway on VPS loopback | `administratively prohibited` |
| `-R` on any other port | `remote port forwarding failed` |
| `-R` on a non-loopback address | `remote port forwarding failed` |
| another key as `mcptunnel` | `Permission denied (publickey)` |
| password authentication | `Permission denied (publickey)` |

Restrictions come from `config/vps/sshd-mcptunnel.conf` (`AllowTcpForwarding remote`, `PermitTTY no`, `ForceCommand`) and per-key `restrict,port-forwarding,permitlisten="127.0.0.1:<port>"`.

## AT-PUBLIC — pass (one recommended item missing)

`tests/oauth-e2e.py` was run against the public HTTPS URL:

```text
PASS  unauthenticated /mcp -> 401 + resource_metadata
PASS  invalid bearer token -> 401
PASS  protected resource metadata (RFC 9728)  -- resource=/mcp
PASS  AS metadata advertises PKCE S256
PASS  AS metadata advertises DCR
PASS  AS metadata advertises CIMD
PASS  DCR with allowed redirect URI  -- 201
PASS  non-allow-listed redirect URI refused at authorize  -- 400
PASS  authorize redirects to login/consent UI  -- 302
PASS  wrong password rejected
PASS  login with configured user  -- 200
PASS  consent returns code + state to registered redirect URI
WARN  authorization response carries iss (RFC 9207, recommended)  -- absent
PASS  token exchange (code + PKCE verifier)  -- 200
PASS  authorization code is single-use
PASS  authenticated MCP initialize  -- 200
ALL CHECKS PASSED
```

- The redirect-URI allow-list is enforced when a client *uses* a URI (authorize), not at DCR. A rogue registration therefore cannot obtain a code.
- The gateway does not return the RFC 9207 `iss` parameter (known, ADR-0002 F2). ChatGPT lists it as recommended. It is re-assessed at AT-CHATGPT.

## Generic E2E — pass

Smoke suite through the whole chain: client → public HTTPS → Caddy → gateway (OAuth token) → tunnel → bridge → Desktop Commander. Tools appear as `win01_<tool>` (27 = 26 DC + `gateway_status`).

```text
PASS  initialize  -- server MCP Gateway@4.0.10
PASS  tools/list contains required Desktop Commander tools  -- 27 tools
PASS  create / write / list / read / edit fixture
PASS  deterministic command returns mcp-relay-ok
PASS  start long-running process; read output (same session)
PASS  20 repeated sequential calls stay valid
PASS  process from first connection is visible from second connection
PASS  terminate process from second connection
ALL CHECKS PASSED
```

Latency note:
- The test client was the Owner's workstation, whose local proxy (fake-IP DNS mode) routed the public hostname through a proxy node. TLS handshake alone took ~5 s, and calls took 1–5 s.
- Relay-internal legs are small: VPS → node via tunnel is 79 ms, and the gateway reuses backend sessions (2 bridge sessions total).
- Real ChatGPT traffic reaches the ingress directly, so latency is measured again at AT-CHATGPT.

Exposure note: internet scanners probed the hostname (e.g. `/backend/.env` → 404) within a minute of certificate issuance, as expected from Certificate Transparency. Nothing is reachable without OAuth.

## Resources (VPS, idle)

| Process | RSS |
|---|---|
| mcp-gateway | 139 MiB |
| caddy | 50 MiB |
| **MCPRelay VPS stack** | **~189 MiB** (budget ≤ 200 MiB) |

The tunnel uses the pre-existing `sshd`, so it adds no new process beyond one `sshd` session child per node.

## Status

- P0-S3: pass. P0-S4: pass. P0-S5: pass except AT-CHATGPT, which is `OWNER_VALIDATION_REQUIRED` (needs the Owner's ChatGPT account with Developer mode).
- Known issues: RFC 9207 `iss` absent (gateway); the host OS is end-of-life (P6 condition, see P0-S0); the node currently runs DC with an isolated test profile (production profile decision in P2).

## AT-CHATGPT — first connection (2026-09-28)

The Owner added the connector in ChatGPT Developer mode.

- **OAuth: pass.** ChatGPT registered via **CIMD** (`client_id` = an `https://chatgpt.com/oauth/.../client.json` URL), completed login/consent, and received a token. The missing RFC 9207 `iss` parameter did **not** block ChatGPT.
- **Protocol:** ChatGPT (`openai-mcp/1.0.0`) speaks MCP **2026-07-28** (sessionless). `server/discover` and `tools/list` succeeded through the gateway.
- **Defect found: `resources/read` → 400 (×5).** DC tags five tools with MCP-Apps/ChatGPT widget metadata (`openai/outputTemplate: ui://desktop-commander/...`).
  - The gateway namespaces resource URIs (`ui://win01/...`) but not these `_meta` references, so ChatGPT's reads fail.
  - The widget resources are also large (file preview 1.2 MB, config editor 450 KB). One read took 40 s over the cross-border tunnel test path, and the namespaced read through the gateway ended with `SSE stream ended without a response`.
- **Fix (bridge 0.2.0):** widgets are not needed for MCPRelay's purpose (remote terminal/file tools). The bridge now always strips widget metadata from `tools/list`, so clients never fetch the UI resources.
  - DC's own switch for this is a remote A/B feature flag, which is not deterministic and depends on a third party, so it was not used.
  - Verified: the public `tools/list` (2026-07-28) has 0 widget references, `win01_start_process` → `mcp-relay-ok` works through the public edge, and the gateway reconnected to the restarted bridge automatically.
- Remaining for AT-CHATGPT PASS: refresh the connector in ChatGPT and perform the list/read/command/write checks from ChatGPT itself.
