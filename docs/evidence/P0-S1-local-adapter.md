# P0-S1 — Local Adapter (M1) Evidence

- Date: 2026-09-27
- Node under test: Owner's Windows 11 workstation, Node.js v24.15.0
- Desktop Commander: `@wonderwhy-er/desktop-commander@0.2.51`
- Smoke client: `tests/mcp-smoke.mjs` (`@modelcontextprotocol/sdk@1.30.1`, handshake-era protocol 2025-11-25)
- Isolation: DC ran with `USERPROFILE`/`HOME` pointing to a scratch directory seeded with `{"telemetryEnabled": false}`, so the Owner's live DC config was not touched. The test fixture was inside that directory (DC's default `allowedDirectories` is the user home).

## Result summary

| Adapter | Mode | Listener | Cross-connection process state | Per-call cold start | Verdict |
|---|---|---|---|---|---|
| Supergateway 4.0.0 | stateless | `0.0.0.0:18001` + `[::]:18001` | **fail**: even the same session gets `No session found for PID` | ~2.2–2.5 s per call (11 DC processes for 11 calls) | **rejected** |
| Supergateway 4.0.0 | `--stateful` | all interfaces | **fail**: a second connection gets a fresh DC | first call per session ~2.2 s | **rejected** |
| `node-runtime/bridge.mjs` 0.1.0 | one shared DC | `127.0.0.1:18001` only | **pass** | none after startup (initialize 94 ms) | **accepted** |

Additional Supergateway observation: when a DC child was discarded, the PowerShell process it had started kept running as an orphan (killed manually).

## Bridge smoke run (AT-LOCAL checks)

```text
PASS  initialize  -- 94 ms; server desktop-commander@0.2.51
PASS  tools/list contains required Desktop Commander tools  -- 27 ms; 26 tools
PASS  create fixture directory  -- 20 ms
PASS  write fixture file  -- 300 ms
PASS  list fixture directory  -- 114 ms
PASS  read fixture file  -- 242 ms
PASS  edit fixture file  -- 883 ms
PASS  deterministic command returns mcp-relay-ok  -- 253 ms
PASS  start long-running process  -- 3135 ms; pid 15096
PASS  read long-running output (same session)  -- 1524 ms
PASS  20 repeated sequential calls stay valid  -- 6355 ms
PASS  second independent client connects  -- 11 ms
PASS  process from first connection is visible from second connection  -- 1514 ms
PASS  terminate process from second connection  -- 152 ms

ALL CHECKS PASSED
```

The long-running check includes deliberate waits: `timeout_ms` 3000 on start and 1.5 s sleeps before reads. Per-call `read_file` latency (~300 ms) was the same through stateful Supergateway, so it is DC-internal, not bridge overhead.

## Recovery and concurrency

- DC killed with `taskkill /F`: the bridge logged `DC exited`, restarted DC after 1 s, and reported `DC ready` 3.2 s after the kill. A fresh smoke run then passed. In-flight requests at crash time get a JSON-RPC error, so the failure is visible to the client.
- 3 smoke clients in parallel against one bridge: all passed. JSON-RPC id remapping kept the sessions apart.

## Resources (idle, after tests; Windows working set / private bytes)

| Process | WS | Private |
|---|---|---|
| bridge (node) | 80 MiB | 43 MiB |
| Desktop Commander (node) | 116 MiB | 111 MiB |
| **Total node-side relay stack** | **~196 MiB** | ~154 MiB |

This is within the 300 MiB node budget, before the tunnel client is added. CPU was quiescent at idle.

Disk: `node-runtime/node_modules` is 193 MiB (DC pulls PDF/Office/markdown tooling). The P3 packaging budget will account for it.

## Desktop Commander behavior relevant to MCPRelay

- Telemetry: honors `telemetryEnabled: false` (checked before every capture).
- Feature flags: DC fetches `https://desktopcommander.app/flags/v2/production.json` at start and periodically. The fetch is non-blocking with a hard timeout, so DC works without it. This is the only remaining third-party egress observed; it has no functional role for MCPRelay.
- Onboarding: DC may open a browser welcome page for new clients. The bridge starts DC with `--no-onboarding`.
- Local logs: DC writes `claude_tool_call.log` and `tool-history.jsonl` (tool arguments) under `~/.claude-server-commander/`. This is a privacy/disk note for P2.
- DC tools carry ChatGPT Apps `_meta` (`openai/outputTemplate`, UI resources). P0-S4 must check whether the gateway passes `_meta` through.
- The DC crash orphans processes DC had started. This comes from Windows process semantics. It is noted as a known issue and is not mitigated in v0.1.

## Decision

Supergateway is removed from the architecture. `node-runtime/bridge.mjs` becomes the M1 adapter under the ADR-0002 F3 same-role substitution. It is ~270 lines, uses only the official MCP SDK, reuses DC's Node runtime, and is one process with no new runtime. The node-side stack is now DC + bridge (+ tunnel client in P0-S3).

## Reproduce

```bash
npm ci --prefix node-runtime && npm ci --prefix tests
node node-runtime/bridge.mjs --port 18001            # terminal 1
node tests/mcp-smoke.mjs --url http://127.0.0.1:18001/mcp --fixture <dir inside DC allowedDirectories>
```

CI runs the same AT-LOCAL checks on `windows-latest` and `ubuntu-latest` (`.github/workflows/local-adapter.yml`).

## CI result (2026-09-28)

GitHub Actions run `36368610908` on `main@dd43d2a`: **success**.
- `windows-latest`: all 14 AT-LOCAL checks pass; the listener is loopback-only.
- `ubuntu-latest`: all 14 checks pass, including cross-connection process state. This is the first Linux evidence for the same runtime (early P5 probe). Linux file operations are much faster than on the Owner's Windows node: `read_file` ~19 ms vs ~300 ms.
