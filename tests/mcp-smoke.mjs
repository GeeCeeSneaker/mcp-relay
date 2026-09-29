#!/usr/bin/env node
// MCPRelay smoke client: runs the same AT-LOCAL checks against any MCP
// Streamable HTTP endpoint (local adapter, tunnel backend or public gateway).
//
//   node tests/mcp-smoke.mjs --url http://127.0.0.1:18001/mcp --fixture C:\mcprelay-fixture
//     [--prefix win01_]        tool-name prefix added by a namespacing gateway
//     [--token-env MCP_TOKEN]  env var holding a bearer access token
//     [--os windows|linux]     node OS (selects the long-running test command)
//     [--era legacy|modern]    protocol generation: 2025-era handshake (SDK v1
//                              client) or sessionless 2026-07-28 (SDK v2 client)
//     [--destructive-ok]       also check that remove_path refuses the allowed
//                              root itself (only against throwaway/scratch roots:
//                              a broken server would delete that root)
//
// Exit code 0 only if every check passes.

import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';

const { values: opt } = parseArgs({
  options: {
    url: { type: 'string' },
    fixture: { type: 'string' },
    prefix: { type: 'string', default: '' },
    'token-env': { type: 'string' },
    os: { type: 'string', default: process.platform === 'win32' ? 'windows' : 'linux' },
    era: { type: 'string', default: 'legacy' },
    'destructive-ok': { type: 'boolean', default: false },
  },
});
const MODERN = '2026-07-28';
const sdk = opt.era === 'modern'
  ? await import('@modelcontextprotocol/client')
  : {
      ...(await import('@modelcontextprotocol/sdk/client/index.js')),
      ...(await import('@modelcontextprotocol/sdk/client/streamableHttp.js')),
    };
if (!opt.url || !opt.fixture) {
  console.error('usage: mcp-smoke.mjs --url <mcp url> --fixture <node-side dir> [--prefix p_] [--token-env VAR] [--os windows|linux]');
  process.exit(2);
}

const sep = opt.os === 'windows' ? '\\' : '/';
const fixtureFile = `${opt.fixture}${sep}hello.txt`;
const tool = (name) => `${opt.prefix}${name}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LONG_RUNNING = opt.os === 'windows'
  ? { shell: 'powershell.exe', command: 'for ($i=1; $i -le 90; $i++) { "tick $i"; Start-Sleep -Seconds 1 }' }
  : { shell: '/bin/sh', command: 'i=1; while [ $i -le 90 ]; do echo tick $i; i=$((i+1)); sleep 1; done' };

const EXPOSED_TOOLS = ['list_capabilities', 'invoke_read', 'invoke_write', 'invoke_destructive', 'invoke_exec'];
const REQUIRED_CAPS = [
  'node_status', 'list_directory', 'read_file', 'write_file', 'edit_block', 'create_directory', 'move_file',
  'remove_path', 'get_file_info', 'search_files',
  'start_process', 'read_process_output', 'interact_with_process', 'force_terminate', 'list_sessions', 'list_processes',
];

let failures = 0;
function report(ok, name, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
}

async function connect() {
  const headers = {};
  if (opt['token-env']) {
    const token = process.env[opt['token-env']];
    if (!token) throw new Error(`env var ${opt['token-env']} is empty`);
    headers.Authorization = `Bearer ${token}`;
  }
  const transport = new sdk.StreamableHTTPClientTransport(new URL(opt.url), { requestInit: { headers } });
  const client = opt.era === 'modern'
    ? new sdk.Client({ name: 'mcprelay-smoke', version: '0.1.0' }, { versionNegotiation: { mode: { pin: MODERN } } })
    : new sdk.Client({ name: 'mcprelay-smoke', version: '0.1.0' });
  await client.connect(transport);
  return client;
}

// Capabilities are called through the invoke_<class> tool named in the node's
// catalog (list_capabilities), exactly as a model client would.
let CATALOG = null;
async function catalog(client) {
  if (!CATALOG) {
    const res = await client.callTool({ name: tool('list_capabilities'), arguments: {} });
    CATALOG = JSON.parse(res.content[0].text);
    CATALOG.via = new Map(CATALOG.capabilities.map((c) => [c.name, c.invoke_with]));
  }
  return CATALOG;
}
async function invokeRaw(client, via, args) {
  const res = await client.callTool({ name: tool(via), arguments: args });
  const text = (res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  return { isError: !!res.isError, text };
}
async function call(client, name, args) {
  const via = (await catalog(client)).via.get(name);
  if (!via) throw new Error(`capability ${name} is not in the catalog`);
  return invokeRaw(client, via, { capability: name, args });
}

async function check(name, fn) {
  const t0 = performance.now();
  try {
    const detail = await fn();
    report(true, name, `${Math.round(performance.now() - t0)} ms${detail ? `; ${detail}` : ''}`);
    return true;
  } catch (err) {
    report(false, name, err?.message ?? String(err));
    return false;
  }
}

function expect(cond, message) {
  if (!cond) throw new Error(message);
}

const brief = (s) => JSON.stringify(s.length > 160 ? `${s.slice(0, 160)}…` : s);

// Poll read_process_output until new "tick" output appears. Slow hosts (CI
// Windows runners) can return only an empty line at first. Lost state shows up
// as "No session found" and fails immediately.
async function readTicks(client, handle) {
  let last = '';
  for (let i = 0; i < 5; i++) {
    const r = await call(client, 'read_process_output', { handle, timeout_ms: 2000 });
    expect(!r.isError && !/No session found/i.test(r.text), brief(r.text));
    if (/tick \d+/.test(r.text)) return;
    last = r.text;
  }
  throw new Error(`no new output after 5 reads: ${brief(last)}`);
}

if (opt['token-env']) {
  await check('request without bearer token is rejected', async () => {
    const r = await fetch(opt.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '0' } } }),
    });
    expect(r.status === 401, `status ${r.status}`);
  });
}

// --- session A -------------------------------------------------------------
let a;
let pid;
let handle;
const initOk = await check('initialize', async () => {
  a = await connect();
  const v = a.getServerVersion();
  const pv = typeof a.getNegotiatedProtocolVersion === 'function' ? a.getNegotiatedProtocolVersion() : undefined;
  if (opt.era === 'modern') expect(pv === MODERN, `negotiated ${pv}, expected ${MODERN}`);
  return `server ${v?.name}@${v?.version}${pv ? `, protocol ${pv}` : ''}`;
});
if (!initOk) process.exit(1);

await check('tools/list exposes exactly the fixed class tools', async () => {
  const { tools } = await a.listTools();
  const mine = tools.map((t) => t.name).filter((n) => n.startsWith(opt.prefix)).sort();
  expect(JSON.stringify(mine) === JSON.stringify(EXPOSED_TOOLS.map(tool).sort()), `got: ${mine.join(', ')}`);
  return `${tools.length} tools`;
});

await check('catalog lists the required capabilities with class and schema', async () => {
  const c = await catalog(a);
  const names = new Set(c.capabilities.map((x) => x.name));
  const missing = REQUIRED_CAPS.filter((n) => !names.has(n));
  expect(missing.length === 0, `missing: ${missing.join(', ')}`);
  expect(c.capabilities.every((x) => x.class && x.invoke_with === `invoke_${x.class}` && x.args_schema?.type === 'object' && x.description), 'incomplete catalog entry');
  expect(c.environment?.file_roots?.length > 0 && c.environment.default_shell && c.catalog_version, 'environment/catalog_version missing');
  return `${c.capabilities.length} capabilities, catalog ${c.catalog_version}, default shell: ${c.environment.default_shell}`;
});

await check('tools carry no UI widget references', async () => {
  const { tools } = await a.listTools();
  const withUi = tools.filter((t) => t._meta && ('openai/outputTemplate' in t._meta || 'ui/resourceUri' in t._meta));
  expect(withUi.length === 0, `widget refs on: ${withUi.map((t) => t.name).join(', ')}`);
});

await check('create fixture directory', async () => {
  const r = await call(a, 'create_directory', { path: opt.fixture });
  expect(!r.isError, brief(r.text));
});

await check('write fixture file', async () => {
  const r = await call(a, 'write_file', { path: fixtureFile, content: 'hello mcp-relay\nline2\n', mode: 'rewrite' });
  expect(!r.isError, brief(r.text));
});

await check('list fixture directory', async () => {
  const r = await call(a, 'list_directory', { path: opt.fixture, depth: 1 });
  expect(!r.isError && r.text.includes('hello.txt'), brief(r.text));
});

await check('read fixture file', async () => {
  const r = await call(a, 'read_file', { path: fixtureFile });
  expect(!r.isError && r.text.includes('hello mcp-relay'), brief(r.text));
});

await check('edit fixture file', async () => {
  const e = await call(a, 'edit_block', { file_path: fixtureFile, old_string: 'line2', new_string: 'line2-edited' });
  expect(!e.isError, brief(e.text));
  const r = await call(a, 'read_file', { path: fixtureFile });
  expect(r.text.includes('line2-edited'), brief(r.text));
});

await check('deterministic command returns mcp-relay-ok', async () => {
  const r = await call(a, 'start_process', { command: 'echo mcp-relay-ok', timeout_ms: 15000 });
  expect(!r.isError && r.text.includes('mcp-relay-ok'), brief(r.text));
});

await check('commands cannot read the bridge token from their environment', async () => {
  const command = opt.os === 'windows' ? 'echo "[$env:MCPRELAY_BRIDGE_TOKEN]"' : 'echo "[$MCPRELAY_BRIDGE_TOKEN]"';
  const r = await call(a, 'start_process', { command, timeout_ms: 15000, ...(opt.os === 'windows' ? { shell: 'powershell.exe' } : {}) });
  expect(!r.isError && r.text.includes('[]'), brief(r.text));
});

await check('start long-running process', async () => {
  const r = await call(a, 'start_process', { ...LONG_RUNNING, timeout_ms: 3000 });
  expect(!r.isError, brief(r.text));
  const m = r.text.match(/PID\s+(\d+)/);
  expect(m, `no PID in ${brief(r.text)}`);
  pid = Number(m[1]);
  handle = (r.text.match(/handle (p_[\w-]+)/) || [])[1];
  expect(handle, `no handle in ${brief(r.text)}`);
  return `pid ${pid}, handle ${handle}`;
});

await check('read long-running output (same session)', async () => {
  expect(pid, 'no pid');
  await sleep(1500);
  await readTicks(a, handle);
});

await check('20 repeated sequential calls stay valid', async () => {
  for (let i = 0; i < 20; i++) {
    const r = await call(a, 'read_file', { path: fixtureFile });
    expect(!r.isError && r.text.includes('hello mcp-relay'), `iteration ${i}: ${brief(r.text)}`);
  }
});

await a.close();

// --- session B: a separate client connection must see session A's process ---
let b;
await check('second independent client connects', async () => {
  b = await connect();
});

await check('process from first connection is visible from second connection', async () => {
  expect(pid && b, 'no pid or client');
  await sleep(1500);
  await readTicks(b, handle);
});

await check('terminate process from second connection', async () => {
  expect(pid && b, 'no pid or client');
  const r = await call(b, 'force_terminate', { handle });
  expect(!r.isError && !/No (active )?session found/i.test(r.text), brief(r.text));
});

// --- v1.1 tools: node_status, read_file tail, sha256, list_processes, remove_path ---
const J = (r) => { try { return JSON.parse(r.text); } catch { throw new Error(`not JSON: ${brief(r.text)}`); } };
const shellOf = opt.os === 'windows' ? { shell: 'powershell.exe' } : { shell: '/bin/sh' };
const run = (command) => call(b, 'start_process', { command, timeout_ms: 20000, ...shellOf });
let status;

await check('node_status reports runtime facts and no credentials', async () => {
  const r = await call(b, 'node_status', {});
  status = J(r);
  for (const k of ['server_version', 'pid', 'uptime_seconds', 'hostname', 'os', 'arch', 'allowed_dirs', 'sessions', 'running_sessions']) expect(k in status, `missing ${k}`);
  expect(Number.isInteger(status.pid) && Array.isArray(status.allowed_dirs) && status.allowed_dirs.length > 0, brief(r.text));
  const token = opt['token-env'] ? process.env[opt['token-env']] : '';
  expect(!token || !r.text.includes(token), 'bearer token leaked');
  expect(!/authorization|bearer|password|secret|MCPRELAY_BRIDGE_TOKEN/i.test(r.text), 'credential-like text present');
  return `v${status.server_version}, pid ${status.pid}`;
});

await check('read_file offset<0 returns exactly the last N lines', async () => {
  const f = `${opt.fixture}${sep}hundred.txt`;
  await call(b, 'write_file', { path: f, content: Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n') + '\n' });
  const t = await call(b, 'read_file', { path: f, offset: -10 });
  const body = t.text.split('\n\n').slice(1).join('\n\n').split('\n');
  expect(body.length === 10 && body[0] === 'line 91' && body[9] === 'line 100', brief(t.text));
  const h = await call(b, 'read_file', { path: f, offset: 5, length: 2 });
  expect(/line 6\nline 7$/.test(h.text.trim()), `positive offset changed: ${brief(h.text)}`);
});

await check('get_file_info sha256 matches a reference hash', async () => {
  const f = `${opt.fixture}${sep}hash.txt`; const content = 'mcprelay sha256 check\n中文\n';
  await call(b, 'write_file', { path: f, content });
  const info = J(await call(b, 'get_file_info', { path: f, sha256: true }));
  const want = createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
  expect(info.sha256 === want, `${info.sha256} != ${want}`);
});

await check('list_processes: all, by pid, by name, limit', async () => {
  const all = J(await call(b, 'list_processes', { limit: 20 }));
  expect(Array.isArray(all) && all.length > 1 && all.length <= 20, `all: ${all.length}`);
  const byPid = J(await call(b, 'list_processes', { pid: status.pid }));
  expect(byPid.length === 1 && byPid[0].pid === status.pid && byPid[0].name && byPid[0].rss > 0, JSON.stringify(byPid).slice(0, 200));
  const byName = J(await call(b, 'list_processes', { name: 'node', limit: 200 }));
  expect(byName.some((p) => p.pid === status.pid), 'server pid not found by name "node"');
  const lim = J(await call(b, 'list_processes', { limit: 3 }));
  expect(lim.length === 3, `limit 3 returned ${lim.length}`);
  expect(!all.some((p) => 'command_line' in p || 'cmdline' in p), 'command lines must not be returned');
  return `${all.length} rows`;
});

await check('remove_path: file, empty dir, non-empty dir (non-recursive fails, recursive ok)', async () => {
  const d = `${opt.fixture}${sep}rmtest`;
  await call(b, 'create_directory', { path: `${d}${sep}sub` });
  await call(b, 'write_file', { path: `${d}${sep}sub${sep}f.txt`, content: 'x' });
  await call(b, 'write_file', { path: `${d}${sep}single.txt`, content: 'x' });
  expect(!(await call(b, 'remove_path', { path: `${d}${sep}single.txt` })).isError, 'file');
  await call(b, 'create_directory', { path: `${d}${sep}empty` });
  expect(!(await call(b, 'remove_path', { path: `${d}${sep}empty` })).isError, 'empty dir');
  const nr = await call(b, 'remove_path', { path: `${d}${sep}sub` });
  expect(nr.isError && /not empty/i.test(nr.text), `non-recursive: ${brief(nr.text)}`);
  expect(!(await call(b, 'remove_path', { path: d, recursive: true })).isError, 'recursive');
  const gone = await call(b, 'get_file_info', { path: d });
  expect(gone.isError, 'directory still exists');
});

await check('remove_path refuses paths outside the allowed roots', async () => {
  const outside = opt.os === 'windows' ? 'C:\\Windows\\win.ini' : '/etc/hostname';
  const r = await call(b, 'remove_path', { path: outside });
  expect(r.isError && /not allowed/i.test(r.text), brief(r.text));
});

await check('remove_path removes a link, never its target; recursive delete does not follow links', async () => {
  const outsideDir = opt.os === 'windows' ? 'C:\\Users\\Public\\mcprelay-sentinel' : '/tmp/mcprelay-sentinel';
  const keep = `${outsideDir}${sep}keep.txt`;
  const l1 = `${opt.fixture}${sep}link-only`; const d = `${opt.fixture}${sep}withlink`; const l2 = `${d}${sep}inner-link`;
  if (opt.os === 'windows') {
    await run(`New-Item -ItemType Directory -Force '${outsideDir}' | Out-Null; Set-Content -Path '${keep}' -Value keep`);
    await call(b, 'create_directory', { path: d });
    await run(`cmd /c mklink /J "${l1}" "${outsideDir}"; cmd /c mklink /J "${l2}" "${outsideDir}"`);
  } else {
    await run(`mkdir -p '${outsideDir}' && echo keep > '${keep}'`);
    await call(b, 'create_directory', { path: d });
    await run(`ln -sfn '${outsideDir}' '${l1}' && ln -sfn '${outsideDir}' '${l2}'`);
  }
  const r1 = await call(b, 'remove_path', { path: l1 });
  expect(!r1.isError && /link/i.test(r1.text), `link: ${brief(r1.text)}`);
  const r2 = await call(b, 'remove_path', { path: d, recursive: true });
  expect(!r2.isError, `recursive: ${brief(r2.text)}`);
  const still = await run(opt.os === 'windows' ? `Test-Path '${keep}'` : `test -f '${keep}' && echo True || echo False`);
  expect(/True/.test(still.text), `target content was deleted! ${brief(still.text)}`);
  await run(opt.os === 'windows' ? `Remove-Item -Recurse -Force '${outsideDir}'` : `rm -rf '${outsideDir}'`);
});

// --- v2.0: risk-class tools, class enforcement, argument validation ---
await check('class tools carry titles and risk annotations', async () => {
  const { tools } = await b.listTools();
  const ann = (n) => tools.find((t) => t.name === tool(n))?.annotations || {};
  for (const n of EXPOSED_TOOLS) expect(ann(n).title && typeof ann(n).readOnlyHint === 'boolean', `no annotations on ${n}`);
  expect(ann('list_capabilities').readOnlyHint === true && ann('invoke_read').readOnlyHint === true && ann('invoke_read').destructiveHint === false, 'read tools must be read-only');
  expect(ann('invoke_write').readOnlyHint === false && ann('invoke_write').destructiveHint === false, 'invoke_write is a non-destructive write');
  expect(ann('invoke_destructive').destructiveHint === true && ann('invoke_destructive').openWorldHint === false, 'invoke_destructive must be destructive');
  expect(ann('invoke_exec').destructiveHint === true && ann('invoke_exec').openWorldHint === true, 'invoke_exec must be destructive/open-world');
  const c = await catalog(b);
  const cls = (n) => c.capabilities.find((x) => x.name === n)?.class;
  expect(cls('read_file') === 'read' && cls('create_directory') === 'write' && cls('remove_path') === 'destructive' && cls('start_process') === 'exec', 'capability classes changed');
});

await check('tool descriptions carry the node environment', async () => {
  const { tools } = await b.listTools();
  const d = (n) => tools.find((t) => t.name === tool(n))?.description || '';
  expect(d('invoke_read').includes(status.allowed_dirs[0]), `allowed root missing: ${brief(d('invoke_read'))}`);
  expect(/Default shell/.test(d('invoke_exec')) && /full rights/.test(d('invoke_exec')), `shell context missing: ${brief(d('invoke_exec'))}`);
  expect(d('invoke_destructive').includes('remove_path'), 'current capability names missing');
});

await check('a capability is refused through another class tool and nothing runs', async () => {
  const r = await invokeRaw(b, 'invoke_read', { capability: 'remove_path', args: { path: fixtureFile } });
  expect(r.isError && /invoke_destructive/.test(r.text), brief(r.text));
  const x = await invokeRaw(b, 'invoke_write', { capability: 'start_process', args: { command: 'echo nope', timeout_ms: 1000 } });
  expect(x.isError && /invoke_exec/.test(x.text), brief(x.text));
  expect(!(await call(b, 'get_file_info', { path: fixtureFile })).isError, 'fixture file was removed!');
});

await check('unknown capability and invalid args are explained', async () => {
  const u = await invokeRaw(b, 'invoke_read', { capability: 'no_such_thing', args: {} });
  expect(u.isError && /list_capabilities/.test(u.text) && /read_file/.test(u.text), brief(u.text));
  const m = await invokeRaw(b, 'invoke_read', { capability: 'read_file', args: {} });
  expect(m.isError && /missing required argument "path"/.test(m.text) && /args_schema/.test(m.text), brief(m.text));
  const k = await invokeRaw(b, 'invoke_read', { capability: 'read_file', args: { file: fixtureFile } });
  expect(k.isError && /unknown argument "file"/.test(k.text), brief(k.text));
  const ty = await invokeRaw(b, 'invoke_read', { capability: 'read_file', args: { path: 42 } });
  expect(ty.isError && /must be a string/.test(ty.text), brief(ty.text));
  // numeric strings are coerced ("-1" -> -1), a common model habit
  const co = await invokeRaw(b, 'invoke_read', { capability: 'read_file', args: { path: fixtureFile, offset: '-1' } });
  expect(!co.isError && /line2-edited/.test(co.text), brief(co.text));
});

// --- guard lists: protected (never read/changed) and read-only paths inside the roots ---
// Only test folders named mcprelay-guard* (set via MCPRELAY_PROTECTED_DIRS /
// MCPRELAY_READONLY_DIRS, as CI does), never real ones such as ~/.ssh.
const lc = (s) => (opt.os === 'windows' ? s.toLowerCase() : s);
const insideRoots = (p) => status.allowed_dirs.some((r) => lc(p).startsWith(lc(r.endsWith(sep) ? r : r + sep)));

await check('protected paths are neither read, listed, searched nor changed', async () => {
  const env = (await catalog(b)).environment;
  const ssh = await call(b, 'read_file', { path: `${env.working_directory}${sep}.ssh${sep}id_probe` });
  expect(ssh.isError && /(Protected path|not allowed)/.test(ssh.text), `~/.ssh style path readable? ${brief(ssh.text)}`);
  const prot = env.protected_paths.find((p) => insideRoots(p) && /mcprelay-guard/.test(p));
  if (!prot) return 'no mcprelay-guard protected test folder configured (skipped)';
  const parent = prot.slice(0, prot.lastIndexOf(sep));
  const secret = `${prot}${sep}mcprelay-guard-probe.txt`;
  await run(opt.os === 'windows'
    ? `New-Item -ItemType Directory -Force '${prot}' | Out-Null; if (-not (Test-Path '${secret}')) { Set-Content -Path '${secret}' -Value guard-secret-xyz }`
    : `mkdir -p '${prot}' && [ -e '${secret}' ] || echo guard-secret-xyz > '${secret}'`);
  const rd = await call(b, 'read_file', { path: secret });
  expect(rd.isError && /^Error \[protected_path]: Protected path/.test(rd.text), `read: ${brief(rd.text)}`);
  const wr = await call(b, 'write_file', { path: secret, content: 'x' });
  expect(wr.isError && /Protected path/.test(wr.text), `write: ${brief(wr.text)}`);
  const ls = await call(b, 'list_directory', { path: prot });
  expect(ls.isError && /Protected path/.test(ls.text), `list: ${brief(ls.text)}`);
  const up = await call(b, 'list_directory', { path: parent, depth: 2 });
  expect(!up.isError && /\(protected, not listed\)/.test(up.text) && !up.text.includes('mcprelay-guard-probe'), `parent listing: ${brief(up.text)}`);
  const se = await call(b, 'search_files', { path: parent, pattern: 'mcprelay-guard-probe*', max_results: 5 });
  expect(!se.text.includes('mcprelay-guard-probe'), `search found protected file: ${brief(se.text)}`);
  const rm = await call(b, 'remove_path', { path: secret });
  expect(rm.isError && /Protected path/.test(rm.text), `remove: ${brief(rm.text)}`);
  await run(opt.os === 'windows' ? `Remove-Item -Force '${secret}'` : `rm -f '${secret}'`);
  return prot;
});

await check('read-only paths are readable but never changed', async () => {
  const env = (await catalog(b)).environment;
  const ro = env.read_only_paths.find((p) => insideRoots(p) && /mcprelay-guard/.test(p));
  if (!ro) return 'no mcprelay-guard read-only test folder configured (skipped)';
  const f = `${ro}${sep}mcprelay-ro-probe.txt`;
  await run(opt.os === 'windows'
    ? `New-Item -ItemType Directory -Force '${ro}' | Out-Null; Set-Content -Path '${f}' -Value ro-ok`
    : `mkdir -p '${ro}' && echo ro-ok > '${f}'`);
  const rd = await call(b, 'read_file', { path: f });
  expect(!rd.isError && rd.text.includes('ro-ok'), `read: ${brief(rd.text)}`);
  for (const [cap, args] of [['write_file', { path: f, content: 'x' }], ['edit_block', { file_path: f, old_string: 'ro-ok', new_string: 'x' }],
    ['create_directory', { path: `${ro}${sep}sub` }], ['remove_path', { path: f }], ['move_file', { source: f, destination: `${opt.fixture}${sep}moved.txt` }]]) {
    const r = await call(b, cap, args);
    expect(r.isError && /^Error \[read_only_path]: Read-only path/.test(r.text), `${cap}: ${brief(r.text)}`);
  }
  expect((await call(b, 'read_file', { path: f })).text.includes('ro-ok'), 'read-only file changed!');
  // A folder holding a guarded folder can be neither removed nor moved.
  const parent = ro.slice(0, ro.lastIndexOf(sep));
  if (insideRoots(parent)) {
    const rm = await call(b, 'remove_path', { path: parent, recursive: true });
    expect(rm.isError && /(contains a protected or read-only|allowed root)/.test(rm.text), `remove parent: ${brief(rm.text)}`);
    const mv = await call(b, 'move_file', { source: parent, destination: `${parent}-moved` });
    expect(mv.isError && /(contains a protected or read-only|Read-only path|not allowed)/.test(mv.text), `move parent: ${brief(mv.text)}`);
  }
  await run(opt.os === 'windows' ? `Remove-Item -Force '${f}'` : `rm -f '${f}'`);
  return ro;
});

// --- v2.2: process handles, error codes, catalog_version, cancellable search ---
await check('process operations need the start_process handle, not a PID', async () => {
  const r = await call(b, 'start_process', { ...LONG_RUNNING, timeout_ms: 2000 });
  const h = (r.text.match(/handle (p_[\w-]+)/) || [])[1]; const p = Number((r.text.match(/PID\s+(\d+)/) || [])[1]);
  expect(h && p, brief(r.text));
  const byPid = await call(b, 'read_process_output', { pid: p });
  expect(byPid.isError && /\[invalid_args\]/.test(byPid.text) && /unknown argument "pid"/.test(byPid.text), `pid accepted: ${brief(byPid.text)}`);
  const wrong = await call(b, 'force_terminate', { handle: 'p_notarealhandle0' });
  expect(wrong.isError && /\[bad_handle\]/.test(wrong.text), `bad handle: ${brief(wrong.text)}`);
  const ls = await call(b, 'list_sessions', {});
  expect(ls.text.includes(`PID: ${p}`) && !ls.text.includes(h), `list_sessions leaks handles: ${brief(ls.text)}`);
  const k = await call(b, 'force_terminate', { handle: h });
  expect(!k.isError, brief(k.text));
  await sleep(1000);
  const again = await call(b, 'interact_with_process', { handle: h, input: 'x' });
  expect(again.isError && /\[process_exited\]/.test(again.text), `after terminate: ${brief(again.text)}`);
});

await check('failures carry stable error codes and a next action', async () => {
  const cases = [
    ['read_file', { path: opt.os === 'windows' ? 'C:\\Windows\\win.ini' : '/etc/hostname' }, 'path_not_allowed', 'fix the arguments'],
    ['read_file', { path: `${opt.fixture}${sep}no-such-file.txt` }, 'not_found', 'fix the arguments'],
    ['read_file', { path: opt.fixture }, 'is_a_directory', 'fix the arguments'],
    ['edit_block', { file_path: fixtureFile, old_string: 'not-in-file-xyz', new_string: 'y' }, 'no_match', 'fix the arguments'],
  ];
  for (const [cap, args, code, next] of cases) {
    const r = await call(b, cap, args);
    expect(r.isError && r.text.startsWith(`Error [${code}]`) && r.text.includes(`next: ${next}`), `${cap}: ${brief(r.text)}`);
  }
  const c = await catalog(b);
  expect(c.errors?.codes?.protected_path === 'ask_user' && c.errors.codes.timeout === 'retry_later', 'error codes missing from the catalog');
  // Catalog-related failures tell the caller to re-read the catalog, with the current version.
  for (const [via, args] of [['invoke_read', { capability: 'no_such_capability', args: {} }], ['invoke_read', { capability: 'remove_path', args: { path: fixtureFile } }],
    ['invoke_read', { capability: 'read_file', args: { file: fixtureFile } }]]) {
    const e = await invokeRaw(b, via, args);
    expect(e.isError && /next: capabilities may have changed: call list_capabilities again/.test(e.text) && e.text.includes(`catalog_version ${c.catalog_version}`), `refresh hint: ${brief(e.text)}`);
  }
  expect(/change at any time/.test(c.usage), 'catalog usage lacks the update notice');
});

await check('catalog_version is the same for every filtered view', async () => {
  const views = [];
  for (const cls of [undefined, 'read', 'write', 'destructive', 'exec']) {
    const res = await b.callTool({ name: tool('list_capabilities'), arguments: cls ? { class: cls } : {} });
    const v = JSON.parse(res.content[0].text);
    expect(v.view === (cls || 'all') && v.capabilities.every((x) => !cls || x.class === cls), `view ${cls}`);
    views.push(v.catalog_version);
  }
  expect(new Set(views).size === 1, `versions differ: ${views.join(', ')}`);
  return views[0];
});

await check('default shell is the one the catalog advertises', async () => {
  const c = await catalog(b);
  const r = await call(b, 'start_process', { command: 'echo shell-ok', timeout_ms: 20000 });
  const used = (r.text.match(/shell: ([^)]+)\)/) || [])[1] || '';
  const want = c.environment.shells.find((s) => s.note === c.environment.default_shell)?.shell || c.environment.default_shell;
  expect(!r.isError && /shell-ok/.test(r.text) && used && want.toLowerCase().endsWith(used.toLowerCase()), `used ${used}, catalog ${c.environment.default_shell}: ${brief(r.text)}`);
  return `${c.environment.default_shell} (${used})`;
});

await check('audit log records calls without arguments and stays within its cap', async () => {
  const st = J(await call(b, 'node_status', {}));
  if (!st.audit_log) return 'audit log disabled on this node (skipped)';
  const inside = st.allowed_dirs.some((r) => st.audit_log.toLowerCase().startsWith(r.toLowerCase()));
  if (!inside) return 'audit log outside file roots (skipped)';
  await sleep(300); // audit writes are asynchronous
  // The newest entries may sit in the rotated file if the log just rolled over.
  let text = '';
  for (const p of [`${st.audit_log}.1`, st.audit_log]) {
    const r = await call(b, 'read_file', { path: p, offset: -250 });
    if (!r.isError) text += `${r.text.split('\n\n').slice(1).join('\n\n')}\n`;
  }
  const lines = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  expect(lines.length > 0 && lines.every((e) => e.t && e.tool && typeof e.ok === 'boolean' && typeof e.ms === 'number'), brief(text));
  expect(lines.some((e) => e.tool === 'node_status'), 'the node_status call just made is not in the audit log');
  expect(lines.some((e) => e.tool === 'remove_path' && e.cls === 'read' && e.err === 'wrong_class'), 'refused cross-class call not audited');
  expect(lines.every((e) => /^[0-9a-f]{8}$/.test(e.boot) && /^[0-9a-f]{8}$/.test(e.call)), 'boot/call ids missing');
  expect(lines.some((e) => e.tool === 'start_process' && Number.isInteger(e.pid)), 'process calls must record the PID');
  const allowedKeys = new Set(['t', 'boot', 'call', 'tool', 'cls', 'ok', 'ms', 'pid', 'err']);
  expect(lines.every((e) => Object.keys(e).every((k) => allowedKeys.has(k))), 'unexpected fields in audit entries');
  expect(!text.includes(opt.fixture) && !text.includes('mcp-relay-ok'), 'arguments/results leaked into the audit log');
  const size = J(await call(b, 'get_file_info', { path: st.audit_log })).size;
  expect(size <= st.audit_max_bytes, `audit log ${size} > cap ${st.audit_max_bytes}`);
  return `${lines.length} recent entries, ${size} bytes (cap ${st.audit_max_bytes})`;
});

if (opt['destructive-ok']) {
  await check('remove_path refuses the allowed root itself (scratch roots only)', async () => {
    const root = status.allowed_dirs[0];
    const r = await call(b, 'remove_path', { path: root, recursive: true });
    expect(r.isError && /allowed root|not allowed/i.test(r.text), brief(r.text));
    const still = await call(b, 'get_file_info', { path: root });
    expect(!still.isError, 'allowed root is gone!');
  });
}

await b?.close();

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
