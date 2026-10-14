// Fixed read-only collector for process_usage. Reuses the existing Windows
// helper; Linux uses one atomic /proc stat record and verified getconf units.
import fs from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { provenTree } from './process-usage.mjs';

const error = (message, code = 'process_usage_unavailable') => Object.assign(new Error(message), { code });
function helperRead(helper, request, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(error('observation cancelled', 'timeout'));
    const env = {};
    for (const k of ['SystemRoot', 'WINDIR', 'SYSTEMDRIVE', 'TMP', 'TEMP']) if (process.env[k]) env[k] = process.env[k];
    const child = spawn(helper, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env });
    let output = ''; let failure = null;
    const stop = code => { failure ??= error('bounded process helper unavailable', code); child.kill(); };
    const timer = setTimeout(() => stop('timeout'), 3000);
    const abort = () => stop('timeout'); signal?.addEventListener('abort', abort, { once: true });
    child.on('error', () => { failure ??= error('process helper unavailable'); });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', s => { output += s; if (Buffer.byteLength(output) > 1024 * 1024) stop('too_large'); });
    child.stdin?.on('error', () => {});
    child.on('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (failure) return reject(failure);
      try { const r = JSON.parse(output); if (code !== 0 || !r.ok || !Array.isArray(r.processes)) throw error('invalid helper result'); resolve(r.processes.filter(p => !p.exited)); }
      catch { reject(error('process helper counters unavailable')); }
    });
    child.stdin?.end(JSON.stringify({ op: 'inspect', ...request }));
  });
}
let units;
async function linuxUnits() {
  units ??= (async () => {
    const get = name => new Promise((resolve, reject) => execFile('getconf', [name],
      { timeout: 1000, maxBuffer: 128, env: { PATH: '/usr/bin:/bin', LANG: 'C' } },
      (e, out) => e ? reject(error('system counter units unavailable')) : resolve(Number(out.trim()))));
    const [hz, page, rawBoot] = await Promise.all([get('CLK_TCK'), get('PAGESIZE'), fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')]);
    if (!Number.isInteger(hz) || hz < 1 || hz > 1000000 || !Number.isInteger(page) || page < 512 || page > 1048576
      || !/^[a-f0-9-]{36}\s*$/.test(rawBoot)) throw error('unproven counter units/boot identity');
    return { hz, page, boot: rawBoot.trim().replace(/-/g, '').slice(0, 8) };
  })();
  return units;
}
async function linuxRead(pids, metrics, signal) {
  const { hz, page, boot } = await linuxUnits();
  const list = pids ?? (await fs.readdir('/proc')).filter(p => /^\d+$/.test(p)).map(Number);
  if (list.length > 8192) throw error('process enumeration bound exceeded', 'too_large');
  return (await Promise.all(list.map(async pid => {
    if (signal?.aborted) throw error('observation cancelled', 'timeout');
    try {
      const text = await fs.readFile(`/proc/${pid}/stat`, { encoding: 'utf8', signal });
      const f = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
      if (f[0] === 'Z' || f[0] === 'X') return null;
      const row = { pid, ppid: Number(f[1]), start: `${boot}.${f[19]}` };
      if (metrics) Object.assign(row, { cpu_time_seconds: (Number(f[11]) + Number(f[12])) / hz,
        rss_bytes: Number(f[21]) * page, observed_monotonic_seconds: performance.now() / 1000 });
      return row;
    } catch (e) { if (['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(e.code)) return null; throw e; }
  }))).filter(Boolean);
}
export function nativeUsageSnapshot({ windows, helper }) {
  const read = (pids, metrics, signal) => windows
    ? helperRead(helper, { ...(pids ? { pids } : { all: true }), metrics, identity_only: true }, signal)
    : linuxRead(pids, metrics, signal);
  return async (request, signal) => {
    // Full-system enumeration is identity metadata only. CPU/RSS is read only
    // for the root and proven members, never unrelated process attribution.
    const initial = await read(request.tree ? null : [request.pid], false, signal);
    const root = initial.find(p => p.pid === request.pid);
    if (!root) return { root: null, members: [] };
    if (!root.start) throw error('process start identity unavailable');
    if (root.start !== request.start) return { root, members: [] };
    const members = request.tree ? provenTree(initial, root) : [root];
    const metrics = await read(members.map(p => p.pid), true, signal);
    const latest = await read(request.tree ? null : [request.pid], false, signal);
    const endRoot = latest.find(p => p.pid === request.pid);
    if (!endRoot || endRoot.start !== root.start) return { root: endRoot ?? null, members: [], partial: true };
    const endMembers = request.tree ? provenTree(latest, endRoot) : [endRoot];
    const endMap = new Map(endMembers.map(p => [p.pid, p]));
    const stable = metrics.filter(p => {
      const before = members.find(m => m.pid === p.pid); const after = endMap.get(p.pid);
      return before?.start === p.start && after?.start === p.start && before.ppid === p.ppid && after.ppid === p.ppid && !p.exited;
    });
    const selected = new Set(members.map(p => `${p.pid}@${p.start}`));
    const changed = endMembers.length !== members.length || endMembers.some(p => !selected.has(`${p.pid}@${p.start}`));
    const unproven = request.tree && latest.some(p => endMap.has(p.ppid) && !p.start);
    return { root: stable.find(p => p.pid === root.pid) ?? endRoot, members: stable,
      partial: changed || !!unproven || stable.length !== members.length };
  };
}
