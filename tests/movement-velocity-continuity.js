#!/usr/bin/env node
'use strict';
const fs=require('fs');
const path=require('path');
const vm=require('vm');
const root=path.resolve(__dirname,'..');
const sim=fs.readFileSync(path.join(root,'js/game/simulation.js'),'utf8');
const sb=sim.indexOf('const MOVE_COMMAND_CHUNK = BASE_MAX_STEP * 0.85;');
const se=sim.indexOf('\nfunction sampleLocalRender',sb);
if(sb<0||se<0) throw new Error('movement velocity block not found');
const block=sim.slice(sb,se);
for(const required of ['movement.vx','movement.vy','clampVectorDelta','MOVE_INTEGRATION_MAX_DT_MS','Trapezoidal integration']){
  if(!block.includes(required)) throw new Error(`velocity-integrator contract missing: ${required}`);
}
if(block.includes('dirX:dx/distance')||block.includes('profile=buildMoveProfile')) throw new Error('direction/scalar profile still owns retarget motion');
let now=1000;
const c={BASE_MAX_STEP:75,MOVE_DECEL:560,MOVE_ACCEL:620,MOVE_SPEED:220,MOVE_MAX_DURATION:8000,myId:'me',moveState:Object.create(null),performance:{now:()=>now},predicted:{x:0,y:0,alive:true},confirmedWorld:{},localCommandBackpressured:()=>false};
c.getPredictedTail=()=>c.predicted;c.clampWorldPoint=(x,y)=>({x,y});c.tracePosition=()=>{};c.makeMoveCommand=(dx,dy)=>({dx,dy});c.executeLocal=cmd=>{c.predicted={...c.predicted,x:c.predicted.x+cmd.dx,y:c.predicted.y+cmd.dy};};
vm.createContext(c);vm.runInContext(block+'\nthis.evalMoveFn=evalMove;',c);
const m={startX:0,startY:0,targetX:-500,targetY:0,vx:220,vy:0,lastStepAt:1000,hardStopAt:9000,lastWallAt:1000};c.moveState.me=m;
now=1090;const a=c.evalMoveFn(m,now);
if(a.vx>=220) throw new Error('180-degree turn did not begin decelerating/steering old velocity');
if(a.vx<220-620*.09-1e-6) throw new Error('180-degree turn exceeded vector acceleration budget');
if(Math.abs(a.vy)>1e-6) throw new Error('straight reverse invented lateral velocity');
console.log('PSSF movement velocity continuity: PASS');
