#!/usr/bin/env node
// MCPRelay "desk" PROTOTYPE: a minimal, self-contained local capability server
// meant to be compared against Desktop Commander + bridge (see ADR-0004).
//
// One process serves MCP over loopback HTTP in both protocol generations
// (2026-07-28 natively, 2025-era via the SDK's stateless fallback) and
// implements the core tools itself, with Desktop Commander-compatible names and
// arguments so the same tests and clients work unchanged.
//
//   MCPRELAY_BRIDGE_TOKEN=... node desk.mjs [--port 18001] [--host 127.0.0.1]
//   MCPRELAY_ALLOWED_DIRS=<dir>[;<dir>...]   file-tool roots (default: user home)

import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Server, ProtocolError, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';

const VERSION = '0.1.0-prototype';
const { values: opt } = parseArgs({
  options: { port: { type: 'string', default: '18001' }, host: { type: 'string', default: '127.0.0.1' }, path: { type: 'string', default: '/mcp' } },
});
const WIN = process.platform === 'win32';
const log = (...a) => console.error(new Date().toISOString(), '[desk]', ...a);

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
  // realpath of the longest existing prefix, so symlinks cannot escape the roots
  let cur = path.resolve(p); const rest = [];
  for (;;) {
    try { return path.join(await fs.realpath(cur), ...rest.reverse()); }
    catch { const parent = path.dirname(cur); if (parent === cur) return path.resolve(p); rest.push(path.basename(cur)); cur = parent; }
  }
}
async function allowedPath(p) {
  if (typeof p !== 'string' || !p) throw new ProtocolError(-32602, 'path is required');
  const real = await realish(p);
  const ok = ALLOWED.some((root) => { const r = norm(root); const x = norm(real); return x === r || x.startsWith(r.endsWith(path.sep) ? r : r + path.sep); });
  if (!ok) throw new Error(`Path not allowed: ${p}. Must be within one of these directories: ${ALLOWED.join(', ')}`);
  return real;
}

// ---------------------------------------------------------------- helpers --
const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_SESSION_OUTPUT = 2 * 1024 * 1024;

async function listDir(dir, depth, prefix = '') {
  const out = [];
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (e) { return [`[DENIED] ${prefix}(${e.code})`]; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    const rel = prefix + e.name;
    if (e.isDirectory()) {
      out.push(`[DIR] ${rel}`);
      if (depth > 1) out.push(...await listDir(path.join(dir, e.name), depth - 1, rel + path.sep));
    } else out.push(`[FILE] ${rel}`);
    if (out.length > 5000) { out.push('[WARNING] listing truncated at 5000 entries'); break; }
  }
  return out;
}

async function searchFiles(root, namePattern, contentPattern, max) {
  const nameRe = namePattern ? new RegExp(namePattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.'), 'i') : null;
  const contentRe = contentPattern ? new RegExp(contentPattern, 'i') : null;
  const hits = []; const stack = [root];
  while (stack.length && hits.length < max) {
    const dir = stack.pop();
    let entries; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!['node_modules', '.git'].includes(e.name)) stack.push(full); continue; }
      if (nameRe && !nameRe.test(e.name)) continue;
      if (!contentRe) { hits.push(full); } else {
        try {
          const st = await fs.stat(full); if (st.size > 5 * 1024 * 1024) continue;
          const lines = (await fs.readFile(full, 'utf8')).split(/\r?\n/);
          lines.forEach((l, i) => { if (hits.length < max && contentRe.test(l)) hits.push(`${full}:${i + 1}: ${l.slice(0, 200)}`); });
        } catch { /* unreadable */ }
      }
      if (hits.length >= max) break;
    }
  }
  return hits;
}

// -------------------------------------------------------------- processes --
const sessions = new Map(); // pid -> { child, out, readPos, exitCode, shell, started }
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
    if (WIN) execFile('taskkill', ['/T', '/F', '/PID', String(pid)], () => resolve());
    else { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } resolve(); }
  });
}
async function waitForOutput(s, timeoutMs) {
  const start = Date.now(); const from = s.out.length;
  while (Date.now() - start < timeoutMs && s.exitCode === null && s.out.length === from) await sleep(50);
  // small grace period to collect the rest of a burst
  if (s.out.length > from) await sleep(100);
}
function takeOutput(s) {
  const chunk = s.out.slice(s.readPos); s.readPos = s.out.length; return chunk;
}
async function startProcess({ command, timeout_ms: timeoutMs = 10000, shell }) {
  if (typeof command !== 'string' || !command) throw new ProtocolError(-32602, 'command is required');
  const [file, args] = shellInvocation(command, shell);
  const child = spawn(file, args, { cwd: homedir(), env: process.env, windowsHide: true, detached: !WIN, stdio: ['pipe', 'pipe', 'pipe'] });
  const s = { child, out: '', readPos: 0, exitCode: null, shell: path.basename(file), started: Date.now() };
  const append = (d) => { s.out += d.toString('utf8'); if (s.out.length > MAX_SESSION_OUTPUT) { const cut = s.out.length - MAX_SESSION_OUTPUT; s.out = s.out.slice(cut); s.readPos = Math.max(0, s.readPos - cut); } };
  child.stdout.on('data', append); child.stderr.on('data', append);
  child.on('exit', (code) => { s.exitCode = code ?? -1; setTimeout(() => sessions.delete(child.pid), 10 * 60 * 1000).unref(); });
  await new Promise((r) => { child.once('spawn', r); child.once('error', r); });
  if (!child.pid) return text(`Failed to start: ${command}`, true);
  sessions.set(child.pid, s);
  // Return when the process exits, when it has produced output and then gone
  // quiet (e.g. a REPL prompt), or at timeout_ms.
  const start = Date.now();
  let seen = 0; let quietSince = Date.now();
  while (Date.now() - start < timeoutMs && s.exitCode === null) {
    await sleep(50);
    if (s.out.length !== seen) { seen = s.out.length; quietSince = Date.now(); }
    else if (seen > 0 && Date.now() - quietSince >= 400) break;
  }
  const status = s.exitCode === null ? '\nProcess still running; use read_process_output to get more.' : `\nProcess finished with exit code ${s.exitCode}.`;
  return text(`Process started with PID ${child.pid} (shell: ${s.shell})\nInitial output:\n${takeOutput(s)}${status}`);
}

// ------------------------------------------------------------------- tools --
const P = (props, required = []) => ({ type: 'object', properties: props, required });
const str = { type: 'string' }; const num = { type: 'number' };
const TOOLS = {
  list_directory: { d: 'List files and directories ([DIR]/[FILE]) up to `depth` levels.', s: P({ path: str, depth: num }, ['path']), ro: true,
    run: async (a) => text((await listDir(await allowedPath(a.path), a.depth ?? 2)).join('\n') || '(empty directory)') },
  read_file: { d: 'Read a text file by lines. offset: first line (0-based); length: max lines (default 1000).', s: P({ path: str, offset: num, length: num }, ['path']), ro: true,
    run: async (a) => {
      const p = await allowedPath(a.path); const buf = await fs.readFile(p);
      if (buf.subarray(0, 8000).includes(0)) return text(`Binary file (${buf.length} bytes) not shown: ${a.path}`, true);
      const lines = buf.toString('utf8').split(/\r?\n/); const off = Math.max(0, a.offset ?? 0); const len = a.length ?? 1000;
      const part = lines.slice(off, off + len);
      return text(`[Reading ${part.length} lines from line ${off} (total: ${lines.length} lines, ${Math.max(0, lines.length - off - part.length)} remaining)]\n\n${part.join('\n')}`);
    } },
  write_file: { d: 'Write (mode=rewrite, default) or append (mode=append) text to a file.', s: P({ path: str, content: str, mode: { type: 'string', enum: ['rewrite', 'append'] } }, ['path', 'content']),
    run: async (a) => { const p = await allowedPath(a.path); await fs.mkdir(path.dirname(p), { recursive: true });
      await (a.mode === 'append' ? fs.appendFile(p, a.content, 'utf8') : fs.writeFile(p, a.content, 'utf8')); return text(`Wrote ${Buffer.byteLength(a.content)} bytes to ${a.path} (${a.mode || 'rewrite'})`); } },
  edit_block: { d: 'Replace exact text in a file. expected_replacements (default 1) must match the number of occurrences.', s: P({ file_path: str, old_string: str, new_string: str, expected_replacements: num }, ['file_path', 'old_string', 'new_string']),
    run: async (a) => {
      const p = await allowedPath(a.file_path); const src = await fs.readFile(p, 'utf8'); const n = src.split(a.old_string).length - 1; const want = a.expected_replacements ?? 1;
      if (!a.old_string || n !== want) return text(`Found ${n} occurrence(s) of old_string, expected ${want}; no changes made.`, true);
      await fs.writeFile(p, src.split(a.old_string).join(a.new_string), 'utf8'); return text(`Replaced ${n} occurrence(s) in ${a.file_path}`);
    } },
  create_directory: { d: 'Create a directory (and parents).', s: P({ path: str }, ['path']),
    run: async (a) => { await fs.mkdir(await allowedPath(a.path), { recursive: true }); return text(`Directory ready: ${a.path}`); } },
  move_file: { d: 'Move or rename a file or directory.', s: P({ source: str, destination: str }, ['source', 'destination']),
    run: async (a) => { await fs.rename(await allowedPath(a.source), await allowedPath(a.destination)); return text(`Moved ${a.source} -> ${a.destination}`); } },
  get_file_info: { d: 'File or directory metadata.', s: P({ path: str }, ['path']), ro: true,
    run: async (a) => { const st = await fs.stat(await allowedPath(a.path));
      return text(JSON.stringify({ size: st.size, type: st.isDirectory() ? 'directory' : 'file', modified: st.mtime, created: st.birthtime }, null, 2)); } },
  search_files: { d: 'Search files under path by name glob (pattern, e.g. *.ts) and/or content regex (content_pattern).', s: P({ path: str, pattern: str, content_pattern: str, max_results: num }, ['path']), ro: true,
    run: async (a) => { const hits = await searchFiles(await allowedPath(a.path), a.pattern, a.content_pattern, Math.min(a.max_results ?? 100, 1000)); return text(hits.join('\n') || 'No matches.'); } },
  start_process: { d: 'Run a shell command (PowerShell on Windows by default). Waits up to timeout_ms for output/exit; long-running processes keep running and are addressed by PID.', s: P({ command: str, timeout_ms: num, shell: str }, ['command', 'timeout_ms']),
    run: startProcess },
  read_process_output: { d: 'Read new output of a process started with start_process (waits up to timeout_ms for new output).', s: P({ pid: num, timeout_ms: num }, ['pid']), ro: true,
    run: async (a) => { const s = sessions.get(a.pid); if (!s) return text(`No session found for PID ${a.pid}`, true);
      await waitForOutput(s, a.timeout_ms ?? 5000); const out = takeOutput(s);
      return text(`${out || '(no new output)'}${s.exitCode === null ? '' : `\nProcess finished with exit code ${s.exitCode}.`}`); } },
  interact_with_process: { d: 'Send a line of input to a running process and return the output it produces.', s: P({ pid: num, input: str, timeout_ms: num }, ['pid', 'input']),
    run: async (a) => { const s = sessions.get(a.pid); if (!s || s.exitCode !== null) return text(`No active session found for PID ${a.pid}`, true);
      takeOutput(s); s.child.stdin.write(a.input.endsWith('\n') ? a.input : a.input + '\n'); await waitForOutput(s, a.timeout_ms ?? 8000); return text(takeOutput(s) || '(no output)'); } },
  force_terminate: { d: 'Terminate a process started with start_process, including its child processes.', s: P({ pid: num }, ['pid']),
    run: async (a) => { const s = sessions.get(a.pid); if (!s || s.exitCode !== null) return text(`No active session found for PID ${a.pid}`, true);
      await killTree(a.pid); return text(`Terminated process ${a.pid}`); } },
  list_sessions: { d: 'List processes started with start_process.', s: P({}), ro: true,
    run: async () => text([...sessions.entries()].map(([pid, s]) => `PID: ${pid}, ${s.exitCode === null ? 'running' : `exited (${s.exitCode})`}, runtime: ${Math.round((Date.now() - s.started) / 1000)}s`).join('\n') || 'No sessions.') },
};
const TOOL_LIST = Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.d, inputSchema: t.s, annotations: { readOnlyHint: !!t.ro } }));

function mcpServer() {
  const server = new Server({ name: 'mcprelay-desk', version: VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler('tools/list', async () => ({ tools: TOOL_LIST }));
  server.setRequestHandler('tools/call', async (req) => {
    const t = TOOLS[req.params.name];
    if (!t) throw new ProtocolError(-32602, `Unknown tool: ${req.params.name}`);
    try { return await t.run(req.params.arguments || {}); }
    catch (e) { if (e instanceof ProtocolError) throw e; return text(`Error: ${e.message}`, true); }
  });
  return server;
}

// -------------------------------------------------------------------- HTTP --
const handler = toNodeHandler(createMcpHandler(mcpServer)); // 2026-07-28 + stateless 2025-era fallback
const http = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/healthz' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ desk: VERSION, dc: 'up', sessions: sessions.size }));
    return;
  }
  if (url.pathname !== opt.path) { res.writeHead(404).end(); return; }
  if (!authorized(req)) { res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } })); return; }
  await handler(req, res);
});
const shutdown = async () => { for (const pid of sessions.keys()) await killTree(pid); process.exit(0); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
http.listen(Number(opt.port), opt.host, () => {
  log(`MCP endpoint http://${opt.host}:${opt.port}${opt.path}; allowed dirs: ${ALLOWED.join(', ')}`);
  if (!TOKEN_DIGEST) log('WARNING: MCPRELAY_BRIDGE_TOKEN not set; /mcp accepts unauthenticated local requests');
});
