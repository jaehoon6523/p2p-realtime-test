#!/usr/bin/env node
'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const source=fs.readFileSync(path.join(__dirname,'..','js','core','disposition.js'),'utf8');
(async()=>{
  const ingested=[];
  const command={commandId:'actor:e2:simdep',playerId:'actor',type:'shoot',eventSeq:2,simulationRef:{sequence:7,stateHash:'h7'}};
  const context={
    console,Map,Set,Date,Math,JSON,String,Number,Object,Array,performance:{now:()=>1000},queueMicrotask,setTimeout,clearTimeout,
    deferredCommands:new Map([[command.commandId,{command,remote:true,code:'SIMULATION_REF_PENDING',reason:'wait s7',firstDeferredAt:900,lastDeferredAt:900}]]),
    temporalRetryTimers:new Map(),MAX_DEFERRED_PER_PLAYER:256,TEMPORAL_RETRY_MIN_MS:40,TEMPORAL_DEFER_MAX_MS:1600,
    commandStream:()=> 'event',commandSequenceText:()=> 'eventSeq=2',ingestCommand:(cmd,remote,opts)=>ingested.push({cmd,remote,opts}),
    log:()=>{},requestPeerResync:()=>{},confirmedWorld:{},confirmedSeq:new Map(),confirmedEventSeq:new Map(),myId:'me',
    isPeerOpen:()=>false,safeDataSend:()=>{},stateHash:()=>'',lastResyncRequestAt:new Map(),resyncCounter:0,
    prefixRepairState:new Map(),rebaseRequestState:new Map(),pendingOrderByPlayer:new Map(),pendingEventOrderByPlayer:new Map(),
    pendingById:new Map(),visibleWorld:{},simulationStateHistory:new Map(),seenCommandIds:new Set(),seenCommandFingerprintById:new Map(),
    seenCommandQueue:[],faultCounter:0,invalidCounter:0,ignoredCounter:0,duplicateCounter:0,deferredCounter:0,
    RULESET_REVISION:'pssf-v13-r29',PROTOCOL:13
  };
  vm.createContext(context);vm.runInContext(source,context,{filename:'disposition.js'});
  vm.runInContext("wakeSimulationReferenceDependencies('actor',6)",context);
  await new Promise(r=>setImmediate(r));
  if(ingested.length!==0) throw new Error('wrong simulation sequence woke dependency');
  vm.runInContext("wakeSimulationReferenceDependencies('actor',7)",context);
  await new Promise(r=>setImmediate(r));
  if(ingested.length!==1||!ingested[0].opts?.reentry) throw new Error('matching simulation ref did not wake deferred event');
  console.log('PSSF simulation ref wakeup: PASS');
})().catch(err=>{console.error(err);process.exit(1);});
