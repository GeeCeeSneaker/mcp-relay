// Disposable TCP stand-in. NOT SSH, MCP, an installed service or a live route.
import net from 'node:net';
import fs from 'node:fs';
const [mode,readyPath,configPath]=process.argv.slice(2);
const connections=new Set();
const tracked=s=>{connections.add(s);s.on('close',()=>connections.delete(s));s.on('error',()=>s.destroy());return s;};
if(mode==='backend'){
 const server=net.createServer(s=>{tracked(s);s.end('OWNED_FIXTURE');});
 server.listen(0,'127.0.0.1',()=>fs.writeFileSync(readyPath,JSON.stringify({pid:process.pid,port:server.address().port})));
}else if(mode==='tunnel'){
 const plan=JSON.parse(fs.readFileSync(configPath,'utf8'));
 let open=0;
 for(const pair of plan){
  const server=net.createServer(incoming=>{
   const downstream=tracked(net.connect(pair.localPort,'127.0.0.1'));tracked(incoming);
   incoming.on('close',()=>downstream.destroy());downstream.on('close',()=>incoming.destroy());
   incoming.pipe(downstream).pipe(incoming);
  });
  server.on('error',()=>process.exit(2));
  server.listen(pair.remotePort,'127.0.0.1',()=>{if(++open===plan.length)fs.writeFileSync(readyPath,JSON.stringify({pid:process.pid}));});
 }
}else throw Error('Unknown owned fixture mode');
