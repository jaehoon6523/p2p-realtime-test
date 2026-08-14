'use strict';

function getPredictedTail(playerId){
    const ids=pendingOrderByPlayer.get(playerId)||[];
    for(let i=ids.length-1;i>=0;i--){
        const pending=pendingById.get(ids[i]);
        if(pending?.nextState) return pending.nextState;
    }
    return confirmedWorld[playerId]||null;
}

function localCommandBackpressured(){
    const pending=(pendingOrderByPlayer.get(myId)||[]).length;
    let deferred=0;
    for(const item of deferredCommands.values()) if(item.command.playerId===myId&&commandStream(item.command)==='simulation') deferred++;
    return pending+deferred>=MAX_LOCAL_PENDING;
}

function localEventBackpressured(){
    const pending=(pendingEventOrderByPlayer.get(myId)||[]).length;
    let deferred=0;
    for(const item of deferredCommands.values()) if(item.command.playerId===myId&&commandStream(item.command)==='event') deferred++;
    return pending+deferred>=MAX_LOCAL_EVENT_PENDING;
}

function makeSimulationBaseCommand(type,previous){
    if(localCommandBackpressured()) return null;
    const sequence=++localSequence;
    const membership=membershipDescriptor();
    return {
        protocol:PROTOCOL,
        rulesetRevision:RULESET_REVISION,
        stream:'simulation',
        type,
        commandId:createCommandId(myId,sequence,'simulation'),
        playerId:myId,
        sequence,
        previousStateHash:stateHash(previous),
        tick:currentTick(),
        topologyEpoch:membership.topologyEpoch,
        assignmentId:membership.assignmentId,
        aoiRadius:AOI_RADIUS,
    };
}

function makeEventBaseCommand(type){
    if(localEventBackpressured()) return null;
    const eventSeq=++localEventSequence;
    const membership=membershipDescriptor();
    return {
        protocol:PROTOCOL,
        rulesetRevision:RULESET_REVISION,
        stream:'event',
        type,
        commandId:createCommandId(myId,eventSeq,'event'),
        playerId:myId,
        eventSeq,
        tick:currentTick(),
        topologyEpoch:membership.topologyEpoch,
        assignmentId:membership.assignmentId,
        aoiRadius:AOI_RADIUS,
    };
}

function makeMoveCommand(dx,dy){
    const prev=getPredictedTail(myId);
    if(!prev||!prev.alive) return null;
    const desired=clampWorldPoint(prev.x+dx,prev.y+dy);
    const safeDx=desired.x-prev.x,safeDy=desired.y-prev.y;
    if(Math.abs(safeDx)<=1e-9&&Math.abs(safeDy)<=1e-9) return null;
    const command=makeSimulationBaseCommand('move',prev);
    if(!command) return null;
    const result=computeMove(prev,safeDx,safeDy,command.tick);
    return {...command,dx:round6(safeDx),dy:round6(safeDy),claimedX:result.x,claimedY:result.y};
}

function buildShootCheckpoint(shooter){
    const checkpoint=[];
    const world=Object.create(null);
    const interestRadius=Math.max(AOI_RADIUS,MAX_COMBAT_RANGE+HIT_RADIUS+24);
    for(const id of [myId,...directOpenPeerIds()]){
        const state=id===myId?shooter:confirmedWorld[id];
        if(!state) continue;
        if(id!==myId&&distanceBetweenStates(shooter,state)>interestRadius) continue;
        const item={playerId:id,x:round6(state.x),y:round6(state.y),alive:Boolean(state.alive),lifeId:state.lifeId,sequence:state.sequence,tick:state.tick};
        checkpoint.push(item);
        world[id]=item;
    }
    checkpoint.sort((a,b)=>a.playerId.localeCompare(b.playerId));
    networkMetrics.lastCheckpointPlayers=checkpoint.length;
    return {checkpoint,world};
}

function pendingShootCount(playerId){
    return (pendingEventOrderByPlayer.get(playerId)||[]).reduce((count,id)=>count+(pendingById.get(id)?.command?.type==='shoot'?1:0),0);
}
function suppressShoot(code,detail=''){
    log('warn',`SHOOT_SUPPRESSED code=${code}${detail?` ${detail}`:''}`);
    return null;
}

function abilityRefFromCommand(command){
    if(!command?.abilitySeq) return null;
    return {
        abilitySeq:command.abilitySeq,
        abilityId:command.abilityId,
        castStartTick:command.castStartTick,
        releaseTick:command.tick,
        abilityHash:abilityEvidenceHash(command),
    };
}
function nextAbilityContext(ability,castStartTick){
    const abilitySeq=++localAbilitySequence;
    return {
        abilitySeq,
        castStartTick,
        previousAbilityRef:lastLocalAbilityRef?{...lastLocalAbilityRef}:null,
        previousSameAbilityRef:lastLocalAbilityRefById.get(ability.id)?{...lastLocalAbilityRefById.get(ability.id)}:null,
    };
}
function registerLocalAbilityIssued(command){
    const ref=abilityRefFromCommand(command);
    if(!ref) return;
    lastLocalAbilityRef=ref;
    lastLocalAbilityRefById.set(command.abilityId,ref);
}

function makeShootCommand(dirX,dirY,abilityId='basic_attack',castStartTick=currentTick()){
    const ability=ABILITY_BY_ID[abilityId];
    if(!ability||ability.kind!=='shoot') return suppressShoot('ABILITY_UNKNOWN',`ability=${abilityId}`);
    const shooter=getPredictedTail(myId);
    if(!shooter) return suppressShoot('NO_LOCAL_STATE');
    if(!shooter.alive) return suppressShoot('DEAD',`life=${shooter.lifeId}`);
    const unresolved=pendingShootCount(myId);
    if(unresolved>=MAX_PENDING_SHOOTS) return suppressShoot('EVENT_BACKPRESSURE',`pendingShoot=${unresolved}/${MAX_PENDING_SHOOTS}`);
    const length=Math.hypot(dirX,dirY);
    if(!Number.isFinite(length)||length<1e-9) return suppressShoot('INVALID_AIM');
    const aimX=round6(dirX/length),aimY=round6(dirY/length);
    const data=buildShootCheckpoint(shooter);
    const abilityContext=nextAbilityContext(ability,castStartTick);
    const command=makeEventBaseCommand('shoot');
    if(!command){ localAbilitySequence--; return suppressShoot('EVENT_BACKPRESSURE',`pendingEvent=${(pendingEventOrderByPlayer.get(myId)||[]).length}/${MAX_LOCAL_EVENT_PENDING}`); }
    const hitId=rayHit(shooter.x,shooter.y,aimX,aimY,data.world,myId,ability.range);
    const result={
        ...command,
        abilityId:ability.id,
        ...abilityContext,
        simulationRef:{sequence:shooter.sequence,stateHash:simulationRefHash(shooter)},
        aimX,aimY,
        checkpoint:data.checkpoint,
        checkpointHash:stableHash(data.checkpoint),
        claimedHitId:hitId,
        claimedHitLifeId:hitId?data.world[hitId].lifeId:null,
    };
    registerLocalAbilityIssued(result);
    return result;
}

function makeDashCommand(dirX,dirY,castStartTick=currentTick()){
    const ability=ABILITY_DEFINITIONS.E;
    const prev=getPredictedTail(myId);
    if(!prev||!prev.alive) return null;
    const length=Math.hypot(dirX,dirY);
    if(!Number.isFinite(length)||length<1e-9) return null;
    const nx=dirX/length,ny=dirY/length;
    const desired=clampWorldPoint(prev.x+nx*ability.distance,prev.y+ny*ability.distance);
    const dx=round6(desired.x-prev.x),dy=round6(desired.y-prev.y);
    if(Math.hypot(dx,dy)<1e-9) return null;
    const abilityContext=nextAbilityContext(ability,castStartTick);
    const command=makeSimulationBaseCommand('dash',prev);
    if(!command){ localAbilitySequence--; return null; }
    const result={...command,abilityId:ability.id,...abilityContext,dx,dy,claimedX:round6(desired.x),claimedY:round6(desired.y)};
    registerLocalAbilityIssued(result);
    return result;
}

function makeHealCommand(){
    const prev=getPredictedTail(myId);
    if(!prev||!prev.alive||prev.hp>=MAX_HP) return null;
    const command=makeSimulationBaseCommand('heal',prev);
    if(!command) return null;
    return {...command,claimedHp:prev.hp+1};
}

function makeRespawnCommand(){
    const prev=getPredictedTail(myId);
    if(!prev||prev.alive) return null;
    const command=makeSimulationBaseCommand('respawn',prev);
    if(!command) return null;
    return {...command,spawnX:round6(randomSpawnX()),spawnY:round6(randomSpawnY()),nextLifeId:prev.lifeId+1};
}
