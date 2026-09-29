#!/usr/bin/env node
// MCPRelay node capability server (module M1, ADR-0004): one process serving
// MCP over loopback HTTP in both protocol generations (2026-07-28 natively,
// 2025-era via the SDK's stateless fallback) and implementing the local tools
// itself (Desktop Commander-compatible names/arguments). Supervised by the tray
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
import { createHash, timingSafeEqual } from 'node:crypto';
import { homedir, hostname, arch, release } from 'node:os';
import { parseArgs } from 'node:util';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { Server, ProtocolError, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';

const VERSION = '1.1.0';
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
const norm = (p) => (WIN ? p.toLowerCase() : p);
const ALLOWED = (process.env.MCPRELAY_ALLOWED_DIRS || homedir()).split(WIN ? ';' : ':').filter(Boolean).map((d) => path.resolve(d));
async function realish(p) {
  // realpath of the longest existing prefix, so symlinks/junctions cannot escape the roots
  let cur = path.resolve(p); const rest = [];
  for (;;) {
    try { return path.join(await fs.realpath(cur), ...rest.reverse()); }
    catch { const parent = path.dirname(cur); if (parent === cur) return path.resolve(p); rest.push(path.basename(cur)); cur = parent; }
  }
}
async function allowedPath(p) {
  if (typeof p !== 'string' || !p) throw new ProtocolError(-32602, 'path is required');
  const real = await realish(p);
  const x = norm(real);
  const ok = ALLOWED.some((root) => { const r = norm(root); return x === r || x.startsWith(r.endsWith(path.sep) ? r : r + path.sep); });
  if (!ok) throw new Error(`Path not allowed: ${p}. Must be within one of these directories: ${ALLOWED.join(', ')}`);
  return real;
}

// ---------------------------------------------------------------- helpers --
const text = (t, isError = false) => {
  const s = t.length > MAX_RESULT_CHARS ? `${t.slice(0, MAX_RESULT_CHARS)}\n[truncated: result exceeded ${MAX_RESULT_CHARS} characters]` : t;
  return { content: [{ type: 'text', text: s }], ...(isError ? { isError: true } : {}) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (promise, ms, what) => {
  let timer;
  return Promise.race([promise, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000}s`)), ms); })])
    .finally(() => clearTimeout(timer));
};

async function listDir(dir, depth, prefix = '', out = []) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (e) { out.push(`[DENIED] ${prefix}(${e.code})`); return out; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (out.length >= 5000) { out.push('[WARNING] listing truncated at 5000 entries'); return out; }
    const rel = prefix + e.name;
    if (e.isDirectory()) {
      out.push(`[DIR] ${rel}`);
      if (depth > 1) await listDir(path.join(dir, e.name), depth - 1, rel + path.sep, out);
    } else out.push(`[FILE] ${rel}`);
  }
  return out;
}

async function searchFiles(root, namePattern, contentText, max) {
  // File names: glob (* and ?). Content: case-insensitive literal text, never a
  // user regex (a pathological pattern could block the event loop).
  const nameRe = namePattern ? new RegExp(`^${String(namePattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i') : null;
  const needle = contentText ? String(contentText).toLowerCase() : null;
  const hits = []; const stack = [root]; let visited = 0;
  while (stack.length && hits.length < max && visited < 200_000) {
    const dir = stack.pop();
    let entries; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      visited++;
      if (e.isSymbolicLink()) continue; // links/junctions could lead outside the allowed roots
      const full = path.join(dir, e.name);
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
  return hits;
}

// -------------------------------------------------------------- processes --
const sessions = new Map(); // pid -> { child, out, readPos, exitCode, shell, started }
const running = () => [...sessions.values()].filter((s) => s.exitCode === null).length;
function shellInvocation(command, shell) {
  if (WIN) {
    const sh = shell || 'powershell.exe';
    if (/cmd(\.exe)?$/i.test(sh)) return [sh, ['/d', '/s', '/c', `chcp 65001>nul & ${command}`]];
    // UTF-8 output regardless of the console code page (e.g. GBK on Chinese Windows).
    const prefix = '[Console]::OutputEncoding=[Text.Encoding]::UTF8;$OutputEncoding=[Text.Encoding]::UTF8;';
    return [sh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', prefix + command]];
  }
  return [shell || process.env.SHELL || '/bin/sh', ['-c', command]];
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
  if (typeof command !== 'string' || !command) throw new ProtocolError(-32602, 'command is required');
  if (running() >= MAX_RUNNING) return text(`Too many running processes (${MAX_RUNNING}); terminate some with force_terminate first.`, true);
  const [file, args] = shellInvocation(command, shell);
  const child = spawn(file, args, { cwd: homedir(), env: process.env, windowsHide: true, detached: !WIN, stdio: ['pipe', 'pipe', 'pipe'] });
  const s = { child, out: '', readPos: 0, exitCode: null, shell: path.basename(file), started: Date.now() };
  const append = (d) => {
    s.out += d.toString('utf8');
    if (s.out.length > MAX_SESSION_OUTPUT) { const cut = s.out.length - MAX_SESSION_OUTPUT; s.out = s.out.slice(cut); s.readPos = Math.max(0, s.readPos - cut); }
  };
  child.stdout.on('data', append); child.stderr.on('data', append);
  child.stdin.on('error', () => {}); // writing to a process that already exited must not crash the server
  child.on('exit', (code) => { s.exitCode = code ?? -1; setTimeout(() => sessions.delete(child.pid), EXITED_SESSION_TTL_MS).unref(); });
  const spawnError = await new Promise((r) => { child.once('spawn', () => r(null)); child.once('error', r); });
  if (spawnError || !child.pid) return text(`Failed to start (${spawnError?.message || 'unknown error'}): ${command}`, true);
  sessions.set(child.pid, s);
  await waitQuiet(s, Math.min(Math.max(timeoutMs, 0), CALL_TIMEOUT_MS - 5000));
  const status = s.exitCode === null ? '\nProcess still running; use read_process_output to get more.' : `\nProcess finished with exit code ${s.exitCode}.`;
  return text(`Process started with PID ${child.pid} (shell: ${s.shell})\nInitial output:\n${takeOutput(s)}${status}`);
}

// --------------------------------------------------- remove / hash / procs --
const STARTED_AT = Date.now();
const insideRoot = (x) => ALLOWED.some((root) => { const r = norm(root); return x.startsWith(r.endsWith(path.sep) ? r : r + path.sep); });

async function removePath(p, recursive) {
  if (typeof p !== 'string' || !p) throw new ProtocolError(-32602, 'path is required');
  // Resolve the PARENT (so links inside the path are resolved) but act on the entry itself:
  // removing a symlink/junction removes only the link, never its target.
  const abs = path.resolve(p);
  const target = path.join(await allowedPath(path.dirname(abs)), path.basename(abs));
  const x = norm(target);
  if (!insideRoot(x)) throw new Error(`Path not allowed: ${p}. Must be strictly inside one of: ${ALLOWED.join(', ')}`);
  if (ALLOWED.some((root) => { const r = norm(root); return r === x || r.startsWith(x + path.sep); })) {
    throw new Error(`Refusing to remove an allowed root (or a directory containing one): ${p}`);
  }
  let st;
  try { st = await fs.lstat(target); } catch (e) { if (e.code === 'ENOENT') return text(`Not found: ${p}`, true); throw e; }
  if (st.isSymbolicLink()) {
    try { await fs.unlink(target); } catch (e) { if (WIN && ['EPERM', 'EISDIR'].includes(e.code)) await fs.rmdir(target); else throw e; }
    return text(`Removed link ${p} (its target was not touched)`);
  }
  if (st.isDirectory()) {
    if (!recursive) {
      try { await fs.rmdir(target); } catch (e) { if (['ENOTEMPTY', 'EEXIST'].includes(e.code)) return text(`Directory not empty: ${p}. Pass recursive=true to remove it with its contents.`, true); throw e; }
      return text(`Removed empty directory ${p}`);
    }
    await fs.rm(target, { recursive: true, force: false }); // lstat-based: links inside are unlinked, not followed
    return text(`Removed directory ${p} and its contents`);
  }
  await fs.unlink(target);
  return text(`Removed file ${p}`);
}

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(p).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

// System-wide read-only process listing. Command lines are deliberately not
// returned: other programs' arguments can contain passwords or tokens.
async function listProcesses({ name, pid, limit = 50 }) {
  const max = Math.min(Math.max(1, Number(limit) || 50), 500);
  if (pid !== undefined && !Number.isInteger(pid)) throw new ProtocolError(-32602, 'pid must be an integer');
  if (name !== undefined && !/^[\w .+-]{1,100}$/.test(String(name))) throw new ProtocolError(-32602, 'name may contain only letters, digits, space, . _ + -');
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

// ------------------------------------------------------------------- tools --
const P = (props, required = []) => ({ type: 'object', properties: props, required });
const str = { type: 'string' }; const num = { type: 'number' };
const TOOLS = {
  node_status: { d: 'Status of this MCPRelay node runtime: version, PID, uptime, host, OS, allowed file roots and process-session counts. Contains no credentials.', s: P({}), ro: true,
    run: async () => text(JSON.stringify({
      server_version: VERSION, pid: process.pid, uptime_seconds: Math.round((Date.now() - STARTED_AT) / 1000),
      hostname: hostname(), os: `${process.platform} ${release()}`, arch: arch(), node_version: process.version,
      allowed_dirs: ALLOWED, sessions: sessions.size, running_sessions: running(),
    }, null, 2)) },
  list_directory: { d: 'List files and directories ([DIR]/[FILE]) up to `depth` levels (default 2).', s: P({ path: str, depth: num }, ['path']), ro: true,
    run: async (a) => text((await listDir(await allowedPath(a.path), Math.min(a.depth ?? 2, 10))).join('\n') || '(empty directory)') },
  read_file: { d: 'Read a UTF-8 text file by lines. offset >= 0: first line (0-based); offset < 0: the last |offset| lines (tail, e.g. -50 for logs). length: max lines (default 1000).', s: P({ path: str, offset: num, length: num }, ['path']), ro: true,
    run: async (a) => {
      const p = await allowedPath(a.path); const st = await fs.stat(p);
      if (st.isDirectory()) return text(`${a.path} is a directory; use list_directory`, true);
      if (st.size > 64 * 1024 * 1024) return text(`File too large to read (${st.size} bytes)`, true);
      const buf = await fs.readFile(p);
      if (buf.subarray(0, 8000).includes(0)) return text(`Binary file (${buf.length} bytes) not shown: ${a.path}`, true);
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
      if (typeof a.content !== 'string') throw new ProtocolError(-32602, 'content must be a string');
      const p = await allowedPath(a.path); await fs.mkdir(path.dirname(p), { recursive: true });
      if (a.mode === 'append') await fs.appendFile(p, a.content, 'utf8');
      else { const tmp = `${p}.mcprelay-${process.pid}.tmp`; await fs.writeFile(tmp, a.content, 'utf8'); await fs.rename(tmp, p); } // atomic replace
      return text(`Wrote ${Buffer.byteLength(a.content)} bytes to ${a.path} (${a.mode || 'rewrite'})`);
    } },
  edit_block: { d: 'Replace exact text in a file. expected_replacements (default 1) must equal the number of occurrences.', s: P({ file_path: str, old_string: str, new_string: str, expected_replacements: num }, ['file_path', 'old_string', 'new_string']),
    run: async (a) => {
      const p = await allowedPath(a.file_path); const src = await fs.readFile(p, 'utf8');
      const n = a.old_string ? src.split(a.old_string).length - 1 : 0; const want = a.expected_replacements ?? 1;
      if (!a.old_string || n !== want) return text(`Found ${n} occurrence(s) of old_string, expected ${want}; no changes made.`, true);
      const tmp = `${p}.mcprelay-${process.pid}.tmp`; await fs.writeFile(tmp, src.split(a.old_string).join(a.new_string), 'utf8'); await fs.rename(tmp, p);
      return text(`Replaced ${n} occurrence(s) in ${a.file_path}`);
    } },
  create_directory: { d: 'Create a directory (and parents).', s: P({ path: str }, ['path']),
    run: async (a) => { await fs.mkdir(await allowedPath(a.path), { recursive: true }); return text(`Directory ready: ${a.path}`); } },
  move_file: { d: 'Move or rename a file or directory.', s: P({ source: str, destination: str }, ['source', 'destination']),
    run: async (a) => { await fs.rename(await allowedPath(a.source), await allowedPath(a.destination)); return text(`Moved ${a.source} -> ${a.destination}`); } },
  remove_path: { d: 'Delete a file, an empty directory, or (recursive=true) a directory with its contents. Only inside the allowed roots; never an allowed root itself. Links are removed without touching their targets.', s: P({ path: str, recursive: { type: 'boolean' } }, ['path']),
    run: async (a) => removePath(a.path, a.recursive === true) },
  get_file_info: { d: 'File or directory metadata; sha256=true adds the file\'s SHA-256.', s: P({ path: str, sha256: { type: 'boolean' } }, ['path']), ro: true,
    run: async (a) => { const p = await allowedPath(a.path); const st = await fs.stat(p);
      const info = { size: st.size, type: st.isDirectory() ? 'directory' : 'file', modified: st.mtime, created: st.birthtime };
      if (a.sha256 === true && !st.isDirectory()) info.sha256 = await sha256File(p);
      return text(JSON.stringify(info, null, 2)); } },
  search_files: { d: 'Search files under path by file-name glob (pattern, e.g. *.ts) and/or case-insensitive text (content_pattern). Symbolic links are not followed.', s: P({ path: str, pattern: str, content_pattern: str, max_results: num }, ['path']), ro: true,
    run: async (a) => { const hits = await searchFiles(await allowedPath(a.path), a.pattern, a.content_pattern, Math.min(a.max_results ?? 100, 1000)); return text(hits.join('\n') || 'No matches.'); } },
  start_process: { d: 'Run a shell command (PowerShell on Windows by default; shell: "cmd.exe" for cmd). Returns when the command exits, its output goes quiet, or after timeout_ms; long-running processes keep running and are addressed by PID.', s: P({ command: str, timeout_ms: num, shell: str }, ['command', 'timeout_ms']),
    run: startProcess },
  read_process_output: { d: 'Read new output of a process started with start_process (waits up to timeout_ms for new output).', s: P({ pid: num, timeout_ms: num }, ['pid']), ro: true,
    run: async (a) => { const s = sessions.get(a.pid); if (!s) return text(`No session found for PID ${a.pid}`, true);
      await waitQuiet(s, Math.min(a.timeout_ms ?? 5000, 60_000)); const out = takeOutput(s);
      return text(`${out || '(no new output)'}${s.exitCode === null ? '' : `\nProcess finished with exit code ${s.exitCode}.`}`); } },
  interact_with_process: { d: 'Send a line of input to a running process and return the output it produces.', s: P({ pid: num, input: str, timeout_ms: num }, ['pid', 'input']),
    run: async (a) => { const s = sessions.get(a.pid); if (!s || s.exitCode !== null) return text(`No active session found for PID ${a.pid}`, true);
      takeOutput(s); s.child.stdin.write(String(a.input).endsWith('\n') ? String(a.input) : `${a.input}\n`);
      await waitQuiet(s, Math.min(a.timeout_ms ?? 8000, 60_000)); return text(takeOutput(s) || '(no output)'); } },
  force_terminate: { d: 'Terminate a process started with start_process, including its child processes.', s: P({ pid: num }, ['pid']),
    run: async (a) => { const s = sessions.get(a.pid); if (!s || s.exitCode !== null) return text(`No active session found for PID ${a.pid}`, true);
      await killTree(a.pid); return text(`Terminated process ${a.pid}`); } },
  list_sessions: { d: 'List processes started with start_process.', s: P({}), ro: true,
    run: async () => text([...sessions.entries()].map(([pid, s]) => `PID: ${pid}, ${s.exitCode === null ? 'running' : `exited (${s.exitCode})`}, runtime: ${Math.round((Date.now() - s.started) / 1000)}s`).join('\n') || 'No sessions.') },
  list_processes: { d: 'List system processes (read-only), largest memory first: pid, parent_pid, name, path, start_time, cpu_time (s), rss (bytes). Filter by name (substring) or pid; limit (default 50, max 500). Command lines are not returned.', s: P({ name: str, pid: num, limit: num }), ro: true,
    run: async (a) => { const rows = await listProcesses(a); return text(rows.length ? JSON.stringify(rows, null, 1) : 'No matching processes.'); } },
};
const TOOL_LIST = Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.d, inputSchema: t.s, annotations: { readOnlyHint: !!t.ro } }));

function mcpServer() {
  const server = new Server({ name: 'mcprelay-node', version: VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler('tools/list', async () => ({ tools: TOOL_LIST }));
  server.setRequestHandler('tools/call', async (req) => {
    const t = TOOLS[req.params.name];
    if (!t) throw new ProtocolError(-32602, `Unknown tool: ${req.params.name}`);
    try { return await withTimeout(t.run(req.params.arguments || {}), CALL_TIMEOUT_MS, req.params.name); }
    catch (e) { if (e instanceof ProtocolError) throw e; return text(`Error: ${e.message}`, true); }
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
http.listen(Number(opt.port), opt.host, () => {
  log(`MCP endpoint http://${opt.host}:${opt.port}${opt.path} (v${VERSION}); allowed dirs: ${ALLOWED.join(', ')}`);
  if (!TOKEN_DIGEST) log('WARNING: MCPRELAY_BRIDGE_TOKEN not set; /mcp accepts unauthenticated local requests');
});
