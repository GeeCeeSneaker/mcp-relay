# P2 — Performance and Stability Measurement (2026-09-28)

- Probe: `tests/perf-probe.py`, run on the VPS against the installed node (bridge 0.3.0 → 0.3.1, real profile). Public summary; no identifiers.
- Paths measured:
  - tunnel only (VPS → node bridge);
  - full server-side path (public edge → Caddy → gateway → tunnel → bridge → DC).
- Not measured: ChatGPT's own leg (OpenAI → ingress) cannot be observed from here.

## Results

| Measurement | bridge 0.3.0 | bridge 0.3.1 |
|---|---|---|
| Tunnel RTT (`/healthz`, n=50) | p50 38 ms / p95 44 ms | p50 38 ms / p95 38 ms |
| `list_directory` direct via tunnel (n=30) | p50 57 ms / p95 149 ms | p50 55 ms / p95 132 ms |
| `list_directory` via public edge (n=30) | p50 2023 ms / p95 2065 ms | p50 1515 ms / p95 1542 ms |
| `start_process echo` via public edge (n=15) | p50 2076 ms | p50 1572 ms |
| `read_file` 1 MiB via public edge | **fail** | ok, 1.8 s |
| Sustained, 1 call / 3 s | 100/100 ok over 300 s, p50 1865 ms | 20/20 ok over 60 s, p50 1368 ms |
| Raw tunnel throughput (1 MiB result) | 1 MiB in 0.31 s (≈3.3 MiB/s) | — |

Stability:
- In ~7 h since install, the app log shows 4 child exits, all deliberately triggered by recovery tests or the bridge swap. There were no unplanned disconnects.
- Every call in all runs succeeded.

## Findings

1. **1 MiB results failed through the gateway.**
   - Cause: the gateway's HTTP client (`httpx2`) caps a single SSE event at 1 MiB (`DEFAULT_MAX_EVENT_SIZE_BYTES`), and the bridge answered POSTs as a one-event SSE stream.
   - Fix (bridge 0.3.1): `enableJsonResponse` answers POSTs with plain JSON. Server notifications still use the GET stream.
2. **Per-call latency is dominated by the gateway, not the tunnel.**
   - The FastMCP proxy opens fresh backend sessions for every request. A capture showed one public `tools/call` producing **2 backend sessions: 8 POST, 2 GET, 2 DELETE**. Each session runs `server/discover` (the bridge is handshake-era, so this is rejected) → `initialize` → `notifications/initialized` → GET stream → call → `DELETE`, and every step crosses the ~38 ms tunnel.
   - The bridge's own share is ~55 ms.
   - Improvement options:
     - persistent backend session in the gateway: expected ~0.1–0.3 s/call; needs a gateway patch;
     - 2026-07-28 support in the bridge, which removes the handshake/teardown steps: expected ~0.5 s/call;
     - both.
3. **Desktop Commander start time varies (2–30 s)** under the real profile. It waits for its remote feature-flag fetch; startup only.
