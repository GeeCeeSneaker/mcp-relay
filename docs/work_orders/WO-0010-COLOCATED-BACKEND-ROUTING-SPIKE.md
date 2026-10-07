# WO-0010 — Co-located MCP Backend Routing Spike

- Status: `READY`
- Tracking: #38
- Program dependency: ADCP M1-C.

## Objective

Prove the smallest way to expose a second loopback MCP backend on one managed node through the existing MCPRelay tunnel/gateway namespace.

Use a disposable fixture. Do **not** implement ADCP Controller semantics in this WO.

## Preferred result

Configuration only.

If the existing gateway/tunnel already supports another backend cleanly, record the exact supported configuration and add only the minimum reproducible test/docs.

Code is justified only if field evidence proves a small routing/namespacing/compatibility seam is missing.

## Fixture

A disposable loopback MCP backend with one deterministic read tool is sufficient.

Do not create a permanent fixture service.

## Required E2E proof

From the normal central client path:

1. existing generic node capability backend remains reachable;
2. second backend is reachable under deterministic node/backend namespacing;
3. backend unavailable is distinguishable from node unavailable;
4. fixture restart/reconnect recovers;
5. failure of second backend does not break generic node tools;
6. no new public inbound port;
7. authentication remains on the existing public/gateway boundary;
8. sanitized routing/audit evidence identifies node/backend/call.

## Resource proof

Record incremental:
- permanent process count;
- idle CPU;
- RSS;
- background network/keepalive behavior.

A configuration-only second backend should not justify a new resident proxy process unless the existing component cannot provide the required route.

## Stop condition

If satisfying this WO requires any of the following, stop and return to architecture review instead of implementing it:

- generic plugin framework;
- dynamic service registry;
- new proxy/tunnel protocol;
- new public endpoint;
- persistent workflow state;
- ADCP-specific run/binding logic in MCPRelay.

## Non-goals

- Controller endpoint implementation;
- central Management Plane;
- Agent/provider integration;
- dynamic backend enrollment;
- failover/migration;
- per-Agent Relay daemon.

## Exit

`DEV_ACCEPTED` when the existing routing path is proven sufficient or the smallest evidence-justified routing seam is implemented, with E2E isolation/reconnect/resource evidence.
