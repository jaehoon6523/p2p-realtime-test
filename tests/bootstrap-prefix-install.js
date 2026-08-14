#!/usr/bin/env node
'use strict';
const fs=require('fs');
const path=require('path');
const vm=require('vm');
const root=path.resolve(__dirname,'..');
const sim=fs.readFileSync(path.join(root,'js/game/simulation.js'),'utf8');
const disp=fs.readFileSync(path.join(root,'js/core/disposition.js'),'utf8');

function extract(src,name){
  const start=src.indexOf(`function ${name}(`);
  if(start<0) throw new Error(`${name} not found`);
  let i=src.indexOf('{',start),depth=0;
  for(;i<src.length;i++){
    if(src[i]==='{') depth++;
    else if(src[i]==='}') {depth--; if(depth===0){i++;break;}}
  }
  return src.slice(start,i);
}

const c={
  PROTOCOL:13,RULESET_REVISION:'pssf-v13-r29',MAX_HP:3,AUTO_MODE:false,
  confirmedWorld:Object.create(null),visibleWorld:Object.create(null),confirmedSeq:new Map(),confirmedEventSeq:new Map(),confirmedAbilitySeq:new Map(),
  simulationStateHistory:new Map(),tickAnchors:new Map(),activityAnchors:new Map(),relayWorld:new Map(),prefixRepairState:new Map(),
  performance:{now:()=>2000},logs:[],acked:false,rendered:false,
};
c.stateHash=s=>`h${s.sequence}`;
c.importHistoricalStates=()=>0;
c.importAbilityCheckpoint=(id,cp)=>{ if(cp?.confirmedAbilitySeq) c.confirmedAbilitySeq.set(id,cp.confirmedAbilitySeq); return cp?.confirmedAbilitySeq?1:0; };
c.acceptDeferred=()=>{};c.reconcileEventStreamFromSnapshot=()=>{};c.rememberSimulationState=()=>{};
c.queueRemoteRenderTarget=()=>{c.rendered=true;};c.sendInstalledBootstrapAck=()=>{c.acked=true;return true;};c.log=(k,m)=>c.logs.push(m);c.setTimeout=()=>{};
vm.createContext(c);
vm.runInContext([
  extract(disp,'prefixRepairSignature'),
  extract(disp,'noteAppliedPrefixRepair'),
  extract(sim,'receiveSnapshot'),
  'this.receiveSnapshot=receiveSnapshot;'
].join('\n'),c);

c.receiveSnapshot('peer',{
  protocol:13,rulesetRevision:'pssf-v13-r29',senderId:'peer',bootstrap:true,eventSequence:4,clockTick:20,
  abilityCheckpoint:{confirmedAbilitySeq:3},historyTail:[],
  state:{x:100,y:120,sequence:9,tick:20,hp:3,alive:true,lifeId:1,color:'#fff'}
});
if(c.confirmedSeq.get('peer')!==9||c.confirmedEventSeq.get('peer')!==4||c.confirmedAbilitySeq.get('peer')!==3) throw new Error('snapshot prefix did not install all stream heads');
if(c.prefixRepairState.get('peer')?.signature!=='9:h9:e4') throw new Error('prefix repair state was not recorded during real snapshot install');
if(!c.rendered||!c.acked) throw new Error('snapshot install did not reach render/ACK stage');
console.log('PSSF bootstrap prefix install: PASS');
