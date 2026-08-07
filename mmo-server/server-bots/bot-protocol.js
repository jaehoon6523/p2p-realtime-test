'use strict';

const PROTOCOL = 13;
const RULESET_REVISION = 'pssf-v13-r1';
const WORLD_WIDTH = 1000;
const WORLD_HEIGHT = 760;
const WORLD_MARGIN = 14;
const DEFAULT_AOI_RADIUS = 260;
const MIN_AOI_RADIUS = 120;
const MAX_AOI_RADIUS = 1400;
const MAX_RANGE = 230; // combat range is ruleset-owned, not AOI-owned
const HIT_RADIUS = 14;
const MAX_HP = 3;
const TICK_MS = 1000 / 30;
const STEP_INTERVAL_MS = 90;
const BASE_MAX_STEP = 50;
const STEP_JITTER_ALLOWANCE = 1.35;
const STEP_EPSILON = 0.75;
const MAX_TICK_ADVANCE = 120;
const RESPAWN_MS = 5000;
const POLICY_GRACE_MS = 15_000;

function round6(v){ return Math.round(v * 1e6) / 1e6; }
function clampNumber(v,fallback,min,max){ const n=Number(v); return Number.isFinite(n)?Math.max(min,Math.min(max,n)):fallback; }
function stableHash(value){ const text=JSON.stringify(value); let hash=2166136261; for(let i=0;i<text.length;i++){ hash^=text.charCodeAt(i); hash=Math.imul(hash,16777619); } return (hash>>>0).toString(16).padStart(8,'0'); }
function stateHash(state){ return stableHash({x:round6(state.x),y:round6(state.y),sequence:state.sequence,tick:state.tick,hp:state.hp,alive:state.alive,lifeId:state.lifeId,deadServerAt:Number(state.deadServerAt)||0}); }
function clampWorldPoint(x,y){ return {x:Math.max(WORLD_MARGIN,Math.min(WORLD_WIDTH-WORLD_MARGIN,x)),y:Math.max(WORLD_MARGIN,Math.min(WORLD_HEIGHT-WORLD_MARGIN,y))}; }
function inBounds(x,y){ return Number.isFinite(x)&&Number.isFinite(y)&&x>=WORLD_MARGIN&&y>=WORLD_MARGIN&&x<=WORLD_WIDTH-WORLD_MARGIN&&y<=WORLD_HEIGHT-WORLD_MARGIN; }
function allowedStepForTicks(previousTick,commandTick){ const elapsedTicks=Math.max(1,Math.min(MAX_TICK_ADVANCE,commandTick-previousTick)); const elapsedSteps=elapsedTicks/(STEP_INTERVAL_MS/TICK_MS); return BASE_MAX_STEP*Math.max(1,elapsedSteps)*STEP_JITTER_ALLOWANCE+STEP_EPSILON; }
function computeMove(prev,dx,dy,tick){
  const maxStep=allowedStepForTicks(prev.tick,tick), distance=Math.hypot(dx,dy), scale=distance>maxStep&&distance>0?maxStep/distance:1;
  const p=clampWorldPoint(prev.x+dx*scale,prev.y+dy*scale);
  return {x:round6(p.x),y:round6(p.y),distance:round6(distance),maxStep:round6(maxStep),speedViolation:distance>maxStep+1e-9,tickViolation:tick<prev.tick};
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
function verificationRequired(commandOrType){ const type=typeof commandOrType==='string'?commandOrType:commandOrType?.type; return type==='shoot'||type==='heal'||type==='respawn'; }

class ProtocolState {
  constructor({id,color='#c77dff',aoiRadius=DEFAULT_AOI_RADIUS}){
    this.id=id; this.color=color; this.aoiRadius=clampNumber(aoiRadius,DEFAULT_AOI_RADIUS,MIN_AOI_RADIUS,MAX_AOI_RADIUS);
    this.startedAt=performance.now(); this.confirmedWorld=Object.create(null); this.tickAnchors=new Map(); this.pendingById=new Map(); this.pendingOrderByPlayer=new Map(); this.localSequence=0; this.openPeers=new Set();
    this.membershipEpoch='unassigned'; this.membershipRoot='unassigned'; this.roomPeerCount=1; this.selfPolicy=null; this.policyByAssignment=new Map(); this.currentPolicyByPeer=new Map(); this.orphanCertificates=new Map();
    const spawn=clampWorldPoint(120+Math.random()*(WORLD_WIDTH-240),100+Math.random()*(WORLD_HEIGHT-200));
    this.confirmedWorld[id]={x:round6(spawn.x),y:round6(spawn.y),color,sequence:0,tick:this.currentTick(),hp:MAX_HP,alive:true,lifeId:1,deadObservedAt:0,deadServerAt:0,tentative:false}; this.tickAnchors.set(id,{remoteTick:this.confirmedWorld[id].tick,localTime:performance.now()});
  }
  currentTick(){ return Math.floor((performance.now()-this.startedAt)/TICK_MS); }
  setOpenPeer(id,open){ if(open) this.openPeers.add(id); else this.openPeers.delete(id); }
  setNetworkView(view={}){
    if(typeof view.membershipEpoch==='string') this.membershipEpoch=view.membershipEpoch;
    if(typeof view.membershipRoot==='string') this.membershipRoot=view.membershipRoot;
    if(Number.isFinite(view.peerCount)) this.roomPeerCount=view.peerCount;
    if(view.selfPolicy) this._storePolicy(view.selfPolicy,true);
    for(const p of Array.isArray(view.peerPolicies)?view.peerPolicies:[]) this._storePolicy(p,false);
    this._prunePolicies();
  }
  _storePolicy(policy,isSelf){
    if(!policy||typeof policy.peerId!=='string'||typeof policy.assignmentId!=='string') return;
    const now=performance.now(),previous=this.currentPolicyByPeer.get(policy.peerId);
    if(previous&&previous.assignmentId!==policy.assignmentId){previous.expiresAt=now+POLICY_GRACE_MS;this.policyByAssignment.set(previous.assignmentId,previous);}
    const copy={...policy,expiresAt:now+POLICY_GRACE_MS};
    this.policyByAssignment.set(copy.assignmentId,copy); this.currentPolicyByPeer.set(copy.peerId,copy); if(isSelf||copy.peerId===this.id) this.selfPolicy=copy;
  }
  _prunePolicies(){ const now=performance.now(); for(const [id,p] of this.policyByAssignment) if(p.expiresAt<=now&&this.currentPolicyByPeer.get(p.peerId)?.assignmentId!==id) this.policyByAssignment.delete(id); }
  policyFor(actorId,assignmentId){ const p=this.policyByAssignment.get(assignmentId); return p?.peerId===actorId?p:null; }
  predictedTail(playerId){ const ids=this.pendingOrderByPlayer.get(playerId)||[]; for(let i=ids.length-1;i>=0;i--){ const p=this.pendingById.get(ids[i]); if(p?.nextState) return p.nextState; } return this.confirmedWorld[playerId]||null; }
  snapshot(){ const s=this.confirmedWorld[this.id]; return {protocol:PROTOCOL,rulesetRevision:RULESET_REVISION,senderId:this.id,clockTick:this.currentTick(),state:{...s,deadObservedAt:0},stateHash:stateHash(s)}; }
  mergeSnapshot(remoteId,snapshot){
    if(!snapshot||snapshot.protocol!==PROTOCOL||snapshot.rulesetRevision!==RULESET_REVISION||snapshot.senderId!==remoteId||!snapshot.state) return false;
    const s=snapshot.state; if(!Number.isFinite(s.x)||!Number.isFinite(s.y)||!Number.isSafeInteger(s.sequence)||!Number.isSafeInteger(s.lifeId)||!Number.isSafeInteger(s.hp)||!inBounds(s.x,s.y)) return false;
    const current=this.confirmedWorld[remoteId]; if(current&&s.sequence<current.sequence) return false;
    this.confirmedWorld[remoteId]={...s,color:s.color||'#7aa5ff',hp:Math.max(0,Math.min(MAX_HP,s.hp)),alive:Boolean(s.alive),deadObservedAt:s.alive?0:performance.now(),deadServerAt:Number(s.deadServerAt)||0,tentative:false}; this.tickAnchors.set(remoteId,{remoteTick:Number.isSafeInteger(snapshot.clockTick)?snapshot.clockTick:s.tick,localTime:performance.now()}); return true;
  }
  makeBaseCommand(type,previous){
    const p=this.selfPolicy; if(!p) return null; const sequence=++this.localSequence;
    return {protocol:PROTOCOL,rulesetRevision:RULESET_REVISION,type,commandId:`${this.id}:${sequence}:${Math.random().toString(16).slice(2,14)}`,playerId:this.id,sequence,previousStateHash:stateHash(previous),tick:this.currentTick(),topologyEpoch:p.topologyEpoch,assignmentId:p.assignmentId,aoiRadius:this.aoiRadius};
  }
  makeMoveCommand(dx,dy){
    const prev=this.predictedTail(this.id); if(!prev?.alive) return null; const desired=clampWorldPoint(prev.x+dx,prev.y+dy), safeDx=desired.x-prev.x,safeDy=desired.y-prev.y; if(Math.hypot(safeDx,safeDy)<1e-9)return null;
    const command=this.makeBaseCommand('move',prev); if(!command)return null; const result=computeMove(prev,safeDx,safeDy,command.tick); return {...command,dx:round6(safeDx),dy:round6(safeDy),claimedX:result.x,claimedY:result.y};
  }
  makeShootCommand(targetX,targetY){
    const shooter=this.predictedTail(this.id); if(!shooter?.alive)return null; const dx=targetX-shooter.x,dy=targetY-shooter.y,len=Math.hypot(dx,dy)||1,dirX=dx/len,dirY=dy/len;
    const checkpoint=[],world=Object.create(null),interestRadius=Math.max(this.aoiRadius,MAX_RANGE+HIT_RADIUS+24);
    for(const pid of [this.id,...this.openPeers]){ const s=pid===this.id?shooter:this.confirmedWorld[pid]; if(!s)continue; if(pid!==this.id&&Math.hypot(s.x-shooter.x,s.y-shooter.y)>interestRadius)continue; const item={playerId:pid,x:round6(s.x),y:round6(s.y),alive:Boolean(s.alive),lifeId:s.lifeId,sequence:s.sequence}; checkpoint.push(item); world[pid]=item; }
    checkpoint.sort((a,b)=>a.playerId.localeCompare(b.playerId)); const command=this.makeBaseCommand('shoot',shooter); if(!command)return null; const hitId=rayHit(shooter.x,shooter.y,dirX,dirY,world,this.id);
    return {...command,originX:round6(shooter.x),originY:round6(shooter.y),dirX:round6(dirX),dirY:round6(dirY),checkpoint,checkpointHash:stableHash(checkpoint),claimedHitId:hitId,claimedHitLifeId:hitId?world[hitId].lifeId:null};
  }
  makeRespawnCommand(){ const prev=this.predictedTail(this.id); if(!prev||prev.alive)return null; const command=this.makeBaseCommand('respawn',prev); if(!command)return null; const p=clampWorldPoint(80+Math.random()*(WORLD_WIDTH-160),80+Math.random()*(WORLD_HEIGHT-160)); return {...command,spawnX:round6(p.x),spawnY:round6(p.y),nextLifeId:prev.lifeId+1}; }
  predictNextState(previous,command){ if(command.type==='move'){const r=computeMove(previous,command.dx,command.dy,command.tick);return {...previous,x:r.x,y:r.y,tick:command.tick,sequence:command.sequence,tentative:true};} if(command.type==='heal')return {...previous,hp:Math.min(MAX_HP,previous.hp+1),tick:command.tick,sequence:command.sequence,tentative:true}; if(command.type==='respawn')return {...previous,x:command.spawnX,y:command.spawnY,hp:MAX_HP,alive:true,lifeId:command.nextLifeId,tick:command.tick,sequence:command.sequence,deadObservedAt:0,tentative:true}; return {...previous,tick:command.tick,sequence:command.sequence,tentative:true}; }
  validateEnvelope(command){
    if(!command||command.protocol!==PROTOCOL||command.rulesetRevision!==RULESET_REVISION||!['move','shoot','heal','respawn'].includes(command.type))return 'bad envelope';
    if(typeof command.assignmentId!=='string'||!Number.isSafeInteger(command.topologyEpoch))return 'missing assignment';
    const p=this.policyFor(command.playerId,command.assignmentId); if(!p||p.topologyEpoch!==command.topologyEpoch)return 'unknown server assignment';
    if(!Number.isFinite(command.aoiRadius)||command.aoiRadius<MIN_AOI_RADIUS||command.aoiRadius>MAX_AOI_RADIUS)return 'invalid AOI';
    return null;
  }
  acceptCommand(command){
    const envelope=this.validateEnvelope(command); if(envelope)return {ok:false,reason:envelope}; const previous=this.predictedTail(command.playerId); if(!previous)return {ok:false,reason:'missing previous state'};
    const expected=(this.confirmedWorld[command.playerId]?.sequence||0)+(this.pendingOrderByPlayer.get(command.playerId)||[]).length+1; if(command.sequence!==expected)return {ok:false,reason:`sequence expected=${expected} got=${command.sequence}`}; if(stateHash(previous)!==command.previousStateHash)return {ok:false,reason:'previousStateHash mismatch'};
    const pending={command,previousState:{...previous},nextState:this.predictNextState(previous,command),verdict:null,rejectReason:null}; this.pendingById.set(command.commandId,pending); const order=this.pendingOrderByPlayer.get(command.playerId)||[]; order.push(command.commandId); this.pendingOrderByPlayer.set(command.playerId,order);
    const orphan=this.orphanCertificates.get(command.commandId); if(orphan){ this.orphanCertificates.delete(command.commandId); this.applyCertificate(orphan); }
    if(command.type==='move'&&!pending.verdict){ const result=this.validateCommand(command); pending.verdict=result.accepted?'accepted':'rejected'; pending.rejectReason=result.reason; this.drain(command.playerId); }
    else if(!pending.verdict){ const policy=this.policyFor(command.playerId,command.assignmentId); if(!policy?.quorum){ const result=this.validateCommand(command); pending.verdict=result.accepted?'accepted':'rejected'; pending.rejectReason=result.reason; this.drain(command.playerId); } }
    return {ok:true,pending};
  }
  validateCommand(command){
    const pending=this.pendingById.get(command.commandId); if(!pending)return {accepted:false,reason:'missing pending'}; const previous=pending.previousState;
    if(command.tick<previous.tick)return {accepted:false,reason:`tick regression previous=${previous.tick} got=${command.tick}`};
    if(command.type==='move'){const r=computeMove(previous,command.dx,command.dy,command.tick);const accepted=previous.alive&&!r.speedViolation&&!r.tickViolation&&r.x===command.claimedX&&r.y===command.claimedY&&inBounds(r.x,r.y);return {accepted,reason:accepted?'move verified':`move invalid distance=${r.distance} max=${r.maxStep}`,computed:r};}
    if(command.type==='shoot'){const len=Math.hypot(command.dirX,command.dirY),originMatches=Math.hypot(previous.x-command.originX,previous.y-command.originY)<1.5;if(!Array.isArray(command.checkpoint)||command.checkpoint.length>64)return {accepted:false,reason:'checkpoint shape'};const world=Object.create(null),seen=new Set();let shooterSeen=false;for(const item of command.checkpoint){if(!item||typeof item.playerId!=='string'||seen.has(item.playerId)||!Number.isFinite(item.x)||!Number.isFinite(item.y)||!Number.isSafeInteger(item.lifeId)||!inBounds(item.x,item.y))return {accepted:false,reason:'checkpoint item'};seen.add(item.playerId);world[item.playerId]=item;if(item.playerId===command.playerId){shooterSeen=true;if(Math.hypot(previous.x-item.x,previous.y-item.y)>1.5||item.lifeId!==previous.lifeId)return {accepted:false,reason:'shooter checkpoint mismatch'};}const local=item.playerId===command.playerId?previous:this.confirmedWorld[item.playerId];if(local&&Math.hypot(local.x-item.x,local.y-item.y)>3.5)return {accepted:false,reason:'known checkpoint mismatch'};if(local&&local.lifeId!==item.lifeId)return {accepted:false,reason:'known life mismatch'};}const hit=rayHit(command.originX,command.originY,command.dirX,command.dirY,world,command.playerId),life=hit?world[hit]?.lifeId:null;const accepted=previous.alive&&shooterSeen&&Math.abs(len-1)<0.02&&originMatches&&stableHash(command.checkpoint)===command.checkpointHash&&hit===command.claimedHitId&&life===command.claimedHitLifeId;return {accepted,reason:accepted?'shoot verified':'shoot invalid',computed:{hit,life}};}
    if(command.type==='heal'){const accepted=previous.alive&&previous.hp<MAX_HP&&command.claimedHp===previous.hp+1;return {accepted,reason:accepted?'heal verified':'heal invalid'};}
    if(command.type==='respawn'){const deathAge=performance.now()-(previous.deadObservedAt||0);const accepted=!previous.alive&&deathAge>=RESPAWN_MS-300&&command.nextLifeId===previous.lifeId+1&&inBounds(command.spawnX,command.spawnY);return {accepted,reason:accepted?'respawn verified':`respawn invalid deadAge=${Math.round(deathAge)}ms`};}
    return {accepted:false,reason:'unsupported'};
  }
  makeVerificationReceipt(command){ const result=this.validateCommand(command); return {protocol:PROTOCOL,rulesetRevision:RULESET_REVISION,commandId:command.commandId,playerId:command.playerId,sequence:command.sequence,assignmentId:command.assignmentId,decision:result.accepted?'accept':'reject',reason:result.reason,computedHash:stableHash(result.computed||null),evidenceHash:stableHash(command)}; }
  applyCertificate(cert){
    if(!cert||cert.playerId==null||cert.assignmentId==null)return false; const pending=this.pendingById.get(cert.commandId); if(!pending){ this.orphanCertificates.set(cert.commandId,cert); setTimeout(()=>this.orphanCertificates.delete(cert.commandId),10_000); return false; }
    const c=pending.command; if(cert.playerId!==c.playerId||cert.sequence!==c.sequence||cert.assignmentId!==c.assignmentId)return false; pending.verdict=cert.verdict==='accepted'?'accepted':'rejected'; pending.certificateServerTime=Number.isFinite(cert.serverTime)?cert.serverTime:null; pending.rejectReason=cert.verdict==='accepted'?null:'server certificate rejected'; this.drain(c.playerId); return true;
  }
  drain(playerId){ while(true){ const expected=(this.confirmedWorld[playerId]?.sequence||0)+1,order=this.pendingOrderByPlayer.get(playerId)||[],id=order.find(cid=>this.pendingById.get(cid)?.command.sequence===expected); if(!id)break; const p=this.pendingById.get(id); if(!p.verdict)break; if(p.verdict==='accepted')this.commit(p); else this.reject(p); } }
  commit(p){ const c=p.command; let state={...p.nextState,tentative:false},current=this.confirmedWorld[c.playerId]||p.previousState; if(c.type==='move'||c.type==='shoot')state={...state,hp:current.hp,alive:current.alive,lifeId:current.lifeId,deadObservedAt:current.deadObservedAt,deadServerAt:Number(current.deadServerAt)||0}; else if(c.type==='heal')state={...state,hp:current.alive?Math.min(MAX_HP,current.hp+1):current.hp,alive:current.alive,lifeId:current.lifeId,deadObservedAt:current.deadObservedAt,deadServerAt:Number(current.deadServerAt)||0}; this.confirmedWorld[c.playerId]=state; this.tickAnchors.set(c.playerId,{remoteTick:c.tick,localTime:performance.now()}); this._removePending(c); if(c.playerId===this.id)this.localSequence=Math.max(this.localSequence,c.sequence); if(c.type==='shoot'&&c.claimedHitId){const victim=this.confirmedWorld[c.claimedHitId];if(victim?.alive&&victim.lifeId===c.claimedHitLifeId){victim.hp=Math.max(0,victim.hp-1);if(victim.hp===0){victim.alive=false;victim.deadObservedAt=performance.now();victim.deadServerAt=Number.isFinite(p.certificateServerTime)?p.certificateServerTime:Date.now();}}} }
  reject(p){ const c=p.command; this._removePending(c); const order=this.pendingOrderByPlayer.get(c.playerId)||[]; for(const id of [...order]){const other=this.pendingById.get(id);if(other&&other.command.sequence>c.sequence)this.pendingById.delete(id);} this.pendingOrderByPlayer.set(c.playerId,order.filter(id=>this.pendingById.has(id))); if(c.playerId===this.id)this.localSequence=(this.confirmedWorld[this.id]?.sequence||0)+(this.pendingOrderByPlayer.get(this.id)||[]).length; }
  _removePending(c){ this.pendingById.delete(c.commandId); this.pendingOrderByPlayer.set(c.playerId,(this.pendingOrderByPlayer.get(c.playerId)||[]).filter(id=>id!==c.commandId)); }
}

module.exports={PROTOCOL,RULESET_REVISION,WORLD_WIDTH,WORLD_HEIGHT,WORLD_MARGIN,DEFAULT_AOI_RADIUS,MIN_AOI_RADIUS,MAX_AOI_RADIUS,MAX_RANGE,HIT_RADIUS,MAX_HP,RESPAWN_MS,round6,stableHash,stateHash,clampWorldPoint,inBounds,computeMove,rayHit,verificationRequired,ProtocolState};
