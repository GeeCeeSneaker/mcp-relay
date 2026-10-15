// One disposable deterministic read tool. Never a resident Controller/proxy.
import { createServer } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFileSync, appendFileSync } from 'node:fs';
const require=createRequire(new URL('../node-runtime/package.json',import.meta.url));
const {Server,createMcpHandler}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/server')));
const {toNodeHandler}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/node')));
const token=process.env.WO10_PROBE_TOKEN;delete process.env.WO10_PROBE_TOKEN;
if(!token)throw new Error('fixture token required');
const hash=s=>createHash('sha256').update(s).digest();const expected=hash('Bearer '+token);
const context=new AsyncLocalStorage();
const statePath=process.env.WO10_PROBE_STATE;const eventsPath=process.env.WO10_PROBE_EVENTS;
delete process.env.WO10_PROBE_STATE;delete process.env.WO10_PROBE_EVENTS;
const event=kind=>{if(eventsPath)appendFileSync(eventsPath,JSON.stringify({kind})+'\n');};
const metadataStalled=()=>statePath&&readFileSync(statePath,'utf8')==='stall';
const handler=toNodeHandler(createMcpHandler(()=>{
 const server=new Server({name:'wo10-probe',version:'1'},{capabilities:{tools:{}}});
 server.setRequestHandler('tools/list',async()=>{
  if(metadataStalled()){
   event('metadata_started');const response=context.getStore().response;
   await new Promise(resolve=>{
    const finish=()=>{clearTimeout(timer);response.off('close',finish);event('metadata_closed');resolve();};
    const timer=setTimeout(finish,10000);response.once('close',finish);
   });
  }
  return{tools:[{name:'probe',description:'One deterministic disposable read',inputSchema:{type:'object',properties:{tag:{type:'string','x-mcp-header':'fixture-tag'}}},annotations:{readOnlyHint:true,idempotentHint:true,openWorldHint:false}}]};
 });
 server.setRequestHandler('tools/call',async r=>{
  if(r.params.name!=='probe')throw new Error('unknown fixture tool');
  if(r.params.arguments?.tag!==undefined&&typeof r.params.arguments.tag!=='string')throw new Error('invalid fixture tag');
  event('tool_executed');
  return{content:[{type:'text',text:JSON.stringify({marker:'WO0010_OK',backend:'fixture_probe',expected_bearer_accepted:true,caller_canary_seen:!!context.getStore()?.canary})}]};
 });return server;
}));
createServer(async(req,res)=>{
 if(req.url==='/healthz'){res.writeHead(200).end('ok');return;}
 if(req.url!=='/mcp'){res.writeHead(404).end();return;}
 if(!timingSafeEqual(hash(req.headers.authorization||''),expected)){res.writeHead(401).end('unauthorized');return;}
 res.setHeader('connection','close');
 await context.run({canary:req.headers['x-wo10-canary'],response:res},()=>handler(req,res));
}).listen(Number(process.argv[2]),'127.0.0.1');
