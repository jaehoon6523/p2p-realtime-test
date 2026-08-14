#!/usr/bin/env node
'use strict';
const fs=require('fs');
const path=require('path');
const vm=require('vm');
const root=path.resolve(__dirname,'..');
const sim=fs.readFileSync(path.join(root,'js/game/simulation.js'),'utf8');
const start=sim.indexOf('function receiveSnapshot(remoteId,snapshot){');
const end=sim.indexOf('\n}',start);
if(start<0) throw new Error('receiveSnapshot not found');
// Extract by brace counting.
let depth=0, pos=sim.indexOf('{',start), i=pos;
for(;i<sim.length;i++){
  if(sim[i]==='{') depth++;
  else if(sim[i]==='}'){ depth--; if(depth===0){i++;break;} }
}
const fn=sim.slice(start,i);
const c={
 PROTOCOL:13,RULESET_REVISION:'pssf-v13-r26',MAX_HP:3,AUTO_MODE:false,
 confirmedWorld:Object.create(null),visibleWorld:Object.create(null),
 confirmedSeq:new Map(),confirmedEventSeq:new Map(),tickAnchors:new Map(),activityAnchors:new Map(),
 relayWorld:new Map(),performance:{now:()=>2000},rendered:null,acked:false,logs:[],
};
c.importHistoricalStates=()=>0;c.acceptDeferred=()=>{};c.reconcileEventStreamFromSnapshot=()=>{};
c.rememberSimulationState=()=>{};c.noteAppliedPrefixRepair=()=>{};
c.queueRemoteRenderTarget=(id,state,opt)=>{c.rendered={id,state,opt};};
c.stateHash=()=> 'hash';c.sendInstalledBootstrapAck=()=>{c.acked=true;return true;};
c.log=(cls,msg)=>c.logs.push({cls,msg});c.setTimeout=()=>{};
vm.createContext(c);
vm.runInContext(fn+'\nthis.receive=receiveSnapshot;',c);
c.receive('peer',{protocol:13,rulesetRevision:'pssf-v13-r26',senderId:'peer',clockTick:12,eventSequence:0,
 state:{x:100,y:200,sequence:4,tick:12,hp:3,alive:true,lifeId:1,color:'#fff'},historyTail:[],bootstrap:true});
if(!c.confirmedWorld.peer||!c.visibleWorld.peer) throw new Error('remote snapshot did not install world state');
if(!c.rendered||c.rendered.id!=='peer'||c.rendered.opt?.snap!==true) throw new Error('remote render target was not initialized');
if(!c.acked) throw new Error('bootstrap snapshot was not ACKed after install');
console.log('PSSF remote bootstrap render: PASS');
