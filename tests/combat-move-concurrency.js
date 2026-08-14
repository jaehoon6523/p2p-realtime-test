#!/usr/bin/env node
'use strict';
const fs=require('fs');
const path=require('path');
const vm=require('vm');
const root=path.resolve(__dirname,'..');
const input=fs.readFileSync(path.join(root,'js/ui/input.js'),'utf8');
const start=input.indexOf('function aimVectorFromWorld(');
const end=input.indexOf('\ncanvas.addEventListener',start);
if(start<0||end<0) throw new Error('ability input block not found');
const block=input.slice(start,end);
if(block.includes("if(ability.kind==='shoot') flushActiveMoveToNow")) throw new Error('shoot still flushes movement');
if(!block.includes("if(ability.kind==='dash')")) throw new Error('dash/movement separation missing');

let now=1000;
const activeMove={targetX:400,targetY:100};
const executed=[];
let flushCount=0;
const c={
  ABILITY_DEFINITIONS:{
    Q:{id:'basic_attack',key:'Q',kind:'shoot',cooldownMs:500,castMs:0,recoveryMs:200},
    E:{id:'dash',key:'E',kind:'dash',cooldownMs:3000,castMs:0,recoveryMs:200},
  },
  roomReady:true,
  performance:{now:()=>now},
  currentTick:()=>10,
  myId:'me',
  localAbilityReadyAt:new Map(),
  localAbilityLockUntil:0,
  lastAimWorld:{x:200,y:100},
  moveState:{me:activeMove},
  getPredictedTail:()=>({x:100,y:100,alive:true,lifeId:1,sequence:4}),
  flushActiveMoveToNow:()=>{ flushCount++; },
  makeShootCommand:(x,y,id)=>({type:'shoot',eventSeq:1,abilityId:id,aimX:x,aimY:y}),
  makeDashCommand:(x,y)=>({type:'dash',sequence:5,abilityId:'dash',dx:x,dy:y}),
  executeLocal:cmd=>executed.push(cmd),
  commandSequenceText:cmd=>cmd.type==='shoot'?`eventSeq=${cmd.eventSeq}`:`seq=${cmd.sequence}`,
  log:()=>{},
  setTimeout:fn=>fn(),
};
vm.createContext(c);
vm.runInContext(block+'\nthis.tryCastAbilityFn=tryCastAbility;',c);

c.tryCastAbilityFn('Q');
if(flushCount!==0) throw new Error(`Q flushed movement ${flushCount} time(s)`);
if(c.moveState.me!==activeMove) throw new Error('Q changed/cancelled active movement');
if(executed.length!==1||executed[0].type!=='shoot') throw new Error('Q did not issue shoot while moving');

// Dash is a simulation movement ability: it may replace the click-move plan.
now=2000;
c.localAbilityLockUntil=0;
c.localAbilityReadyAt.clear();
c.moveState.me=activeMove;
c.tryCastAbilityFn('E');
if(flushCount!==1) throw new Error('dash did not align movement before replacing it');
if(c.moveState.me) throw new Error('dash did not replace active movement plan');
if(executed.length!==2||executed[1].type!=='dash') throw new Error('dash command missing');
console.log('PSSF combat/movement concurrency: PASS');
