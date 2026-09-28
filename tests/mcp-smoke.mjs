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
//
// Exit code 0 only if every check passes.

import { parseArgs } from 'node:util';

const { values: opt } = parseArgs({
  options: {
    url: { type: 'string' },
    fixture: { type: 'string' },
    prefix: { type: 'string', default: '' },
    'token-env': { type: 'string' },
    os: { type: 'string', default: process.platform === 'win32' ? 'windows' : 'linux' },
    era: { type: 'string', default: 'legacy' },
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

const REQUIRED_TOOLS = [
  'list_directory', 'read_file', 'write_file', 'edit_block', 'create_directory',
  'start_process', 'read_process_output', 'interact_with_process', 'force_terminate',
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

async function call(client, name, args) {
  const res = await client.callTool({ name: tool(name), arguments: args });
  const text = (res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  return { isError: !!res.isError, text };
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
async function readTicks(client, pid) {
  let last = '';
  for (let i = 0; i < 5; i++) {
    const r = await call(client, 'read_process_output', { pid, timeout_ms: 2000 });
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
const initOk = await check('initialize', async () => {
  a = await connect();
  const v = a.getServerVersion();
  const pv = typeof a.getNegotiatedProtocolVersion === 'function' ? a.getNegotiatedProtocolVersion() : undefined;
  if (opt.era === 'modern') expect(pv === MODERN, `negotiated ${pv}, expected ${MODERN}`);
  return `server ${v?.name}@${v?.version}${pv ? `, protocol ${pv}` : ''}`;
});
if (!initOk) process.exit(1);

await check('tools/list contains required Desktop Commander tools', async () => {
  const { tools } = await a.listTools();
  const names = new Set(tools.map((t) => t.name));
  const missing = REQUIRED_TOOLS.map(tool).filter((n) => !names.has(n));
  expect(missing.length === 0, `missing: ${missing.join(', ')}`);
  return `${tools.length} tools`;
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
  return `pid ${pid}`;
});

await check('read long-running output (same session)', async () => {
  expect(pid, 'no pid');
  await sleep(1500);
  await readTicks(a, pid);
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
  await readTicks(b, pid);
});

await check('terminate process from second connection', async () => {
  expect(pid && b, 'no pid or client');
  const r = await call(b, 'force_terminate', { pid });
  expect(!r.isError && !/No (active )?session found/i.test(r.text), brief(r.text));
});

await b?.close();

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
