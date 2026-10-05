# ADR-0009 — Local Git Operations Capability Family

- Date: 2026-10-05
- Status: `PROPOSED` (Owner approved the direction; exact contract must pass real ChatGPT Scheduled Task proof)
- Change class: C2 — node capability/risk-class interface change. No new service, daemon, database, queue, workflow engine or control plane.
- Tracking: #29

## Problem

ADCP field evidence showed that unattended ChatGPT can often inspect a local repository, run bounded diagnostics, and operate declared process targets, while a production Git mutation expressed through open-world shell execution can be blocked before the request reaches MCPRelay.

The previous ADR-0009 draft framed the requirement around one `repository_reconcile` workflow. That abstraction is too narrow for MCPRelay. MCPRelay should expose reusable host capabilities, not encode one caller's deployment/recovery recipe.

The actual reusable requirement is:

> Provide a coherent set of local Git repository operations so an agent can perform normal version-control work without requiring arbitrary shell/file mutation authority.

This capability family is about **local Git repository state**. GitHub API operations such as Issues, PRs, reviews and remote publication remain separate concerns and should use a GitHub connector/API surface when available.

## Design principles

1. **Git operations, not command wrappers.** The public contract describes repository/ref/index/worktree/commit intent. It does not expose raw Git argv or shell text.
2. **Repository-scoped.** Every operation resolves one existing Git repository/worktree inside allowed roots and validates its common-dir relationship.
3. **Expected-state guarded.** Every mutating operation has enough exact preconditions (HEAD/ref/tree/index/worktree identity as applicable) to fail closed on stale state.
4. **No silent data loss.** The low-risk Git class excludes force/lossy operations. Dirty or conflicting state causes refusal or a verified abort/rollback.
5. **Structured results.** Return Git identities and before/after facts, not terminal prose that callers must parse.
6. **No caller-supplied executable/command.** MCPRelay chooses the Git implementation internally.
7. **No ADCP-specific semantics.** No `deploy_controller`, `preserve_task_workspace`, or similar project workflow in MCPRelay.
8. **No Git framework.** This is one capability family in the existing node runtime, not a plugin/recipe system.

## Risk model

ADR-0007 currently groups capabilities into read, write, destructive and exec dispatchers. That is insufficiently precise for normal local version-control operations.

Add one fixed dispatcher:

```text
invoke_git({ capability, args })
```

`invoke_git` is a **bounded local version-control mutation class**.

Risk ordering for the supported operations is intended to be approximately:

```text
read-only
  < bounded local Git mutation
  < generic filesystem write/delete/destructive mutation
  < open-world shell/program execution
```

The reason is not that every Git command is safe. It is that the operations admitted to `invoke_git` are deliberately limited to:

- one identified repository under allowed roots;
- versioned/ref/index/worktree state with structured identities;
- exact expected-state/CAS preconditions;
- non-force, non-lossy behavior;
- deterministic verification after mutation.

`invoke_git` must be truthfully annotated as mutating (`readOnlyHint=false`) and non-open-world (`openWorldHint=false`). It should not be marked destructive if the implementation continues to exclude the destructive variants below. Exact MCP annotations follow the pinned SDK contract.

### Operations that do NOT qualify for the low-risk Git class

The following remain outside `invoke_git` v1 because they can intentionally discard data, rewrite published/local history without recovery guarantees, or create broader external effects:

- `reset --hard` or equivalent worktree/index discard;
- `git clean` / untracked deletion;
- force checkout that discards local changes;
- force branch/tag deletion or force ref rewrite;
- force worktree removal when dirty/unmerged;
- arbitrary caller-supplied patch application;
- arbitrary remote URL changes;
- push/force-push or other remote publication;
- credential changes;
- destructive submodule operations.

If later required, these must remain in an appropriately higher-risk class or receive a separately justified contract. They do not inherit lower risk merely because Git implements them.

## Capability surface

### A. Read capabilities — remain under `invoke_read`

Local Git inspection should be structured and not require shell parsing. Implement the smallest set that covers normal decision-making:

1. `git_status`
   - repository/common-dir identity;
   - HEAD SHA and symbolic ref/branch;
   - staged, unstaged, untracked and conflict path sets;
   - index/tree fingerprint suitable for CAS;
   - optional tracked diff fingerprint.

2. `git_diff`
   - structured or bounded textual diff for tracked/index comparison;
   - supports path filtering and bounded output;
   - never mutates.

3. `git_history`
   - bounded commit ancestry/log facts;
   - exact commit/tree/parent identities.

4. `git_refs`
   - local branch/tag/ref identities and configured remote-tracking refs;
   - no ref mutation.

5. `git_worktrees`
   - registered worktrees, paths, HEADs, branches and lock/prunable facts.

6. `git_object_info`
   - prove whether an exact local object/ref exists and its type/identity;
   - no arbitrary object content dump beyond bounded need.

Implementation may merge read capabilities if one smaller structured schema covers the same use cases cleanly; do not mirror every Git subcommand as a tool.

### B. Mutating capabilities — through `invoke_git`

The initial implementation should cover the normal local workflow as a coherent family.

#### 1. `git_fetch`

Fetch only from a repository's already-configured remote name and allowed configured refspecs.

- no caller-supplied URL;
- records remote/ref before and after;
- does not merge/rebase/update the checked-out branch automatically.

#### 2. `git_checkout`

Materialize an exact existing local ref/commit in an existing worktree.

- requires expected current HEAD/ref;
- dirty policy initially `require_clean` or `preserve_exact`;
- `preserve_exact` may use internal Git mechanics, but must prove the same staged/unstaged path set and diff fingerprint after transition;
- no force/discard mode.

This general capability replaces the previous one-off `repository_reconcile` concept.

#### 3. `git_ref_update`

Create, rename, advance/move, or safely delete local branch/tag refs using exact expected old identity.

- every move/delete requires CAS on the previous ref target;
- delete is allowed only when the implementation can prove the configured safe condition (for example exact expected target plus reachability/merged rule); otherwise refuse;
- no force semantics and no remote ref publication.

#### 4. `git_worktree_update`

Add or remove a registered local worktree.

- add requires exact ref/commit identity and an allowed target path;
- remove requires exact worktree identity and clean/non-conflicted state;
- no forced dirty removal;
- prune may be supported only for already-missing/prunable registrations with exact facts.

#### 5. `git_index_update`

Stage or unstage exact repository paths.

- path set must resolve inside the repository;
- expected HEAD/index identity required;
- does not delete or overwrite working-tree content;
- returns resulting index/tree fingerprint and staged path set.

#### 6. `git_commit`

Create a local commit from the already-staged index.

- requires exact expected HEAD/parent and expected staged tree/index fingerprint;
- uses repository/user configured identity; MCPRelay does not accept credential material;
- message is data, not command text;
- returns commit SHA, parent(s), tree SHA and new ref identity;
- no push/publication.

#### 7. `git_integrate`

Perform a bounded local history integration against exact local commit identities.

Initial modes may include:
- merge exact commit/ref;
- cherry-pick exact commit;
- revert exact commit.

Rules:
- exact expected HEAD required;
- clean or explicitly supported exact dirty state required;
- no caller-supplied strategy executable/options that turn it into arbitrary Git invocation;
- on conflict, automatically abort when Git can prove return to the exact previous state; otherwise report explicit partial/conflict state;
- no automatic push.

Rebase is deferred from the first implementation because its multi-step conflict/rewrite semantics add disproportionate complexity. Add it only if normal use proves the need.

## Why this is one capability family rather than many command wrappers

The capability names above describe stable Git state concerns: inspection, checkout, refs, worktrees, index, commit creation and integration. They are not a one-for-one export of Git CLI commands.

The implementation may internally invoke Git, libgit-like plumbing, or helper code. The contract remains repository-state-oriented and machine-verifiable.

A caller such as ADCP composes these generic operations:

```text
inspect repository
-> fetch configured origin if required
-> verify exact current HEAD/diff
-> checkout exact accepted commit while preserving exact delta
-> verify final state
```

MCPRelay does not know that this sequence is a Controller deployment.

## Interaction with existing MCPRelay capabilities

- Process/service lifecycle remains owned by ADR-0008 (`process_info`, `target_*`, etc.).
- Generic filesystem reads/writes remain existing file capabilities.
- Git operations should not fall back to `start_process` merely because implementation is missing; callers must explicitly choose the broader exec surface if authorized.
- GitHub-hosted remote collaboration (PR/Issue/review/merge/push policy) is not folded into this local capability family.

## Safety / identity contract

Every mutating Git capability must:

1. canonicalize and validate repository/worktree path inside allowed roots;
2. reject symlink/junction escapes inconsistent with the repository identity;
3. establish Git common-dir and worktree identity;
4. validate exact expected HEAD/ref/index/worktree facts relevant to the operation;
5. refuse unresolved conflicts unless the operation explicitly owns them;
6. refuse unexpected dirty/untracked collision state;
7. re-read identities immediately before mutation where TOCTOU matters;
8. verify final repository state before success;
9. report explicit partial outcome if the final state cannot be proved;
10. never silently clean/discard local content.

## Real ChatGPT experiment

This ADR does not claim the new risk class bypasses ChatGPT approval or safety behavior. That would be the wrong objective.

A real Scheduled Task experiment must compare representative operations performed through:

- generic `invoke_exec/start_process` shell/Git;
- structured `invoke_git` capabilities.

At minimum test:

- status/read (control);
- fetch configured remote in a disposable repo;
- clean checkout/switch to exact commit;
- create/remove a clean worktree;
- stage + local commit.

Record whether each action:

- executes unattended;
- asks/pauses for approval;
- is blocked before MCPRelay;
- reaches MCPRelay and fails for server-side contract reasons.

If `invoke_git` remains blocked for all meaningful mutations, do not respond by wrapping commands more narrowly. Reassess whether the separate class still adds enough safety/clarity to justify its connector cost.

## Minimalism

This ADR adds one capability family and one fixed dispatcher because multiple normal local Git actions share the same demonstrated trust/scoping model.

It does **not** add:

- a deployment tool;
- a generic managed-mutation framework;
- a Git workflow DSL;
- a plugin system;
- persistent operation state;
- a database/queue/approval service;
- remote GitHub automation.

The family is complete enough for routine local repository work, but destructive/force/remote-write variants stay out of the low-risk class by design.
