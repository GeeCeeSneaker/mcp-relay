// WO-0009: exact identity/rate negatives and owned disposable native fixtures.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { sampleUsage, provenTree, processUsageCapabilities } from '../node-runtime/process-usage.mjs';
import { nativeUsageSnapshot } from '../node-runtime/process-usage-native.mjs';

// Exercise the actual /proc parser, error classification and identity scans on
// both runners; only filesystem bytes/units are deterministic, not snapshots.
function procCollector(read, pids = [10]) {
  let reads = 0;
  const stat = (pid, state = 'S') => {
    const f = Array(22).fill('0');
    Object.assign(f, { 0: state, 1: pid === 10 ? '0' : '10', 11: '100', 12: '0',
      19: pid === 10 ? '100' : '101', 21: '2' });
    return `${pid} (owned fixture) ${f.join(' ')}`;
  };
  const snapshot = nativeUsageSnapshot({ windows: false }, {
    procFs: {
      readdir: async p => { assert.equal(p, '/proc'); return pids.map(String); },
      readFile: async p => {
        const pid = Number(/^\/proc\/(\d+)\/stat$/.exec(p)?.[1]);
        assert(pids.includes(pid));
        const result = read(pid, ++reads);
        if (['EACCES', 'EPERM', 'ENOENT', 'ESRCH'].includes(result))
          throw Object.assign(new Error('fixture observation unavailable'), { code: result });
        return stat(pid, result);
      },
    },
    getUnits: async () => ({ hz: 100, page: 4096, boot: 'aabbccdd' }),
  });
  return { snapshot, count: () => reads };
}
const procSample = (snapshot, tree = false) => sampleUsage({ ref: '10@aabbccdd.100', interval_ms: 100, tree },
  { snapshot, wait: async () => {} });

test('collector rejects a persistently unreadable descendant instead of a complete root-only tree', async () => {
  for (const code of ['EACCES', 'EPERM']) {
    const c = procCollector(pid => pid === 11 ? code : 'S', [10, 11]);
    await assert.rejects(procSample(c.snapshot, true), { code: 'process_usage_unavailable' });
  }
});
test('collector root access loss in metrics or ending identity scans never proves exit', async () => {
  for (const code of ['EACCES', 'EPERM']) for (const lostAt of [2, 3, 4, 5, 6]) {
    const c = procCollector((pid, read) => read >= lostAt ? code : 'S');
    await assert.rejects(procSample(c.snapshot), { code: 'process_usage_unavailable' });
    assert.equal(c.count(), lostAt);
  }
});
test('collector preserves confirmed absence and zombie/dead root exit semantics', async () => {
  for (const fact of ['ENOENT', 'ESRCH', 'Z', 'X']) {
    const initial = procCollector(() => fact);
    await assert.rejects(procSample(initial.snapshot), { code: 'process_exited' });
    const later = procCollector((pid, read) => read >= 4 ? fact : 'S');
    const result = await procSample(later.snapshot);
    assert.equal(result.state, 'exited'); assert.equal(result.cpu_percent_one_core, null);
    assert.equal(result.rss_bytes, null); assert.equal(result.partial, true);
  }
});
test('collector unknown membership fails even when the unreadable pid could be unrelated', async () => {
  const c = procCollector(pid => pid === 11 ? 'EACCES' : 'S', [10, 11]);
  await assert.rejects(procSample(c.snapshot, true), { code: 'process_usage_unavailable' });
});

const row = (pid, start, cpu, time, ppid = 0, rss = 1024) => ({ pid, start, ppid,
  cpu_time_seconds: cpu, observed_monotonic_seconds: time, rss_bytes: rss });
const snap = (root, members = root ? [root] : [], partial = false) => ({ root, members, partial });
async function fake(a, b, args = {}) {
  let calls = 0;
  return sampleUsage({ ref: '10@100', interval_ms: 100, ...args }, {
    snapshot: async () => ++calls === 1 ? a : b, wait: async () => {}, date: () => 'fixture-time' });
}
test('exact rate uses measured time and one-core units, never host core count', async () => {
  const r = await fake(snap(row(10,'100',5,10)), snap(row(10,'100',7,12)));
  assert.equal(r.cpu_percent_one_core,100); assert.equal(r.cpu_delta_seconds,2); assert.equal(r.elapsed_seconds,2);
});
test('unknown/reversed counters and invalid clocks are null, never fabricated zero', async () => {
  for (const end of [row(10,'100',undefined,11),row(10,'100',4,11),row(10,'100',7,10)]) {
    const r=await fake(snap(row(10,'100',5,10)),snap(end)); assert.equal(r.cpu_percent_one_core,null); assert.equal(r.state,'unavailable');
  }
});
test('stale ref is rejected before waiting or attributing a reused PID', async () => {
  await assert.rejects(fake(snap(row(10,'101',0,1)),snap(row(10,'101',5,2))), { code:'identity_mismatch' });
});
test('PID reused mid-sample never contributes new process CPU/RSS', async () => {
  const r=await fake(snap(row(10,'100',5,10)),snap(row(10,'101',900,12)));
  assert.equal(r.state,'identity_mismatch');assert.equal(r.cpu_time_after_seconds,null);assert.equal(r.cpu_percent_one_core,null);assert.equal(r.rss_bytes,null);
});
test('mid-sample exit is explicit with no invented completed rate', async () => {
  const r=await fake(snap(row(10,'100',5,10)),snap(null));assert.equal(r.state,'exited');assert.equal(r.partial,true);assert.equal(r.cpu_delta_seconds,null);
});
test('tree proof excludes parent-PID reuse, different boot and unrelated rows', () => {
  const root=row(10,'aabbccdd.100',0,0);
  const rows=[root,row(11,'aabbccdd.101',0,0,10),row(12,'aabbccdd.102',0,0,11),
    row(13,'aabbccdd.99',0,0,10),row(14,'11223344.200',0,0,10),row(15,'aabbccdd.200',0,0,88)];
  assert.deepEqual(provenTree(rows,root).map(p=>p.pid),[10,11,12]);
  assert.throws(()=>provenTree(rows,root,1),{code:'too_large'});
});
test('stable multi-child tree exceeds one core; unrelated counters excluded', async () => {
  const a=[row(10,'100',1,1),row(11,'101',2,1,10),row(12,'102',3,1,10)];
  const b=[row(10,'100',1,2),row(11,'101',3,2,10),row(12,'102',4,2,10)];
  const r=await fake(snap(a[0],a),snap(b[0],b),{tree:true});assert.equal(r.tree.cpu_percent_one_core,200);assert.equal(r.tree.rss_bytes,3072);
});
test('child exit/new membership makes total tree unknown, known observations retained', async () => {
  const a=[row(10,'100',1,1),row(11,'101',2,1,10)];
  const b=[row(10,'100',2,2),row(12,'102',200,2,10)];
  const r=await fake(snap(a[0],a),snap(b[0],b),{tree:true});assert.equal(r.partial,true);assert.equal(r.tree.cpu_percent_one_core,null);
  assert.equal(r.tree.proven_observed_cpu_delta_seconds,1);assert.deepEqual(r.tree.unavailable_refs,['12@102']);
});
test('invalid intervals, weak refs, cancellation and request admission fail bounded', async () => {
  for(const args of [{ref:'10'},{ref:'0@100'},{ref:'10@unknown'},{interval_ms:0},{interval_ms:5001},{interval_ms:NaN},{tree:'true'}])
    await assert.rejects(fake(snap(row(10,'100',0,1)),snap(row(10,'100',0,2)),args),{code:'invalid_args'});
  const abort=new AbortController();abort.abort();
  await assert.rejects(sampleUsage({ref:'10@100',interval_ms:100},{snapshot:async()=>snap(row(10,'100',0,1))},abort.signal),{name:'AbortError'});
  const releases=[];const cap=processUsageCapabilities({snapshot:()=>new Promise(resolve=>releases.push(()=>resolve(snap(row(10,'100',0,1))))),
    fail:(code,message)=>{throw Object.assign(new Error(message),{code});},factsResult:x=>x}).tools.process_usage;
  const running=Array.from({length:4},()=>{const a=new AbortController();return {a,p:cap.run({ref:'10@100',interval_ms:100},a.signal).catch(e=>e.code)};});
  await assert.rejects(cap.run({ref:'10@100'},new AbortController().signal),{code:'busy'});
  for(const {a} of running)a.abort();for(const release of releases)release();assert.deepEqual(await Promise.all(running.map(r=>r.p)),['timeout','timeout','timeout','timeout']);
});

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
let root,server,client,url;const owned=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function call(capability,args,via='invoke_read') {
  const r=await client.callTool({name:via,arguments:{capability,args}});const text=r.content.map(c=>c.text||'').join('\n');
  let value=null;if(!r.isError){try{value=JSON.parse(text);}catch{value=text;}}
  return {error:!!r.isError,text,code:(/^Error \[(\w+)\]/.exec(text)||[])[1],value};
}
const good=r=>{assert.equal(r.error,false,r.text);return r.value;};
async function fixture(mode) {
  const p=spawn(process.execPath,[path.join(root,'fixture.mjs'),mode],{windowsHide:true,stdio:['ignore','pipe','ignore']});owned.push(p);
  const ready=await new Promise((resolve,reject)=>{let s='';const timer=setTimeout(()=>reject(new Error('owned fixture not ready')),5000);
    p.stdout.on('data',b=>{s+=b;const i=s.indexOf('\n');if(i>=0){clearTimeout(timer);resolve(JSON.parse(s.slice(0,i)));}});p.once('error',reject);});
  p.exactRef=good(await call('process_info',{pid:p.pid})).ref;
  return {p,...ready};
}
before(async()=>{
  root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mcprelay-wo9-')));
  await fs.writeFile(path.join(root,'fixture.mjs'),`import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';
const mode=process.argv[2];const children=[];
if(mode==='tree')for(let i=0;i<2;i++)children.push(spawn(process.execPath,[fileURLToPath(import.meta.url),'busy'],{windowsHide:true,stdio:'ignore'}));
console.log(JSON.stringify({pid:process.pid,children:children.map(p=>p.pid)}));
if(mode==='busy'){let x=0;const deadline=Date.now()+60000;while(Date.now()<deadline)for(let i=0;i<1000;i++)x=Math.sqrt(x+1);process.exit(0);}else {setInterval(()=>{},1000);setTimeout(()=>process.exit(0),120000);}
`);
  const lease=net.createServer();await new Promise(r=>lease.listen(0,'127.0.0.1',r));const port=lease.address().port;await new Promise(r=>lease.close(r));
  const token=randomBytes(32).toString('hex');url=`http://127.0.0.1:${port}/mcp`;
  server=spawn(process.execPath,[path.join(repo,'node-runtime/server.mjs'),'--port',String(port)],{windowsHide:true,stdio:'ignore',
    env:{...process.env,MCPRELAY_ALLOWED_DIRS:root,MCPRELAY_BRIDGE_TOKEN:token,MCPRELAY_TARGETS:path.join(root,'targets.json'),MCPRELAY_AUDIT_LOG:path.join(root,'audit','audit.log')}});
  let ready=false;for(let i=0;i<100;i++){try{if((await fetch(url.replace('/mcp','/healthz'))).ok){ready=true;break;}}catch{}await sleep(100);}assert(ready,'disposable server startup');
  client=new Client({name:'wo9-test',version:'1'},{versionNegotiation:{mode:{pin:'2026-07-28'}}});
  await client.connect(new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
});
after(async()=>{
  const cleanupErrors=[];
  for(const p of owned)if(p.exitCode===null&&p.signalCode===null){
    const ended=new Promise(r=>p.once('close',r));
    try {
      if(p.exactRef){const r=await call('stop_process',{ref:p.exactRef,graceful:'none',force:true,tree:true},'invoke_destructive');
        if(r.error&&!['not_found','process_exited'].includes(r.code))throw new Error(r.text);
      }else p.kill('SIGKILL');
      await Promise.race([ended,sleep(4000).then(()=>{if(p.exitCode===null&&p.signalCode===null)throw new Error('owned fixture cleanup timed out');})]);
    }catch(e){cleanupErrors.push(e);}
  }
  await client?.close();
  if(server?.exitCode===null){const ended=new Promise(r=>server.once('close',r));server.kill();await ended;}
  if(root){assert.equal(path.dirname(await fs.realpath(root)),await fs.realpath(os.tmpdir()));assert(path.basename(root).startsWith('mcprelay-wo9-'));await fs.rm(root,{recursive:true,force:true});}
  if(cleanupErrors.length)throw new AggregateError(cleanupErrors,'owned fixture cleanup failed');
});
test('native owned idle/busy samples: stable identity, RSS and one-core saturation',async()=>{
  const idle=await fixture('idle');const idleRef=idle.p.exactRef;
  const i=good(await call('process_usage',{ref:idleRef,interval_ms:1000}));assert.equal(i.state,'sampled');assert(i.cpu_percent_one_core<20);assert(i.rss_bytes>0);
  const busy=await fixture('busy');const busyRef=busy.p.exactRef;
  const b=good(await call('process_usage',{ref:busyRef,interval_ms:2000}));assert.equal(b.state,'sampled');assert(b.cpu_percent_one_core>40&&b.cpu_percent_one_core<140,JSON.stringify(b));
  console.log(JSON.stringify({owned_idle_cpu_one_core:i.cpu_percent_one_core,owned_busy_cpu_one_core:b.cpu_percent_one_core,rss_available:b.rss_bytes>0}));
  busy.p.kill('SIGKILL');await new Promise(r=>busy.p.once('close',r));
});
test('native multi-child tree proves membership and excludes an unrelated owned process',async()=>{
  const tree=await fixture('tree');
  const unrelated=await fixture('idle');const ref=tree.p.exactRef;
  const unrelatedRef=unrelated.p.exactRef;
  const r=good(await call('process_usage',{ref,tree:true,interval_ms:1500}));assert.equal(r.partial,false,JSON.stringify(r));assert(r.descendant_count>=2);assert(r.tree.cpu_percent_one_core>40);
  assert(!r.tree.sampled_refs.includes(unrelatedRef));for(const pid of tree.children)assert(r.tree.sampled_refs.some(s=>s.startsWith(pid+'@')));
  // Close exact test-owned children through the existing identity-checked stop;
  // this is fixture cleanup, never part of process_usage.
  for(const pid of tree.children){const childRef=good(await call('process_info',{pid})).ref;good(await call('stop_process',{ref:childRef,graceful:'none',force:true,tree:false},'invoke_destructive'));}
});
test('native stale reference and root exit mid-sample are honest',async()=>{
  const f=await fixture('idle');const ref=f.p.exactRef;
  const bad=await call('process_usage',{ref:ref+'1',interval_ms:100});assert.equal(bad.error,true);assert.equal(bad.code,'identity_mismatch');
  const pending=call('process_usage',{ref,interval_ms:3000});await sleep(1500);f.p.kill('SIGKILL');const r=good(await pending);assert.equal(r.state,'exited');assert.equal(r.cpu_percent_one_core,null);
});
test('native child exit makes tree aggregate partial while root attribution remains exact',async()=>{
  const tree=await fixture('tree');const childRef=good(await call('process_info',{pid:tree.children[0]})).ref;
  const pending=call('process_usage',{ref:tree.p.exactRef,tree:true,interval_ms:3000});await sleep(1500);
  good(await call('stop_process',{ref:childRef,graceful:'none',force:true,tree:false},'invoke_destructive'));
  const r=good(await pending);assert.equal(r.state,'sampled');assert.equal(r.partial,true);assert.equal(r.tree.cpu_percent_one_core,null);
  assert(!r.tree.sampled_refs.includes(childRef));
});
test('repeated native calls and cancellation leave no helper; class boundary stays read',async()=>{
  const f=await fixture('idle');const ref=f.p.exactRef;
  for(let i=0;i<4;i++)assert.equal(good(await call('process_usage',{ref,interval_ms:100})).state,'sampled');
  const cat=JSON.parse((await client.callTool({name:'list_capabilities',arguments:{}})).content[0].text);
  assert.equal(cat.capabilities.find(c=>c.name==='process_usage').class,'read');assert.equal((await call('process_usage',{ref},'invoke_exec')).code,'wrong_class');
  const procs=good(await call('list_processes',{name:'mcprelay-proc',limit:500}));
  assert(!(Array.isArray(procs)?procs:[]).some(p=>p.parent_pid===server.pid),'no helper after completed observations');
});
