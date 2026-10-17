"""Real config/assembly activation: default-off and no silent fallback."""
import argparse,pathlib,sys,unittest
import asyncio,contextvars
from types import SimpleNamespace as NS
ap=argparse.ArgumentParser();ap.add_argument('--gateway-source',required=True);args=ap.parse_args()
sys.path.insert(0,str(pathlib.Path(args.gateway_source).resolve()/'src'))
from mcp_gateway.config import BackendConfig
from mcp_gateway.gateway import build_gateway
from pydantic import ValidationError
from unittest.mock import patch

class Activation(unittest.TestCase):
    def test_existing_default_is_off(self):
        value=BackendConfig(url='http://fixture.invalid/mcp')
        self.assertFalse(value.isolate_metadata);self.assertIsNone(value.metadata_profile)
    def test_explicit_false_preserves_custom_auth(self):
        for auth in [{'type':'none'},{'type':'headers','headers':{'x-fixture':'owned'}},{'type':'oauth'}]:
            with self.subTest(kind=auth['type']):
                self.assertFalse(BackendConfig(url='http://fixture.invalid/mcp',auth=auth,isolate_metadata=False).isolate_metadata)
    def test_boolean_is_strict(self):
        for value in ['true','false',0,1,None,[],{}]:
            with self.subTest(value=value),self.assertRaises(ValidationError):
                BackendConfig(url='http://fixture.invalid/mcp',isolate_metadata=value)
    def test_profile_required_and_known(self):
        for profile in [None,'unreviewed-v2',False,1]:
            with self.subTest(profile=profile),self.assertRaises(ValidationError):
                BackendConfig(url='http://fixture.invalid/mcp',auth={'type':'bearer','token':'fixture-only'},isolate_metadata=True,metadata_profile=profile)
    def test_orphan_profile_rejected(self):
        with self.assertRaises(ValidationError):BackendConfig(url='http://fixture.invalid/mcp',metadata_profile='bounded-v1')
    def test_activation_errors_do_not_echo_auth_material(self):
        marker='owned-fixture-do-not-echo'
        with self.assertRaises(ValidationError) as caught:
            BackendConfig(url='http://fixture.invalid/mcp',auth={'type':'bearer','token':marker},isolate_metadata=True)
        self.assertNotIn(marker,str(caught.exception))
    def test_opted_auth_not_silently_changed(self):
        for kind in ['none','oauth']:
            with self.subTest(kind=kind),self.assertRaises(ValidationError):
                BackendConfig(url='http://fixture.invalid/mcp',auth={'type':kind},isolate_metadata=True,metadata_profile='bounded-v1')
    def test_dependency_mismatch_blocks_before_mounts(self):
        backend=BackendConfig(url='http://fixture.invalid/mcp',auth={'type':'bearer','token':'fixture-only'},isolate_metadata=True,metadata_profile='bounded-v1')
        with patch('mcp_gateway.bounded_metadata.version',return_value='unreviewed'),patch('mcp_gateway.gateway.FastMCPProxy') as stock:
            with self.assertRaisesRegex(RuntimeError,'dependency mismatch'):
                build_gateway(NS(backends={'probe_fixture':backend}),None,None,{})
            stock.assert_not_called()
    def test_default_off_gateway_still_assembles(self):
        self.assertIsNotNone(build_gateway(NS(backends={}),None,NS(backend_status=lambda:[]),{}))
    def test_default_off_does_not_gate_dependency_or_stock_transport(self):
        from fastmcp import Client
        from mcp_gateway.upstream import NoForwardStreamableHttpTransport
        import httpx2
        backend=BackendConfig(url='http://fixture.invalid/mcp',auth={'type':'oauth'})
        client=Client(NoForwardStreamableHttpTransport(backend.url,httpx_client_factory=httpx2.AsyncClient))
        with patch('mcp_gateway.bounded_metadata.version',side_effect=AssertionError('default must not gate')):
            self.assertIsNotNone(build_gateway(NS(backends={'stock':backend}),None,NS(backend_status=lambda:[]),{'stock':client}))
        self.assertIs(client.transport.httpx_client_factory,httpx2.AsyncClient)
    def test_mixed_assembly_preserves_stock_and_rejects_opted_custom_factory(self):
        from fastmcp import Client
        from mcp_gateway.upstream import NoForwardStreamableHttpTransport
        import httpx2
        stock=BackendConfig(url='http://fixture.invalid/stock',auth={'type':'oauth'})
        opted=BackendConfig(url='http://fixture.invalid/probe',auth={'type':'bearer','token':'fixture-only'},isolate_metadata=True,metadata_profile='bounded-v1')
        a=Client(NoForwardStreamableHttpTransport(stock.url,httpx_client_factory=httpx2.AsyncClient))
        b=Client(NoForwardStreamableHttpTransport(opted.url))
        config=NS(backends={'stock':stock,'probe':opted})
        with patch('mcp_gateway.gateway.FastMCPProxy',wraps=__import__('mcp_gateway.gateway',fromlist=['FastMCPProxy']).FastMCPProxy) as original:
            self.assertIsNotNone(build_gateway(config,None,NS(backend_status=lambda:[]),{'stock':a,'probe':b}))
            self.assertEqual(original.call_count,1)
        b.transport.httpx_client_factory=httpx2.AsyncClient
        with patch('mcp_gateway.gateway.FastMCPProxy') as original:
            with self.assertRaisesRegex(ValueError,'custom HTTP'):
                build_gateway(config,None,None,{'stock':a,'probe':b})
            original.assert_not_called()
    def test_handler_mode_and_tls_are_not_silently_replaced(self):
        from fastmcp import Client
        from mcp_gateway.upstream import NoForwardStreamableHttpTransport
        from mcp_gateway.bounded_metadata import metadata_template
        import ssl,httpx2
        context=ssl.create_default_context()
        async def owned_handler(message):pass
        source=Client(NoForwardStreamableHttpTransport('https://fixture.invalid/mcp',headers={'X-Fixture':'owned'},verify=context),mode='legacy',message_handler=owned_handler)
        fresh=metadata_template(source)
        self.assertEqual(fresh.mode,source.mode)
        self.assertIs(fresh._base_message_handler,owned_handler)  # Read-only pinned-package assertion; no SDK hook/cache mutation.
        self.assertIsNot(fresh.transport,source.transport)
        self.assertEqual(fresh.transport.headers,source.transport.headers)
        with patch('httpx2.AsyncHTTPTransport',wraps=httpx2.AsyncHTTPTransport) as factory:
            http=fresh.transport.httpx_client_factory(headers={},auth=None,follow_redirects=True)
            self.assertIs(factory.call_args.kwargs['verify'],context)
            import asyncio
            asyncio.run(http.aclose())
        with self.assertRaises(ValueError):
            metadata_template(Client(NoForwardStreamableHttpTransport('https://fixture.invalid/mcp',verify=False)))
    def test_overlapping_alias_fails_before_side_effects(self):
        from fastmcp import Client
        from mcp_gateway.upstream import NoForwardStreamableHttpTransport
        stock=BackendConfig(url='http://fixture.invalid/mcp')
        opted=BackendConfig(url=stock.url,auth={'type':'bearer','token':'fixture-only'},isolate_metadata=True,metadata_profile='bounded-v1')
        with self.assertRaisesRegex(ValueError,'namespace'):
            build_gateway(NS(backends={'node':stock,'node_probe':opted}),None,None,{'node_probe':Client(NoForwardStreamableHttpTransport(stock.url))})

class SchemaGuards(unittest.IsolatedAsyncioTestCase):
    async def test_stock_dispatch_is_not_reimplemented(self):
        from mcp_gateway.bounded_metadata import SchemaScope
        from unittest.mock import AsyncMock
        original=AsyncMock(return_value='native-dispatch')
        with patch('mcp_gateway.bounded_metadata.get_http_request',side_effect=AssertionError('stock must not be preempted')):
            for name in ['stock_echo','gateway_status','unknown_or_hashed']:
                self.assertEqual(await SchemaScope({'probe'}).on_call_tool(NS(message=NS(name=name)),original),'native-dispatch')
        self.assertEqual(original.await_count,3)
    async def test_failed_lookup_then_recovery_does_not_execute(self):
        from mcp_gateway.bounded_metadata import SchemaScope,STATE_KEY
        from fastmcp.exceptions import ToolError
        from unittest.mock import AsyncMock
        scope=SchemaScope({'probe'});server=NS(get_tool=AsyncMock(return_value=None))
        request=NS(state=NS(),headers={},json=AsyncMock(return_value={'method':'tools/call','params':{'name':'probe_echo'}}))
        ctx=NS(message=NS(name='probe_echo',arguments={'value':1}),fastmcp_context=NS(fastmcp=server,request_context=NS(request=object(),protocol_version='2026-07-28')))
        execute=AsyncMock()
        with patch('mcp_gateway.bounded_metadata.get_http_request',return_value=request),patch('mcp_gateway.bounded_metadata.get_access_token',return_value=object()):
            self.assertEqual(await scope.on_list_tools(ctx,execute),[])
            self.assertEqual(getattr(request.state,STATE_KEY),('probe_echo',False))
            server.get_tool.return_value=object()
            with self.assertRaises(ToolError):await scope.on_call_tool(ctx,execute)
            execute.assert_not_awaited()
    async def test_concurrent_request_markers_are_independent(self):
        from mcp_gateway.bounded_metadata import SchemaScope,STATE_KEY
        from fastmcp.exceptions import ToolError
        from unittest.mock import AsyncMock
        current=contextvars.ContextVar('owned-request');ready=asyncio.Event()
        good,bad=NS(state=NS(),headers={}),NS(state=NS(),headers={})
        for request in [good,bad]:request.json=AsyncMock(return_value={'method':'tools/call','params':{'name':'probe_echo'}})
        async def lookup(name):
            if current.get() is bad:ready.set();await asyncio.sleep(.01);raise TimeoutError
            return object()
        ctx=NS(message=NS(name='probe_echo',arguments={'value':1}),fastmcp_context=NS(fastmcp=NS(get_tool=lookup),request_context=NS(request=object(),protocol_version='2026-07-28')))
        scope=SchemaScope({'probe'});execute=AsyncMock()
        async def preflight(request):current.set(request);return await scope.on_list_tools(ctx,execute)
        with patch('mcp_gateway.bounded_metadata.get_http_request',side_effect=current.get),patch('mcp_gateway.bounded_metadata.get_access_token',return_value=object()):
            pending=asyncio.create_task(preflight(bad));await ready.wait();await preflight(good);await pending
            self.assertEqual(getattr(good.state,STATE_KEY),('probe_echo',True));self.assertEqual(getattr(bad.state,STATE_KEY),('probe_echo',False))
            current.set(bad)
            with self.assertRaises(ToolError):await scope.on_call_tool(ctx,execute)
            current.set(good);await scope.on_call_tool(ctx,execute);self.assertEqual(execute.await_count,1)
    async def test_non_opted_versions_still_use_normal_dispatch(self):
        from mcp_gateway.bounded_metadata import SchemaScope
        from fastmcp import FastMCP
        from fastmcp.utilities.versions import VersionSpec
        from unittest.mock import AsyncMock
        stock=FastMCP('stock-version-test')
        stock.tool(lambda:'ONE',name='versioned',version='1');stock.tool(lambda:'TWO',name='versioned',version='2')
        scope=SchemaScope({'probe'});ctx=NS(message=NS(name='stock_versioned',arguments={}))
        for selected,marker in [('1','ONE'),('2','TWO')]:
            body={'method':'tools/call','params':{'name':'stock_versioned','_meta':{'fastmcp':{'version':{'eq':selected}}}}}
            request=NS(json=AsyncMock(return_value=body))
            async def normal(context):return await stock.call_tool('versioned',{},version=VersionSpec(eq=selected))
            with patch('mcp_gateway.bounded_metadata.get_http_request',return_value=request):
                self.assertIn(marker,str(await scope.on_call_tool(ctx,normal)))
    async def test_opted_version_descriptor_cannot_reach_execution_factory(self):
        from mcp_gateway.bounded_metadata import ComponentProvider
        from fastmcp.exceptions import ToolError
        from unittest.mock import AsyncMock,Mock
        client=NS(list_tools=AsyncMock(return_value=[NS(meta={'fastmcp':{'version':'1'}})]))
        class Lease:
            async def __aenter__(self):return client
            async def __aexit__(self,*args):pass
        execute=Mock(side_effect=AssertionError('no execution'))
        with self.assertRaises(ToolError):await ComponentProvider(Lease,execute).list_tools()
        execute.assert_not_called()

if __name__=='__main__':unittest.main(argv=[sys.argv[0]],verbosity=2)
