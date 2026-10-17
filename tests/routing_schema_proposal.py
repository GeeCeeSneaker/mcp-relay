"""WO10 isolated design prototype; NOT a packaged/deployed gateway patch."""
import asyncio
import httpx2
from fastmcp import Client,FastMCP
from fastmcp.server.providers.proxy import ProxyTool
from fastmcp.server.providers.base import Provider
from fastmcp.exceptions import ToolError
from fastmcp.server.dependencies import get_http_request, get_access_token
from fastmcp.server.middleware import Middleware
from mcp_types.version import MODERN_PROTOCOL_VERSIONS

METADATA_SECONDS = 3
STATE_KEY = 'wo10_schema_scope'

def require_unversioned(meta):
    if isinstance(meta,dict) and isinstance(meta.get('fastmcp'),dict) and 'version' in meta['fastmcp']:
        raise ToolError('Prototype excludes versioned tools and version requests')

def metadata_http_client_factory(**kwargs):
    kwargs.pop('timeout',None)
    return httpx2.AsyncClient(transport=httpx2.AsyncHTTPTransport(retries=0),
        timeout=httpx2.Timeout(connect=.25,read=2,write=2,pool=2),**kwargs)

class MetadataExecutionProvider(Provider):
    """Documented Provider extension; normal dispatch owns all execution gates.

    Construct raw proxy tools BEFORE namespace/rename/version/session transforms.
    Do not reconstruct resolved tools or short-circuit execution middleware.
    This proving lane serves tools only, not resources/prompts or proxy handshake.
    """
    def __init__(self,metadata_factory,execution_factory):
        super().__init__();self.metadata_factory=metadata_factory;self.execution_factory=execution_factory
    async def _list_tools(self):
        async with asyncio.timeout(METADATA_SECONDS):
            async with self.metadata_factory() as client:
                tools=await client.list_tools()
        for tool in tools:require_unversioned(tool.meta)
        return [ProxyTool.from_mcp_tool(self.execution_factory,tool) for tool in tools]

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
        require_unversioned(params.get('_meta'))
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
        body=await request.json()
        if isinstance(body,dict) and isinstance(body.get('params'),dict):
            require_unversioned(body['params'].get('_meta'))
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
    if any(config.backends[name].auth.type!='bearer' for name in clients):
        raise ValueError('Prototype requires bearer-only backends')
    from mcp_gateway import gateway
    from mcp_gateway.upstream import NoForwardStreamableHttpTransport
    metadata_clients={}
    executions={}
    for name,client in clients.items():
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
        mcp.add_provider(MetadataExecutionProvider(lambda:metadata_clients[name].new(),executions[name]))
        mcp.add_middleware(BackendCatalogBound())
        return mcp
    previous=gateway.FastMCPProxy
    try:
        gateway.FastMCPProxy=proxy  # Fixture assembly substitution only.
        mcp=original(config,provider,manager,metadata_clients)
    finally:gateway.FastMCPProxy=previous
    mcp.add_middleware(RequestSchemaScope())
    return mcp
