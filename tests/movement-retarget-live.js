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
if(block.includes('targetX:toX,targetY:toY,vx,vy')) throw new Error('retarget still assigns velocity into the destination plan');
if(block.includes('commitMoveVelocity(previousSample,now);')) throw new Error('retarget still evaluates old target and can brake during click');
if(!block.includes('writeLocalMoveVelocity(velocity.vx,velocity.vy,now);')) throw new Error('retarget does not preserve exact current velocity');
let now=1000;
const c={
  BASE_MAX_STEP:75,MOVE_DECEL:560,MOVE_ACCEL:620,MOVE_SPEED:220,MOVE_STEER_RATE:Math.PI*2.2,MOVE_RETARGET_BRAKE_GRACE_MS:320,MOVE_MAX_DURATION:8000,
  performance:{now:()=>now},myId:'me',moveState:Object.create(null),localMoveVelocity:{vx:220,vy:0,lastStepAt:1000},
  predicted:{x:100,y:100,alive:true},traces:[],confirmedWorld:{me:{x:100,y:100,alive:true}},localCommandBackpressured:()=>false,
};
c.getPredictedTail=()=>c.predicted;c.tracePosition=(reason,opt)=>c.traces.push({reason,opt});c.clampWorldPoint=(x,y)=>({x,y});c.makeMoveCommand=(dx,dy)=>({dx,dy});c.executeLocal=cmd=>{c.predicted={...c.predicted,x:c.predicted.x+cmd.dx,y:c.predicted.y+cmd.dy};};
vm.createContext(c);vm.runInContext(block+'\nthis.startMoveFn=startMove;this.evalMoveFn=evalMove;',c);
c.moveState.me={startX:0,startY:100,targetX:300,targetY:100,retargetAt:1000,hardStopAt:9000,lastWallAt:1000};
now=1100;
const savedBefore={vx:c.localMoveVelocity.vx,vy:c.localMoveVelocity.vy};
c.startMoveFn('me',100,100,100,300);
const m=c.moveState.me;if(!m) throw new Error('retarget deleted movement');
if('vx' in m||'vy' in m) throw new Error('retarget plan owns velocity');
if(Math.abs(m.targetX-100)>1e-9||Math.abs(m.targetY-300)>1e-9) throw new Error('new target was not armed');
if(Math.abs(c.localMoveVelocity.vx-savedBefore.vx)>1e-9||Math.abs(c.localMoveVelocity.vy-savedBefore.vy)>1e-9) throw new Error('click changed persistent velocity');
const savedSpeed=Math.hypot(c.localMoveVelocity.vx,c.localMoveVelocity.vy);
now=1190;const next=c.evalMoveFn(m,now);
const nextSpeed=Math.hypot(next.vx,next.vy);
if(Math.abs(nextSpeed-savedSpeed)>1e-6) throw new Error(`steering changed scalar speed during retarget grace: before=${savedSpeed} after=${nextSpeed}`);
const turn=Math.abs(Math.atan2(next.vy,next.vx)-Math.atan2(savedBefore.vy,savedBefore.vx));
if(turn>c.MOVE_STEER_RATE*.09+1e-6) throw new Error(`heading changed faster than steering budget: turn=${turn}`);
if(!c.traces.some(x=>x.reason==='retarget:armed')) throw new Error('retarget did not reach armed state');
console.log('PSSF movement live retarget: PASS');
