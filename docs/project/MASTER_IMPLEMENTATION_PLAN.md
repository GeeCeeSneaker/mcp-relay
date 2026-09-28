# Master Implementation Plan — v1

## 1. Execution authority

**This entire v1 plan is pre-authorized by the Owner.** The development team does not need Reviewer approval to move from one phase to the next when the phase exit criteria are satisfied and no escalation trigger is crossed.

The team may:
- create/decompose Issues and branches/PRs;
- change task ordering when dependencies permit;
- run work in parallel;
- fix discovered defects;
- refactor/delete unnecessary code;
- choose exact versions and equivalent same-responsibility components;
- improve scripts/tests/docs;
- merge ordinary pre-authorized implementation changes according to repository/CI discipline;
- proceed into the next phase based on recorded evidence.

Reviewer may review asynchronously and can reopen incorrect/over-complex decisions. Final release qualification requires independent exact-head review.

## 2. Escalation triggers

Pause only the affected architectural decision and request Owner/Reviewer decision when work would:
- add a new permanent network service/process category not represented in module design;
- introduce a custom MCP/tunnel/auth protocol;
- add a general VPN, database/control plane, broker, Kubernetes or web management platform;
- materially broaden public or local-machine exposure;
- change the public client contract in a way that breaks prior accepted clients;
- require destructive/irreversible Owner data or infrastructure actions;
- require new paid third-party infrastructure/service dependency;
- weaken encryption/authentication to make the system work.

Routine dependency incompatibility is **not** automatically escalation: the team may evaluate and adopt a simpler equivalent component inside the same logical module, document the evidence, and continue.

## 3. Phase sequence

```text
P0 Architecture compatibility spike
          |
P1 Windows single-node vertical slice
          |
P2 Reliability + reproducible configuration
          |
P3 Windows packaging/service lifecycle
          |
P4 Multi-node Windows
          |
P5 Linux parity
          |
P6 v1 release qualification
```

P0/P1 are strongly sequential. After P1, diagnostics/tests/documentation can advance in parallel with later phases. P5 may start once the Windows runtime/config contract is stable; it need not wait for every multi-node convenience.

## P0 — Compatibility and component selection

### Objective
Validate the risky external compatibility assumptions before writing substantial project code.

### Required work
1. Pin candidate Desktop Commander + Supergateway and prove local Streamable HTTP behavior.
2. Prove candidate reverse tunnel carries repeated MCP calls correctly.
3. Prove candidate gateway authentication/discovery against a standard remote MCP client and then actual ChatGPT where account access permits.
4. Confirm Caddy/public TLS route.
5. Record exact versions and incompatibilities.

### Spike sequence (refined by ADR-0002)

Ordered by risk and by dependency on Owner inputs. Local spikes need no VPS access and start immediately.

| Spike | Boundary | Needs | Pass criteria | If it fails |
|---|---|---|---|---|
| P0-S1 | M1 local adapter | node only | AT-LOCAL incl. **process state persists across separate HTTP requests/sessions**, loopback-only listener, DC telemetry off, idle RSS recorded | SDK bridge fallback (ADR-0002 F3) |
| P0-S2 | shared smoke client | node only | one `tests/` script runs the same AT checks against any URL (+ optional bearer) | — (test tooling) |
| P0-S0 | VPS inventory | Owner: VPS SSH access | OS, free RAM, existing :443 proxy, sshd config, Docker/Python availability recorded (sanitized) | — |
| P0-S3 | M2 tunnel | S1 + S0 | AT-TUNNEL via OpenSSH reverse forward (forward-only key, `permitlisten`, loopback bind); wrong key rejected; recovery ≤ 60 s with restart loop | rathole v0.5.0, then frp |
| P0-S4 | M3 gateway | S0 | pinned gateway on VPS loopback; standard MCP client completes DCR/CIMD + PKCE login; unauthenticated `/mcp` → 401 with `resource_metadata`; namespaced DC tools listed | config fix → upstream patch → alternative gateway |
| P0-S5 | M4 + ChatGPT | S3 + S4 + Owner: DNS name, ChatGPT Developer mode | valid public TLS; AT-PUBLIC; AT-CHATGPT or `OWNER_VALIDATION_REQUIRED` | reverse-proxy/gateway config; RFC 9207 gap assessed here |

S1 and S2 run first. S0 runs as soon as the Owner provides VPS access. S3 and S4 can run in parallel after that.

### Team freedom
If a candidate fails, compare the smallest equivalent alternatives for that same module. Do not preserve a candidate for architectural pride.

### Exit
- chosen component for M1-M4 roles recorded;
- no known protocol/auth blocker;
- no custom service needed;
- preliminary resource snapshot available.

## P1 — Windows single-node vertical slice

### Objective
Deliver the first real user value: ChatGPT/remote MCP invokes local Windows Desktop Commander tools through our VPS.

### Functional acceptance
- public authenticated HTTPS MCP endpoint;
- NATed Windows node with no public inbound MCP port;
- remote `tools/list` succeeds;
- representative directory listing;
- file read and controlled write/edit in a test fixture;
- deterministic shell command;
- long-running process/output interaction representative of Desktop Commander;
- repeated calls over one session/path do not corrupt protocol state.

### Deliverables
- minimal config templates;
- component lock/version record;
- manual deployment/runbook;
- sanitized E2E evidence;
- resource measurement.

### Exit
AT-LOCAL, AT-TUNNEL, AT-PUBLIC, AT-E2E pass. If actual ChatGPT access is Owner-only, mark the one missing test `OWNER_VALIDATION_REQUIRED` and continue engineering; do not fake the result.

## P2 — Reliability and reproducible configuration

### Objective
Turn the successful spike into a stable runtime chain without adding platform machinery.

### Required work
- deterministic start/stop/status commands;
- automatic tunnel reconnect using native component behavior;
- defined behavior for gateway/node offline states;
- node/VPS config templates and secret-placement rules;
- restart tests: node component, VPS component, node reboot simulation where available;
- minimal diagnostics scripts;
- CI for project-owned scripts/config validation;
- remove spike-only artifacts and unnecessary wrappers.

### Exit
- automatic recovery after controlled failures;
- no manual routing edits needed after transient disconnect;
- operator can identify failing boundary from native logs/status;
- repo can reproduce deployment from clean machine/VPS with secrets supplied separately.

## P3 — Windows packaging and service lifecycle

### Objective
A new Windows machine can be brought online with minimal manual setup.

### Required work
- freeze exact runtime/dependency set;
- choose smallest packaging approach based on measured chain;
- package node dependencies or deterministic offline/installer acquisition;
- one normal service lifecycle visible to operator where practical, **running in the interactive user's context** so DC commands have the user's identity/profile (ADR-0002 F7; per-user Scheduled Task vs. user-account service chosen by evidence);
- install/start/stop/status/restart/uninstall;
- reboot auto-start;
- config/secret location documented;
- version command/report;
- upgrade path for package-to-package update.

### User-experience target
Installation should require only the minimum node-specific values/secret bundle. Avoid asking the user to install Node/npm/Docker/individual dependencies manually if the project can package them reproducibly.

### Exit
Fresh Windows validation: install -> configure -> connect -> ChatGPT/remote tool call -> reboot -> reconnect -> uninstall. No mutable `@latest` runtime dependency resolution.

## P4 — Multi-node Windows

### Objective
Operate at least two Windows nodes through the same VPS/public system without architecture changes.

First-choice mechanism (ADR-0002): one gateway backend per node, using the gateway's native `<node>_<tool>` namespacing, one tunnel port per node, and one forward-only SSH key per node restricted by `permitlisten`.

### Required work
- stable node naming/identity;
- deterministic backend allocation;
- choose and document simplest client-visible node selection/namespacing;
- add/remove node procedure;
- offline node does not break unrelated node;
- no tool collision/accidental cross-node routing;
- static/small-fleet configuration remains source of truth unless proven insufficient.

### Exit
Two nodes online simultaneously; client can intentionally invoke each; shutting down one leaves the other functional; adding/removing a node requires configuration/provisioning only.

## P5 — Linux parity

### Objective
Add Linux node support while preserving the public/gateway contract.

### Required work
- validate Desktop Commander/Supergateway or accepted local runtime on Linux;
- reuse reverse tunnel and config semantics;
- systemd/native lifecycle;
- package/install/uninstall scripts/artifact;
- Linux-specific path/shell/process differences tested;
- avoid retrofitting a large cross-platform framework unless duplication proves material.

### Exit
Fresh Linux host can install/configure/connect; representative file/terminal/process tests pass through the same public MCP system; Windows remains unaffected.

## P6 — v1 release qualification

### Objective
Prove the system is safe enough, stable enough and simple enough for regular private use.

### Required work
- full acceptance matrix in `ACCEPTANCE_TEST_PLAN.md`;
- unauthenticated/invalid-auth negative tests;
- 24h idle/periodic-call soak on at least one node when practical;
- controlled reconnect/restart tests;
- Windows + Linux install/rebuild evidence;
- two-node isolation test;
- resource budgets reviewed;
- dependency/license/version inventory;
- user/operator documentation;
- remove dead code/spike configs/unneeded dependencies;
- final minimalism review: attempt to delete/merge layers before v1 freeze.

### Final v1 acceptance
- actual ChatGPT proof on at least one Windows node;
- required capability matrix pass;
- no known unauthenticated public-control path;
- normal recovery works;
- Windows distribution is simple and reproducible;
- Linux parity proven;
- multi-node proven;
- resource budgets acceptable or explicitly justified;
- independent Reviewer PASS/PASS_WITH_CONDITIONS on exact release head.

## 4. Parallel work guidance

Safe parallel streams after P1:
- runtime/reconnect tests;
- diagnostics and docs;
- Windows packaging experiments;
- gateway multi-node presentation experiments;
- Linux compatibility probe once local runtime contract is stable.

Do not parallelize by creating competing permanent frameworks. Experiments should converge to one selected path and delete losers.

## 5. Definition of program complete

The project reaches v1 when P6 passes. Future UI, automatic enrollment, fleet database, update service or broader remote-access features are post-v1 proposals requiring observed operational need.
