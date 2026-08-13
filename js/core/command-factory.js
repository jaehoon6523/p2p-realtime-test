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
    for(const item of deferredCommands.values()) if(item.command.playerId===myId) deferred++;
    return pending+deferred>=MAX_LOCAL_PENDING;
}

function makeBaseCommand(type,previous){
    if(localCommandBackpressured()) return null;
    const sequence=++localSequence;
    const membership=membershipDescriptor();
    return {
        protocol:PROTOCOL,
        rulesetRevision:RULESET_REVISION,
        type,
        commandId:createCommandId(myId,sequence),
        playerId:myId,
        sequence,
        previousStateHash:stateHash(previous),
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
    const command=makeBaseCommand('move',prev);
    if(!command) return null;
    const result=computeMove(prev,safeDx,safeDy,command.tick);
    return {...command,dx:round6(safeDx),dy:round6(safeDy),claimedX:result.x,claimedY:result.y};
}

function buildShootCheckpoint(shooter){
    const membership=membershipDescriptor();
    const checkpoint=[];
    const world=Object.create(null);
    const interestRadius=Math.max(AOI_RADIUS,MAX_RANGE+HIT_RADIUS+24);
    for(const id of [myId,...directOpenPeerIds()]){
        const state=id===myId?shooter:confirmedWorld[id];
        if(!state) continue;
        if(id!==myId&&distanceBetweenStates(shooter,state)>interestRadius) continue;
        const item={playerId:id,x:round6(state.x),y:round6(state.y),alive:Boolean(state.alive),lifeId:state.lifeId,sequence:state.sequence};
        checkpoint.push(item);
        world[id]=item;
    }
    checkpoint.sort((a,b)=>a.playerId.localeCompare(b.playerId));
    networkMetrics.lastCheckpointPlayers=checkpoint.length;
    return {membership,checkpoint,world};
}

function makeShootCommand(dirX,dirY){
    const shooter=getPredictedTail(myId);
    if(!shooter||!shooter.alive) return null;
    const data=buildShootCheckpoint(shooter);
    if(!data){ log('t-warn','shoot blocked: checkpoint incomplete'); return null; }
    const command=makeBaseCommand('shoot',shooter);
    if(!command) return null;
    const originX=round6(shooter.x),originY=round6(shooter.y);
    const hitId=rayHit(originX,originY,dirX,dirY,data.world,myId);
    return {...command,originX,originY,dirX:round6(dirX),dirY:round6(dirY),checkpoint:data.checkpoint,checkpointHash:stableHash(data.checkpoint),claimedHitId:hitId,claimedHitLifeId:hitId?data.world[hitId].lifeId:null};
}

function makeHealCommand(){
    const prev=getPredictedTail(myId);
    if(!prev||!prev.alive||prev.hp>=MAX_HP) return null;
    const command=makeBaseCommand('heal',prev);
    if(!command) return null;
    return {...command,claimedHp:prev.hp+1};
}

function makeRespawnCommand(){
    const prev=getPredictedTail(myId);
    if(!prev||prev.alive) return null;
    const command=makeBaseCommand('respawn',prev);
    if(!command) return null;
    return {...command,spawnX:round6(randomSpawnX()),spawnY:round6(randomSpawnY()),nextLifeId:prev.lifeId+1};
}
