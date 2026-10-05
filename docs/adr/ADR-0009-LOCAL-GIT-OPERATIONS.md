# ADR-0009 — Local Git Operations Capability Family

- Date: 2026-10-05
- Status: `PROPOSED` (Owner approved the direction; exact contract must pass real ChatGPT Scheduled Task proof). Implemented in node server 2.5.0.
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

ADR-0007 groups capabilities into read, write, destructive and exec dispatchers.

**Owner decision (2026-10-05): no new dispatcher.** An earlier draft of this ADR added a separate `invoke_git` tool. Instead:
- structured Git reads go to `invoke_read`;
- the bounded Git changes go to the existing **`invoke_write`**.

The `write` class is redefined from "creates without changing existing data" to **"changes without data loss"**. It covers creating directories and the Git changes below. Every one of them:
- names the exact state it expects;
- never forces, overwrites or discards anything.

Overwriting or deleting stays in `destructive`.

Why:

| | readOnly | destructive | idempotent | openWorld |
|---|---|---|---|---|
| `invoke_write` (existing) | false | false | true | false |
| the `invoke_git` draft | false | false | false | false |

- The MCP annotations, which is what a client sees of a tool's risk, were identical except `idempotentHint`. Even that holds in effect: every Git change is compare-and-swap on the expected state, so repeating a call is refused with `stale_state` instead of applying twice.
- A separate tool would therefore not be treated differently by clients.
- Adding it would have changed the fixed tool set, which forces every ChatGPT connector to be refreshed or re-added (ADR-0007). Keeping the set means no connector change.
- One dispatcher less is less to maintain.

Accepted cost: a client that grants `invoke_write` grants the Git changes too; they cannot be allowed separately per tool. If the Scheduled Task proof shows that separate granting is needed, a separate class can still be split off then.

Risk ordering for the supported operations is intended to be approximately:

```text
read-only
  < bounded local Git change (class write)
  < generic filesystem write/delete/destructive change
  < open-world shell/program execution
```

The reason is not that every Git command is safe. It is that the operations admitted to the write class are deliberately limited to:

- one identified repository under allowed roots;
- versioned/ref/index/worktree state with structured identities;
- exact expected-state/CAS preconditions;
- non-force, non-lossy behavior;
- deterministic verification after mutation.

### Operations that do NOT qualify for the low-risk Git class

The following remain outside the Git capabilities (v1) because they can intentionally discard data, rewrite published/local history without recovery guarantees, or create broader external effects:

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

### B. Mutating capabilities — through `invoke_write`

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
- the structured Git capabilities through `invoke_write`.

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

If the structured Git changes remain blocked for all meaningful mutations, do not respond by wrapping commands more narrowly. Reassess whether the separate class still adds enough safety/clarity to justify its connector cost.

## Minimalism

This ADR adds one capability family, in the existing read and write classes, because multiple normal local Git actions share the same demonstrated trust/scoping model.

It does **not** add:

- a deployment tool;
- a generic managed-mutation framework;
- a Git workflow DSL;
- a plugin system;
- persistent operation state;
- a database/queue/approval service;
- remote GitHub automation.

The family is complete enough for routine local repository work, but destructive/force/remote-write variants stay out of the low-risk class by design.

## Implementation (node server 2.5.0)

The code is in `node-runtime/git.mjs` and the tests in `tests/git-ops.mjs`. The evidence is in `docs/evidence/P2-node-2.5-local-git-2026-10-05.md`. Contract decisions made while implementing:

**Git and its configuration**
- **Git:** the system Git is used (`MCPRELAY_GIT` overrides it), version 2.25 or newer. The catalog reports it in `environment.git`, and calls fail with `git_missing` without it.
- **No caller argv.** Revisions, ref names and paths are validated as data:
  - no leading `-`, no whitespace;
  - paths only after `--` and as literal pathspecs.
- **Repository content never runs code.** Every Git call sets:
  - `core.hooksPath` to a folder that does not exist, so no hooks run, including hooks that a repository (husky) keeps in its own content;
  - `core.fsmonitor=false`;
  - `--no-ext-diff --no-textconv`;
  - no submodule recursion and `protocol.ext.allow=never`.
- **User-configured programs still apply:** credential helpers, LFS filters, merge drivers and signing. Agents cannot change Git config through the write class.

**Repository scope**
- The working tree, git dir and common dir must all resolve, as real paths, inside the file roots. So a link or a `.git` file that points outside is refused.
- Changes are also refused if the working tree contains a protected or read-only folder.

**Expected state and fingerprints**
- Expected state comes from `git_status`:
  - `index_fingerprint` is the SHA-256 of every index entry (`ls-files -s`);
  - `worktree_fingerprint` is the SHA-256 of the content of every unstaged, untracked or conflicted path.
- `git_status` reports two cleanliness fields (2.5.1, #33):
  - `clean`: no staged, unstaged, untracked or conflicted paths, as in Git's "working tree clean";
  - `tracked_clean`: the same without untracked files. This is what `dirty_policy: require_clean` and `git_integrate` require.
  - Ignored files count for neither field. Worktree removal additionally refuses untracked and ignored files.
- A name such as a branch, tag or `origin/main` must be pinned with `expected_target`/`expected_source`, unless a full SHA is given.

**Per operation**
- **`git_checkout`:**
  - uses `git switch --no-overwrite-ignore`, so ignored files are never overwritten either;
  - `preserve_exact` verifies afterwards that every dirty path has the same index entry and the same content.
- **`git_commit`:**
  - is built with plumbing (`write-tree`, `commit-tree`), then `update-ref HEAD <new> <expected_head>`;
  - the branch moves only by compare-and-swap, and no hook or editor runs.
- **`git_ref_update`:**
  - covers branches and lightweight tags;
  - moves and deletes are compare-and-swap through `update-ref --stdin`;
  - "no commit lost": a move must be a fast-forward, or the old commit must stay reachable from a worktree HEAD, another local branch or (branches only) the upstream; the same holds for delete;
  - a branch checked out in a worktree is not moved or deleted (`ref_in_use`).
- **`git_worktree_update`:**
  - `add` and `remove` only; prune is not offered;
  - removal is refused if the worktree has untracked or ignored files, because `git worktree remove` would delete ignored files silently.
- **`git_integrate`:**
  - on failure an operation in progress is aborted;
  - the previous HEAD, branch and index are verified before `conflict` (or `nothing_to_commit` for an empty pick) is reported;
  - if that cannot be proven, the result is `partial_state`.

**Concurrency and new error codes**
- One change at a time per repository (common dir); another is refused with `busy`.
- New error codes:
  - `not_a_repository`, `stale_state`, `ref_in_use`, `nothing_to_commit` → fix_args;
  - `dirty_worktree`, `conflict`, `not_merged`, `operation_in_progress`, `partial_state`, `git_failed`, `git_missing` → ask_user;
  - `fetch_failed` → retry_later.
- The audit line of a Git change carries `git_head` (the resulting commit), never messages, paths or diffs.

**Not in this version:** rebase, annotated tag creation, worktree prune, submodule operations.
