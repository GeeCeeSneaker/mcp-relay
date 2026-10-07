# Local Agent Capability Plane and Controller Integration — Proposed Direction

## Status

**PROPOSED cross-project integration direction. Design-only; no deployment or public-contract change is authorized by this document.**

This proposal records a new demonstrated use case: MCPRelay is becoming the reusable **multi-node communication and capability plane** that connects a central ADCP Management/Reviewer Control Plane to tightly paired per-node resident Controllers and future local/remote Agent runtimes.

The proposal preserves MCPRelay's core product boundary:

> provide one low-overhead authenticated communication/routing plane across many terminals, expose generic host capabilities, and route stable Controller control operations between the central Reviewer/Management Plane and each resident Controller without absorbing Controller workflow/business semantics.

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

- remote authenticated identity/routing to many nodes;
- node connection/reconnection and reachability;
- stable namespace/addressing of each terminal;
- generic local file capabilities;
- identity-checked process lifecycle;
- declared target lifecycle;
- bounded local Git operations;
- bounded read-only SQLite inspection;
- on-demand process/resource observation;
- exposure/routing of each resident Controller's fixed control surface;
- audit/correlation of capability calls;
- gateway aggregation for central management/Reviewer clients.

### MCPRelay does not own

- ADCP Task readiness/hold/revision;
- Reviewer recovery decisions;
- Provider session/turn semantics;
- Agent prompt/work contracts;
- workspace/result delivery state;
- GitHub PR acceptance/merge;
- the authoritative ADCP binding/run/session store;
- Provider adapters for Codex, CodeBuddy, Claude or other vendors;
- central placement/recovery decisions.

The central ADCP Management/Reviewer Control Plane may persist node inventory/read-model data **and its own durable runtime decisions/placement/dispatch correlation**. MCPRelay itself remains the communication/routing layer rather than the workflow scheduler or decision authority.

The rule is:

> A capability belongs in MCPRelay when it is a stable host operation useful across callers. A workflow/provider concept stays with its domain owner.

### Execution Node Stack

Operationally, each managed terminal should be deployed as one compatible **Execution Node Stack**:

```text
MCPRelay Node
+ Resident Controller
```

The two components are expected to be present together for a fully managed node.

MCPRelay owns node identity/connectivity/routing and generic host capabilities. Controller owns local Agent/runtime semantics and supervision.

They should share a compatibility/lifecycle contract (node identity, startup ordering, Controller endpoint, protocol version, health, upgrade/rollback), but they need not be one process or one repository. Keeping them logically separate lets Relay remain reusable while still making deployment/operations treat them as one node product surface.

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

### 3.4 P1 — resident Controller control surface through MCPRelay

Each managed execution terminal runs one resident Controller beside the MCPRelay Node.

MCPRelay exposes the Controller's fixed operations under the node namespace:

- `controller.snapshot` — **read**;
- `controller.apply_decision` — **exec** because success may start/resume Agent execution;
- `controller.stop_run` — **destructive**.

The stable semantic path is:

```text
ADCP Management / Reviewer Control Plane
-> MCPRelay Gateway
-> selected node
-> MCPRelay Node
-> resident Controller
```

The Controller operation remains Controller-owned. Relay authenticates, names, routes and correlates the call.

A caller must not be able to replace the typed decision reference with arbitrary Provider commands, prompts or local shell.

### 3.5 Controller endpoint integration

Preferred local implementation:

- Controller exposes one loopback-only typed MCP/RPC endpoint;
- MCPRelay Node is configured with the local Controller endpoint and accepted protocol/version range;
- Gateway exposes the Controller operations under the node namespace;
- central callers never need direct access to the Controller port;
- Relay health can distinguish "node reachable / Controller unavailable or incompatible".

If direct gateway aggregation of the Controller backend is sufficient, do not duplicate tools in the node server.

If a tiny node-side adapter is needed to present stable names, authenticate locally, translate schemas, or attach node/call correlation, it must remain stateless with respect to ADCP run/binding/workspace semantics.

Do not create a generic plugin framework before another backend proves the same integration pattern.

### 3.6 Central Management/Reviewer integration

MCPRelay should assume its normal northbound client will eventually be the ADCP Management Plane with Reviewer integrated into it, not only an interactive ChatGPT session.

Relay therefore must support clean central orchestration of:

- node reachability;
- Controller snapshot reads;
- Controller decision dispatch;
- exact stop;
- generic diagnostics/maintenance;
- multi-node correlation/audit.

Relay does **not** choose START/RESUME/STOP, select the node according to project policy, or persist the authoritative runtime decision. Those belong above Relay.

The central Management Plane may keep durable decision/placement/dispatch records. MCPRelay only needs enough transport-level call identity/audit to let that system reconcile a request with the selected node and Controller response.

### 3.7 Multi-node behavior

The first multi-node proof should use static/small-fleet node configuration.

A node is considered fully managed only when:

- Relay Node is reachable/authenticated;
- resident Controller is reachable through the local integration;
- Controller protocol/version is compatible;
- Controller snapshot is valid.

One node going offline must not break routing to another.

Do not add automatic migration/failover, a broker, dynamic service discovery or a fleet database inside MCPRelay.

### 3.8 Future execution-scoped Agent tool access

A second real Agent/provider may need MCPRelay generic host tools.

This is separate from the central Management -> Controller path.

Do not simply hand an implementation Agent the same credential/scope used by the central operator plane.

A future proof must identify the minimum scope dimensions, likely:

- capability names/risk classes;
- exact workspace/scratch path boundary;
- execution identity;
- lifetime/expiry;
- audit correlation.

Do not implement enterprise RBAC, a policy database or per-Agent Relay daemon before one real task proves the requirement.

Provider-side tool allowlists are useful defense in depth but are not automatically a substitute for host-side capability/path isolation.

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

MCPRelay provides two surfaces to the central ADCP Management/Reviewer Control Plane.

### Generic node capabilities

```text
target_status / target_start / target_stop / target_restart
git_*
sqlite_schema / sqlite_query
process_info / process_usage / wait_for
file capabilities where necessary
```

### Routed resident-Controller capabilities

```text
controller.snapshot
controller.apply_decision
controller.stop_run
```

The Controller operations are semantically owned and executed by Controller. Relay provides node identity, authentication, routing, compatibility checks and call correlation.

The Management Plane remains responsible for:

```text
Reviewer reasoning
runtime-decision persistence
which Task may execute
START vs RESUME vs STOP
which node receives the decision
placement/recovery policy
human escalation
global audit/read model
```

Controller remains responsible for:

```text
binding/run/provider truth
local capacity/resource exclusion
Agent/process/session monitoring
workspace/result ownership
exact stop completion
terminal preservation/delivery
```

GitHub remains the software-development authority for source/Task/PR/review/merge in the current workflow, but target-mode runtime decisions may originate durably in the Management Plane and travel through MCPRelay without duplicating command content in GitHub.

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
- a replicated central binding/run/session correctness database;
- automatic failover/migration or a general scheduling/queue platform before multi-node evidence;
- arbitrary localhost HTTP proxying;
- a persistent metrics/telemetry service;
- a second capability daemon for each provider;
- per-project command wrappers around shell;
- resource budgets relaxed because a machine has spare hardware.

## 9. Integration phases

### R0 — complete generic gaps

- #35 SQLite read;
- #37 on-demand process/tree usage;
- acceptance/resource tests;
- actual Scheduled ChatGPT proof.

### R1 — Execution Node Stack contract

- define MCPRelay Node + resident Controller compatibility contract;
- route Controller loopback endpoint through node/gateway namespace;
- expose `controller.snapshot/apply_decision/stop_run`;
- distinguish Relay-up/Controller-down/incompatible states;
- prove Controller supervision survives Relay restart/disconnect;
- prove combined idle resource budget.

### R2 — central Management/Reviewer proof

- one central Management Plane client reads two node/controller snapshots through Relay;
- creates/persists one bounded runtime decision;
- selects one compatible node;
- routes `controller.apply_decision`;
- correlates Controller receipt/result;
- no direct per-node shell or Controller credential from Reviewer.

### R3 — directive-authority cutover proof

- allow one proving lane to use Management Plane durable decision IDs instead of GitHub runtime-comment IDs;
- Relay transports the decision reference;
- Controller validates against the accepted authority;
- prove idempotent replay, ambiguous dispatch reconciliation and STOP;
- ensure exactly one normal directive authority/consumer.

### R4 — second Agent / multi-node proof

- run at least two Execution Node Stacks;
- integrate a real second provider on one node;
- prove node isolation and provider/capability inventory;
- do not add a provider framework to Relay.

### R5 — scoped Agent MCP tools, only if proven necessary

- one real Agent Task consumes generic Relay capabilities;
- implement smallest execution-scoped capability/path/lifetime boundary;
- prove it cannot access central Controller/operator capabilities unless explicitly granted;
- measure resource/context overhead.

## 10. Acceptance questions

Before merging implementation that expands MCPRelay for this integration, Reviewer must answer:

1. Is MCPRelay still a reusable communication/capability plane rather than an ADCP workflow engine?
2. Are MCPRelay Node + Controller one operable Execution Node Stack with an explicit compatibility contract?
3. Can the central Reviewer/Management Plane use Relay as the only normal per-node communication path?
4. Are `controller.snapshot/apply_decision/stop_run` thin routed operations with semantics remaining in Controller?
5. Is runtime-decision authority above Relay, with exactly one accepted source during migration?
6. Can Relay remain useful for diagnosis/maintenance when Controller is unhealthy?
7. Does loss/restart of Relay leave local Controller Agent supervision intact?
8. Does multi-node support avoid premature discovery/broker/failover/scheduler machinery?
9. Do the Relay Node + resident Controller remain inside measured CPU/RSS/background-I/O budgets?
10. Can future Agent tool access be separated from central operator/Controller authority?

This proposal intentionally keeps MCPRelay a small reusable capability plane while allowing ADCP and future Agents to build richer behavior above it.
