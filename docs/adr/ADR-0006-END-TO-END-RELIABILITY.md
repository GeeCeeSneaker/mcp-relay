# ADR-0006 — End-to-End Connection Reliability

- Date: 2026-09-29
- Status: `ACCEPTED` (Owner: "connection stability and reliability first, even at some cost in performance")
- Change class: C1/C2 — configuration and small code changes inside existing components; one systemd timer.

## Principle

Every hop must either recover on its own or hide the fault from the caller. Retries are allowed only where the request provably **did not reach** its target, so a command never runs twice.

## Measures by hop

| Hop | Failure | Measure |
|---|---|---|
| Client → Caddy | gateway restarting | Caddy retries the *dial* to the gateway for 15 s (`lb_try_duration`). Only unsent requests are retried |
| Caddy / gateway process | exits (any code) | systemd `Restart=always`, `StartLimitIntervalSec=0`: never gives up |
| Caddy / gateway process | running but unresponsive | `mcprelay-watchdog.timer` (1 min). Restarts after 2 failed checks, with 90 s start grace. The Caddy check tests Caddy alone (any HTTP status), so a gateway fault never restarts Caddy |
| Gateway → node | per-request connection churn | persistent backend client (patch 0001, ADR-0005) |
| Gateway → node | tunnel reconnecting / node server restarting | connection-establishment retries with exponential backoff, ~15 s (patch 0002). Never retries a sent request |
| Gateway → node | pooled connection died with an old tunnel | the node server answers every request with `Connection: close`, so no connection outlives a tunnel. Costs ~1 tunnel RTT per call |
| Tunnel | dead link | `ServerAliveInterval 10` × 3 (node) and `ClientAliveInterval 10` × 3 (VPS): detected in ≤ 30 s, and the stale VPS listener is released |
| Tunnel | ssh exits | tray app restarts it with 1/2/5/10/15 s backoff; also immediately on resume from sleep and on network availability |
| Node server | exits / crashes | tray app restarts it (1/2/5/10/30 s). An uncaught exception exits deliberately for a clean restart. Child trees are killed via Job Objects |
| Node server | hung (alive, not answering) | tray app: 3 failed health checks (after 20 s uptime) → restart |
| Node server | one call hangs or explodes | per-call 120 s bound; errors become tool errors; output, result and session caps |
| Tray app | unexpected exception | logs it, stops its children, starts a fresh instance, exits |
| Whole node | reboot / logon | `HKCU\...\Run` starts the app hidden at logon |

## Evidence

`docs/evidence/P2-reliability-and-resources-2026-09-29.md` has the full data. Headline results:
- **Chaos run, 200 s** (1 call every 2 s; faults: node server killed, tunnel killed, gateway restarted, Caddy restarted, tunnel dropped by the VPS): **100/100 calls succeeded**. Before this ADR, the same kind of run lost 4 of 90 calls.
- **Frozen gateway (SIGSTOP):** the watchdog replaced it; healthy 18 s after the freeze in a manual run, or within ~2–3 min on the timer.
- **Frozen node server (NtSuspendProcess):** the tray app replaced it; healthy after 18 s.
- **30-minute soak:** see evidence.

## Not covered / residual

- **A Caddy restart** (rare: deploy or watchdog) can fail requests that arrive during its ~0.3 s restart. It is the edge, so nothing sits in front of it to retry.
- **A request that reached the node** when the tunnel or server died mid-call is **not** retried, by design (non-idempotent). The client sees one error.
- **Tray-app self-restart** is compiled in but was not fault-injected.
- **Reboot and sleep/resume** still need an Owner-side test (they need the physical machine).
