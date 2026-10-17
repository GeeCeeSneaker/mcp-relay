"""WO-0010 isolated OAuth gateway composition; never central/tunnel E2E."""
import argparse, asyncio, base64, ctypes, hashlib, json, os, pathlib, secrets, shutil, socket, subprocess, sys, tempfile, time, traceback
from urllib.parse import parse_qs, urlencode, urlparse
import httpx, httpx2, yaml
from fastmcp import Client
from fastmcp.client.transports import StreamableHttpTransport
from mcp.shared.exceptions import MCPError
from mcp_types import REQUEST_TIMEOUT
from mcp_types import HEADER_MISMATCH

ap=argparse.ArgumentParser();ap.add_argument('--gateway-source',required=True);ap.add_argument('--node-exe',default=shutil.which('node'));ap.add_argument('--sample-seconds',type=float,default=30);ap.add_argument('--diagnostic-only',action='store_true',help='Collect isolation outcomes even on the known timeout; never acceptance');ap.add_argument('--schema-scope-proposal',action='store_true',help='Test-only opt-in assembly; not product implementation');ap.add_argument('--production-mixed',action='store_true',help='Real candidate config/build_gateway; stock G0 plus opted G1');ap.add_argument('--strict-matrix',action='store_true',help='Run all cold/warm/concurrent/reconnect negatives; any failed check exits 1');ap.add_argument('--stock-compatibility-only',action='store_true',help='Focused R1 regression, not the full product matrix');args=ap.parse_args()
if args.production_mixed and (args.schema_scope_proposal or not args.strict_matrix):ap.error('mixed product path requires strict matrix and no prototype substitution')
if args.strict_matrix and args.diagnostic_only:ap.error('strict matrix cannot use diagnostic-only mode')
if args.stock_compatibility_only and not args.production_mixed:ap.error('focused R1 mode requires actual product assembly')
if not args.node_exe or not 1<=args.sample_seconds<=60:raise SystemExit('node executable and 1..60 second sample required')
repo=pathlib.Path(__file__).resolve().parents[1];source=pathlib.Path(args.gateway_source).resolve()
root=pathlib.Path(tempfile.mkdtemp(prefix='mcprelay-wo10-')).resolve();processes=[];logs=[];reports=[];stage='prepare';checks=0;isolation=[];matrix=[];baseline=[]
stock_version_error=None

def report(name):
    global checks
    checks+=1;print('PASS '+name,flush=True)
def port():
    with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]
def env():
    e={k:v for k,v in os.environ.items() if k.upper() in ['SYSTEMROOT','WINDIR','SYSTEMDRIVE','TEMP','TMP','PATH']}
    e.update(PYTHONDONTWRITEBYTECODE='1',PYTHONIOENCODING='utf-8',PYTHONPATH=str(source/'src'))
    return e
def launch(label,command,e):
    logfile=open(root/(label+'-'+str(len(logs))+'.log'),'wb');logs.append(logfile)
    p=subprocess.Popen(command,env=e,cwd=repo,stdout=logfile,stderr=subprocess.STDOUT,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
    processes.append(p);return p
def stop(p):
    if p.poll() is None:
        p.terminate()
        try:p.wait(5)
        except subprocess.TimeoutExpired:p.kill();p.wait(5)
async def ready(url,p):
    async with httpx.AsyncClient(timeout=1) as h:
        for _ in range(100):
            if p.poll() is not None:raise RuntimeError('owned fixture startup failed')
            try:
                if (await h.get(url)).status_code==200:return
            except httpx.HTTPError:pass
            await asyncio.sleep(.1)
    raise RuntimeError('owned fixture readiness deadline')
def resource(p):
    if p.poll() is not None:raise RuntimeError('owned process exited during resource sample')
    if os.name=='nt':
        from ctypes import wintypes as w
        class PMC(ctypes.Structure):
            _fields_=[('cb',w.DWORD),('faults',w.DWORD)]+[(n,ctypes.c_size_t) for n in ['peak','rss','qpp','qp','qnp','qn','pf','ppf']]
        k=ctypes.WinDLL('kernel32',use_last_error=True);a=ctypes.WinDLL('psapi',use_last_error=True)
        k.GetProcessTimes.argtypes=[w.HANDLE]+[ctypes.POINTER(ctypes.c_uint64)]*4
        a.GetProcessMemoryInfo.argtypes=[w.HANDLE,ctypes.POINTER(PMC),w.DWORD]
        creation,exit_time,kernel,user=(ctypes.c_uint64() for _ in range(4));memory=PMC()
        if not k.GetProcessTimes(int(p._handle),ctypes.byref(creation),ctypes.byref(exit_time),ctypes.byref(kernel),ctypes.byref(user)) or not a.GetProcessMemoryInfo(int(p._handle),ctypes.byref(memory),ctypes.sizeof(memory)):raise RuntimeError('owned resource counters unavailable')
        return {'start':str(creation.value),'cpu':(kernel.value+user.value)/1e7,'rss':memory.rss}
    f=pathlib.Path('/proc/'+str(p.pid)+'/stat').read_text().rsplit(')',1)[1].split()
    return {'start':f[19],'cpu':(int(f[11])+int(f[12]))/os.sysconf('SC_CLK_TCK'),'rss':int(f[21])*os.sysconf('SC_PAGESIZE')}
async def measure(label,owned):
    def http_requests():
        return sum(f.read_bytes().count(b'HTTP Request:') for f in root.glob('gateway-*.log'))
    request_count=http_requests();a=[resource(p) for p in owned];start=time.monotonic();await asyncio.sleep(args.sample_seconds);b=[resource(p) for p in owned];elapsed=time.monotonic()-start
    assert all(x['start']==y['start'] for x,y in zip(a,b))
    r={'label':label,'window_seconds':elapsed,'temporary_process_count':len(owned),'cpu_percent_one_core':sum(y['cpu']-x['cpu'] for x,y in zip(a,b))/elapsed*100,'rss_mib':sum(y['rss'] for y in b)/1048576,'idle_logged_http_requests':http_requests()-request_count,'ssh_keepalive':'not_in_isolated_fixture'}
    reports.append(r);print(json.dumps(r),flush=True)
def facts(result):
    text=''.join(getattr(c,'text','') for c in result.content);return json.loads(text)
async def auth(base,password):
    async with httpx.AsyncClient(timeout=10,follow_redirects=False) as h:
        unauth=await h.post(base+'/mcp',json={'jsonrpc':'2.0','id':1,'method':'tools/list'},headers={'accept':'application/json, text/event-stream'});assert unauth.status_code==401
        report('existing gateway boundary refuses unauthenticated MCP')
        meta=(await h.get(base+'/.well-known/oauth-authorization-server')).json()
        redirect='http://127.0.0.1:53682/callback';reg={'client_name':'wo10-fixture','redirect_uris':[redirect],'token_endpoint_auth_method':'none','grant_types':['authorization_code','refresh_token'],'response_types':['code']}
        r=await h.post(meta['registration_endpoint'],json=reg);assert r.status_code in [200,201];client_id=r.json()['client_id']
        verifier=secrets.token_urlsafe(48);challenge=base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode();state=secrets.token_hex(8)
        q={'response_type':'code','client_id':client_id,'redirect_uri':redirect,'code_challenge':challenge,'code_challenge_method':'S256','state':state,'resource':base+'/mcp'}
        r=await h.get(meta['authorization_endpoint']+'?'+urlencode(q));txn=parse_qs(urlparse(r.headers.get('location','')).query)['txn'][0]
        assert (await h.post(base+'/auth/api/login',json={'username':'fixture','password':password})).status_code==200
        r=await h.post(base+'/auth/api/consent',json={'txn_id':txn,'approve':True});cb=parse_qs(urlparse(r.json()['redirect_to']).query);assert cb['state']==[state]
        r=await h.post(meta['token_endpoint'],data={'grant_type':'authorization_code','code':cb['code'][0],'redirect_uri':redirect,'client_id':client_id,'code_verifier':verifier,'resource':base+'/mcp'});assert r.status_code==200
        report('real isolated OAuth code/PKCE/login/consent exchange succeeds');return r.json()['access_token']
async def strict_outages(base,access,client,probe,launch_probe,probe_port,cold,probe_state,probe_events):
    threshold=max(.75,5*max(baseline));assert threshold<=2, 'healthy fixture baseline too slow for this regression envelope'
    async def rpc(name,arguments,c=None,headers=None,meta=None):
        if c is not None:return await c.call_tool_mcp(name,arguments,meta=meta)
        h={'Authorization':'Bearer '+access,'X-WO10-Canary':'strict-caller'};h.update(headers or {})
        # The whole fresh session includes the SDK output-schema lookup.
        async with Client(StreamableHttpTransport(base+'/mcp',headers=h),timeout=8,init_timeout=5) as fresh:
            return await asyncio.wait_for(fresh.call_tool_mcp(name,arguments,meta=meta),10)
    async def check(label,operation,expected,limit):
        start=time.monotonic();ok=False;outcome='unknown'
        try:
            value=await operation;outcome='result';ok=expected(value)
        except MCPError as e:outcome='MCP_ERROR_'+str(e.code)
        except Exception as e:outcome=type(e).__module__+'.'+type(e).__name__
        elapsed=time.monotonic()-start;ok=ok and elapsed<=limit
        item={'case':label,'pass':ok,'outcome':outcome,'elapsed_seconds':round(elapsed,3),'limit_seconds':round(limit,3)}
        matrix.append(item);print(json.dumps(item),flush=True)
    healthy=lambda r:not r.is_error and facts(r)['server_version']=='2.5.1'
    failed=lambda r:r.is_error
    generic_args={'capability':'node_status','args':{}}
    mode='cold_before_discovery' if cold else 'warm_after_discovery'
    if args.production_mixed:
        if not cold:
            await check(mode+'/real_component_resources',client.list_resources(),lambda items:any(str(r.uri)=='fixture://fixture_backend/component' for r in items),4)
            await check(mode+'/real_component_templates',client.list_resource_templates(),lambda items:any(t.uri_template=='fixture://fixture_backend/item/{name}' for t in items),4)
            await check(mode+'/real_component_prompts',client.list_prompts(),lambda items:any(p.name=='fixture_backend_render' for p in items),4)
            await check(mode+'/resource_namespace_identity',client.read_resource('fixture://fixture_backend/component'),lambda value:'RESOURCE:fixture://component' in str(value),4)
            await check(mode+'/template_namespace_identity',client.read_resource('fixture://fixture_backend/item/example'),lambda value:'RESOURCE:fixture://item/example' in str(value),4)
            await check(mode+'/prompt_namespace_identity',client.get_prompt('fixture_backend_render',{'name':'example'}),lambda value:'PROMPT:example' in str(value),4)
            async def long_component(kind):
                start=time.monotonic()
                value=await client.read_resource('fixture://fixture_backend/item/slow') if kind=='resource' else await client.get_prompt('fixture_backend_render',{'name':'slow'})
                return 'slow' in str(value) and time.monotonic()-start>=3.1
            await check(mode+'/resource_execution_outlives_metadata_budget',long_component('resource'),lambda value:value,6)
            await check(mode+'/prompt_execution_outlives_metadata_budget',long_component('prompt'),lambda value:value,6)
            probe_state.write_text('component_error')
            async def component_error(kind):
                try:
                    if kind=='resource':await client.read_resource('fixture://fixture_backend/component')
                    else:await client.get_prompt('fixture_backend_render',{'name':'example'})
                except MCPError:return True
                return False
            await check(mode+'/resource_error_not_swallowed',component_error('resource'),lambda value:value,4)
            await check(mode+'/prompt_error_not_swallowed',component_error('prompt'),lambda value:value,4)
            probe_state.write_text('ready')
    async def delayed_execution():
        # Windows PowerShell initialization plus the 4s command can outlast the
        # existing 7s initial-output wait. Use the pinned Node directly via CMD;
        # a whitespace-free expression avoids CMD's quoted-command ambiguity.
        # Assert its version and enter the owned root inside Node. Keep 7s/8s.
        directory=str(root).replace("'","'\"'\"'")
        command="node -e require('node:assert').equal(process.version,'v24.21.0');process.chdir(process.env.WO10_CONTROL_ROOT);setTimeout(console.log,4000,'WO10_DELAY')" if os.name=='nt' else f"cd '{directory}' && sleep 4 && printf 'WO10_DELAY\\n'"
        shell='cmd.exe' if os.name=='nt' else '/bin/sh'
        start=time.monotonic()
        r=await rpc('fixture_node_invoke_exec',{'capability':'start_process','args':{'command':command,'shell':shell,'timeout_ms':7000}})
        output=''.join(getattr(c,'text','') for c in r.content)
        marker='WO10_DELAY' in output;finished='Process finished with exit code 0.' in output
        import re
        exit_match=re.search(r'Process finished with exit code (-?\d+)\.',output)
        print(json.dumps({'execution_control':mode,'mcp_error':r.is_error,'timer_marker':marker,'finished_zero':finished,'exit_code':int(exit_match[1]) if exit_match else None,'still_running':'Process still running;' in output,'shell_error':'syntax is incorrect' in output}),flush=True)
        if r.is_error or not marker or not finished:(root/('delayed-'+mode+'.txt')).write_text(output)
        return not r.is_error and marker and finished and time.monotonic()-start>=3.5
    await check(mode+'/metadata_deadline_does_not_cut_execution',delayed_execution(),lambda complete:complete,8)
    for cycle in range(2):
        old_start=resource(probe)['start'] if probe.poll() is None else probe.initial_start
        stop(probe);assert probe.poll() is not None
        for frontend,c in [('existing_session',client),('fresh_session',None)]:
            label=f'{mode}/cycle{cycle}/{frontend}'
            await check(label+'/alone',rpc('fixture_node_invoke_read',generic_args,c),healthy,threshold)
            bad=asyncio.create_task(check(label+'/failed_backend',rpc('fixture_backend_probe',{}),failed,4))
            await asyncio.sleep(.05)
            await check(label+'/alongside_failed_backend',rpc('fixture_node_invoke_read',generic_args,c),healthy,threshold)
            await bad
        async def catalog():return {t.name for t in await client.list_tools()}
        await check(f'{mode}/cycle{cycle}/catalog',catalog(),lambda t:'fixture_node_invoke_read' in t and 'fixture_backend_probe' not in t,4)
        async def unauthenticated():
            async with httpx.AsyncClient(timeout=4) as h:
                return (await h.post(base+'/mcp',json={'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':'fixture_node_invoke_read','arguments':generic_args}},headers={'Authorization':'Bearer invalid-fixture-token','accept':'application/json, text/event-stream'})).status_code
        await check(f'{mode}/cycle{cycle}/unauthorized',unauthenticated(),lambda status:status==401,4)
        await check(f'{mode}/cycle{cycle}/malformed_arguments',rpc('fixture_node_invoke_read',{'capability':123,'args':{}}),failed,4)
        await check(f'{mode}/cycle{cycle}/unavailable_schema_refuses_execution',rpc('fixture_backend_probe',{'tag':'matching'},headers={'Mcp-Param-fixture-tag':'matching'}),failed,4)
        probe=launch_probe();await ready(f'http://127.0.0.1:{probe_port}/healthz',probe)
        probe.initial_start=resource(probe)['start'];assert probe.initial_start!=old_start
        await check(f'{mode}/cycle{cycle}/reconnected',rpc('fixture_backend_probe',{}),lambda r:not r.is_error and facts(r)['marker']=='WO0010_OK' and not facts(r)['caller_canary_seen'],threshold)
        if args.production_mixed:
            before_calls=probe_events.read_text().count('tool_executed')
            async def opted_version():
                result=await rpc('fixture_backend_probe',{},meta={'fastmcp':{'version':'1'}})
                return result.is_error and probe_events.read_text().count('tool_executed')==before_calls
            await check(f'{mode}/cycle{cycle}/opted_version_zero_execution',opted_version(),lambda value:value,4)
        await check(f'{mode}/cycle{cycle}/matching_header',rpc('fixture_backend_probe',{'tag':'matching'},headers={'Mcp-Param-fixture-tag':'matching'}),lambda r:not r.is_error,threshold)
        async def mismatch():
            try:await rpc('fixture_backend_probe',{'tag':'body'},headers={'Mcp-Param-fixture-tag':'wrong'})
            except MCPError as e:return e.code==HEADER_MISMATCH
            except httpx2.HTTPStatusError as e:return e.response.status_code==400
            return False
        await check(f'{mode}/cycle{cycle}/mismatched_header',mismatch(),lambda rejected:rejected,4)
    if args.production_mixed and cold:
        # G1 is now alive but advertises only tools: these are genuine absent
        # method controls, not an unavailable-backend empty catalog.
        await check(mode+'/absent_opted_resource_methods',client.list_resources(),lambda items:items==[],4)
        await check(mode+'/absent_opted_template_methods',client.list_resource_templates(),lambda items:items==[],4)
        await check(mode+'/absent_opted_prompt_methods',client.list_prompts(),lambda items:items==[],4)
    def events():
        records=[json.loads(line)['kind'] for line in probe_events.read_text().splitlines()]
        return {name:records.count(name) for name in ['metadata_started','metadata_closed','tool_executed']}
    before=events();probe_state.write_text('stall')
    stalled=asyncio.create_task(check(mode+'/stalled_metadata/refused',rpc('fixture_backend_probe',{'tag':'matching'},headers={'Mcp-Param-fixture-tag':'matching'}),failed,4))
    await asyncio.sleep(.1)
    await check(mode+'/stalled_metadata/healthy_sibling',rpc('fixture_node_invoke_read',generic_args,client),healthy,threshold)
    if args.production_mixed:
        await check(mode+'/stalled_metadata/fresh_healthy_sibling',rpc('fixture_node_invoke_read',generic_args),healthy,threshold)
        # Compare with this run's actual default-off control, not an assumed
        # version error: pinned stock dispatch accepts this node's metadata.
        assert stock_version_error is not None
        await check(mode+'/stalled_metadata/stock_version_metadata_baseline',rpc('fixture_node_invoke_read',generic_args,meta={'fastmcp':{'version':'1'}}),lambda r:r.is_error==stock_version_error and (r.is_error or healthy(r)),4)
    await stalled
    async def closed():
        for _ in range(40):
            r=events()
            if r['metadata_started']>before['metadata_started'] and r['metadata_started']==r['metadata_closed']:
                return r['tool_executed']==before['tool_executed']
            await asyncio.sleep(.05)
        return False
    await check(mode+'/stalled_metadata/closed_zero_execution',closed(),lambda value:value,3)
    before=events();cancelled=asyncio.create_task(rpc('fixture_backend_probe',{'tag':'matching'},headers={'Mcp-Param-fixture-tag':'matching'}))
    for _ in range(40):
        if events()['metadata_started']>before['metadata_started']:break
        await asyncio.sleep(.025)
    else:raise AssertionError('metadata cancellation did not reach the accepting backend')
    cancelled.cancel()
    async def cancellation():
        try:await cancelled
        except asyncio.CancelledError:return True
        return False
    await check(mode+'/cancelled_metadata/caller_cancelled',cancellation(),lambda value:value,1)
    await check(mode+'/cancelled_metadata/healthy_sibling',rpc('fixture_node_invoke_read',generic_args,client),healthy,threshold)
    if args.production_mixed:
        await check(mode+'/cancelled_metadata/fresh_healthy_sibling',rpc('fixture_node_invoke_read',generic_args),healthy,threshold)
    await check(mode+'/cancelled_metadata/closed_zero_execution',closed(),lambda value:value,3)
    probe_state.write_text('ready')
    await check(mode+'/stalled_metadata/recovered',rpc('fixture_backend_probe',{}),lambda r:not r.is_error and facts(r)['marker']=='WO0010_OK',threshold)
    return probe

async def proposal_negatives():
    from types import SimpleNamespace as NS
    from unittest.mock import patch
    from fastmcp.exceptions import ToolError
    from routing_schema_proposal import proposed_gateway,RequestSchemaScope
    called=False
    def original(*args):
        nonlocal called
        called=True;raise AssertionError('overlap must be rejected before assembly')
    try:proposed_gateway(original,NS(backends={'fixture':NS(enabled=True),'fixture_backend':NS(enabled=True)}),None,None,None)
    except ValueError:matrix.append({'case':'prototype_namespace_overlap_pre_side_effect','pass':not called})
    else:matrix.append({'case':'prototype_namespace_overlap_pre_side_effect','pass':False})
    executed=False
    async def execute(context):
        nonlocal executed
        executed=True
    context=NS(message=NS(name='fixture_backend_probe',arguments={'tag':'body'}),fastmcp_context=NS(request_context=NS(protocol_version='2026-07-28')))
    request=NS(state=NS(),headers={})
    async def request_json():return {'method':'tools/call','params':{'name':'fixture_backend_probe'}}
    request.json=request_json
    with patch('routing_schema_proposal.get_http_request',return_value=request):
        try:await RequestSchemaScope().on_call_tool(context,execute)
        except ToolError:matrix.append({'case':'prototype_missing_schema_fail_closed','pass':not executed})
        else:matrix.append({'case':'prototype_missing_schema_fail_closed','pass':False})

async def trial(with_probe,cold=False):
    global stage,stock_version_error
    stage='startup';generic_port,probe_port,gateway_port=port(),port(),port();node_token,probe_token,password,key=(secrets.token_hex(32) for _ in range(4))
    e=env();e.update(MCPRELAY_BRIDGE_TOKEN=node_token,MCPRELAY_ALLOWED_DIRS=str(root),MCPRELAY_TARGETS=str(root/'targets.json'),MCPRELAY_AUDIT_LOG=str(root/'audit'/'audit.log'))
    if os.name=='nt':
        e['PATH']=str(pathlib.Path(args.node_exe).resolve().parent)+os.pathsep+e.get('PATH','')
        e['WO10_CONTROL_ROOT']=str(root)
    generic=launch('generic',[args.node_exe,str(repo/'node-runtime/server.mjs'),'--port',str(generic_port)],e)
    await ready(f'http://127.0.0.1:{generic_port}/healthz',generic)
    probe_state=root/('probe-state-'+str(len(logs))+'.txt');probe_state.write_text('ready')
    probe_events=root/('probe-events-'+str(len(logs))+'.jsonl');probe_events.write_text('')
    def launch_probe():
        e=env();e.update(WO10_PROBE_TOKEN=probe_token,WO10_PROBE_STATE=str(probe_state),WO10_PROBE_EVENTS=str(probe_events))
        if args.production_mixed and not cold:e['WO10_PROBE_COMPONENTS']='1'
        return launch('probe',[args.node_exe,str(repo/'tests/routing-probe.mjs'),str(probe_port)],e)
    probe=launch_probe() if with_probe else None
    if probe:
        await ready(f'http://127.0.0.1:{probe_port}/healthz',probe);probe.initial_start=resource(probe)['start']
    if probe:
        async with Client(StreamableHttpTransport(f'http://127.0.0.1:{probe_port}/mcp',headers={'Authorization':'Bearer '+probe_token,'X-WO10-Canary':'positive-control'}),timeout=10) as direct:
            assert facts(await direct.call_tool_mcp('probe',{}))['caller_canary_seen']
        report('header detector positive control sees a direct caller canary')
    if cold:stop(probe)
    backends={'fixture_node':{'url':f'http://127.0.0.1:{generic_port}/mcp','auth':{'type':'bearer','token':node_token}}}
    if with_probe:backends['fixture_backend']={'url':f'http://127.0.0.1:{probe_port}/mcp','auth':{'type':'bearer','token':probe_token}}
    if with_probe and args.production_mixed:
        backends['fixture_backend'].update(isolate_metadata=True,metadata_profile='bounded-v1')
    trial_id=str(len(logs))
    base=f'http://127.0.0.1:{gateway_port}';config={'server':{'public_url':base,'host':'127.0.0.1','port':gateway_port},'auth':{'encryption_key':key,'users':[{'username':'fixture','password':password}],'allowed_client_redirect_uris':['http://127.0.0.1:*/callback']},'storage':{'path':str(root/('gateway-'+trial_id+'.db'))},'backends':backends}
    cfg=root/('gateway-'+trial_id+'.yaml');cfg.write_text(yaml.safe_dump(config))
    loader=root/'gateway_loader.py';loader.write_text('import os\nfrom mcp_gateway.app import create_app\napp=create_app(os.environ["WO10_CONFIG"])\n')
    if args.schema_scope_proposal:
        loader.write_text('import os,sys\nsys.path.insert(0,'+repr(str(repo/'tests'))+')\nimport mcp_gateway.app as assembly\nfrom routing_schema_proposal import proposed_gateway\noriginal=assembly.build_gateway\nassembly.build_gateway=lambda *args: proposed_gateway(original,*args)\napp=assembly.create_app(os.environ["WO10_CONFIG"])\n')
    e=env();e['PYTHONPATH']=str(root)+os.pathsep+str(source/'src');e['WO10_CONFIG']=str(cfg)
    gateway=launch('gateway',[sys.executable,'-m','uvicorn','gateway_loader:app','--host','127.0.0.1','--port',str(gateway_port),'--log-level','warning'],e)
    await ready(base+'/.well-known/oauth-authorization-server',gateway);stage='oauth';access=await auth(base,password)
    transport=StreamableHttpTransport(base+'/mcp',headers={'Authorization':'Bearer '+access,'X-WO10-Canary':'must-not-forward'})
    stage='namespaces'
    async with Client(transport,timeout=20,init_timeout=10) as client:
        if not cold:
            tools={t.name for t in await client.list_tools()};assert 'fixture_node_invoke_read' in tools
            r=facts(await client.call_tool_mcp('fixture_node_invoke_read',{'capability':'node_status','args':{}}));assert r['server_version']=='2.5.1';report('generic backend remains reachable through exact configured namespace')
        if args.strict_matrix and not probe:
            for _ in range(5):
                start=time.monotonic();assert facts(await client.call_tool_mcp('fixture_node_invoke_read',{'capability':'node_status','args':{}}))['server_version']=='2.5.1';baseline.append(time.monotonic()-start)
            print(json.dumps({'healthy_baseline_seconds':baseline,'healthy_limit_seconds':max(.75,5*max(baseline))}),flush=True)
            if args.production_mixed:
                control=await client.call_tool_mcp('fixture_node_invoke_read',{'capability':'node_status','args':{}},meta={'fastmcp':{'version':'1'}})
                stock_version_error=control.is_error
                print(json.dumps({'stock_version_metadata_control_error':stock_version_error}),flush=True)
        if probe and not cold:
            assert 'fixture_backend_probe' in tools;result=facts(await client.call_tool_mcp('fixture_backend_probe',{}));assert result['marker']=='WO0010_OK' and result['expected_bearer_accepted'] and not result['caller_canary_seen'];report('second namespace read works; caller headers/token are not forwarded')
        await measure('cold_sibling_unavailable' if cold else 'two_backends' if probe else 'one_backend',[gateway,generic]+([probe] if probe and probe.poll() is None else []))
        if probe and args.strict_matrix:
            stage='strict-isolation-matrix';probe=await strict_outages(base,access,client,probe,launch_probe,probe_port,cold,probe_state,probe_events)
        elif probe:
            stage='failure-isolation';old_start=resource(probe)['start'];stop(probe);assert probe.poll() is not None
            async with Client(StreamableHttpTransport(f'http://127.0.0.1:{generic_port}/mcp',headers={'Authorization':'Bearer '+node_token}),timeout=10) as direct:
                assert facts(await direct.call_tool_mcp('invoke_read',{'capability':'node_status','args':{}}))['server_version']=='2.5.1'
            report('healthy backend direct control succeeds after second backend exit')
            async def observe(name,arguments):
                start=time.monotonic()
                try:
                    # Contain transport/exit errors in the entire observation.
                    # The same gateway/configuration is used; this is a fresh frontend session.
                    async with Client(StreamableHttpTransport(base+'/mcp',headers={'Authorization':'Bearer '+access}),timeout=20,init_timeout=10) as call_client:
                        r=await asyncio.wait_for(call_client.call_tool_mcp(name,arguments),22)
                        outcome='server_error' if r.is_error else 'success'
                        if name=='fixture_node_invoke_read' and outcome=='success':assert facts(r)['server_version']=='2.5.1'
                except (httpx.ReadTimeout,httpx2.ReadTimeout,asyncio.TimeoutError) as e:outcome=type(e).__name__
                except MCPError as e:
                    if e.code!=REQUEST_TIMEOUT:raise
                    outcome='MCP_REQUEST_TIMEOUT'
                item={'tool':name,'outcome':outcome,'elapsed_seconds':round(time.monotonic()-start,3)};isolation.append(item);print(json.dumps(item),flush=True);return outcome
            # Run healthy call alone first: a concurrent failed request is not needed.
            healthy=await observe('fixture_node_invoke_read',{'capability':'node_status','args':{}})
            if args.diagnostic_only:
                assert healthy in ['success','ReadTimeout','TimeoutError','MCP_REQUEST_TIMEOUT']
                report('diagnostic isolation outcome recorded; WO acceptance remains BLOCKED')
            else:assert healthy=='success', 'generic route interrupted by second backend outage'
            stage='probe-outage-read';bad=await observe('fixture_backend_probe',{});assert bad in ['server_error','ReadTimeout','TimeoutError','MCP_REQUEST_TIMEOUT']
            stage='status-after-outage'
            status=facts(await client.call_tool_mcp('gateway_status',{}));assert all(b['connected'] for b in status)
            report('gateway_status connected is auth-presence, not backend reachability')
            await ready(base+'/.well-known/oauth-authorization-server',gateway)
            stage='reconnect';probe=launch_probe();await ready(f'http://127.0.0.1:{probe_port}/healthz',probe)
            assert resource(probe)['start']!=old_start
            r=facts(await client.call_tool_mcp('fixture_backend_probe',{}));assert r['marker']=='WO0010_OK';report('exact fixture restart reconnects through the same configured backend')
            r=facts(await client.call_tool_mcp('fixture_node_invoke_read',{'capability':'node_status','args':{}}));assert r['server_version']=='2.5.1';report('generic route recovers after second backend restart')
    stop(gateway);stop(probe) if probe else None;stop(generic)
async def main():
    if args.strict_matrix and args.schema_scope_proposal:
        await proposal_negatives()
        from routing_proposal_tests import run_negatives
        extra=await run_negatives();matrix.extend(extra)
        for item in extra:print(json.dumps(item),flush=True)
    if not args.stock_compatibility_only:
        await trial(False)
        if args.strict_matrix:await trial(True,cold=True)
        await trial(True)
    if args.production_mixed:
        from types import SimpleNamespace
        from routing_stock_compatibility import run
        extra=await run(SimpleNamespace(root=root,repo=repo,source=source,node_exe=args.node_exe,port=port,env=env,launch=launch,ready=ready,auth=auth,stop=stop))
        matrix.extend(extra)
try:
    asyncio.run(main());assert all(p.poll() is not None for p in processes);report('all temporary fixture processes completed; no product code or persistent process added')
    result={'checks':checks,'resource':reports,'isolation':isolation,'matrix':matrix,'matrix_failed':sum(not x['pass'] for x in matrix),'prototype':args.schema_scope_proposal,'production_mixed':args.production_mixed,'wo_acceptance':'BLOCKED','diagnostic_only':args.diagnostic_only,'normal_central_e2e':'NOT_RUN','ssh_tunnel_seam':'NOT_RUN','permanent_process_delta':0}
    print(json.dumps(result),flush=True);(root/'result.json').write_text(json.dumps(result,indent=2));code=1 if result['matrix_failed'] else 0
except Exception as e:
    print('FAIL '+stage+' '+type(e).__module__+'.'+type(e).__name__,flush=True);(root/'failure.txt').write_text(type(e).__name__+': '+str(e));(root/'traceback.txt').write_text(traceback.format_exc());code=1
finally:
    cleanup_errors=[]
    for p in reversed(processes):
        try:stop(p)
        except Exception as e:cleanup_errors.append(type(e).__name__)
    for f in logs:f.close()
    if cleanup_errors:print('FAIL owned cleanup '+','.join(cleanup_errors),flush=True);code=1
    # Keep private logs/state for review; no user-data directory is deleted.
    print('PRIVATE_EVIDENCE retained only in an isolated temporary directory',file=sys.stderr)
sys.exit(code)
