#!/usr/bin/env node
'use strict';
const fs=require('fs');
const path=require('path');
const vm=require('vm');
const root=path.resolve(__dirname,'..');
const sim=fs.readFileSync(path.join(root,'js/game/simulation.js'),'utf8');
const sb=sim.indexOf('const MOVE_COMMAND_CHUNK = BASE_MAX_STEP * 0.85;');
const se=sim.indexOf('\nfunction sampleLocalRender',sb);
const tb=sim.indexOf('function tickMovement(){');
const te=sim.indexOf('\nfunction tickCombat(){',tb);
if(sb<0||se<0||tb<0||te<0) throw new Error('movement blocks not found');
const block=sim.slice(sb,se)+'\n'+sim.slice(tb,te);
let now=1000;
const c={
  BASE_MAX_STEP:75,MOVE_DECEL:560,MOVE_ACCEL:620,MOVE_SPEED:220,MOVE_STEER_RATE:Math.PI*2.2,MOVE_RETARGET_BRAKE_GRACE_MS:320,MOVE_MAX_DURATION:8000,
  myId:'me',roomReady:true,moveState:Object.create(null),localMoveVelocity:{vx:0,vy:0,lastStepAt:1000},
  performance:{now:()=>now},predicted:{x:0,y:0,alive:true,sequence:0},localCommandBackpressured:()=>false,
};
c.getPredictedTail=()=>c.predicted;
c.clampWorldPoint=(x,y)=>({x,y});
c.tracePosition=()=>{};
c.makeMoveCommand=(dx,dy)=>({dx,dy});
c.executeLocal=cmd=>{ c.predicted={...c.predicted,x:c.predicted.x+cmd.dx,y:c.predicted.y+cmd.dy,sequence:c.predicted.sequence+1}; };
c.queueLocalRenderTarget=()=>{};
vm.createContext(c);
vm.runInContext(block+'\nthis.runTick=()=>tickMovement();',c);
c.moveState.me={startX:0,startY:0,targetX:500,targetY:0,retargetAt:1000,hardStopAt:9000,lastWallAt:1000};
now=1090;c.runTick();
const v1=c.localMoveVelocity.vx;
if(v1<=0) throw new Error(`first tick did not accelerate: vx=${v1}`);
if('vx' in c.moveState.me||'vy' in c.moveState.me) throw new Error('destination plan owns velocity');
now=1180;c.runTick();
const v2=c.localMoveVelocity.vx;
if(v2<=v1+1e-6) throw new Error(`second tick restarted/stalled velocity instead of accumulating: v1=${v1} v2=${v2}`);
now=1270;c.runTick();
const v3=c.localMoveVelocity.vx;
if(v3<=v2+1e-6) throw new Error(`third tick restarted/stalled velocity instead of accumulating: v2=${v2} v3=${v3}`);
console.log('PSSF movement velocity persistence: PASS');
