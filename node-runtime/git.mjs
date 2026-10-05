// Local Git operations (ADR-0009): structured reads of one Git repository
// (class "read") and bounded, non-lossy changes to it (class "write").
//
// Rules shared by every capability:
// * the caller never supplies Git argv, options, shell text or URLs: revisions,
//   ref names and paths are validated, and the server builds the command;
// * the repository (working tree, git dir and common dir) must lie inside the
//   file roots; changes also need it to hold no protected or read-only folder;
// * repository content can never run code here: hooks are disabled
//   (core.hooksPath points to a folder that does not exist), as are fsmonitor,
//   external diff and textconv, submodule recursion and the ext:: transport.
//   Programs the user configured in Git config (credential helpers, LFS
//   filters, merge drivers, signing) still apply;
// * every change names the exact state it expects (HEAD, branch, ref value,
//   index/worktree fingerprints from git_status) and fails with stale_state,
//   changing nothing, when the repository differs. Ref changes are atomic
//   compare-and-swap (update-ref). The result is re-read and verified;
// * nothing is forced or discarded: no reset --hard, clean, force checkout,
//   force ref rewrite, push or URL change. Git's own non-force checks (local
//   changes, untracked and ignored files) stay in force as a second guard.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const GIT_MIN = [2, 25];
// Stable error codes added by this family (merged into the server's ERRORS).
export const GIT_ERRORS = {
  not_a_repository: 'fix_args', stale_state: 'fix_args', ref_in_use: 'fix_args', nothing_to_commit: 'fix_args',
  dirty_worktree: 'ask_user', conflict: 'ask_user', not_merged: 'ask_user', operation_in_progress: 'ask_user',
  partial_state: 'ask_user', git_failed: 'ask_user', git_missing: 'ask_user',
  fetch_failed: 'retry_later',
};

export function gitCapabilities({ allowedPath, fail, factsResult, CapError, norm, holdsGuarded, noHooksDir }) {
  const GIT = process.env.MCPRELAY_GIT || 'git';
  const info = { version: null, problem: 'not checked yet' };

  // Repository-redirecting and identity-overriding variables of the server's own
  // environment are dropped; transport settings the user relies on are kept.
  const KEEP = /^GIT_(SSH|SSH_COMMAND|SSH_VARIANT|ASKPASS|CONFIG_GLOBAL|CONFIG_SYSTEM|CONFIG_NOSYSTEM|SSL_\w+|HTTP_\w+)$/i;
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k) || KEEP.test(k)));
  Object.assign(baseEnv, { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_LITERAL_PATHSPECS: '1', GIT_MERGE_AUTOEDIT: 'no', GIT_EDITOR: ':', LC_ALL: 'C' });
  const readEnv = { ...baseEnv, GIT_OPTIONAL_LOCKS: '0' }; // reads never take the index lock
  const HARDEN = ['core.hooksPath', noHooksDir, 'core.fsmonitor', 'false', 'protocol.ext.allow', 'never', 'submodule.recurse', 'false',
    'fetch.recurseSubmodules', 'false', 'color.ui', 'false', 'log.showSignature', 'false', 'advice.detachedHead', 'false', 'gc.auto', '0', 'maintenance.auto', 'false']
    .reduce((a, v, i, all) => (i % 2 ? a : [...a, '-c', `${v}=${all[i + 1]}`]), []);

  // Runs git with fixed, server-built arguments. Resolves {code, out (Buffer), err, truncated};
  // stdout beyond `limit` bytes stops the command (truncated). Only reads pass `signal`:
  // a change is never killed half-way (on Windows that would leave index.lock behind).
  // literal=false: for the few commands that reject literal pathspecs (check-ignore).
  function git(cwd, args, { input, limit = 32 << 20, timeout = 60_000, read = false, signal, literal = true } = {}) {
    return new Promise((resolve, reject) => {
      let env = read ? readEnv : baseEnv;
      if (!literal) { env = { ...env }; delete env.GIT_LITERAL_PATHSPECS; }
      let child;
      try { child = spawn(GIT, [...HARDEN, ...args], { cwd, env, windowsHide: true, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] }); } catch (e) { reject(e); return; }
      const out = []; let size = 0; let truncated = false; let err = '';
      const timer = setTimeout(() => { child.kill(); reject(new CapError('timeout', `git ${args[0]} timed out after ${timeout / 1000} s`)); }, timeout);
      const onAbort = () => child.kill();
      signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout.on('data', (d) => {
        if (truncated) return;
        out.push(d); size += d.length;
        if (size > limit) { truncated = true; child.kill(); }
      });
      child.stderr.on('data', (d) => { if (err.length < 16384) err += d; });
      child.stdin?.on('error', () => {});
      child.on('error', (e) => { clearTimeout(timer); reject(e.code === 'ENOENT' ? new CapError('git_missing', `Git not found (${GIT}). Install Git or set MCPRELAY_GIT.`) : e); });
      child.on('close', (code) => {
        clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
        const buf = Buffer.concat(out);
        resolve({ code, out: truncated ? buf.subarray(0, limit) : buf, err: err.trim(), truncated });
      });
      if (input !== undefined) child.stdin.end(input);
    });
  }
  const gist = (err) => err.split('\n').filter((l) => l && !/^hint:/.test(l)).slice(0, 6).join(' | ').slice(0, 600);
  async function ok(cwd, args, o) {
    const r = await git(cwd, args, o);
    if (r.code !== 0) fail('git_failed', `git ${args[0]} failed: ${gist(r.err) || `exit code ${r.code}`}`);
    return r.out.toString('utf8');
  }

  async function detect() {
    const r = await git(process.cwd(), ['--version'], { read: true, timeout: 20_000 }).catch((e) => ({ code: -1, err: e.message, out: Buffer.alloc(0) }));
    const m = /git version (\d+)\.(\d+)[^\s]*/.exec(r.out.toString());
    if (r.code !== 0 || !m) { info.version = null; info.problem = `Git not found (${GIT}): ${gist(r.err || '')}`; return; }
    info.version = m[0].slice(12);
    const [maj, min] = [Number(m[1]), Number(m[2])];
    info.problem = maj > GIT_MIN[0] || (maj === GIT_MIN[0] && min >= GIT_MIN[1]) ? null : `Git ${info.version} is too old; ${GIT_MIN.join('.')} or newer is required.`;
  }

  // ------------------------------------------------------------ validation --
  const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
  const isSha = (s) => typeof s === 'string' && SHA.test(s.toLowerCase());
  function checkRev(rev, what) {
    // A revision is data: never an option, never whitespace or control characters.
    if (typeof rev !== 'string' || !rev || rev.length > 256 || rev.startsWith('-') || /[\s\x00-\x1f\x7f]/.test(rev)) {
      fail('invalid_args', `${what} must be a revision (a commit SHA, branch, tag or remote-tracking name; not starting with "-", no spaces).`);
    }
  }
  async function validRef(ctx, full, what) {
    if (typeof full !== 'string' || !/^refs\/(heads|tags)\/./.test(full) || /[\s\x00-\x1f\x7f]/.test(full)) {
      fail('invalid_args', `${what} must be a full local branch or tag name: refs/heads/<name> or refs/tags/<name>.`);
    }
    if ((await git(ctx.top, ['check-ref-format', full], { read: true })).code !== 0) fail('invalid_args', `${what} "${full}" is not a valid Git ref name.`);
    return full;
  }
  async function validBranch(ctx, name, what) {
    if (typeof name !== 'string' || !name || name.startsWith('-') || name === 'HEAD') fail('invalid_args', `${what} must be a branch name.`);
    await validRef(ctx, `refs/heads/${name}`, what);
    return name;
  }
  // Repository paths: relative to the working tree (or absolute inside it), never into .git.
  function repoPaths(ctx, list) {
    if (!Array.isArray(list) || !list.length || list.length > 1000) fail('invalid_args', 'paths must be a non-empty array of at most 1000 paths.');
    const top = norm(ctx.top);
    return list.map((p) => {
      if (typeof p !== 'string' || !p || p.includes('\0')) fail('invalid_args', 'every path must be a non-empty string.');
      const abs = path.resolve(ctx.top, p); const x = norm(abs);
      if (x !== top && !x.startsWith(top.endsWith(path.sep) ? top : top + path.sep)) fail('path_not_allowed', `Path ${p} is outside the repository ${ctx.top}.`);
      const rel = path.relative(ctx.top, abs).split(path.sep).join('/');
      if (rel.split('/').some((s) => s.toLowerCase() === '.git')) fail('path_not_allowed', `Path ${p} is inside .git; Git capabilities only address repository content.`);
      return rel || '.';
    });
  }
  const optPaths = (ctx, list) => (list === undefined ? [] : repoPaths(ctx, list));
  const clamp = (v, lo, hi, d) => Math.min(Math.max(Number.isFinite(v) ? Math.trunc(v) : d, lo), hi);

  // ------------------------------------------------------------ repository --
  // Resolves the working tree, git dir and common dir, all inside the file roots.
  // A symlink/junction or a .git file pointing elsewhere resolves to its real
  // location, so it is refused when that is outside the roots or guarded.
  async function openRepo(p, mode) {
    if (info.problem) fail('git_missing', info.problem);
    const real = await allowedPath(p, mode);
    const st = await fs.stat(real).catch(() => null);
    if (!st) fail('not_found', `Not found: ${p}`);
    if (!st.isDirectory()) fail('not_a_repository', `${p} is not a directory; pass the repository's working-tree folder.`);
    const r = await git(real, ['rev-parse', '--is-bare-repository', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'], { read: true });
    const lines = r.out.toString('utf8').split('\n');
    if (r.code !== 0 || lines[0] === 'true' || !lines[1]) {
      fail('not_a_repository', `${p} is not inside a Git working tree${lines[0] === 'true' ? ' (bare repositories are not supported)' : ''}${r.code ? `: ${gist(r.err)}` : ''}.`);
    }
    const top = await allowedPath(path.resolve(lines[1]), mode);
    const gitDir = await allowedPath(path.resolve(real, lines[2]), mode);
    const commonDir = await allowedPath(path.resolve(real, lines[3]), mode);
    if (mode === 'write' && holdsGuarded(norm(top))) fail('read_only_path', `Refusing to change ${top}: the working tree contains a protected or read-only folder.`);
    return { top, gitDir, commonDir };
  }
  const repoFacts = (ctx) => ({ worktree: ctx.top, git_dir: ctx.gitDir, common_dir: ctx.commonDir });
  const busy = new Set(); // one change at a time per repository (common dir)
  async function change(repo, fn) {
    const ctx = await openRepo(repo, 'write');
    const key = norm(ctx.commonDir);
    if (busy.has(key)) fail('busy', `Another Git change to ${ctx.top} is in progress.`);
    busy.add(key);
    try { return await fn(ctx); } finally { busy.delete(key); }
  }
  async function inProgress(ctx) {
    for (const [f, op] of [['MERGE_HEAD', 'merge'], ['CHERRY_PICK_HEAD', 'cherry_pick'], ['REVERT_HEAD', 'revert'], ['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['BISECT_LOG', 'bisect']]) {
      if (await fs.stat(path.join(ctx.gitDir, f)).then(() => true, () => false)) return op;
    }
    return null;
  }
  async function noOperation(ctx) {
    const op = await inProgress(ctx);
    if (op) fail('operation_in_progress', `A ${op} is in progress in ${ctx.top}; it must be finished or aborted by the user first. Nothing was changed.`, { status: 'refused', operation_in_progress: op });
  }

  // -------------------------------------------------------------- snapshot --
  function hashFile(p) {
    return new Promise((resolve, reject) => {
      const h = createHash('sha256');
      createReadStream(p).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
    });
  }
  // Exact working-tree content of one path (for fingerprints and preserve_exact).
  async function contentMark(abs) {
    const st = await fs.lstat(abs).catch(() => null);
    if (!st) return null;
    if (st.isSymbolicLink()) return `link:${await fs.readlink(abs).catch(() => '?')}`;
    if (st.isDirectory()) return 'dir';
    if (st.size > 256 * 1024 * 1024) return `large:${st.size}:${st.mtimeMs}`;
    return `sha256:${await hashFile(abs).catch((e) => `unreadable:${e.code}`)}`;
  }
  const FP_MAX_PATHS = 20_000;
  // Current state: HEAD, branch, staged / unstaged / untracked / conflict paths,
  // index entries and the two fingerprints used as expected-state preconditions:
  //   index_fingerprint    = sha256 of every index entry (mode, object, stage, path);
  //   worktree_fingerprint = sha256 of the content of every path with unstaged
  //                          changes, untracked or conflicted.
  async function snapshot(ctx) {
    const st = await ok(ctx.top, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'], { read: true });
    const f = st.split('\0');
    const s = { head: 'unborn', branch: 'HEAD', upstream: null, ahead: null, behind: null, staged: [], unstaged: [], untracked: [], conflicts: [] };
    for (let i = 0; i < f.length; i++) {
      const e = f[i];
      if (!e) continue;
      if (e.startsWith('# ')) {
        const [k, ...v] = e.slice(2).split(' '); const val = v.join(' ');
        if (k === 'branch.oid') s.head = val === '(initial)' ? 'unborn' : val;
        else if (k === 'branch.head') s.branch = val === '(detached)' ? 'HEAD' : val;
        else if (k === 'branch.upstream') s.upstream = val;
        else if (k === 'branch.ab') { const m = /^\+(\d+) -(\d+)$/.exec(val); if (m) { s.ahead = Number(m[1]); s.behind = Number(m[2]); } }
        continue;
      }
      const parts = e.split(' ');
      if (e[0] === '1' || e[0] === '2') {
        const entry = { path: parts.slice(e[0] === '1' ? 8 : 9).join(' ') };
        if (e[0] === '2') entry.orig_path = f[++i];
        if (parts[1][0] !== '.') s.staged.push({ ...entry, status: parts[1][0] });
        if (parts[1][1] !== '.') s.unstaged.push({ ...entry, status: parts[1][1] });
      } else if (e[0] === 'u') s.conflicts.push({ path: parts.slice(10).join(' '), status: parts[1] });
      else if (e[0] === '?') s.untracked.push(e.slice(2));
    }
    const ls = (await git(ctx.top, ['ls-files', '-s', '-z'], { read: true })).out;
    s.index_fingerprint = createHash('sha256').update(ls).digest('hex');
    s.index = new Map();
    for (const rec of ls.toString('utf8').split('\0')) {
      const tab = rec.indexOf('\t');
      if (tab > 0) { const p = rec.slice(tab + 1); s.index.set(p, s.index.has(p) ? `${s.index.get(p)};${rec.slice(0, tab)}` : rec.slice(0, tab)); }
    }
    const wt = [...new Set([...s.unstaged.map((x) => x.path), ...s.untracked, ...s.conflicts.map((x) => x.path)])].sort();
    if (wt.length > FP_MAX_PATHS) {
      s.worktree_fingerprint = null;
      s.worktree_note = `more than ${FP_MAX_PATHS} changed or untracked paths: no worktree fingerprint (dirty_policy preserve_exact is unavailable)`;
    } else {
      const marks = [];
      for (const p of wt) marks.push([p, await contentMark(path.join(ctx.top, p))]);
      s.worktree_fingerprint = createHash('sha256').update(JSON.stringify(marks)).digest('hex');
    }
    s.clean = !s.staged.length && !s.unstaged.length && !s.conflicts.length;
    return s;
  }
  // Index entry and working-tree content of each dirty path: what preserve_exact keeps.
  async function delta(ctx, s, paths) {
    const list = paths || [...new Set([...s.staged, ...s.unstaged].flatMap((x) => [x.path, x.orig_path]).concat(s.untracked).filter(Boolean))].sort();
    const out = new Map();
    for (const p of list) out.set(p, { index: s.index.get(p) ?? null, worktree: await contentMark(path.join(ctx.top, p)) });
    return out;
  }
  const where = (s) => ({ head: s.head, branch: s.branch });
  function expectState(s, a, keys) {
    const mism = {};
    // SHAs and fingerprints are hex (any case); branch names are case-sensitive.
    const cmp = (k, want, have, exact = false) => {
      if (want !== undefined && (exact ? String(want) !== have : String(want).toLowerCase() !== String(have).toLowerCase())) mism[k] = { expected: want, actual: have };
    };
    if (keys.includes('head')) cmp('head', a.expected_head, s.head);
    if (keys.includes('branch')) cmp('branch', a.expected_branch, s.branch, true);
    if (keys.includes('index')) cmp('index_fingerprint', a.expected_index, s.index_fingerprint);
    if (keys.includes('worktree')) cmp('worktree_fingerprint', a.expected_worktree, s.worktree_fingerprint);
    if (Object.keys(mism).length) {
      fail('stale_state', `The repository is not in the expected state (${Object.keys(mism).join(', ')} differ); nothing was changed. Call git_status again and decide with the current values.`, { status: 'stale_state', mismatches: mism });
    }
  }
  const needClean = (s, what) => {
    if (s.conflicts.length) fail('conflict', `${what}: the index has unresolved conflicts; nothing was changed.`, { status: 'refused', conflicts: s.conflicts.slice(0, 50) });
    if (!s.clean) {
      fail('dirty_worktree', `${what}: the working tree has uncommitted changes to tracked files; nothing was changed.`, {
        status: 'refused', staged: s.staged.slice(0, 50).map((x) => x.path), unstaged: s.unstaged.slice(0, 50).map((x) => x.path),
      });
    }
  };

  // -------------------------------------------------------------- objects --
  async function commitOf(ctx, rev, what) {
    checkRev(rev, what);
    const r = await git(ctx.top, ['rev-parse', '--verify', '-q', `${rev}^{commit}`], { read: true });
    if (r.code !== 0) fail('not_found', `${what} "${rev}" is not a commit in this repository.`);
    return r.out.toString().trim();
  }
  // A name (branch, tag, origin/main) must be pinned by the commit SHA the caller expects.
  async function exactCommit(ctx, rev, expected, what, resolveAs = rev) {
    const sha = await commitOf(ctx, resolveAs, what);
    if (isSha(rev) && rev.toLowerCase() === sha) return sha;
    if (expected === undefined) fail('invalid_args', `${what} "${rev}" is a name; also pass expected_${what} = the commit SHA you expect it to point to (git_refs / git_object_info), or pass a full commit SHA.`);
    if (String(expected).toLowerCase() !== sha) fail('stale_state', `${what} "${rev}" points to ${sha}, not ${expected}; nothing was changed.`, { status: 'stale_state', mismatches: { [what]: { expected, actual: sha } } });
    return sha;
  }
  // ^{object}: a full-length SHA is only accepted if the object exists.
  const refValue = async (ctx, ref) => { const r = await git(ctx.top, ['rev-parse', '--verify', '-q', `${ref}^{object}`], { read: true }); return r.code === 0 ? r.out.toString().trim() : null; };
  const isAncestor = async (ctx, a, b) => (await git(ctx.top, ['merge-base', '--is-ancestor', a, b], { read: true })).code === 0;
  const parentsOf = async (ctx, c) => (await ok(ctx.top, ['rev-list', '--parents', '-n', '1', c], { read: true })).trim().split(' ').slice(1);
  async function worktreeList(ctx) {
    const txt = await ok(ctx.top, ['worktree', 'list', '--porcelain'], { read: true });
    const list = [];
    for (const block of txt.split(/\n\n+/)) {
      const w = {};
      for (const line of block.split('\n')) {
        const sp = line.indexOf(' '); const k = sp < 0 ? line : line.slice(0, sp); const v = sp < 0 ? true : line.slice(sp + 1);
        if (k === 'worktree') w.path = path.resolve(v);
        else if (k === 'HEAD') w.head = v;
        else if (k === 'branch') w.branch = v;
        else if (['detached', 'bare', 'locked', 'prunable'].includes(k)) w[k] = v;
      }
      if (w.path) list.push(w);
    }
    return list;
  }
  const realOr = (p) => fs.realpath(p).catch(() => p);
  // True if no commit is lost when `ref` (pointing to commit c) stops pointing there:
  // c stays reachable from HEAD of a worktree, another local branch, or (for a branch)
  // its configured upstream.
  async function stillReachable(ctx, c, ref) {
    for (const w of await worktreeList(ctx)) if (w.head && await isAncestor(ctx, c, w.head)) return 'a worktree HEAD';
    const others = (await ok(ctx.top, ['for-each-ref', '--format=%(refname)', '--contains', c, 'refs/heads'], { read: true })).split('\n').filter((r) => r && r !== ref);
    if (others.length) return others[0];
    if (ref.startsWith('refs/heads/')) {
      const up = (await ok(ctx.top, ['for-each-ref', '--format=%(upstream)', ref], { read: true })).trim();
      if (up && await refValue(ctx, up) && await isAncestor(ctx, c, up)) return up;
    }
    return null;
  }

  // ---------------------------------------------------------------- reads --
  async function gitStatus(a) {
    const ctx = await openRepo(a.repo, 'read');
    const s = await snapshot(ctx);
    const max = clamp(a.max_paths, 1, 5000, 500);
    const lists = { staged: s.staged, unstaged: s.unstaged, untracked: s.untracked, conflicts: s.conflicts };
    return factsResult({
      repository: repoFacts(ctx), head: s.head, branch: s.branch, detached: s.branch === 'HEAD',
      upstream: s.upstream, ahead: s.ahead, behind: s.behind, operation_in_progress: await inProgress(ctx), clean: s.clean,
      counts: Object.fromEntries(Object.entries(lists).map(([k, v]) => [k, v.length])),
      ...Object.fromEntries(Object.entries(lists).map(([k, v]) => [k, v.slice(0, max)])),
      truncated: Object.values(lists).some((v) => v.length > max),
      index_fingerprint: s.index_fingerprint, worktree_fingerprint: s.worktree_fingerprint, ...(s.worktree_note ? { worktree_note: s.worktree_note } : {}),
    });
  }

  async function gitDiff(a, signal) {
    const ctx = await openRepo(a.repo, 'read');
    const scope = a.scope ?? 'unstaged';
    const paths = optPaths(ctx, a.paths);
    const base = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--find-renames'];
    let range = []; let from = null; let to = null;
    if (scope === 'staged') range = ['--cached'];
    else if (scope === 'commits') {
      if (a.from === undefined) fail('invalid_args', 'scope "commits" needs from (and optionally to, default HEAD).');
      from = await commitOf(ctx, a.from, 'from'); to = await commitOf(ctx, a.to ?? 'HEAD', 'to'); range = [from, to];
    } else if (a.from !== undefined || a.to !== undefined) fail('invalid_args', 'from/to are only used with scope "commits".');
    const ns = await git(ctx.top, [...base, ...range, '--numstat', '-z', '--', ...paths], { read: true, signal });
    if (ns.code !== 0) fail('git_failed', `git diff failed: ${gist(ns.err)}`);
    const f = ns.out.toString('utf8').split('\0'); const files = [];
    for (let i = 0; i < f.length; i++) {
      if (!f[i]) continue;
      const [add, del, p] = f[i].split('\t');
      const file = { path: p, added: add === '-' ? null : Number(add), deleted: del === '-' ? null : Number(del), binary: add === '-' };
      if (p === '') { file.old_path = f[++i]; file.path = f[++i]; }
      files.push(file);
    }
    const max = clamp(a.max_bytes, 1000, 2_000_000, 200_000);
    const patch = a.stat_only ? null : await git(ctx.top, [...base, ...range, '--', ...paths], { read: true, limit: max, signal });
    return factsResult({
      repository: ctx.top, scope, ...(from ? { from, to } : {}), files,
      ...(patch ? { patch: patch.out.toString('utf8'), truncated: patch.truncated } : {}),
      note: scope === 'unstaged' ? 'Untracked files are not part of a diff (see git_status untracked).' : undefined,
    });
  }

  async function gitHistory(a, signal) {
    const ctx = await openRepo(a.repo, 'read');
    const max = clamp(a.max_count, 1, 200, 20);
    const paths = optPaths(ctx, a.paths);
    const rev = a.rev ?? 'HEAD';
    if (rev === 'HEAD' && !(await refValue(ctx, 'HEAD'))) return factsResult({ repository: ctx.top, rev, commits: [], more: false, note: 'HEAD is unborn (no commits yet)' });
    const start = await commitOf(ctx, rev, 'rev');
    const r = await git(ctx.top, ['log', '--no-color', `--format=%H%x1f%T%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cI%x1f%s%x1e`, '-n', String(max + 1), start, '--', ...paths], { read: true, signal });
    if (r.code !== 0) fail('git_failed', `git log failed: ${gist(r.err)}`);
    const commits = r.out.toString('utf8').split('\x1e').map((x) => x.replace(/^\n/, '')).filter(Boolean).map((rec) => {
      const [commit, tree, parents, an, ae, ad, cd, subject] = rec.split('\x1f');
      return { commit, tree, parents: parents ? parents.split(' ') : [], author: { name: an, email: ae, date: ad }, committer_date: cd, subject };
    });
    return factsResult({ repository: ctx.top, rev, start, commits: commits.slice(0, max), more: commits.length > max });
  }

  const redactUrl = (u) => u.replace(/^(https?:\/\/)[^@/]+@/i, '$1***@');
  async function gitRefs(a) {
    const ctx = await openRepo(a.repo, 'read');
    const kind = a.kind ?? 'all';
    const max = clamp(a.max, 1, 5000, 500);
    const spaces = { all: ['refs/heads', 'refs/tags', 'refs/remotes'], branches: ['refs/heads'], tags: ['refs/tags'], remotes: ['refs/remotes'] }[kind];
    const out = await ok(ctx.top, ['for-each-ref', `--count=${max + 1}`, '--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(upstream)%00%(upstream:track,nobracket)%00%(symref)', ...spaces], { read: true });
    const refs = out.split('\n').filter(Boolean).map((l) => {
      const [ref, object, type, peeled, upstream, track, symref] = l.split('\0');
      return { ref, object, type, ...(peeled ? { target: peeled } : { target: object }), ...(upstream ? { upstream, track: track || 'up to date' } : {}), ...(symref ? { symref } : {}) };
    });
    const remotes = [];
    for (const name of (await ok(ctx.top, ['remote'], { read: true })).split('\n').filter(Boolean)) {
      const get = async (k) => (await git(ctx.top, ['config', '--get-all', `remote.${name}.${k}`], { read: true })).out.toString('utf8').split('\n').filter(Boolean);
      remotes.push({ name, urls: (await get('url')).map(redactUrl), fetch: await get('fetch') });
    }
    const s = await refValue(ctx, 'HEAD');
    const branch = (await git(ctx.top, ['symbolic-ref', '-q', '--short', 'HEAD'], { read: true })).out.toString().trim() || 'HEAD';
    return factsResult({ repository: ctx.top, head: s ?? 'unborn', branch, kind, refs: refs.slice(0, max), truncated: refs.length > max, remotes });
  }

  async function gitWorktrees(a) {
    const ctx = await openRepo(a.repo, 'read');
    const list = await worktreeList(ctx);
    const here = norm(ctx.top);
    return factsResult({ repository: ctx.top, worktrees: await Promise.all(list.map(async (w, i) => ({
      path: w.path, head: w.head ?? null, branch: w.branch ?? (w.detached ? 'HEAD' : null), main: i === 0,
      current: norm(await realOr(w.path)) === here, ...(w.locked ? { locked: w.locked === true ? 'locked' : w.locked } : {}),
      ...(w.prunable ? { prunable: w.prunable === true ? 'prunable' : w.prunable } : {}), exists: !!(await fs.stat(w.path).catch(() => null)),
    }))) });
  }

  async function gitObjectInfo(a) {
    const ctx = await openRepo(a.repo, 'read');
    checkRev(a.rev, 'rev');
    const oid = await refValue(ctx, a.rev);
    if (!oid) return factsResult({ repository: ctx.top, rev: a.rev, exists: false });
    const type = (await ok(ctx.top, ['cat-file', '-t', oid], { read: true })).trim();
    const size = Number((await ok(ctx.top, ['cat-file', '-s', oid], { read: true })).trim());
    const full = (await git(ctx.top, ['rev-parse', '--symbolic-full-name', a.rev], { read: true })).out.toString().trim();
    const res = { repository: ctx.top, rev: a.rev, exists: true, object: oid, type, size, ...(full.startsWith('refs/') ? { ref: full } : {}) };
    const commit = (await git(ctx.top, ['rev-parse', '--verify', '-q', `${oid}^{commit}`], { read: true })).out.toString().trim();
    if (type === 'tag') res.target = (await ok(ctx.top, ['rev-parse', `${oid}^{}`], { read: true })).trim();
    if (commit) {
      res.commit = commit;
      res.tree = (await ok(ctx.top, ['rev-parse', `${commit}^{tree}`], { read: true })).trim();
      res.parents = await parentsOf(ctx, commit);
      if (a.contained_in !== undefined) { const c = await commitOf(ctx, a.contained_in, 'contained_in'); res.contained_in = { rev: a.contained_in, commit: c, contains: await isAncestor(ctx, commit, c) }; }
    } else if (a.contained_in !== undefined) fail('invalid_args', 'contained_in needs rev to name a commit (or a tag of one).');
    return factsResult(res);
  }

  // -------------------------------------------------------------- changes --
  async function gitFetch(a) {
    return change(a.repo, async (ctx) => {
      if (typeof a.remote !== 'string' || !/^[A-Za-z0-9][\w.-]{0,99}$/.test(a.remote)) fail('invalid_args', 'remote must be the name of a configured remote (e.g. origin).');
      const remotes = (await ok(ctx.top, ['remote'], { read: true })).split('\n').filter(Boolean);
      if (!remotes.includes(a.remote)) fail('not_found', `No configured remote "${a.remote}" (configured: ${remotes.join(', ') || 'none'}). Remotes and URLs are only changed by the user.`);
      const snap = async () => new Map((await ok(ctx.top, ['for-each-ref', '--format=%(refname) %(objectname)', `refs/remotes/${a.remote}`, 'refs/tags'], { read: true }))
        .split('\n').filter(Boolean).map((l) => l.split(' ')));
      const before = await snap(); const head0 = await refValue(ctx, 'HEAD');
      const r = await git(ctx.top, ['fetch', '--no-recurse-submodules', ...(a.prune ? ['--prune'] : []), a.remote], { timeout: 100_000 });
      const after = await snap();
      const changed = [];
      for (const ref of new Set([...before.keys(), ...after.keys()])) if (before.get(ref) !== after.get(ref)) changed.push({ ref, old: before.get(ref) ?? null, new: after.get(ref) ?? null });
      const facts = { status: r.code === 0 ? 'fetched' : 'failed', repository: ctx.top, remote: a.remote, changed, head: head0 ?? 'unborn', head_unchanged: (await refValue(ctx, 'HEAD')) === head0 };
      if (r.code !== 0) fail('fetch_failed', `git fetch ${a.remote} failed: ${gist(r.err)}`, facts);
      return factsResult(facts);
    });
  }

  async function gitCheckout(a) {
    return change(a.repo, async (ctx) => {
      await noOperation(ctx);
      const s = await snapshot(ctx);
      expectState(s, a, ['head', 'branch']);
      const policy = a.dirty_policy ?? 'require_clean';
      if (policy === 'preserve_exact') {
        if (s.conflicts.length) needClean(s, 'checkout');
        if (a.expected_index === undefined || a.expected_worktree === undefined) fail('invalid_args', 'dirty_policy "preserve_exact" needs expected_index and expected_worktree from git_status.');
        if (s.worktree_fingerprint === null) fail('dirty_worktree', `preserve_exact is unavailable: ${s.worktree_note}.`);
        expectState(s, a, ['index', 'worktree']);
      } else needClean(s, 'checkout');
      checkRev(a.target, 'target');
      const branch = a.detach !== true && !a.target.startsWith('refs/') && await refValue(ctx, `refs/heads/${a.target}`) ? await validBranch(ctx, a.target, 'target') : null;
      const sha = await exactCommit(ctx, a.target, a.expected_target, 'target', branch ? `refs/heads/${branch}` : a.target);
      const want = { head: sha, branch: branch ?? 'HEAD' };
      if (s.head === want.head && s.branch === want.branch) return factsResult({ status: 'unchanged', repository: ctx.top, old: where(s), new: where(s) });
      const keep = policy === 'preserve_exact' ? await delta(ctx, s) : null;
      const r = await git(ctx.top, ['switch', '--no-guess', '--no-overwrite-ignore', ...(branch ? [branch] : ['--detach', sha])], { timeout: 100_000 });
      const s2 = await snapshot(ctx);
      const facts = { status: null, repository: ctx.top, dirty_policy: policy, old: where(s), new: where(s2) };
      if (r.code !== 0) {
        if (s2.head === s.head && s2.branch === s.branch && s2.index_fingerprint === s.index_fingerprint) {
          facts.status = 'refused';
          fail(/local changes|untracked working tree files|would be overwritten|would be removed/.test(r.err) ? 'dirty_worktree' : 'git_failed', `Git refused the checkout; nothing was changed: ${gist(r.err)}`, facts);
        }
        facts.status = 'partial';
        fail('partial_state', `git switch failed part-way: ${gist(r.err)}. Inspect with git_status.`, facts);
      }
      if (s2.head !== want.head || s2.branch !== want.branch) { facts.status = 'partial'; fail('partial_state', `After the checkout HEAD is ${s2.head} (${s2.branch}), expected ${want.head} (${want.branch}).`, facts); }
      if (keep) {
        const now = await delta(ctx, s2, [...keep.keys()]);
        const changed = [...keep].filter(([p, v]) => now.get(p).index !== v.index || now.get(p).worktree !== v.worktree).map(([p]) => p);
        if (changed.length) {
          // Not expected (Git refuses checkouts that would touch local changes); go back without force.
          const back = await git(ctx.top, ['switch', '--no-guess', '--no-overwrite-ignore', ...(s.branch !== 'HEAD' ? [s.branch] : ['--detach', s.head])], { timeout: 100_000 });
          Object.assign(facts, { status: 'partial', changed_paths: changed.slice(0, 50), returned_to_old: back.code === 0, new: where(await snapshot(ctx)) });
          fail('partial_state', `The local changes of ${changed.length} path(s) were not preserved exactly${back.code === 0 ? '; switched back to the previous HEAD' : ''}.`, facts);
        }
        facts.preserved_paths = keep.size;
      }
      facts.status = 'checked_out';
      Object.assign(facts, { index_fingerprint: s2.index_fingerprint, worktree_fingerprint: s2.worktree_fingerprint });
      return factsResult(facts);
    });
  }

  async function gitRefUpdate(a) {
    return change(a.repo, async (ctx) => {
      const ref = await validRef(ctx, a.ref, 'ref');
      const branch = ref.startsWith('refs/heads/');
      const cur = await refValue(ctx, ref);
      const facts = { status: null, repository: ctx.top, action: a.action, ref, old: cur };
      const needOld = () => {
        if (cur === null) fail('not_found', `${ref} does not exist.`, { ...facts, status: 'refused' });
        if (a.expected_old === undefined) fail('invalid_args', `${a.action} needs expected_old = the ref's current value (object in git_refs).`);
        if (String(a.expected_old).toLowerCase() !== cur) fail('stale_state', `${ref} is ${cur}, not ${a.expected_old}; nothing was changed.`, { ...facts, status: 'stale_state', mismatches: { ref: { expected: a.expected_old, actual: cur } } });
      };
      const checkedOut = async (r) => (await worktreeList(ctx)).find((w) => w.branch === r);
      const notInUse = async (r) => { const w = await checkedOut(r); if (w) fail('ref_in_use', `${r} is checked out in ${w.path}; use git_checkout / git_integrate there instead.`, { ...facts, status: 'refused' }); };
      const lossless = async (newCommit) => {
        const c = await commitOf(ctx, cur, 'ref');
        if (newCommit && await isAncestor(ctx, c, newCommit)) return 'fast-forward';
        const by = await stillReachable(ctx, c, ref);
        if (!by) fail('not_merged', `${ref} points to ${c}, which no worktree HEAD, other local branch${branch ? ' or upstream' : ''} contains; ${a.action === 'delete' ? 'deleting' : 'moving'} it would lose commits. Nothing was changed.`, { ...facts, status: 'refused' });
        return `kept by ${by}`;
      };
      const tx = async (line) => {
        const r = await git(ctx.top, ['update-ref', '--create-reflog', '-m', `mcprelay: git_ref_update ${a.action}`, '--stdin'], { input: `${line}\n` });
        if (r.code !== 0) {
          if ((await refValue(ctx, ref)) !== cur) fail('partial_state', `update-ref failed and ${ref} changed meanwhile: ${gist(r.err)}`, { ...facts, status: 'partial' });
          fail('stale_state', `${ref} changed concurrently or could not be updated; nothing was changed: ${gist(r.err)}`, { ...facts, status: 'stale_state' });
        }
      };
      if (a.action === 'create') {
        if (cur !== null) fail('already_exists', `${ref} already exists (${cur}).`, { ...facts, status: 'refused' });
        if (a.target === undefined) fail('invalid_args', 'create needs target (and expected_target unless target is a full commit SHA).');
        const sha = await exactCommit(ctx, a.target, a.expected_target, 'target');
        await tx(`create ${ref} ${sha}`);
        facts.new = sha;
      } else if (a.action === 'move') {
        needOld();
        if (a.target === undefined) fail('invalid_args', 'move needs target (and expected_target unless target is a full commit SHA).');
        const sha = await exactCommit(ctx, a.target, a.expected_target, 'target');
        if (branch) await notInUse(ref);
        if (sha === cur) return factsResult({ ...facts, status: 'unchanged', new: cur });
        facts.lossless = await lossless(sha);
        await tx(`update ${ref} ${sha} ${cur}`);
        facts.new = sha;
      } else if (a.action === 'delete') {
        needOld();
        if (branch) await notInUse(ref);
        facts.lossless = await lossless(null);
        await tx(`delete ${ref} ${cur}`);
        facts.new = null;
      } else if (a.action === 'rename') {
        if (!branch) fail('invalid_args', 'rename is for branches; for a tag use create + delete.');
        needOld();
        const to = await validRef(ctx, a.new_ref, 'new_ref');
        if (!to.startsWith('refs/heads/')) fail('invalid_args', 'new_ref must be refs/heads/<name>.');
        if (await refValue(ctx, to)) fail('already_exists', `${to} already exists.`, { ...facts, status: 'refused' });
        const r = await git(ctx.top, ['branch', '-m', ref.slice(11), to.slice(11)]);
        if (r.code !== 0) fail('git_failed', `Renaming failed: ${gist(r.err)}`, { ...facts, status: 'refused' });
        facts.new_ref = to; facts.new = await refValue(ctx, to);
        if (facts.new !== cur || await refValue(ctx, ref)) fail('partial_state', `After the rename ${to} is ${facts.new} and ${ref} ${await refValue(ctx, ref) ? 'still exists' : 'is gone'}.`, { ...facts, status: 'partial' });
      } else fail('invalid_args', 'action must be create, move, delete or rename.');
      if (a.action !== 'rename' && (await refValue(ctx, ref)) !== facts.new) fail('partial_state', `${ref} is not ${facts.new} after the update.`, { ...facts, status: 'partial' });
      facts.status = { create: 'created', move: 'moved', delete: 'deleted', rename: 'renamed' }[a.action];
      return factsResult(facts);
    });
  }

  async function gitWorktreeUpdate(a) {
    return change(a.repo, async (ctx) => {
      if (typeof a.path !== 'string' || !a.path) fail('invalid_args', 'path is required.');
      const list = await worktreeList(ctx);
      const main = list[0]?.path ?? ctx.top;
      if (a.action === 'add') {
        const dest = await allowedPath(a.path, 'write');
        if (await fs.lstat(dest).then(() => true, () => false)) fail('already_exists', `${a.path} already exists; a new worktree needs a path that does not exist yet.`);
        if (a.target === undefined) fail('invalid_args', 'add needs target (a branch, or a commit with expected_target).');
        checkRev(a.target, 'target');
        let args; let want;
        if (a.new_branch !== undefined) {
          const nb = await validBranch(ctx, a.new_branch, 'new_branch');
          if (await refValue(ctx, `refs/heads/${nb}`)) fail('already_exists', `Branch ${nb} already exists.`);
          const sha = await exactCommit(ctx, a.target, a.expected_target, 'target');
          args = ['-b', nb, dest, sha]; want = { head: sha, branch: `refs/heads/${nb}` };
        } else if (a.detach !== true && !a.target.startsWith('refs/') && await refValue(ctx, `refs/heads/${a.target}`)) {
          const b = await validBranch(ctx, a.target, 'target');
          const sha = await exactCommit(ctx, b, a.expected_target, 'target', `refs/heads/${b}`);
          const w = list.find((x) => x.branch === `refs/heads/${b}`);
          if (w) fail('ref_in_use', `Branch ${b} is already checked out in ${w.path}; use new_branch or detach.`);
          args = [dest, b]; want = { head: sha, branch: `refs/heads/${b}` };
        } else {
          const sha = await exactCommit(ctx, a.target, a.expected_target, 'target');
          args = ['--detach', dest, sha]; want = { head: sha, branch: null };
        }
        const r = await git(ctx.top, ['worktree', 'add', '--quiet', ...args], { timeout: 100_000 });
        const real = await realOr(dest);
        const w = (await worktreeList(ctx)).find((x) => norm(x.path) === norm(dest) || norm(x.path) === norm(real));
        const facts = { status: null, repository: ctx.top, action: 'add', path: dest, head: w?.head ?? null, branch: w?.branch ?? (w ? 'HEAD' : null) };
        if (r.code !== 0) {
          if (!w) { facts.status = 'refused'; fail('git_failed', `git worktree add failed; nothing was added: ${gist(r.err)}`, facts); }
          facts.status = 'partial'; fail('partial_state', `git worktree add reported an error after registering ${dest}: ${gist(r.err)}`, facts);
        }
        if (!w || w.head !== want.head || (want.branch && w.branch !== want.branch)) { facts.status = 'partial'; fail('partial_state', `The new worktree at ${dest} is not at ${want.head}${want.branch ? ` on ${want.branch}` : ''}.`, facts); }
        facts.status = 'added';
        return factsResult(facts);
      }
      if (a.action === 'remove') {
        const dest = await allowedPath(a.path, 'write');
        const w = list.find((x) => norm(x.path) === norm(dest)) || (await Promise.all(list.map(async (x) => (norm(await realOr(x.path)) === norm(dest) ? x : null)))).find(Boolean);
        if (!w) fail('not_found', `${a.path} is not a registered worktree of this repository (see git_worktrees).`);
        if (w === list[0]) fail('invalid_args', 'The main worktree cannot be removed.');
        if (w.locked) fail('ref_in_use', `Worktree ${w.path} is locked${w.locked === true ? '' : ` (${w.locked})`}; the user must unlock it first.`);
        if (a.expected_head === undefined) fail('invalid_args', 'remove needs expected_head = the HEAD of that worktree (git_worktrees).');
        const facts = { status: null, repository: ctx.top, action: 'remove', path: w.path, head: w.head ?? null, branch: w.branch ?? 'HEAD' };
        if (String(a.expected_head).toLowerCase() !== w.head) fail('stale_state', `Worktree ${w.path} is at ${w.head}, not ${a.expected_head}; nothing was changed.`, { ...facts, status: 'stale_state' });
        if (!(await fs.stat(w.path).catch(() => null))) fail('not_found', `Worktree folder ${w.path} is missing; pruning registrations is not supported (ask the user).`, { ...facts, status: 'refused' });
        const wctx = await openRepo(w.path, 'write');
        if (await inProgress(wctx)) fail('operation_in_progress', `A Git operation is in progress in ${w.path}.`, { ...facts, status: 'refused' });
        const ws = await snapshot(wctx);
        if (!ws.clean || ws.untracked.length) {
          fail('dirty_worktree', `Worktree ${w.path} has uncommitted changes or untracked files; nothing was removed.`, { ...facts, status: 'refused', staged: ws.staged.length, unstaged: ws.unstaged.length, untracked: ws.untracked.length, conflicts: ws.conflicts.length });
        }
        // git worktree remove deletes ignored files silently: refuse instead.
        const ign = (await ok(w.path, ['status', '--porcelain=v2', '-z', '--ignored=matching', '--untracked-files=normal'], { read: true })).split('\0').filter((x) => x.startsWith('! ')).map((x) => x.slice(2));
        if (ign.length) fail('dirty_worktree', `Worktree ${w.path} contains ${ign.length} ignored file(s) or folder(s) (e.g. ${ign.slice(0, 3).join(', ')}) that removal would delete; nothing was removed. Remove them first (remove_path) or ask the user.`, { ...facts, status: 'refused', ignored: ign.slice(0, 50) });
        // Run from a worktree that stays (a folder in use cannot be removed on Windows).
        const r = await git(norm(await realOr(w.path)) === norm(ctx.top) ? main : ctx.top, ['worktree', 'remove', w.path], { timeout: 100_000 });
        const still = (await worktreeList(ctx)).some((x) => x.path === w.path);
        const exists = !!(await fs.stat(w.path).catch(() => null));
        if (r.code !== 0 || still || exists) {
          facts.status = r.code !== 0 && still && exists ? 'refused' : 'partial';
          fail(facts.status === 'refused' ? 'git_failed' : 'partial_state', `git worktree remove ${r.code ? `failed: ${gist(r.err)}` : 'left'} ${still ? 'the registration' : ''}${still && exists ? ' and ' : ''}${exists ? 'the folder' : ''}`.trim(), { ...facts, registered: still, folder_exists: exists });
        }
        facts.status = 'removed';
        return factsResult(facts);
      }
      fail('invalid_args', 'action must be add or remove.');
    });
  }

  async function gitIndexUpdate(a) {
    return change(a.repo, async (ctx) => {
      await noOperation(ctx);
      const s = await snapshot(ctx);
      expectState(s, a, ['head', 'index']);
      const rels = repoPaths(ctx, a.paths);
      const facts = { status: null, repository: ctx.top, action: a.action, paths: rels, head: s.head };
      if (a.action === 'stage') {
        const ign = await git(ctx.top, ['check-ignore', '--', ...rels], { read: true, literal: false });
        if (ign.code > 1) fail('git_failed', `git check-ignore failed: ${gist(ign.err)}`);
        if (ign.code === 0) fail('invalid_args', `Ignored path(s) are not staged: ${ign.out.toString().trim().split('\n').slice(0, 10).join(', ')}. Nothing was changed.`, { ...facts, status: 'refused' });
      } else if (a.action !== 'unstage') fail('invalid_args', 'action must be stage or unstage.');
      const args = a.action === 'stage' ? ['add', '--', ...rels] : s.head === 'unborn' ? ['rm', '--cached', '-r', '-q', '--', ...rels] : ['restore', '--staged', '--', ...rels];
      const r = await git(ctx.top, args);
      const s2 = await snapshot(ctx);
      Object.assign(facts, { staged: s2.staged.slice(0, 500), staged_count: s2.staged.length, index_fingerprint: s2.index_fingerprint, worktree_fingerprint: s2.worktree_fingerprint });
      if (r.code !== 0) {
        if (s2.index_fingerprint === s.index_fingerprint) fail(/did not match/.test(r.err) ? 'not_found' : 'git_failed', `git ${args[0]} failed; nothing was changed: ${gist(r.err)}`, { ...facts, status: 'refused' });
        fail('partial_state', `git ${args[0]} failed after changing the index: ${gist(r.err)}`, { ...facts, status: 'partial' });
      }
      if (s2.head !== s.head) fail('partial_state', 'HEAD changed during the index update.', { ...facts, status: 'partial' });
      facts.status = s2.index_fingerprint === s.index_fingerprint ? 'unchanged' : a.action === 'stage' ? 'staged' : 'unstaged';
      return factsResult(facts);
    });
  }

  async function gitCommit(a) {
    return change(a.repo, async (ctx) => {
      if (typeof a.message !== 'string' || !a.message.trim() || a.message.length > 65536 || a.message.includes('\0')) fail('invalid_args', 'message must be non-empty text (at most 65536 characters).');
      await noOperation(ctx);
      const s = await snapshot(ctx);
      expectState(s, a, ['head', 'branch', 'index']);
      if (s.conflicts.length) needClean(s, 'commit');
      if (!s.staged.length) fail('nothing_to_commit', 'Nothing is staged; stage changes with git_index_update first.', { status: 'refused', head: s.head });
      // Plumbing instead of `git commit`: no hooks, no editor, and the branch moves by
      // compare-and-swap from expected_head, so a concurrent commit can never be lost.
      const tree = (await ok(ctx.top, ['write-tree'])).trim();
      const parents = s.head === 'unborn' ? [] : [s.head];
      const msg = a.message.endsWith('\n') ? a.message : `${a.message}\n`;
      const commit = (await ok(ctx.top, ['commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-F', '-'], { input: msg })).trim();
      const subject = a.message.trim().split('\n')[0].slice(0, 200);
      const u = await git(ctx.top, ['update-ref', '-m', `commit${parents.length ? '' : ' (initial)'}: ${subject}`, 'HEAD', commit, s.head === 'unborn' ? '' : s.head]);
      const facts = { status: null, repository: ctx.top, commit, tree, parents, branch: s.branch, previous_head: s.head };
      if (u.code !== 0) fail('stale_state', `HEAD moved before the commit could be recorded; nothing was changed (commit object ${commit} stays unreferenced): ${gist(u.err)}`, { ...facts, status: 'stale_state' });
      const s2 = await snapshot(ctx);
      if (s2.head !== commit || s2.branch !== s.branch) fail('partial_state', `After the commit HEAD is ${s2.head} (${s2.branch}).`, { ...facts, status: 'partial' });
      Object.assign(facts, { status: 'committed', staged_left: s2.staged.length, index_fingerprint: s2.index_fingerprint, new: where(s2) });
      return factsResult(facts);
    });
  }

  async function gitIntegrate(a) {
    return change(a.repo, async (ctx) => {
      const mode = a.mode;
      if (!['merge', 'cherry_pick', 'revert'].includes(mode)) fail('invalid_args', 'mode must be merge, cherry_pick or revert.');
      if (mode !== 'merge' && (a.fast_forward !== undefined || a.message !== undefined)) fail('invalid_args', 'fast_forward and message are only used with mode "merge".');
      if (a.message !== undefined && (typeof a.message !== 'string' || !a.message.trim() || a.message.includes('\0'))) fail('invalid_args', 'message must be non-empty text.');
      await noOperation(ctx);
      const s = await snapshot(ctx);
      expectState(s, a, ['head', 'branch']);
      if (s.head === 'unborn') fail('invalid_args', 'HEAD is unborn; nothing to integrate into.');
      needClean(s, mode);
      const src = await exactCommit(ctx, a.source, a.expected_source, 'source');
      if (mode !== 'merge' && (await parentsOf(ctx, src)).length > 1) fail('invalid_args', `${src} is a merge commit; ${mode} of merge commits is not supported.`);
      const ff = { allow: '--ff', never: '--no-ff', only: '--ff-only' }[a.fast_forward ?? 'allow'];
      if (!ff) fail('invalid_args', 'fast_forward must be allow, never or only.');
      const args = mode === 'merge' ? ['merge', '--no-edit', '--no-stat', '--no-overwrite-ignore', '--no-rerere-autoupdate', ff, ...(a.message ? ['-m', a.message] : []), src]
        : mode === 'cherry_pick' ? ['cherry-pick', '--no-rerere-autoupdate', src] : ['revert', '--no-edit', '--no-rerere-autoupdate', src];
      const r = await git(ctx.top, args, { timeout: 100_000 });
      const s2 = await snapshot(ctx); const op = await inProgress(ctx);
      const facts = { status: null, repository: ctx.top, mode, source: src, old: where(s), new: where(s2) };
      if (r.code !== 0 || op) {
        facts.conflicts = s2.conflicts.slice(0, 100);
        if (op) await git(ctx.top, [{ merge: 'merge', cherry_pick: 'cherry-pick', revert: 'revert' }[op] || 'merge', '--abort']);
        const s3 = await snapshot(ctx);
        const restored = !(await inProgress(ctx)) && s3.head === s.head && s3.branch === s.branch && s3.index_fingerprint === s.index_fingerprint && s3.clean;
        Object.assign(facts, { new: where(s3), aborted: !!op, restored });
        if (!restored) { facts.status = 'partial'; fail('partial_state', `${mode} failed and the previous state could not be proven restored: ${gist(r.err)}. Inspect with git_status and ask the user.`, facts); }
        facts.status = op ? 'aborted' : 'refused';
        if (facts.conflicts.length) fail('conflict', `${mode} of ${src} conflicts in ${facts.conflicts.length} path(s); it was aborted and the repository is back at ${s.head}.`, facts);
        if (op === 'cherry_pick' || op === 'revert') fail('nothing_to_commit', `${mode} of ${src} would create an empty commit (already applied?); aborted, nothing changed.`, facts);
        fail(/untracked working tree files|would be overwritten|local changes/.test(r.err) ? 'dirty_worktree' : 'git_failed', `${mode} refused; nothing was changed: ${gist(r.err)}`, facts);
      }
      const parents = s2.head === s.head ? null : await parentsOf(ctx, s2.head);
      if (s2.branch !== s.branch) { facts.status = 'partial'; fail('partial_state', `HEAD moved to ${s2.branch} during ${mode}.`, facts); }
      if (s2.head === s.head) facts.status = 'up_to_date';
      else if (mode === 'merge' && s2.head === src) facts.status = 'fast_forward';
      else if (mode === 'merge' && parents.length === 2 && parents[0] === s.head && parents[1] === src) facts.status = 'merged';
      else if (mode !== 'merge' && parents.length === 1 && parents[0] === s.head) facts.status = mode === 'revert' ? 'reverted' : 'picked';
      else { facts.status = 'partial'; fail('partial_state', `Unexpected result of ${mode}: HEAD ${s2.head} with parents ${parents.join(', ')}.`, facts); }
      if (!s2.clean) facts.warning = 'the working tree is not clean after the operation (filters or line-ending normalization?); see git_status';
      Object.assign(facts, { parents, index_fingerprint: s2.index_fingerprint });
      return factsResult(facts);
    });
  }

  // ---------------------------------------------------------- catalog part --
  const P = (props, required = []) => ({ type: 'object', properties: props, required });
  const str = { type: 'string' }; const num = { type: 'number' }; const bool = { type: 'boolean' }; const strs = { type: 'array', items: str };
  const repo = { repo: str };
  const HEADX = 'expected_head = HEAD from git_status ("unborn" before the first commit)';
  const tools = {
    git_status: { d: 'State of a local Git repository (repo = its working-tree folder inside the file roots): HEAD, branch ("HEAD" when detached), upstream ahead/behind, operation in progress, staged / unstaged / untracked / conflict paths (max_paths per list, default 500), and index_fingerprint / worktree_fingerprint, which Git write capabilities take as expected_index / expected_worktree. Start every Git change here.',
      s: P({ ...repo, max_paths: num }, ['repo']), run: gitStatus },
    git_diff: { d: 'Diff of a local repository, bounded (max_bytes, default 200000): scope unstaged (working tree vs index, default), staged (index vs HEAD) or commits (from .. to, to default HEAD). Optional paths filter; stat_only returns only the per-file numbers. Never changes anything; external diff tools and textconv are not run.',
      s: P({ ...repo, scope: { type: 'string', enum: ['unstaged', 'staged', 'commits'] }, from: str, to: str, paths: strs, max_bytes: num, stat_only: bool }, ['repo']), run: gitDiff },
    git_history: { d: 'Commit history from rev (default HEAD), newest first: commit, tree, parents, author, dates, subject. max_count (default 20, max 200); optional paths filter; more=true if older commits exist.',
      s: P({ ...repo, rev: str, max_count: num, paths: strs }, ['repo']), run: gitHistory },
    git_refs: { d: 'Local branches, tags and remote-tracking refs with their values (object; target = the commit for annotated tags), upstream and ahead/behind; configured remotes with fetch refspecs (URL credentials masked). kind: all (default), branches, tags, remotes.',
      s: P({ ...repo, kind: { type: 'string', enum: ['all', 'branches', 'tags', 'remotes'] }, max: num }, ['repo']), run: gitRefs },
    git_worktrees: { d: 'Worktrees registered for the repository: path, HEAD, branch, main/current, locked/prunable, whether the folder exists.',
      s: P(repo, ['repo']), run: gitWorktrees },
    git_object_info: { d: 'Whether a revision or object exists locally, and its full id, type, size, ref name; for commits tree and parents. contained_in: also report whether that commit is contained in (an ancestor of) another revision. Object content is not returned.',
      s: P({ ...repo, rev: str, contained_in: str }, ['repo', 'rev']), run: gitObjectInfo },
    git_fetch: { d: `Fetch from a configured remote by name (e.g. origin), with its configured refspecs; URLs cannot be given. Updates remote-tracking refs (and tags per the remote's configuration) only: never the checked-out branch or working tree. prune=true also removes remote-tracking refs deleted on the remote. Returns every changed ref with old and new values.`,
      s: P({ ...repo, remote: str, prune: bool }, ['repo', 'remote']), run: gitFetch },
    git_checkout: { d: `Check out an exact commit. target = a local branch (switches to it) or a commit, tag or remote-tracking ref (detached HEAD; detach=true forces this for a branch name too); for a name, expected_target = the commit SHA it must point to. Needs ${HEADX}, optional expected_branch. dirty_policy: require_clean (default: no uncommitted changes to tracked files) or preserve_exact (carry the local changes over; needs expected_index and expected_worktree, and every changed path's index entry and content is verified identical afterwards). Never forces: Git refuses if local changes, untracked or ignored files would be overwritten.`,
      s: P({ ...repo, target: str, expected_target: str, expected_head: str, expected_branch: str, detach: bool, dirty_policy: { type: 'string', enum: ['require_clean', 'preserve_exact'] }, expected_index: str, expected_worktree: str }, ['repo', 'target', 'expected_head']), run: gitCheckout },
    git_ref_update: { d: 'Create, move, delete or rename a local branch or tag; ref = refs/heads/<name> or refs/tags/<name> (lightweight tags). create: target (+ expected_target for a name). move/delete/rename: expected_old = the ref\'s current value (object in git_refs), changed by atomic compare-and-swap. Never loses commits: a move must be a fast-forward, or the old commit must stay reachable from a worktree HEAD, another local branch or (branches) the upstream; the same holds for delete. A branch checked out in a worktree is not moved or deleted. rename: branches only, new_ref. No remote changes.',
      s: P({ ...repo, action: { type: 'string', enum: ['create', 'move', 'delete', 'rename'] }, ref: str, target: str, expected_target: str, expected_old: str, new_ref: str }, ['repo', 'action', 'ref']), run: gitRefUpdate },
    git_worktree_update: { d: 'Add or remove a linked worktree. add: path (inside the file roots, must not exist) and target: a local branch not checked out elsewhere, or a commit (detached; expected_target for a name), or new_branch = a new branch created at target. remove: path of a registered, unlocked, non-main worktree, expected_head = its HEAD (git_worktrees); refused unless it is clean with no untracked or ignored files, so nothing is lost.',
      s: P({ ...repo, action: { type: 'string', enum: ['add', 'remove'] }, path: str, target: str, expected_target: str, new_branch: str, detach: bool, expected_head: str }, ['repo', 'action', 'path']), run: gitWorktreeUpdate },
    git_index_update: { d: `Stage (add, including deletions) or unstage exact paths (relative to the repository, or absolute inside it). Needs ${HEADX} and expected_index (index_fingerprint). Never changes working-tree files; ignored files are not staged. Returns the staged set and the new fingerprints.`,
      s: P({ ...repo, action: { type: 'string', enum: ['stage', 'unstage'] }, paths: strs, expected_head: str, expected_index: str }, ['repo', 'action', 'paths', 'expected_head', 'expected_index']), run: gitIndexUpdate },
    git_commit: { d: `Create a local commit from what is staged, with message, using the repository's configured author identity. Needs ${HEADX} and expected_index (index_fingerprint); optional expected_branch. The branch moves by compare-and-swap from expected_head. Hooks do not run. Never pushes.`,
      s: P({ ...repo, message: str, expected_head: str, expected_branch: str, expected_index: str }, ['repo', 'message', 'expected_head', 'expected_index']), run: gitCommit },
    git_integrate: { d: `Integrate one exact commit into the current branch: mode merge (fast_forward allow (default) / never / only; optional message), cherry_pick or revert (not of merge commits). source = commit SHA, or a name plus expected_source. Needs ${HEADX}, optional expected_branch, and no uncommitted changes to tracked files. On a conflict the operation is aborted and the previous state verified: status aborted with the conflicting paths. Never pushes; no rebase.`,
      s: P({ ...repo, mode: { type: 'string', enum: ['merge', 'cherry_pick', 'revert'] }, source: str, expected_source: str, expected_head: str, expected_branch: str, fast_forward: { type: 'string', enum: ['allow', 'never', 'only'] }, message: str }, ['repo', 'mode', 'source', 'expected_head']), run: gitIntegrate },
  };
  const meta = {
    git_status: ['Git status', 'read'], git_diff: ['Git diff', 'read'], git_history: ['Git history', 'read'], git_refs: ['Git refs', 'read'],
    git_worktrees: ['Git worktrees', 'read'], git_object_info: ['Git object info', 'read'],
    git_fetch: ['Git fetch', 'write'], git_checkout: ['Git checkout', 'write'], git_ref_update: ['Git branch/tag update', 'write'],
    git_worktree_update: ['Git worktree add/remove', 'write'], git_index_update: ['Git stage/unstage', 'write'], git_commit: ['Git commit', 'write'], git_integrate: ['Git merge/cherry-pick/revert', 'write'],
  };
  const environment = () => ({
    version: info.version, available: !info.problem, ...(info.problem ? { problem: info.problem } : {}),
    rules: 'Read state with git_status (and git_refs / git_object_info), then pass the values you saw as expected_*: a change is refused with stale_state, changing nothing, if the repository differs. Repository hooks never run. Not available here, by design: reset --hard, clean, force checkout or branch deletion, rebase, push, remote/URL changes; they need run commands and the user\'s approval.',
  });
  return { tools, meta, detect, environment };
}
