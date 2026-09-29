#!/usr/bin/env node
// Extended capability checks used to compare local capability servers
// (the node capability server; originally Desktop Commander vs. the desk prototype, ADR-0004). Windows node.
//
//   node tests/compare-ext.mjs --url <mcp url> --token-env VAR --fixture <dir inside allowed dirs> [--prefix p_]
import { parseArgs } from 'node:util';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const { values: opt } = parseArgs({ options: { url: { type: 'string' }, 'token-env': { type: 'string' }, fixture: { type: 'string' }, prefix: { type: 'string', default: '' } } });
const headers = opt['token-env'] ? { Authorization: `Bearer ${process.env[opt['token-env']]}` } : {};
const c = new Client({ name: 'compare-ext', version: '0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
await c.connect(new StreamableHTTPClientTransport(new URL(opt.url), { requestInit: { headers } }));
// Capabilities go through the invoke_<class> tool named in the node's catalog.
const cat = await c.callTool({ name: `${opt.prefix}list_capabilities`, arguments: {} });
const via = new Map(JSON.parse(cat.content[0].text).capabilities.map((x) => [x.name, x.invoke_with]));
const call = async (name, args) => {
  const r = await c.callTool({ name: opt.prefix + via.get(name), arguments: { capability: name, args } }, undefined, { timeout: 120000 });
  return { isError: !!r.isError, text: (r.content || []).map((x) => x.text || '').join('\n') };
};
const pidOf = (t) => Number((/PID\s+(\d+)/.exec(t) || [])[1]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
async function check(name, fn) {
  const t0 = performance.now();
  try { const d = await fn(); console.log(`PASS  ${name}  -- ${Math.round(performance.now() - t0)} ms${d ? `; ${d}` : ''}`); }
  catch (e) { fails++; console.log(`FAIL  ${name}  -- ${e.message.slice(0, 200)}`); }
}
const expect = (c, m) => { if (!c) throw new Error(m); };

await check('command latency (5x echo, median)', async () => {
  const xs = [];
  for (let i = 0; i < 5; i++) { const t = performance.now(); const r = await call('start_process', { command: 'echo ok', timeout_ms: 15000 }); expect(r.text.includes('ok'), r.text); xs.push(performance.now() - t); }
  return `median ${Math.round(xs.sort((a, b) => a - b)[2])} ms (default shell)`;
});
await check('command latency, PowerShell (5x, median)', async () => {
  const xs = [];
  for (let i = 0; i < 5; i++) { const t = performance.now(); const r = await call('start_process', { command: 'echo ok', timeout_ms: 15000, shell: 'powershell.exe' }); expect(r.text.includes('ok'), r.text); xs.push(performance.now() - t); }
  return `median ${Math.round(xs.sort((a, b) => a - b)[2])} ms`;
});
await check('Chinese output is not garbled', async () => {
  const r = await call('start_process', { command: 'echo 中文测试-编码', timeout_ms: 15000 });
  expect(r.text.includes('中文测试-编码'), JSON.stringify(r.text.slice(0, 200)));
});
await check('Chinese file name + content round trip', async () => {
  const f = `${opt.fixture}\\中文文件.txt`;
  await call('create_directory', { path: opt.fixture });
  const w = await call('write_file', { path: f, content: '你好，世界\n第二行\n', mode: 'rewrite' }); expect(!w.isError, w.text);
  const r = await call('read_file', { path: f }); expect(r.text.includes('你好，世界'), r.text.slice(0, 200));
});
await check('large output (20k lines) readable', async () => {
  const r = await call('start_process', { command: '1..20000 | ForEach-Object { "line $_" }', timeout_ms: 30000, shell: 'powershell.exe' });
  const pid = pidOf(r.text); let all = r.text;
  for (let i = 0; i < 10 && !/line 20000/.test(all); i++) all += (await call('read_process_output', { pid, timeout_ms: 2000 })).text;
  expect(/line 20000/.test(all) || /line 1999\d/.test(all), `tail missing (got ${all.length} chars)`);
  return `${all.length} chars`;
});
await check('interactive REPL (node -i)', async () => {
  const r = await call('start_process', { command: 'node -i', timeout_ms: 3000 });
  const pid = pidOf(r.text); expect(pid, r.text);
  const out = await call('interact_with_process', { pid, input: '6*7', timeout_ms: 8000 });
  await call('force_terminate', { pid });
  expect(/42/.test(out.text), JSON.stringify(out.text.slice(0, 200)));
});
await check('force_terminate kills the child tree', async () => {
  const r = await call('start_process', { command: 'ping -n 120 127.0.0.1', timeout_ms: 2000, shell: 'powershell.exe' });
  const pid = pidOf(r.text); expect(pid, r.text);
  const before = await call('start_process', { command: 'Get-CimInstance Win32_Process -Filter "Name=\'PING.EXE\'" | Measure-Object | Select-Object -ExpandProperty Count', timeout_ms: 15000, shell: 'powershell.exe' });
  await call('force_terminate', { pid }); await sleep(1500);
  const after = await call('start_process', { command: 'Get-CimInstance Win32_Process -Filter "Name=\'PING.EXE\'" | Measure-Object | Select-Object -ExpandProperty Count', timeout_ms: 15000, shell: 'powershell.exe' });
  const n = (r) => Number((r.text.match(/Initial output:\s*(\d+)/) || [])[1] ?? NaN);
  expect(n(after) < n(before), `ping.exe count before ${n(before)}, after ${n(after)}`);
  return `ping.exe ${n(before)} -> ${n(after)}`;
});
await check('file tool outside allowed dirs is denied', async () => {
  const r = await call('read_file', { path: 'C:\\Windows\\win.ini' });
  expect(r.isError || /not allowed/i.test(r.text), r.text.slice(0, 160));
});
await check('search_files finds text and does not follow a junction out of the roots', async () => {
  await call('create_directory', { path: opt.fixture });
  await call('write_file', { path: `${opt.fixture}\\needle.txt`, content: 'alpha\nfind-me-42\n', mode: 'rewrite' });
  const j = `${opt.fixture}\\outside-link`;
  await call('start_process', { command: `cmd /c "if not exist "${j}" mklink /J "${j}" C:\\Windows"`, timeout_ms: 15000, shell: 'powershell.exe' });
  const r = await call('search_files', { path: opt.fixture, content_pattern: 'FIND-ME-42' });
  expect(!r.isError && r.text.includes('needle.txt'), `text search: ${r.text.slice(0, 160)}`);
  const s = await call('search_files', { path: opt.fixture, pattern: 'win.ini' });
  expect(!/win\.ini/i.test(s.text), `followed junction: ${s.text.slice(0, 160)}`);
  await call('start_process', { command: `cmd /c rmdir "${j}"`, timeout_ms: 15000, shell: 'powershell.exe' });
});
await check('file ops latency (write+read+edit, 10x median)', async () => {
  const xs = []; const f = `${opt.fixture}\\lat.txt`;
  for (let i = 0; i < 10; i++) { const t = performance.now(); await call('write_file', { path: f, content: `a${i}\nb\n`, mode: 'rewrite' }); await call('read_file', { path: f }); await call('edit_block', { file_path: f, old_string: 'b', new_string: 'c' }); xs.push(performance.now() - t); }
  return `median ${Math.round(xs.sort((a, b) => a - b)[5])} ms per write+read+edit`;
});
await c.close();
console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(fails ? 1 : 0);
