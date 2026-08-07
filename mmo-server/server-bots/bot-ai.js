'use strict';

const { clampWorldPoint, MAX_RANGE, RESPAWN_MS } = require('./bot-protocol');

function randomBetween(a,b){ return a + Math.random()*(b-a); }
function isBotId(id){ return /^BOT-/i.test(id); }

class DodgeBotAI {
  constructor(peer,{moveSpeed=165,telegraphMin=700,telegraphMax=1050,attackGapMin=1300,attackGapMax=2600}={}){
    this.peer=peer; this.moveSpeed=moveSpeed; this.telegraphMin=telegraphMin; this.telegraphMax=telegraphMax; this.attackGapMin=attackGapMin; this.attackGapMax=attackGapMax;
    this.moveTarget=null; this.nextMoveTargetAt=0; this.nextAttackAt=performance.now()+randomBetween(1200,2400); this.attack=null; this.lastTick=performance.now(); this.respawnRequested=false;
    this.simulatedPingMs=Math.round(randomBetween(30,180));
  }
  humanTargets(){ return Object.entries(this.peer.protocol.confirmedWorld).filter(([id,s])=>id!==this.peer.id&&!isBotId(id)&&s?.alive); }
  nearestHuman(){
    const me=this.peer.protocol.predictedTail(this.peer.id); if(!me) return null;
    return this.humanTargets().map(([id,s])=>({id,state:s,d:Math.hypot(s.x-me.x,s.y-me.y)})).sort((a,b)=>a.d-b.d)[0]||null;
  }
  chooseMoveTarget(now){
    const target=this.nearestHuman(); const center=target?.state||{x:500,y:380};
    const angle=Math.random()*Math.PI*2, radius=randomBetween(125,235);
    this.moveTarget=clampWorldPoint(center.x+Math.cos(angle)*radius,center.y+Math.sin(angle)*radius);
    this.nextMoveTargetAt=now+randomBetween(900,1800)+this.simulatedPingMs;
  }
  async tick(now=performance.now()){
    const me=this.peer.protocol.predictedTail(this.peer.id); if(!me) return;
    if(!me.alive){
      if(!this.respawnRequested&&now-(me.deadObservedAt||0)>=RESPAWN_MS+100){ const c=this.peer.protocol.makeRespawnCommand(); if(c){ this.respawnRequested=true; await this.peer.sendCommand(c); } }
      return;
    }
    this.respawnRequested=false;
    if(now>=this.nextMoveTargetAt||!this.moveTarget) this.chooseMoveTarget(now);
    const dt=Math.min(.12,Math.max(.01,(now-this.lastTick)/1000)); this.lastTick=now;
    if(this.moveTarget){
      const tail=this.peer.protocol.predictedTail(this.peer.id); const dx=this.moveTarget.x-tail.x,dy=this.moveTarget.y-tail.y,d=Math.hypot(dx,dy);
      if(d>5){ const step=Math.min(d,this.moveSpeed*dt); const c=this.peer.protocol.makeMoveCommand(dx/d*step,dy/d*step); if(c) await this.peer.sendCommand(c); }
      else this.nextMoveTargetAt=0;
    }
    if(this.attack){
      if(now>=this.attack.fireAt){
        const shot=this.peer.protocol.makeShootCommand(this.attack.x,this.attack.y); if(shot) await this.peer.sendCommand(shot);
        this.attack=null; this.simulatedPingMs=Math.round(randomBetween(30,180)); this.nextAttackAt=now+randomBetween(this.attackGapMin,this.attackGapMax)+this.simulatedPingMs;
      }
      return;
    }
    if(now>=this.nextAttackAt){
      const target=this.nearestHuman(); const shooter=this.peer.protocol.predictedTail(this.peer.id);
      if(target&&shooter&&target.d<=MAX_RANGE+55){
        const warmup=Math.round(randomBetween(this.telegraphMin,this.telegraphMax));
        this.attack={targetId:target.id,x:target.state.x,y:target.state.y,fireAt:now+warmup+this.simulatedPingMs,warmup,pingMs:this.simulatedPingMs};
        this.peer.broadcastTelegraph({targetId:target.id,targetX:this.attack.x,targetY:this.attack.y,leadMs:warmup+this.simulatedPingMs,pingMs:this.simulatedPingMs});
      } else this.nextAttackAt=now+500;
    }
  }
}
module.exports={DodgeBotAI,isBotId};
