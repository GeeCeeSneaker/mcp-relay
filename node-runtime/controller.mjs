// Thin ADCP reference-RPC v1 adapter. No directive authority, retries or state store.
import net from 'node:net';
import { randomUUID } from 'node:crypto';

export const CONTROLLER_PROTOCOL = 'adcp-reference-rpc/1';
export const CONTROLLER_ERRORS = { controller_outcome_unknown: 'reconcile', controller_snapshot_unavailable: 'retry_later' };
const MAX_FRAME = 16 * 1024;
const MAX_IN_FLIGHT = 16;
const SHA = /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/;
const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const keys = (x, expected) => object(x) && Object.keys(x).length === expected.length && expected.every((k) => Object.hasOwn(x, k));
const string = (x, max = 128) => typeof x === 'string' && x.length > 0 && x.length <= max;
const sha = (x) => typeof x === 'string' && SHA.test(x);
const positive = (x) => Number.isSafeInteger(x) && x > 0;
const nullable = (x, check) => x === null || check(x);
const date = (x) => string(x, 64) && Number.isFinite(Date.parse(x));
const code = (x) => string(x) && /^[A-Z0-9_:-]+$/.test(x);
const REF_KEYS = ['repository', 'runtime_issue_number', 'directive_comment_id'];
const RECEIPT_KEYS = [
  'repository', 'runtime_issue_number', 'directive_comment_id', 'run_id', 'task_id',
  'task_revision', 'task_spec_commit', 'accepted_policy_commit', 'action', 'model',
  'target_run_id', 'target_ended_at', 'reasoning_effort', 'claimed_at', 'ended_at',
  'outcome_code', 'terminal_disposition', 'candidate_result_head', 'result_tree_sha',
  'implementation_pr', 'delivery_stage', 'delivery_reason_code',
];
function reference(x) {
  return keys(x, REF_KEYS) && string(x.repository, 256)
    && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(x.repository)
    && positive(x.runtime_issue_number) && typeof x.directive_comment_id === 'string'
    && /^[1-9][0-9]{0,19}$/.test(x.directive_comment_id);
}
function validReceipt(r, ref) {
  return keys(r, RECEIPT_KEYS) && REF_KEYS.every((k) => r[k] === ref[k])
    && string(r.run_id) && string(r.task_id) && /^TASK-[0-9]+$/.test(r.task_id)
    && nullable(r.task_revision, positive) && nullable(r.task_spec_commit, sha)
    && sha(r.accepted_policy_commit)
    && ['START_NEW_SESSION', 'RESUME_SESSION', 'STOP_RUN'].includes(r.action)
    // Shape/bounds only: model choice and availability belong to Controller.
    && string(r.model) && nullable(r.reasoning_effort, string)
    && nullable(r.target_run_id, string) && nullable(r.target_ended_at, date)
    && date(r.claimed_at) && nullable(r.ended_at, date) && nullable(r.outcome_code, code)
    && nullable(r.terminal_disposition, (x) => ['CANDIDATE_READY', 'BLOCKED'].includes(x))
    && nullable(r.candidate_result_head, sha)
    && nullable(r.result_tree_sha, sha)
    && nullable(r.implementation_pr, positive)
    && nullable(r.delivery_stage, code) && nullable(r.delivery_reason_code, code);
}
function validResult(x, ref) {
  if (!object(x)) return false;
  if (keys(x, ['state'])) return x.state === 'UNKNOWN';
  if (keys(x, ['state', 'reason'])) {
    return ['UNKNOWN', 'REJECTED', 'NOT_ADMITTED'].includes(x.state) && code(x.reason);
  }
  return keys(x, ['state', 'receipt']) && ['IN_PROGRESS', 'TERMINAL', 'REJECTED'].includes(x.state)
    && validReceipt(x.receipt, ref);
}

const fields = (x, definition) => keys(x, Object.keys(definition)) && Object.entries(definition).every(([k, check]) => check(x[k]));
const nonnegative = (x) => Number.isSafeInteger(x) && x >= 0;
const atom = (x) => string(x) && /^[A-Za-z0-9_.:@+-]+$/.test(x);
const oneOf = (...values) => (x) => values.includes(x);
function validSnapshot(x) {
  const maybe = (check) => (v) => nullable(v, check);
  return fields(x, {
    schema_version: oneOf('adcp.controller-snapshot.v1'), protocol_version: oneOf(CONTROLLER_PROTOCOL),
    controller_version: atom, repository: (v) => string(v, 256) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v),
    observed_at: date, node_id: maybe(atom),
    health: (v) => fields(v, {
      status: oneOf('healthy', 'stale', 'stopped', 'missing', 'invalid'), heartbeat_at: maybe(date),
      age_seconds: maybe((n) => typeof n === 'number' && Number.isFinite(n)),
      controller_identity: maybe(atom), runtime_identity: maybe(atom), process_id: maybe(positive),
      process_start_time: maybe(date), successful_cycle_count: maybe(nonnegative), last_successful_cycle_at: maybe(date),
    }),
    store: (v) => fields(v, { status: oneOf('readable', 'unavailable'), trust: oneOf('validated_on_open', 'unknown') }),
    provider: (v) => fields(v, { name: maybe(atom), default_model: maybe(atom), default_reasoning_effort: maybe(atom), availability: oneOf('unknown') }),
    capacity: (v) => fields(v, { limit: (n) => positive(n) && n <= 64, occupied: maybe(nonnegative), available: maybe(nonnegative) }),
    admission: oneOf('not_evaluated'),
    bindings: (v) => Array.isArray(v) && v.length <= 8 && v.every((b) => fields(b, {
      binding_id: maybe(atom), task_id: maybe(atom), provider: maybe(atom), session_id: maybe(atom),
      created_at: maybe(date), workspace_owner_binding_id: maybe(atom),
    })),
    runs: (v) => Array.isArray(v) && v.length <= 8 && v.every((r) => fields(r, {
      run_id: maybe(atom), binding_id: maybe(atom), task_id: maybe(atom), runtime_issue_number: maybe(positive),
      categories: (a) => Array.isArray(a) && a.length <= 4 && a.every(oneOf('unresolved_launch', 'pending_terminal', 'pending_delivery', 'pending_stop')),
      provider: maybe(atom), session_id: maybe(atom), provider_execution_id: maybe(atom), provider_state: oneOf('ended', 'unresolved'),
      model: maybe(atom), reasoning_effort: maybe(atom), process_id: maybe(positive), process_start_time: maybe(date),
      workspace_owner_binding_id: maybe(atom), result_owner_run_id: maybe(atom), delivery_stage: maybe(code),
    })),
    truncated: (v) => typeof v === 'boolean', agent_telemetry: oneOf(null), resource_summary: oneOf(null),
    last_material_error: maybe((v) => fields(v, { stage: code, reason: code })),
    partial: (v) => Array.isArray(v) && v.length <= 16 && v.every(code),
  });
}

// A single connection, frame and absolute deadline per request. No reconnect,
// redispatch or cancellation claim; the Controller owns any dispatched work.
function exchange(port, deadlineMs, method, ref, validate = validResult) {
  const id = `${method}:${randomUUID()}`; // binds response to this request AND method
  const wire = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id, method, params: ref })}\n`);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let bytes = Buffer.alloc(0), settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    const unknown = () => finish(new Error('controller_outcome_unknown'));
    const timer = setTimeout(unknown, deadlineMs);
    socket.once('connect', () => socket.write(wire));
    socket.on('error', unknown);
    socket.once('close', () => { if (!settled) unknown(); });
    socket.on('data', (chunk) => {
      if (settled) return;
      if (bytes.length + chunk.length > MAX_FRAME) { unknown(); return; }
      bytes = Buffer.concat([bytes, chunk]);
      const lf = bytes.indexOf(10);
      if (lf < 0) return;
      try {
        if (lf !== bytes.length - 1) throw new Error('multiple frames');
        const response = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, lf)));
        if (!keys(response, ['jsonrpc', 'id', 'result']) || response.jsonrpc !== '2.0'
            || response.id !== id || !validate(response.result, ref)) throw new Error('incompatible response');
        finish(null, response.result);
      } catch { unknown(); }
    });
  });
}

export function controllerCapabilities({ port, protocol = CONTROLLER_PROTOCOL, timeoutMs = 10_000, nodeId, fail, factsResult }) {
  // Opt-in is local configuration, never an argument to an MCP call.
  if (port === undefined || port === '') return { tools: {}, meta: {} };
  if (!/^[0-9]+$/.test(String(port)) || !positive(Number(port)) || Number(port) > 65535
      || protocol !== CONTROLLER_PROTOCOL || !Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 30_000) {
    throw new Error('Invalid configured Controller port, protocol or timeout');
  }
  let inFlight = 0;
  const schema = { type: 'object', additionalProperties: false, required: REF_KEYS,
    properties: { repository: { type: 'string' }, runtime_issue_number: { type: 'number' }, directive_comment_id: { type: 'string' } } };
  const tool = (method, description) => ({ d: `${description} Protocol ${CONTROLLER_PROTOCOL}; GitHub remains authority. No endpoint/prompt/shell input.`, s: schema,
    run: async (ref) => {
      if (!reference(ref)) fail('invalid_args', 'Expected one exact repository / runtime Issue / directive comment reference.');
      if (inFlight >= MAX_IN_FLIGHT) fail('busy', 'Controller bridge busy; this call was not dispatched.');
      inFlight++;
      try {
        return factsResult(await exchange(Number(port), timeoutMs, method, ref));
      } catch {
        fail('controller_outcome_unknown', 'No compatible bounded Controller response. Do not redispatch apply_decision; reconcile this exact reference through controller.get_result.',
          { state: 'UNKNOWN', protocol: CONTROLLER_PROTOCOL, reference: ref, reconcile_with: 'controller.get_result' });
      } finally { inFlight--; }
    } });
  return {
    tools: {
      'controller.apply_decision': tool('controller.apply_decision', 'Apply one durable GitHub directive. Can START/RESUME an Agent or STOP an exact run; acknowledgment is not completion.'),
      'controller.get_result': tool('controller.get_result', 'Read the bounded current receipt/result for one exact GitHub reference, without applying it.'),
      'controller.snapshot': {
        d: `Read bounded existing Controller health/Store/ownership facts. Protocol ${CONTROLLER_PROTOCOL}; partial/unknown is explicit; not an admission decision. No Provider or host probe.`,
        s: { type: 'object', additionalProperties: false, properties: {} },
        run: async (args) => {
          if (!keys(args, [])) fail('invalid_args', 'controller.snapshot expects an empty object.');
          if (inFlight >= MAX_IN_FLIGHT) fail('busy', 'Controller bridge busy; this read was not dispatched.');
          inFlight++;
          try {
            const snapshot = await exchange(Number(port), timeoutMs, 'controller.snapshot', {}, validSnapshot);
            // Node identity is bound by this runtime, never by caller arguments.
            if (snapshot.node_id === null && atom(nodeId)) {
              snapshot.node_id = nodeId;
              snapshot.partial = snapshot.partial.filter((v) => v !== 'NODE_IDENTITY_UNBOUND');
            }
            return factsResult(snapshot);
          } catch {
            fail('controller_snapshot_unavailable', 'Controller snapshot unavailable or incompatible; node liveness does not imply Controller readiness.',
              { state: 'UNKNOWN', protocol: CONTROLLER_PROTOCOL });
          } finally { inFlight--; }
        },
      },
    },
    meta: {
      'controller.apply_decision': ['Controller apply START/RESUME/STOP decision', 'exec'],
      'controller.get_result': ['Controller receipt/result', 'read'],
      'controller.snapshot': ['Controller current health/Store/ownership snapshot', 'read'],
    },
  };
}
