#!/usr/bin/env python3
"""MCPRelay performance/stability probe. Run on the VPS.

    perf-probe.py <public-mcp-url> <bridge-url-via-tunnel> <node-perf-dir> [seconds] [tool-prefix]

<node-perf-dir> must contain f64.txt, f256.txt and f1024.txt (text files of those sizes in KiB).
Needs an access token in /root/.perf-token (tests/oauth-e2e.py --token-out) and reads the
node bridge token from /etc/mcprelay/gateway.yaml. Secrets are never printed. Afterwards,
remove the test client: scripts/vps-revoke.sh --keep-client <connector-client-id>.
"""
import json, re, sys, time
import httpx

PUBLIC, BRIDGE, PERF_DIR = sys.argv[1:4]
DURATION = int(sys.argv[4]) if len(sys.argv) > 4 else 300
PREFIX = sys.argv[5] if len(sys.argv) > 5 else 'win01_'
SEP = '\\' if re.match(r'^[A-Za-z]:', PERF_DIR) else '/'
HEALTHZ = BRIDGE.rsplit('/', 1)[0] + '/healthz'
TOKEN = open('/root/.perf-token').read().strip()
BRIDGE_TOKEN = re.search(r'type: bearer\s+token: "([^"]+)"', open('/etc/mcprelay/gateway.yaml').read()).group(1)
META = {'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {},
        'io.modelcontextprotocol/clientInfo': {'name': 'perf', 'version': '0'}}
c = httpx.Client(timeout=120)


def pct(xs, p):
    xs = sorted(xs)
    return xs[max(0, min(len(xs) - 1, round(p / 100 * (len(xs) - 1))))]


def summary(name, xs, fails=0):
    ms = [x * 1000 for x in xs]
    print(f"{name:44s} n={len(xs):3d} fail={fails}  p50={pct(ms,50):7.0f}ms  p95={pct(ms,95):7.0f}ms  max={max(ms):7.0f}ms", flush=True)


def body_json(r):
    b = r.text
    if b.lstrip().startswith(('event', 'data')):
        b = [l[5:] for l in b.splitlines() if l.startswith('data:')][-1]
    return json.loads(b)


def public_call(name, args):
    t = time.perf_counter()
    r = c.post(PUBLIC, headers={'authorization': f'Bearer {TOKEN}', 'accept': 'application/json, text/event-stream',
                                'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': PREFIX + name},
               json={'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': PREFIX + name, 'arguments': args, '_meta': META}})
    d = body_json(r); el = time.perf_counter() - t
    ok = r.status_code == 200 and 'result' in d and not d['result'].get('isError')
    return ok, el, ''.join(x.get('text', '') for x in d.get('result', {}).get('content', []))


bh = {'authorization': f'Bearer {BRIDGE_TOKEN}', 'accept': 'application/json, text/event-stream', 'content-type': 'application/json'}
r = c.post(BRIDGE, headers=bh, json={'jsonrpc': '2.0', 'id': 1, 'method': 'initialize',
                                     'params': {'protocolVersion': '2025-11-25', 'capabilities': {}, 'clientInfo': {'name': 'perf', 'version': '0'}}})
bh['mcp-session-id'] = r.headers['mcp-session-id']; bh['mcp-protocol-version'] = '2025-11-25'
c.post(BRIDGE, headers=bh, json={'jsonrpc': '2.0', 'method': 'notifications/initialized'})


def bridge_call(name, args):
    t = time.perf_counter()
    r = c.post(BRIDGE, headers=bh, json={'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call', 'params': {'name': name, 'arguments': args}})
    d = body_json(r); el = time.perf_counter() - t
    return r.status_code == 200 and 'result' in d and not d['result'].get('isError'), el


print('== A. tunnel round trip (VPS -> node bridge /healthz)')
xs = []
for _ in range(50):
    t = time.perf_counter(); c.get(HEALTHZ); xs.append(time.perf_counter() - t)
summary('healthz via tunnel', xs)

print('== B/C. small tool call: list_directory')
for label, fn in (('direct bridge (tunnel only)', lambda: bridge_call('list_directory', {'path': PERF_DIR, 'depth': 1})),
                  ('public edge + gateway + tunnel', lambda: public_call('list_directory', {'path': PERF_DIR, 'depth': 1})[:2])):
    xs, f = [], 0
    for _ in range(30):
        ok, el = fn(); xs.append(el); f += 0 if ok else 1
    summary(label, xs, f)

print('== C2. command execution via public edge')
xs, f = [], 0
for _ in range(15):
    ok, el, text = public_call('start_process', {'command': 'echo mcp-relay-ok', 'timeout_ms': 10000})
    xs.append(el); f += 0 if ok and 'mcp-relay-ok' in text else 1
summary('start_process echo (public)', xs, f)

print('== D. read throughput via public edge (read_file)')
for kb in (64, 256, 1024):
    ok, el, text = public_call('read_file', {'path': PERF_DIR + SEP + f'f{kb}.txt', 'offset': 0, 'length': 1000000})
    size = len(text.encode())
    print(f"read f{kb}.txt  ok={ok}  returned={size/1024:7.0f} KiB  time={el*1000:7.0f}ms", flush=True)

print(f'== E. sustained: 1 call every 3 s for {DURATION}s (list_directory via public edge)')
xs, f, t0 = [], 0, time.time()
while time.time() - t0 < DURATION:
    try:
        ok, el = public_call('list_directory', {'path': PERF_DIR, 'depth': 1})[:2]
    except Exception:
        ok, el = False, 0.0
    xs.append(el); f += 0 if ok else 1
    time.sleep(max(0, 3 - el))
summary('sustained list_directory', xs, f)
print(f"success rate: {100 * (len(xs) - f) / len(xs):.1f}%")
