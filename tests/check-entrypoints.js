'use strict';
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
let failed=false;
function assert(ok,msg){ if(!ok){ failed=true; console.error('FAIL:',msg); } else console.log('PASS:',msg); }
for(const file of ['p2p-mmo-demo-hardened.html','p2p-mmo-demo-auto.html']){
  const text=fs.readFileSync(path.join(root,file),'utf8');
  assert(!/<script\s+src=/i.test(text),`${file}: no external runtime script`);
  assert(text.includes('requestAnimationFrame(draw);'),`${file}: render loop starts`);
  assert(text.includes('const SIGNAL_PROTOCOL = 5;'),`${file}: signaling protocol 5`);
  assert(text.includes('const tickCheck=checkCommandTick(command.playerId,command.tick,previous.tick);'),`${file}: future tick validation wired`);
  assert(text.includes("const SERVER_ONLY_SIGNAL_TYPES = new Set(['joined','join-error','topology-update','membership-summary','verification-certificate','relay-error']);"),`${file}: forged server-control guard present`);
}
const launcher=fs.readFileSync(path.join(root,'p2p-mmo-auto-launcher.html'),'utf8');
assert(launcher.includes("const client=p.get('client')||'p2p-mmo-demo-auto.html';"),'launcher keeps p2p-mmo-demo-auto.html');
const server=fs.readFileSync(path.join(root,'mmo-server','signaling-server.js'),'utf8');
assert(server.includes("const PEER_RELAY_TYPES = new Set(['offer', 'answer', 'ice', 'wire']);"),'server peer relay allowlist present');
assert(server.includes('const SIGNAL_PROTOCOL = 5;'),'server signaling protocol 5');
if(failed) process.exit(1);
console.log('ALL ENTRYPOINT CHECKS PASS');
