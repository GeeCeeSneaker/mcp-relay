// WO-0009: bounded two-snapshot observation. No target signal, sampler or store.
import { setTimeout as delay } from 'node:timers/promises';

const refOf = p => p?.start ? `${p.pid}@${p.start}` : null;
const number = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
export function startOrder(start) {
  const s = String(start);
  if (/^\d+$/.test(s)) return { boot: '', ticks: BigInt(s) };
  const m = /^([a-f0-9]{8})\.(\d+)$/.exec(s);
  return m ? { boot: m[1], ticks: BigInt(m[2]) } : null;
}
export function provenTree(rows, root, limit = 128) {
  const selected = [root]; const seen = new Set([root.pid]);
  for (let i = 0; i < selected.length; i++) {
    const parent = selected[i]; const p = startOrder(parent.start);
    for (const child of rows) {
      const c = startOrder(child.start);
      if (seen.has(child.pid) || child.ppid !== parent.pid || !p || !c || p.boot !== c.boot || c.ticks < p.ticks) continue;
      if (selected.length >= limit + 1) throw Object.assign(new Error('proven descendant limit exceeded'), { code: 'too_large' });
      seen.add(child.pid); selected.push(child);
    }
  }
  return selected;
}
function rate(before, after) {
  if (refOf(before) !== refOf(after) || !number(before?.cpu_time_seconds) || !number(after?.cpu_time_seconds)) return null;
  const elapsed = after.observed_monotonic_seconds - before.observed_monotonic_seconds;
  const delta = after.cpu_time_seconds - before.cpu_time_seconds;
  if (!Number.isFinite(elapsed) || elapsed <= 0 || delta < 0) return null;
  return { elapsed_seconds: elapsed, cpu_time_before_seconds: before.cpu_time_seconds,
    cpu_time_after_seconds: after.cpu_time_seconds, cpu_delta_seconds: delta, cpu_percent_one_core: delta / elapsed * 100 };
}
export async function sampleUsage(a, { snapshot, wait = delay, date = () => new Date().toISOString() }, signal) {
  const match = /^(\d+)@(\S+)$/.exec(a.ref ?? '');
  if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) <= 0 || !startOrder(match[2])) {
    throw Object.assign(new Error('exact pid@start ref required'), { code: 'invalid_args' });
  }
  const interval = a.interval_ms ?? 1000;
  if (!Number.isInteger(interval) || interval < 100 || interval > 5000 || (a.tree !== undefined && typeof a.tree !== 'boolean')) {
    throw Object.assign(new Error('interval_ms must be 100..5000; tree must be boolean'), { code: 'invalid_args' });
  }
  const request = { pid: Number(match[1]), start: match[2], tree: a.tree === true };
  const began = date(); const before = await snapshot(request, signal);
  if (!before.root) throw Object.assign(new Error('exact process is not running'), { code: 'process_exited' });
  if (refOf(before.root) !== a.ref) throw Object.assign(new Error('process start identity differs'), { code: 'identity_mismatch' });
  await wait(interval, undefined, { signal });
  const after = await snapshot(request, signal);
  const ended = date();
  const same = refOf(after.root) === a.ref;
  const measured = same ? rate(before.root, after.root) : null;
  const missing = [];
  if (!measured) missing.push('cpu_rate');
  if (!same || !number(after.root?.rss_bytes)) missing.push('rss');
  const result = { ref: a.ref, pid: request.pid, sample_start: began, sample_end: ended,
    observed_end_ref: refOf(after.root),
    requested_interval_ms: interval, state: !after.root ? 'exited' : !same ? 'identity_mismatch' : missing.length ? 'unavailable' : 'sampled',
    partial: !same || missing.length > 0 || !!before.partial || !!after.partial, missing_fields: missing,
    cpu_unit: 'percent_of_one_logical_core',
    elapsed_seconds: measured?.elapsed_seconds ?? null, cpu_time_before_seconds: number(before.root.cpu_time_seconds) ? before.root.cpu_time_seconds : null,
    cpu_time_after_seconds: same && number(after.root?.cpu_time_seconds) ? after.root.cpu_time_seconds : null,
    cpu_delta_seconds: measured?.cpu_delta_seconds ?? null, cpu_percent_one_core: measured?.cpu_percent_one_core ?? null,
    rss_bytes: same && number(after.root?.rss_bytes) ? after.root.rss_bytes : null,
    descendant_count: same ? after.members.filter(p => p.pid !== request.pid).length : null };
  if (request.tree) {
    const prior = new Map(before.members.map(p => [refOf(p), p]));
    const next = new Map(after.members.map(p => [refOf(p), p]));
    const cohortChanged = prior.size !== next.size || [...prior.keys()].some(k => !next.has(k));
    let cpu = 0, delta = 0, rss = 0, observed = 0; const unknown = [];
    for (const [ref, p] of next) {
      const r = rate(prior.get(ref), p);
      if (!r || !number(p.rss_bytes)) { unknown.push(ref); continue; }
      cpu += r.cpu_percent_one_core; delta += r.cpu_delta_seconds; rss += p.rss_bytes; observed++;
    }
    const partial = !same || !!before.partial || !!after.partial || cohortChanged || unknown.length > 0;
    result.tree = { partial, cohort_changed: cohortChanged, observed_process_count: observed, unavailable_refs: unknown,
      sampled_refs: [...next.keys()],
      cpu_percent_one_core: partial ? null : cpu, cpu_delta_seconds: partial ? null : delta,
      rss_bytes: partial ? null : rss, proven_observed_cpu_delta_seconds: same ? delta : null };
    result.partial ||= partial;
  }
  return result;
}
export function processUsageCapabilities({ snapshot, fail, factsResult }) {
  let active = 0;
  return { meta: { process_usage: ['Exact process resource sample', 'read'] }, tools: {
    process_usage: {
      d: 'Bounded CPU/RSS observation of exact ref pid@start. interval_ms 100..5000 (1000), tree false by default. CPU percent is of one logical core, not divided by host core count; a tree can exceed 100%. Proven descendants only, identity checked before/after. Exit/reuse/unavailable/cohort changes are explicit partial facts, unknown rates are null. No target signal or persistent sampler. Get the ref from process_info or target_status.',
      s: { type: 'object', properties: { ref: { type: 'string' }, interval_ms: { type: 'number' }, tree: { type: 'boolean' } }, required: ['ref'] },
      run: async (a, signal) => {
        if (active >= 4) fail('busy', 'Four process samples are already active');
        active++;
        const controller = new AbortController();
        const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        const deadline = setTimeout(abort, 30000);
        try { return factsResult(await sampleUsage(a, { snapshot }, controller.signal)); }
        catch (e) { fail(e.name === 'AbortError' ? 'timeout' : e.code || 'process_usage_unavailable',
          ['invalid_args', 'identity_mismatch', 'process_exited', 'too_large'].includes(e.code) ? e.message : 'Process counters unavailable or bounded observation cancelled'); }
        finally { clearTimeout(deadline); signal?.removeEventListener('abort', abort); active--; }
      },
    },
  } };
}
