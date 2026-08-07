'use strict';

const PROTOCOL = 13;
const RULESET_REVISION = 'pssf-v13-r1';
const WORLD_WIDTH = 1000;
const WORLD_HEIGHT = 760;
const WORLD_MARGIN = 14;
const AOI_RADIUS = 260;
const MAX_RANGE = Math.max(60, Math.min(450, AOI_RADIUS - 30));
const HIT_RADIUS = 14;
const MAX_HP = 3;
const TICK_MS = 1000 / 30;
const STEP_INTERVAL_MS = 90;
const BASE_MAX_STEP = 50;
const STEP_JITTER_ALLOWANCE = 1.35;
const STEP_EPSILON = 0.75;
const MAX_TICK_ADVANCE = 120;
const RESPAWN_MS = 5000;
const POLICY_GRACE_MS = 15000;

function round6(v){ return Math.round(v * 1e6) / 1e6; }
function stableHash(value){
  const text=JSON.stringify(value); let hash=2166136261;
  for(let i=0;i<text.length;i++){ hash^=text.charCodeAt(i); hash=Math.imul(hash,16777619); }
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
  const maxStep=allowedStepForTicks(prev.tick,tick);
  const distance=Math.hypot(dx,dy);
  const scale=distance>maxStep&&distance>0?maxStep/distance:1;
  return {x:round6(prev.x+dx*scale),y:round6(prev.y+dy*scale),distance:round6(distance),maxStep:round6(maxStep),speedViolation:distance>maxStep+1e-9,tickViolation:tick<prev.tick};
}
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
  constructor({id,color='#c77dff',aoiRadius=AOI_RADIUS}){
    this.id=id; this.color=color; this.aoiRadius=aoiRadius;
    this.startedAt=performance.now();
    this.confirmedWorld=Object.create(null);
    this.confirmedSeq=new Map();
    this.pendingById=new Map();
    this.pendingOrderByPlayer=new Map();
    this.deferredCommands=new Map();
    this.localSequence=0;
    this.openPeers=new Set();
    this.currentPolicyByPeer=new Map();
    this.policyByAssignment=new Map();
    this.selfPolicy=null;
    const spawn=clampWorldPoint(80+Math.random()*(WORLD_WIDTH-160),80+Math.random()*(WORLD_HEIGHT-160));
    const state={x:round6(spawn.x),y:round6(spawn.y),color,sequence:0,tick:this.currentTick(),hp:MAX_HP,alive:true,lifeId:1,deadObservedAt:0,deadServerAt:0,tentative:false};
    this.confirmedWorld[id]={...state}; this.confirmedSeq.set(id,0);
  }
  currentTick(){ return Math.floor((performance.now()-this.startedAt)/TICK_MS); }
  setOpenPeer(id,open){ if(open) this.openPeers.add(id); else this.openPeers.delete(id); }
  storePolicy(policy,{self=false}={}){
    if(!policy||typeof policy.peerId!=='string'||typeof policy.assignmentId!=='string') return;
    const now=performance.now(); const prev=this.currentPolicyByPeer.get(policy.peerId);
    if(prev&&prev.assignmentId!==policy.assignmentId){ prev.expiresAt=now+POLICY_GRACE_MS; this.policyByAssignment.set(prev.assignmentId,prev); }
    const copy={...policy,expiresAt:now+POLICY_GRACE_MS};
    this.currentPolicyByPeer.set(copy.peerId,copy); this.policyByAssignment.set(copy.assignmentId,copy);
    if(self||copy.peerId===this.id) this.selfPolicy=copy;
    this.prunePolicies();
  }
  applyPolicyView(message){
    if(message?.selfPolicy) this.storePolicy(message.selfPolicy,{self:true});
    for(const p of Array.isArray(message?.peerPolicies)?message.peerPolicies:[]) this.storePolicy(p);
  }
  prunePolicies(){
    const now=performance.now();
    for(const [id,p] of this.policyByAssignment){ if(p.expiresAt<=now&&this.currentPolicyByPeer.get(p.peerId)?.assignmentId!==id) this.policyByAssignment.delete(id); }
  }
  policyForCommand(command){ const p=this.policyByAssignment.get(command?.assignmentId); return p&&p.peerId===command.playerId?p:null; }
  validatorsFor(command){ return [...(this.policyForCommand(command)?.validatorIds||[])]; }
  quorumFor(command){ return this.policyForCommand(command)?.quorum||0; }
  commandPolicyMatches(command){ const p=this.policyForCommand(command); return Boolean(p)&&p.topologyEpoch===command.topologyEpoch&&p.rulesetRevision===RULESET_REVISION; }
  predictedTail(playerId){
    const ids=this.pendingOrderByPlayer.get(playerId)||[];
    for(let i=ids.length-1;i>=0;i--){ const p=this.pendingById.get(ids[i]); if(p?.nextState) return p.nextState; }
    return this.confirmedWorld[playerId]||null;
  }
  snapshot(){ const s=this.confirmedWorld[this.id]; return {protocol:PROTOCOL,rulesetRevision:RULESET_REVISION,senderId:this.id,clockTick:this.currentTick(),state:{...s,deadObservedAt:0},stateHash:stateHash(s)}; }
  mergeSnapshot(remoteId,snapshot){
    if(!snapshot||snapshot.protocol!==PROTOCOL||snapshot.rulesetRevision!==RULESET_REVISION||snapshot.senderId!==remoteId||!snapshot.state) return false;
    const s=snapshot.state;
    if(!Number.isFinite(s.x)||!Number.isFinite(s.y)||!Number.isSafeInteger(s.sequence)||!Number.isSafeInteger(s.lifeId)||!Number.isSafeInteger(s.hp)||!inBounds(s.x,s.y)) return false;
    const localSeq=this.confirmedSeq.get(remoteId)||0; if(s.sequence<localSeq) return false;
    const normalized={...s,color:s.color||'#7aa5ff',hp:Math.max(0,Math.min(MAX_HP,s.hp)),alive:Boolean(s.alive),deadObservedAt:s.alive?0:performance.now(),deadServerAt:0,tentative:false};
    this.confirmedWorld[remoteId]=normalized; this.confirmedSeq.set(remoteId,normalized.sequence); return true;
  }
  makeBaseCommand(type,previous){
    const p=this.selfPolicy; if(!p) return null;
    const sequence=++this.localSequence;
    return {protocol:PROTOCOL,rulesetRevision:RULESET_REVISION,type,commandId:`${this.id}:${sequence}:${Math.random().toString(16).slice(2,14)}`,playerId:this.id,sequence,previousStateHash:stateHash(previous),tick:this.currentTick(),topologyEpoch:p.topologyEpoch,assignmentId:p.assignmentId,aoiRadius:this.aoiRadius};
  }
  makeMoveCommand(dx,dy){
    const prev=this.predictedTail(this.id); if(!prev?.alive) return null;
    const desired=clampWorldPoint(prev.x+dx,prev.y+dy); const safeDx=desired.x-prev.x,safeDy=desired.y-prev.y;
    if(Math.abs(safeDx)<=1e-9&&Math.abs(safeDy)<=1e-9) return null;
    const c=this.makeBaseCommand('move',prev); if(!c) return null; const r=computeMove(prev,safeDx,safeDy,c.tick);
    return {...c,dx:round6(safeDx),dy:round6(safeDy),claimedX:r.x,claimedY:r.y};
  }
  buildShootCheckpoint(shooter){
    const checkpoint=[],world=Object.create(null),interestRadius=Math.max(this.aoiRadius,MAX_RANGE+HIT_RADIUS+24);
    for(const pid of [this.id,...this.openPeers]){
      const s=pid===this.id?shooter:this.confirmedWorld[pid]; if(!s) continue;
      if(pid!==this.id&&Math.hypot(s.x-shooter.x,s.y-shooter.y)>interestRadius) continue;
      const item={playerId:pid,x:round6(s.x),y:round6(s.y),alive:Boolean(s.alive),lifeId:s.lifeId,sequence:s.sequence}; checkpoint.push(item); world[pid]=item;
    }
    checkpoint.sort((a,b)=>a.playerId.localeCompare(b.playerId)); return {checkpoint,world};
  }
  makeShootCommand(targetX,targetY){
    const shooter=this.predictedTail(this.id); if(!shooter?.alive) return null;
    const dx=targetX-shooter.x,dy=targetY-shooter.y,len=Math.hypot(dx,dy)||1,dirX=dx/len,dirY=dy/len;
    const data=this.buildShootCheckpoint(shooter); const c=this.makeBaseCommand('shoot',shooter); if(!c) return null;
    const hitId=rayHit(shooter.x,shooter.y,dirX,dirY,data.world,this.id);
    return {...c,originX:round6(shooter.x),originY:round6(shooter.y),dirX:round6(dirX),dirY:round6(dirY),checkpoint:data.checkpoint,checkpointHash:stableHash(data.checkpoint),claimedHitId:hitId,claimedHitLifeId:hitId?data.world[hitId].lifeId:null};
  }
  makeHealCommand(){ const prev=this.predictedTail(this.id); if(!prev?.alive||prev.hp>=MAX_HP) return null; const c=this.makeBaseCommand('heal',prev); return c?{...c,claimedHp:prev.hp+1}:null; }
  makeRespawnCommand(){
    const prev=this.predictedTail(this.id); if(!prev||prev.alive) return null; const c=this.makeBaseCommand('respawn',prev); if(!c) return null;
    const p=clampWorldPoint(80+Math.random()*(WORLD_WIDTH-160),80+Math.random()*(WORLD_HEIGHT-160)); return {...c,spawnX:round6(p.x),spawnY:round6(p.y),nextLifeId:prev.lifeId+1};
  }
  validateEnvelope(remoteId,c){
    if(!c||c.protocol!==PROTOCOL||c.rulesetRevision!==RULESET_REVISION) return 'unsupported protocol/ruleset';
    if(!['move','shoot','heal','respawn'].includes(c.type)) return 'unsupported command';
    if(c.playerId!==remoteId) return 'identity mismatch';
    if(!Number.isSafeInteger(c.sequence)||c.sequence<1||!Number.isSafeInteger(c.tick)||c.tick<0) return 'invalid sequence/tick';
    if(typeof c.previousStateHash!=='string'||typeof c.assignmentId!=='string'||!Number.isSafeInteger(c.topologyEpoch)) return 'invalid references';
    if(!this.commandPolicyMatches(c)) return 'unknown server assignment';
    if(!Number.isFinite(c.aoiRadius)||c.aoiRadius<120||c.aoiRadius>1400) return 'invalid AOI';
    if(c.type==='move'&&![c.dx,c.dy,c.claimedX,c.claimedY].every(Number.isFinite)) return 'invalid move';
    if(c.type==='shoot'&&(![c.originX,c.originY,c.dirX,c.dirY].every(Number.isFinite)||!Array.isArray(c.checkpoint)||c.checkpoint.length>64)) return 'invalid shoot';
    if(c.type==='heal'&&!Number.isSafeInteger(c.claimedHp)) return 'invalid heal';
    if(c.type==='respawn'&&(!Number.isFinite(c.spawnX)||!Number.isFinite(c.spawnY)||!Number.isSafeInteger(c.nextLifeId))) return 'invalid respawn';
    return null;
  }
  predictNextState(previous,c){
    if(c.type==='move'){ const r=computeMove(previous,c.dx,c.dy,c.tick); return {...previous,x:r.x,y:r.y,tick:c.tick,sequence:c.sequence,tentative:true}; }
    if(c.type==='heal') return {...previous,hp:Math.min(MAX_HP,previous.hp+1),tick:c.tick,sequence:c.sequence,tentative:true};
    if(c.type==='respawn') return {...previous,x:c.spawnX,y:c.spawnY,hp:MAX_HP,alive:true,lifeId:c.nextLifeId,tick:c.tick,sequence:c.sequence,deadObservedAt:0,deadServerAt:0,tentative:true};
    return {...previous,tick:c.tick,sequence:c.sequence,tentative:true};
  }
  acceptCommand(c,remoteId=c.playerId){
    const env=this.validateEnvelope(remoteId,c); if(env) return {ok:false,reason:env};
    const expected=(this.confirmedSeq.get(c.playerId)||0)+(this.pendingOrderByPlayer.get(c.playerId)||[]).length+1;
    if(c.sequence>expected){ this.deferredCommands.set(c.commandId,{command:c,remoteId}); return {ok:false,deferred:true,reason:`sequence expected=${expected} got=${c.sequence}`}; }
    if(c.sequence<expected) return {ok:false,reason:`stale expected=${expected} got=${c.sequence}`};
    const previous=this.predictedTail(c.playerId); if(!previous||stateHash(previous)!==c.previousStateHash) return {ok:false,reason:'previousStateHash mismatch'};
    const pending={command:c,previousState:{...previous},nextState:this.predictNextState(previous,c),verdict:null,rejectReason:null};
    this.pendingById.set(c.commandId,pending); const order=this.pendingOrderByPlayer.get(c.playerId)||[]; order.push(c.commandId); this.pendingOrderByPlayer.set(c.playerId,order);
    if(c.type==='move'){
      const r=this.evaluateCommand(c); pending.verdict=r.accepted?'accepted':'rejected'; pending.rejectReason=r.reason; this.drain(c.playerId);
    } else if(!this.validatorsFor(c).length||!this.quorumFor(c)) {
      const r=this.evaluateCommand(c); pending.verdict=r.accepted?'accepted':'rejected'; pending.rejectReason=r.reason; this.drain(c.playerId);
    }
    return {ok:true,pending};
  }
  checkpointMatchesLocal(checkpoint,shooterId,shooterState){
    if(!Array.isArray(checkpoint)||checkpoint.length>64) return false; const seen=new Set(); let shooterSeen=false;
    for(const item of checkpoint){
      if(!item||typeof item.playerId!=='string'||seen.has(item.playerId)||![item.x,item.y].every(Number.isFinite)||!Number.isSafeInteger(item.lifeId)||!inBounds(item.x,item.y)) return false;
      seen.add(item.playerId);
      if(item.playerId===shooterId){ shooterSeen=true; if(Math.hypot(shooterState.x-item.x,shooterState.y-item.y)>1.5||item.lifeId!==shooterState.lifeId) return false; }
      const local=item.playerId===shooterId?shooterState:this.confirmedWorld[item.playerId];
      if(local&&Math.hypot(local.x-item.x,local.y-item.y)>3.5) return false;
      if(local&&local.lifeId!==item.lifeId) return false;
    }
    return shooterSeen;
  }
  evaluateCommand(c){
    const p=this.pendingById.get(c.commandId); if(!p) return {accepted:false,reason:'missing pending',computed:null}; const previous=p.previousState;
    if(!this.commandPolicyMatches(c)) return {accepted:false,reason:'server assignment mismatch',computed:null};
    if(c.tick<previous.tick) return {accepted:false,reason:`tick regression previous=${previous.tick} got=${c.tick}`,computed:null};
    if(c.type==='move'){
      const r=computeMove(previous,c.dx,c.dy,c.tick); const accepted=previous.alive&&!r.speedViolation&&!r.tickViolation&&r.x===c.claimedX&&r.y===c.claimedY&&inBounds(r.x,r.y);
      return {accepted,reason:accepted?'move verified':`move invalid distance=${r.distance} max=${r.maxStep}`,computed:r};
    }
    if(c.type==='shoot'){
      const length=Math.hypot(c.dirX,c.dirY),originMatches=Math.hypot(previous.x-c.originX,previous.y-c.originY)<1.5;
      const checkpointOk=stableHash(c.checkpoint)===c.checkpointHash&&this.checkpointMatchesLocal(c.checkpoint,c.playerId,previous);
      const world=Object.create(null); for(const item of c.checkpoint) world[item.playerId]=item;
      const hit=rayHit(c.originX,c.originY,c.dirX,c.dirY,world,c.playerId),life=hit?world[hit]?.lifeId:null;
      const accepted=previous.alive&&Math.abs(length-1)<0.02&&originMatches&&checkpointOk&&hit===c.claimedHitId&&life===c.claimedHitLifeId;
      return {accepted,reason:accepted?'shoot verified':`shoot invalid hit=${hit||'none'} checkpoint=${checkpointOk}`,computed:{hit,life}};
    }
    if(c.type==='heal'){ const accepted=previous.alive&&previous.hp<MAX_HP&&c.claimedHp===previous.hp+1; return {accepted,reason:accepted?'heal verified':'heal invalid state',computed:null}; }
    if(c.type==='respawn'){
      const deathAge=performance.now()-(previous.deadObservedAt||0); const accepted=!previous.alive&&deathAge>=RESPAWN_MS-300&&c.nextLifeId===previous.lifeId+1&&inBounds(c.spawnX,c.spawnY);
      return {accepted,reason:accepted?'respawn verified':`respawn invalid deadAge=${Math.round(deathAge)}ms`,computed:null};
    }
    return {accepted:false,reason:'unsupported',computed:null};
  }
  makeVerificationReceipt(c){
    const r=this.evaluateCommand(c);
    return {protocol:PROTOCOL,rulesetRevision:RULESET_REVISION,commandId:c.commandId,playerId:c.playerId,sequence:c.sequence,assignmentId:c.assignmentId,decision:r.accepted?'accept':'reject',reason:r.reason,computedHash:stableHash(r.computed||null),evidenceHash:stableHash(c)};
  }
  applyCertificate(cert){
    const p=this.pendingById.get(cert?.commandId); if(!p) return false; const c=p.command;
    if(cert.playerId!==c.playerId||cert.sequence!==c.sequence||cert.assignmentId!==c.assignmentId) return false;
    p.verdict=cert.verdict==='accepted'?'accepted':'rejected'; p.rejectReason=p.verdict==='accepted'?null:'server quorum certificate rejected'; p.certificateServerTime=cert.serverTime;
    this.drain(c.playerId); return true;
  }
  drain(playerId){
    while(true){
      const expected=(this.confirmedSeq.get(playerId)||0)+1,order=this.pendingOrderByPlayer.get(playerId)||[];
      const id=order.find(cid=>this.pendingById.get(cid)?.command.sequence===expected); if(!id) break;
      const p=this.pendingById.get(id); if(!p?.verdict) break;
      if(p.verdict==='accepted') this.commit(p); else this.reject(p);
    }
    this.acceptDeferred(playerId);
  }
  commit(p){
    const c=p.command,current=this.confirmedWorld[c.playerId]||p.previousState; let state={...p.nextState,tentative:false};
    if(c.type==='move'||c.type==='shoot') state={...state,hp:current.hp,alive:current.alive,lifeId:current.lifeId,deadObservedAt:current.deadObservedAt,deadServerAt:current.deadServerAt};
    if(c.type==='heal') state={...state,hp:current.alive?Math.min(MAX_HP,current.hp+1):current.hp,alive:current.alive,lifeId:current.lifeId,deadObservedAt:current.deadObservedAt,deadServerAt:current.deadServerAt};
    this.confirmedWorld[c.playerId]=state; this.confirmedSeq.set(c.playerId,c.sequence); this.removePending(c);
    if(c.playerId===this.id) this.localSequence=Math.max(this.localSequence,c.sequence);
    if(c.type==='shoot'&&c.claimedHitId){
      const victim=this.confirmedWorld[c.claimedHitId]; if(victim?.alive&&victim.lifeId===c.claimedHitLifeId){ victim.hp=Math.max(0,victim.hp-1); if(victim.hp===0){ victim.alive=false; victim.deadObservedAt=performance.now(); victim.deadServerAt=Number.isFinite(p.certificateServerTime)?p.certificateServerTime:Date.now(); } }
    }
  }
  reject(p){
    const c=p.command; this.removePending(c);
    const order=this.pendingOrderByPlayer.get(c.playerId)||[];
    for(const id of [...order]){ const other=this.pendingById.get(id); if(other&&other.command.sequence>c.sequence) this.pendingById.delete(id); }
    this.pendingOrderByPlayer.set(c.playerId,order.filter(id=>this.pendingById.has(id)));
    for(const [id,item] of [...this.deferredCommands]) if(item.command.playerId===c.playerId&&item.command.sequence>c.sequence) this.deferredCommands.delete(id);
    if(c.playerId===this.id) this.localSequence=(this.confirmedSeq.get(this.id)||0)+(this.pendingOrderByPlayer.get(this.id)||[]).length;
  }
  removePending(c){ this.pendingById.delete(c.commandId); this.pendingOrderByPlayer.set(c.playerId,(this.pendingOrderByPlayer.get(c.playerId)||[]).filter(id=>id!==c.commandId)); }
  acceptDeferred(playerId){
    let progressed=true;
    while(progressed){
      progressed=false; const expected=(this.confirmedSeq.get(playerId)||0)+(this.pendingOrderByPlayer.get(playerId)||[]).length+1;
      const entry=[...this.deferredCommands.values()].find(x=>x.command.playerId===playerId&&x.command.sequence===expected);
      if(entry){ this.deferredCommands.delete(entry.command.commandId); this.acceptCommand(entry.command,entry.remoteId); progressed=true; }
    }
  }
}

module.exports={PROTOCOL,RULESET_REVISION,WORLD_WIDTH,WORLD_HEIGHT,WORLD_MARGIN,AOI_RADIUS,MAX_RANGE,HIT_RADIUS,MAX_HP,RESPAWN_MS,round6,stableHash,stateHash,clampWorldPoint,inBounds,computeMove,rayHit,ProtocolState};
