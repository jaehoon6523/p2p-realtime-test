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
if(!block.includes('commitMoveVelocity(previousSample,now);')) throw new Error('retarget does not preserve persistent instantaneous velocity');
let now=1000;
const c={
  BASE_MAX_STEP:75,MOVE_DECEL:560,MOVE_ACCEL:620,MOVE_SPEED:220,MOVE_MAX_DURATION:8000,
  performance:{now:()=>now},myId:'me',moveState:Object.create(null),localMoveVelocity:{vx:220,vy:0,lastStepAt:1000},
  predicted:{x:100,y:100,alive:true},traces:[],confirmedWorld:{me:{x:100,y:100,alive:true}},localCommandBackpressured:()=>false,
};
c.getPredictedTail=()=>c.predicted;c.tracePosition=(reason,opt)=>c.traces.push({reason,opt});c.clampWorldPoint=(x,y)=>({x,y});c.makeMoveCommand=(dx,dy)=>({dx,dy});c.executeLocal=cmd=>{c.predicted={...c.predicted,x:c.predicted.x+cmd.dx,y:c.predicted.y+cmd.dy};};
vm.createContext(c);vm.runInContext(block+'\nthis.startMoveFn=startMove;this.evalMoveFn=evalMove;',c);
c.moveState.me={startX:0,startY:100,targetX:300,targetY:100,hardStopAt:9000,lastWallAt:1000};
now=1100;
const before=c.evalMoveFn(c.moveState.me,now);
c.startMoveFn('me',100,100,100,300);
const m=c.moveState.me;if(!m) throw new Error('retarget deleted movement');
if('vx' in m||'vy' in m) throw new Error('retarget plan owns velocity');
if(Math.abs(m.targetX-100)>1e-9||Math.abs(m.targetY-300)>1e-9) throw new Error('new target was not armed');
if(Math.abs(c.localMoveVelocity.vx-before.vx)>1e-6||Math.abs(c.localMoveVelocity.vy-before.vy)>1e-6) throw new Error('retarget reset/reassigned persistent velocity');
const saved={vx:c.localMoveVelocity.vx,vy:c.localMoveVelocity.vy};
now=1190;const next=c.evalMoveFn(m,now);const dv=Math.hypot(next.vx-saved.vx,next.vy-saved.vy);
if(dv>620*.09+1e-6) throw new Error(`velocity changed faster than acceleration budget: dv=${dv}`);
if(!c.traces.some(x=>x.reason==='retarget:armed')) throw new Error('retarget did not reach armed state');
console.log('PSSF movement live retarget: PASS');
