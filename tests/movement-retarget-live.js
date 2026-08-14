#!/usr/bin/env node
'use strict';
const fs=require('fs');
const path=require('path');
const vm=require('vm');
const root=path.resolve(__dirname,'..');
const sim=fs.readFileSync(path.join(root,'js/game/simulation.js'),'utf8');
const sb=sim.indexOf('function buildMoveProfile(');
const se=sim.indexOf('\nfunction rebaseLocalMovementAfterRejection',sb);
if(sb<0||se<0) throw new Error('movement planning block not found');
const block=sim.slice(sb,se);
const startBody=block.slice(block.indexOf('function startMove('));
if(startBody.includes('flushActiveMoveToNow(now)')) throw new Error('retarget still flushes the old movement plan');
const c={
  MOVE_DECEL:520,MOVE_ACCEL:700,MOVE_SPEED:220,MOVE_MAX_DURATION:8000,MOVE_FINISH_EPSILON:0.05,BASE_MAX_STEP:75,
  performance:{now:()=>1000},myId:'me',moveState:Object.create(null),
  predicted:{x:100,y:100,alive:true},traces:[],
};
c.getPredictedTail=()=>c.predicted;
c.tracePosition=(reason,opt)=>c.traces.push({reason,opt});
vm.createContext(c);
vm.runInContext(block+'\nthis.startMoveFn=startMove;',c);
// Existing move is active toward the right. Retarget must arm immediately toward a new point.
c.moveState.me={startX:0,startY:100,targetX:300,targetY:100,dirX:1,dirY:0,distance:300,startTime:0,hardStopAt:999999,lastWallAt:900,profile:{startSpeed:100,peakSpeed:220,accelTime:1,cruiseTime:2,decelTime:1,accelDistance:160,cruiseDistance:100,decel:520,totalTime:4}};
c.startMoveFn('me',100,100,100,300);
const m=c.moveState.me;
if(!m) throw new Error('retarget deleted movement');
if(Math.abs(m.startX-100)>1e-9||Math.abs(m.startY-100)>1e-9) throw new Error('retarget did not start from predicted tail');
if(Math.abs(m.targetX-100)>1e-9||Math.abs(m.targetY-300)>1e-9) throw new Error('new target was not armed immediately');
if(!c.traces.some(x=>x.reason==='retarget:armed')) throw new Error('retarget did not reach armed state');
console.log('PSSF movement live retarget: PASS');
