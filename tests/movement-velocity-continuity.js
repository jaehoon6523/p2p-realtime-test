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
for(const required of ['readLocalMoveVelocity','writeLocalMoveVelocity','localMoveVelocity','MOVE_STEER_RATE','Retargeting changes heading intent']){
  if(!block.includes(required)) throw new Error(`persistent velocity contract missing: ${required}`);
}
if(block.includes('movement.vx')||block.includes('movement.vy')) throw new Error('destination plan still owns velocity');
let now=1000;
const c={
  BASE_MAX_STEP:75,MOVE_DECEL:560,MOVE_ACCEL:620,MOVE_SPEED:220,MOVE_STEER_RATE:Math.PI*2.2,MOVE_RETARGET_BRAKE_GRACE_MS:320,MOVE_MAX_DURATION:8000,
  myId:'me',moveState:Object.create(null),localMoveVelocity:{vx:220,vy:0,lastStepAt:1000},
  performance:{now:()=>now},predicted:{x:0,y:0,alive:true},confirmedWorld:{},localCommandBackpressured:()=>false
};
c.getPredictedTail=()=>c.predicted;c.clampWorldPoint=(x,y)=>({x,y});c.tracePosition=()=>{};c.makeMoveCommand=(dx,dy)=>({dx,dy});c.executeLocal=cmd=>{c.predicted={...c.predicted,x:c.predicted.x+cmd.dx,y:c.predicted.y+cmd.dy};};
vm.createContext(c);vm.runInContext(block+'\nthis.evalMoveFn=evalMove;this.commitMoveVelocityFn=commitMoveVelocity;',c);
const m={startX:0,startY:0,targetX:-500,targetY:0,retargetAt:1000,hardStopAt:9000,lastWallAt:1000};c.moveState.me=m;
now=1090;const a=c.evalMoveFn(m,now);
const speedA=Math.hypot(a.vx,a.vy);
if(Math.abs(speedA-220)>1e-6) throw new Error(`180-degree steering reduced scalar speed: ${speedA}`);
const angleA=Math.abs(Math.atan2(a.vy,a.vx));
if(angleA>c.MOVE_STEER_RATE*.09+1e-6) throw new Error(`first turn exceeded steering budget: ${angleA}`);
// Persistence: commit one tick, next evaluation must start from the committed vector, not the plan's creation heading.
c.commitMoveVelocityFn(a,now);
const committed={vx:a.vx,vy:a.vy};
now=1180;const b=c.evalMoveFn(m,now);
if(Math.abs(c.localMoveVelocity.vx-committed.vx)>1e-9||Math.abs(c.localMoveVelocity.vy-committed.vy)>1e-9) throw new Error('committed velocity vector was not retained');
const speedB=Math.hypot(b.vx,b.vy);
if(Math.abs(speedB-220)>1e-6) throw new Error(`second steering tick reduced scalar speed: ${speedB}`);
console.log('PSSF movement velocity continuity: PASS');
