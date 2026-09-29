#!/usr/bin/env node
// MCPRelay node capability server (module M1, ADR-0004): one process serving
// MCP over loopback HTTP in both protocol generations (2026-07-28 natively,
// 2025-era via the SDK's stateless fallback) and implementing the local
// capabilities itself (Desktop Commander-compatible names/arguments). Clients see
// a fixed tool set, list_capabilities + one invoke_<class> tool per risk class
// (ADR-0007), so capability changes need no client-side tool refresh. Supervised by the tray
// app (app/windows/MCPRelay.cs), which restarts it on exit or failed health.
//
//   MCPRELAY_BRIDGE_TOKEN=<token> node server.mjs [--port 18001] [--host 127.0.0.1]
//   MCPRELAY_ALLOWED_DIRS=<dir>[;<dir>...]   file-tool roots (default: user home)
//
// Reliability rules (the Owner ranks stability above speed):
// * every tool call is bounded (CALL_TIMEOUT_MS) and never throws past the handler;
// * responses carry `Connection: close`, so the gateway never reuses a pooled
//   connection that died with a previous tunnel (costs one tunnel RTT per call);
// * process sessions and their output are bounded; child trees are killed on exit;
// * unexpected errors are logged; an uncaught exception exits so the supervisor
//   restarts a clean process instead of running in an unknown state.

import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { homedir, hostname, arch, release } from 'node:os';
import { parseArgs } from 'node:util';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server, ProtocolError, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';

const VERSION = '2.2.0';
const { values: opt } = parseArgs({
  options: { port: { type: 'string', default: '18001' }, host: { type: 'string', default: '127.0.0.1' }, path: { type: 'string', default: '/mcp' } },
});
const WIN = process.platform === 'win32';
const log = (...a) => console.error(new Date().toISOString(), '[server]', ...a);

const CALL_TIMEOUT_MS = 120_000;        // hard bound for any single tool call
const MAX_RESULT_CHARS = 4 * 1024 * 1024;
const MAX_SESSION_OUTPUT = 2 * 1024 * 1024;
const MAX_RUNNING = 32;                 // concurrently running start_process sessions
const EXITED_SESSION_TTL_MS = 10 * 60_000;

// ------------------------------------------------------------------- auth --
const TOKEN = process.env.MCPRELAY_BRIDGE_TOKEN || '';
delete process.env.MCPRELAY_BRIDGE_TOKEN; // never visible to spawned commands
const digest = (s) => createHash('sha256').update(s).digest();
const TOKEN_DIGEST = TOKEN ? digest(TOKEN) : null;
const authorized = (req) => {
  if (!TOKEN_DIGEST) return true;
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  return !!m && timingSafeEqual(digest(m[1]), TOKEN_DIGEST);
};

// ------------------------------------------------------------ path policy --
// File capabilities work only inside ALLOWED. This is a guardrail against
// mistakes, not a security boundary: exec capabilities run with the user's full
// rights. Two guard lists take precedence inside the roots:
//  * PROTECTED - secrets, never read or changed: MCPRelay's credentials and
//    config, SSH/GPG/cloud keys, OS and browser credential stores;
//  * READ_ONLY - integrity only, readable but never changed: system folders,
//    MCPRelay's program, logs and running code.
// Both are extended via MCPRELAY_PROTECTED_DIRS / MCPRELAY_READONLY_DIRS.
const norm = (p) => (WIN ? p.toLowerCase() : p);
const dirList = (v) => (v || '').split(WIN ? ';' : ':').filter(Boolean).map((d) => path.resolve(d));
const ALLOWED = dirList(process.env.MCPRELAY_ALLOWED_DIRS || homedir());
const E = process.env;
const inHome = (...p) => path.join(homedir(), ...p);
const PROTECTED = [...new Set([
  ...(WIN ? [
    E.APPDATA && path.join(E.APPDATA, 'MCPRelay'),
    E.APPDATA && path.join(E.APPDATA, 'Microsoft', 'Credentials'), E.APPDATA && path.join(E.APPDATA, 'Microsoft', 'Protect'),
    E.LOCALAPPDATA && path.join(E.LOCALAPPDATA, 'Microsoft', 'Credentials'),
    E.LOCALAPPDATA && path.join(E.LOCALAPPDATA, 'Google', 'Chrome', 'User Data'),
    E.LOCALAPPDATA && path.join(E.LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data'),
    E.APPDATA && path.join(E.APPDATA, 'Mozilla', 'Firefox', 'Profiles'),
  ] : []),
  ...['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker'].map((d) => inHome(d)),
].filter(Boolean).map((d) => path.resolve(d)).concat(dirList(E.MCPRELAY_PROTECTED_DIRS)))];
const READ_ONLY = [...new Set([
  ...(WIN
    ? [E.SystemRoot || 'C:\\Windows', E.ProgramFiles, E['ProgramFiles(x86)'], E.ProgramW6432, E.ProgramData,
        E.LOCALAPPDATA && path.join(E.LOCALAPPDATA, 'MCPRelay'), E.LOCALAPPDATA && path.join(E.LOCALAPPDATA, 'Programs', 'MCPRelay')]
    : ['/bin', '/boot', '/dev', '/etc', '/lib', '/lib32', '/lib64', '/opt', '/proc', '/sbin', '/snap', '/sys', '/usr', '/var']),
  path.dirname(fileURLToPath(import.meta.url)),                         // this server's own code
  E.MCPRELAY_AUDIT_LOG && path.dirname(path.resolve(E.MCPRELAY_AUDIT_LOG)),
].filter(Boolean).map((d) => path.resolve(d)).concat(dirList(E.MCPRELAY_READONLY_DIRS)))];
// Per-drive system entries on Windows (any drive letter): read-only.
const SYS_RE = /^[a-z]:\\(\$recycle\.bin|system volume information|recovery|config\.msi)(\\|$)|^[a-z]:\\(pagefile|hiberfil|swapfile)\.sys$/;
const under = (x, root) => { const r = norm(root); return x === r || x.startsWith(r.endsWith(path.sep) ? r : r + path.sep); };
function guardOf(real) { // 'protected' | 'read-only' | null
  const x = norm(real);
  if (PROTECTED.some((d) => under(x, d))) return 'protected';
  if (READ_ONLY.some((d) => under(x, d)) || (WIN && SYS_RE.test(x))) return 'read-only';
  return null;
}
// True if a guarded location lies inside `real` (deleting/moving it would take the guarded one along).
const holdsGuarded = (real) => [...PROTECTED, ...READ_ONLY].some((d) => under(norm(d), real));
function assertGuard(real, p, mode) {
  const g = guardOf(real);
  if (g === 'protected') fail('protected_path', `Protected path: ${p}. Credential and MCPRelay configuration folders are off-limits to file capabilities.`);
  if (g === 'read-only' && mode === 'write') fail('read_only_path', `Read-only path: ${p}. File capabilities do not change system folders or MCPRelay's program and logs.`);
}
async function realish(p) {
  // realpath of the longest existing prefix, so symlinks/junctions cannot escape the roots
  let cur = path.resolve(p); const rest = [];
  for (;;) {
    try { return path.join(await fs.realpath(cur), ...rest.reverse()); }
    catch { const parent = path.dirname(cur); if (parent === cur) return path.resolve(p); rest.push(path.basename(cur)); cur = parent; }
  }
}
async function allowedPath(p, mode = 'read') {
  if (typeof p !== 'string' || !p) fail('invalid_args', 'path is required');
  const real = await realish(p);
  const x = norm(real);
  if (!ALLOWED.some((root) => under(x, root))) fail('path_not_allowed', `Path not allowed: ${p}. Must be within one of these directories: ${ALLOWED.join(', ')}`);
  assertGuard(real, p, mode);
  return real;
}

// ---------------------------------------------------------------- helpers --
const text = (t, isError = false) => {
  const s = t.length > MAX_RESULT_CHARS ? `${t.slice(0, MAX_RESULT_CHARS)}\n[truncated: result exceeded ${MAX_RESULT_CHARS} characters]` : t;
  return { content: [{ type: 'text', text: s }], ...(isError ? { isError: true } : {}) };
};

// Stable error codes for agents. Every failed call returns
// "Error [<code>]: <message> (next: <action>)" plus _meta["io.mcprelay/error"],
// and the audit log records the same code. action tells the caller what to do:
// fix_args = change the arguments and retry; ask_user = stop and ask the user;
// retry_later = transient; stop = unexpected server-side failure.
const ERRORS = {
  invalid_args: 'fix_args', unknown_capability: 'fix_args', wrong_class: 'fix_args', path_not_allowed: 'fix_args',
  not_found: 'fix_args', already_exists: 'fix_args', not_empty: 'fix_args', is_a_directory: 'fix_args', not_a_directory: 'fix_args',
  too_large: 'fix_args', binary_file: 'fix_args', no_match: 'fix_args', spawn_failed: 'fix_args',
  bad_handle: 'fix_args', process_exited: 'fix_args',
  protected_path: 'ask_user', read_only_path: 'ask_user', permission_denied: 'ask_user',
  timeout: 'retry_later', busy: 'retry_later',
  internal_error: 'stop',
};
const NEXT = { fix_args: 'fix the arguments and retry', ask_user: 'stop and ask the user', retry_later: 'retry later', stop: 'stop; report the error' };
class CapError extends Error { constructor(code, message) { super(message); this.code = code; } }
const fail = (code, message) => { throw new CapError(code, message); };
const ERRNO = { ENOENT: 'not_found', EEXIST: 'already_exists', ENOTEMPTY: 'not_empty', EISDIR: 'is_a_directory', ENOTDIR: 'not_a_directory',
  EACCES: 'permission_denied', EPERM: 'permission_denied', EBUSY: 'busy', EMFILE: 'busy' };
function errorResult(code, message) {
  const action = ERRORS[code] || 'stop';
  return { ...text(`Error [${code}]: ${message} (next: ${NEXT[action]})`, true), _meta: { 'io.mcprelay/error': { code, action } } };
}
const codeOf = (e) => (e instanceof CapError ? e.code : e instanceof ProtocolError ? 'invalid_args' : ERRNO[e?.code] || 'internal_error');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Bounds a call. On timeout the AbortController is aborted, so long-running
// capabilities (search, listing, hashing) actually stop instead of running on.
const withTimeout = (promise, ms, what, ac) => {
  let timer;
  return Promise.race([promise, new Promise((_, rej) => { timer = setTimeout(() => { ac?.abort(); rej(new CapError('timeout', `${what} timed out after ${ms / 1000}s`)); }, ms); })])
    .finally(() => clearTimeout(timer));
};

// Walk budgets: stop early with partial results (well inside CALL_TIMEOUT_MS)
// instead of timing out, and stop at once when the call is aborted.
const LIST_BUDGET_MS = 30_000;
const SEARCH_BUDGET_MS = Number(process.env.MCPRELAY_SEARCH_BUDGET_MS) || 60_000; // env override for tests
const SEARCH_MAX_ENTRIES = 200_000;

async function listDir(dir, depth, prefix = '', out = [], lim = { deadline: Date.now() + LIST_BUDGET_MS, signal: null }) {
  if (lim.signal?.aborted) return out;
  if (Date.now() > lim.deadline) { if (!lim.stopped) { lim.stopped = true; out.push(`[WARNING] listing stopped after ${LIST_BUDGET_MS / 1000} s; use a smaller depth or a subfolder`); } return out; }
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (e) { out.push(`[DENIED] ${prefix}(${e.code})`); return out; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (out.length >= 5000) { out.push('[WARNING] listing truncated at 5000 entries'); return out; }
    if (lim.stopped || lim.signal?.aborted) return out;
    const rel = prefix + e.name;
    if (e.isDirectory()) {
      const full = path.join(dir, e.name);
      if (guardOf(full) === 'protected') { out.push(`[DIR] ${rel} (protected, not listed)`); continue; }
      out.push(`[DIR] ${rel}`);
      if (depth > 1) await listDir(full, depth - 1, rel + path.sep, out, lim);
    } else out.push(`[FILE] ${rel}`);
  }
  return out;
}

async function searchFiles(root, namePattern, contentText, max, signal) {
  // File names: glob (* and ?). Content: case-insensitive literal text, never a
  // user regex (a pathological pattern could block the event loop).
  // Cooperative limits: checked before every directory and every file read.
  const nameRe = namePattern ? new RegExp(`^${String(namePattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i') : null;
  const needle = contentText ? String(contentText).toLowerCase() : null;
  const hits = []; const stack = [root]; let visited = 0; let stopped = null;
  const deadline = Date.now() + SEARCH_BUDGET_MS;
  const over = () => {
    if (signal?.aborted) stopped = 'aborted';
    else if (Date.now() > deadline) stopped = `time budget (${SEARCH_BUDGET_MS / 1000} s)`;
    else if (visited >= SEARCH_MAX_ENTRIES) stopped = `entry limit (${SEARCH_MAX_ENTRIES})`;
    return stopped;
  };
  while (stack.length && hits.length < max && !over()) {
    const dir = stack.pop();
    let entries; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      visited++;
      if (over()) break;
      if (e.isSymbolicLink()) continue; // links/junctions could lead outside the allowed roots
      const full = path.join(dir, e.name);
      if (guardOf(full) === 'protected') continue; // never search credential stores
      if (e.isDirectory()) { if (!['node_modules', '.git'].includes(e.name)) stack.push(full); continue; }
      if (nameRe && !nameRe.test(e.name)) continue;
      if (!needle) hits.push(full);
      else {
        try {
          const st = await fs.stat(full); if (st.size > 5 * 1024 * 1024) continue;
          const lines = (await fs.readFile(full, 'utf8')).split(/\r?\n/);
          for (let i = 0; i < lines.length && hits.length < max; i++) if (lines[i].toLowerCase().includes(needle)) hits.push(`${full}:${i + 1}: ${lines[i].slice(0, 200)}`);
        } catch { /* unreadable file */ }
      }
      if (hits.length >= max) break;
    }
  }
  return { hits, visited, stopped: stopped === 'aborted' ? null : stopped };
}

// -------------------------------------------------------------- processes --
const sessions = new Map(); // pid -> { child, out, readPos, exitCode, shell, started, handle }
// Opaque per-process handles: read/input/terminate need the handle returned by
// start_process, so one agent cannot act on another agent's process by PID.
// Handles work across connections; list_sessions never shows them.
const handles = new Map(); // handle -> pid
function sessionOf(handle, { active = false } = {}) {
  const pid = typeof handle === 'string' ? handles.get(handle) : undefined;
  const s = pid === undefined ? undefined : sessions.get(pid);
  if (!s) fail('bad_handle', 'Unknown or expired process handle. Use the handle returned by start_process (exited sessions expire after 10 min); list_sessions shows PIDs only.');
  if (active && s.exitCode !== null) fail('process_exited', `Process ${pid} already exited with code ${s.exitCode}.`);
  return [pid, s];
}
const running = () => [...sessions.values()].filter((s) => s.exitCode === null).length;
function shellInvocation(command, shell) {
  if (WIN) {
    const sh = shell || SHELLS.default;
    if (/cmd(\.exe)?$/i.test(sh)) return [sh, ['/d', '/s', '/c', `chcp 65001>nul & ${command}`]];
    // UTF-8 output regardless of the console code page (e.g. GBK on Chinese Windows).
    const prefix = '[Console]::OutputEncoding=[Text.Encoding]::UTF8;$OutputEncoding=[Text.Encoding]::UTF8;';
    return [sh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', prefix + command]];
  }
  return [shell || SHELLS.default, ['-c', command]];
}
function killTree(pid) {
  return new Promise((resolve) => {
    if (WIN) execFile('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true }, () => resolve());
    else { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } resolve(); }
  });
}
async function waitQuiet(s, timeoutMs, { returnOnQuiet = true } = {}) {
  // Return on exit, after output has gone quiet (e.g. a prompt), or at timeout.
  const start = Date.now(); let seen = s.out.length; let changed = false; let quietSince = Date.now();
  while (Date.now() - start < timeoutMs && s.exitCode === null) {
    await sleep(50);
    if (s.out.length !== seen) { seen = s.out.length; changed = true; quietSince = Date.now(); }
    else if (returnOnQuiet && changed && Date.now() - quietSince >= 400) break;
  }
}
function takeOutput(s) { const chunk = s.out.slice(s.readPos); s.readPos = s.out.length; return chunk; }

async function startProcess({ command, timeout_ms: timeoutMs = 10_000, shell }) {
  if (typeof command !== 'string' || !command) fail('invalid_args', 'command is required');
  if (running() >= MAX_RUNNING) fail('busy', `Too many running processes (${MAX_RUNNING}); terminate some with force_terminate first.`);
  const [file, args] = shellInvocation(command, shell);
  const child = spawn(file, args, { cwd: homedir(), env: process.env, windowsHide: true, detached: !WIN, stdio: ['pipe', 'pipe', 'pipe'] });
  const s = { child, out: '', readPos: 0, exitCode: null, shell: path.basename(file), started: Date.now(), handle: `p_${randomBytes(9).toString('base64url')}` };
  const append = (d) => {
    s.out += d.toString('utf8');
    if (s.out.length > MAX_SESSION_OUTPUT) { const cut = s.out.length - MAX_SESSION_OUTPUT; s.out = s.out.slice(cut); s.readPos = Math.max(0, s.readPos - cut); }
  };
  child.stdout.on('data', append); child.stderr.on('data', append);
  child.stdin.on('error', () => {}); // writing to a process that already exited must not crash the server
  child.on('exit', (code) => { s.exitCode = code ?? -1; setTimeout(() => { sessions.delete(child.pid); handles.delete(s.handle); }, EXITED_SESSION_TTL_MS).unref(); });
  const spawnError = await new Promise((r) => { child.once('spawn', () => r(null)); child.once('error', r); });
  if (spawnError || !child.pid) fail('spawn_failed', `Failed to start (${spawnError?.message || 'unknown error'}); check args.shell`);
  sessions.set(child.pid, s); handles.set(s.handle, child.pid);
  await waitQuiet(s, Math.min(Math.max(timeoutMs, 0), CALL_TIMEOUT_MS - 5000));
  const status = s.exitCode === null ? `\nProcess still running; use read_process_output with handle ${s.handle} to get more.` : `\nProcess finished with exit code ${s.exitCode}.`;
  return { ...text(`Process started with PID ${child.pid}, handle ${s.handle} (shell: ${s.shell})\nInitial output:\n${takeOutput(s)}${status}`), auditPid: child.pid };
}

// --------------------------------------------------- remove / hash / procs --
const STARTED_AT = Date.now();
const insideRoot = (x) => ALLOWED.some((root) => { const r = norm(root); return x.startsWith(r.endsWith(path.sep) ? r : r + path.sep); });

async function removePath(p, recursive) {
  if (typeof p !== 'string' || !p) fail('invalid_args', 'path is required');
  // Resolve the PARENT (so links inside the path are resolved) but act on the entry itself:
  // removing a symlink/junction removes only the link, never its target.
  const abs = path.resolve(p);
  const target = path.join(await allowedPath(path.dirname(abs)), path.basename(abs));
  const x = norm(target);
  if (!insideRoot(x)) fail('path_not_allowed', `Path not allowed: ${p}. Must be strictly inside one of: ${ALLOWED.join(', ')}`);
  if (ALLOWED.some((root) => { const r = norm(root); return r === x || r.startsWith(x + path.sep); })) {
    fail('path_not_allowed', `Refusing to remove an allowed root (or a directory containing one): ${p}`);
  }
  assertGuard(target, p, 'write');
  if (holdsGuarded(x)) fail('read_only_path', `Refusing to remove ${p}: it contains a protected or read-only folder.`);
  let st;
  try { st = await fs.lstat(target); } catch (e) { if (e.code === 'ENOENT') fail('not_found', `Not found: ${p}`); throw e; }
  if (st.isSymbolicLink()) {
    try { await fs.unlink(target); } catch (e) { if (WIN && ['EPERM', 'EISDIR'].includes(e.code)) await fs.rmdir(target); else throw e; }
    return text(`Removed link ${p} (its target was not touched)`);
  }
  if (st.isDirectory()) {
    if (!recursive) {
      try { await fs.rmdir(target); } catch (e) { if (['ENOTEMPTY', 'EEXIST'].includes(e.code)) fail('not_empty', `Directory not empty: ${p}. Pass recursive=true to remove it with its contents.`); throw e; }
      return text(`Removed empty directory ${p}`);
    }
    await fs.rm(target, { recursive: true, force: false }); // lstat-based: links inside are unlinked, not followed
    return text(`Removed directory ${p} and its contents`);
  }
  await fs.unlink(target);
  return text(`Removed file ${p}`);
}

function sha256File(p, signal) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const rs = createReadStream(p).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
    signal?.addEventListener('abort', () => rs.destroy(), { once: true }); // stop reading on call timeout
  });
}

// System-wide read-only process listing. Command lines are deliberately not
// returned: other programs' arguments can contain passwords or tokens.
async function listProcesses({ name, pid, limit = 50 }) {
  const max = Math.min(Math.max(1, Number(limit) || 50), 500);
  if (pid !== undefined && !Number.isInteger(pid)) fail('invalid_args', 'pid must be an integer');
  if (name !== undefined && !/^[\w .+-]{1,100}$/.test(String(name))) fail('invalid_args', 'name may contain only letters, digits, space, . _ + -');
  if (WIN) {
    const filter = pid !== undefined ? `-Filter "ProcessId=${pid}"` : name ? `-Filter "Name LIKE '%${name}%'"` : '';
    const script = `$ErrorActionPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8;` +
      `@(Get-CimInstance Win32_Process ${filter} | Sort-Object WorkingSetSize -Descending | Select-Object -First ${max} | ForEach-Object { [pscustomobject]@{` +
      `pid=$_.ProcessId;parent_pid=$_.ParentProcessId;name=$_.Name;path=$_.ExecutablePath;` +
      `start_time=$(if($_.CreationDate){$_.CreationDate.ToString('o')});cpu_time=[math]::Round(($_.UserModeTime+$_.KernelModeTime)/1e7,2);rss=[int64]$_.WorkingSetSize} }) | ConvertTo-Json -Compress -Depth 2`;
    const out = await new Promise((resolve, reject) => execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }, (e, stdout) => (e ? reject(e) : resolve(stdout))));
    const parsed = out.trim() ? JSON.parse(out) : [];
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  const hz = 100; const page = 4096;
  const btime = Number(((await fs.readFile('/proc/stat', 'utf8')).match(/^btime (\d+)/m) || [])[1] || 0);
  const pids = pid !== undefined ? [String(pid)] : (await fs.readdir('/proc')).filter((d) => /^\d+$/.test(d));
  const rows = [];
  for (const p of pids) {
    try {
      const stat = await fs.readFile(`/proc/${p}/stat`, 'utf8');
      const comm = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      let exe = null; try { exe = await fs.readlink(`/proc/${p}/exe`); } catch { /* other user's process */ }
      // comm can be a thread name (Node.js reports "MainThread"); prefer the executable's name.
      const display = exe ? path.basename(exe) : comm;
      const want = name ? String(name).toLowerCase() : null;
      if (want && !display.toLowerCase().includes(want) && !comm.toLowerCase().includes(want)) continue;
      const rss = Number((await fs.readFile(`/proc/${p}/statm`, 'utf8')).split(' ')[1]) * page;
      rows.push({ pid: Number(p), parent_pid: Number(f[1]), name: display, path: exe,
        start_time: new Date((btime + Number(f[19]) / hz) * 1000).toISOString(), cpu_time: (Number(f[11]) + Number(f[12])) / hz, rss });
    } catch { /* process exited meanwhile */ }
  }
  return rows.sort((a, b) => b.rss - a.rss).slice(0, max);
}

// ------------------------------------------------------------ audit log --
// One JSON line per tool call: time, boot/call ids, capability, class, ok,
// duration, the PID for process operations, and the error code.
// Never arguments or results (they can contain secrets or file contents).
// Size-bounded: rotates at AUDIT_MAX bytes and keeps one old file (<= 2 x AUDIT_MAX).
const AUDIT = process.env.MCPRELAY_AUDIT_LOG || '';
const AUDIT_MAX = Number(process.env.MCPRELAY_AUDIT_MAX_BYTES) || 1024 * 1024;
let auditSize = -1; let auditChain = Promise.resolve();
function audit(entry) {
  if (!AUDIT) return;
  const line = `${JSON.stringify(entry)}\n`;
  auditChain = auditChain.then(async () => {
    try {
      if (auditSize < 0) {
        await fs.mkdir(path.dirname(AUDIT), { recursive: true });
        auditSize = await fs.stat(AUDIT).then((s) => s.size, () => 0);
      }
      if (auditSize + line.length > AUDIT_MAX) {
        await fs.rm(`${AUDIT}.1`, { force: true });
        await fs.rename(AUDIT, `${AUDIT}.1`).catch(() => {});
        auditSize = 0;
      }
      await fs.appendFile(AUDIT, line, 'utf8');
      auditSize += Buffer.byteLength(line);
    } catch { /* auditing must never break a call */ }
  });
}

// --------------------------------------------- client-facing environment --
const NODE_NAME = process.env.MCPRELAY_NODE_NAME || hostname();
const OS_DESC = WIN ? `Windows ${Number(release().split('.')[2] || 0) >= 22000 ? '11' : '10'} ${arch()}` : `${process.platform} ${release()} ${arch()}`;

// Shells, detected once at startup. On Windows the default is PowerShell 7
// (pwsh) when installed, else Windows PowerShell 5.1.
const SHELLS = { default: WIN ? 'powershell.exe' : (process.env.SHELL || '/bin/sh'), available: [] };
async function detectShells() {
  if (!WIN) { SHELLS.available = [{ shell: SHELLS.default, note: 'POSIX shell' }]; return; }
  const psVersion = (exe) => new Promise((resolve) => execFile(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'],
    { windowsHide: true, timeout: 20_000 }, (e, out) => resolve(e ? null : String(out).trim() || null)));
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  let pwsh = null;
  for (const exe of ['pwsh.exe', path.join(pf, 'PowerShell', '7', 'pwsh.exe')]) {
    const v = await psVersion(exe); if (v) { pwsh = { shell: exe === 'pwsh.exe' ? 'pwsh.exe' : exe, note: `PowerShell ${v}` }; break; }
  }
  const v5 = await psVersion('powershell.exe');
  SHELLS.available = [pwsh, v5 && { shell: 'powershell.exe', note: `Windows PowerShell ${v5}` }, { shell: 'cmd.exe', note: 'Command Prompt' }].filter(Boolean);
  SHELLS.default = (pwsh || { shell: 'powershell.exe' }).shell;
}
const shellLabel = () => SHELLS.available.find((s) => s.shell === SHELLS.default)?.note || SHELLS.default;
const envNote = (kind) => kind === 'exec'
  ? ` [Node "${NODE_NAME}", ${OS_DESC}. Default shell: ${shellLabel()}${WIN ? ', UTF-8 output' : ''}; other shells via args.shell: ${SHELLS.available.filter((s) => s.shell !== SHELLS.default).map((s) => `${s.shell} (${s.note})`).join(', ') || 'none'}. Working directory: ${homedir()}. Commands run with the user's full rights and are NOT limited to the file roots]`
  : ` [Node "${NODE_NAME}", ${OS_DESC}. File capabilities only work inside: ${ALLOWED.join('; ')}; system folders are read-only and credential/MCPRelay config folders are off-limits (see list_capabilities)]`;

// ------------------------------------------------------------------- tools --
const P = (props, required = []) => ({ type: 'object', properties: props, required });
const str = { type: 'string' }; const num = { type: 'number' };
const TOOLS = {
  node_status: { d: 'Status of this MCPRelay node runtime: version, PID, uptime, host, OS, allowed file roots and process-session counts. Contains no credentials.', s: P({}),
    run: async () => text(JSON.stringify({
      server_version: VERSION, node_name: NODE_NAME, boot_id: BOOT_ID, pid: process.pid, uptime_seconds: Math.round((Date.now() - STARTED_AT) / 1000),
      hostname: hostname(), os: `${process.platform} ${release()}`, arch: arch(), node_version: process.version,
      allowed_dirs: ALLOWED, default_shell: SHELLS.default, shells: SHELLS.available,
      sessions: sessions.size, running_sessions: running(), audit_log: AUDIT || null, audit_max_bytes: AUDIT ? AUDIT_MAX : null,
    }, null, 2)) },
  list_directory: { d: 'List files and directories ([DIR]/[FILE]) up to `depth` levels (default 2).', s: P({ path: str, depth: num }, ['path']),
    run: async (a, signal) => text((await listDir(await allowedPath(a.path), Math.min(a.depth ?? 2, 10), '', [], { deadline: Date.now() + LIST_BUDGET_MS, signal })).join('\n') || '(empty directory)') },
  read_file: { d: 'Read a UTF-8 text file by lines. offset >= 0: first line (0-based); offset < 0: the last |offset| lines (tail, e.g. -50 for logs). length: max lines (default 1000).', s: P({ path: str, offset: num, length: num }, ['path']),
    run: async (a) => {
      const p = await allowedPath(a.path); const st = await fs.stat(p);
      if (st.isDirectory()) fail('is_a_directory', `${a.path} is a directory; use list_directory`);
      if (st.size > 64 * 1024 * 1024) fail('too_large', `File too large to read (${st.size} bytes)`);
      const buf = await fs.readFile(p);
      if (buf.subarray(0, 8000).includes(0)) fail('binary_file', `Binary file (${buf.length} bytes) not shown: ${a.path}`);
      const lines = buf.toString('utf8').split(/\r?\n/);
      const len = Math.max(1, a.length ?? 1000);
      if ((a.offset ?? 0) < 0) {
        const body = lines.length && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines; // ignore the final newline
        const n = Math.min(Math.abs(a.offset), len, body.length); const from = body.length - n;
        return text(`[Reading last ${n} lines (lines ${from}-${body.length - 1} of ${body.length})]\n\n${body.slice(from).join('\n')}`);
      }
      const off = a.offset ?? 0; const part = lines.slice(off, off + len);
      return text(`[Reading ${part.length} lines from line ${off} (total: ${lines.length} lines, ${Math.max(0, lines.length - off - part.length)} remaining)]\n\n${part.join('\n')}`);
    } },
  write_file: { d: 'Write (mode=rewrite, default) or append (mode=append) UTF-8 text to a file; creates parent directories.', s: P({ path: str, content: str, mode: { type: 'string', enum: ['rewrite', 'append'] } }, ['path', 'content']),
    run: async (a) => {
      if (typeof a.content !== 'string') fail('invalid_args', 'content must be a string');
      const p = await allowedPath(a.path, 'write'); await fs.mkdir(path.dirname(p), { recursive: true });
      if (a.mode === 'append') await fs.appendFile(p, a.content, 'utf8');
      else { const tmp = `${p}.mcprelay-${process.pid}.tmp`; await fs.writeFile(tmp, a.content, 'utf8'); await fs.rename(tmp, p); } // atomic replace
      return text(`Wrote ${Buffer.byteLength(a.content)} bytes to ${a.path} (${a.mode || 'rewrite'})`);
    } },
  edit_block: { d: 'Replace exact text in a file. expected_replacements (default 1) must equal the number of occurrences.', s: P({ file_path: str, old_string: str, new_string: str, expected_replacements: num }, ['file_path', 'old_string', 'new_string']),
    run: async (a) => {
      const p = await allowedPath(a.file_path, 'write'); const src = await fs.readFile(p, 'utf8');
      const n = a.old_string ? src.split(a.old_string).length - 1 : 0; const want = a.expected_replacements ?? 1;
      if (!a.old_string || n !== want) fail('no_match', `Found ${n} occurrence(s) of old_string, expected ${want}; no changes made.`);
      const tmp = `${p}.mcprelay-${process.pid}.tmp`; await fs.writeFile(tmp, src.split(a.old_string).join(a.new_string), 'utf8'); await fs.rename(tmp, p);
      return text(`Replaced ${n} occurrence(s) in ${a.file_path}`);
    } },
  create_directory: { d: 'Create a directory (and parents).', s: P({ path: str }, ['path']),
    run: async (a) => { await fs.mkdir(await allowedPath(a.path, 'write'), { recursive: true }); return text(`Directory ready: ${a.path}`); } },
  move_file: { d: 'Move or rename a file or directory.', s: P({ source: str, destination: str }, ['source', 'destination']),
    run: async (a) => {
      const src = await allowedPath(a.source, 'write');
      if (holdsGuarded(norm(src))) fail('read_only_path', `Refusing to move ${a.source}: it contains a protected or read-only folder.`);
      await fs.rename(src, await allowedPath(a.destination, 'write')); return text(`Moved ${a.source} -> ${a.destination}`); } },
  remove_path: { d: 'Delete a file, an empty directory, or (recursive=true) a directory with its contents. Only inside the allowed roots; never an allowed root itself. Links are removed without touching their targets.', s: P({ path: str, recursive: { type: 'boolean' } }, ['path']),
    run: async (a) => removePath(a.path, a.recursive === true) },
  get_file_info: { d: 'File or directory metadata; sha256=true adds the file\'s SHA-256.', s: P({ path: str, sha256: { type: 'boolean' } }, ['path']),
    run: async (a, signal) => { const p = await allowedPath(a.path); const st = await fs.stat(p);
      const info = { size: st.size, type: st.isDirectory() ? 'directory' : 'file', modified: st.mtime, created: st.birthtime };
      if (a.sha256 === true && !st.isDirectory()) info.sha256 = await sha256File(p, signal);
      return text(JSON.stringify(info, null, 2)); } },
  search_files: { d: 'Search files under path by file-name glob (pattern, e.g. *.ts) and/or case-insensitive text (content_pattern). Symbolic links, node_modules and .git are skipped. Stops after 60 s or 200000 entries and then returns partial results marked [partial: ...].', s: P({ path: str, pattern: str, content_pattern: str, max_results: num }, ['path']),
    run: async (a, signal) => {
      const { hits, visited, stopped } = await searchFiles(await allowedPath(a.path), a.pattern, a.content_pattern, Math.min(a.max_results ?? 100, 1000), signal);
      const note = stopped ? `\n[partial: search stopped at the ${stopped} after ${visited} entries; narrow path or pattern for complete results]` : '';
      return text((hits.join('\n') || 'No matches.') + note); } },
  start_process: { d: 'Run a shell command in the default shell (see the environment; on Windows PowerShell 7 when installed) or in args.shell (e.g. "powershell.exe" for Windows PowerShell 5.1, "cmd.exe"). Returns when the command exits, its output goes quiet, or after timeout_ms; long-running processes keep running; the result gives a PID and a handle, and read_process_output / interact_with_process / force_terminate need that handle.', s: P({ command: str, timeout_ms: num, shell: str }, ['command', 'timeout_ms']),
    run: startProcess },
  read_process_output: { d: 'Read new output of a process started with start_process, identified by the handle start_process returned (waits up to timeout_ms for new output).', s: P({ handle: str, timeout_ms: num }, ['handle']),
    run: async (a) => { const [pid, s] = sessionOf(a.handle);
      await waitQuiet(s, Math.min(a.timeout_ms ?? 5000, 60_000)); const out = takeOutput(s);
      return { ...text(`${out || '(no new output)'}${s.exitCode === null ? '' : `\nProcess finished with exit code ${s.exitCode}.`}`), auditPid: pid }; } },
  interact_with_process: { d: 'Send a line of input to a running process (identified by its start_process handle) and return the output it produces.', s: P({ handle: str, input: str, timeout_ms: num }, ['handle', 'input']),
    run: async (a) => { const [pid, s] = sessionOf(a.handle, { active: true });
      takeOutput(s); s.child.stdin.write(String(a.input).endsWith('\n') ? String(a.input) : `${a.input}\n`);
      await waitQuiet(s, Math.min(a.timeout_ms ?? 8000, 60_000)); return { ...text(takeOutput(s) || '(no output)'), auditPid: pid }; } },
  force_terminate: { d: 'Terminate a process started with start_process (identified by its handle), including its child processes.', s: P({ handle: str }, ['handle']),
    run: async (a) => { const [pid] = sessionOf(a.handle, { active: true });
      await killTree(pid); return { ...text(`Terminated process ${pid}`), auditPid: pid }; } },
  list_sessions: { d: 'List processes started with start_process (PID, state, shell, runtime). Handles are not shown: only the caller that started a process holds its handle.', s: P({}),
    run: async () => text([...sessions.entries()].map(([pid, s]) => `PID: ${pid}, ${s.exitCode === null ? 'running' : `exited (${s.exitCode})`}, shell: ${s.shell}, runtime: ${Math.round((Date.now() - s.started) / 1000)}s`).join('\n') || 'No sessions.') },
  list_processes: { d: 'List system processes (read-only), largest memory first: pid, parent_pid, name, path, start_time, cpu_time (s), rss (bytes). Filter by name (substring) or pid; limit (default 50, max 500). Command lines are not returned.', s: P({ name: str, pid: num, limit: num }),
    run: async (a) => { const rows = await listProcesses(a); return text(rows.length ? JSON.stringify(rows, null, 1) : 'No matching processes.'); } },
};
// ---------------------------------------------------------- risk classes --
// Clients (ChatGPT) cache a connector's tool list, so the exposed tools are a
// small fixed set: list_capabilities plus one invoke_<class> tool per risk
// class. Capabilities can change without a client-side refresh; each class
// tool carries the MCP ToolAnnotations of its class, so clients still ask the
// user before destructive or open-world actions. The server enforces classes:
// a capability is only run through its own class tool.
const CLASSES = {
  read: { title: 'Read (no changes)', covers: 'reads files, directories, file info, process output, command sessions, system processes and node status; never changes anything',
    hints: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  write: { title: 'Create (non-destructive)', covers: 'creates things without overwriting, changing or deleting existing data',
    hints: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  destructive: { title: 'Modify or delete files, stop processes', covers: 'writes, overwrites, edits, moves or deletes files and folders, or terminates processes',
    hints: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } },
  exec: { title: 'Run shell commands', covers: "runs shell commands or sends input to running processes, with the user's full rights",
    hints: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } },
};
const META = {
  //                     title                      class
  node_status:           ['Node status',            'read'],
  list_directory:        ['List directory',         'read'],
  read_file:             ['Read file',              'read'],
  get_file_info:         ['File info / SHA-256',    'read'],
  search_files:          ['Search files',           'read'],
  read_process_output:   ['Read process output',    'read'],
  list_sessions:         ['List command sessions',  'read'],
  list_processes:        ['List system processes',  'read'],
  create_directory:      ['Create directory',       'write'],
  write_file:            ['Write file',             'destructive'],
  edit_block:            ['Edit file',              'destructive'],
  move_file:             ['Move or rename',         'destructive'],
  remove_path:           ['Delete file or folder',  'destructive'],
  force_terminate:       ['Terminate process',      'destructive'],
  start_process:         ['Run command',            'exec'],
  interact_with_process: ['Send input to process',  'exec'],
};
const invokeTool = (cls) => `invoke_${cls}`;
const namesOf = (cls) => Object.keys(TOOLS).filter((n) => META[n][1] === cls);

const allCaps = () => Object.entries(TOOLS).map(([name, t]) => ({
  name, class: META[name][1], invoke_with: invokeTool(META[name][1]), title: META[name][0], description: t.d, args_schema: t.s,
}));
function catalog(onlyClass) {
  const all = allCaps();
  return {
    node: NODE_NAME, server_version: VERSION,
    // Hash of the complete catalog (capabilities, classes, schemas), the same
    // for every filtered view; clients may cache the catalog until it changes.
    catalog_version: createHash('sha256').update(JSON.stringify(all)).digest('hex').slice(0, 12),
    view: onlyClass || 'all',
    environment: { os: OS_DESC, file_roots: ALLOWED, protected_paths: PROTECTED, read_only_paths: READ_ONLY.concat(WIN ? ['<drive>:\\$Recycle.Bin, System Volume Information, Recovery, Config.Msi, *.sys page/hibernate files'] : []),
      default_shell: shellLabel(), shells: SHELLS.available, working_directory: homedir(),
      notes: ['File capabilities only work inside file_roots, never touch protected_paths, and only read read_only_paths. This is a guardrail against mistakes, not a security boundary.',
        "Shell commands run with the user's full rights and are not limited by these lists."] },
    usage: 'Call the tool named in invoke_with (a gateway may prefix it, e.g. "<node>_invoke_read") with {"capability": name, "args": {...}}, args following args_schema. This list is current; tool descriptions cached by a client may be older.',
    classes: Object.fromEntries(Object.entries(CLASSES).map(([c, v]) => [c, { invoke_with: invokeTool(c), covers: v.covers }])),
    errors: { format: 'Error [<code>]: <message> (next: <action>); also in result _meta["io.mcprelay/error"] = {code, action}',
      actions: { fix_args: NEXT.fix_args, ask_user: NEXT.ask_user, retry_later: NEXT.retry_later, stop: NEXT.stop }, codes: ERRORS },
    capabilities: onlyClass ? all.filter((c) => c.class === onlyClass) : all,
  };
}

// Validates and lightly coerces arguments against the capability's flat
// schema ("5" -> 5, "true" -> true). Errors name the problem and the schema so
// the caller can correct itself.
function checkArgs(schema, input) {
  let a = input ?? {};
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { return { error: 'args must be a JSON object' }; } }
  if (a === null || typeof a !== 'object' || Array.isArray(a)) return { error: 'args must be a JSON object' };
  const props = schema.properties || {}; const out = {};
  for (const [k, v] of Object.entries(a)) {
    const p = props[k];
    if (!p) return { error: `unknown argument "${k}"` };
    let x = v;
    if (p.type === 'number' && typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x))) x = Number(x);
    if (p.type === 'boolean' && (x === 'true' || x === 'false')) x = x === 'true';
    const ok = p.type === 'number' ? typeof x === 'number' && Number.isFinite(x) : typeof x === p.type;
    if (!ok) return { error: `argument "${k}" must be a ${p.type}` };
    if (p.enum && !p.enum.includes(x)) return { error: `argument "${k}" must be one of: ${p.enum.join(', ')}` };
    out[k] = x;
  }
  for (const k of schema.required || []) if (out[k] === undefined) return { error: `missing required argument "${k}"` };
  return { args: out };
}

const EXPOSED = () => [
  { name: 'list_capabilities', title: 'List capabilities',
    description: `List everything this node can do right now: each capability with its risk class, the invoke_* tool to use, a description and its argument schema, plus the node environment (OS, file roots, shells). Call it once at the start of a conversation and whenever a capability is reported unknown. Optional: class (${Object.keys(CLASSES).join(', ')}).${envNote('file')}`,
    inputSchema: P({ class: { type: 'string', enum: Object.keys(CLASSES) } }),
    annotations: { title: 'List capabilities', ...CLASSES.read.hints } },
  ...Object.entries(CLASSES).map(([cls, c]) => ({
    name: invokeTool(cls), title: c.title,
    description: `Run one "${cls}" capability of this node: ${c.covers}. capability = a name from list_capabilities whose class is "${cls}" (currently: ${namesOf(cls).join(', ')}); args = that capability's arguments as a JSON object. Capabilities of another class are refused.${envNote(cls === 'exec' ? 'exec' : 'file')}`,
    inputSchema: P({ capability: { type: 'string', description: `Capability name (class "${cls}")` },
      args: { type: 'object', description: 'Arguments for the capability, per its args_schema in list_capabilities', additionalProperties: true } }, ['capability']),
    annotations: { title: c.title, ...c.hints },
  })),
];

async function invoke(cls, params, done) {
  const name = params.capability;
  if (typeof name !== 'string' || !Object.hasOwn(TOOLS, name)) {
    done({ tool: typeof name === 'string' ? name.slice(0, 64) : '?', cls, err: 'unknown_capability' });
    return errorResult('unknown_capability', `Unknown capability "${name}". Capabilities of class "${cls}": ${namesOf(cls).join(', ')}. Call list_capabilities for the full current list.`);
  }
  const own = META[name][1];
  if (own !== cls) {
    done({ tool: name, cls, err: 'wrong_class' });
    return errorResult('wrong_class', `"${name}" is a "${own}" capability; call ${invokeTool(own)} instead. Nothing was run.`);
  }
  const { args, error } = checkArgs(TOOLS[name].s, params.args);
  if (error) {
    done({ tool: name, cls, err: 'invalid_args' });
    return errorResult('invalid_args', `Invalid args for ${name}: ${error}. args_schema: ${JSON.stringify(TOOLS[name].s)}`);
  }
  const ac = new AbortController();
  try {
    const { auditPid, ...result } = await withTimeout(TOOLS[name].run(args, ac.signal), CALL_TIMEOUT_MS, name, ac);
    done({ tool: name, cls, pid: auditPid });
    return result;
  } catch (e) {
    const code = codeOf(e);
    if (code === 'internal_error') log(`${name} failed:`, e?.stack || e);
    done({ tool: name, cls, err: code });
    return errorResult(code, e.message);
  }
}

// Non-sensitive correlation ids: boot_id per server process, call_id per call
// (also returned in the result's _meta so a client can match audit lines).
const BOOT_ID = randomBytes(4).toString('hex');

function mcpServer() {
  const server = new Server({ name: 'mcprelay-node', version: VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler('tools/list', async () => ({ tools: EXPOSED() }));
  server.setRequestHandler('tools/call', async (req) => {
    const tool = req.params.name; const params = req.params.arguments || {}; const started = Date.now();
    const callId = randomBytes(4).toString('hex');
    const done = ({ tool: name, cls, err, pid }) => audit({ t: new Date(started).toISOString(), boot: BOOT_ID, call: callId, tool: name,
      ...(cls ? { cls } : {}), ok: !err, ms: Date.now() - started, ...(pid ? { pid } : {}), ...(err ? { err } : {}) });
    const tag = (r) => ({ ...r, _meta: { ...(r._meta || {}), 'io.mcprelay/call_id': `${BOOT_ID}-${callId}` } });
    if (tool === 'list_capabilities') {
      if (params.class !== undefined && !Object.hasOwn(CLASSES, params.class)) {
        done({ tool, err: 'invalid_args' }); return tag(errorResult('invalid_args', `class must be one of: ${Object.keys(CLASSES).join(', ')}`));
      }
      done({ tool });
      return tag(text(JSON.stringify(catalog(params.class), null, 1)));
    }
    const cls = typeof tool === 'string' && tool.startsWith('invoke_') ? tool.slice(7) : null;
    if (!cls || !Object.hasOwn(CLASSES, cls)) {
      done({ tool: String(tool).slice(0, 64), err: 'unknown_tool' });
      throw new ProtocolError(-32602, `Unknown tool: ${tool}. Tools: list_capabilities, ${Object.keys(CLASSES).map(invokeTool).join(', ')}`);
    }
    return tag(await invoke(cls, params, done));
  });
  return server;
}

// -------------------------------------------------------------------- HTTP --
const handler = toNodeHandler(createMcpHandler(mcpServer), { onerror: (e) => log('handler error:', e?.message || e) });
const http = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/healthz' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' }).end(JSON.stringify({ server: VERSION, sessions: sessions.size, running: running() }));
      return;
    }
    if (url.pathname !== opt.path) { res.writeHead(404, { connection: 'close' }).end(); return; }
    // Never let the gateway reuse a keep-alive connection across a tunnel break.
    res.setHeader('connection', 'close');
    if (!authorized(req)) { res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } })); return; }
    await handler(req, res);
  } catch (e) {
    log('request failed:', e?.stack || e);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end();
  }
});
http.requestTimeout = CALL_TIMEOUT_MS + 30_000;
http.headersTimeout = 30_000;

async function shutdown(code) {
  for (const [pid, s] of sessions) if (s.exitCode === null) await killTree(pid);
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('unhandledRejection', (e) => log('unhandled rejection:', e?.stack || e));
process.on('uncaughtException', (e) => { log('uncaught exception, exiting for a clean restart:', e?.stack || e); shutdown(1); });

http.on('error', (e) => { log('listen error:', e.message); process.exit(1); }); // e.g. port busy -> supervisor retries
await detectShells(); // before listening, so the first tools/list already names the right shell
http.listen(Number(opt.port), opt.host, () => {
  log(`MCP endpoint http://${opt.host}:${opt.port}${opt.path} (v${VERSION}); allowed dirs: ${ALLOWED.join(', ')}; default shell: ${shellLabel()}; audit log: ${AUDIT || 'off'}`);
  if (!TOKEN_DIGEST) log('WARNING: MCPRELAY_BRIDGE_TOKEN not set; /mcp accepts unauthenticated local requests');
});
