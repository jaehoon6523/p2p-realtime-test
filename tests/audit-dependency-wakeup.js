#!/usr/bin/env node
'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const source=fs.readFileSync(path.join(__dirname,'..','js','core','verification.js'),'utf8');

(async()=>{
  const sent=[],logs=[];
  let setTimeoutCalls=0;
  const command={commandId:'actor:e2:dep',playerId:'actor',assignmentId:'assign-1',eventSeq:2,type:'shoot',abilitySeq:2};
  const confirmedAbilitySeq=new Map([['actor',0]]);
  const context={
    console,Map,Set,Date,Math,JSON,String,Number,Object,Array,command,
    performance:{now:()=>1000},queueMicrotask,
    setInterval:()=>0,clearInterval:()=>{},
    setTimeout:(fn,ms)=>{ setTimeoutCalls++; return setTimeout(fn,ms); },clearTimeout,
    PROTOCOL:13,RULESET_REVISION:'pssf-v13-r29',AUTO_DEBUG:true,
    TEMPORAL_RETRY_MIN_MS:40,TEMPORAL_DEFER_MAX_MS:1600,
    RULE_DISPOSITION:{ACCEPT:'ACCEPT',REJECT:'REJECT',DEFER:'DEFER',RESYNC:'RESYNC',FAULT:'FAULT'},
    pendingById:new Map([[command.commandId,{command,verdict:null,remote:true}]]),
    confirmedAbilitySeq,
    abilityAuditWaiters:new Map(),abilityAuditWaiterByCommand:new Map(),auditWakeQueued:new Set(),
    evaluateCommand:()=> confirmedAbilitySeq.get('actor')>=1
      ? {disposition:'ACCEPT',code:'SHOOT_VALID',reason:'ready',computed:{ok:true}}
      : {disposition:'DEFER',code:'ABILITY_LINEAGE_PENDING',reason:'waiting a1',computed:{known:0}},
    commandFingerprint:()=> 'evidence-1',commandStream:()=> 'event',commandStreamSequence:()=>2,
    stableHash:v=>JSON.stringify(v),scheduleNetem:(dir,peer,kind,fn)=>{fn();return true;},
    sendSignal:message=>{ sent.push(message); return true; },log:(cls,msg)=>logs.push(`${cls}:${msg}`),
    validatorsFor:()=>['validator'],myId:'validator',requestPeerResync:()=>{},reportProtocolFault:()=>{},
    SIGNAL_PROTOCOL:5,orphanCertificates:new Map(),ignoredCounter:0,invalidCounter:0,
    drainEventCommits:()=>{},drainCommits:()=>{}
  };
  vm.createContext(context); vm.runInContext(source,context,{filename:'verification.js'});
  vm.runInContext('runAudit(pendingById.get(command.commandId).command)',context);
  if(sent.length!==1||sent[0].receipt.resultCode!=='ABILITY_LINEAGE_PENDING') throw new Error('initial dependency abstain missing');
  if(setTimeoutCalls!==0) throw new Error(`ability dependency incorrectly scheduled timer count=${setTimeoutCalls}`);
  // Even an accidental duplicate audit before the dependency changes must not spam the server.
  vm.runInContext('runAudit(pendingById.get(command.commandId).command)',context);
  if(sent.length!==1) throw new Error('duplicate unchanged receipt was retransmitted');
  confirmedAbilitySeq.set('actor',1);
  vm.runInContext("wakeAbilityAuditDependencies('actor')",context);
  await new Promise(resolve=>setImmediate(resolve));
  if(sent.length!==2||sent[1].receipt.decision!=='accept'||sent[1].receipt.resultCode!=='SHOOT_VALID') throw new Error('ability dependency wake did not re-audit to accept');
  if(!logs.some(x=>x.includes('AUDIT_WAIT'))) throw new Error('dependency wait diagnostic missing');
  console.log('PSSF audit dependency wakeup: PASS');
})().catch(err=>{console.error(err);process.exit(1);});
