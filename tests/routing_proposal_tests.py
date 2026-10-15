"""Pinned-package proving tests for the WO10 opt-in tool-only prototype."""
import asyncio
import contextvars
from types import SimpleNamespace as NS
from unittest.mock import patch
from fastmcp import Client, FastMCP
from fastmcp.exceptions import ToolError
from fastmcp.server.middleware import Middleware
from fastmcp.server.extensions import ServerExtension
from fastmcp.server.transforms import ToolTransform
from fastmcp.tools.tool_transform import ToolTransformConfig
from routing_schema_proposal import MetadataExecutionProvider, RequestSchemaScope, STATE_KEY, require_unversioned, proposed_gateway

async def run_negatives():
    results=[]
    async def check(name,operation):
        try:await operation();results.append({'case':'pinned/'+name,'pass':True})
        except Exception as e:results.append({'case':'pinned/'+name,'pass':False,'outcome':type(e).__name__})
    executions=[];backend=FastMCP('owned-memory-backend')
    @backend.tool
    def original(value:int)->int:
        executions.append(value);return value
    provider=MetadataExecutionProvider(lambda:Client(backend),lambda:Client(backend))
    front=FastMCP('owned-memory-front');front.add_provider(provider)
    front.add_transform(ToolTransform({'original':ToolTransformConfig(name='renamed')}))
    async def renamed():
        before=len(executions);await front.call_tool('renamed',{'value':7})
        assert executions[before:]==[7]
    await check('rename_preserves_backend_identity_and_normal_dispatch',renamed)
    class Deny(Middleware):
        async def on_call_tool(self,context,call_next):raise ToolError('test deny')
    async def middleware():
        guarded=FastMCP('guarded');guarded.add_provider(provider);guarded.add_middleware(Deny())
        before=len(executions)
        try:await guarded.call_tool('original',{'value':8})
        except ToolError:pass
        else:raise AssertionError('middleware bypassed')
        assert len(executions)==before
    await check('downstream_middleware_refuses_zero_execution',middleware)
    class DenyExtension(ServerExtension):
        identifier='com.example/wo10-test'
        async def intercept_tool_call(self,params,context,call_next):raise ToolError('test interceptor deny')
    async def interceptor():
        guarded=FastMCP('intercepted');guarded.add_provider(provider);guarded.add_extension(DenyExtension())
        before=len(executions)
        try:await guarded.call_tool('original',{'value':9})
        except ToolError:pass
        else:raise AssertionError('interceptor bypassed')
        assert len(executions)==before
    await check('normal_extension_interceptor_refuses_zero_execution',interceptor)
    async def rejected_tool(kind):
        guarded=FastMCP('rejected');tool=(await provider.list_tools())[0]
        if kind=='denied':tool=tool.model_copy(update={'auth':lambda ctx:False})
        if kind=='missing_auth':tool=tool.model_copy(update={'auth':lambda ctx:ctx.token is not None})
        guarded.add_tool(tool)
        if kind=='disabled':guarded.disable(keys={tool.key})
        before=len(executions)
        try:await guarded.call_tool('unknown' if kind=='unknown' else 'original',{'value':10})
        except Exception:
            assert await guarded.get_tool('unknown' if kind=='unknown' else 'original') is None
        else:raise AssertionError('unsupported call executed')
        assert len(executions)==before
    for kind in ['denied','disabled','missing_auth','unknown']:
        await check(kind+'_zero_backend_execution',lambda kind=kind:rejected_tool(kind))
    async def version():
        before=len(executions)
        versioned=FastMCP('versioned-memory-backend')
        versioned.tool(lambda:1,name='versioned',version='1')
        version_provider=MetadataExecutionProvider(lambda:Client(versioned),lambda:Client(versioned))
        try:await version_provider.list_tools()
        except ToolError:pass
        else:raise AssertionError('versioned backend descriptor admitted')
        assert len(executions)==before
    await check('version_request_and_descriptor_excluded',version)
    async def unsupported_auth():
        for kind in ['oauth','headers','none']:
            b=NS(enabled=True,auth=NS(type=kind));called=[]
            try:proposed_gateway(lambda *a:called.append(1),NS(backends={'one':b}),None,None,{'one':object()})
            except ValueError:pass
            else:raise AssertionError('unsupported auth admitted')
            assert not called
    await check('non_bearer_rejected_before_assembly',unsupported_auth)
    request_var=contextvars.ContextVar('owned-test-request');scope=RequestSchemaScope()
    class Request:
        def __init__(self):self.state=NS();self.headers={}
        async def json(self):return {'method':'tools/call','params':{'name':'original','arguments':{'value':1}}}
    def context(server):return NS(message=NS(name='original',arguments={'value':1}),fastmcp_context=NS(fastmcp=server,request_context=NS(protocol_version='2026-07-28',request=object())))
    async def request_tests():
        good,bad=Request(),Request();recovered=False;dispatched=[];ready=asyncio.Event()
        class Lookup:
            async def get_tool(self,name):
                if request_var.get() is bad and not recovered:
                    ready.set();await asyncio.sleep(.02);raise TimeoutError
                return await backend.get_tool(name)
        ctx=context(Lookup())
        async def next_call(context):dispatched.append(request_var.get())
        async def noop(context):raise AssertionError('synthetic schema went global')
        async def preflight(request):
            request_var.set(request);return await scope.on_list_tools(ctx,noop)
        with patch('routing_schema_proposal.get_http_request',side_effect=request_var.get),patch('routing_schema_proposal.get_access_token',return_value=object()):
            task=asyncio.create_task(preflight(bad));await ready.wait();await preflight(good);await task
            assert getattr(good.state,STATE_KEY)==('original',True) and getattr(bad.state,STATE_KEY)==('original',False)
            recovered=True;request_var.set(bad)
            try:await scope.on_call_tool(ctx,next_call)
            except ToolError:pass
            else:raise AssertionError('recovered backend allowed unvalidated dispatch')
            request_var.set(good);await scope.on_call_tool(ctx,next_call);assert dispatched==[good]
    # Record zero tool execution independently of how many positive controls ran.
    before=len(executions)
    async def markers():
        # This check's next-call spy never invokes a backend.
        await request_tests();assert len(executions)==before
    # Avoid coupling the security assertion to a global positive-control count.
    await check('concurrent_request_markers_and_recovery_fail_closed',markers)
    async def missing_context():
        req=Request();request_var.set(req);ctx=context(backend);called=[]
        async def never(context):called.append(1)
        with patch('routing_schema_proposal.get_http_request',side_effect=request_var.get),patch('routing_schema_proposal.get_access_token',return_value=None):
            try:await scope.on_list_tools(ctx,never)
            except ToolError:pass
            else:raise AssertionError('missing auth schema admitted')
        assert not called and getattr(req.state,STATE_KEY)==('original',False)
    await check('missing_schema_auth_context_fails_closed',missing_context)
    async def requested_version():
        req=Request();request_var.set(req);ctx=context(backend);called=[]
        async def body():return {'method':'tools/call','params':{'name':'original','_meta':{'fastmcp':{'version':{'eq':'1'}}}}}
        req.json=body
        async def never(context):called.append(1)
        with patch('routing_schema_proposal.get_http_request',side_effect=request_var.get),patch('routing_schema_proposal.get_access_token',return_value=object()):
            for operation in [scope.on_list_tools(ctx,never),scope.on_call_tool(ctx,never)]:
                try:await operation
                except ToolError:pass
                else:raise AssertionError('requested version admitted')
        assert not called
    await check('requested_version_refused_before_execution',requested_version)
    return results
