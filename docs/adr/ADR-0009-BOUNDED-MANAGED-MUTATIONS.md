# ADR-0009 — Bounded Managed Mutations

- Date: 2026-10-05
- Status: `PROPOSED` (Owner approved the direction; exact interface must pass real ChatGPT scheduled-task proof)
- Change class: C2 — node capability interface / risk-class change. No new service, daemon, database, queue or control plane.
- Tracking: #29

## Problem

MCPRelay deliberately exposes broad host capabilities through fixed risk-class tools (ADR-0007). This works well for reads and interactive operation, but ADCP field evidence exposed a gap for unattended Scheduled Reviewer work:

- scheduled ChatGPT could read local state;
- it could use `start_process` for diagnostic commands;
- it could use declared `target_stop` / `target_start` for a production Controller;
- when the same scheduled run attempted the actual production Git state mutation through open-world shell execution, the mutation was refused before it reached MCPRelay's audit log;
- an interactive ChatGPT run could perform the same underlying Git mutation through `start_process`.

The missing capability is not a new ADCP deployment command. The general requirement is narrower:

> Express a bounded local state transition in a form whose identity, scope, preconditions and final state are machine-verifiable without giving the caller arbitrary command execution.

OpenAI may still require confirmation or block a managed action. This ADR does not attempt to bypass platform approval or safety behavior. It improves the semantic boundary exposed by MCPRelay and then requires a real Scheduled Task experiment.

## Owner constraint

Do not wrap concrete commands or project workflows as MCP capabilities.

Rejected examples include:

- `git_reset`
- `git_apply`
- `remove_worktree`
- `deploy_adcp_controller`
- `takeown`
- `restart_<product>`

MCPRelay provides reusable host capabilities. ADCP or another caller composes them.

This follows ADR-0008: process identity, process primitives and user-declared targets solve a class of lifecycle problems without one tool per incident.

## Decision

### 1. Add one fixed `invoke_managed` dispatcher

ADR-0007 currently exposes:

- `list_capabilities`
- `invoke_read`
- `invoke_write`
- `invoke_destructive`
- `invoke_exec`

Add one sixth stable tool:

```text
invoke_managed({ capability, args })
```

`managed` means all of the following:

1. the capability may mutate local state;
2. it is **not open-world** and cannot execute caller-supplied shell, program, script, command line or arbitrary URL;
3. the affected resource is already identifiable inside MCPRelay's accepted local boundary;
4. mutation is guarded by exact expected-state / CAS-style preconditions;
5. the final state is deterministic enough to verify structurally;
6. unexpected scope, identity or state causes zero mutation where possible;
7. retries are safe through expected-state checks;
8. partial outcomes are explicit;
9. rollback is attempted only when the prior exact state can itself be proved;
10. audit records capability/result class but still do not log secrets or arbitrary caller content.

The server enforces that only capabilities registered as `managed` can run through this dispatcher.

### 2. MCP annotations must be truthful

`invoke_managed` must not be marked read-only or disguised as low-risk merely to influence ChatGPT behavior.

The intended semantics are:

- `readOnlyHint = false`;
- `openWorldHint = false`;
- mutation/destructive semantics reported truthfully;
- retry/idempotence semantics reported only if the final implementation satisfies them.

Exact annotations should follow the MCP SDK fields supported by the pinned implementation.

The purpose of a separate dispatcher is to distinguish bounded, identity-checked state transitions from:

- broad `invoke_destructive`, which currently groups unrelated destructive file/process operations; and
- `invoke_exec`, which is explicitly arbitrary execution.

A real ChatGPT scheduled-task experiment decides whether this distinction improves unattended usability. Do not infer platform behavior from annotations alone.

### 3. Initial capability: `repository_reconcile`

Only one managed capability is authorized by this ADR initially.

`repository_reconcile` describes a desired Git working-tree state. It does not expose Git subcommands.

#### Initial input contract

The exact schema may be refined in implementation, but must preserve these semantics:

```text
repository_path
expected_head                 exact full commit SHA
desired_head                  exact full commit SHA
expected_ref                  optional exact branch/ref identity
dirty_policy                  require_clean | preserve_exact
expected_dirty_paths          required for preserve_exact
expected_diff_sha256          required for preserve_exact
expected_untracked_paths      optional bounded identity check
```

Rules:

- `repository_path` must resolve inside allowed local roots and must identify exactly one Git working tree/common-dir relationship;
- both commits are local exact objects; v1 does not accept arbitrary remote URLs;
- caller cannot provide Git argv, shell text, patch text or executable paths;
- unexpected staged state, changed path set, diff fingerprint, worktree identity or ref identity fails closed;
- `preserve_exact` preserves the already-present exact tracked delta across the HEAD transition; it does not accept a new arbitrary caller patch;
- untracked content is never silently deleted or overwritten;
- no history rewriting, force push, publication, branch deletion or worktree deletion is part of this capability.

#### State transition

Conceptually:

```text
observe exact repository identity
-> verify expected HEAD/ref/worktree state
-> verify exact dirty fingerprint
-> verify desired commit object
-> prove preservation compatibility when preserve_exact
-> perform minimal local transition
-> restore/preserve exact authorized dirty state
-> verify final HEAD/ref/path set/diff fingerprint
-> return structured before/after result
```

Implementation may use Git internally, but Git command choice is an implementation detail, not part of the MCP contract.

#### Failure semantics

Before mutation:

- any identity/precondition mismatch returns a structured failure with zero mutation.

After mutation starts:

- if the previous exact state can be deterministically restored, restore and report `rolled_back`;
- otherwise stop and report an explicit partial outcome with observed final identity;
- never guess, silently clean, discard local content or continue with a mismatched fingerprint.

### 4. Complementary read capability only if required

A read capability such as `repository_status` may be added if callers need a structured way to obtain the exact CAS inputs without shell parsing.

It should return only generally useful Git facts, for example:

- repository/common-dir identity;
- HEAD SHA;
- branch/ref identity;
- staged/unstaged path sets;
- tracked diff fingerprint;
- untracked path set;
- worktree registration facts relevant to safe reconciliation.

Do not create command-specific read tools.

## Risk inventory and disposition

### Field-proven managed candidate

| Operation class | Current route | Field evidence | Decision |
|---|---|---|---|
| exact version-controlled repository transition | `invoke_exec/start_process` + shell/Git | scheduled mutation refused before MCPRelay audit; interactive execution possible | implement `repository_reconcile` first |

### Already solved generically

| Operation class | Existing MCPRelay abstraction | Decision |
|---|---|---|
| resident process/service lifecycle | ADR-0008 process refs + declared targets | keep; no new service/deployment-specific capabilities |

### Plausible but deferred

These actions can be approval-sensitive or high impact, but they are **not** automatically new MCP features:

- important-tree overwrite/delete/move;
- symlink/junction/runtime-pointer replacement;
- package/runtime install or upgrade;
- ACL/ownership/privilege changes;
- registry/firewall/proxy/network/scheduled-task configuration;
- credential/secret mutation;
- arbitrary process termination outside declared targets.

A second managed capability is added only after real repeated field evidence proves a stable reusable contract.

Potential future shapes, not approved implementation scope:

- `path_reconcile`: expected filesystem state -> desired filesystem state under allowed roots;
- `link_reconcile`: exact old link/junction target -> exact allowed new target.

Do not introduce `reconcile_resource(kind=...)`, a plugin framework, recipe language or workflow engine until at least two real managed capabilities prove a common abstraction.

## Explicit non-goals

- bypassing ChatGPT confirmations, permissions or safety controls;
- making Scheduled Tasks capable of arbitrary unattended shell execution;
- ADCP-specific deployment logic in MCPRelay;
- arbitrary patch application;
- arbitrary remote Git fetching or publication in the first implementation;
- generic package manager, registry, firewall, ACL or credential automation;
- persistent operation state, approval state or workflow state;
- database, broker, scheduler or policy engine.

## Why not put `repository_reconcile` in `invoke_destructive`?

ADR-0007 intentionally groups capabilities by fixed risk tool because ChatGPT caches tools. That also means the client sees only the broad dispatcher, not the narrower capability contract when deciding how to treat an action.

The demonstrated requirement is specifically to separate:

- arbitrary/open-world execution;
- broad unrelated destructive primitives; and
- a mutation whose target, before-state and after-state are all explicitly bounded.

This is enough field evidence to justify evaluating one additional fixed risk class. It is **not** evidence for adding many direct MCP tools.

The cost is that adding a sixth fixed dispatcher may require connector refresh/re-add. That cost is accepted only if the real scheduled-task experiment demonstrates material value.

## Acceptance

### Local deterministic tests

1. exact expected state succeeds on clean transition;
2. `preserve_exact` succeeds while preserving exact dirty-path set and diff fingerprint;
3. wrong HEAD/ref/diff/path fingerprint causes zero mutation;
4. missing desired object causes zero mutation;
5. unexpected untracked collision causes zero mutation;
6. simulated failure after transition proves verified rollback or explicit partial result;
7. no caller-supplied command/program/patch/URL can enter the managed path;
8. allowed-root and symlink/junction safety rules remain enforced;
9. existing read/write/destructive/exec behavior does not regress.

### Real client proof

Use actual ChatGPT Scheduled Task behavior, not only unit tests:

1. record the existing open-world shell mutation behavior;
2. invoke the equivalent repository state transition through `invoke_managed/repository_reconcile`;
3. record whether ChatGPT executes unattended, pauses for approval or blocks it;
4. record the app/connector permission configuration used;
5. confirm interactive behavior as a secondary comparison.

If Scheduled ChatGPT still blocks the managed mutation, do **not** respond by creating more wrappers. Keep the capability only if it still materially improves safety/clarity for supported interactive or approved workflows; otherwise reconsider the sixth dispatcher.

## Minimalism check

This change adds:

- one fixed dispatcher;
- one managed capability;
- optionally one structured read capability if implementation proves it necessary.

It does **not** add a process, service, database, configuration platform, generic workflow abstraction or ADCP-specific tool.

A future proposal for the second managed capability must cite independent field evidence and re-run the minimalism review.
