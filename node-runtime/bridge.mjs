#!/usr/bin/env node
// MCPRelay local adapter (module M1): exposes ONE long-lived Desktop Commander
// stdio process as a loopback-only MCP Streamable HTTP endpoint.
//
// Why not Supergateway: it spawns a DC child per request/session, so processes
// started with start_process are lost between calls, and it binds all
// interfaces (ADR-0002 F3, docs/evidence/P0-S1-local-adapter.md).
//
// Every HTTP session shares the single DC instance. The bridge performs the
// MCP handshake with DC itself, answers client `initialize` from that cached
// result, and remaps JSON-RPC ids so concurrent sessions cannot collide.
//
//   node bridge.mjs [--port 18001] [--host 127.0.0.1] [--path /mcp]
//
// Auth: if MCPRELAY_BRIDGE_TOKEN is set, every /mcp request must carry
// `Authorization: Bearer <token>` (the gateway's backend credential). The
// variable is removed from the environment before DC starts, so commands run
// through DC cannot read it.

import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import { Server as ModernServer, ProtocolError, createMcpHandler, isLegacyRequest } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';

const { values: opt } = parseArgs({
  options: {
    port: { type: 'string', default: '18001' },
    host: { type: 'string', default: '127.0.0.1' },
    path: { type: 'string', default: '/mcp' },
  },
});

const require = createRequire(import.meta.url);
const DC_ENTRY = require.resolve('@wonderwhy-er/desktop-commander/package.json').replace(/package\.json$/, 'dist/index.js');
const VERSION = '0.4.0';

const TOKEN = process.env.MCPRELAY_BRIDGE_TOKEN || '';
delete process.env.MCPRELAY_BRIDGE_TOKEN;
const digest = (s) => createHash('sha256').update(s).digest();
const TOKEN_DIGEST = TOKEN ? digest(TOKEN) : null;
function authorized(req) {
  if (!TOKEN_DIGEST) return true;
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  return !!m && timingSafeEqual(digest(m[1]), TOKEN_DIGEST);
}
const SESSION_IDLE_MS = 30 * 60 * 1000;
const RESTART_DELAY_MS = [1000, 2000, 5000, 10000];

const log = (...a) => console.error(new Date().toISOString(), '[bridge]', ...a);
const isRequest = (m) => 'method' in m && 'id' in m;
const isResponse = (m) => !('method' in m) && 'id' in m;
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

// DC tags some tools with MCP-Apps/ChatGPT widget metadata pointing at ~1.2 MB
// ui:// HTML resources. Through a namespacing gateway those URIs no longer
// resolve, and fetching them over the tunnel is slow. MCPRelay only needs the
// tools themselves, so the bridge always hides the widget references.
const UI_META_KEYS = ['ui/resourceUri', 'openai/outputTemplate', 'openai/widgetAccessible', 'ui'];
function stripUiMeta(result) {
  if (!Array.isArray(result?.tools)) return result;
  const tools = result.tools.map((t) => {
    if (!t._meta) return t;
    const meta = Object.fromEntries(Object.entries(t._meta).filter(([k]) => !UI_META_KEYS.includes(k)));
    const { _meta, ...rest } = t;
    return Object.keys(meta).length ? { ...rest, _meta: meta } : rest;
  });
  return { ...result, tools };
}

// ---------------------------------------------------------------- DC child --
let dc = null;             // StdioClientTransport of the running DC
let dcReady = null;        // Promise<initialize result> for the running DC
let dcPid = null;
let restarts = 0;
let nextId = 1;
const pending = new Map(); // bridge id -> { session, id, method }
const progressOwner = new Map(); // progressToken -> session

function startDc() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [DC_ENTRY, '--no-onboarding'],
    env: process.env,       // keep the user's full environment for DC commands
    stderr: 'inherit',
  });
  dc = transport;
  let resolveInit;
  let rejectInit;
  dcReady = new Promise((res, rej) => { resolveInit = res; rejectInit = rej; });
  dcReady.catch(() => {});
  const initId = `bridge-init-${nextId++}`;

  transport.onmessage = (msg) => {
    if (isResponse(msg) && msg.id === initId) {
      if (msg.error) return rejectInit(new Error(msg.error.message));
      transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      restarts = 0;
      log(`DC ready (pid ${dcPid}, protocol ${msg.result.protocolVersion})`);
      return resolveInit(msg.result);
    }
    fromDc(msg);
  };
  transport.onerror = (err) => log('DC transport error:', err.message);
  transport.onclose = () => {
    if (dc !== transport) return;
    log(`DC exited (pid ${dcPid})`);
    rejectInit(new Error('Desktop Commander exited'));
    for (const [bid, p] of pending) {
      if (p.reject) p.reject(Object.assign(new Error('Desktop Commander restarted; request aborted'), { code: -32603 }));
      else p.session.transport.send(rpcError(p.id, -32603, 'Desktop Commander restarted; request aborted')).catch(() => {});
      pending.delete(bid);
    }
    dc = null;
    dcPid = null;
    if (shuttingDown) return;
    const delay = RESTART_DELAY_MS[Math.min(restarts++, RESTART_DELAY_MS.length - 1)];
    setTimeout(startDc, delay);
  };

  transport.start().then(() => {
    dcPid = transport.pid;
    transport.send({
      jsonrpc: '2.0', id: initId, method: 'initialize',
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'mcprelay-bridge', version: VERSION },
      },
    });
  }, (err) => {
    log('failed to start DC:', err.message);
    transport.onclose();
  });
}

function fromDc(msg) {
  if (isResponse(msg)) {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (p.resolve) { // request issued by the modern (2026-07-28) leg
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code, data: msg.error.data }));
      else p.resolve(msg.result);
      return;
    }
    const out = p.method === 'tools/list' && msg.result ? { ...msg, result: stripUiMeta(msg.result) } : msg;
    p.session.transport.send({ ...out, id: p.id }).catch((e) => log('send to client failed:', e.message));
    return;
  }
  if (isRequest(msg)) {
    // The bridge declares no client capabilities, so DC should not ask for any.
    dc?.send(rpcError(msg.id, -32601, 'Not supported by MCPRelay bridge'));
    return;
  }
  // Notification: progress goes to its owner, everything else to all sessions.
  const token = msg.params?.progressToken;
  const targets = msg.method === 'notifications/progress' && progressOwner.has(token)
    ? [progressOwner.get(token)]
    : [...sessions.values()];
  for (const s of targets) s.transport.send(msg).catch(() => {});
}

// ------------------------------------------------- modern (2026-07-28) leg --
// Sessionless clients (the gateway, ChatGPT-era SDKs) get the 2026-07-28
// protocol: no initialize/initialized/GET/DELETE round trips per connection.
// Each request is served by a throwaway SDK v2 Server whose handlers forward to
// the same long-lived DC over its existing (2025-era) stdio session.
function dcRequest(method, params) {
  return dcReady.then(() => new Promise((resolve, reject) => {
    const bid = nextId++;
    pending.set(bid, { resolve, reject, method });
    dc.send({ jsonrpc: '2.0', id: bid, method, ...(params === undefined ? {} : { params }) })
      .catch((e) => { pending.delete(bid); reject(e); });
  }));
}

// Strip the per-request envelope keys the 2025-era DC does not understand.
function legacyParams(params) {
  if (!params?._meta) return params;
  const meta = Object.fromEntries(Object.entries(params._meta).filter(([k]) => !k.startsWith('io.modelcontextprotocol/')));
  const { _meta, ...rest } = params;
  return Object.keys(meta).length ? { ...rest, _meta: meta } : rest;
}

const FORWARDED = {
  tools: ['tools/list', 'tools/call'],
  resources: ['resources/list', 'resources/read', 'resources/templates/list'],
  prompts: ['prompts/list', 'prompts/get'],
  completions: ['completion/complete'],
};

async function modernServer() {
  const init = await dcReady;
  const capabilities = {};
  for (const cap of Object.keys(FORWARDED)) if (init.capabilities?.[cap]) capabilities[cap] = {};
  const server = new ModernServer(init.serverInfo, { capabilities, instructions: init.instructions });
  for (const cap of Object.keys(capabilities)) {
    for (const method of FORWARDED[cap]) {
      server.setRequestHandler(method, async (request) => {
        try {
          const result = await dcRequest(method, legacyParams(request.params));
          return method === 'tools/list' ? stripUiMeta(result) : result;
        } catch (e) {
          if (typeof e.code === 'number') throw new ProtocolError(e.code, e.message, e.data);
          throw e;
        }
      });
    }
  }
  return server;
}
const modernHandler = toNodeHandler(createMcpHandler(modernServer, { legacy: 'reject' }));

const MAX_BODY = 4 * 1024 * 1024;
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Request body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('Parse error: invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function probeRequest(req) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  return new Request(`http://localhost${req.url}`, { method: req.method, headers });
}

// ---------------------------------------------------------- HTTP sessions --
const sessions = new Map(); // sessionId -> { transport, lastSeen }

async function fromClient(session, msg) {
  session.lastSeen = Date.now();
  if (isRequest(msg) && msg.method === 'initialize') {
    try {
      const init = await dcReady;
      const requested = msg.params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : init.protocolVersion;
      await session.transport.send({ jsonrpc: '2.0', id: msg.id, result: { ...init, protocolVersion } });
    } catch (err) {
      await session.transport.send(rpcError(msg.id, -32603, `Desktop Commander unavailable: ${err.message}`));
    }
    return;
  }
  if (msg.method === 'notifications/initialized') return; // bridge already did this with DC
  if (isRequest(msg) && msg.method === 'ping') {
    await session.transport.send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }
  if (isResponse(msg)) return; // answers to server->client requests; never issued

  try {
    await dcReady;
  } catch (err) {
    if (isRequest(msg)) await session.transport.send(rpcError(msg.id, -32603, `Desktop Commander unavailable: ${err.message}`));
    return;
  }
  if (isRequest(msg)) {
    const bid = nextId++;
    pending.set(bid, { session, id: msg.id, method: msg.method });
    const token = msg.params?._meta?.progressToken;
    if (token !== undefined) progressOwner.set(token, session);
    await dc.send({ ...msg, id: bid });
    return;
  }
  if (msg.method === 'notifications/cancelled') {
    for (const [bid, p] of pending) {
      if (p.session === session && p.id === msg.params?.requestId) {
        await dc.send({ ...msg, params: { ...msg.params, requestId: bid } });
      }
    }
    return;
  }
  await dc.send(msg);
}

function dropSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  for (const [bid, p] of pending) if (p.session === s) pending.delete(bid);
  for (const [token, owner] of progressOwner) if (owner === s) progressOwner.delete(token);
}

function newSession() {
  const session = { transport: null, lastSeen: Date.now() };
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => sessions.set(id, session),
    // Answer POSTs with plain JSON instead of a one-event SSE stream: SSE
    // clients cap single events (e.g. 1 MiB in the gateway's httpx2), which
    // large read_file results exceed. Notifications still use the GET stream.
    enableJsonResponse: true,
  });
  transport.onmessage = (msg) => fromClient(session, msg).catch((e) => log('client message failed:', e.message));
  transport.onclose = () => dropSession(transport.sessionId);
  session.transport = transport;
  return session;
}

const http = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/healthz' && req.method === 'GET') {
    let dcUp = false;
    try { dcUp = !!(await Promise.race([dcReady, new Promise((r) => setTimeout(r, 50))])); } catch { /* down */ }
    res.writeHead(dcUp ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ bridge: VERSION, dc: dcUp ? 'up' : 'down', dcPid, sessions: sessions.size, pending: pending.size }));
    return;
  }
  if (url.pathname !== opt.path) {
    res.writeHead(404).end();
    return;
  }
  if (!authorized(req)) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify(rpcError(null, -32001, 'Unauthorized')));
    return;
  }
  let parsedBody;
  if (req.method === 'POST') {
    try {
      parsedBody = await readJsonBody(req);
    } catch (e) {
      res.writeHead(e.status || 400, { 'content-type': 'application/json' });
      res.end(JSON.stringify(rpcError(null, -32700, e.message)));
      return;
    }
  }
  if (!(await isLegacyRequest(probeRequest(req), parsedBody, { maxRequestBodySize: MAX_BODY }))) {
    await modernHandler(req, res, parsedBody);
    return;
  }
  const sid = req.headers['mcp-session-id'];
  let session = sid ? sessions.get(sid) : undefined;
  if (sid && !session) {
    // Unknown/expired session: 404 tells spec-compliant clients to re-initialize.
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(rpcError(null, -32001, 'Session not found')));
    return;
  }
  if (!session) session = newSession();
  session.lastSeen = Date.now();
  await session.transport.handleRequest(req, res, parsedBody);
});

setInterval(() => {
  const cutoff = Date.now() - SESSION_IDLE_MS;
  for (const [id, s] of sessions) {
    if (s.lastSeen < cutoff) {
      log(`closing idle session ${id}`);
      s.transport.close().catch(() => {});
      dropSession(id);
    }
  }
}, 60 * 1000).unref();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal}: shutting down`);
  http.close();
  await dc?.close().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

startDc();
http.listen(Number(opt.port), opt.host, () => {
  log(`MCP endpoint http://${opt.host}:${opt.port}${opt.path} (DC ${DC_ENTRY})`);
  if (!TOKEN_DIGEST) log('WARNING: MCPRELAY_BRIDGE_TOKEN not set; /mcp accepts unauthenticated local requests');
});
