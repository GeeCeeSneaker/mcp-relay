// Private fixed worker for sqlite.mjs, never a caller-supplied program. A fresh
// process avoids sharing a writable WAL mapping with another connection and
// allows the parent to interrupt native SQLite work by terminating only this child.
import { DatabaseSync, constants as C } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';

const MAX_SCHEMA_ENTRIES = 1000;
const encode = v => typeof v === 'bigint'
  ? (v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(v) : { type: 'integer', value: String(v) })
  : v instanceof Uint8Array ? { type: 'blob', base64: Buffer.from(v).toString('base64') }
    : typeof v === 'number' && !Number.isFinite(v) ? { type: 'real', value: String(v) } : v;
const bytes = r => Buffer.byteLength(JSON.stringify(r, null, 1));
if (isMainThread) {
  // Keep this tiny supervisor responsive while SQLite executes native code in
  // its worker thread. Parent death must not orphan an unbounded native query.
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 140000) { process.stdout.write(JSON.stringify({ error: 'sqlite_limit' })); process.exit(0); }
  }
  let request;
  try { request = JSON.parse(input); } catch { process.stdout.write(JSON.stringify({ error: 'sqlite_rejected' })); process.exit(0); }
  let finished = false;
  const finish = message => {
    if (finished) return;
    finished = true; clearTimeout(deadline);
    process.stdout.write(JSON.stringify(message), () => process.exit(0));
  };
  // process.exit() can wait for a thread stuck in native SQLite. Only an OS
  // process kill guarantees interruption when the owning node has disappeared.
  const hardExit = () => process.kill(process.pid, 'SIGKILL');
  process.once('disconnect', hardExit);
  if (process.connected === false) hardExit();
  const deadline = setTimeout(hardExit, Math.min(request.timeout_ms ?? 2000, 10000));
  const worker = new Worker(new URL(import.meta.url), {
    workerData: input, resourceLimits: { maxOldGenerationSizeMb: 16 },
  });
  worker.once('message', finish);
  worker.once('error', () => finish({ error: 'sqlite_unavailable' }));
} else {
  const input = workerData;
  let db;
  let denied = false;
  try {
    const a = JSON.parse(input);
    const uri = pathToFileURL(a.file);
    uri.search = 'mode=ro&readonly_shm=1';
    db = new DatabaseSync(uri.href, {
      readOnly: true, allowExtension: false, defensive: true,
      readBigInts: true, returnArrays: true, allowBareNamedParameters: false,
      allowUnknownNamedParameters: false, timeout: 0,
    });
    if (typeof db.setAuthorizer !== 'function' || !db.limits) throw { code: 'sqlite_unavailable' };
    // Connection/process-local settings only. No journal mode, schema or file mutation.
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; PRAGMA hard_heap_limit=33554432; BEGIN');
    db.enableLoadExtension(false);
    db.limits.length = 2 * 1024 * 1024;
    db.limits.sqlLength = 65536;
    db.limits.attach = 0;
    db.limits.vdbeOp = 100000;
    const schemaPragmas = new Set(['table_xinfo', 'index_list', 'index_xinfo', 'foreign_key_list', 'journal_mode', 'schema_version']);
    db.setAuthorizer((action, arg1, arg2, database) => {
      const allowed = action === C.SQLITE_SELECT || action === C.SQLITE_RECURSIVE
        || (action === C.SQLITE_READ && (database === 'main' || database === null))
        || (action === C.SQLITE_FUNCTION && !['load_extension', 'readfile', 'writefile', 'zipfile', 'fts3_tokenizer'].includes(String(arg2).toLowerCase()))
        || (a.op === 'schema' && action === C.SQLITE_PRAGMA && schemaPragmas.has(arg1));
      if (!allowed) denied = true;
      return allowed ? C.SQLITE_OK : C.SQLITE_DENY;
    });
    const result = { observed_at: new Date().toISOString(), read_only: true, truncated: false };
    if (a.op === 'query') {
      const stmt = db.prepare(a.sql);
      // SQLite's own parsed source, not a SELECT-prefix/parser approximation.
      // Reject any non-whitespace tail (including a second statement).
      if (!stmt.sourceSQL || !a.sql.startsWith(stmt.sourceSQL) || a.sql.slice(stmt.sourceSQL.length).trim()) throw { code: 'sqlite_rejected' };
      Object.assign(result, { columns: stmt.columns().map(c => c.name), rows: [], row_count: 0 });
      if (bytes(result) > a.max_bytes) throw { code: 'sqlite_limit' };
      const iterable = a.named ? stmt.iterate(a.bindings) : stmt.iterate(...a.bindings);
      for (const raw of iterable) {
        if (result.rows.length >= a.max_rows) { result.truncated = true; break; }
        const row = raw.map(encode);
        result.rows.push(row); result.row_count++;
        // Reserve the slightly longer "false" flag while deciding fit.
        if (bytes(result) > a.max_bytes) {
          result.rows.pop(); result.row_count--; result.truncated = true; break;
        }
      }
    } else if (a.op === 'schema') {
      const get = sql => db.prepare(sql).get().map(encode)[0];
      result.database = { sqlite_version: get('SELECT sqlite_version()'),
        journal_mode: get('PRAGMA journal_mode'), schema_version: get('PRAGMA schema_version') };
      result.tables = [];
      let entries = 0;
      const metadata = (sql, value) => {
        const stmt = db.prepare(sql); const columns = stmt.columns().map(c => c.name); const rows = [];
        for (const row of stmt.iterate(value)) {
          if (++entries > MAX_SCHEMA_ENTRIES) { result.truncated = true; break; }
          rows.push(Object.fromEntries(columns.map((name, i) => [name, encode(row[i])])));
        }
        return rows;
      };
      const tables = db.prepare("SELECT name,type FROM sqlite_schema WHERE type IN ('table','view') AND (? IS NULL OR name=?) ORDER BY name");
      for (const [name, type] of tables.iterate(a.table ?? null, a.table ?? null)) {
        if (result.tables.length >= a.max_tables || entries >= MAX_SCHEMA_ENTRIES) { result.truncated = true; break; }
        const table = { name, type, columns: metadata('SELECT * FROM pragma_table_xinfo(?)', name),
          indexes: metadata('SELECT * FROM pragma_index_list(?)', name),
          foreign_keys: metadata('SELECT * FROM pragma_foreign_key_list(?)', name) };
        for (const index of table.indexes) index.columns = metadata('SELECT * FROM pragma_index_xinfo(?)', index.name);
        if (result.truncated) table.details_truncated = true;
        result.tables.push(table);
        if (bytes(result) > a.max_bytes) { result.tables.pop(); result.truncated = true; break; }
      }
    } else throw { code: 'sqlite_rejected' };
    if (bytes(result) > a.max_bytes) throw { code: 'sqlite_limit' };
    db.close(); db = null;
    parentPort.postMessage({ result });
  } catch (e) {
    try { db?.close(); } catch {}
    const code = ['sqlite_unavailable', 'sqlite_rejected', 'sqlite_limit'].includes(e.code) ? e.code
      : denied || e.errcode === 23 ? 'sqlite_rejected'
      : e.errcode === 5 || e.errcode === 6 ? 'busy'
        : e.errcode === 7 || e.errcode === 18 ? 'sqlite_limit' : 'sqlite_error';
    // Do not echo SQL, parameters, database contents or private filenames on failure.
    parentPort.postMessage({ error: code });
  }
}
