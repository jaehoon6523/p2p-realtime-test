#!/usr/bin/env node
'use strict';
const fs=require('fs');
const path=require('path');
const vm=require('vm');
const root=path.resolve(__dirname,'..');
const cfg=fs.readFileSync(path.join(root,'js/core/config-state.js'),'utf8');
const sim=fs.readFileSync(path.join(root,'js/game/simulation.js'),'utf8');

function constValue(name){
  const m=cfg.match(new RegExp(`const ${name} = ([^;]+);`));
  if(!m) throw new Error(`missing runtime constant ${name}`);
  return vm.runInNewContext(m[1],{Math});
}
const SNAPSHOT_HISTORY_TAIL_SEQUENCES=constValue('SNAPSHOT_HISTORY_TAIL_SEQUENCES');
const HISTORY_REPAIR_MAX_STATES=constValue('HISTORY_REPAIR_MAX_STATES');
if(!(SNAPSHOT_HISTORY_TAIL_SEQUENCES>0)) throw new Error('invalid snapshot history tail cap');
if(!(HISTORY_REPAIR_MAX_STATES>0)) throw new Error('invalid history repair cap');

const compactStart=sim.indexOf('function compactHistoryState(state){');
const importStart=sim.indexOf('\nfunction importHistoricalStates',compactStart);
const sendStart=sim.indexOf('function sendSnapshot(remoteId,{bootstrap=false}={}){');
const sendEnd=sim.indexOf('\nfunction sendCommandToPeer',sendStart);
if(compactStart<0||importStart<0||sendStart<0||sendEnd<0) throw new Error('bootstrap functions not found');

const c={
  SNAPSHOT_HISTORY_TAIL_SEQUENCES,HISTORY_REPAIR_MAX_STATES,
  PROTOCOL:13,RULESET_REVISION:'pssf-v13-r26',myId:'me',AUTO_MODE:false,
  simulationStateHistory:new Map(),confirmedWorld:Object.create(null),confirmedEventSeq:new Map(),
  bootstrapSentPeers:new Set(),bootstrapPendingSince:new Map(),
  performance:{now:()=>1234},currentTick:()=>99,
  round6:n=>Math.round(n*1e6)/1e6,
  simulationRefHash:s=>`ref-${s.sequence}`,
  stateHash:s=>`state-${s.sequence}`,
  isPeerOpen:id=>id==='peer',
  sent:[],logs:[],
};
c.sendWireNow=(id,message)=>{c.sent.push({id,message});return true;};
c.safeDataSend=(id,message)=>{c.sent.push({id,message});return true;};
c.log=(cls,msg)=>c.logs.push({cls,msg});
const state={x:10,y:20,sequence:3,tick:99,hp:3,alive:true,lifeId:1,deadServerAt:0};
c.confirmedWorld.me={...state};
c.simulationStateHistory.set('me',new Map([[2,[{...state,sequence:2}]],[3,[{...state}]]]));
vm.createContext(c);
vm.runInContext(sim.slice(compactStart,importStart)+
  '\n'+sim.slice(sendStart,sendEnd)+
  '\nthis.tail=()=>snapshotHistoryTail();this.sendBootstrap=()=>sendSnapshot("peer",{bootstrap:true});',c);

const tail=c.tail();
if(!Array.isArray(tail)||tail.length<2) throw new Error('snapshot history tail failed to build');
if(!c.sendBootstrap()) throw new Error('bootstrap snapshot send returned false');
const wire=c.sent.find(x=>x.message?.kind==='snapshot');
if(!wire) throw new Error('bootstrap snapshot was not emitted');
if(wire.message.snapshot.bootstrap!==true) throw new Error('bootstrap flag missing');
if(!Array.isArray(wire.message.snapshot.historyTail)) throw new Error('history tail missing from bootstrap snapshot');
if(!c.bootstrapSentPeers.has('peer')) throw new Error('bootstrap send state was not recorded');
console.log('PSSF bootstrap runtime state: PASS');
