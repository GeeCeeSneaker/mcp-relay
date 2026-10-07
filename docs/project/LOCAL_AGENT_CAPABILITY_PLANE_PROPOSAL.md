# Local Agent Capability Plane and Controller Integration — Proposed Direction

## Status

**PROPOSED cross-project integration direction. Design-only; no deployment or public-contract change is authorized by this document.**

This proposal records a new demonstrated use case: MCPRelay is becoming the reusable local capability plane not only for interactive ChatGPT calls, but also for remote Reviewer automation and future local/remote Agent runtimes.

The proposal preserves MCPRelay's core product boundary:

> expose generic host capabilities through one low-overhead MCP path; do not absorb caller-specific workflow/business semantics.

The initial motivating caller is ADCP, but the design is intentionally reusable.

## 1. Evidence

MCPRelay already solved two recurring unattended-agent failure classes with general capabilities:

- ADR-0008: identity-checked process/declared-target lifecycle rather than shell stop/restart wrappers;
- ADR-0009: bounded local Git operations rather than arbitrary Git shell commands.

A third demonstrated generic gap is tracked by Issue #35:

- read-only local SQLite schema/query inspection, so automation does not need open-world exec merely to read an existing local database.

ADCP also has a concrete resource-performance requirement. A previous Controller deployment exhibited sustained high CPU. MCPRelay itself already treats low idle CPU/RSS as acceptance criteria in `RESOURCE_BUDGETS.md`.

Future Agent providers such as CodeBuddy can consume MCP servers and expose Agent SDK/ACP interfaces. That supports MCPRelay as a shared tool plane, but it does not justify provider-specific execution logic in MCPRelay.

## 2. Responsibility boundary

### MCPRelay owns

- remote authenticated routing to a node;
- generic local file capabilities;
- identity-checked process lifecycle;
- declared target lifecycle;
- bounded local Git operations;
- bounded read-only SQLite inspection;
- on-demand process/resource observation;
- audit of capability calls;
- configuration-only routing of additional co-located MCP backends when the existing gateway/tunnel can support it.

### MCPRelay does not own

- ADCP Task readiness/hold/revision;
- Reviewer recovery decisions;
- Provider session/turn semantics;
- Agent prompt/work contracts;
- workspace/result delivery state;
- GitHub PR acceptance/merge;
- a central Agent/run/session database;
- provider adapters for Codex, CodeBuddy, Claude or other vendors.

The rule is:

> A capability belongs in MCPRelay when it is a stable host operation useful across callers. A workflow/provider concept stays with its domain owner.

## 3. Capability roadmap

### 3.1 Existing — keep

- file read/write/edit boundaries;
- process identity/list/wait/stop/spawn;
- declared target status/start/stop/restart;
- local Git read/write family;
- fixed risk-class dispatch;
- one node capability process.

Do not create aliases for individual projects.

### 3.2 P0 — local SQLite read family (#35)

Implement only read semantics:

- `sqlite_schema`;
- `sqlite_query`.

Requirements from #35 remain controlling:

- allowed-root enforcement;
- true SQLite read-only/query-only behavior;
- no extension loading / ATTACH / writable PRAGMA / mutation;
- one statement;
- row/byte/time bounds;
- WAL-aware committed reads;
- structured results;
- real Scheduled Task proof.

Do not add SQLite mutation, repair, migration or a database abstraction layer.

### 3.3 P0 — generic on-demand process usage

Add one read capability, provisionally `process_usage`, if existing `cpu_time + rss` snapshots are insufficient for reliable rate attribution.

Input:

```text
ref
sample_ms
include_descendants?
```

Output:

```text
exact ref / observation interval
cpu_time_before / cpu_time_after / delta
cpu_percent normalized to one logical core
rss
descendant_count
tree_cpu_percent when requested
tree_rss when requested
partial/unavailable facts
```

Rules:

- exact process identity is rechecked before and after sampling;
- bounded sample window only;
- no background sampler, telemetry database or monitoring daemon;
- process exit during sampling is explicit, not silently converted to zero;
- descendants are included only when their parent/start relationship is identity-safe.

A declared target uses `target_status` to obtain the exact ref and then the same generic `process_usage`; do not add one resource tool per target.

### 3.4 P1 — co-located MCP backend routing by configuration

ADCP may later expose a small Controller-owned loopback MCP endpoint.

The first choice is **configuration**, not a generic plugin framework in `node-runtime/server.mjs`:

- reuse the existing outbound tunnel process with another static reverse-forward if supported;
- configure the existing MCP gateway with another namespaced backend;
- keep the Controller listener loopback-only;
- keep client/public ingress on the same authenticated gateway;
- do not add a new public port;
- do not create a second MCPRelay node capability process.

This is the same multi-backend responsibility already owned by tunnel/gateway modules.

If current tunnel/gateway components cannot route one additional co-located backend cleanly, record the incompatibility and re-evaluate. Do not automatically build a custom backend registry/proxy.

### 3.5 Future — execution-scoped Agent tool access

A second real Agent/provider may need MCPRelay tools.

Do **not** simply hand an implementation Agent the node's broad operator credential.

A future proof must identify the minimum scope dimensions, likely:

- capability names/risk classes;
- exact workspace/scratch path boundary;
- execution identity;
- lifetime/expiry;
- audit correlation.

Do not implement this as enterprise RBAC, a policy database or per-Agent Relay daemon before one real task proves the requirement.

Provider-side tool allowlists (for example CodeBuddy subagent/tool controls) are useful defense in depth but are not automatically a substitute for host-side path/capability isolation.

## 4. Risk model

Keep the existing fixed dispatcher model unless real client evidence requires a split.

Intended relative risk remains:

```text
read-only structured observation
  < non-lossy expected-state local Git write
  < generic file/process destructive mutation
  < open-world command/program execution
```

New capabilities must be classified by actual effect, not by the desire to avoid Scheduled Task approval.

A project-specific "safe wrapper" is rejected when it only disguises an open-world action.

## 5. Performance minimalism

MCPRelay's existing resource budget is part of this integration contract, not a side concern.

### 5.1 Base stack

Existing policy remains:

- node stack idle CPU should be approximately quiescent;
- sustained >1% on an otherwise idle node requires investigation;
- target aggregate idle RSS <=300 MiB;
- child workload resources are accounted separately.

### 5.2 New capability cost

SQLite read, process sampling and additional backend routing must not create:

- another permanent sampler;
- another local capability daemon;
- a polling database watcher;
- a process registry;
- a persistent metrics store;
- per-Agent Relay processes as the default.

On-demand calls may consume CPU during the request, then return to quiescence.

### 5.3 Measurement

Acceptance evidence for material integration changes records:

- exact MCPRelay version/commit;
- permanent process count;
- node capability-server RSS;
- CPU-time delta over a defined idle window;
- representative call latency;
- workload child-process CPU/RSS separately;
- any added periodic network/background traffic.

Use process identity rather than executable-name attribution.

## 6. ADCP integration contract

MCPRelay should provide the following generic building blocks; ADCP composes them:

```text
target_status / target_start / target_stop / target_restart
git_*
sqlite_schema / sqlite_query
process_info / process_usage / wait_for
file capabilities where necessary
```

ADCP remains responsible for deciding and proving:

```text
which Task may execute
START vs RESUME vs STOP
binding/run/provider identity
workspace/result ownership
exact result publication
Reviewer acceptance
```

If ADCP exposes its own MCP backend, MCPRelay routes it; MCPRelay does not reinterpret it.

## 7. CodeBuddy / additional Agent direction

Current official CodeBuddy surfaces demonstrate two different roles that must not be conflated:

1. **CodeBuddy as an Agent runtime** — controlled through its Agent SDK / ACP / HTTP surfaces.
2. **CodeBuddy as an MCP client** — consumes MCP servers/tools, including scoped tools for subagents.

Provider control belongs in an ADCP Provider Adapter.

Host tools belong in MCPRelay.

The first CodeBuddy integration should compare the official SDK and ACP boundary in a disposable proof and choose one. The SDK/HTTP surfaces are currently documented as Preview/Beta, so no CodeBuddy-specific detail should enter MCPRelay's durable public capability contract.

## 8. Explicitly rejected for now

- ADCP-specific tools in MCPRelay node core;
- a generic provider/Agent plugin system;
- a central task/run/session database;
- a queue/scheduler/failover service;
- arbitrary localhost HTTP proxying;
- a persistent metrics/telemetry service;
- a second capability daemon for each provider;
- per-project command wrappers around shell;
- resource budgets relaxed because a machine has spare hardware.

## 9. Integration phases

### R0 — complete generic gaps

- #35 SQLite read;
- on-demand process usage;
- acceptance/resource tests;
- actual Scheduled ChatGPT proof.

### R1 — ADCP generic-capability proof

- ADCP Reviewer uses only structured MCPRelay capabilities for representative local diagnosis/operator steps;
- open-world exec is exceptional;
- Controller target lifecycle is fully observable;
- resource attribution works.

### R2 — demand-resident Controller proof

ADCP changes its own lifecycle; MCPRelay only starts/stops/observes the declared target.

Pass when Controller can be absent while no work exists and still complete wake -> run -> terminal mechanics -> clean exit without weakening crash correctness.

### R3 — optional additional Controller backend

Only after ADCP architecture accepts it:

- route one loopback Controller MCP backend through existing tunnel/gateway configuration;
- measure incremental process/network/resource cost;
- prove authentication/routing isolation;
- no new node-core plugin architecture.

### R4 — second Agent / scoped tool proof

- integrate a real second provider in ADCP;
- only then determine whether execution-scoped MCPRelay grants are required;
- freeze the smallest proven contract.

## 10. Acceptance questions

Before merging implementation that expands MCPRelay for this integration, Reviewer must answer:

1. Is the capability useful outside ADCP?
2. Can an existing capability be composed instead?
3. Did the change add a permanent process/service/database?
4. Does the new operation have a narrower truthful risk class than exec?
5. Does it remain within resource budgets?
6. Can a caller misuse it to bypass path/process/identity checks?
7. Is caller/provider workflow semantics leaking into MCPRelay?
8. Can any old wrapper/process now be deleted?
9. Has actual ChatGPT/Scheduled Task behavior been tested rather than inferred?
10. Is the same capability meaningful on Linux or at least not needlessly Windows-specific?

This proposal intentionally keeps MCPRelay a small reusable capability plane while allowing ADCP and future Agents to build richer behavior above it.
