#!/usr/bin/env node
'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const source=fs.readFileSync(path.join(__dirname,'..','js','core','verification.js'),'utf8');
const logs=[],sent=[];
let signalReady=false;
const command={commandId:'actor:e1:test',playerId:'actor',assignmentId:'assign-1',eventSeq:1,type:'shoot'};
const context={
  console,Map,Set,Date,Math,JSON,String,Number,Object,Array,command,
  performance:{now:()=>1000},
  setInterval:()=>0,clearInterval:()=>{},setTimeout:()=>0,clearTimeout:()=>{},
  PROTOCOL:13,RULESET_REVISION:'pssf-v13-r25',AUTO_DEBUG:true,TEMPORAL_RETRY_MIN_MS:40,
  RULE_DISPOSITION:{ACCEPT:'ACCEPT',REJECT:'REJECT',DEFER:'DEFER',RESYNC:'RESYNC',FAULT:'FAULT'},
  pendingById:new Map([[command.commandId,{command,verdict:null}]]),
  evaluateCommand:(cmd,pending,opts)=>{
    if(!opts?.skipPolicyCheck) throw new Error('audit must bypass client policy cache');
    return {disposition:'ACCEPT',code:'SHOOT_VALID',reason:'ok',computed:{hit:null}};
  },
  commandFingerprint:()=> 'evidence-1',
  commandStream:()=> 'event',commandStreamSequence:()=>1,
  stableHash:()=> 'computed-1',
  scheduleNetem:(dir,peer,kind,fn)=>{fn();return true;},
  sendSignal(message){ if(!signalReady) return false; sent.push(message); return true; },
  log:(cls,msg)=>logs.push(`${cls}:${msg}`),
  validatorsFor:()=>['validator'],myId:'validator',
  requestPeerResync:()=>{},reportProtocolFault:()=>{},
  SIGNAL_PROTOCOL:5,
  orphanCertificates:new Map(),ignoredCounter:0,invalidCounter:0,
  drainEventCommits:()=>{},drainCommits:()=>{}
};
vm.createContext(context); vm.runInContext(source,context,{filename:'verification.js'});
vm.runInContext('runAudit(command)',context);
if(vm.runInContext('pendingVerificationReceipts.size',context)!==1) throw new Error('receipt should remain queued while signaling is unavailable');
signalReady=true;
vm.runInContext('flushPendingVerificationReceipts()',context);
if(vm.runInContext('pendingVerificationReceipts.size',context)!==0) throw new Error('receipt queue did not drain after signaling recovery');
if(sent.length!==1||sent[0].type!=='verification-receipt'||sent[0].receipt.commandId!==command.commandId) throw new Error('verification receipt not sent after retry');
if(!logs.some(x=>x.includes('AUDIT_RECEIPT_TX'))) throw new Error('receipt TX diagnostic missing');
console.log('PSSF audit receipt retry: PASS');
