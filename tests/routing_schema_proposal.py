"""WO10 isolated design prototype; NOT a packaged/deployed gateway patch."""
import asyncio
import httpx2
from fastmcp import Client,FastMCP
from fastmcp.server.providers.proxy import ProxyProvider,ProxyTool
from fastmcp.exceptions import ToolError
from fastmcp.server.dependencies import get_http_request, get_access_token
from fastmcp.server.middleware import Middleware
from mcp_types.version import MODERN_PROTOCOL_VERSIONS

METADATA_SECONDS = 3
STATE_KEY = 'wo10_schema_scope'

def metadata_http_client_factory(**kwargs):
    kwargs.pop('timeout',None)
    return httpx2.AsyncClient(transport=httpx2.AsyncHTTPTransport(retries=0),
        timeout=httpx2.Timeout(connect=.25,read=2,write=2,pool=2),**kwargs)

class BackendExecution(Middleware):
    def __init__(self,factory):self.factory=factory
    async def on_call_tool(self,context,call_next):
        async with asyncio.timeout(METADATA_SECONDS):
            tool=await context.fastmcp_context.fastmcp.get_tool(context.message.name)
        if tool is None:raise ToolError('Unknown or unavailable backend tool')
        # Public schema conversion preserves the advertised input/output/header
        # metadata; actual execution keeps the existing persistent client/retries.
        execution=ProxyTool.from_mcp_tool(self.factory,tool.to_mcp_tool(name=tool.name))
        return await execution.run(context.message.arguments or {},context=context.fastmcp_context)

class BackendCatalogBound(Middleware):
    async def on_list_tools(self, context, call_next):
        try:
            async with asyncio.timeout(METADATA_SECONDS):
                return await call_next(context)
        except TimeoutError:
            # Only metadata timeout is omitted, never an arbitrary exception.
            return []

class RequestSchemaScope(Middleware):
    async def on_list_tools(self, context, call_next):
        ctx = context.fastmcp_context
        if ctx is None or ctx.request_context is None or ctx.request_context.request is None:
            return await call_next(context)
        request = get_http_request()
        body = await request.json()
        if not isinstance(body, dict) or body.get('method') != 'tools/call':
            return await call_next(context)
        params = body.get('params')
        if not isinstance(params, dict) or not isinstance(params.get('name'), str):
            return await call_next(context)
        name = params['name']
        setattr(request.state, STATE_KEY, (name, False))
        if get_access_token() is None:
            raise ToolError('Authenticated schema context unavailable')
        try:
            async with asyncio.timeout(METADATA_SECONDS):
                tool = await ctx.fastmcp.get_tool(name)
        except TimeoutError:
            return []
        if tool is None:
            return []
        setattr(request.state, STATE_KEY, (name, True))
        return [tool]  # Existing outer dereference and SDK header checks remain.

    async def on_call_tool(self, context, call_next):
        request = get_http_request()
        name = context.message.name
        modern = context.fastmcp_context.request_context.protocol_version in MODERN_PROTOCOL_VERSIONS
        needs_schema = modern and (bool(context.message.arguments) or any(
            k.lower().startswith('mcp-param-') for k in request.headers))
        if needs_schema and getattr(request.state, STATE_KEY, None) != (name, True):
            raise ToolError('Backend schema unavailable; call refused')
        # Empty-argument calls skip SDK schema preflight; bound only discovery.
        try:
            async with asyncio.timeout(METADATA_SECONDS):
                tool = await context.fastmcp_context.fastmcp.get_tool(name)
        except TimeoutError:
            raise ToolError('Backend metadata unavailable') from None
        if tool is None:
            raise ToolError('Unknown or unavailable tool')
        return await call_next(context)  # No execution timeout inflation/reduction.

def proposed_gateway(original, config, provider, manager, clients):
    names = [n for n, b in config.backends.items() if b.enabled]
    if any(a != b and b.startswith(a + '_') for a in names for b in names):
        raise ValueError('Prototype requires non-overlapping namespace prefixes')
    from mcp_gateway import gateway
    from mcp_gateway.upstream import NoForwardStreamableHttpTransport
    metadata_clients={}
    executions={}
    for name,client in clients.items():
        if config.backends[name].auth.type not in ['bearer','headers','none']:
            raise ValueError('Prototype OAuth-backend compatibility is unproven')
        gateway._require_no_header_forwarding(name,client)
        transport=client.transport
        meta=NoForwardStreamableHttpTransport(transport.url,headers=dict(transport.headers),auth=transport.auth,
            httpx_client_factory=metadata_http_client_factory)
        metadata_clients[name]=Client(meta,timeout=3,init_timeout=3)
        executions[name]=gateway._persistent_client_factory(name,client)
    def proxy(*args,**kwargs):
        name=kwargs['name'].removeprefix('proxy-')
        kwargs.pop('client_factory')
        mcp=FastMCP(*args,**kwargs)
        # The documented Provider composition/TTL API avoids private cache edits.
        mcp.add_provider(ProxyProvider(lambda:metadata_clients[name].new(),cache_ttl=0))
        mcp.add_middleware(BackendCatalogBound())
        mcp.add_middleware(BackendExecution(executions[name]))
        return mcp
    previous=gateway.FastMCPProxy
    try:
        gateway.FastMCPProxy=proxy  # Fixture assembly substitution only.
        mcp=original(config,provider,manager,metadata_clients)
    finally:gateway.FastMCPProxy=previous
    mcp.add_middleware(RequestSchemaScope())
    return mcp
