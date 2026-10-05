# WO-0007 — Local Git Operations Capability Family

- Status: `IN_PROGRESS` — implemented in node server 2.5.0, with the deterministic tests green on Windows and Linux. The real Scheduled Task proof is pending with the Owner. Evidence: `docs/evidence/P2-node-2.5-local-git-2026-10-05.md`.

## Objective

Implement and field-prove the generic local Git capability family defined by ADR-0009 so remote agents can perform normal local repository work without using arbitrary shell commands or generic filesystem mutation for routine version-control operations.

Tracking: #29.

## Required capability model

### Existing `invoke_read`

Add structured local Git read capabilities sufficient for normal decision-making:

- `git_status`
- `git_diff`
- `git_history`
- `git_refs`
- `git_worktrees`
- `git_object_info`

The implementation team may consolidate read capabilities where that produces a smaller stable schema. Do not mechanically mirror Git CLI commands.

### Existing `invoke_write` (Owner decision 2026-10-05, ADR-0009)

The bounded local Git mutations go through the existing `invoke_write`, whose class is redefined as "changes without data loss". The earlier draft's separate `invoke_git` dispatcher is not added: its MCP annotations would have equalled `invoke_write`'s, and a new fixed tool would force every ChatGPT connector to be re-added.

Initial mutation capabilities:

1. `git_fetch`
2. `git_checkout`
3. `git_ref_update`
4. `git_worktree_update`
5. `git_index_update`
6. `git_commit`
7. `git_integrate` (initially merge/cherry-pick/revert; rebase deferred)

Every capability is repository-state-oriented and must reject arbitrary shell/Git argv.

## Risk contract

The Git changes in `invoke_write` are mutating but non-open-world. Supported operations must remain lower-risk than generic filesystem destructive/write operations and arbitrary exec by enforcing repository scope, exact expected-state checks, and non-force/non-lossy semantics.

Not permitted through the Git capabilities (v1):

- hard reset/discard of local worktree or index;
- clean/untracked deletion;
- force checkout;
- force ref deletion/rewrite;
- forced removal of dirty worktrees;
- caller-supplied arbitrary patches;
- arbitrary remote URLs;
- push/force-push or remote publication;
- credentials/secrets mutation;
- destructive submodule operations.

These do not become low-risk because they are Git operations.

## Common identity/precondition contract

Every mutation must use the relevant subset of:

- repository/worktree path under allowed roots;
- Git common-dir identity;
- exact expected HEAD SHA;
- exact expected symbolic ref/branch when applicable;
- exact expected ref target for ref mutation;
- exact index/tree fingerprint for index/commit operations;
- exact dirty/conflict/untracked path set when applicable;
- exact worktree identity for worktree operations;
- exact local commit/object identity for checkout/integration.

Unexpected state fails closed before mutation where possible.

## Capability acceptance

### Read operations

1. `git_status` returns stable structured HEAD/ref/staged/unstaged/untracked/conflict facts.
2. `git_diff` is bounded and supports path filtering without mutation.
3. `git_history` returns exact commit/tree/parent identities with bounded traversal.
4. `git_refs` reports local and remote-tracking identities without mutation.
5. `git_worktrees` reports registration/path/ref/HEAD facts.
6. `git_object_info` proves exact local object/ref existence/type.

### `git_fetch`

- only configured remote names/refspecs;
- no arbitrary URL input;
- does not automatically merge/rebase/update checkout;
- returns changed tracking refs and before/after identities.

### `git_checkout`

- exact expected current HEAD/ref;
- exact desired local ref/commit;
- no force/discard;
- dirty policy only `require_clean` or proven `preserve_exact`;
- final HEAD/ref and dirty fingerprint verified.

### `git_ref_update`

- create/rename/move/delete local refs through exact CAS;
- no force semantics;
- safe delete only when configured proof condition is satisfied;
- no remote publication.

### `git_worktree_update`

- add worktree only at allowed path against exact local ref/commit;
- remove only exact clean/non-conflicted worktree;
- no forced dirty removal;
- final worktree registration verified.

### `git_index_update`

- stage/unstage exact paths only;
- expected HEAD/index identity;
- no worktree-content deletion or overwrite;
- resulting staged set and index/tree fingerprint verified.

### `git_commit`

- expected HEAD/parent and staged index/tree fingerprint;
- local commit only;
- uses configured identity, accepts no credentials;
- returns commit/ref/tree/parent identities;
- no push.

### `git_integrate`

- exact expected HEAD and exact local source commit/ref;
- initial modes: merge, cherry-pick, revert;
- no arbitrary strategy executable/options;
- conflicts cause verified abort to previous exact state when possible, otherwise explicit partial state;
- no automatic remote publication.

## Shared safety tests

At minimum test:

1. repository path outside allowed roots -> refused;
2. symlink/junction escape or common-dir mismatch -> refused;
3. stale HEAD/ref/index/worktree identity -> zero mutation;
4. unexpected dirty/conflict/untracked state -> zero mutation;
5. operation result is re-read and verified before success;
6. concurrent state change between observation and mutation -> CAS/refusal;
7. no capability accepts shell/program/Git argv;
8. no low-risk capability exposes force/discard/clean/push behavior;
9. audit output contains capability/result identity but no secrets or full command content;
10. existing file/process/read/write/destructive/exec behavior remains green.

## Real Scheduled Task proof

Use disposable repositories first.

Compare equivalent workflows through generic `invoke_exec/start_process` versus structured Git capabilities:

1. status/read control;
2. fetch configured remote;
3. clean checkout to exact commit;
4. create then remove a clean worktree;
5. stage files and create a local commit.

For each record:

- connector/app permission configuration;
- whether it executes unattended, pauses/asks for approval, or is blocked;
- whether an MCPRelay audit entry exists;
- exact catalog version and dispatcher annotations;
- resulting Git state.

The goal is truthful lower-risk expression, not bypassing ChatGPT safety. If the platform still blocks the structured mutations, do not respond by creating command-specific wrappers.

## Explicitly out of scope

- ADCP-specific deployment/recovery logic;
- GitHub Issue/PR/review APIs;
- remote push/publication;
- hard reset/clean/force variants;
- generic package/file/ACL/registry/network capabilities;
- recipe/plugin/workflow engine;
- persistent operation state or approval service.

## Exit criteria

`DEV_ACCEPTED` requires:

- all required read and mutation capabilities implemented or a documented evidence-based simplification that preserves the full routine local Git workflow;
- deterministic safety/CAS tests pass;
- no low-risk Git capability can be used as arbitrary filesystem write or arbitrary exec;
- real Scheduled Task comparison is recorded;
- minimalism review confirms the family is generic Git functionality rather than a collection of incident-specific wrappers;
- documentation clearly states which destructive/remote-write Git operations remain outside the Git capabilities (ADR-0009, catalog `environment.git.rules`).
