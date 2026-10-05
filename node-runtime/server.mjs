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
//   MCPRELAY_TARGETS=<file>                  declared targets (default: %APPDATA%\MCPRelay\targets.json,
//                                            ~/.config/mcprelay/targets.json on Linux; ADR-0008)
//   MCPRELAY_PROC_HELPER=<exe>               Windows process helper (default: mcprelay-proc.exe next to this file)
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
import { createReadStream, openSync, closeSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server, ProtocolError, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { GIT_ERRORS, gitCapabilities } from './git.mjs';

const VERSION = '2.5.1';
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
// Long-running programs the user declared for the target_* capabilities (ADR-0008).
// Protected below, so agents can use the targets but never change them.
const TARGETS_FILE = path.resolve(E.MCPRELAY_TARGETS
  || (WIN ? path.join(E.APPDATA || inHome('AppData', 'Roaming'), 'MCPRelay', 'targets.json') : inHome('.config', 'mcprelay', 'targets.json')));
const PROTECTED = [...new Set([
  TARGETS_FILE,
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
// refresh_catalog = capabilities may have changed: call list_capabilities again,
// then retry with the current names/classes/arguments; fix_args = change the
// arguments and retry; ask_user = stop and ask the user; retry_later =
// transient; stop = unexpected server-side failure.
const ERRORS = {
  invalid_args: 'refresh_catalog', unknown_capability: 'refresh_catalog', wrong_class: 'refresh_catalog', path_not_allowed: 'fix_args',
  not_found: 'fix_args', already_exists: 'fix_args', not_empty: 'fix_args', is_a_directory: 'fix_args', not_a_directory: 'fix_args',
  too_large: 'fix_args', binary_file: 'fix_args', no_match: 'fix_args', spawn_failed: 'fix_args',
  bad_handle: 'fix_args', process_exited: 'fix_args',
  weak_identity: 'fix_args', ambiguous_match: 'fix_args', unknown_target: 'fix_args', already_running: 'fix_args',
  protected_path: 'ask_user', read_only_path: 'ask_user', permission_denied: 'ask_user',
  identity_mismatch: 'ask_user', protected_process: 'ask_user', graceful_unavailable: 'ask_user', stop_timeout: 'ask_user',
  start_failed: 'ask_user', health_check_failed: 'ask_user', targets_invalid: 'ask_user',
  timeout: 'retry_later', busy: 'retry_later',
  internal_error: 'stop', helper_missing: 'stop',
  ...GIT_ERRORS, // local Git operations (git.mjs)
};
const NEXT = { refresh_catalog: 'capabilities may have changed: call list_capabilities again, then retry with the current names, classes and arguments', fix_args: 'fix the arguments and retry', ask_user: 'stop and ask the user', retry_later: 'retry later', stop: 'stop; report the error' };
// facts: optional structured record of what was found or done before the failure
// (process lifecycle), returned with the error and in _meta["io.mcprelay/result"].
class CapError extends Error { constructor(code, message, facts) { super(message); this.code = code; this.facts = facts; } }
const fail = (code, message, facts) => { throw new CapError(code, message, facts); };
const ERRNO = { ENOENT: 'not_found', EEXIST: 'already_exists', ENOTEMPTY: 'not_empty', EISDIR: 'is_a_directory', ENOTDIR: 'not_a_directory',
  EACCES: 'permission_denied', EPERM: 'permission_denied', EBUSY: 'busy', EMFILE: 'busy' };
function errorResult(code, message, facts) {
  const action = ERRORS[code] || 'stop';
  // catalog_version lets the caller see whether its copy of the catalog is stale.
  const catalog_version = catalogVersion();
  const body = `Error [${code}]: ${message} (next: ${NEXT[action]}; catalog_version ${catalog_version})${facts ? `\n${JSON.stringify(facts, null, 1)}` : ''}`;
  return { ...text(body, true), _meta: { 'io.mcprelay/error': { code, action, catalog_version }, ...(facts ? { 'io.mcprelay/result': facts } : {}) } };
}
// Successful lifecycle results: the same facts as JSON text and in _meta.
const factsResult = (facts) => ({ ...text(JSON.stringify(facts, null, 1)), _meta: { 'io.mcprelay/result': facts } });
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
      `start_time=$(if($_.CreationDate){$_.CreationDate.ToString('o')});cpu_time=[math]::Round(($_.UserModeTime+$_.KernelModeTime)/1e7,2);rss=[int64]$_.WorkingSetSize;` +
      // ref = pid@<creation time in microseconds since 1601 UTC> (drop the last digit of the 100 ns FILETIME)
      `ref=$(if($_.CreationDate){$f=[string]$_.CreationDate.ToFileTimeUtc();"$($_.ProcessId)@$($f.Substring(0,$f.Length-1))"})} }) | ConvertTo-Json -Compress -Depth 2`;
    const out = await new Promise((resolve, reject) => execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }, (e, stdout) => (e ? reject(e) : resolve(stdout))));
    const parsed = out.trim() ? JSON.parse(out) : [];
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  const hz = 100; const page = 4096;
  const btime = await bootTime(); const boot = await bootKey();
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
        start_time: new Date((btime + Number(f[19]) / hz) * 1000).toISOString(), cpu_time: (Number(f[11]) + Number(f[12])) / hz, rss, ref: `${p}@${boot}.${f[19]}` });
    } catch { /* process exited meanwhile */ }
  }
  return rows.sort((a, b) => b.rss - a.rss).slice(0, max);
}

// ------------------------------------------- process lifecycle (ADR-0008) --
// Identity-checked operations on any process, including ones MCPRelay did not
// start. A process is named by a ref "<pid>@<start>", where start is its creation
// time (Windows: microseconds since 1601 UTC; Linux: boot id + start ticks). Every
// action re-checks it, so a reused PID is never hit. Windows uses the helper
// mcprelay-proc.exe (app/windows/mcprelay-proc.cs); Linux reads /proc. Nothing is
// kept between calls: no registry, no background work.
const HELPER = WIN ? path.resolve(E.MCPRELAY_PROC_HELPER || path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcprelay-proc.exe')) : null;
function runHelper(req, env = process.env) {
  return new Promise((resolve, reject) => {
    let out = ''; let err = ''; let settled = false;
    const settle = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
    const child = spawn(HELPER, [], { windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { child.kill(); settle(reject, new CapError('timeout', 'process helper timed out')); }, 100_000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.stdin.on('error', () => {});
    child.on('error', (e) => settle(reject, e.code === 'ENOENT'
      ? new CapError('helper_missing', `Process helper not found: ${HELPER}. It ships next to server.mjs; reinstall or update MCPRelay.`) : e));
    child.on('close', () => {
      let r; try { r = JSON.parse(out); } catch { settle(reject, new CapError('internal_error', `process helper returned no result${err ? `: ${err.slice(0, 300)}` : ''}`)); return; }
      if (r.ok) settle(resolve, r);
      else settle(reject, new CapError(req.op === 'spawn' ? 'spawn_failed' : 'internal_error', `${req.op === 'spawn' ? `Failed to start ${req.exe}` : 'process helper'}: ${r.error}`));
    });
    child.stdin.end(JSON.stringify(req));
  });
}

let BOOT_KEY = null; let BOOT_TIME = null;
async function bootKey() {
  if (BOOT_KEY === null) BOOT_KEY = (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8').catch(() => 'boot')).trim().replace(/-/g, '').slice(0, 8);
  return BOOT_KEY;
}
async function bootTime() {
  if (BOOT_TIME === null) BOOT_TIME = Number(((await fs.readFile('/proc/stat', 'utf8')).match(/^btime (\d+)/m) || [])[1] || 0);
  return BOOT_TIME;
}
const posixQuote = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);
async function linuxProc(pid) {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (f[0] === 'Z' || f[0] === 'X') return null; // exited, not yet reaped
    const opt = (p) => p.catch(() => null);
    const exe = await opt(fs.readlink(`/proc/${pid}/exe`));
    const raw = await opt(fs.readFile(`/proc/${pid}/cmdline`, 'utf8'));
    return {
      pid: Number(pid), ppid: Number(f[1]), name: exe ? path.basename(exe) : stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')')),
      exe, cmd: raw ? raw.replace(/\0$/, '').split('\0').map(posixQuote).join(' ') : null, cwd: await opt(fs.readlink(`/proc/${pid}/cwd`)),
      start: `${await bootKey()}.${f[19]}`, start_iso: new Date((await bootTime()) * 1000 + Number(f[19]) * 10).toISOString(),
    };
  } catch { return null; }
}
// Raw records {pid, ppid, name, exe, cmd, cwd, start, start_iso, access?} of the given PIDs, or of all processes.
async function procsInspect(pids) {
  if (WIN) return (await runHelper(pids ? { op: 'inspect', pids } : { op: 'inspect', all: true })).processes;
  const list = pids ? pids.map(String) : (await fs.readdir('/proc')).filter((d) => /^\d+$/.test(d));
  return (await Promise.all(list.map(linuxProc))).filter(Boolean);
}
const refOf = (p) => (p?.start ? `${p.pid}@${p.start}` : null);
function parseRef(ref) {
  const m = /^(\d+)@(\S+)$/.exec(String(ref));
  if (!m) fail('invalid_args', `ref must look like "<pid>@<start>", as returned by process_info, list_processes or spawn_process; got "${ref}"`);
  return { pid: Number(m[1]), start: m[2] };
}
const startOrder = (p) => { try { return BigInt(String(p.start).split('.').pop()); } catch { return -1n; } };
// The process and its descendants; a child must start after its parent (rules out reused parent PIDs).
function subtree(all, pid, start) {
  const root = all.find((p) => p.pid === pid && p.start === start);
  if (!root) return [];
  const out = [root];
  for (let i = 0; i < out.length; i++) {
    for (const p of all) if (p.ppid === out[i].pid && !out.includes(p) && startOrder(p) >= startOrder(out[i])) out.push(p);
  }
  return out;
}

// Command lines can carry secrets; values after secret-looking flags/variables and URL passwords are masked.
const SECRET = '(?:pass(?:word|wd|phrase)?|pwd|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|auth\\w*|credential\\w*|cookie|session)';
const redact = (cmd) => (typeof cmd !== 'string' ? cmd : cmd
  .replace(new RegExp(`((?:--?|/)[\\w.-]*${SECRET}[\\w.-]*)(=|:|\\s+)("[^"]*"|'[^']*'|\\S+)`, 'gi'), '$1$2***')
  .replace(new RegExp(`\\b([A-Za-z_]\\w*${SECRET}\\w*)=("[^"]*"|\\S+)`, 'gi'), '$1=***')
  .replace(/(\w+:\/\/[^\s:/@]+:)[^\s@/]+@/g, '$1***@'));
const trimSep = (p) => (p && p.length > 1 && /[\\/]$/.test(p) && !/^[a-z]:\\$/i.test(p) ? p.slice(0, -1) : p);
function identity(p) {
  return {
    ref: refOf(p), pid: p.pid, parent_pid: p.ppid, name: p.name, executable: p.exe ?? null,
    command_line: redact(p.cmd ?? null), command_line_sha256: p.cmd ? createHash('sha256').update(p.cmd).digest('hex').slice(0, 16) : null,
    cwd: p.cwd ? trimSep(p.cwd) : null, start_time: p.start_iso ?? null, ...(p.access ? { access: p.access } : {}),
  };
}
const brief = (p) => ({ ref: refOf(p), pid: p.pid, start_time: p.start_iso ?? null });

// Identity fields shared by process_info, stop_process and target match rules.
// A check is true, false, or null when the field could not be read (null fails: fail-closed).
const SELECTOR = Object.fromEntries(['ref', 'pid', 'name', 'executable', 'command_line', 'command_line_contains', 'cwd'].map((k) => [k, { type: k === 'pid' ? 'number' : 'string' }]));
const lc = (s) => (WIN ? s.toLowerCase() : s);
const samePath = (a, b) => norm(trimSep(path.resolve(a))) === norm(trimSep(path.resolve(b)));
const bare = (n) => lc(n).replace(/\.exe$/i, '');
function checksOf(p, sel) {
  const c = {};
  if (sel.ref !== undefined) c.ref = refOf(p) === sel.ref;
  if (sel.pid !== undefined) c.pid = p.pid === sel.pid;
  if (sel.name !== undefined) c.name = !!p.name && bare(p.name) === bare(sel.name);
  if (sel.executable !== undefined) c.executable = !p.exe ? null : /[\\/]/.test(sel.executable) ? samePath(p.exe, sel.executable) : bare(path.basename(p.exe)) === bare(sel.executable);
  if (sel.command_line !== undefined) c.command_line = p.cmd == null ? null : p.cmd.trim() === sel.command_line.trim();
  if (sel.command_line_contains !== undefined) c.command_line_contains = p.cmd == null ? null : lc(p.cmd).includes(lc(sel.command_line_contains));
  if (sel.cwd !== undefined) c.cwd = p.cwd == null ? null : samePath(p.cwd, sel.cwd);
  return c;
}
const allTrue = (c) => Object.values(c).every((v) => v === true);
const selectorOf = (a) => Object.fromEntries(Object.keys(SELECTOR).filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));
// Strong enough to act on: a ref, or the full executable path plus command line or working directory.
const strongIdentity = (sel) => sel.ref !== undefined
  || (typeof sel.executable === 'string' && /[\\/]/.test(sel.executable) && ['command_line', 'command_line_contains', 'cwd'].some((k) => sel[k] !== undefined));

// Exactly one process that matches every given field, or a failure that says why.
async function resolveOne(sel) {
  if (!Object.keys(sel).length) fail('invalid_args', 'Name the process: ref, or pid / name / executable / command_line / command_line_contains / cwd.');
  const pid = sel.ref !== undefined ? parseRef(sel.ref).pid : sel.pid;
  if (pid !== undefined) {
    const [p] = (await procsInspect([pid])).filter((x) => x.pid === pid);
    if (!p) fail('not_found', `No running process has PID ${pid}.`, { status: 'not_found', pid });
    const checks = checksOf(p, sel);
    if (!allTrue(checks)) {
      fail('identity_mismatch', `Process ${pid} does not match the expected identity${checks.ref === false ? ' (different start time: the PID now belongs to another process)' : ''}. Nothing was done.`,
        { status: 'identity_mismatch', checks, actual: identity(p) });
    }
    return p;
  }
  const hits = (await procsInspect(null)).filter((p) => allTrue(checksOf(p, sel)));
  if (!hits.length) fail('not_found', 'No running process matches.', { status: 'not_found' });
  if (hits.length > 1) fail('ambiguous_match', `${hits.length} processes match; pass ref to pick one.`, { status: 'ambiguous_match', matches: hits.slice(0, 20).map(identity) });
  return hits[0];
}

async function processInfo(a) {
  const sel = selectorOf(a);
  if (!Object.keys(sel).length) fail('invalid_args', 'Give ref or pid, or search with name / executable / command_line / command_line_contains / cwd.');
  const pid = sel.ref !== undefined ? parseRef(sel.ref).pid : sel.pid;
  if (pid !== undefined) {
    const [p] = (await procsInspect([pid])).filter((x) => x.pid === pid);
    if (!p) fail('not_found', `No running process has PID ${pid}.`);
    const checks = checksOf(p, sel);
    if (checks.ref === false) fail('not_found', `Process ${sel.ref} has exited; PID ${pid} now belongs to another process (started ${p.start_iso}).`);
    return text(JSON.stringify({ ...identity(p), checks, identity_match: allTrue(checks) }, null, 1));
  }
  const hits = (await procsInspect(null)).filter((p) => allTrue(checksOf(p, sel)));
  const max = Math.min(Math.max(1, a.limit ?? 20), 100);
  return text(JSON.stringify({ matched: hits.length, processes: hits.slice(0, max).map(identity) }, null, 1));
}

// ---- stop
const GRACEFUL = ['auto', 'console_ctrl', 'close', 'sigterm', 'sigint', 'none'];
const CRITICAL = new Set(['system', 'registry', 'memory compression', 'smss.exe', 'csrss.exe', 'wininit.exe', 'winlogon.exe', 'services.exe',
  'lsass.exe', 'lsaiso.exe', 'svchost.exe', 'dwm.exe', 'fontdrvhost.exe']);
function assertStoppable(p) {
  if (p.pid === process.pid || p.pid === process.ppid) fail('protected_process', `PID ${p.pid} is the MCPRelay node server or its supervisor; the user restarts those from the MCPRelay app.`);
  if ((WIN && (p.pid <= 4 || CRITICAL.has(String(p.name).toLowerCase()))) || (!WIN && p.pid === 1)) fail('protected_process', `${p.name} (PID ${p.pid}) is a critical system process.`);
}
async function linuxStop(p, { graceful, ms, force, tree }) {
  const same = async (q) => (await linuxProc(q.pid))?.start === q.start;
  if (!(await same(p))) return { result: (await linuxProc(p.pid)) ? 'identity_mismatch' : 'not_found' };
  const desc = tree ? subtree(await procsInspect(null), p.pid, p.start).slice(1) : [];
  const send = async (q, sig) => {
    if (!(await same(q))) return false; // re-checked right before every signal
    try { process.kill(q.pid, sig); return true; } catch (e) { if (e.code === 'EPERM') fail('permission_denied', `Not allowed to signal PID ${q.pid} (another user's process).`); return false; }
  };
  const gone = async () => !(await same(p));
  const waitGone = async (until) => { while (Date.now() < until) { if (await gone()) return; await sleep(100); } };
  const t0 = Date.now(); let graceful_done = null; let note = null;
  const sig = { auto: 'SIGTERM', sigterm: 'SIGTERM', sigint: 'SIGINT' }[graceful];
  if (graceful !== 'none') {
    if (!sig) note = `${graceful} is only available on Windows`;
    else if (await send(p, sig)) { graceful_done = sig.toLowerCase(); await waitGone(t0 + ms); }
  }
  let forced = false; let killed = 0;
  if (!(await gone()) && force) {
    forced = await send(p, 'SIGKILL'); await waitGone(Date.now() + 5000);
    for (const d of desc) if (await send(d, 'SIGKILL')) killed++;
  }
  return { result: (await gone()) ? 'stopped' : 'still_running', graceful: graceful_done, graceful_note: note, forced, children_killed: killed, waited_ms: Date.now() - t0 };
}
async function stopVerified(p, { graceful = 'auto', graceful_timeout_ms: gms = 10_000, force = false, tree = true }) {
  assertStoppable(p);
  if (graceful === 'none' && !force) fail('invalid_args', 'graceful "none" needs force=true.');
  const ms = Math.min(Math.max(gms, 0), 60_000);
  const r = WIN
    ? await runHelper({ op: 'stop', pid: p.pid, start: p.start, graceful: ['sigterm', 'sigint'].includes(graceful) ? 'none' : graceful, graceful_ms: ms, force, tree })
    : await linuxStop(p, { graceful, ms, force, tree });
  const base = { ref: refOf(p), pid: p.pid, name: p.name };
  if (r.result === 'identity_mismatch') fail('identity_mismatch', `Process ${p.pid} changed identity before it could be stopped; nothing was done.`, { status: 'identity_mismatch', ...base });
  if (r.result === 'access_denied') fail('permission_denied', `Not allowed to stop PID ${p.pid} (elevated or another user's process).`, { status: 'access_denied', ...base });
  if (r.result === 'not_found') return { status: 'stopped', ...base, stop_method: 'already_exited', exit_code: null };
  const note = WIN && ['sigterm', 'sigint'].includes(graceful) ? `${graceful} is only available on Linux` : r.graceful_note;
  const facts = {
    status: r.result === 'stopped' ? 'stopped' : 'still_running', ...base,
    stop_method: r.forced ? 'forced' : r.graceful ? 'graceful' : 'none', graceful_signal: r.graceful ?? null,
    ...(note ? { graceful_note: note } : {}), children_killed: r.children_killed ?? 0, waited_ms: r.waited_ms ?? 0, exit_code: r.exit_code ?? null,
  };
  if (facts.status === 'still_running') {
    if (!r.graceful) fail('graceful_unavailable', `No graceful stop is possible for PID ${p.pid} (${note || 'no method applies'}); it was not touched. Use force=true only if the user agrees.`, facts);
    fail('stop_timeout', `PID ${p.pid} is still running ${ms / 1000} s after a graceful stop (${r.graceful}); force was not allowed.`, facts);
  }
  return facts;
}
async function stopProcess(a) {
  const sel = selectorOf(a);
  if (!strongIdentity(sel)) {
    fail('weak_identity', 'Refusing to stop by PID or name alone. Pass ref (from process_info / list_processes / spawn_process), or executable (full path) plus command_line, command_line_contains or cwd.');
  }
  const p = await resolveOne(sel);
  return factsResult(await stopVerified(p, a));
}

// ---- start
function mergeEnv(extra) {
  const out = { ...process.env };
  for (const [k, v] of Object.entries(extra || {})) {
    if (typeof v !== 'string') fail('invalid_args', `env values must be strings ("${k}")`);
    if (WIN) for (const key of Object.keys(out)) if (key.toLowerCase() === k.toLowerCase()) delete out[key];
    out[k] = v;
  }
  return out;
}
async function logTail(file, n = 20) {
  if (!file) return null;
  try {
    const buf = await fs.readFile(await allowedPath(file));
    return buf.subarray(Math.max(0, buf.length - 16384)).toString('utf8').split(/\r?\n/).slice(-n - 1).join('\n').trim();
  } catch { return null; }
}
// Starts a program without a shell, detached from this server (it survives a
// server restart when outlives_node is true). Returns {pid, start, outlives_node, log}.
async function spawnDetached({ executable, args = [], cwd, env, log }) {
  if (typeof executable !== 'string' || !executable) fail('invalid_args', 'executable is required');
  const dir = path.resolve(cwd || homedir());
  if (!(await fs.stat(dir).catch(() => null))?.isDirectory()) fail('not_found', `Working directory not found: ${dir}`);
  let logPath = null;
  if (log) { logPath = await allowedPath(log, 'write'); await fs.mkdir(path.dirname(logPath), { recursive: true }); }
  const childEnv = mergeEnv(env);
  if (WIN) {
    const r = await runHelper({ op: 'spawn', exe: executable, args, cwd: dir, log: logPath }, childEnv);
    return { pid: r.pid, start: r.start, outlives_node: !r.in_job, log: logPath };
  }
  const fd = logPath ? openSync(logPath, 'a') : 'ignore';
  try {
    const child = spawn(executable, args, { cwd: dir, env: childEnv, detached: true, stdio: ['ignore', fd, fd] });
    const err = await new Promise((r) => { child.once('spawn', () => r(null)); child.once('error', r); });
    if (err || !child.pid) fail('spawn_failed', `Failed to start ${executable}: ${err?.message || 'unknown error'}`);
    child.unref();
    return { pid: child.pid, start: (await linuxProc(child.pid))?.start ?? null, outlives_node: true, log: logPath };
  } finally { if (typeof fd === 'number') closeSync(fd); }
}
async function spawnProcess(a) {
  const sp = await spawnDetached(a);
  await sleep(500); // a program that fails at once (bad arguments, missing file) shows up here
  const [p] = (await procsInspect([sp.pid])).filter((x) => x.pid === sp.pid && x.start === sp.start);
  const facts = { status: p ? 'started' : 'exited_early', ...(p ? identity(p) : { ref: sp.start ? `${sp.pid}@${sp.start}` : null, pid: sp.pid }), outlives_node: sp.outlives_node, log: sp.log };
  if (!sp.outlives_node) facts.warning = 'This process is inside the MCPRelay supervisor job and stops when the node server restarts; update the MCPRelay app.';
  if (!p) { facts.log_tail = await logTail(sp.log); fail('process_exited', `${a.executable} started (PID ${sp.pid}) but exited within 0.5 s.`, facts); }
  return factsResult(facts);
}

// ---- health probes and waiting
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
function loopbackUrlError(u) {
  let x; try { x = new URL(u); } catch { return 'must be a URL'; }
  if (!['http:', 'https:'].includes(x.protocol)) return 'must be http or https';
  return LOOPBACK.has(x.hostname) ? null : 'must point to this machine (127.0.0.1, localhost or [::1])';
}
function probeError(pr, where) {
  if (!isObj(pr)) return `${where} must be an object`;
  const keys = Object.keys(pr);
  if (keys.filter((k) => ['tcp', 'http', 'file'].includes(k)).length !== 1) return `${where} needs exactly one of tcp, http, file`;
  const unknown = keys.find((k) => !['tcp', 'http', 'file', 'status'].includes(k));
  if (unknown) return `${where}: unknown key "${unknown}"`;
  if (pr.tcp !== undefined && !(Number.isInteger(pr.tcp) && pr.tcp > 0 && pr.tcp < 65536)) return `${where}.tcp must be a port number`;
  if (pr.http !== undefined) { const e = typeof pr.http === 'string' ? loopbackUrlError(pr.http) : 'must be a URL'; if (e) return `${where}.http ${e}`; }
  if (pr.status !== undefined && (pr.http === undefined || !Number.isInteger(pr.status))) return `${where}.status needs http and must be an integer`;
  if (pr.file !== undefined && (typeof pr.file !== 'string' || !path.isAbsolute(pr.file))) return `${where}.file must be an absolute path`;
  return null;
}
// One probe attempt: {probe, ok, detail}. file: modified at or after `since` (ms).
async function probeOnce(pr, since) {
  if (pr.tcp !== undefined) {
    return new Promise((resolve) => {
      const s = net.connect({ host: '127.0.0.1', port: pr.tcp });
      const done = (ok, detail) => { s.destroy(); resolve({ probe: `tcp ${pr.tcp}`, ok, detail }); };
      s.setTimeout(2000, () => done(false, 'timeout'));
      s.once('connect', () => done(true, 'accepting connections'));
      s.once('error', (e) => done(false, e.code || e.message));
    });
  }
  if (pr.http !== undefined) {
    try {
      const r = await fetch(pr.http, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
      await r.body?.cancel();
      return { probe: `http ${pr.http}`, ok: pr.status ? r.status === pr.status : r.status >= 200 && r.status < 300, detail: `status ${r.status}` };
    } catch (e) { return { probe: `http ${pr.http}`, ok: false, detail: e.cause?.code || e.name || String(e) }; }
  }
  const st = await fs.stat(pr.file).catch(() => null);
  return { probe: `file ${pr.file}`, ok: !!st && st.mtimeMs >= since, detail: st ? `modified ${st.mtime.toISOString()}` : 'missing' };
}
const UNTIL = ['process_exited', 'port_open', 'http_ok', 'file_updated'];
async function waitFor(a, signal) {
  const t0 = Date.now(); const limit = Math.min(Math.max(a.timeout_ms ?? 30_000, 0), 110_000);
  const need = (k) => { if (a[k] === undefined) fail('invalid_args', `until=${a.until} needs ${k}`); return a[k]; };
  let test;
  if (a.until === 'process_exited') {
    const { pid, start } = parseRef(need('ref'));
    test = async () => { const gone = !(await procsInspect([pid])).some((p) => p.pid === pid && p.start === start); return { ok: gone, detail: gone ? 'exited' : 'running' }; };
  } else if (a.until === 'port_open') {
    const pr = { tcp: need('port') }; const e = probeError(pr, 'port'); if (e) fail('invalid_args', e);
    test = () => probeOnce(pr, 0);
  } else if (a.until === 'http_ok') {
    const pr = { http: need('url'), ...(a.status !== undefined ? { status: a.status } : {}) }; const e = probeError(pr, 'url'); if (e) fail('invalid_args', e);
    test = () => probeOnce(pr, 0);
  } else {
    const file = await allowedPath(need('path'));
    const since = a.modified_after !== undefined ? Date.parse(a.modified_after) : 0;
    if (Number.isNaN(since)) fail('invalid_args', 'modified_after must be an ISO date-time');
    test = () => probeOnce({ file }, since);
  }
  let last;
  for (;;) {
    last = await test();
    if (last.ok || Date.now() - t0 >= limit || signal?.aborted) break;
    await sleep(WIN && a.until === 'process_exited' ? 500 : 250);
  }
  return text(JSON.stringify({ until: a.until, met: last.ok, waited_ms: Date.now() - t0, detail: last.detail }, null, 1));
}

// ---- targets: long-running programs the user declared in TARGETS_FILE
//   {"targets": {"<name>": {description, match: {...}, start: {executable, args, cwd, env, log},
//     stop: {graceful, graceful_timeout_s, force, tree}, health: [{tcp}|{http, status}|{file}], health_timeout_s, min_alive_s}}}
// Read and validated on every call; never written by the server.
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const TARGET_NAME = /^[A-Za-z0-9][\w.-]{0,63}$/;
function targetSpec(name, t, problems) {
  const bad = (m) => { problems.push(`${name}: ${m}`); return null; };
  if (!TARGET_NAME.test(name)) return bad('a name may contain letters, digits, _ . - (max 64)');
  if (!isObj(t)) return bad('must be an object');
  const known = ['description', 'match', 'start', 'stop', 'health', 'health_timeout_s', 'min_alive_s'];
  const unknown = Object.keys(t).find((k) => !known.includes(k));
  if (unknown) return bad(`unknown key "${unknown}" (known: ${known.join(', ')})`);
  if (!isObj(t.match)) return bad('match is required');
  for (const [k, v] of Object.entries(t.match)) {
    if (!['name', 'executable', 'command_line', 'command_line_contains', 'cwd'].includes(k) || typeof v !== 'string' || !v) return bad(`match.${k}: allowed are non-empty strings for name, executable, command_line, command_line_contains, cwd`);
  }
  if (!strongIdentity(t.match)) return bad('match needs the full executable path plus command_line, command_line_contains or cwd');
  let start = null;
  if (t.start !== undefined) {
    const s = t.start;
    if (!isObj(s)) return bad('start must be an object');
    const u = Object.keys(s).find((k) => !['executable', 'args', 'cwd', 'env', 'log'].includes(k));
    if (u) return bad(`start: unknown key "${u}"`);
    if (typeof s.executable !== 'string' || !s.executable) return bad('start.executable is required');
    if (s.args !== undefined && (!Array.isArray(s.args) || s.args.some((x) => typeof x !== 'string'))) return bad('start.args must be an array of strings');
    for (const k of ['cwd', 'log']) if (s[k] !== undefined && (typeof s[k] !== 'string' || !path.isAbsolute(s[k]))) return bad(`start.${k} must be an absolute path`);
    if (s.env !== undefined && (!isObj(s.env) || Object.values(s.env).some((x) => typeof x !== 'string'))) return bad('start.env must map names to strings');
    start = { executable: s.executable, args: s.args || [], cwd: s.cwd, env: s.env || {}, log: s.log };
  }
  const stop = { graceful: 'auto', graceful_timeout_s: 10, force: false, tree: true };
  if (t.stop !== undefined) {
    if (!isObj(t.stop)) return bad('stop must be an object');
    for (const [k, v] of Object.entries(t.stop)) {
      if (k === 'graceful') { if (!GRACEFUL.includes(v)) return bad(`stop.graceful must be one of ${GRACEFUL.join(', ')}`); }
      else if (k === 'graceful_timeout_s') { if (typeof v !== 'number' || v < 0 || v > 45) return bad('stop.graceful_timeout_s must be 0..45'); }
      else if (k === 'force' || k === 'tree') { if (typeof v !== 'boolean') return bad(`stop.${k} must be true or false`); }
      else return bad(`stop: unknown key "${k}"`);
      stop[k] = v;
    }
    if (stop.graceful === 'none' && !stop.force) return bad('stop.graceful "none" needs stop.force true');
  }
  const health = t.health ?? [];
  if (!Array.isArray(health)) return bad('health must be an array of probes');
  for (const [i, pr] of health.entries()) { const e = probeError(pr, `health[${i}]`); if (e) return bad(e); }
  const range = (k, lo, hi, d) => { const v = t[k] ?? d; return typeof v === 'number' && v >= lo && v <= hi ? v : bad(`${k} must be ${lo}..${hi}`); };
  const health_timeout_s = range('health_timeout_s', 1, 45, 30); const min_alive_s = range('min_alive_s', 0, 10, 2);
  if (health_timeout_s === null || min_alive_s === null) return null;
  return { name, description: typeof t.description === 'string' ? t.description : '', match: t.match, start, stop, health, health_timeout_s, min_alive_s };
}
async function loadTargets() {
  let raw;
  try { raw = await fs.readFile(TARGETS_FILE, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return new Map(); fail('targets_invalid', `Cannot read ${TARGETS_FILE} (${e.code}).`); }
  let doc;
  try { doc = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch (e) { fail('targets_invalid', `${TARGETS_FILE} is not valid JSON: ${e.message}`); }
  if (!isObj(doc) || !isObj(doc.targets)) fail('targets_invalid', `${TARGETS_FILE} must be {"targets": {"<name>": {...}}}`);
  const problems = []; const out = new Map();
  for (const [name, t] of Object.entries(doc.targets)) { const spec = targetSpec(name, t, problems); if (spec) out.set(name, spec); }
  if (problems.length) fail('targets_invalid', `${TARGETS_FILE}: ${problems.join('; ')}. ${ASK_USER_TARGETS}`);
  return out;
}
const busyTargets = new Set(); // in-flight operations per target, so two calls never interleave
async function onTarget(name, fn) {
  const targets = await loadTargets();
  const t = targets.get(name);
  if (!t) fail('unknown_target', `Unknown target "${name}". Declared targets: ${[...targets.keys()].join(', ') || 'none'}. ${ASK_USER_TARGETS}`);
  if (busyTargets.has(name)) fail('busy', `Another operation on target "${name}" is in progress.`);
  busyTargets.add(name);
  try { return await fn(t); } finally { busyTargets.delete(name); }
}
const instancesOf = async (t, all) => (all || await procsInspect(null)).filter((p) => allTrue(checksOf(p, t.match)));
async function pickInstance(t, expectRef, facts) {
  const inst = await instancesOf(t);
  if (expectRef !== undefined) {
    const hit = inst.find((p) => refOf(p) === expectRef);
    if (!hit) {
      Object.assign(facts, { status: 'identity_mismatch', running: inst.map(brief) });
      fail('identity_mismatch', `Target "${t.name}": the expected instance ${expectRef} is not running${inst.length ? ` (running: ${inst.map(refOf).join(', ')})` : ''}. Nothing was done.`, facts);
    }
    return hit;
  }
  if (inst.length > 1) {
    Object.assign(facts, { status: 'ambiguous_match', running: inst.map(brief) });
    fail('ambiguous_match', `Target "${t.name}" has ${inst.length} running instances; pass expect_ref to pick one.`, facts);
  }
  return inst[0] || null;
}
async function stopInstance(t, p, facts) {
  facts.old = identity(p); facts.old_identity_verified = true;
  try {
    const r = await stopVerified(p, { graceful: t.stop.graceful, graceful_timeout_ms: t.stop.graceful_timeout_s * 1000, force: t.stop.force, tree: t.stop.tree });
    facts.stop_method = r.stop_method; facts.stop = r;
  } catch (e) {
    if (e instanceof CapError) e.facts = { ...facts, status: 'stop_failed', stop: e.facts ?? null };
    throw e;
  }
}
// Start as declared, then verify: the started process or one of its children (launcher
// scripts, which may first run a preparation step) must match the target within
// max(10 s, health_timeout_s) of the start, stay alive min_alive_s and pass every probe.
// Failures are reported with the facts; a started process is left running (no rollback).
async function startTarget(t, facts) {
  const since = Date.now();
  let sp;
  try { sp = await spawnDetached(t.start); } catch (e) {
    if (e instanceof CapError) throw new CapError('start_failed', e.message, { ...facts, status: facts.old ? 'stopped_not_started' : 'start_failed' });
    throw e;
  }
  facts.outlives_node = sp.outlives_node;
  if (!sp.outlives_node) facts.warning = 'The new process is inside the MCPRelay supervisor job and stops when the node server restarts; update the MCPRelay app.';
  facts.log = sp.log;
  const failWith = async (code, status, message) => {
    facts.status = status; facts.log_tail = await logTail(sp.log);
    fail(code, message, facts);
  };
  let inst = null;
  const idWindowS = Math.max(10, t.health_timeout_s);
  for (const until = since + idWindowS * 1000; ;) {
    const tree = subtree(await procsInspect(null), sp.pid, sp.start);
    inst = tree.find((p) => allTrue(checksOf(p, t.match))) || null;
    if (inst || !tree.length || Date.now() > until) {
      if (!inst) {
        facts.new = { ref: sp.start ? `${sp.pid}@${sp.start}` : null, pid: sp.pid }; facts.new_identity_verified = false;
        if (!tree.length) await failWith('start_failed', 'exited_after_start', `Target "${t.name}" started (PID ${sp.pid}) but exited at once; see log_tail.`);
        await failWith('identity_mismatch', 'started_identity_mismatch', `Target "${t.name}" started (PID ${sp.pid}), but neither it nor a child matches the target's match rule after ${idWindowS} s. It was left running; the target definition may need fixing.`);
      }
      break;
    }
    await sleep(300);
  }
  facts.new = identity(inst); facts.new_identity_verified = true;
  let results = [];
  for (const deadline = since + t.health_timeout_s * 1000; ;) {
    if (!(await procsInspect([inst.pid])).some((p) => p.pid === inst.pid && p.start === inst.start)) {
      facts.health = results; facts.health_check = 'failed';
      await failWith('start_failed', 'exited_after_start', `Target "${t.name}" (PID ${inst.pid}) exited during its health check; see log_tail.`);
    }
    results = await Promise.all(t.health.map((pr) => probeOnce(pr, since)));
    if (results.every((r) => r.ok) && Date.now() - since >= t.min_alive_s * 1000) break;
    if (Date.now() >= deadline) {
      facts.health = results; facts.health_check = 'failed';
      await failWith('health_check_failed', 'started_unhealthy', `Target "${t.name}" is running (PID ${inst.pid}) but did not pass its health check within ${t.health_timeout_s} s. It was left running.`);
    }
    await sleep(500);
  }
  facts.health = results; facts.health_check = t.health.length ? 'passed' : 'none';
  return facts;
}
const needStart = (t) => { if (!t.start) fail('targets_invalid', `Target "${t.name}" has no start section, so it can only be stopped.`); };
const targetFacts = (t) => ({ target: t.name, status: null, old: null, old_identity_verified: false, stop_method: null });

async function targetStatus(a) {
  const targets = await loadTargets();
  const all = await procsInspect(null);
  if (a.target === undefined) {
    return text(JSON.stringify({ targets_file: TARGETS_FILE, ...(targets.size ? {} : { note: `No targets declared. ${ASK_USER_TARGETS}` }), targets: await Promise.all([...targets.values()].map(async (t) => ({
      name: t.name, description: t.description, running: (await instancesOf(t, all)).map(brief), can_start: !!t.start,
    }))) }, null, 1));
  }
  const t = targets.get(a.target);
  if (!t) fail('unknown_target', `Unknown target "${a.target}". Declared targets: ${[...targets.keys()].join(', ') || 'none'}. ${ASK_USER_TARGETS}`);
  const inst = await instancesOf(t, all);
  return text(JSON.stringify({
    target: t.name, description: t.description, running: inst.map(identity),
    health: inst.length === 1 && t.health.length ? await Promise.all(t.health.map((pr) => probeOnce(pr, 0))) : null,
    match: t.match,
    start: t.start && { executable: t.start.executable, args: redact(t.start.args.join(' ')), cwd: t.start.cwd ?? null, env_names: Object.keys(t.start.env), log: t.start.log ?? null },
    stop: t.stop, health_probes: t.health, health_timeout_s: t.health_timeout_s, min_alive_s: t.min_alive_s,
  }, null, 1));
}
const targetStart = (a) => onTarget(a.target, async (t) => {
  needStart(t);
  const facts = targetFacts(t);
  const inst = await instancesOf(t);
  if (inst.length) { Object.assign(facts, { status: 'already_running', running: inst.map(brief) }); fail('already_running', `Target "${t.name}" is already running; use target_restart to restart it.`, facts); }
  await startTarget(t, facts);
  facts.status = 'started';
  return factsResult(facts);
});
const targetStop = (a) => onTarget(a.target, async (t) => {
  const facts = targetFacts(t);
  const inst = await pickInstance(t, a.expect_ref, facts);
  if (!inst) { facts.status = 'not_running'; return factsResult(facts); }
  await stopInstance(t, inst, facts);
  facts.status = 'stopped';
  return factsResult(facts);
});
const targetRestart = (a) => onTarget(a.target, async (t) => {
  needStart(t); // checked before anything is stopped
  const facts = { ...targetFacts(t), new: null, new_identity_verified: false, health_check: null };
  const inst = await pickInstance(t, a.expect_ref, facts);
  if (inst) await stopInstance(t, inst, facts);
  else if (a.start_if_stopped === false) { facts.status = 'not_running'; fail('not_found', `Target "${t.name}" is not running (start_if_stopped=false).`, facts); }
  await startTarget(t, facts);
  facts.status = inst ? 'restarted' : 'started';
  return factsResult(facts);
});
// How a target is declared, for agents that must ask the user to add or fix one
// (catalog environment.targets_help; pointed to by target errors and target_status).
const ASK_USER_TARGETS = `Agents cannot change ${TARGETS_FILE}; ask the user to add or fix the target there (format: list_capabilities environment.targets_help). The file is read on every call: no restart needed.`;
const TARGETS_HELP = {
  file: TARGETS_FILE,
  edited_by: 'the user only (agents cannot change it); read on every call, so no restart is needed',
  format: '{"targets": {"<name>": {"description"?, "match": {"executable": <full path>, plus "command_line_contains" | "command_line" | "cwd"}, '
    + '"start"?: {"executable", "args"?: [...], "cwd"?, "env"?: {...}, "log"?: <file inside file_roots>}, '
    + '"stop"?: {"graceful"?: auto|console_ctrl|close|sigterm|sigint|none (auto), "graceful_timeout_s"?: 0-45 (10), "force"?: bool (false), "tree"?: bool (true)}, '
    + '"health"?: [{"tcp": port} | {"http": "http://127.0.0.1:<port>/...", "status"?: n} | {"file": path}], "health_timeout_s"?: 1-45 (30), "min_alive_s"?: 0-10 (2)}}}',
  rules: [
    'match identifies the running instance and, after a start, the new one: the started process or a child of it (e.g. behind a launcher script), within max(10 s, health_timeout_s). Make match specific enough that helper processes the launcher runs first (preflight checks) do not match, e.g. by cwd.',
    'Without start a target can only be stopped. Without force, a program that ignores the graceful stop is left running and reported (stop_timeout).',
    'Paths are absolute; in JSON, Windows backslashes are doubled.',
  ],
  example: WIN
    ? { targets: { 'my-service': { description: 'example', match: { executable: 'C:\\Program Files\\nodejs\\node.exe', command_line_contains: 'service.mjs' },
      start: { executable: 'C:\\Program Files\\nodejs\\node.exe', args: ['D:\\app\\service.mjs'], cwd: 'D:\\app', log: 'D:\\app\\logs\\service.log' },
      stop: { graceful: 'auto', graceful_timeout_s: 20, force: true }, health: [{ http: 'http://127.0.0.1:8080/healthz' }] } } }
    : { targets: { 'my-service': { description: 'example', match: { executable: '/usr/bin/node', command_line_contains: 'service.mjs' },
      start: { executable: '/usr/bin/node', args: ['/srv/app/service.mjs'], cwd: '/srv/app', log: '/home/me/app/service.log' },
      stop: { graceful: 'sigterm', graceful_timeout_s: 20, force: true }, health: [{ http: 'http://127.0.0.1:8080/healthz' }] } } },
};
const targetsSummary = () => loadTargets().then((m) => [...m.values()].map((t) => ({ name: t.name, description: t.description, can_start: !!t.start })), (e) => ({ error: e.message }));

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

// ------------------------------------------------- local Git (ADR-0009) --
// Structured Git reads (class read) and non-lossy Git changes (class write); see git.mjs.
const GITOPS = gitCapabilities({ allowedPath, fail, factsResult, CapError, norm, holdsGuarded,
  // core.hooksPath for every Git call: a folder that does not exist, inside this server's read-only code folder.
  noHooksDir: path.join(path.dirname(fileURLToPath(import.meta.url)), 'no-git-hooks') });

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
      process_helper: WIN ? (await fs.stat(HELPER).then(() => HELPER, () => null)) : 'not needed (Linux /proc)', targets_file: TARGETS_FILE,
      git_version: GITOPS.environment().version,
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
  list_processes: { d: 'List system processes (read-only), largest memory first: pid, parent_pid, name, path, start_time, cpu_time (s), rss (bytes), ref (pid@start, for process_info / stop_process). Filter by name (substring) or pid; limit (default 50, max 500). Command lines are not returned (process_info shows one process with secrets masked).', s: P({ name: str, pid: num, limit: num }),
    run: async (a) => { const rows = await listProcesses(a); return text(rows.length ? JSON.stringify(rows, null, 1) : 'No matching processes.'); } },
  // process lifecycle (ADR-0008)
  process_info: { d: 'Identity of any running process, including ones MCPRelay did not start: ref (pid@start; use it with stop_process / wait_for), pid, parent_pid, name, executable, command_line (secret-looking values masked) and its sha256, cwd, start_time. Select with ref or pid (plus expected fields: returns per-field checks and identity_match), or search by name / executable / command_line / command_line_contains / cwd (all given fields must match). Read-only.',
    s: P({ ...SELECTOR, limit: num }), run: processInfo },
  wait_for: { d: 'Wait up to timeout_ms (default 30000, max 110000) until: process_exited (ref), port_open (port on 127.0.0.1), http_ok (url on this machine; status, default any 2xx), file_updated (path; modified after modified_after, an ISO time, or exists). Returns met true/false.',
    s: P({ until: { type: 'string', enum: UNTIL }, ref: str, port: num, url: str, status: num, path: str, modified_after: str, timeout_ms: num }, ['until']), run: waitFor },
  stop_process: { d: 'Stop a process by verified identity; it need not have been started by MCPRelay. Identify it by ref, or by executable (full path) plus command_line, command_line_contains or cwd; PID or name alone is refused, exactly one process must match, and its start time is re-checked before acting, so a reused PID is never hit. graceful (default auto: Windows Ctrl+C then Ctrl+Break on its own console, else WM_CLOSE; Linux SIGTERM; or console_ctrl, close, sigterm, sigint, none) for up to graceful_timeout_ms (default 10000, max 60000), then terminates it only if force=true; tree (default true) includes its children. Returns status, stop_method, exit_code.',
    s: P({ ...SELECTOR, graceful: { type: 'string', enum: GRACEFUL }, graceful_timeout_ms: num, force: { type: 'boolean' }, tree: { type: 'boolean' } }), run: stopProcess },
  spawn_process: { d: 'Start a program directly, without a shell: executable, args (array of strings), cwd (default home), env (added to the node environment), log (file inside the file roots receiving stdout and stderr). It runs detached and keeps running when the node server restarts (outlives_node). Returns ref, pid and identity. For programs the user declared as targets, use target_restart / target_start.',
    s: P({ executable: str, args: { type: 'array', items: str }, cwd: str, env: { type: 'object', additionalProperties: str }, log: str }, ['executable']), run: spawnProcess },
  target_status: { d: 'Targets are long-running programs the user declared in targets_file (see list_capabilities environment); agents cannot change them. Without target: every target with its running instances. With target: instance identities, settings and current health.',
    s: P({ target: str }), run: targetStatus },
  target_start: { d: 'Start a declared target that is not running, exactly as declared, then verify its identity and health checks.', s: P({ target: str }, ['target']), run: targetStart },
  target_stop: { d: 'Stop the running instance of a declared target with its declared stop policy. expect_ref: act only if that exact instance is the running one. Not running is reported as status not_running.', s: P({ target: str, expect_ref: str }, ['target']), run: targetStop },
  target_restart: { d: 'Restart a declared target in one call: verify the running instance (expect_ref: must be that exact instance), stop it per the declared policy, start it as declared, verify the new identity and health checks. Returns status (restarted / started), old and new identity, stop_method, health_check. Partial outcomes are reported, never rolled back: stop_failed, stopped_not_started, exited_after_start, started_identity_mismatch, started_unhealthy. start_if_stopped (default true).',
    s: P({ target: str, expect_ref: str, start_if_stopped: { type: 'boolean' } }, ['target']), run: targetRestart },
  ...GITOPS.tools,
};
// ---------------------------------------------------------- risk classes --
// Clients (ChatGPT) cache a connector's tool list, so the exposed tools are a
// small fixed set: list_capabilities plus one invoke_<class> tool per risk
// class. Capabilities can change without a client-side refresh; each class
// tool carries the MCP ToolAnnotations of its class, so clients still ask the
// user before destructive or open-world actions. The server enforces classes:
// a capability is only run through its own class tool.
const CLASSES = {
  read: { title: 'Read (no changes)', covers: 'reads files, directories, file info, process output, command sessions, system processes, process identities, target status, node status and local Git repository state, or waits for a condition; never changes anything',
    hints: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  // ADR-0009: non-lossy changes. Git changes are listed here because every one names the
  // exact state it expects (compare-and-swap) and none forces or discards anything.
  write: { title: 'Create or change without data loss', covers: 'creates directories, and changes local Git repositories (fetch, checkout, branches/tags, worktrees, staging, commit, merge/cherry-pick/revert) only from an exact expected state, never forcing, overwriting or discarding anything; no push',
    hints: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  destructive: { title: 'Modify or delete files, stop or restart processes', covers: 'writes, overwrites, edits, moves or deletes files and folders, stops processes by verified identity, or starts, stops and restarts targets the user declared',
    hints: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } },
  exec: { title: 'Run commands and programs', covers: "runs shell commands or programs, or sends input to running processes, with the user's full rights",
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
  process_info:          ['Process identity',       'read'],
  wait_for:              ['Wait for condition',     'read'],
  target_status:         ['Target status',          'read'],
  create_directory:      ['Create directory',       'write'],
  write_file:            ['Write file',             'destructive'],
  edit_block:            ['Edit file',              'destructive'],
  move_file:             ['Move or rename',         'destructive'],
  remove_path:           ['Delete file or folder',  'destructive'],
  force_terminate:       ['Terminate process',      'destructive'],
  stop_process:          ['Stop process',           'destructive'],
  target_start:          ['Start target',           'destructive'],
  target_stop:           ['Stop target',            'destructive'],
  target_restart:        ['Restart target',         'destructive'],
  start_process:         ['Run command',            'exec'],
  interact_with_process: ['Send input to process',  'exec'],
  spawn_process:         ['Start program',          'exec'],
  ...GITOPS.meta,
};
const invokeTool = (cls) => `invoke_${cls}`;
const namesOf = (cls) => Object.keys(TOOLS).filter((n) => META[n][1] === cls);

const allCaps = () => Object.entries(TOOLS).map(([name, t]) => ({
  name, class: META[name][1], invoke_with: invokeTool(META[name][1]), title: META[name][0], description: t.d, args_schema: t.s,
}));
const catalogVersion = () => createHash('sha256').update(JSON.stringify(allCaps())).digest('hex').slice(0, 12);
function catalog(onlyClass, targets = []) {
  const all = allCaps();
  return {
    node: NODE_NAME, server_version: VERSION,
    // Hash of the complete catalog (capabilities, classes, schemas), the same
    // for every filtered view; clients may cache the catalog until it changes.
    catalog_version: catalogVersion(),
    view: onlyClass || 'all',
    environment: { os: OS_DESC, file_roots: ALLOWED, protected_paths: PROTECTED, read_only_paths: READ_ONLY.concat(WIN ? ['<drive>:\\$Recycle.Bin, System Volume Information, Recovery, Config.Msi, *.sys page/hibernate files'] : []),
      default_shell: shellLabel(), shells: SHELLS.available, working_directory: homedir(),
      // Programs the user declared for target_status / target_start / target_stop / target_restart.
      targets_file: TARGETS_FILE, targets, targets_help: TARGETS_HELP,
      // Local Git operations (git_* capabilities).
      git: GITOPS.environment(),
      notes: ['File capabilities only work inside file_roots, never touch protected_paths, and only read read_only_paths. This is a guardrail against mistakes, not a security boundary.',
        "Shell commands run with the user's full rights and are not limited by these lists.",
        'Processes are identified by ref "<pid>@<start>" (process_info, list_processes, spawn_process); acting on a ref re-checks it, so a PID reused by another process is never hit.',
        'targets are declared by the user in targets_file, which agents cannot change; for them prefer target_restart over stop_process + spawn_process.',
        'Restarting a long-running program: if it is a declared target, target_restart (one call). Otherwise process_info (get its ref and start details) -> stop_process (ref) -> spawn_process -> wait_for; for repeated or unattended restarts, ask the user to declare it as a target (environment.targets_help).',
        'Local Git work: git_status first, then a write-class git_* capability with the values it returned as expected_* (environment.git.rules). Prefer these over Git commands run through invoke_exec.'] },
    usage: 'Call the tool named in invoke_with (a gateway may prefix it, e.g. "<node>_invoke_read") with {"capability": name, "args": {...}}, args following args_schema. This list is current; tool descriptions cached by a client may be older. Capabilities, their classes and arguments can change at any time (server updates). If a call fails with next action refresh_catalog, or its error shows a catalog_version different from yours, call list_capabilities again and retry with the current catalog.',
    classes: Object.fromEntries(Object.entries(CLASSES).map(([c, v]) => [c, { invoke_with: invokeTool(c), covers: v.covers }])),
    errors: { format: 'Error [<code>]: <message> (next: <action>); also in result _meta["io.mcprelay/error"] = {code, action}',
      actions: NEXT, codes: ERRORS },
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
    if ((p.type === 'array' || p.type === 'object') && typeof x === 'string') { try { x = JSON.parse(x); } catch { /* reported below */ } }
    const ok = p.type === 'number' ? typeof x === 'number' && Number.isFinite(x)
      : p.type === 'array' ? Array.isArray(x) && (!p.items || x.every((i) => typeof i === p.items.type))
        : p.type === 'object' ? isObj(x) && (!p.additionalProperties?.type || Object.values(x).every((v) => typeof v === p.additionalProperties.type))
          : typeof x === p.type;
    if (!ok) return { error: `argument "${k}" must be a ${p.type}` };
    if (p.enum && !p.enum.includes(x)) return { error: `argument "${k}" must be one of: ${p.enum.join(', ')}` };
    out[k] = x;
  }
  for (const k of schema.required || []) if (out[k] === undefined) return { error: `missing required argument "${k}"` };
  return { args: out };
}

const EXPOSED = () => [
  { name: 'list_capabilities', title: 'List capabilities',
    description: `List everything this node can do right now: each capability with its risk class, the invoke_* tool to use, a description and its argument schema, plus the node environment (OS, file roots, shells). Call it once at the start of a conversation. Capabilities can change at any time: call it again whenever a call fails with next action refresh_catalog or an unexpected error, then retry with the current catalog. Optional: class (${Object.keys(CLASSES).join(', ')}).${envNote('file')}`,
    inputSchema: P({ class: { type: 'string', enum: Object.keys(CLASSES) } }),
    annotations: { title: 'List capabilities', ...CLASSES.read.hints } },
  ...Object.entries(CLASSES).map(([cls, c]) => ({
    name: invokeTool(cls), title: c.title,
    description: `Run one "${cls}" capability of this node: ${c.covers}. capability = a name from list_capabilities whose class is "${cls}" (currently: ${namesOf(cls).join(', ')}); args = that capability's arguments as a JSON object. Capabilities of another class are refused. Capabilities may be updated: if a call fails with next action refresh_catalog (unknown capability, wrong class, invalid args), call list_capabilities again and retry.${envNote(cls === 'exec' ? 'exec' : 'file')}`,
    inputSchema: P({ capability: { type: 'string', description: `Capability name (class "${cls}")` },
      args: { type: 'object', description: 'Arguments for the capability, per its args_schema in list_capabilities', additionalProperties: true } }, ['capability']),
    annotations: { title: c.title, ...c.hints },
  })),
];

// Lifecycle facts add the target name and the PIDs acted on (never command lines or arguments).
const auditOf = (f) => {
  if (!f) return {};
  const pid = f.old?.pid ?? f.pid; const out = {};
  if (f.target) out.target = f.target;
  if (Number.isInteger(pid)) out.pid = pid;
  if (Number.isInteger(f.new?.pid)) out.new_pid = f.new.pid;
  // Git changes: the resulting commit (an identity, not content).
  const head = f.commit ?? f.new?.head;
  if (typeof head === 'string' && /^[0-9a-f]{40,64}$/.test(head)) out.git_head = head;
  return out;
};

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
    done({ tool: name, cls, pid: auditPid, ...auditOf(result._meta?.['io.mcprelay/result']) });
    return result;
  } catch (e) {
    const code = codeOf(e);
    if (code === 'internal_error') log(`${name} failed:`, e?.stack || e);
    done({ tool: name, cls, err: code, ...auditOf(e?.facts) });
    return errorResult(code, e.message, e?.facts);
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
    const done = ({ tool: name, cls, err, pid, target, new_pid: newPid, git_head: gitHead }) => audit({ t: new Date(started).toISOString(), boot: BOOT_ID, call: callId, tool: name,
      ...(cls ? { cls } : {}), ...(target ? { target } : {}), ok: !err, ms: Date.now() - started, ...(pid ? { pid } : {}), ...(newPid ? { new_pid: newPid } : {}),
      ...(gitHead ? { git_head: gitHead } : {}), ...(err ? { err } : {}) });
    const tag = (r) => ({ ...r, _meta: { ...(r._meta || {}), 'io.mcprelay/call_id': `${BOOT_ID}-${callId}` } });
    if (tool === 'list_capabilities') {
      if (params.class !== undefined && !Object.hasOwn(CLASSES, params.class)) {
        done({ tool, err: 'invalid_args' }); return tag(errorResult('invalid_args', `class must be one of: ${Object.keys(CLASSES).join(', ')}`));
      }
      done({ tool });
      return tag(text(JSON.stringify(catalog(params.class, await targetsSummary()), null, 1)));
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
await Promise.all([detectShells(), GITOPS.detect()]); // before listening, so the first tools/list already names the right shell and Git
http.listen(Number(opt.port), opt.host, () => {
  log(`MCP endpoint http://${opt.host}:${opt.port}${opt.path} (v${VERSION}); allowed dirs: ${ALLOWED.join(', ')}; default shell: ${shellLabel()}; git: ${GITOPS.environment().version || 'not available'}; audit log: ${AUDIT || 'off'}`);
  if (!TOKEN_DIGEST) log('WARNING: MCPRELAY_BRIDGE_TOKEN not set; /mcp accepts unauthenticated local requests');
});
