# Evidence — Node server 2.5.0: local Git operations (ADR-0009 / WO-0007)

- Date: 2026-10-05
- Windows host: the Owner's Windows 11 PC, Git 2.54.0.windows.1. The server ran from the repository on a test port, with its own token and a scratch root.
- Linux: covered by CI (`tests/git-ops.mjs` on ubuntu-latest).
- Owner decisions applied:
  - Git changes go in the existing `invoke_write` class (no `invoke_git` tool, so no connector change);
  - repository hooks are disabled;
  - deleting or moving a ref requires that no commit is lost;
  - one PR.

## Capabilities

| Class | Capabilities |
|---|---|
| read (`invoke_read`) | `git_status`, `git_diff`, `git_history`, `git_refs`, `git_worktrees`, `git_object_info` |
| write (`invoke_write`) | `git_fetch`, `git_checkout`, `git_ref_update`, `git_worktree_update`, `git_index_update`, `git_commit`, `git_integrate` |

- The exposed tools are unchanged: `list_capabilities` plus four `invoke_*` tools with the same annotations.
- Only the `invoke_write` title and description text changed. ChatGPT keeps its cached copy, which is harmless: the server enforces classes, and `list_capabilities` is authoritative.

## WO-0007 shared safety tests → checks

| # | WO-0007 requirement | Check in `tests/git-ops.mjs` | Windows |
|---|---|---|---|
| 1 | Repository outside the roots refused | repository outside the file roots … refused | PASS |
| 2 | Symlink/junction escape or common-dir mismatch refused | junction and `.git` file pointing to a repository outside the roots | PASS |
| 3 | Stale HEAD/ref/index/worktree → zero mutation | checkout (stale HEAD, stale pinned name, stale fingerprint), index (stale index), commit (stale index), ref move (stale `expected_old`), worktree remove (stale HEAD) | PASS |
| 4 | Unexpected dirty/conflict/untracked → zero mutation | checkout and integrate on a dirty tree; worktree remove with untracked and with ignored files; checkout over an ignored file | PASS |
| 5 | Result re-read and verified | every change re-reads the state (`new`, parents, tree, registration) before success; `partial_state` otherwise | PASS |
| 6 | Concurrent change between observation and action → refused | a commit made outside between `git_status` and `git_commit` → `stale_state` | PASS |
| 7 | No shell/program/Git argv | `--output=…` as a revision, `args`, `url` and `force` arguments → `invalid_args`; no file created | PASS |
| 8 | No force/discard/clean/push | not offered; ref moves that would lose commits → `not_merged`; checked-out branch → `ref_in_use` | PASS |
| 9 | Audit: identity, no secrets or content | the `git_commit` audit line carries `git_head` = the new commit; the commit message is absent | PASS |
| 10 | Existing behavior stays green | `tests/mcp-smoke.mjs` (both eras, `--destructive-ok`), `tests/process-lifecycle.mjs`, `tests/compare-ext.mjs` | ALL PASSED |

Per-capability acceptance:
- `git_fetch`: only a configured remote; changed tracking refs listed; HEAD and worktree untouched.
- `git_checkout`: detached at a pinned remote-tracking name, back to the branch; `preserve_exact` carries staged, unstaged and untracked changes both ways, byte-identical.
- `git_ref_update`: create, fast-forward, refusing a lossy move or delete, rename, tag create/delete.
- `git_worktree_update`: add with a new branch, remove when clean.
- `git_index_update`: stage/unstage; ignored paths refused.
- `git_commit`: parent, tree and author verified against the CLI.
- `git_integrate`: fast-forward, true merge, `fast_forward: only` refused, cherry-pick, an empty re-pick aborted (`nothing_to_commit`), revert, a conflict aborted and verified restored.

Hooks:
- A clone with hooks in both `.git/hooks` and an in-repository `core.hooksPath` (as husky sets up) went through stage, commit, two checkouts, a merge and a tag creation via MCPRelay; no hook ran.
- Sanity check: a plain `git commit` in the same clone did run them.

`tests/git-ops.mjs`: 25/25 PASS on Windows.

## Latency (Windows, from the audit log of the run)

| Capability | median | max |
|---|---|---|
| git_status | 0.41 s | 0.70 s |
| git_diff / git_history | 0.48–0.56 s | 0.72 s |
| git_checkout | 0.84 s | 2.5 s |
| git_commit | 0.44 s | 1.4 s |
| git_ref_update / git_index_update | 1.0 s | 1.9 s |
| git_integrate | 1.4 s | 2.2 s |

Each call runs several short Git processes (state read, change, re-read); on Windows a process start costs ~50–100 ms.

## Package

- `packaging/windows/build.ps1` now ships `git.mjs` next to `server.mjs`.
- The packaged server started with the pinned Node and reported `git: 2.54.0.windows.1`.

## Found while implementing

- `rev-parse --verify` accepts any full-length hex SHA without checking that the object exists; existence checks use `<rev>^{object}`.
- `git check-ignore` rejects literal pathspecs, so it runs without `GIT_LITERAL_PATHSPECS`.
- `git switch` and `git merge` overwrite ignored files by default; MCPRelay passes `--no-overwrite-ignore`.
- `git worktree remove` deletes ignored files without `--force`; MCPRelay refuses instead.

## Interactive ChatGPT end-to-end (Owner, 2026-10-05; details in #29)

- **Setup:** server 2.5.0, `catalog_version` `95de673f796d`, a disposable repository under `D:\`.
- **Connector:** ChatGPT's cached connector still described `invoke_write` narrowly. A fresh `list_capabilities` listed the `git_*` capabilities, and `invoke_write` accepted them with no connector refresh.
- **Passed:**
  - all six reads;
  - fetch, checkout (including `preserve_exact` both ways), ref create/rename/delete, worktree add/remove, stage/unstage, commit, merge.
- **Fail-closed checks held:**
  - stale `expected_head` → `stale_state`;
  - revert on a dirty tree → `dirty_worktree`;
  - removing a worktree with an untracked file → `dirty_worktree`.
- **Finding #33:** `clean: true` with only an untracked file. Fixed in 2.5.1:
  - `clean` = no staged, unstaged, untracked or conflicted paths;
  - `tracked_clean` = the same without untracked files.

## Real ChatGPT Scheduled Task proof — pending (Owner)

Install 2.5.0 on the node. The connector needs no change. Then, in a disposable repository inside the roots:
1. Make it a clone of a local bare "origin", with a commit pushed to origin from a second clone.
2. In a Scheduled Task, run the same five workflows twice:
   - once with Git commands through `invoke_exec` (`start_process`);
   - once with the `git_*` capabilities.
3. The workflows: status/read, fetch origin, clean checkout to an exact commit, add then remove a clean worktree, stage files and commit.

For each, record:
- the connector permission setting;
- the outcome: unattended, asked for approval, or blocked before MCPRelay;
- whether an audit line exists, plus the `catalog_version`;
- the resulting Git state.
