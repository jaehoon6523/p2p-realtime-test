#!/usr/bin/env node
'use strict';
const fs=require('fs');
const path=require('path');
const vm=require('vm');
const root=path.resolve(__dirname,'..');
const sim=fs.readFileSync(path.join(root,'js/game/simulation.js'),'utf8');
function extract(name){
  const start=sim.indexOf(`function ${name}`); if(start<0) throw new Error(`missing ${name}`);
  let i=sim.indexOf('{',start),depth=0;
  for(;i<sim.length;i++){
    if(sim[i]==='{') depth++;
    else if(sim[i]==='}'){ depth--; if(depth===0){i++;break;} }
  }
  return sim.slice(start,i);
}
const c={
  pageUnloading:false,roomReady:true,
  bootstrapSentPeers:new Set(['peer']),bootstrapPendingSince:new Map([['peer',0]]),
  directOpenPeerIds:()=>['peer'],performance:{now:()=>2000},calls:0,
  sendSnapshot:()=>{c.calls++;c.bootstrapSentPeers.add('peer');return true;},
};
vm.createContext(c);
vm.runInContext(extract('retryPendingBootstraps')+'\nthis.retry=retryPendingBootstraps;',c);
c.retry();
if(c.calls!==0) throw new Error('successful bootstrap was retried only because ACK was absent');
c.bootstrapSentPeers.clear();
c.retry();
if(c.calls!==1) throw new Error('unsent bootstrap was not retried');
console.log('PSSF bootstrap no-ACK spam: PASS');
