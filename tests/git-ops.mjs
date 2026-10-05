#!/usr/bin/env node
// Local Git operations checks (ADR-0009 / WO-0007): the git_* read capabilities
// (class read) and the non-lossy git_* changes (class write), against disposable
// repositories the test creates under --fixture (a bare "origin" plus clones).
// Runs on the node's own host: it prepares repositories with the git CLI.
//
//   node tests/git-ops.mjs --url http://127.0.0.1:18001/mcp --fixture <dir inside the file roots>
//     [--token-env VAR] [--audit <the server's MCPRELAY_AUDIT_LOG>]
//
// Exit code 0 only if every check passes.

import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const { values: opt } = parseArgs({ options: { url: { type: 'string' }, fixture: { type: 'string' }, 'token-env': { type: 'string' }, audit: { type: 'string' } } });
if (!opt.url || !opt.fixture) {
  console.error('usage: git-ops.mjs --url <mcp url> --fixture <dir> [--token-env VAR] [--audit <audit log>]');
  process.exit(2);
}
const WIN = process.platform === 'win32';
const norm = (p) => (WIN ? p.toLowerCase() : p);

let failures = 0;
async function check(name, fn) {
  const t0 = performance.now();
  try {
    const detail = await fn();
    console.log(`PASS  ${name}  -- ${Math.round(performance.now() - t0)} ms${detail ? `; ${detail}` : ''}`);
  } catch (e) {
    failures++;
    console.log(`FAIL  ${name}  -- ${e?.message ?? e}`);
  }
}
const expect = (cond, message) => { if (!cond) throw new Error(message); };
const brief = (s) => JSON.stringify(s.length > 400 ? `${s.slice(0, 400)}…` : s);

const headers = {};
if (opt['token-env']) headers.Authorization = `Bearer ${process.env[opt['token-env']]}`;
const client = new Client({ name: 'mcprelay-git-ops', version: '0.1.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
await client.connect(new StreamableHTTPClientTransport(new URL(opt.url), { requestInit: { headers } }));
const catalog = JSON.parse((await client.callTool({ name: 'list_capabilities', arguments: {} })).content[0].text);
const VIA = new Map(catalog.capabilities.map((c) => [c.name, c.invoke_with]));
async function raw(tool, capability, args) {
  const res = await client.callTool({ name: tool, arguments: { capability, args } });
  return { isError: !!res.isError, text: res.content.map((c) => c.text).join('\n') };
}
// {ok, text, code, facts}: facts = the JSON result, or the facts that follow an error line.
async function call(name, args) {
  const r = await raw(VIA.get(name) || 'invoke_read', name, args);
  const code = r.isError ? (/^Error \[(\w+)\]/.exec(r.text) || [])[1] : null;
  let facts = null;
  try { facts = JSON.parse(r.isError ? r.text.slice(r.text.indexOf('\n') + 1) : r.text); } catch { /* plain text */ }
  return { ok: !r.isError, text: r.text, code, facts };
}
const mustOk = async (name, args) => { const r = await call(name, args); expect(r.ok, `${name}: ${brief(r.text)}`); return r.facts; };
const status = (repo) => mustOk('git_status', { repo });

// ----------------------------------------------------------------- fixture --
const ROOT = path.join(opt.fixture, `git-${randomBytes(3).toString('hex')}`);
await fs.mkdir(ROOT, { recursive: true });
const P = (...p) => path.join(ROOT, ...p);
const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sha = (cwd, rev = 'HEAD') => g(cwd, 'rev-parse', rev);
const write = (f, s) => fs.writeFile(f, s);
const read = (f) => fs.readFile(f, 'utf8');
const exists = (f) => fs.lstat(f).then(() => true, () => false);
const identity = (cwd) => { g(cwd, 'config', 'user.name', 'MCPRelay Test'); g(cwd, 'config', 'user.email', 'test@example.invalid'); g(cwd, 'config', 'core.autocrlf', 'false'); };
const commitFile = async (cwd, file, content, msg) => { await write(path.join(cwd, file), content); g(cwd, 'add', '--', file); g(cwd, 'commit', '-q', '-m', msg); return sha(cwd); };
// autocrlf off from the start, so checkouts are byte-identical on every OS.
function cloneOf(name) { g(ROOT, 'clone', '-q', '-c', 'core.autocrlf=false', P('origin.git'), name); identity(P(name)); return P(name); }

g(ROOT, '-c', 'init.defaultBranch=main', 'init', '-q', '--bare', 'origin.git');
g(ROOT, '-c', 'init.defaultBranch=main', 'init', '-q', 'seed'); // config before the first file
identity(P('seed'));
await write(P('seed', '.gitignore'), '*.log\nsecret.env\n');
await write(P('seed', 'b.txt'), 'b\n');
await commitFile(P('seed'), 'a.txt', 'line1\nline2\nline3\n', 'initial');
g(P('seed'), 'add', '.gitignore', 'b.txt'); g(P('seed'), 'commit', '-q', '-m', 'ignore and b');
g(P('seed'), 'remote', 'add', 'origin', P('origin.git'));
g(P('seed'), 'push', '-q', 'origin', 'main');
const WORK = cloneOf('work');
const OTHER = cloneOf('other');
const base = sha(WORK);

// ----------------------------------------------------------------- catalog --
await check('catalog: git reads are class read, git changes class write (invoke_write)', async () => {
  const cls = (n) => catalog.capabilities.find((c) => c.name === n)?.class;
  for (const n of ['git_status', 'git_diff', 'git_history', 'git_refs', 'git_worktrees', 'git_object_info']) expect(cls(n) === 'read', `${n} is ${cls(n)}`);
  for (const n of ['git_fetch', 'git_checkout', 'git_ref_update', 'git_worktree_update', 'git_index_update', 'git_commit', 'git_integrate']) expect(cls(n) === 'write', `${n} is ${cls(n)}`);
  expect(catalog.environment.git?.available === true && catalog.environment.git.version, `git environment: ${JSON.stringify(catalog.environment.git)}`);
  const { tools } = await client.listTools();
  expect(!tools.some((t) => t.name === 'invoke_git'), 'no separate invoke_git tool is exposed');
  const w = tools.find((t) => t.name === 'invoke_write').annotations;
  expect(w.readOnlyHint === false && w.destructiveHint === false && w.openWorldHint === false, `invoke_write annotations: ${JSON.stringify(w)}`);
  return `git ${catalog.environment.git.version}`;
});

await check('a capability is refused through another class tool (nothing runs)', async () => {
  const r = await raw('invoke_read', 'git_commit', { repo: WORK, message: 'x', expected_head: base, expected_index: 'x' });
  expect(r.isError && /wrong_class/.test(r.text) && /invoke_write/.test(r.text), brief(r.text));
  const w = await raw('invoke_write', 'git_status', { repo: WORK });
  expect(w.isError && /wrong_class/.test(w.text), brief(w.text));
  const x = await raw('invoke_exec', 'git_fetch', { repo: WORK, remote: 'origin' });
  expect(x.isError && /wrong_class/.test(x.text), brief(x.text));
  expect(sha(WORK) === base, 'HEAD moved');
});

// ------------------------------------------------------------------- reads --
let st0;
await check('git_status: clean clone with head, branch, upstream and fingerprints', async () => {
  st0 = await status(WORK);
  expect(st0.head === base && st0.branch === 'main' && st0.detached === false && st0.clean === true, JSON.stringify(st0));
  expect(st0.upstream === 'origin/main' && st0.ahead === 0 && st0.behind === 0, `upstream ${st0.upstream} ${st0.ahead}/${st0.behind}`);
  expect(/^[0-9a-f]{64}$/.test(st0.index_fingerprint) && /^[0-9a-f]{64}$/.test(st0.worktree_fingerprint), 'fingerprints');
  expect(norm(st0.repository.worktree) === norm(await fs.realpath(WORK)), `worktree ${st0.repository.worktree}`);
});

await check('git_status: staged / unstaged / untracked; fingerprints follow content', async () => {
  await write(P('work', 'a.txt'), 'line1\nchanged\nline3\n');
  await write(P('work', 'new.txt'), 'new\n'); g(WORK, 'add', 'new.txt');
  await write(P('work', 'u.txt'), 'untracked\n');
  await write(P('work', 'x.log'), 'ignored\n');
  const s = await status(WORK);
  expect(s.clean === false && s.staged.some((x) => x.path === 'new.txt' && x.status === 'A'), `staged ${JSON.stringify(s.staged)}`);
  expect(s.unstaged.some((x) => x.path === 'a.txt' && x.status === 'M') && s.untracked.includes('u.txt') && !s.untracked.includes('x.log'), JSON.stringify(s));
  expect(s.index_fingerprint !== st0.index_fingerprint && s.worktree_fingerprint !== st0.worktree_fingerprint, 'fingerprints did not change');
  await write(P('work', 'u.txt'), 'untracked, edited\n');
  const s2 = await status(WORK);
  expect(s2.worktree_fingerprint !== s.worktree_fingerprint && s2.index_fingerprint === s.index_fingerprint, 'worktree fingerprint must follow untracked content only');
});

await check('git_diff: unstaged, staged, commits, path filter, bound', async () => {
  const u = await mustOk('git_diff', { repo: WORK });
  expect(u.files.length === 1 && u.files[0].path === 'a.txt' && /\+changed/.test(u.patch), brief(JSON.stringify(u)));
  const s = await mustOk('git_diff', { repo: WORK, scope: 'staged' });
  expect(s.files.some((f) => f.path === 'new.txt') && /\+new/.test(s.patch), brief(JSON.stringify(s)));
  const c = await mustOk('git_diff', { repo: WORK, scope: 'commits', from: `${base}~1`, to: base, paths: ['b.txt'], stat_only: true });
  expect(c.files.length === 1 && c.files[0].path === 'b.txt' && c.patch === undefined, brief(JSON.stringify(c)));
  const t = await mustOk('git_diff', { repo: WORK, scope: 'commits', from: `${base}~1`, max_bytes: 1000 });
  expect(typeof t.truncated === 'boolean', 'truncated flag');
  const out = await call('git_diff', { repo: WORK, paths: ['../outside.txt'] });
  expect(out.code === 'path_not_allowed', brief(out.text));
});
// restore the clean state with the CLI (the test's own setup tool)
g(WORK, 'reset', '-q', '--hard'); for (const f of ['u.txt', 'x.log']) await fs.rm(P('work', f), { force: true });

await check('git_history: identities, parents, bound', async () => {
  const h = await mustOk('git_history', { repo: WORK, max_count: 1 });
  expect(h.commits.length === 1 && h.commits[0].commit === base && h.commits[0].tree === sha(WORK, 'HEAD^{tree}'), brief(JSON.stringify(h)));
  expect(h.commits[0].parents[0] === sha(WORK, 'HEAD~1') && h.more === true && h.commits[0].subject === 'ignore and b', brief(JSON.stringify(h)));
  const p = await mustOk('git_history', { repo: WORK, paths: ['a.txt'] });
  expect(p.commits.length === 1 && p.commits[0].subject === 'initial', brief(JSON.stringify(p)));
});

await check('git_refs and git_object_info', async () => {
  const r = await mustOk('git_refs', { repo: WORK });
  expect(r.refs.some((x) => x.ref === 'refs/heads/main' && x.object === base && x.upstream === 'refs/remotes/origin/main'), brief(JSON.stringify(r.refs)));
  expect(r.remotes.length === 1 && r.remotes[0].name === 'origin' && r.remotes[0].fetch[0].includes('refs/remotes/origin/'), brief(JSON.stringify(r.remotes)));
  const o = await mustOk('git_object_info', { repo: WORK, rev: 'main', contained_in: 'origin/main' });
  expect(o.exists && o.object === base && o.type === 'commit' && o.ref === 'refs/heads/main' && o.contained_in.contains === true, brief(JSON.stringify(o)));
  const m = await mustOk('git_object_info', { repo: WORK, rev: 'f'.repeat(40) });
  expect(m.exists === false, brief(JSON.stringify(m)));
});

await check('git_worktrees lists the main worktree', async () => {
  const w = await mustOk('git_worktrees', { repo: WORK });
  expect(w.worktrees.length === 1 && w.worktrees[0].main && w.worktrees[0].current && w.worktrees[0].head === base, brief(JSON.stringify(w)));
});

// -------------------------------------------------------- scope and argv --
await check('repository outside the file roots, or not a repository: refused', async () => {
  const r = await call('git_status', { repo: path.parse(ROOT).root });
  expect(r.code === 'path_not_allowed', brief(r.text));
  await fs.mkdir(P('plain'));
  const n = await call('git_status', { repo: P('plain') });
  expect(n.code === 'not_a_repository' || n.code === 'path_not_allowed', brief(n.text)); // the fixture parent may itself be in no repo
});

// A writable folder outside the server's file roots, for escape checks (none: skipped).
const nodeStatus = JSON.parse((await raw('invoke_read', 'node_status', {})).text);
const outsideBase = [os.tmpdir(), process.cwd()].find((d) => !nodeStatus.allowed_dirs.some((r) => norm(path.resolve(d)).startsWith(norm(path.resolve(r)))));
let OUTSIDE = null;
await check('symlink/junction and .git-file escapes to a repository outside the roots: refused', async () => {
  if (!outsideBase) return 'SKIPPED: no writable folder outside the roots';
  OUTSIDE = path.join(outsideBase, `mcprelay-git-outside-${randomBytes(3).toString('hex')}`);
  g(outsideBase, '-c', 'init.defaultBranch=main', 'init', '-q', OUTSIDE);
  await fs.symlink(OUTSIDE, P('link-out'), WIN ? 'junction' : 'dir');
  const l = await call('git_status', { repo: P('link-out') });
  expect(l.code === 'path_not_allowed', `link: ${brief(l.text)}`);
  await fs.mkdir(P('gitfile-out'));
  await write(P('gitfile-out', '.git'), `gitdir: ${path.join(OUTSIDE, '.git')}\n`);
  const f = await call('git_status', { repo: P('gitfile-out') });
  expect(f.code === 'path_not_allowed', `.git file: ${brief(f.text)}`);
  return `outside: ${outsideBase}`;
});

await check('no capability takes Git options or extra argv', async () => {
  const marker = P('injected.txt');
  const h = await call('git_history', { repo: WORK, rev: `--output=${marker}` });
  expect(h.code === 'invalid_args', brief(h.text));
  const a = await call('git_fetch', { repo: WORK, remote: 'origin', args: ['--force'] });
  expect(a.code === 'invalid_args' && /unknown argument "args"/.test(a.text), brief(a.text));
  const u = await call('git_fetch', { repo: WORK, remote: 'origin', url: 'https://example.invalid/x.git' });
  expect(u.code === 'invalid_args', brief(u.text));
  const f = await call('git_checkout', { repo: WORK, target: base, expected_head: base, force: true });
  expect(f.code === 'invalid_args', brief(f.text));
  expect(!(await exists(marker)), 'an option was passed to git');
});

// -------------------------------------------------------------------- fetch --
const upstream1 = await commitFile(OTHER, 'remote.txt', 'from other\n', 'remote change');
g(OTHER, 'push', '-q', 'origin', 'main');
await check('git_fetch: configured remote only; tracking refs change, HEAD and worktree do not', async () => {
  const bad = await call('git_fetch', { repo: WORK, remote: 'nope' });
  expect(bad.code === 'not_found', brief(bad.text));
  const f = await mustOk('git_fetch', { repo: WORK, remote: 'origin' });
  expect(f.status === 'fetched' && f.changed.some((c) => c.ref === 'refs/remotes/origin/main' && c.old === base && c.new === upstream1), brief(JSON.stringify(f)));
  expect(f.head_unchanged && sha(WORK) === base && !(await exists(P('work', 'remote.txt'))), 'fetch changed HEAD or the worktree');
});

// ----------------------------------------------------------------- checkout --
await check('git_checkout: stale HEAD, dirty tree and unpinned names change nothing', async () => {
  const stale = await call('git_checkout', { repo: WORK, target: upstream1, expected_head: 'a'.repeat(40) });
  expect(stale.code === 'stale_state' && stale.facts.mismatches.head, brief(stale.text));
  const name = await call('git_checkout', { repo: WORK, target: 'origin/main', expected_head: base });
  expect(name.code === 'invalid_args' && /expected_target/.test(name.text), brief(name.text));
  const wrong = await call('git_checkout', { repo: WORK, target: 'origin/main', expected_target: base, expected_head: base });
  expect(wrong.code === 'stale_state', brief(wrong.text));
  await write(P('work', 'a.txt'), 'dirty\n');
  const d = await call('git_checkout', { repo: WORK, target: upstream1, expected_head: base });
  expect(d.code === 'dirty_worktree' && /next: stop and ask the user/.test(d.text), brief(d.text));
  expect(sha(WORK) === base && (await read(P('work', 'a.txt'))) === 'dirty\n', 'state changed');
  g(WORK, 'checkout', '-q', '--', 'a.txt');
});

await check('git_checkout: detached at an exact commit, then back to the branch', async () => {
  const c = await mustOk('git_checkout', { repo: WORK, target: 'origin/main', expected_target: upstream1, expected_head: base, expected_branch: 'main' });
  expect(c.status === 'checked_out' && c.new.head === upstream1 && c.new.branch === 'HEAD' && sha(WORK) === upstream1, brief(JSON.stringify(c)));
  const back = await call('git_checkout', { repo: WORK, target: 'main', expected_head: upstream1 });
  expect(back.code === 'invalid_args', `a branch name needs expected_target: ${brief(back.text)}`);
  const b = await mustOk('git_checkout', { repo: WORK, target: 'main', expected_target: base, expected_head: upstream1 });
  expect(b.new.head === base && b.new.branch === 'main' && g(WORK, 'symbolic-ref', 'HEAD') === 'refs/heads/main', brief(JSON.stringify(b)));
});

await check('git_checkout preserve_exact: staged, unstaged and untracked changes carried over unchanged', async () => {
  await write(P('work', 'a.txt'), 'line1\nlocal edit\nline3\n');
  await write(P('work', 'staged.txt'), 'staged\n'); g(WORK, 'add', 'staged.txt');
  await write(P('work', 'loose.txt'), 'untracked\n');
  const s = await status(WORK);
  const noFp = await call('git_checkout', { repo: WORK, target: upstream1, expected_head: base, dirty_policy: 'preserve_exact' });
  expect(noFp.code === 'invalid_args', brief(noFp.text));
  const staleFp = await call('git_checkout', { repo: WORK, target: upstream1, expected_head: base, dirty_policy: 'preserve_exact', expected_index: s.index_fingerprint, expected_worktree: '0'.repeat(64) });
  expect(staleFp.code === 'stale_state' && sha(WORK) === base, brief(staleFp.text));
  const c = await mustOk('git_checkout', { repo: WORK, target: upstream1, expected_head: base, dirty_policy: 'preserve_exact', expected_index: s.index_fingerprint, expected_worktree: s.worktree_fingerprint });
  expect(c.status === 'checked_out' && c.preserved_paths === 3 && sha(WORK) === upstream1, brief(JSON.stringify(c)));
  expect((await read(P('work', 'a.txt'))) === 'line1\nlocal edit\nline3\n' && (await read(P('work', 'loose.txt'))) === 'untracked\n', 'content changed');
  expect(g(WORK, 'diff', '--cached', '--name-only') === 'staged.txt', 'staged set changed');
  const s2 = await status(WORK);
  await mustOk('git_checkout', { repo: WORK, target: 'main', expected_target: base, expected_head: upstream1, dirty_policy: 'preserve_exact', expected_index: s2.index_fingerprint, expected_worktree: s2.worktree_fingerprint });
  expect(sha(WORK) === base && (await read(P('work', 'a.txt'))) === 'line1\nlocal edit\nline3\n', 'not back on main with the changes');
});
g(WORK, 'reset', '-q', '--hard'); await fs.rm(P('work', 'loose.txt'), { force: true });

await check('git_checkout never overwrites an ignored file', async () => {
  g(WORK, 'switch', '-q', '-c', 'tracks-secret');
  await write(P('work', 'secret.env'), 'TRACKED=1\n'); g(WORK, 'add', '-f', 'secret.env'); g(WORK, 'commit', '-q', '-m', 'track secret');
  const tracked = sha(WORK);
  g(WORK, 'switch', '-q', 'main');
  await write(P('work', 'secret.env'), 'LOCAL_SECRET=keep-me\n'); // ignored on main
  const r = await call('git_checkout', { repo: WORK, target: 'tracks-secret', expected_target: tracked, expected_head: base });
  expect(!r.ok && ['dirty_worktree', 'git_failed'].includes(r.code), brief(r.text));
  expect((await read(P('work', 'secret.env'))) === 'LOCAL_SECRET=keep-me\n' && sha(WORK) === base, 'ignored file overwritten or HEAD moved');
  await fs.rm(P('work', 'secret.env')); g(WORK, 'branch', '-q', '-D', 'tracks-secret');
});

// ------------------------------------------------------------ index/commit --
await check('git_index_update: stage and unstage exact paths; stale index and ignored paths refused', async () => {
  await write(P('work', 'a.txt'), 'line1\nline2 edited\nline3\n');
  await write(P('work', 'x.log'), 'ignored\n');
  const s = await status(WORK);
  const stale = await call('git_index_update', { repo: WORK, action: 'stage', paths: ['a.txt'], expected_head: base, expected_index: '0'.repeat(64) });
  expect(stale.code === 'stale_state' && g(WORK, 'diff', '--cached', '--name-only') === '', brief(stale.text));
  const ign = await call('git_index_update', { repo: WORK, action: 'stage', paths: ['x.log'], expected_head: base, expected_index: s.index_fingerprint });
  expect(ign.code === 'invalid_args' && /Ignored/.test(ign.text), brief(ign.text));
  const st = await mustOk('git_index_update', { repo: WORK, action: 'stage', paths: [P('work', 'a.txt')], expected_head: base, expected_index: s.index_fingerprint });
  expect(st.status === 'staged' && st.staged.some((x) => x.path === 'a.txt') && g(WORK, 'diff', '--cached', '--name-only') === 'a.txt', brief(JSON.stringify(st)));
  const un = await mustOk('git_index_update', { repo: WORK, action: 'unstage', paths: ['a.txt'], expected_head: base, expected_index: st.index_fingerprint });
  expect(un.status === 'unstaged' && un.staged.length === 0 && (await read(P('work', 'a.txt'))) === 'line1\nline2 edited\nline3\n', brief(JSON.stringify(un)));
  await fs.rm(P('work', 'x.log'));
});

let c1;
await check('git_commit: local commit by compare-and-swap; stale HEAD or index and empty index refused', async () => {
  let s = await status(WORK);
  const none = await call('git_commit', { repo: WORK, message: 'nothing', expected_head: base, expected_index: s.index_fingerprint });
  expect(none.code === 'nothing_to_commit', brief(none.text));
  const st = await mustOk('git_index_update', { repo: WORK, action: 'stage', paths: ['a.txt'], expected_head: base, expected_index: s.index_fingerprint });
  const staleIdx = await call('git_commit', { repo: WORK, message: 'x', expected_head: base, expected_index: s.index_fingerprint });
  expect(staleIdx.code === 'stale_state' && sha(WORK) === base, brief(staleIdx.text));
  const tree = g(WORK, 'write-tree');
  const c = await mustOk('git_commit', { repo: WORK, message: 'edit line2\n\nbody text', expected_head: base, expected_branch: 'main', expected_index: st.index_fingerprint });
  c1 = c.commit;
  expect(c.status === 'committed' && sha(WORK) === c1 && c.parents[0] === base && c.tree === tree && c.staged_left === 0, brief(JSON.stringify(c)));
  expect(g(WORK, 'log', '-1', '--format=%s|%an') === 'edit line2|MCPRelay Test' && g(WORK, 'symbolic-ref', 'HEAD') === 'refs/heads/main', 'commit metadata');
  // A change between observation and action (here: a commit made outside) is refused.
  s = await status(WORK);
  await commitFile(WORK, 'outside.txt', 'x\n', 'made outside');
  await write(P('work', 'b.txt'), 'b2\n'); g(WORK, 'add', 'b.txt');
  const raced = await call('git_commit', { repo: WORK, message: 'late', expected_head: c1, expected_index: (await status(WORK)).index_fingerprint });
  expect(raced.code === 'stale_state' && raced.facts.mismatches.head, brief(raced.text));
  g(WORK, 'reset', '-q', '--hard', c1);
  void s;
});

// --------------------------------------------------------------------- refs --
await check('git_ref_update: create, fast-forward, lossless delete/rename, tags', async () => {
  const exists1 = await call('git_ref_update', { repo: WORK, action: 'create', ref: 'refs/heads/main', target: c1 });
  expect(exists1.code === 'already_exists', brief(exists1.text));
  const bad = await call('git_ref_update', { repo: WORK, action: 'create', ref: 'feature', target: c1 });
  expect(bad.code === 'invalid_args', brief(bad.text));
  const cr = await mustOk('git_ref_update', { repo: WORK, action: 'create', ref: 'refs/heads/feature', target: base });
  expect(cr.status === 'created' && sha(WORK, 'refs/heads/feature') === base, brief(JSON.stringify(cr)));
  const stale = await call('git_ref_update', { repo: WORK, action: 'move', ref: 'refs/heads/feature', target: c1, expected_old: upstream1 });
  expect(stale.code === 'stale_state' && sha(WORK, 'refs/heads/feature') === base, brief(stale.text));
  const mv = await mustOk('git_ref_update', { repo: WORK, action: 'move', ref: 'refs/heads/feature', target: upstream1, expected_old: base });
  expect(mv.status === 'moved' && mv.lossless === 'fast-forward' && sha(WORK, 'refs/heads/feature') === upstream1, brief(JSON.stringify(mv)));
  const loss = await call('git_ref_update', { repo: WORK, action: 'move', ref: 'refs/heads/feature', target: c1, expected_old: upstream1 });
  expect(loss.code === 'not_merged' && sha(WORK, 'refs/heads/feature') === upstream1, `moving away from an unmerged commit: ${brief(loss.text)}`);
  const del = await call('git_ref_update', { repo: WORK, action: 'delete', ref: 'refs/heads/feature', expected_old: upstream1 });
  expect(del.code === 'not_merged', `deleting an unmerged branch: ${brief(del.text)}`);
  const main = await call('git_ref_update', { repo: WORK, action: 'move', ref: 'refs/heads/main', target: base, expected_old: c1 });
  expect(main.code === 'ref_in_use', brief(main.text));
  await mustOk('git_ref_update', { repo: WORK, action: 'create', ref: 'refs/heads/merged', target: base });
  const rn = await mustOk('git_ref_update', { repo: WORK, action: 'rename', ref: 'refs/heads/merged', new_ref: 'refs/heads/merged2', expected_old: base });
  expect(rn.status === 'renamed' && sha(WORK, 'refs/heads/merged2') === base, brief(JSON.stringify(rn)));
  const d = await mustOk('git_ref_update', { repo: WORK, action: 'delete', ref: 'refs/heads/merged2', expected_old: base });
  expect(d.status === 'deleted' && /kept by/.test(d.lossless), brief(JSON.stringify(d)));
  const t = await mustOk('git_ref_update', { repo: WORK, action: 'create', ref: 'refs/tags/v1', target: 'main', expected_target: c1 });
  expect(t.status === 'created' && sha(WORK, 'refs/tags/v1') === c1, brief(JSON.stringify(t)));
  const td = await mustOk('git_ref_update', { repo: WORK, action: 'delete', ref: 'refs/tags/v1', expected_old: c1 });
  expect(td.status === 'deleted', brief(JSON.stringify(td)));
  g(WORK, 'branch', '-q', '-D', 'feature');
});

// ---------------------------------------------------------------- worktrees --
await check('git_worktree_update: add with a new branch; remove only when clean (untracked and ignored files kept)', async () => {
  const wt = P('wt1');
  const a = await mustOk('git_worktree_update', { repo: WORK, action: 'add', path: wt, target: c1, new_branch: 'wt-branch' });
  expect(a.status === 'added' && a.head === c1 && a.branch === 'refs/heads/wt-branch' && (await exists(path.join(wt, 'a.txt'))), brief(JSON.stringify(a)));
  const again = await call('git_worktree_update', { repo: WORK, action: 'add', path: wt, target: c1, new_branch: 'wt-branch2' });
  expect(again.code === 'already_exists', brief(again.text));
  const stale = await call('git_worktree_update', { repo: WORK, action: 'remove', path: wt, expected_head: base });
  expect(stale.code === 'stale_state', brief(stale.text));
  await write(path.join(wt, 'note.txt'), 'untracked\n');
  const dirty = await call('git_worktree_update', { repo: WORK, action: 'remove', path: wt, expected_head: c1 });
  expect(dirty.code === 'dirty_worktree' && (await exists(path.join(wt, 'note.txt'))), brief(dirty.text));
  await fs.rm(path.join(wt, 'note.txt'));
  await write(path.join(wt, 'build.log'), 'ignored\n');
  const ign = await call('git_worktree_update', { repo: WORK, action: 'remove', path: wt, expected_head: c1 });
  expect(ign.code === 'dirty_worktree' && /ignored/.test(ign.text) && (await exists(path.join(wt, 'build.log'))), brief(ign.text));
  await fs.rm(path.join(wt, 'build.log'));
  const mainRm = await call('git_worktree_update', { repo: WORK, action: 'remove', path: WORK, expected_head: c1 });
  expect(mainRm.code === 'invalid_args', brief(mainRm.text));
  const r = await mustOk('git_worktree_update', { repo: WORK, action: 'remove', path: wt, expected_head: c1 });
  expect(r.status === 'removed' && !(await exists(wt)) && !g(WORK, 'worktree', 'list').includes('wt1'), brief(JSON.stringify(r)));
  expect(sha(WORK, 'refs/heads/wt-branch') === c1, 'the branch stays');
  g(WORK, 'branch', '-q', '-D', 'wt-branch');
});

// ---------------------------------------------------------------- integrate --
await check('git_integrate: fast-forward and true merge', async () => {
  // main (c1) diverged from origin/main (upstream1): fast_forward only must refuse.
  const ffo = await call('git_integrate', { repo: WORK, mode: 'merge', source: upstream1, expected_head: c1, fast_forward: 'only' });
  expect(!ffo.ok && sha(WORK) === c1 && ffo.facts?.status === 'refused', brief(ffo.text));
  const m = await mustOk('git_integrate', { repo: WORK, mode: 'merge', source: 'origin/main', expected_source: upstream1, expected_head: c1, expected_branch: 'main', message: 'merge origin' });
  expect(m.status === 'merged' && m.parents[0] === c1 && m.parents[1] === upstream1 && (await exists(P('work', 'remote.txt'))), brief(JSON.stringify(m)));
  const merged = sha(WORK);
  g(WORK, 'switch', '-q', '-c', 'ahead'); const ahead = await commitFile(WORK, 'ahead.txt', 'ahead\n', 'ahead'); g(WORK, 'switch', '-q', 'main');
  const ff = await mustOk('git_integrate', { repo: WORK, mode: 'merge', source: ahead, expected_head: merged });
  expect(ff.status === 'fast_forward' && sha(WORK) === ahead, brief(JSON.stringify(ff)));
  const up = await mustOk('git_integrate', { repo: WORK, mode: 'merge', source: ahead, expected_head: ahead });
  expect(up.status === 'up_to_date', brief(JSON.stringify(up)));
  g(WORK, 'branch', '-q', '-D', 'ahead');
});

await check('git_integrate: cherry-pick and revert of exact commits; an empty pick is aborted', async () => {
  const h0 = sha(WORK);
  g(WORK, 'switch', '-q', '-c', 'pick'); const pick = await commitFile(WORK, 'picked.txt', 'p\n', 'to pick'); g(WORK, 'switch', '-q', 'main');
  const p = await mustOk('git_integrate', { repo: WORK, mode: 'cherry_pick', source: pick, expected_head: h0 });
  expect(p.status === 'picked' && p.parents[0] === h0 && (await read(P('work', 'picked.txt'))) === 'p\n', brief(JSON.stringify(p)));
  const h1 = sha(WORK);
  const again = await call('git_integrate', { repo: WORK, mode: 'cherry_pick', source: pick, expected_head: h1 });
  expect(again.code === 'nothing_to_commit' && again.facts.restored === true && sha(WORK) === h1, brief(again.text));
  const r = await mustOk('git_integrate', { repo: WORK, mode: 'revert', source: h1, expected_head: h1 });
  expect(r.status === 'reverted' && !(await exists(P('work', 'picked.txt'))), brief(JSON.stringify(r)));
  g(WORK, 'branch', '-q', '-D', 'pick');
});

await check('git_integrate: a conflict is aborted and the previous state verified', async () => {
  const h0 = sha(WORK);
  g(WORK, 'switch', '-q', '-c', 'conf'); const conf = await commitFile(WORK, 'a.txt', 'line1\nTHEIRS\nline3\n', 'theirs'); g(WORK, 'switch', '-q', 'main');
  const ours = await commitFile(WORK, 'a.txt', 'line1\nOURS\nline3\n', 'ours');
  const c = await call('git_integrate', { repo: WORK, mode: 'merge', source: conf, expected_head: ours });
  expect(c.code === 'conflict' && c.facts.status === 'aborted' && c.facts.restored === true && c.facts.conflicts.some((x) => x.path === 'a.txt'), brief(c.text));
  expect(sha(WORK) === ours && (await read(P('work', 'a.txt'))) === 'line1\nOURS\nline3\n' && !(await exists(P('work', '.git', 'MERGE_HEAD'))), 'state not restored');
  await write(P('work', 'a.txt'), 'dirty\n');
  const d = await call('git_integrate', { repo: WORK, mode: 'merge', source: conf, expected_head: ours });
  expect(d.code === 'dirty_worktree' && (await read(P('work', 'a.txt'))) === 'dirty\n', brief(d.text));
  g(WORK, 'checkout', '-q', '--', 'a.txt'); g(WORK, 'branch', '-q', '-D', 'conf');
  void h0;
});

// -------------------------------------------------------------------- hooks --
await check('repository hooks never run (commit, checkout, merge)', async () => {
  const H = cloneOf('hooked');
  const marker = P('hook-ran.txt').split(path.sep).join('/');
  const hook = `#!/bin/sh\necho "$0" >> "${marker}"\n`;
  const names = ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'post-checkout', 'post-merge', 'pre-merge-commit', 'reference-transaction'];
  for (const dir of [path.join(H, '.git', 'hooks'), path.join(H, 'repo-hooks')]) {
    await fs.mkdir(dir, { recursive: true });
    for (const n of names) { await write(path.join(dir, n), hook); await fs.chmod(path.join(dir, n), 0o755); }
  }
  g(H, 'config', 'core.hooksPath', 'repo-hooks'); // as husky and similar tools do, with hooks inside the repository content
  await write(path.join(H, 'h.txt'), 'h\n');
  let s = await status(H);
  const st = await mustOk('git_index_update', { repo: H, action: 'stage', paths: ['h.txt'], expected_head: s.head, expected_index: s.index_fingerprint });
  const c = await mustOk('git_commit', { repo: H, message: 'hooked', expected_head: s.head, expected_index: st.index_fingerprint });
  await mustOk('git_checkout', { repo: H, target: base, expected_head: c.commit });
  await mustOk('git_checkout', { repo: H, target: 'main', expected_target: c.commit, expected_head: base });
  // Test setup through the CLI, with hooks off so it cannot touch the marker.
  const q = (...args) => g(H, '-c', 'core.hooksPath=no-such-dir', ...args);
  q('switch', '-q', '-c', 'side'); await write(path.join(H, 'side.txt'), 's\n'); q('add', 'side.txt'); q('commit', '-q', '-m', 'side');
  const side = sha(H); q('switch', '-q', 'main');
  s = await status(H);
  await mustOk('git_integrate', { repo: H, mode: 'merge', source: side, expected_head: s.head, fast_forward: 'never' });
  await mustOk('git_ref_update', { repo: H, action: 'create', ref: 'refs/tags/hooked', target: side });
  expect(!(await exists(marker)), `a hook ran: ${await read(marker).catch(() => '')}`);
  g(H, 'commit', '-q', '--allow-empty', '-m', 'cli'); // sanity: the same hooks do run for plain git
  expect(await exists(marker), 'sanity check: the hooks never ran, so the test proves nothing');
});

// -------------------------------------------------------------------- audit --
await check('audit log: Git calls recorded with the resulting commit, never the message', async () => {
  if (!opt.audit) return 'SKIPPED: no --audit';
  const lines = (await read(opt.audit).catch(() => '')) + (await read(`${opt.audit}.1`).catch(() => ''));
  const commits = lines.split('\n').filter((l) => l.includes('"tool":"git_commit"') && l.includes('"ok":true')).map((l) => JSON.parse(l));
  expect(commits.length && commits.some((e) => e.git_head === c1 && e.cls === 'write'), `no git_commit line with git_head ${c1}`);
  expect(!lines.includes('edit line2') && !lines.includes('body text'), 'commit message leaked into the audit log');
});

// ------------------------------------------------------------------ cleanup --
await client.close();
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
if (OUTSIDE) await fs.rm(OUTSIDE, { recursive: true, force: true }).catch(() => {});
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
