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
if(block.includes('buildMoveProfile(')) throw new Error('scalar move profile returned');
if(!block.includes('targetX:toX,targetY:toY,vx,vy')) throw new Error('movement does not own velocity vector');
if(!block.includes('const previousSample=previous?evalMove(previous,now):null;')) throw new Error('retarget does not sample prior velocity');

let now=1000;
const c={
  BASE_MAX_STEP:75,MOVE_DECEL:560,MOVE_ACCEL:620,MOVE_SPEED:220,MOVE_MAX_DURATION:8000,
  performance:{now:()=>now},myId:'me',moveState:Object.create(null),
  predicted:{x:100,y:100,alive:true},traces:[],confirmedWorld:{me:{x:100,y:100,alive:true}},
  localCommandBackpressured:()=>false,
};
c.getPredictedTail=()=>c.predicted;
c.tracePosition=(reason,opt)=>c.traces.push({reason,opt});
c.clampWorldPoint=(x,y)=>({x,y});
c.makeMoveCommand=(dx,dy)=>({dx,dy});
c.executeLocal=(cmd)=>{ c.predicted={...c.predicted,x:c.predicted.x+cmd.dx,y:c.predicted.y+cmd.dy}; };
vm.createContext(c);
vm.runInContext(block+'\nthis.startMoveFn=startMove;this.evalMoveFn=evalMove;',c);

// Already moving right at max speed. A 90-degree retarget must preserve the current velocity vector.
c.moveState.me={startX:0,startY:100,targetX:300,targetY:100,vx:220,vy:0,lastStepAt:1000,hardStopAt:9000,lastWallAt:1000};
now=1100;
c.startMoveFn('me',100,100,100,300);
const m=c.moveState.me;
if(!m) throw new Error('retarget deleted movement');
if(Math.abs(m.startX-100)>1e-9||Math.abs(m.startY-100)>1e-9) throw new Error('retarget did not start from predicted tail');
if(Math.abs(m.targetX-100)>1e-9||Math.abs(m.targetY-300)>1e-9) throw new Error('new target was not armed immediately');
if(Math.abs(m.vx-220)>1e-6||Math.abs(m.vy)>1e-6) throw new Error(`velocity vector was rotated/reset at retarget: ${m.vx},${m.vy}`);
if(!c.traces.some(x=>x.reason==='retarget:armed')) throw new Error('retarget did not reach armed state');

// One 90ms step may rotate by at most MOVE_ACCEL*dt in velocity space.
now=1190;
const next=c.evalMoveFn(m,now);
const dv=Math.hypot(next.vx-m.vx,next.vy-m.vy);
if(dv>620*0.09+1e-6) throw new Error(`velocity changed faster than acceleration budget: dv=${dv}`);
if(next.vx<=0) throw new Error('90-degree retarget rotated velocity instantaneously');

// A 180-degree retarget must also keep current vector at the instant of retarget.
c.predicted={x:100,y:100,alive:true};
c.moveState.me={startX:100,startY:100,targetX:300,targetY:100,vx:180,vy:20,lastStepAt:1190,hardStopAt:9000,lastWallAt:1190};
now=1200;
const justBefore=c.evalMoveFn(c.moveState.me,now);
c.startMoveFn('me',100,100,0,100);
if(Math.abs(c.moveState.me.vx-justBefore.vx)>1e-6||Math.abs(c.moveState.me.vy-justBefore.vy)>1e-6) throw new Error('180-degree retarget did not preserve instantaneous vector velocity');
console.log('PSSF movement live retarget: PASS');
