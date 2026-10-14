// WO-0008: one bounded, short-lived Node reader per call. No caller program,
// connection pool, database copy or background work.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SQLITE_ERRORS = {
  sqlite_unavailable: 'stop', sqlite_rejected: 'fix_args', sqlite_error: 'fix_args',
  sqlite_limit: 'fix_args', sqlite_timeout: 'retry_later',
};
const WORKER = fileURLToPath(new URL('./sqlite-worker.mjs', import.meta.url));
const MAX_BYTES = 1024 * 1024;

export function sqliteCapabilities({ allowedPath, fail, factsResult }) {
  let active = 0;
  const integer = (v, fallback, min, max, name) => {
    const n = v ?? fallback;
    if (!Number.isInteger(n) || n < min || n > max) fail('invalid_args', `${name} must be an integer in ${min}..${max}`);
    return n;
  };
  async function run(op, a, signal) {
    if (typeof a.path !== 'string' || !path.isAbsolute(a.path) || a.path.includes('\0')) {
      fail('invalid_args', 'path must be an absolute local database filename, not a URI');
    }
    const file = await allowedPath(a.path, 'read');
    if (!(await fs.stat(file)).isFile()) fail('invalid_args', 'database must be a regular file');
    // SQLite opens companions itself. Validate those names too; do not let a
    // companion link make a native open escape the existing file/guard policy.
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const companion = file + suffix;
      try {
        const st = await fs.lstat(companion);
        const real = await allowedPath(companion, 'read');
        if (st.isSymbolicLink() || path.resolve(real) !== path.resolve(companion) || !st.isFile()) {
          fail('path_not_allowed', 'SQLite companions must be regular files beside the database');
        }
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    const max_bytes = integer(a.max_bytes, 128 * 1024, 512, MAX_BYTES, 'max_bytes');
    const timeout_ms = integer(a.timeout_ms, 2000, 50, 10000, 'timeout_ms');
    const request = { op, file, max_bytes, timeout_ms };
    if (op === 'query') {
      if (typeof a.sql !== 'string' || !a.sql.trim() || a.sql.includes('\0') || Buffer.byteLength(a.sql) > 65536) {
        fail('invalid_args', 'sql must be one nonempty statement of at most 65536 bytes');
      }
      if (a.params !== undefined && a.named_params !== undefined) fail('invalid_args', 'use params or named_params, not both');
      const bindings = a.params ?? a.named_params ?? [];
      if (a.params !== undefined && !Array.isArray(a.params)) fail('invalid_args', 'params must be an array');
      if (a.named_params !== undefined && (!a.named_params || Array.isArray(a.named_params) || typeof a.named_params !== 'object')) {
        fail('invalid_args', 'named_params must be an object');
      }
      const values = Object.values(bindings);
      if (values.length > 1000 || values.some(v => v !== null && typeof v !== 'string'
        && !(typeof v === 'number' && Number.isFinite(v) && (!Number.isInteger(v) || Number.isSafeInteger(v))))
        || Buffer.byteLength(JSON.stringify(bindings)) > 65536) fail('invalid_args', 'unsupported or oversized SQL parameters');
      Object.assign(request, { sql: a.sql, bindings, named: a.named_params !== undefined,
        max_rows: integer(a.max_rows, 200, 1, 1000, 'max_rows') });
    } else {
      if (a.table !== undefined && (typeof a.table !== 'string' || !a.table || a.table.includes('\0') || Buffer.byteLength(a.table) > 1024)) {
        fail('invalid_args', 'table must be an exact nonempty table/view name of at most 1024 bytes');
      }
      Object.assign(request, { table: a.table, max_tables: integer(a.max_tables, 100, 1, 200, 'max_tables') });
    }
    if (signal?.aborted) fail('sqlite_timeout', 'SQLite call was cancelled');
    if (active >= 2) fail('busy', 'Two SQLite readers are already active; retry later');
    active++;
    try {
      const result = await new Promise((resolve, reject) => {
        // Do not inherit NODE_OPTIONS, preload hooks, tokens or caller programs.
        const env = {};
        for (const k of ['SystemRoot', 'WINDIR', 'SYSTEMDRIVE', 'TMP', 'TEMP']) if (process.env[k]) env[k] = process.env[k];
        const child = spawn(process.execPath, ['--max-old-space-size=32', WORKER], {
          windowsHide: true, stdio: ['pipe', 'pipe', 'ignore', 'ipc'], env,
        });
        let output = ''; let reason = null; let spawnError = false;
        const stop = (code) => { reason ??= code; child.kill('SIGKILL'); };
        const timer = setTimeout(() => stop('sqlite_timeout'), timeout_ms);
        const abort = () => stop('sqlite_timeout');
        signal?.addEventListener('abort', abort, { once: true });
        child.on('error', () => { spawnError = true; });
        child.stdin?.on('error', () => {}); // child may exit before receiving input
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', data => {
          output += data;
          if (Buffer.byteLength(output) > max_bytes + 1024) { output = ''; stop('sqlite_limit'); }
        });
        child.on('close', code => {
          clearTimeout(timer); signal?.removeEventListener('abort', abort);
          // A timed-out call resolves only after its owned child actually exits.
          if (reason) return reject({ code: reason });
          if (spawnError || code !== 0) return reject({ code: 'sqlite_unavailable' });
          try {
            const r = JSON.parse(output);
            if (r.error) return reject({ code: r.error });
            if (Buffer.byteLength(JSON.stringify(r.result, null, 1)) > max_bytes) return reject({ code: 'sqlite_limit' });
            resolve(r.result);
          } catch { reject({ code: 'sqlite_unavailable' }); }
        });
        child.stdin?.end(JSON.stringify(request));
      });
      return factsResult(result);
    } catch (e) {
      const code = Object.hasOwn(SQLITE_ERRORS, e.code) || e.code === 'busy' ? e.code : 'sqlite_unavailable';
      fail(code, {
        sqlite_timeout: 'SQLite reader exceeded its deadline and has exited; no background query remains',
        sqlite_limit: 'SQLite result or memory limit exceeded',
        sqlite_rejected: 'SQLite statement is not an authorized single read',
        sqlite_error: 'SQLite could not read this database or statement',
        sqlite_unavailable: 'SQLite reader requires compatible Node SQLite support and could not complete',
        busy: 'SQLite database is busy; no recovery or mutation was attempted',
      }[code]);
    } finally { active--; }
  }
  const str = { type: 'string' }; const num = { type: 'number' };
  const bounds = { path: str, max_bytes: num, timeout_ms: num };
  return {
    meta: { sqlite_schema: ['SQLite schema', 'read'], sqlite_query: ['SQLite query', 'read'] },
    tools: {
      sqlite_schema: {
        d: 'Read bounded SQLite tables/views, columns, indexes and foreign keys. Exact optional table filter. No arbitrary PRAGMA. Uses read-only DB/WAL/SHM access. max_tables 1..200 (100), max_bytes 512..1048576 (131072), timeout_ms 50..10000 (2000).',
        s: { type: 'object', properties: { ...bounds, table: str, max_tables: num }, required: ['path'] },
        run: (a, signal) => run('schema', a, signal),
      },
      sqlite_query: {
        d: 'One bounded SQLite read, enforced by a read-only connection and SQLite authorizer. Positional params array OR named_params object (keys include their SQL prefix). No writes/DDL/PRAGMA/ATTACH/extensions. max_rows 1..1000 (200), max_bytes 512..1048576 (131072), timeout_ms 50..10000 (2000). rows are arrays aligned with columns; large integers and blobs have explicit typed JSON values. Bounds apply to the structured JSON result, excluding MCP envelope.',
        s: { type: 'object', properties: { ...bounds, sql: str, params: { type: 'array' },
          named_params: { type: 'object' }, max_rows: num }, required: ['path', 'sql'] },
        run: (a, signal) => run('query', a, signal),
      },
    },
  };
}
