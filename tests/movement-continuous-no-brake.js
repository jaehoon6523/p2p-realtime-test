#!/usr/bin/env node
'use strict';
const fs=require('fs');
const path=require('path');
const vm=require('vm');
const root=path.resolve(__dirname,'..');
const sim=fs.readFileSync(path.join(root,'js/game/simulation.js'),'utf8');
const sb=sim.indexOf('const MOVE_COMMAND_CHUNK = BASE_MAX_STEP * 0.85;');
const se=sim.indexOf('\nfunction sampleLocalRender',sb);
if(sb<0||se<0) throw new Error('movement block not found');
const block=sim.slice(sb,se);
let now=1000;
const c={
  BASE_MAX_STEP:75,MOVE_DECEL:560,MOVE_ACCEL:620,MOVE_SPEED:220,
  MOVE_STEER_RATE:Math.PI*2.2,MOVE_RETARGET_BRAKE_GRACE_MS:320,MOVE_MAX_DURATION:8000,
  myId:'me',moveState:Object.create(null),localMoveVelocity:{vx:220,vy:0,lastStepAt:1000,cruiseSpeed:220,heading:0},
  performance:{now:()=>now},predicted:{x:500,y:300,alive:true,sequence:10},
  confirmedWorld:{me:{x:500,y:300,alive:true}},localCommandBackpressured:()=>false,traces:[]
};
c.getPredictedTail=()=>c.predicted;
c.clampWorldPoint=(x,y)=>({x,y});
c.tracePosition=(reason,opt)=>c.traces.push({reason,opt});
c.makeMoveCommand=(dx,dy)=>({dx,dy});
c.executeLocal=cmd=>{c.predicted={...c.predicted,x:c.predicted.x+cmd.dx,y:c.predicted.y+cmd.dy,sequence:c.predicted.sequence+1};};
vm.createContext(c);
vm.runInContext(block+'\nthis.startMoveFn=startMove;this.evalMoveFn=evalMove;',c);

// Active movement toward a near point. Retarget must not evaluate/brake the old destination.
c.moveState.me={startX:400,startY:300,targetX:520,targetY:300,retargetAt:700,hardStopAt:9000,lastWallAt:700};
const before={vx:c.localMoveVelocity.vx,vy:c.localMoveVelocity.vy};
now=1050;
c.startMoveFn('me',500,300,200,300);
if(Math.abs(c.localMoveVelocity.vx-before.vx)>1e-9||Math.abs(c.localMoveVelocity.vy-before.vy)>1e-9)
  throw new Error('retarget changed velocity immediately');

// If destination braking has already started but the plan is still active, a new click cancels that
// braking and restores the speed earned by this continuous movement chain.
c.moveState.me={startX:400,startY:300,targetX:520,targetY:300,retargetAt:100,hardStopAt:9000,lastWallAt:100};
c.predicted={...c.predicted,x:505,y:300};
c.localMoveVelocity.vx=220;c.localMoveVelocity.vy=0;c.localMoveVelocity.lastStepAt=1000;c.localMoveVelocity.cruiseSpeed=220;c.localMoveVelocity.heading=0;
now=1100;
const braked=c.evalMoveFn(c.moveState.me,now);
if(!(Math.hypot(braked.vx,braked.vy)<220)) throw new Error('test setup did not enter destination braking');
c.localMoveVelocity.vx=braked.vx;c.localMoveVelocity.vy=braked.vy;c.localMoveVelocity.lastStepAt=now; // cruiseSpeed intentionally remains 220
now=1110;
c.startMoveFn('me',505,300,200,300);
const restored=Math.hypot(c.localMoveVelocity.vx,c.localMoveVelocity.vy);
if(Math.abs(restored-220)>1e-6) throw new Error(`retarget inherited old-target braking: speed=${restored}`);

// During continuous-retarget grace, even a 180-degree turn preserves scalar speed.
now=1140;
let sample=c.evalMoveFn(c.moveState.me,now);
let speed=Math.hypot(sample.vx,sample.vy);
if(Math.abs(speed-220)>1e-6) throw new Error(`continuous retarget decelerated: speed=${speed}`);

// Retarget again before braking can arm. Click must still preserve the current committed speed.
c.localMoveVelocity.vx=sample.vx;c.localMoveVelocity.vy=sample.vy;c.localMoveVelocity.lastStepAt=now;
c.predicted={...c.predicted,x:495,y:300};
now=1200;
c.startMoveFn('me',495,300,495,600);
const speedAfterClick=Math.hypot(c.localMoveVelocity.vx,c.localMoveVelocity.vy);
if(Math.abs(speedAfterClick-220)>1e-6) throw new Error(`second retarget changed speed: ${speedAfterClick}`);
now=1290;
sample=c.evalMoveFn(c.moveState.me,now);
speed=Math.hypot(sample.vx,sample.vy);
if(Math.abs(speed-220)>1e-6) throw new Error(`second continuous retarget decelerated: speed=${speed}`);
console.log('PSSF continuous retarget no-brake: PASS');
