# ADR-0005 — Gateway Patch: Persistent Backend Client (option A)

- Date: 2026-09-29
- Status: `ACCEPTED` (Owner request; deployed)
- Change class: C1 — a local patch to the pinned third-party gateway. There is no new component or trust boundary.

## Context

The FastMCP proxy inside `R0Wi/mcp-gateway` builds a fresh backend client for every request when handed a disconnected `Client`. Over the ~38 ms reverse tunnel, that made the gateway the dominant cost of every tool call: 2 backend sessions per call before bridge 0.4.0, and still ~0.6 s after it.

## Decision

`patches/mcp-gateway/0001-persistent-backend-client.patch` (41 lines, `gateway.py`) replaces `create_proxy(client)` with `FastMCPProxy(client_factory=...)`.

- The factory connects one copy of the configured backend client on first use and reuses it.
- A copy that reports disconnected is closed and replaced.
- Copies come from `Client.new()`, so they keep the no-header-forwarding transport. The gateway's "never forward the caller's token" invariant is unchanged.

`scripts/build-gateway-bundle.sh` applies every `patches/mcp-gateway/*.patch` on an LF checkout of the pinned commit.

Reuse is safe because the node serves the sessionless 2026-07-28 protocol (bridge ≥ 0.4.0 or the desk prototype). There is no server-side session to expire when the node restarts.

## Evidence

- Public per-call p50: 700 ms (B only) → **277 ms** (A + B); sustained 594 → 266 ms.
- Fault behavior, one call every 2 s for 100 s, with the node bridge killed and then the tunnel killed:
  - 50 calls, 1 failed (the first call after the tunnel dropped);
  - the persistent client reconnected within ~2 s;
  - the bridge restart caused no failures, only a delay.

## Consequences

- The project maintains one small patch on the pinned gateway commit. Re-validate it on every gateway upgrade.
- Upstreaming it (an outward-facing contribution) is an Owner decision.
- The first call after a tunnel break can fail once. A retry-once in the factory is a possible follow-up.
