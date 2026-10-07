# WO-0009 — Exact On-Demand Process / Process-Tree Resource Sampling

- Status: `READY`
- Tracking: #37
- Program dependency: ADCP M1-B.

## Objective

Provide exact, read-only CPU/RSS sampling for one identity-stable process and optionally its proven descendant tree so Controllers, Agents and other workloads can be attributed correctly without executable-name guesses or persistent telemetry.

## Scope

Add one read capability, provisionally:

`process_usage`

Input:
- exact `pid@start` process ref;
- bounded sample interval;
- optional descendant-tree aggregation.

Return structured:
- exact process identity;
- sample start/end;
- CPU-time before/after/delta;
- CPU usage expressed unambiguously as percent of one logical core;
- RSS;
- descendant count;
- tree CPU and RSS when requested;
- process-exit/partial/unavailable facts.

100% of the primary CPU percentage means one logical core was saturated over the sample. A multi-threaded tree may exceed 100%.

## Correctness

- verify exact identity before and after sample;
- PID reuse must fail identity checks;
- process exit during sample is explicit;
- descendants are included only when parent/start relationships prove membership;
- unrelated processes are excluded;
- bounded sample duration;
- no mutation/suspend/signal.

## Acceptance

1. idle fixture samples near zero;
2. deterministic one-core busy fixture samples near one-core saturation;
3. multi-child fixture proves tree aggregation;
4. unrelated process excluded;
5. process exit during sample reported explicitly;
6. stale ref/PID reuse rejected;
7. repeated calls leave no background worker;
8. Windows and Linux share semantic output where implemented;
9. actual Scheduled Task can call through read class without open-world exec;
10. node server idle resource budget remains unchanged within measurement noise.

## Minimalism

Do not add:
- sampler thread/daemon;
- time-series database;
- persistent metrics registry;
- per-target tools such as `controller_cpu` or `agent_cpu`.

Declared targets compose:

`target_status -> exact ref -> process_usage`.

## Exit

`DEV_ACCEPTED` when exact identity/rate semantics, descendant attribution, Scheduled Task proof and resource non-regression are recorded.
