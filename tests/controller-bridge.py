"""Actual MCP -> registered Relay capability -> RPC -> real ADCP composition.

No gateway/tunnel/installed service or real Provider is involved. Reuses the
accepted PR288 Store/Provider/workspace/host/result fixtures, never production.
"""
import argparse
import asyncio
import hashlib
import importlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time

sys.dont_write_bytecode = True
ap = argparse.ArgumentParser(description=__doc__)
ap.add_argument('--controller-source', type=Path, required=True)
ap.add_argument('--node-exe', default=shutil.which('node'))
args = ap.parse_args()
REPO = Path(__file__).resolve().parents[1]
SOURCE = args.controller_source.resolve(strict=True)
CONTROLLER_COMMIT = '7539d0fbce292f6e8b97d34bd3038fe603082abc'
assert subprocess.check_output(['git', '-C', str(SOURCE), 'rev-parse', 'HEAD']).decode().strip() == CONTROLLER_COMMIT
assert subprocess.check_output(['git', '-C', str(SOURCE), 'status', '--porcelain=v1']) == b''
sys.path[:0] = [str(SOURCE), str(SOURCE / 'tests')]
fixtures = importlib.import_module('test_reference_control')
assert Path(importlib.import_module('controller').__file__).resolve().is_relative_to(SOURCE)
assert args.node_exe
ROOT = Path(tempfile.mkdtemp(prefix='mcprelay-controller-bridge-')).resolve()
print(json.dumps({'fixture_root': str(ROOT), 'controller_commit': CONTROLLER_COMMIT}), flush=True)
PROCESSES = []


def environment(root):
    e = {k: v for k, v in os.environ.items() if k.upper() in {
        'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'TEMP', 'TMP', 'PATH',
    }}
    e.update(MCPRELAY_TARGETS=str(root / 'targets.json'), MCPRELAY_ALLOWED_DIRS=str(root),
             MCPRELAY_NODE_NAME='controller-bridge-fixture', PYTHONDONTWRITEBYTECODE='1')
    return e


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


async def terminate(proc):
    if proc.returncode is None:
        proc.terminate()
        try:
            await asyncio.wait_for(proc.wait(), 5)
        except asyncio.TimeoutError:
            proc.kill()
            await asyncio.wait_for(proc.wait(), 5)


async def launch(*command, **kwargs):
    proc = await asyncio.create_subprocess_exec(*command, **kwargs,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    PROCESSES.append(proc)
    return proc


class Relay:
    def __init__(self, root, rpc_port=None, timeout=1000):
        self.root, self.rpc_port, self.timeout = root, rpc_port, timeout
        self.port = free_port()
        self.proc = self.log = None

    async def __aenter__(self):
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / 'targets.json').write_text('{"targets":{}}')
        env = environment(self.root)
        if self.rpc_port is not None:
            env.update(MCPRELAY_CONTROLLER_RPC_PORT=str(self.rpc_port),
                MCPRELAY_CONTROLLER_RPC_PROTOCOL='adcp-reference-rpc/1',
                MCPRELAY_CONTROLLER_RPC_TIMEOUT_MS=str(self.timeout))
        self.log = open(self.root / 'relay.log', 'wb')
        self.proc = await launch(args.node_exe, str(REPO / 'node-runtime/server.mjs'),
            '--host', '127.0.0.1', '--port', str(self.port), cwd=REPO, env=env,
            stdout=self.log, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if self.proc.returncode is not None:
                raise AssertionError('Owned Relay fixture failed; see ' + str(self.root / 'relay.log'))
            try:
                reader, writer = await asyncio.open_connection('127.0.0.1', self.port)
                writer.write(b'GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n')
                await writer.drain()
                response = await asyncio.wait_for(reader.read(), 1)
                writer.close()
                await writer.wait_closed()
                if b'200 OK' in response:
                    return self
            except (OSError, asyncio.TimeoutError):
                pass
            await asyncio.sleep(.05)
        raise AssertionError('Owned Relay fixture readiness deadline')

    async def __aexit__(self, *_args):
        if self.proc is not None:
            await terminate(self.proc)
        if self.log is not None:
            self.log.close()

    async def start_call(self, command):
        return await launch(args.node_exe, str(REPO / 'tests/controller-bridge-client.mjs'),
            f'http://127.0.0.1:{self.port}/mcp', json.dumps(command), cwd=REPO,
            env=environment(self.root), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)

    async def call(self, command):
        proc = await self.start_call(command)
        out, err = await asyncio.wait_for(proc.communicate(), 15)
        assert proc.returncode == 0, err.decode(errors='replace')
        return json.loads(out)


def invoke(method, *, issue=140, identity='1401', repository='owner/repo', via=None, extra=None):
    ref = {'repository': repository, 'runtime_issue_number': issue, 'directive_comment_id': identity}
    ref.update(extra or {})
    return {'name': via or ('invoke_read' if method == 'controller.get_result' else 'invoke_exec'),
            'arguments': {'capability': method, 'args': ref}}


def facts(reply):
    return reply['result']['_meta']['io.mcprelay/result']


async def ordinary_read(relay):
    reply = await relay.call({'name': 'invoke_read', 'arguments': {'capability': 'node_status', 'args': {}}})
    assert not reply['result'].get('isError')
    assert json.loads(reply['result']['content'][0]['text'])['node_name'] == 'controller-bridge-fixture'


async def default_off():
    async with Relay(ROOT / 'disabled') as relay:
        reply = await relay.call({'name': 'list_capabilities', 'arguments': {}})
        caps = json.loads(reply['result']['content'][0]['text'])['capabilities']
        assert not [c for c in caps if c['name'].startswith('controller.')]
        await ordinary_read(relay)


async def execution_result(pair, label):
    value, _, agent, delivery = await fixtures.fixture(ROOT / label, pair=pair)
    try:
        async with Relay(ROOT / (label + '-relay'), value.control_server.port) as relay:
            catalog = await relay.call({'name': 'list_capabilities', 'arguments': {}})
            caps = json.loads(catalog['result']['content'][0]['text'])['capabilities']
            bridge = {c['name']: c for c in caps if c['name'].startswith('controller.')}
            assert set(bridge) == {'controller.apply_decision', 'controller.get_result'}
            assert bridge['controller.apply_decision']['class'] == 'exec'
            assert bridge['controller.get_result']['class'] == 'read'
            tools = (await relay.call({'list_tools': True}))['result']['tools']
            annotations = {t['name']: t['annotations'] for t in tools}
            assert annotations['invoke_exec']['destructiveHint'] and not annotations['invoke_exec']['readOnlyHint']
            assert annotations['invoke_exec']['openWorldHint'] and annotations['invoke_read']['readOnlyHint']
            first = facts(await relay.call(invoke('controller.apply_decision')))
            assert first['state'] == 'IN_PROGRESS'
            assert (first['receipt']['model'], first['receipt']['reasoning_effort']) == pair
            envelope = agent.launch_requests[0].execution_envelope
            assert (envelope.model, envelope.reasoning_effort) == pair
            assert facts(await relay.call(invoke('controller.apply_decision'))) == first
            await fixtures.finish(value, agent)
            terminal = facts(await relay.call(invoke('controller.get_result')))
            assert terminal['state'] == 'TERMINAL'
            assert terminal['receipt']['candidate_result_head'] == 'd' * 40
            assert terminal['receipt']['implementation_pr'] == 169
            assert len(agent.launch_requests) == len(delivery.publications) == 1
    finally:
        await value.close()


async def scope_and_stop():
    value, reader, agent, _ = await fixtures.fixture(ROOT / 'scope')
    try:
        async with Relay(ROOT / 'scope-relay', value.control_server.port) as relay:
            wrong = await relay.call(invoke('controller.apply_decision', via='invoke_read'))
            assert wrong['result']['_meta']['io.mcprelay/error']['code'] == 'wrong_class'
            endpoint = await relay.call(invoke('controller.apply_decision', extra={'endpoint': '127.0.0.1:1'}))
            assert endpoint['result']['_meta']['io.mcprelay/error']['code'] == 'invalid_args'
            assert facts(await relay.call(invoke('controller.apply_decision', identity='999')))['state'] == 'REJECTED'
            assert facts(await relay.call(invoke('controller.apply_decision', repository='other/repo')))['state'] == 'REJECTED'
            reader.comments[140] = [fixtures.comment(author='untrusted')]
            assert facts(await relay.call(invoke('controller.apply_decision')))['state'] == 'REJECTED'
            assert not agent.launch_requests
            reader.comments[140] = [fixtures.comment()]
            first = facts(await relay.call(invoke('controller.apply_decision')))
            target = first['receipt']['run_id']
            before = await value.store.get_run(target)
            reader.tasks[141] = 'TASK-061'
            stop = fixtures.comment('1501')
            stop['body'] = '```adcp_execution_directive\ntask_id: TASK-061\naction: STOP_RUN\ntarget_run_id: ' + target + '\n```'
            reader.comments[141] = [stop]
            assert facts(await relay.call(invoke('controller.apply_decision', issue=141, identity='1501')))['state'] == 'REJECTED'
            assert not [c for c in agent.calls if c[0] == 'stop']
            assert await value.store.get_run(target) == before
            stop = dict(stop, id=1402)
            reader.comments[140].append(stop)
            ack = facts(await relay.call(invoke('controller.apply_decision', identity='1402')))
            assert ack['state'] == 'IN_PROGRESS' and ack['receipt']['outcome_code'] == 'STOP_REQUESTED'
            assert ack['receipt']['target_ended_at'] is None
            assert facts(await relay.call(invoke('controller.apply_decision', identity='1402'))) == ack
            assert [c for c in agent.calls if c[0] == 'stop'] == [('stop', target)]
            await fixtures.finish(value, agent)
            assert facts(await relay.call(invoke('controller.get_result', identity='1402')))['state'] == 'TERMINAL'
    finally:
        await value.close()


async def timeout_reconciliation():
    agent = fixtures.GatedAgent()
    value, _, _, _ = await fixtures.fixture(ROOT / 'timeout', agent=agent)
    try:
        async with Relay(ROOT / 'timeout-relay', value.control_server.port, timeout=200) as relay:
            call = asyncio.create_task(relay.call(invoke('controller.apply_decision')))
            await asyncio.wait_for(agent.entered.wait(), 5)
            unknown = await call
            assert unknown['call_ms'] < 2000
            assert facts(unknown)['state'] == 'UNKNOWN'
            assert unknown['result']['_meta']['io.mcprelay/error']['action'] == 'reconcile'
            assert facts(unknown)['reconcile_with'] == 'controller.get_result'
            agent.release.set()
            receipt = facts(await relay.call(invoke('controller.get_result')))
            assert receipt['state'] == 'IN_PROGRESS'
            assert facts(await relay.call(invoke('controller.apply_decision'))) == receipt
            await fixtures.finish(value, agent)
            assert facts(await relay.call(invoke('controller.get_result')))['receipt']['implementation_pr'] == 169
            assert len(agent.launch_requests) == 1
    finally:
        agent.release.set()
        await value.close()


async def disconnect_ownership():
    agent = fixtures.GatedAgent()
    value, _, _, delivery = await fixtures.fixture(ROOT / 'disconnect', agent=agent)
    try:
        async with Relay(ROOT / 'disconnect-relay', value.control_server.port, timeout=10_000) as relay:
            client = await relay.start_call(invoke('controller.apply_decision'))
            await asyncio.wait_for(agent.entered.wait(), 5)
            await terminate(client)
            await terminate(relay.proc)
        agent.release.set()
        await value.run_observation_once()  # serializes after the owned admission
        await fixtures.finish(value, agent)  # no bridge/client exists during delivery
        async with Relay(ROOT / 'reconnected-relay', value.control_server.port) as relay:
            terminal = facts(await relay.call(invoke('controller.get_result')))
            assert terminal['receipt']['implementation_pr'] == 169
            assert facts(await relay.call(invoke('controller.apply_decision'))) == terminal
        assert len(agent.launch_requests) == len(delivery.publications) == 1
    finally:
        agent.release.set()
        await value.close()


async def bounded_bad_backends():
    mode, seen = 'wrong_method_id', []

    async def backend(reader, writer):
        try:
            req = json.loads(await asyncio.wait_for(reader.readline(), 2))
            seen.append(req)
            response = {'jsonrpc': '2.0', 'id': req['id'], 'result': {'state': 'UNKNOWN'}}
            if mode == 'wrong_method_id':
                response['id'] = req['id'].replace('controller.get_result', 'controller.apply_decision')
            elif mode == 'wrong_protocol':
                response['jsonrpc'] = '1.0'
            elif mode == 'wrong_schema':
                response['result'] = {'state': 'TERMINAL', 'receipt': {'prompt': 'must not be forwarded'}}
            elif mode == 'oversize':
                writer.write(b'x' * (16 * 1024 + 1) + b'\n')
                await writer.drain()
                return
            elif mode == 'stall':
                await reader.read()  # bridge must close this actual socket at its deadline
                return
            writer.write((json.dumps(response) + '\n').encode())
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()

    listener = await asyncio.start_server(backend, '127.0.0.1', 0)
    port = listener.sockets[0].getsockname()[1]
    try:
        async with Relay(ROOT / 'bad-backend-relay', port, timeout=200) as relay:
            for mode in ['wrong_method_id', 'wrong_protocol', 'wrong_schema', 'oversize', 'stall']:
                reply = await relay.call(invoke('controller.get_result'))
                assert reply['result'].get('isError') and facts(reply)['state'] == 'UNKNOWN'
                assert reply['result']['_meta']['io.mcprelay/error']['action'] == 'reconcile'
                assert reply['call_ms'] < 2000
                await ordinary_read(relay)
            assert len(seen) == 5  # no automatic retry/redispatch
    finally:
        listener.close()
        await listener.wait_closed()
    async with Relay(ROOT / 'unavailable-relay', free_port(), timeout=200) as relay:
        reply = await relay.call(invoke('controller.get_result'))
        assert facts(reply)['state'] == 'UNKNOWN' and reply['call_ms'] < 2000
        await ordinary_read(relay)


async def main():
    scenarios = [
        ('default disabled / ordinary capability', default_off),
        ('MCP execution/result + replay + sol/high', lambda: execution_result(('gpt-6.1-sol', 'high'), 'sol')),
        ('MCP execution/result + replay + luna/max', lambda: execution_result(('gpt-6-luna', 'max'), 'luna')),
        ('scope/trust/arguments/risk + same-Issue STOP', scope_and_stop),
        ('timeout unknown outcome + exact-reference reconciliation', timeout_reconciliation),
        ('client/bridge disconnect preserves local execution/result', disconnect_ownership),
        ('bounded malformed/unavailable backend + ordinary capability isolation', bounded_bad_backends),
    ]
    try:
        for name, run in scenarios:
            start = time.monotonic()
            await run()
            print('PASS ' + name + ' (' + str(round(time.monotonic() - start, 3)) + 's)', flush=True)
        print(json.dumps({'passed_scenarios': len(scenarios), 'fixture_root': str(ROOT),
            'controller_commit': CONTROLLER_COMMIT, 'real_provider': False,
            'bridge_sha256': hashlib.sha256((REPO / 'node-runtime/controller.mjs').read_bytes()).hexdigest()}), flush=True)
    finally:
        for proc in reversed(PROCESSES):
            await terminate(proc)


asyncio.run(main())
