#!/usr/bin/env node
'use strict';
const fs=require('fs');
const path=require('path');
const vm=require('vm');
const root=path.resolve(__dirname,'..');
const cfg=fs.readFileSync(path.join(root,'js/core/config-state.js'),'utf8');
const sim=fs.readFileSync(path.join(root,'js/game/simulation.js'),'utf8');
if(!cfg.includes('const localMoveVelocity = {vx:0,vy:0')) throw new Error('persistent velocity state missing');
const sb=sim.indexOf('const MOVE_COMMAND_CHUNK = BASE_MAX_STEP * 0.85;');
const se=sim.indexOf('\nfunction sampleLocalRender',sb);
if(sb<0||se<0) throw new Error('movement velocity block not found');
const block=sim.slice(sb,se);
for(const required of ['readLocalMoveVelocity','writeLocalMoveVelocity','localMoveVelocity','clampVectorDelta','Trapezoidal integration']){
  if(!block.includes(required)) throw new Error(`persistent velocity contract missing: ${required}`);
}
if(block.includes('movement.vx')||block.includes('movement.vy')) throw new Error('destination plan still owns velocity');
let now=1000;
const c={
  BASE_MAX_STEP:75,MOVE_DECEL:560,MOVE_ACCEL:620,MOVE_SPEED:220,MOVE_MAX_DURATION:8000,
  myId:'me',moveState:Object.create(null),localMoveVelocity:{vx:220,vy:0,lastStepAt:1000},
  performance:{now:()=>now},predicted:{x:0,y:0,alive:true},confirmedWorld:{},localCommandBackpressured:()=>false
};
c.getPredictedTail=()=>c.predicted;c.clampWorldPoint=(x,y)=>({x,y});c.tracePosition=()=>{};c.makeMoveCommand=(dx,dy)=>({dx,dy});c.executeLocal=cmd=>{c.predicted={...c.predicted,x:c.predicted.x+cmd.dx,y:c.predicted.y+cmd.dy};};
vm.createContext(c);vm.runInContext(block+'\nthis.evalMoveFn=evalMove;this.commitMoveVelocityFn=commitMoveVelocity;',c);
const m={startX:0,startY:0,targetX:-500,targetY:0,hardStopAt:9000,lastWallAt:1000};c.moveState.me=m;
now=1090;const a=c.evalMoveFn(m,now);
if(a.vx>=220) throw new Error('180-degree turn did not begin decelerating/steering old velocity');
if(a.vx<220-620*.09-1e-6) throw new Error('180-degree turn exceeded vector acceleration budget');
if(Math.abs(a.vy)>1e-6) throw new Error('straight reverse invented lateral velocity');
// Persistence: commit one tick, next evaluation must start from the committed value, not the plan's creation speed.
c.commitMoveVelocityFn(a,now);
const committed=a.vx;
now=1180;const b=c.evalMoveFn(m,now);
if(Math.abs(c.localMoveVelocity.vx-committed)>1e-9) throw new Error('committed velocity state was not retained');
if(b.vx>=committed) throw new Error('second reverse tick restarted from an earlier speed');
console.log('PSSF movement velocity continuity: PASS');
