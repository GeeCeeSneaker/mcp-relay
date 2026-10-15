"""Disposable compatibility study, not an installable gateway integration.

The accepted 82-case prototype remains untouched. This file investigates the
remaining mounted-gateway boundary, using the pinned package's public seams.
"""
import asyncio
import ssl
import time
from unittest.mock import patch
from fastmcp import Client, FastMCP
from fastmcp.server.providers.proxy import FastMCPProxy, ProxyResource, ProxyTemplate, ProxyPrompt
from mcp.shared.exceptions import MCPError
from mcp_types import METHOD_NOT_FOUND
from routing_schema_proposal import MetadataExecutionProvider, METADATA_SECONDS


class ComponentProviderProposal(MetadataExecutionProvider):
    """Extend only the three missing raw component families, before transforms."""
    async def _list_resources(self):
        async with asyncio.timeout(METADATA_SECONDS):
            async with self.metadata_factory() as client:
                try:items=await client.list_resources()
                except MCPError as error:
                    if error.code!=METHOD_NOT_FOUND:raise
                    items=[]
        return [ProxyResource.from_mcp_resource(self.execution_factory,item) for item in items]

    async def _list_resource_templates(self):
        async with asyncio.timeout(METADATA_SECONDS):
            async with self.metadata_factory() as client:
                try:items=await client.list_resource_templates()
                except MCPError as error:
                    if error.code!=METHOD_NOT_FOUND:raise
                    items=[]
        return [ProxyTemplate.from_mcp_template(self.execution_factory,item) for item in items]

    async def _list_prompts(self):
        async with asyncio.timeout(METADATA_SECONDS):
            async with self.metadata_factory() as client:
                try:items=await client.list_prompts()
                except MCPError as error:
                    if error.code!=METHOD_NOT_FOUND:raise
                    items=[]
        return [ProxyPrompt.from_mcp_prompt(self.execution_factory,item) for item in items]


def metadata_transport_proposal(source):
    """Explicitly refuse an unreviewed custom factory; never silently replace TLS.

    Production must construct both clients from one reviewed configuration, not
    introspect arbitrary client objects. This is a negative/parameter study only.
    """
    import httpx2
    from mcp_gateway.upstream import NoForwardStreamableHttpTransport, _retrying_client_factory
    if type(source) is not NoForwardStreamableHttpTransport:
        raise ValueError('Unsupported custom transport')
    if source.httpx_client_factory not in (None,_retrying_client_factory):
        raise ValueError('Unsupported custom HTTP factory')
    if source.verify is False:
        raise ValueError('TLS verification must remain enabled')
    if source.httpx_client_factory is _retrying_client_factory and source.verify is not None:
        raise ValueError('Mixed factory/verify semantics need explicit review')
    verify=source.verify if source.verify is not None else True
    def factory(**kwargs):
        kwargs.pop('timeout',None)
        return httpx2.AsyncClient(transport=httpx2.AsyncHTTPTransport(verify=verify,retries=0),
            timeout=httpx2.Timeout(connect=.25,read=2,write=2,pool=2),**kwargs)
    return NoForwardStreamableHttpTransport(source.url,headers=dict(source.headers),auth=source.auth,httpx_client_factory=factory)


async def run_checks():
    results=[]
    async def check(label,operation):
        start=time.monotonic()
        try:await operation();results.append({'case':label,'pass':True,'seconds':round(time.monotonic()-start,3)})
        except Exception as error:results.append({'case':label,'pass':False,'error':type(error).__name__})
    for era in ['legacy','2026-07-28']:
        backend=FastMCP('private-fixture-backend',instructions='BACKEND_INSTRUCTIONS')
        @backend.tool
        def echo(value:str)->str:return value
        @backend.resource('fixture://fixed')
        def fixed()->str:return 'FIXED'
        @backend.resource('fixture://item/{name}')
        def item(name:str)->str:return 'ITEM:'+name
        @backend.prompt
        def greeting(name:str)->str:return 'HELLO:'+name
        @backend.resource('fixture://slow')
        async def slow()->str:
            await asyncio.sleep(3.25);return 'SLOW_DONE'
        # Auto actually performs discover; an exact modern pin can adopt a
        # synthetic result without contacting the server (not metadata proof).
        mode='legacy' if era=='legacy' else 'auto'
        def client():return Client(backend,mode=mode)
        stock=FastMCPProxy(client_factory=client,name='stock-mounted')
        proposed=FastMCP('proposed-mounted')
        proposed.add_provider(ComponentProviderProposal(client,client))
        async def observe(inner):
            outer=FastMCP('public-fixture-gateway',instructions='GATEWAY_INSTRUCTIONS')
            outer.mount(inner,namespace='fixture')
            async with Client(outer,mode=mode) as front:
                # The actual integration boundary is mounted. Backend proxy
                # metadata/ping hooks do not become outer gateway hooks.
                metadata={'instructions':front.instructions,'name':front.server_info.name}
                if era=='legacy':await front.ping()
                else:
                    try:await front.ping()
                    except MCPError as error:assert error.code==METHOD_NOT_FOUND
                    else:raise AssertionError('modern ping unexpectedly exists')
                tools=sorted(t.name for t in await front.list_tools())
                resources=sorted(str(r.uri) for r in await front.list_resources())
                templates=sorted(t.uri_template for t in await front.list_resource_templates())
                prompts=sorted(p.name for p in await front.list_prompts())
                tool=await front.call_tool_mcp('fixture_echo',{'value':'OK'})
                resource=await front.read_resource(resources[0])
                template=await front.read_resource('fixture://fixture/item/example')
                prompt=await front.get_prompt('fixture_greeting',{'name':'example'})
                return {'metadata':metadata,'tools':tools,'resources':resources,'templates':templates,'prompts':prompts,
                    'descriptors':{'tools':[t.model_dump(mode='json') for t in await front.list_tools()],
                        'resources':[r.model_dump(mode='json') for r in await front.list_resources()],
                        'templates':[t.model_dump(mode='json') for t in await front.list_resource_templates()],
                        'prompts':[p.model_dump(mode='json') for p in await front.list_prompts()]},
                    'tool':tool.model_dump(mode='json'),'resource':[c.model_dump(mode='json') for c in resource],
                    'template':[c.model_dump(mode='json') for c in template],'prompt':prompt.model_dump(mode='json')}
        async def compare():
            a,b=await observe(stock),await observe(proposed)
            assert a==b
            assert a['metadata']=={'instructions':'GATEWAY_INSTRUCTIONS','name':'public-fixture-gateway'}
            assert len(a['resources'])==2 and len(a['templates'])==1 and len(a['prompts'])==1
        await check(era+'/mounted_components_initialize_discover_ping_differential',compare)
        async def execution_budget():
            outer=FastMCP('slow-gateway');outer.mount(proposed,namespace='fixture')
            async with Client(outer,mode=mode) as front:
                start=time.monotonic();value=await front.read_resource('fixture://fixture/slow')
                assert 'SLOW_DONE' in str(value) and 3.1<=time.monotonic()-start<6
        await check(era+'/resource_execution_outlives_metadata_budget',execution_budget)
    async def transport_checks():
        from mcp_gateway.upstream import NoForwardStreamableHttpTransport,_retrying_client_factory
        import httpx2
        context=ssl.create_default_context()
        source=NoForwardStreamableHttpTransport('https://fixture.invalid/mcp',headers={'X-Fixture':'owned'},verify=context)
        clone=metadata_transport_proposal(source)
        assert clone.url==source.url and clone.headers==source.headers and clone.headers is not source.headers and clone.auth is source.auth
        # Constructor argument observation, NOT a real TLS handshake claim.
        with patch('httpx2.AsyncHTTPTransport',wraps=httpx2.AsyncHTTPTransport) as transport:
            async with clone.httpx_client_factory(headers={},auth=None,follow_redirects=True):pass
            assert transport.call_args.kwargs=={'verify':context,'retries':0}
        assert source.verify is context and source.httpx_client_factory is None
        accepted=NoForwardStreamableHttpTransport('http://fixture.invalid/mcp',httpx_client_factory=_retrying_client_factory)
        assert metadata_transport_proposal(accepted).url==accepted.url
    await check('TLS_context_and_headers_preserved_constructor_only',transport_checks)
    async def rejected_transports():
        from mcp_gateway.upstream import NoForwardStreamableHttpTransport,_retrying_client_factory
        import httpx2
        import warnings
        class Custom(NoForwardStreamableHttpTransport):pass
        with warnings.catch_warnings():
            warnings.simplefilter('ignore',UserWarning)
            mixed=NoForwardStreamableHttpTransport('https://fixture.invalid/mcp',verify=ssl.create_default_context(),httpx_client_factory=_retrying_client_factory)
        for source in [Custom('https://fixture.invalid/mcp'),NoForwardStreamableHttpTransport('https://fixture.invalid/mcp',verify=False),mixed,
                       NoForwardStreamableHttpTransport('https://fixture.invalid/mcp',httpx_client_factory=httpx2.AsyncClient)]:
            try:metadata_transport_proposal(source)
            except ValueError:pass
            else:raise AssertionError('unreviewed transport silently replaced')
    await check('custom_factory_transport_or_TLS_disable_fail_closed',rejected_transports)
    return results
