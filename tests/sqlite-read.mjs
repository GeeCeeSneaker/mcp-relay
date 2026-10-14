// WO-0008 deterministic read-only/WAL checks against a disposable loopback node.
// Run: node --test tests/sqlite-read.mjs. No deployed node/database is used.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let root, outside, server, client, url, token, dbfile, writer, walfile;
const hash = b => createHash('sha256').update(b).digest('hex');
async function fingerprints(file) {
  const out = {};
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      const st = await fs.stat(file + suffix);
      out[suffix] = { bytes: st.size, hash: hash(await fs.readFile(file + suffix)), modified: st.mtimeMs };
    } catch (e) { if (e.code !== 'ENOENT') throw e; out[suffix] = null; }
  }
  return out;
}
async function call(name, args, via = 'invoke_read', c = client) {
  const r = await c.callTool({ name: via, arguments: { capability: name, args } });
  const text = r.content.map(x => x.text ?? '').join('\n');
  return { error: !!r.isError, code: r._meta?.['io.mcprelay/error']?.code,
    text, value: r.isError ? null : JSON.parse(text) };
}
async function query(sql, extra = {}) {
  return call('sqlite_query', { path: dbfile, sql, ...extra });
}
function good(r) { assert.equal(r.error, false, r.text); return r.value; }
function refused(r) { assert.equal(r.error, true, 'operation unexpectedly allowed'); }
before(async () => {
  // Windows CI can spell TEMP with an 8.3 alias. Declare the canonical root,
  // matching the existing guard's realpath policy; never relax that policy.
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mcprelay-wo8-')));
  outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mcprelay-wo8-outside-')));
  await fs.mkdir(path.join(root, 'protected'));
  await fs.mkdir(path.join(root, 'read-only'));
  dbfile = path.join(root, 'fixture.db');
  const db = new DatabaseSync(dbfile);
  db.exec("CREATE TABLE parent(id INTEGER PRIMARY KEY); INSERT INTO parent VALUES(1);"
    + "CREATE TABLE sample(id INTEGER PRIMARY KEY, value TEXT NOT NULL, parent_id INTEGER REFERENCES parent(id));"
    + "INSERT INTO sample VALUES(1,'first',1),(2,'second',1),(3,'third',1);"
    + "CREATE INDEX sample_value ON sample(value); CREATE VIEW sample_view AS SELECT id,value FROM sample;");
  db.close();
  const lease = net.createServer();
  await new Promise(resolve => lease.listen(0, '127.0.0.1', resolve));
  const port = lease.address().port; await new Promise(resolve => lease.close(resolve));
  url = `http://127.0.0.1:${port}/mcp`; token = randomBytes(32).toString('hex');
  server = spawn(process.execPath, [path.join(repo, 'node-runtime/server.mjs'), '--port', String(port)], {
    windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, MCPRELAY_BRIDGE_TOKEN: token, MCPRELAY_ALLOWED_DIRS: root,
      MCPRELAY_NODE_NAME: 'sqlite-fixture', MCPRELAY_TARGETS: path.join(root, 'targets.json'),
      MCPRELAY_AUDIT_LOG: path.join(root, 'audit.log'), MCPRELAY_PROTECTED_DIRS: path.join(root, 'protected'),
      MCPRELAY_READONLY_DIRS: path.join(root, 'read-only') },
  });
  let logs = ''; server.stderr.on('data', b => { logs = (logs + b.toString()).slice(-5000); });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url.replace('/mcp', '/healthz'))).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, 'disposable node failed to become ready: ' + logs);
  client = new Client({ name: 'sqlite-regression', version: '1' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await client.connect(new StreamableHTTPClientTransport(new URL(url),
    { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));
});
after(async () => {
  await client?.close(); writer?.close();
  if (server && server.exitCode === null) {
    const exited = new Promise(resolve => server.once('close', resolve));
    server.kill(); await exited;
  }
  for (const dir of [root, outside].filter(Boolean)) {
    const real = await fs.realpath(dir);
    assert.equal(real, path.resolve(dir));
    assert(path.basename(real).startsWith('mcprelay-wo8-'));
    assert.equal(path.dirname(real), await fs.realpath(os.tmpdir()));
    await fs.rm(real, { recursive: true, force: true });
  }
});

test('1 SELECT structured columns/rows and exact SQLite integer/blob encoding', async () => {
  const r = good(await query("SELECT id,value FROM sample ORDER BY id"));
  assert.deepEqual(r.columns, ['id', 'value']); assert.deepEqual(r.rows, [[1, 'first'], [2, 'second'], [3, 'third']]);
  assert.equal(r.row_count, 3); assert.equal(r.truncated, false);
  assert.deepEqual(good(await query("SELECT 9223372036854775807, x'0001', NULL")).rows,
    [[{ type: 'integer', value: '9223372036854775807' }, { type: 'blob', base64: 'AAE=' }, null]]);
  assert.deepEqual(good(await query('SELECT 1e999, -1e999')).rows,
    [[{ type: 'real', value: 'Infinity' }, { type: 'real', value: '-Infinity' }]]);
});
test('2 positional/named binding is separate data, never SQL interpolation', async () => {
  assert.deepEqual(good(await query('SELECT value FROM sample WHERE id=?', { params: [2] })).rows, [['second']]);
  assert.deepEqual(good(await query('SELECT :v', { named_params: { ':v': "'; DROP TABLE sample;--" } })).rows,
    [["'; DROP TABLE sample;--"]]);
  refused(await query('SELECT ?', { params: [1], named_params: { ':x': 1 } }));
});
test('3 CTE/join reads and exact schema metadata/filter', async () => {
  assert.equal(good(await query('WITH ids AS (SELECT id FROM sample) SELECT count(*) FROM ids JOIN sample USING(id)')).rows[0][0], 3);
  const schema = good(await call('sqlite_schema', { path: dbfile }));
  const t = schema.tables.find(x => x.name === 'sample');
  assert.equal(t.columns.find(x => x.name === 'id').pk, 1);
  assert.equal(t.columns.find(x => x.name === 'value').notnull, 1);
  assert.equal(t.foreign_keys[0].table, 'parent');
  assert(t.indexes.some(x => x.name === 'sample_value' && x.columns.some(c => c.name === 'value')));
  assert(schema.tables.some(x => x.name === 'sample_view' && x.type === 'view'));
  assert.deepEqual(good(await call('sqlite_schema', { path: dbfile, table: 'sample_view' })).tables.map(x => x.name), ['sample_view']);
});
test('4 writes/DDL/VACUUM/transaction operations refused with zero mutation', async () => {
  const before = await fingerprints(dbfile);
  for (const sql of ["INSERT INTO sample VALUES(4,'bad',1)", "UPDATE sample SET value='bad'",
    'DELETE FROM sample', 'CREATE TABLE bad(x)', 'DROP TABLE sample', 'ALTER TABLE sample ADD COLUMN bad',
    'VACUUM', 'BEGIN', 'COMMIT', 'WITH ids AS (SELECT id FROM sample) DELETE FROM sample WHERE id IN ids',
    "INSERT INTO sample VALUES(4,'bad',1) RETURNING id"]) refused(await query(sql));
  assert.deepEqual(await fingerprints(dbfile), before);
});
test('5 user PRAGMAs and table-valued PRAGMA bypass refused', async () => {
  const before = await fingerprints(dbfile);
  for (const sql of ['PRAGMA user_version=12', 'PRAGMA journal_mode=WAL', 'PRAGMA query_only=OFF',
    'PRAGMA writable_schema=ON', "SELECT * FROM pragma_table_info('sample')"]) refused(await query(sql));
  assert.deepEqual(await fingerprints(dbfile), before);
});
test('6 ATTACH/DETACH/extension and SQL file function refusal', async () => {
  for (const sql of ["ATTACH ':memory:' AS extra", 'DETACH extra', "SELECT load_extension('missing')",
    "SELECT readfile('missing')", "SELECT writefile('missing', 'bad')"]) refused(await query(sql));
});
test('7 multi-statement rejection uses SQLite parsed source; quoted semicolons work', async () => {
  const before = await fingerprints(dbfile);
  for (const sql of ['SELECT 1; SELECT 2', 'SELECT 1; DROP TABLE sample', 'SELECT 1; -- trailing text']) refused(await query(sql));
  assert.deepEqual(good(await query("SELECT ';' AS value;")).rows, [[';']]);
  assert.deepEqual(good(await query('/* safe comment */ SELECT 1')).rows, [[1]]);
  assert.deepEqual(await fingerprints(dbfile), before);
});
test('8 deterministic row/byte/schema bounds and invalid limit rejection', async () => {
  const r = good(await query('SELECT * FROM sample ORDER BY id', { max_rows: 2 }));
  assert.equal(r.row_count, 2); assert.equal(r.truncated, true);
  const bounded = await query("SELECT printf('%1000s','x') FROM sample", { max_bytes: 512 });
  assert(Buffer.byteLength(bounded.text) <= 512); assert.equal(good(bounded).truncated, true);
  const schema = good(await call('sqlite_schema', { path: dbfile, max_tables: 1 }));
  assert.equal(schema.tables.length, 1); assert.equal(schema.truncated, true);
  for (const args of [{ max_rows: 0 }, { max_rows: 1001 }, { max_bytes: 1048577 }, { timeout_ms: 10001 }, { timeout_ms: 1 }]) {
    refused(await query('SELECT 1', args));
  }
});
test('9 expensive native query timeout exits reader; node remains responsive', async () => {
  const t = performance.now();
  const r = await query('WITH RECURSIVE c(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM c WHERE x<1000000000) SELECT sum(x) FROM c',
    { timeout_ms: 300 });
  refused(r); assert.equal(r.code, 'sqlite_timeout'); assert(performance.now() - t < 5000);
  assert.deepEqual(good(await query('SELECT 1')).rows, [[1]]);
  assert.equal((await call('node_status', {})).error, false);
});
test('10 outside/protected/URI/reparse database and companion escape refusal', async () => {
  const outsideDb = path.join(outside, 'outside.db'); await fs.copyFile(dbfile, outsideDb);
  const protectedDb = path.join(root, 'protected', 'private.db'); await fs.copyFile(dbfile, protectedDb);
  for (const file of [outsideDb, protectedDb, 'file:' + dbfile]) refused(await call('sqlite_query', { path: file, sql: 'SELECT 1' }));
  const link = path.join(root, 'escape');
  await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  refused(await call('sqlite_query', { path: path.join(link, 'outside.db'), sql: 'SELECT 1' }));
  const companionDb = path.join(root, 'companion.db'); await fs.copyFile(dbfile, companionDb);
  await fs.writeFile(path.join(outside, 'foreign-wal'), '');
  // A directory junction occupying a native companion name is refused on Windows
  // without needing the host's optional symlink privilege.
  if (process.platform === 'win32') await fs.symlink(outside, companionDb + '-wal', 'junction');
  else await fs.symlink(path.join(outside, 'foreign-wal'), companionDb + '-wal');
  refused(await call('sqlite_query', { path: companionDb, sql: 'SELECT 1' }));
});
test('11 committed active WAL rows visible (not immutable/main-file-only)', async () => {
  walfile = path.join(root, 'live.db'); writer = new DatabaseSync(walfile);
  writer.exec('CREATE TABLE live(value); INSERT INTO live VALUES(1); PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO live VALUES(2)');
  assert.deepEqual(good(await call('sqlite_query', { path: walfile, sql: 'SELECT * FROM live ORDER BY value' })).rows, [[1], [2]]);
});
test('12 DB/WAL/SHM hashes/size/mtime unchanged for reads, schema and rejected operations', async () => {
  writer.exec('INSERT INTO live VALUES(3)');
  const before = await fingerprints(walfile);
  assert(before['-wal'] && before['-shm']);
  assert.deepEqual(good(await call('sqlite_query', { path: walfile, sql: 'SELECT * FROM live ORDER BY value' })).rows, [[1], [2], [3]]);
  good(await call('sqlite_schema', { path: walfile }));
  refused(await call('sqlite_query', { path: walfile, sql: 'PRAGMA wal_checkpoint(TRUNCATE)' }));
  assert.deepEqual(await fingerprints(walfile), before);
  // Read-only guard permits observation and never causes a read-only-root write.
  const rofile = path.join(root, 'read-only', 'ro.db'); await fs.copyFile(dbfile, rofile);
  const roBefore = await fingerprints(rofile);
  good(await call('sqlite_query', { path: rofile, sql: 'SELECT count(*) FROM sample' }));
  assert.deepEqual(await fingerprints(rofile), roBefore);
});
test('13 catalog/classes/auth/legacy compatibility without exec promotion', async () => {
  const cat = JSON.parse((await client.callTool({ name: 'list_capabilities', arguments: {} })).content[0].text);
  for (const name of ['sqlite_schema', 'sqlite_query']) assert.equal(cat.capabilities.find(c => c.name === name).class, 'read');
  refused(await call('sqlite_query', { path: dbfile, sql: 'SELECT 1' }, 'invoke_exec'));
  assert.equal((await call('write_file', { path: path.join(root, 'read-only', 'bad'), content: 'x' }, 'invoke_destructive')).error, true);
  const legacy = new LegacyClient({ name: 'sqlite-legacy', version: '1' });
  await legacy.connect(new LegacyTransport(new URL(url), { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));
  try { assert.deepEqual(good(await call('sqlite_query', { path: dbfile, sql: 'SELECT 1' }, 'invoke_read', legacy)).rows, [[1]]); }
  finally { await legacy.close(); }
});

test('fail closed for malformed database, empty/missing binding and oversized field metadata', async () => {
  const bad = path.join(root, 'bad.db'); await fs.writeFile(bad, 'not a database');
  refused(await call('sqlite_schema', { path: bad }));
  refused(await call('sqlite_query', { path: path.join(root, 'missing.db'), sql: 'SELECT 1' }));
  assert.equal(await fs.stat(path.join(root, 'missing.db')).then(() => true, () => false), false);
  refused(await query('SELECT ?', { params: [true] }));
  refused(await query(''));
  const oversized = await query('SELECT 1 AS "' + 'x'.repeat(1024) + '"', { max_bytes: 512 });
  refused(oversized); assert.equal(oversized.code, 'sqlite_limit');
});
test('two concurrent native readers bounded; third refused and slots recover', async () => {
  const sql = 'WITH RECURSIVE c(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM c WHERE x<1000000000) SELECT sum(x) FROM c';
  const runs = await Promise.all([1, 2, 3].map(() => query(sql, { timeout_ms: 1000 })));
  assert.equal(runs.filter(r => r.code === 'busy').length, 1);
  assert.equal(runs.filter(r => r.code === 'sqlite_timeout').length, 2);
  assert.deepEqual(good(await query('SELECT 1')).rows, [[1]]);
});
test('unauthenticated MCP request is denied on disposable node', async () => {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal(r.status, 401);
});
test('locked database is a bounded busy outcome without repair', async () => {
  const lock = new DatabaseSync(dbfile);
  lock.exec("BEGIN EXCLUSIVE; UPDATE sample SET value='locked' WHERE id=1");
  try {
    const r = await query('SELECT * FROM sample');
    refused(r); assert.equal(r.code, 'busy');
  } finally { lock.exec('ROLLBACK'); lock.close(); }
  assert.deepEqual(good(await query('SELECT value FROM sample WHERE id=1')).rows, [['first']]);
});
test('node exit cannot orphan an expensive native SQLite reader', async () => {
  const pending = query('WITH RECURSIVE c(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM c WHERE x<1000000000) SELECT sum(x) FROM c',
    { timeout_ms: 10000 }).catch(() => null);
  await new Promise(resolve => setTimeout(resolve, 300));
  const own = good(await call('list_processes', { name: 'node', limit: 500 })).filter(p => p.parent_pid === server.pid);
  assert.equal(own.length, 1, 'exact disposable node must have one owned SQLite child');
  const linuxStat = async () => {
    const text = await fs.readFile(`/proc/${own[0].pid}/stat`, 'utf8');
    const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
    return { state: fields[0], cpu: fields[11] + ':' + fields[12], start: fields[19], rss: fields[21] };
  };
  const original = process.platform === 'linux' ? await linuxStat() : null;
  const closed = new Promise(resolve => server.once('close', resolve));
  server.kill(); await closed;
  let gone = false;
  for (let i = 0; i < 40; i++) {
    try { process.kill(own[0].pid, 0); } catch { gone = true; break; }
    if (original) {
      try {
        const current = await linuxStat();
        if (current.start !== original.start) { gone = true; break; } // PID reused: original has exited
        if (current.state === 'Z') {
          // A runner's PID 1 may leave an exited orphan unreaped. Prove native
          // execution and resident memory are gone; never accept a live reader.
          await new Promise(resolve => setTimeout(resolve, 100));
          const after = await linuxStat().catch(e => e.code === 'ENOENT' ? null : Promise.reject(e));
          if (after && after.start === original.start) {
            assert.equal(after.state, 'Z'); assert.equal(after.rss, '0'); assert.equal(after.cpu, current.cpu);
            console.log('Owned reader exited: zombie state, zero resident pages, unchanged CPU ticks; awaiting OS reap');
          }
          gone = true; break;
        }
      } catch (e) { if (e.code === 'ENOENT') { gone = true; break; } throw e; }
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await client.close(); await pending;
  assert(gone, 'owned SQLite reader remained after its node exited');
});
