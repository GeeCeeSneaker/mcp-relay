"""WO-0010 isolated OAuth gateway composition; never central/tunnel E2E."""
import argparse, asyncio, base64, ctypes, hashlib, json, os, pathlib, secrets, shutil, socket, subprocess, sys, tempfile, time, traceback
from urllib.parse import parse_qs, urlencode, urlparse
import httpx, httpx2, yaml
from fastmcp import Client
from fastmcp.client.transports import StreamableHttpTransport
from mcp.shared.exceptions import MCPError
from mcp_types import REQUEST_TIMEOUT

ap=argparse.ArgumentParser();ap.add_argument('--gateway-source',required=True);ap.add_argument('--node-exe',default=shutil.which('node'));ap.add_argument('--sample-seconds',type=float,default=30);ap.add_argument('--diagnostic-only',action='store_true',help='Collect isolation outcomes even on the known timeout; never acceptance');args=ap.parse_args()
if not args.node_exe or not 1<=args.sample_seconds<=60:raise SystemExit('node executable and 1..60 second sample required')
repo=pathlib.Path(__file__).resolve().parents[1];source=pathlib.Path(args.gateway_source).resolve()
root=pathlib.Path(tempfile.mkdtemp(prefix='mcprelay-wo10-')).resolve();processes=[];logs=[];reports=[];stage='prepare';checks=0;isolation=[]

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
async def trial(with_probe):
    global stage
    stage='startup';generic_port,probe_port,gateway_port=port(),port(),port();node_token,probe_token,password,key=(secrets.token_hex(32) for _ in range(4))
    e=env();e.update(MCPRELAY_BRIDGE_TOKEN=node_token,MCPRELAY_ALLOWED_DIRS=str(root),MCPRELAY_TARGETS=str(root/'targets.json'),MCPRELAY_AUDIT_LOG=str(root/'audit'/'audit.log'))
    generic=launch('generic',[args.node_exe,str(repo/'node-runtime/server.mjs'),'--port',str(generic_port)],e)
    await ready(f'http://127.0.0.1:{generic_port}/healthz',generic)
    def launch_probe():
        e=env();e['WO10_PROBE_TOKEN']=probe_token
        return launch('probe',[args.node_exe,str(repo/'tests/routing-probe.mjs'),str(probe_port)],e)
    probe=launch_probe() if with_probe else None
    if probe:await ready(f'http://127.0.0.1:{probe_port}/healthz',probe)
    if probe:
        async with Client(StreamableHttpTransport(f'http://127.0.0.1:{probe_port}/mcp',headers={'Authorization':'Bearer '+probe_token,'X-WO10-Canary':'positive-control'}),timeout=10) as direct:
            assert facts(await direct.call_tool_mcp('probe',{}))['caller_canary_seen']
        report('header detector positive control sees a direct caller canary')
    backends={'fixture_node':{'url':f'http://127.0.0.1:{generic_port}/mcp','auth':{'type':'bearer','token':node_token}}}
    if with_probe:backends['fixture_backend']={'url':f'http://127.0.0.1:{probe_port}/mcp','auth':{'type':'bearer','token':probe_token}}
    base=f'http://127.0.0.1:{gateway_port}';config={'server':{'public_url':base,'host':'127.0.0.1','port':gateway_port},'auth':{'encryption_key':key,'users':[{'username':'fixture','password':password}],'allowed_client_redirect_uris':['http://127.0.0.1:*/callback']},'storage':{'path':str(root/('gateway-'+str(with_probe)+'.db'))},'backends':backends}
    cfg=root/('gateway-'+str(with_probe)+'.yaml');cfg.write_text(yaml.safe_dump(config))
    loader=root/'gateway_loader.py';loader.write_text('import os\nfrom mcp_gateway.app import create_app\napp=create_app(os.environ["WO10_CONFIG"])\n')
    e=env();e['PYTHONPATH']=str(root)+os.pathsep+str(source/'src');e['WO10_CONFIG']=str(cfg)
    gateway=launch('gateway',[sys.executable,'-m','uvicorn','gateway_loader:app','--host','127.0.0.1','--port',str(gateway_port),'--log-level','warning'],e)
    await ready(base+'/.well-known/oauth-authorization-server',gateway);stage='oauth';access=await auth(base,password)
    transport=StreamableHttpTransport(base+'/mcp',headers={'Authorization':'Bearer '+access,'X-WO10-Canary':'must-not-forward'})
    stage='namespaces'
    async with Client(transport,timeout=20,init_timeout=10) as client:
        tools={t.name for t in await client.list_tools()};assert 'fixture_node_invoke_read' in tools
        r=facts(await client.call_tool_mcp('fixture_node_invoke_read',{'capability':'node_status','args':{}}));assert r['server_version']=='2.5.1';report('generic backend remains reachable through exact configured namespace')
        if probe:
            assert 'fixture_backend_probe' in tools;result=facts(await client.call_tool_mcp('fixture_backend_probe',{}));assert result['marker']=='WO0010_OK' and result['expected_bearer_accepted'] and not result['caller_canary_seen'];report('second namespace read works; caller headers/token are not forwarded')
        await measure('two_backends' if probe else 'one_backend',[gateway,generic]+([probe] if probe else []))
        if probe:
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
    await trial(False);await trial(True)
try:
    asyncio.run(main());assert all(p.poll() is not None for p in processes);report('all temporary fixture processes completed; no product code or persistent process added')
    result={'checks':checks,'resource':reports,'isolation':isolation,'wo_acceptance':'BLOCKED','diagnostic_only':args.diagnostic_only,'normal_central_e2e':'NOT_RUN','ssh_tunnel_seam':'NOT_RUN','permanent_process_delta':0}
    print(json.dumps(result),flush=True);(root/'result.json').write_text(json.dumps(result,indent=2));code=0
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
