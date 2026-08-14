#!/usr/bin/env node
'use strict';
const fs=require('fs');
const path=require('path');
const vm=require('vm');
const root=path.resolve(__dirname,'..');
const disposition=fs.readFileSync(path.join(root,'js/core/disposition.js'),'utf8');
const ruleset=fs.readFileSync(path.join(root,'js/game/ruleset.js'),'utf8');
const simulation=fs.readFileSync(path.join(root,'js/game/simulation.js'),'utf8');

function makeContext(){
  const c={
    console, performance:{now:()=>1000}, setTimeout:()=>0, clearTimeout:()=>{},
    confirmedAbilitySeq:new Map(), finalizedAbilityHistory:new Map(), pendingAbilityTerminals:new Map(),
    ABILITY_BY_ID:{
      basic_attack:{id:'basic_attack',kind:'shoot'},
      long_shot:{id:'long_shot',kind:'shoot'},
      dash:{id:'dash',kind:'dash'},
    },
    abilityTimingFor:(ability)=>({castTicks:ability.id==='basic_attack'?0:2,recoveryTicks:2,cooldownTicks:ability.id==='basic_attack'?5:20}),
    stableHash:(v)=>JSON.stringify(v),
  };
  vm.createContext(c);
  vm.runInContext(disposition,c);
  vm.runInContext(ruleset,c);
  return c;
}
function record(seq,id,cast,release){
  return {abilitySeq:seq,abilityId:id,castStartTick:cast,releaseTick:release,abilityHash:`h${seq}`,disposition:'ACCEPTED',commandId:`c${seq}`};
}
const actor=makeContext();
const history=new Map([
  [1,record(1,'basic_attack',0,0)],
  [2,record(2,'dash',10,12)],
  [3,record(3,'long_shot',20,22)],
  [4,record(4,'basic_attack',30,30)],
  [5,record(5,'dash',40,42)],
]);
actor.finalizedAbilityHistory.set('actor',history);
actor.confirmedAbilitySeq.set('actor',5);
const checkpoint=vm.runInContext("abilityCheckpointFor('actor')",actor);
if(checkpoint.confirmedAbilitySeq!==5||checkpoint.last?.abilitySeq!==5) throw new Error('actor checkpoint missing prefix head');
if(!checkpoint.lastByAbility.some(x=>x.abilityId==='basic_attack'&&x.abilitySeq===4)) throw new Error('same-ability checkpoint missing');

const validator=makeContext();
validator.checkpoint=checkpoint;
vm.runInContext("importAbilityCheckpoint('actor',checkpoint)",validator);
if(validator.confirmedAbilitySeq.get('actor')!==5) throw new Error('validator ability prefix not installed');
validator.command={
  playerId:'actor',abilitySeq:6,abilityId:'basic_attack',castStartTick:50,tick:50,
  previousAbilityRef:{abilitySeq:5,abilityId:'dash',castStartTick:40,releaseTick:42,abilityHash:'h5'},
  previousSameAbilityRef:{abilitySeq:4,abilityId:'basic_attack',castStartTick:30,releaseTick:30,abilityHash:'h4'},
};
const result=vm.runInContext('evaluateAbilityContract(command)',validator);
if(result.disposition!=='ACCEPT'||result.code!=='ABILITY_VALID') throw new Error(`next ability not validated after bootstrap: ${result.disposition}/${result.code}`);

if(!simulation.includes('abilityCheckpoint=abilityCheckpointFor(myId)')) throw new Error('snapshot does not export ability checkpoint');
if(!simulation.includes('importAbilityCheckpoint(remoteId,snapshot.abilityCheckpoint)')) throw new Error('snapshot does not import ability checkpoint');
console.log('PSSF ability bootstrap lineage: PASS');
