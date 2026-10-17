"""R1: real create_app parity with slow, genuinely versioned stock G0.

Runs only inside the product harness. The child mode hosts a disposable HTTP
backend, never the installed gateway or a permanent service.
"""
import asyncio
import hashlib
import json
import os
import pathlib
import secrets
import sys
import time

from fastmcp import Client, FastMCP
from fastmcp.client.transports import StreamableHttpTransport
from fastmcp.server.middleware import Middleware
from mcp.shared.exceptions import MCPError
from mcp_types import HEADER_MISMATCH
import httpx2
import yaml


def serve_stock(port):
    from fastmcp.server.auth.providers.jwt import StaticTokenVerifier
    from starlette.responses import PlainTextResponse
    from typing import Annotated
    from pydantic import Field
    token=os.environ.pop('WO10_STOCK_TOKEN')
    events=pathlib.Path(os.environ.pop('WO10_STOCK_EVENTS'))
    def event(kind):
        with events.open('a') as stream:stream.write(json.dumps({'kind':kind})+'\n')
    class SlowCatalog(Middleware):
        async def slow(self,context,call_next):
            event('catalog_started');await asyncio.sleep(.35)
            result=await call_next(context);event('catalog_completed');return result
        on_list_tools=slow
        on_list_resources=slow
        on_list_resource_templates=slow
        on_list_prompts=slow
    stock=FastMCP('slow-stock',auth=StaticTokenVerifier(tokens={token:{'client_id':'owned-stock','scopes':[]}}))
    stock.add_middleware(SlowCatalog())
    @stock.tool(name='versioned',version='1')
    def first(tag:Annotated[str,Field(json_schema_extra={'x-mcp-header':'fixture-tag'})])->dict:
        event('tool_executed');return {'version':'1','tag':tag}
    @stock.tool(name='versioned',version='2')
    def second(tag:Annotated[str,Field(json_schema_extra={'x-mcp-header':'fixture-tag'})])->dict:
        event('tool_executed');return {'version':'2','tag':tag}
    @stock.resource('stock://fixed',name='stock-fixed',description='Slow stock resource',mime_type='text/plain')
    def fixed()->str:return 'STOCK:fixed'
    @stock.resource('stock://item/{name}',name='stock-item',description='Slow stock template',mime_type='text/plain')
    def item(name:str)->str:return 'STOCK:'+name
    @stock.prompt(name='render',description='Slow stock prompt')
    def render(name:str)->str:return 'STOCK:'+name
    @stock.custom_route('/healthz',methods=['GET'])
    async def health(request):return PlainTextResponse('ok')
    stock.run(transport='http',host='127.0.0.1',port=port,show_banner=False,log_level='WARNING')


async def run(h):
    """Use the existing harness's owned process, OAuth and cleanup machinery."""
    results=[]
    async def check(label,operation):
        start=time.monotonic()
        try:
            await operation()
            item={'case':'slow_stock/'+label,'pass':True,'elapsed_seconds':round(time.monotonic()-start,3)}
        except Exception as error:
            item={'case':'slow_stock/'+label,'pass':False,'outcome':type(error).__name__,'elapsed_seconds':round(time.monotonic()-start,3)}
        results.append(item);print(json.dumps(item),flush=True)
    stock_port,probe_port=h.port(),h.port()
    stock_token,probe_token,password,key=(secrets.token_hex(32) for _ in range(4))
    stock_events=h.root/'slow-stock-events.jsonl';stock_events.write_text('')
    e=h.env();e.update(WO10_STOCK_TOKEN=stock_token,WO10_STOCK_EVENTS=str(stock_events))
    stock=h.launch('slow-stock',[sys.executable,str(pathlib.Path(__file__).resolve()),'--serve-stock',str(stock_port)],e)
    await h.ready(f'http://127.0.0.1:{stock_port}/healthz',stock)
    state=h.root/'slow-stock-probe-state.txt';state.write_text('ready')
    probe_events=h.root/'slow-stock-probe-events.jsonl';probe_events.write_text('')
    def probe_count(kind):return probe_events.read_text().count('"'+kind+'"')
    def executions():return stock_events.read_text().count('"tool_executed"')
    def launch_probe():
        e=h.env();e.update(WO10_PROBE_TOKEN=probe_token,WO10_PROBE_STATE=str(state),WO10_PROBE_EVENTS=str(probe_events),WO10_PROBE_COMPONENTS='1')
        return h.launch('slow-stock-sibling',[h.node_exe,str(h.repo/'tests/routing-probe.mjs'),str(probe_port)],e)
    probe=launch_probe();await h.ready(f'http://127.0.0.1:{probe_port}/healthz',probe)

    async def gateway(mixed):
        listen=h.port();base=f'http://127.0.0.1:{listen}'
        backends={'slow_stock':{'url':f'http://127.0.0.1:{stock_port}/mcp','auth':{'type':'bearer','token':stock_token}}}
        if mixed:backends['fixture_backend']={'url':f'http://127.0.0.1:{probe_port}/mcp','auth':{'type':'bearer','token':probe_token},'isolate_metadata':True,'metadata_profile':'bounded-v1'}
        name='mixed' if mixed else 'control'
        config={'server':{'public_url':base,'host':'127.0.0.1','port':listen},'auth':{'encryption_key':key,'users':[{'username':'fixture','password':password}],'allowed_client_redirect_uris':['http://127.0.0.1:*/callback']},'storage':{'path':str(h.root/('slow-stock-'+name+'.db'))},'backends':backends}
        cfg=h.root/('slow-stock-'+name+'.yaml');cfg.write_text(yaml.safe_dump(config))
        loader=h.root/('slow_stock_'+name+'.py');loader.write_text('import os\nfrom mcp_gateway.app import create_app\napp=create_app(os.environ["WO10_CONFIG"])\n')
        e=h.env();e['PYTHONPATH']=str(h.root)+os.pathsep+str(h.source/'src');e['WO10_CONFIG']=str(cfg)
        process=h.launch('gateway-slow-stock-'+name,[sys.executable,'-m','uvicorn',loader.stem+':app','--host','127.0.0.1','--port',str(listen),'--log-level','warning'],e)
        await h.ready(base+'/.well-known/oauth-authorization-server',process)
        access=await h.auth(base,password)
        return base,access,process
    def client(base,access,headers=None):
        values={'Authorization':'Bearer '+access};values.update(headers or {})
        return Client(StreamableHttpTransport(base+'/mcp',headers=values),timeout=10,init_timeout=5)
    async def catalog(front,family):
        method={'tools':'list_tools','resources':'list_resources','templates':'list_resource_templates','prompts':'list_prompts'}[family]
        items=await getattr(front,method)()
        def belongs(item):
            return str(getattr(item,'uri','')).startswith('stock://slow_stock/') or str(getattr(item,'uri_template','')).startswith('stock://slow_stock/') or getattr(item,'name','').startswith('slow_stock_')
        return sorted((item.model_dump(mode='json') for item in items if belongs(item)),key=lambda value:json.dumps(value,sort_keys=True))
    async def version_call(base,access,selected,tag='matching',header='matching'):
        async with client(base,access,{'Mcp-Param-fixture-tag':header}) as front:
            return await front.call_tool_mcp('slow_stock_versioned',{'tag':tag},meta={'fastmcp':{'version':selected}})
    def payload(value):return json.loads(''.join(getattr(part,'text','') for part in value.content))
    control_base,control_access,control=await gateway(False)
    descriptors={};version_results={}
    async with client(control_base,control_access) as front:
        for family in ['tools','resources','templates','prompts']:
            async def control_catalog(family=family):
                before=stock_events.read_text().count('catalog_completed');start=time.monotonic()
                descriptors[family]=await catalog(front,family)
                assert descriptors[family], 'control must advertise stock components'
                assert time.monotonic()-start>.25
                assert stock_events.read_text().count('catalog_completed')>before
                digest=hashlib.sha256(json.dumps(descriptors[family],sort_keys=True).encode()).hexdigest()
                print(json.dumps({'stock_descriptor_control':family,'count':len(descriptors[family]),'sha256':digest}),flush=True)
            await check('control/'+family,control_catalog)
    # Genuine backend versions must dispatch differently in the stock control;
    # do not bless an unversioned tool that happens to accept version metadata.
    for selected in ['1','2']:
        async def control_version(selected=selected):
            value=await version_call(control_base,control_access,selected)
            assert not value.is_error
            version_results[selected]=payload(value)
            assert version_results[selected]=={'version':selected,'tag':'matching'}
            print(json.dumps({'real_stock_version_control':selected,'result':version_results[selected]}),flush=True)
        await check('control/version_'+selected,control_version)
    assert version_results.keys()=={'1','2'} and version_results['1']!=version_results['2']
    h.stop(control)
    base,access,gateway_process=await gateway(True)
    async with client(base,access) as front:
        for mode in ['healthy','refused','stalled','cancelled']:
            if mode=='refused':h.stop(probe)
            elif mode=='stalled':
                probe=launch_probe();await h.ready(f'http://127.0.0.1:{probe_port}/healthz',probe);state.write_text('stall')
            elif mode=='cancelled':
                before=probe_count('metadata_started')
                opted_executions=probe_count('tool_executed')
                async def opted_call():
                    async with client(base,access) as requester:
                        return await requester.call_tool_mcp('fixture_backend_probe',{'tag':'matching'})
                pending=asyncio.create_task(opted_call())
                for _ in range(80):
                    if probe_count('metadata_started')>before:break
                    await asyncio.sleep(.025)
                else:raise AssertionError('cancel test did not enter opted metadata')
                pending.cancel()
                try:await pending
                except asyncio.CancelledError:pass
                else:raise AssertionError('cancelled request completed')
            for family in ['tools','resources','templates','prompts']:
                async def parity(family=family):
                    before=stock_events.read_text().count('catalog_completed');start=time.monotonic()
                    actual=await catalog(front,family)
                    assert actual==descriptors[family], 'stock descriptor parity failed'
                    assert time.monotonic()-start>.25
                    assert stock_events.read_text().count('catalog_completed')>before
                    print(json.dumps({'stock_descriptor_parity':mode+'/'+family,'count':len(actual),'sha256':hashlib.sha256(json.dumps(actual,sort_keys=True).encode()).hexdigest()}),flush=True)
                await check(mode+'/'+family+'_full_descriptor_parity',parity)
            for selected in ['1','2']:
                async def version_parity(selected=selected):
                    before=executions();value=await version_call(base,access,selected)
                    assert not value.is_error and payload(value)==version_results[selected]
                    assert executions()==before+1
                await check(mode+'/version_'+selected+'_fresh_header_dispatch',version_parity)
            async def rejected(kind):
                before=executions()
                try:value=await version_call(base,access,'2',tag=123 if kind=='argument' else 'body',header='123' if kind=='argument' else 'wrong')
                except MCPError as error:
                    if kind=='header':assert error.code==HEADER_MISMATCH
                except httpx2.HTTPStatusError as error:assert error.response.status_code==400
                else:assert value.is_error
                assert executions()==before
            for kind in ['header','argument']:
                await check(mode+'/'+kind+'_rejected_zero_execution',lambda kind=kind:rejected(kind))
            async def non_tool_execution():
                assert 'STOCK:fixed' in str(await front.read_resource('stock://slow_stock/fixed'))
                assert 'STOCK:example' in str(await front.read_resource('stock://slow_stock/item/example'))
                assert 'STOCK:example' in str(await front.get_prompt('slow_stock_render',{'name':'example'}))
            await check(mode+'/resource_template_prompt_dispatch',non_tool_execution)
        async def cancellation_closed():
            for _ in range(100):
                if probe_count('metadata_started')==probe_count('metadata_closed'):
                    assert probe_count('tool_executed')==opted_executions
                    return
                await asyncio.sleep(.025)
            raise AssertionError('opted metadata did not close')
        await check('cancelled/bounded_opted_closure',cancellation_closed)
    h.stop(gateway_process);h.stop(probe);h.stop(stock)
    return results


if __name__=='__main__':
    if len(sys.argv)!=3 or sys.argv[1]!='--serve-stock':raise SystemExit('child fixture mode only')
    serve_stock(int(sys.argv[2]))
