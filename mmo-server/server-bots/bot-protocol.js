'use strict';

const PROTOCOL = 12;
const WORLD_WIDTH = 1000;
const WORLD_HEIGHT = 760;
const WORLD_MARGIN = 14;
const AOI_RADIUS = 260;
const MAX_RANGE = 230;
const HIT_RADIUS = 14;
const MAX_HP = 3;
const TICK_MS = 1000 / 30;
const STEP_INTERVAL_MS = 90;
const BASE_MAX_STEP = 50;
const STEP_JITTER_ALLOWANCE = 1.35;
const STEP_EPSILON = 0.75;
const MAX_TICK_ADVANCE = 120;
const RESPAWN_MS = 5000;
const COMMITTEE_SIZE = 3;

function round6(v){ return Math.round(v * 1e6) / 1e6; }
function stableHash(value){
  const text = JSON.stringify(value); let hash = 2166136261;
  for(let i=0;i<text.length;i++){ hash ^= text.charCodeAt(i); hash = Math.imul(hash,16777619); }
  return (hash>>>0).toString(16).padStart(8,'0');
}
function stateHash(state){
  return stableHash({x:round6(state.x),y:round6(state.y),sequence:state.sequence,tick:state.tick,hp:state.hp,alive:state.alive,lifeId:state.lifeId});
}
function clampWorldPoint(x,y){
  return {x:Math.max(WORLD_MARGIN,Math.min(WORLD_WIDTH-WORLD_MARGIN,x)),y:Math.max(WORLD_MARGIN,Math.min(WORLD_HEIGHT-WORLD_MARGIN,y))};
}
function inBounds(x,y){ return Number.isFinite(x)&&Number.isFinite(y)&&x>=WORLD_MARGIN&&y>=WORLD_MARGIN&&x<=WORLD_WIDTH-WORLD_MARGIN&&y<=WORLD_HEIGHT-WORLD_MARGIN; }
function allowedStepForTicks(previousTick,commandTick){
  const elapsedTicks=Math.max(1,Math.min(MAX_TICK_ADVANCE,commandTick-previousTick));
  const elapsedSteps=elapsedTicks/(STEP_INTERVAL_MS/TICK_MS);
  return BASE_MAX_STEP*Math.max(1,elapsedSteps)*STEP_JITTER_ALLOWANCE+STEP_EPSILON;
}
function computeMove(prev,dx,dy,tick){
  const maxStep=allowedStepForTicks(prev.tick,tick); const distance=Math.hypot(dx,dy); const scale=distance>maxStep&&distance>0?maxStep/distance:1;
  const p=clampWorldPoint(prev.x+dx*scale,prev.y+dy*scale);
  return {x:round6(p.x),y:round6(p.y),distance:round6(distance),maxStep:round6(maxStep),speedViolation:distance>maxStep+1e-9,tickViolation:tick<prev.tick};
}
function validatorsFor(command, committeeSize=COMMITTEE_SIZE){
  const candidates=command.membershipIds.filter(id=>id!==command.playerId);
  if(!candidates.length) return [command.playerId];
  const seed=stableHash({epochId:command.epochId,membershipHash:command.membershipHash,playerId:command.playerId,sequence:command.sequence,previousStateHash:command.previousStateHash});
  return [...candidates].sort((a,b)=>stableHash(`${seed}:${a}`).localeCompare(stableHash(`${seed}:${b}`))).slice(0,Math.min(committeeSize,candidates.length));
}
function quorumFor(command,committeeSize=COMMITTEE_SIZE){ return Math.floor(validatorsFor(command,committeeSize).length/2)+1; }
function rayHit(originX,originY,dirX,dirY,world,excludeId){
  let closest=null,closestProjection=Infinity;
  for(const [id,state] of Object.entries(world)){
    if(id===excludeId||!state||!state.alive) continue;
    const px=state.x-originX,py=state.y-originY,projection=px*dirX+py*dirY;
    if(projection<0||projection>MAX_RANGE) continue;
    const cx=originX+dirX*projection,cy=originY+dirY*projection;
    if(Math.hypot(state.x-cx,state.y-cy)<=HIT_RADIUS&&projection<closestProjection){ closest=id; closestProjection=projection; }
  }
  return closest;
}

class ProtocolState {
  constructor({id,color='#c77dff',committeeSize=COMMITTEE_SIZE,now=()=>Date.now()}){
    this.id=id; this.color=color; this.committeeSize=committeeSize; this.now=now;
    this.startedAt=performance.now();
    this.confirmedWorld=Object.create(null);
    this.pendingById=new Map();
    this.pendingOrderByPlayer=new Map();
    this.receiptHandlers=[];
    this.localSequence=0;
    this.openPeers=new Set();
    const spawn=clampWorldPoint(120+Math.random()*(WORLD_WIDTH-240),100+Math.random()*(WORLD_HEIGHT-200));
    this.confirmedWorld[id]={x:round6(spawn.x),y:round6(spawn.y),color,sequence:0,tick:this.currentTick(),hp:MAX_HP,alive:true,lifeId:1,deadObservedAt:0,tentative:false};
  }
  currentTick(){ return Math.floor((performance.now()-this.startedAt)/TICK_MS); }
  membershipIds(){ return [this.id,...this.openPeers].sort(); }
  membershipDescriptor(){ const membershipIds=this.membershipIds(); const membershipHash=stableHash(membershipIds); return {membershipIds,membershipHash,epochId:stableHash({room:'runtime',membershipHash})}; }
  setOpenPeer(id,open){ if(open) this.openPeers.add(id); else this.openPeers.delete(id); }
  predictedTail(playerId){
    const ids=this.pendingOrderByPlayer.get(playerId)||[];
    for(let i=ids.length-1;i>=0;i--){ const p=this.pendingById.get(ids[i]); if(p?.nextState) return p.nextState; }
    return this.confirmedWorld[playerId]||null;
  }
  snapshot(){ const s=this.confirmedWorld[this.id]; return {protocol:PROTOCOL,senderId:this.id,clockTick:this.currentTick(),state:{...s,deadObservedAt:0},stateHash:stateHash(s)}; }
  mergeSnapshot(remoteId,snapshot){
    if(!snapshot||snapshot.protocol!==PROTOCOL||snapshot.senderId!==remoteId||!snapshot.state) return false;
    const s=snapshot.state;
    if(!Number.isFinite(s.x)||!Number.isFinite(s.y)||!Number.isSafeInteger(s.sequence)||!Number.isSafeInteger(s.lifeId)||!Number.isSafeInteger(s.hp)) return false;
    const current=this.confirmedWorld[remoteId]; if(current&&s.sequence<current.sequence) return false;
    this.confirmedWorld[remoteId]={...s,color:s.color||'#7aa5ff',hp:Math.max(0,Math.min(MAX_HP,s.hp)),alive:Boolean(s.alive),deadObservedAt:s.alive?0:performance.now(),tentative:false};
    return true;
  }
  makeBaseCommand(type,previous){
    const sequence=++this.localSequence; const membership=this.membershipDescriptor();
    return {protocol:PROTOCOL,type,commandId:`${this.id}:${sequence}:${Math.random().toString(16).slice(2,14)}`,playerId:this.id,sequence,previousStateHash:stateHash(previous),tick:this.currentTick(),membershipIds:membership.membershipIds,membershipHash:membership.membershipHash,epochId:membership.epochId,aoiRadius:AOI_RADIUS};
  }
  makeMoveCommand(dx,dy){
    const prev=this.predictedTail(this.id); if(!prev?.alive) return null;
    const command=this.makeBaseCommand('move',prev); const result=computeMove(prev,dx,dy,command.tick);
    return {...command,dx:round6(dx),dy:round6(dy),claimedX:result.x,claimedY:result.y};
  }
  makeShootCommand(targetX,targetY){
    const shooter=this.predictedTail(this.id); if(!shooter?.alive) return null;
    const dx=targetX-shooter.x,dy=targetY-shooter.y,len=Math.hypot(dx,dy)||1,dirX=dx/len,dirY=dy/len;
    const membership=this.membershipDescriptor(); const checkpoint=[]; const world=Object.create(null);
    const interestRadius=Math.max(AOI_RADIUS,MAX_RANGE+HIT_RADIUS+24);
    for(const pid of membership.membershipIds){
      const s=pid===this.id?shooter:this.confirmedWorld[pid]; if(!s) continue;
      if(pid!==this.id&&Math.hypot(s.x-shooter.x,s.y-shooter.y)>interestRadius) continue;
      const item={playerId:pid,x:round6(s.x),y:round6(s.y),alive:Boolean(s.alive),lifeId:s.lifeId,sequence:s.sequence}; checkpoint.push(item); world[pid]=item;
    }
    checkpoint.sort((a,b)=>a.playerId.localeCompare(b.playerId));
    const command=this.makeBaseCommand('shoot',shooter); const hitId=rayHit(shooter.x,shooter.y,dirX,dirY,world,this.id);
    return {...command,membershipIds:membership.membershipIds,membershipHash:membership.membershipHash,originX:round6(shooter.x),originY:round6(shooter.y),dirX:round6(dirX),dirY:round6(dirY),checkpoint,checkpointHash:stableHash(checkpoint),claimedHitId:hitId,claimedHitLifeId:hitId?world[hitId].lifeId:null};
  }
  makeRespawnCommand(){
    const prev=this.predictedTail(this.id); if(!prev||prev.alive) return null;
    const command=this.makeBaseCommand('respawn',prev); const p=clampWorldPoint(80+Math.random()*(WORLD_WIDTH-160),80+Math.random()*(WORLD_HEIGHT-160));
    return {...command,spawnX:round6(p.x),spawnY:round6(p.y),nextLifeId:prev.lifeId+1};
  }
  predictNextState(previous,command){
    if(command.type==='move'){ const r=computeMove(previous,command.dx,command.dy,command.tick); return {...previous,x:r.x,y:r.y,tick:command.tick,sequence:command.sequence,tentative:true}; }
    if(command.type==='heal') return {...previous,hp:Math.min(MAX_HP,previous.hp+1),tick:command.tick,sequence:command.sequence,tentative:true};
    if(command.type==='respawn') return {...previous,x:command.spawnX,y:command.spawnY,hp:MAX_HP,alive:true,lifeId:command.nextLifeId,tick:command.tick,sequence:command.sequence,deadObservedAt:0,tentative:true};
    return {...previous,tick:command.tick,sequence:command.sequence,tentative:true};
  }
  acceptCommand(command){
    if(!command||command.protocol!==PROTOCOL||!['move','shoot','heal','respawn'].includes(command.type)) return {ok:false,reason:'bad envelope'};
    const previous=this.predictedTail(command.playerId); if(!previous) return {ok:false,reason:'missing previous state'};
    const expected=(this.confirmedWorld[command.playerId]?.sequence||0)+(this.pendingOrderByPlayer.get(command.playerId)||[]).length+1;
    if(command.sequence!==expected) return {ok:false,reason:`sequence expected=${expected} got=${command.sequence}`};
    if(stateHash(previous)!==command.previousStateHash) return {ok:false,reason:'previousStateHash mismatch'};
    const pending={command,previousState:{...previous},nextState:this.predictNextState(previous,command),receipts:new Map(),verdict:null};
    this.pendingById.set(command.commandId,pending); const order=this.pendingOrderByPlayer.get(command.playerId)||[]; order.push(command.commandId); this.pendingOrderByPlayer.set(command.playerId,order);
    return {ok:true,pending};
  }
  validateCommand(command){
    const pending=this.pendingById.get(command.commandId); if(!pending) return {accepted:false,reason:'missing pending'};
    const previous=pending.previousState;
    if(command.membershipHash!==stableHash([...command.membershipIds].sort())) return {accepted:false,reason:'membership hash'};
    if(command.type==='move'){
      const r=computeMove(previous,command.dx,command.dy,command.tick);
      const accepted=previous.alive&&!r.speedViolation&&!r.tickViolation&&r.x===command.claimedX&&r.y===command.claimedY&&inBounds(r.x,r.y);
      return {accepted,reason:accepted?'move verified':`move invalid distance=${r.distance} max=${r.maxStep}`,computed:r};
    }
    if(command.type==='shoot'){
      const len=Math.hypot(command.dirX,command.dirY); const originMatches=Math.hypot(previous.x-command.originX,previous.y-command.originY)<1.5;
      const world=Object.create(null); for(const item of command.checkpoint||[]) world[item.playerId]=item;
      const hit=rayHit(command.originX,command.originY,command.dirX,command.dirY,world,command.playerId); const life=hit?world[hit]?.lifeId:null;
      const accepted=previous.alive&&Math.abs(len-1)<0.02&&originMatches&&stableHash(command.checkpoint)===command.checkpointHash&&hit===command.claimedHitId&&life===command.claimedHitLifeId;
      return {accepted,reason:accepted?'shoot verified':'shoot invalid',computed:{hit,life}};
    }
    if(command.type==='heal'){ const accepted=previous.alive&&previous.hp<MAX_HP&&command.claimedHp===previous.hp+1; return {accepted,reason:accepted?'heal verified':'heal invalid'}; }
    if(command.type==='respawn'){ const accepted=!previous.alive&&command.nextLifeId===previous.lifeId+1&&inBounds(command.spawnX,command.spawnY); return {accepted,reason:accepted?'respawn verified':'respawn invalid'}; }
    return {accepted:false,reason:'unsupported'};
  }
  makeReceipt(command){
    const result=this.validateCommand(command);
    return {protocol:PROTOCOL,commandId:command.commandId,playerId:command.playerId,sequence:command.sequence,validatorId:this.id,accepted:result.accepted,reason:result.reason,computed:result.computed||null};
  }
  applyReceipt(receipt){
    const pending=this.pendingById.get(receipt?.commandId); if(!pending||pending.verdict) return false;
    const validators=validatorsFor(pending.command,this.committeeSize); if(!validators.includes(receipt.validatorId)) return false;
    pending.receipts.set(receipt.validatorId,receipt);
    const accepted=[...pending.receipts.values()].filter(r=>r.accepted).length; const rejected=[...pending.receipts.values()].filter(r=>!r.accepted).length; const quorum=quorumFor(pending.command,this.committeeSize);
    if(accepted>=quorum) pending.verdict='accepted'; else if(rejected>validators.length-quorum) pending.verdict='rejected';
    if(pending.verdict) this.drain(pending.command.playerId);
    return true;
  }
  drain(playerId){
    while(true){
      const baseSeq=this.confirmedWorld[playerId]?.sequence||0; const expected=baseSeq+1; const order=this.pendingOrderByPlayer.get(playerId)||[];
      const id=order.find(cid=>this.pendingById.get(cid)?.command.sequence===expected); if(!id) break;
      const p=this.pendingById.get(id); if(!p.verdict) break;
      if(p.verdict==='accepted') this.commit(p); else this.reject(p);
    }
  }
  commit(p){
    const c=p.command; let state={...p.nextState,tentative:false}; const current=this.confirmedWorld[c.playerId]||p.previousState;
    if(c.type==='move'||c.type==='shoot') state={...state,hp:current.hp,alive:current.alive,lifeId:current.lifeId,deadObservedAt:current.deadObservedAt};
    this.confirmedWorld[c.playerId]=state; this._removePending(c);
    if(c.playerId===this.id) this.localSequence=Math.max(this.localSequence,c.sequence);
    if(c.type==='shoot'&&c.claimedHitId){ const victim=this.confirmedWorld[c.claimedHitId]; if(victim?.alive&&victim.lifeId===c.claimedHitLifeId){ victim.hp=Math.max(0,victim.hp-1); if(victim.hp===0){ victim.alive=false; victim.deadObservedAt=performance.now(); } } }
  }
  reject(p){
    const c=p.command; this._removePending(c);
    const order=this.pendingOrderByPlayer.get(c.playerId)||[];
    for(const id of [...order]){ const other=this.pendingById.get(id); if(other&&other.command.sequence>c.sequence) this.pendingById.delete(id); }
    this.pendingOrderByPlayer.set(c.playerId,order.filter(id=>this.pendingById.has(id)));
    if(c.playerId===this.id) this.localSequence=(this.confirmedWorld[this.id]?.sequence||0)+(this.pendingOrderByPlayer.get(this.id)||[]).length;
  }
  _removePending(c){ this.pendingById.delete(c.commandId); this.pendingOrderByPlayer.set(c.playerId,(this.pendingOrderByPlayer.get(c.playerId)||[]).filter(id=>id!==c.commandId)); }
}

module.exports={PROTOCOL,WORLD_WIDTH,WORLD_HEIGHT,WORLD_MARGIN,AOI_RADIUS,MAX_RANGE,HIT_RADIUS,MAX_HP,RESPAWN_MS,COMMITTEE_SIZE,round6,stableHash,stateHash,clampWorldPoint,inBounds,computeMove,validatorsFor,quorumFor,rayHit,ProtocolState};
