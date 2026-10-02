#!/usr/bin/env node
// Process lifecycle checks (ADR-0008): identity-checked process_info /
// stop_process / spawn_process / wait_for and the declared target_* capabilities.
// Runs on the node's own host: it starts "foreign" processes itself and writes the
// targets file the server reads (MCPRELAY_TARGETS).
//
//   node tests/process-lifecycle.mjs --url http://127.0.0.1:18001/mcp --fixture <dir inside the file roots>
//     --targets <the server's MCPRELAY_TARGETS file> [--token-env VAR]
//
// Exit code 0 only if every check passes.

import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const { values: opt } = parseArgs({ options: { url: { type: 'string' }, fixture: { type: 'string' }, targets: { type: 'string' }, 'token-env': { type: 'string' } } });
if (!opt.url || !opt.fixture || !opt.targets) {
  console.error('usage: process-lifecycle.mjs --url <mcp url> --fixture <dir> --targets <targets file> [--token-env VAR]');
  process.exit(2);
}
const WIN = process.platform === 'win32';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NODE = process.execPath;
const RESIDENT = path.join(opt.fixture, 'resident.mjs');
const base = 18700 + Math.floor(Math.random() * 200);
const PORT = { foreign: base, spawned: base + 1, stubborn: base + 2, target: base + 3 };

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
const brief = (s) => JSON.stringify(s.length > 300 ? `${s.slice(0, 300)}…` : s);

const headers = {};
if (opt['token-env']) headers.Authorization = `Bearer ${process.env[opt['token-env']]}`;
const client = new Client({ name: 'mcprelay-lifecycle', version: '0.1.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
await client.connect(new StreamableHTTPClientTransport(new URL(opt.url), { requestInit: { headers } }));
const cat = async () => JSON.parse((await client.callTool({ name: 'list_capabilities', arguments: {} })).content[0].text);
const VIA = new Map((await cat()).capabilities.map((c) => [c.name, c.invoke_with]));
// {ok, text, code, facts}: facts = the JSON result, or the facts that follow an error line.
async function call(name, args) {
  const res = await client.callTool({ name: VIA.get(name) || 'invoke_read', arguments: { capability: name, args } });
  const t = res.content.map((c) => c.text).join('\n');
  const code = res.isError ? (/^Error \[(\w+)\]/.exec(t) || [])[1] : null;
  let facts = null;
  try { facts = JSON.parse(res.isError ? t.slice(t.indexOf('\n') + 1) : t); } catch { /* plain text */ }
  return { ok: !res.isError, text: t, code, facts };
}
const portOpen = (port) => new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port }); s.setTimeout(1000);
  s.once('connect', () => { s.destroy(); resolve(true); }); s.once('error', () => resolve(false)); s.once('timeout', () => { s.destroy(); resolve(false); });
});
async function waitPort(port, up = true, ms = 15000) {
  for (const until = Date.now() + ms; Date.now() < until; await sleep(200)) if ((await portOpen(port)) === up) return;
  throw new Error(`port ${port} not ${up ? 'open' : 'closed'} after ${ms} ms`);
}
const alive = async (ref) => { const r = await call('process_info', { ref }); return r.ok; };

await fs.mkdir(opt.fixture, { recursive: true });
await fs.writeFile(RESIDENT, `import http from 'node:http';
const port = Number(process.argv[2]); const stubborn = process.argv.includes('--stubborn');
const srv = http.createServer((q, r) => r.end('ok')).listen(port, '127.0.0.1', () => console.log('listening', port));
for (const s of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(s, () => { console.log('got', s); if (!stubborn) { srv.close(); process.exit(0); } });
setInterval(() => {}, 1000);
`);
const cleanup = new Set(); // refs to force-stop at the end

// --- a process MCPRelay did not start --------------------------------------
const foreign = spawn(NODE, [RESIDENT, String(PORT.foreign)], { cwd: opt.fixture, detached: true, stdio: 'ignore', windowsHide: true });
foreign.unref();
await waitPort(PORT.foreign);
let fref = null;

await check('process_info reads the identity of a process MCPRelay did not start', async () => {
  const r = await call('process_info', { pid: foreign.pid, executable: NODE, command_line_contains: 'resident.mjs', cwd: opt.fixture });
  expect(r.ok && r.facts.identity_match === true, brief(r.text));
  expect(r.facts.ref?.startsWith(`${foreign.pid}@`) && /resident\.mjs/.test(r.facts.command_line) && r.facts.start_time, brief(r.text));
  fref = r.facts.ref; cleanup.add(fref);
  const l = await call('list_processes', { pid: foreign.pid });
  expect(l.ok && JSON.parse(l.text)[0].ref === fref, `list_processes ref differs: ${brief(l.text)}`);
  return fref;
});

await check('process_info reports a mismatch per field (fail-closed)', async () => {
  const r = await call('process_info', { pid: foreign.pid, executable: WIN ? 'C:\\nowhere\\node.exe' : '/nowhere/node', command_line_contains: 'resident.mjs' });
  expect(r.ok && r.facts.identity_match === false && r.facts.checks.executable === false && r.facts.checks.command_line_contains === true, brief(r.text));
});

await check('stop_process refuses PID alone', async () => {
  const r = await call('stop_process', { pid: foreign.pid, force: true });
  expect(r.code === 'weak_identity' && /next: fix the arguments/.test(r.text), brief(r.text));
  expect(await alive(fref), 'process was stopped');
});

await check('stop_process refuses a mismatching identity', async () => {
  const r = await call('stop_process', { ref: fref, command_line_contains: 'something-else', force: true });
  expect(r.code === 'identity_mismatch' && /next: stop and ask the user/.test(r.text), brief(r.text));
  expect(await alive(fref), 'process was stopped');
});

await check('a reused PID is never hit (stale ref)', async () => {
  const stale = `${foreign.pid}@${WIN ? '1' : 'deadbeef.1'}`;
  const r = await call('stop_process', { ref: stale, force: true });
  expect(r.code === 'identity_mismatch' && /another process/.test(r.text), brief(r.text));
  const i = await call('process_info', { ref: stale });
  expect(i.code === 'not_found', brief(i.text));
  expect(await alive(fref), 'process was stopped');
});

await check('stop_process stops it (graceful where possible, force only when allowed)', async () => {
  let r = await call('stop_process', { ref: fref, graceful_timeout_ms: 5000 });
  if (!r.ok) {
    // Windows: a detached process has no console and no window, so there is no graceful method.
    expect(WIN && r.code === 'graceful_unavailable' && r.facts?.status === 'still_running', brief(r.text));
    expect(await alive(fref), 'touched although force was not allowed');
    r = await call('stop_process', { ref: fref, graceful_timeout_ms: 1000, force: true });
  }
  expect(r.ok && r.facts.status === 'stopped', brief(r.text));
  await waitPort(PORT.foreign, false);
  cleanup.delete(fref);
  return `${r.facts.stop_method}${r.facts.graceful_signal ? ` (${r.facts.graceful_signal})` : ''}`;
});

await check('the node server itself cannot be stopped', async () => {
  const st = JSON.parse((await call('node_status', {})).text);
  const i = await call('process_info', { pid: st.pid });
  const r = await call('stop_process', { ref: i.facts.ref, force: true });
  expect(r.code === 'protected_process', brief(r.text));
});

// --- spawn_process + wait_for ---------------------------------------------------
const LOG = path.join(opt.fixture, 'spawned.log');
await check('spawn_process starts a program and stop_process stops it gracefully', async () => {
  await fs.rm(LOG, { force: true });
  const s = await call('spawn_process', { executable: NODE, args: [RESIDENT, String(PORT.spawned)], cwd: opt.fixture, log: LOG });
  expect(s.ok && s.facts.status === 'started' && s.facts.ref, brief(s.text));
  cleanup.add(s.facts.ref);
  const w = await call('wait_for', { until: 'http_ok', url: `http://127.0.0.1:${PORT.spawned}/`, timeout_ms: 15000 });
  expect(w.ok && w.facts.met === true, brief(w.text));
  const r = await call('stop_process', { ref: s.facts.ref, graceful_timeout_ms: 8000 });
  expect(r.ok && r.facts.status === 'stopped' && r.facts.stop_method === 'graceful', brief(r.text));
  cleanup.delete(s.facts.ref);
  await sleep(300);
  const log = await fs.readFile(LOG, 'utf8');
  expect(/listening/.test(log) && /got SIG(INT|TERM)/.test(log), `log: ${brief(log)}`);
  return `outlives_node ${s.facts.outlives_node}; ${r.facts.graceful_signal}`;
});

await check('a process that ignores a graceful stop: stop_timeout, then force', async () => {
  const s = await call('spawn_process', { executable: NODE, args: [RESIDENT, String(PORT.stubborn), '--stubborn'], cwd: opt.fixture });
  expect(s.ok, brief(s.text)); cleanup.add(s.facts.ref);
  await waitPort(PORT.stubborn);
  const r = await call('stop_process', { ref: s.facts.ref, graceful_timeout_ms: 1500 });
  expect(r.code === 'stop_timeout' && r.facts?.status === 'still_running', brief(r.text));
  expect(await alive(s.facts.ref), 'killed although force was not allowed');
  const f = await call('stop_process', { ref: s.facts.ref, graceful: 'none', force: true });
  expect(f.ok && f.facts.stop_method === 'forced', brief(f.text));
  const w = await call('wait_for', { until: 'process_exited', ref: s.facts.ref, timeout_ms: 10000 });
  expect(w.ok && w.facts.met === true, brief(w.text));
  cleanup.delete(s.facts.ref);
});

await check('spawn_process reports a program that exits at once', async () => {
  const r = await call('spawn_process', { executable: NODE, args: [path.join(opt.fixture, 'no-such-script.mjs')], cwd: opt.fixture, log: path.join(opt.fixture, 'bad.log') });
  expect(r.code === 'process_exited' && r.facts?.status === 'exited_early' && /Cannot find module/.test(r.facts.log_tail || ''), brief(r.text));
});

// --- declared targets --------------------------------------------------------
const TLOG = path.join(opt.fixture, 'target.log');
const targets = { targets: { lc: {
  description: 'lifecycle test resident',
  match: { executable: NODE, command_line_contains: `resident.mjs ${PORT.target}` },
  start: { executable: NODE, args: [RESIDENT, String(PORT.target)], cwd: opt.fixture, env: { LC_TEST: '1' }, log: TLOG },
  stop: { graceful: 'auto', graceful_timeout_s: 10, force: true },
  health: [{ http: `http://127.0.0.1:${PORT.target}/` }, { tcp: PORT.target }], health_timeout_s: 20,
} } };
await fs.writeFile(opt.targets, JSON.stringify(targets, null, 2));
let r1 = null; let r2 = null;

await check('targets are listed in the catalog and their file is protected', async () => {
  const c = await cat();
  expect(c.environment.targets_file && c.environment.targets.some((t) => t.name === 'lc' && t.can_start), JSON.stringify(c.environment.targets));
  const r = await call('read_file', { path: opt.targets });
  expect(r.code === 'protected_path' || r.code === 'path_not_allowed', brief(r.text));
});

await check('target_restart starts a target that is not running', async () => {
  const st = await call('target_status', {});
  expect(st.ok && st.facts.targets.find((t) => t.name === 'lc')?.running.length === 0, brief(st.text));
  const r = await call('target_restart', { target: 'lc' });
  expect(r.ok && r.facts.status === 'started' && r.facts.new_identity_verified && r.facts.health_check === 'passed', brief(r.text));
  r1 = r.facts.new.ref; cleanup.add(r1);
  return r1;
});

await check('target_start refuses a running target', async () => {
  const r = await call('target_start', { target: 'lc' });
  expect(r.code === 'already_running', brief(r.text));
});

await check('target_restart with expect_ref: verified stop, start, identity and health', async () => {
  const r = await call('target_restart', { target: 'lc', expect_ref: r1 });
  expect(r.ok && r.facts.status === 'restarted' && r.facts.old.ref === r1 && r.facts.old_identity_verified, brief(r.text));
  expect(r.facts.new.ref !== r1 && r.facts.new_identity_verified && r.facts.health_check === 'passed', brief(r.text));
  expect(r.facts.stop_method === 'graceful' || (WIN && r.facts.stop_method), brief(r.text));
  cleanup.delete(r1); r2 = r.facts.new.ref; cleanup.add(r2);
  expect(!(await alive(r1)) && (await alive(r2)), 'old/new instance state wrong');
  return `${r1} -> ${r2} (${r.facts.stop_method})`;
});

await check('target_restart with a stale expect_ref does nothing', async () => {
  const r = await call('target_restart', { target: 'lc', expect_ref: r1 });
  expect(r.code === 'identity_mismatch' && r.facts?.running?.[0]?.ref === r2, brief(r.text));
  expect(await alive(r2), 'running instance was touched');
});

await check('target_status shows the running instance and its health', async () => {
  const r = await call('target_status', { target: 'lc' });
  expect(r.ok && r.facts.running.length === 1 && r.facts.running[0].ref === r2 && r.facts.health.every((h) => h.ok), brief(r.text));
  expect(r.facts.start.env_names.includes('LC_TEST') && !('env' in r.facts.start), 'env values must not be shown');
});

await check('target_stop stops it; a second stop reports not_running', async () => {
  const r = await call('target_stop', { target: 'lc' });
  expect(r.ok && r.facts.status === 'stopped' && r.facts.old.ref === r2, brief(r.text));
  cleanup.delete(r2);
  const again = await call('target_stop', { target: 'lc' });
  expect(again.ok && again.facts.status === 'not_running', brief(again.text));
});

await check('unknown and invalid targets are refused', async () => {
  const u = await call('target_restart', { target: 'nope' });
  expect(u.code === 'unknown_target', brief(u.text));
  await fs.writeFile(opt.targets, JSON.stringify({ targets: { weak: { match: { name: 'node' } } } }));
  const i = await call('target_status', {});
  expect(i.code === 'targets_invalid' && /full executable path/.test(i.text), brief(i.text));
  const c = await cat();
  expect(c.environment.targets?.error, 'catalog should carry the targets error');
});

for (const ref of cleanup) await call('stop_process', { ref, graceful: 'none', force: true });
await fs.rm(opt.targets, { force: true });
await client.close();
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
