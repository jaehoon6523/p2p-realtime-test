#!/usr/bin/env node
'use strict';
const fs=require('fs');
const path=require('path');
const vm=require('vm');
const root=path.join(__dirname,'..');
const sim=fs.readFileSync(path.join(root,'js/game/simulation.js'),'utf8');

for(const forbidden of ['movement.sampleX','movement.sampleY','movement.lastX','movement.lastY']){
  if(sim.includes(forbidden)) throw new Error(`second movement position cursor returned: ${forbidden}`);
}
if(!sim.includes('function emitMoveTowardAbsolute(movement,targetX,targetY)')) throw new Error('absolute movement emitter missing');
if(!sim.includes('const tailBefore=getPredictedTail(myId);')) throw new Error('tick movement is not based on predicted tail');
if(!sim.includes('Math.hypot(movement.targetX-tail.x,movement.targetY-tail.y)')) throw new Error('finish condition is not chain-tail based');

const begin=sim.indexOf('const MOVE_COMMAND_CHUNK = BASE_MAX_STEP * 0.85;');
const end=sim.indexOf('\nfunction flushActiveMoveToNow',begin);
if(begin<0||end<0) throw new Error('unable to isolate absolute movement emitter');
const snippet=sim.slice(begin,end);
const context={
  BASE_MAX_STEP:75,
  myId:'me',
  moveState:Object.create(null),
  localCommandBackpressured:()=>false,
  predicted:{x:0,y:0,alive:true},
  emitted:[],
};
context.getPredictedTail=()=>context.predicted;
context.makeMoveCommand=(dx,dy)=>({dx,dy});
context.executeLocal=(command)=>{
  context.emitted.push(Math.hypot(command.dx,command.dy));
  context.predicted={...context.predicted,x:context.predicted.x+command.dx,y:context.predicted.y+command.dy};
};
vm.createContext(context);
vm.runInContext(snippet+'\nthis.runEmit=(m,x,y)=>emitMoveTowardAbsolute(m,x,y);',context);
const movement={}; context.moveState.me=movement;
const result=context.runEmit(movement,200,0);
if(!result.ok||!result.reached) throw new Error('absolute emitter did not reach target');
if(Math.abs(context.predicted.x-200)>1e-6||Math.abs(context.predicted.y)>1e-6) throw new Error('absolute emitter ended at wrong position');
if(context.emitted.some(v=>v>75*0.85+1e-6)) throw new Error('movement chunk exceeds conservative max');
const before=context.emitted.length;
const second=context.runEmit(movement,200,0);
if(!second.reached||context.emitted.length!==before) throw new Error('reaching an already reached target emitted duplicate movement');


// Execute the real tickMovement body with a finished profile. It must retire the plan once,
// then a second tick must be a no-op with no duplicate movement commands.
const tickBegin=sim.indexOf('function tickMovement(){');
const tickEnd=sim.indexOf('\nfunction tickCombat(){',tickBegin);
if(tickBegin<0||tickEnd<0) throw new Error('unable to isolate tickMovement');
context.performance={now:()=>1000};
context.roomReady=true;
context.evalMove=(m)=>({x:m.targetX,y:m.targetY,speed:0,phase:'finished',finished:true});
context.tracePosition=()=>{};
context.queueLocalRenderTarget=()=>{};
vm.runInContext(sim.slice(tickBegin,tickEnd)+'\nthis.runTick=()=>tickMovement();',context);
context.predicted={x:0,y:0,alive:true};
context.emitted.length=0;
context.moveState.me={startX:0,startY:0,targetX:120,targetY:0,lastWallAt:1000,startTime:0,hardStopAt:2000};
context.runTick();
if(context.moveState.me) throw new Error('finished movement plan was not retired');
if(Math.abs(context.predicted.x-120)>1e-6) throw new Error('finished tick did not land on target');
const finishedCount=context.emitted.length;
context.runTick();
if(context.emitted.length!==finishedCount) throw new Error('finished movement emitted again on the next tick');

console.log('PSSF movement single-source: PASS');
