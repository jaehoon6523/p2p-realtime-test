'use strict';

function allowedStepForTicks(previousTick,commandTick){
    const elapsedTicks=Math.max(1,Math.min(MAX_TICK_ADVANCE,commandTick-previousTick));
    const elapsedSteps=elapsedTicks/(STEP_INTERVAL_MS/TICK_MS);
    return BASE_MAX_STEP*Math.max(1,elapsedSteps)*STEP_JITTER_ALLOWANCE+STEP_EPSILON;
}
function computeMove(prev,dx,dy,tick){
    const maxStep=allowedStepForTicks(prev.tick,tick); const distance=Math.hypot(dx,dy); const scale=distance>maxStep&&distance>0?maxStep/distance:1;
    const point=clampWorldPoint(prev.x+dx*scale,prev.y+dy*scale);
    return {x:round6(point.x),y:round6(point.y),distance:round6(distance),maxStep:round6(maxStep),speedViolation:distance>maxStep+1e-9,tickViolation:tick<prev.tick};
}
function checkCommandTick(playerId,tick,previousTick){
    if(tick<previousTick) return {ok:false,reason:`tick regression previous=${previousTick} got=${tick}`};
    if(playerId===myId){ const max=currentTick()+6; return tick<=max?{ok:true}:{ok:false,reason:`future local tick got=${tick} max=${max}`}; }
    const anchor=tickAnchors.get(playerId);
    if(!anchor){ const max=previousTick+MAX_TICK_ADVANCE; return tick<=max?{ok:true}:{ok:false,reason:`unanchored future tick got=${tick} max=${max}`}; }
    const elapsed=Math.max(0,Math.floor((performance.now()-anchor.localTime)/TICK_MS)); const max=anchor.remoteTick+elapsed+12;
    return tick<=max?{ok:true}:{ok:false,reason:`future remote tick got=${tick} max=${max}`};
}
function inBounds(x,y){ return Number.isFinite(x)&&Number.isFinite(y)&&x>=WORLD_MARGIN&&y>=WORLD_MARGIN&&x<=WORLD_WIDTH-WORLD_MARGIN&&y<=WORLD_HEIGHT-WORLD_MARGIN; }

function predictNextState(previous,command){
    if(command.type==='move'){
        const result=computeMove(previous,command.dx,command.dy,command.tick);
        return {...previous,x:result.x,y:result.y,tick:command.tick,sequence:command.sequence,tentative:true};
    }
    if(command.type==='heal') return {...previous,hp:Math.min(MAX_HP,previous.hp+1),tick:command.tick,sequence:command.sequence,tentative:true};
    if(command.type==='respawn') return {...previous,x:command.spawnX,y:command.spawnY,hp:MAX_HP,alive:true,lifeId:command.nextLifeId,tick:command.tick,sequence:command.sequence,deadObservedAt:0,tentative:true};
    return {...previous,tick:command.tick,sequence:command.sequence,tentative:true};
}
function evaluateCommand(command){
    const pending=pendingById.get(command.commandId); if(!pending) return {accepted:false,reason:'missing pending',computed:null};
    const previous=pending.previousState;
    const tickCheck=checkCommandTick(command.playerId,command.tick,previous.tick);
    if(!tickCheck.ok) return {accepted:false,reason:tickCheck.reason,computed:null};
    if(!commandPolicyMatches(command)) return {accepted:false,reason:'server assignment mismatch',computed:null};
    if(command.tick<previous.tick) return {accepted:false,reason:`tick regression previous=${previous.tick} got=${command.tick}`,computed:null};
    if(command.type==='move'){
        const result=computeMove(previous,command.dx,command.dy,command.tick);
        const accepted=previous.alive&&!result.speedViolation&&!result.tickViolation&&result.x===command.claimedX&&result.y===command.claimedY&&inBounds(result.x,result.y);
        return {accepted,reason:accepted?'move verified':`move invalid distance=${result.distance} max=${result.maxStep}`,computed:result};
    }
    if(command.type==='shoot'){
        const length=Math.hypot(command.dirX,command.dirY);
        const originMatches=Math.hypot(previous.x-command.originX,previous.y-command.originY)<1.5;
        const checkpointOk=stableHash(command.checkpoint)===command.checkpointHash&&checkpointMatchesLocal(command.checkpoint,command.playerId,previous);
        const world=Object.create(null); for(const item of command.checkpoint) world[item.playerId]=item;
        const hit=rayHit(command.originX,command.originY,command.dirX,command.dirY,world,command.playerId);
        const life=hit?world[hit]?.lifeId:null;
        const accepted=previous.alive&&Math.abs(length-1)<0.02&&originMatches&&checkpointOk&&hit===command.claimedHitId&&life===command.claimedHitLifeId;
        return {accepted,reason:accepted?'shoot verified':`shoot invalid hit=${hit||'none'} checkpoint=${checkpointOk}`,computed:{hit,life}};
    }
    if(command.type==='heal'){
        const accepted=previous.alive&&previous.hp<MAX_HP&&command.claimedHp===previous.hp+1;
        return {accepted,reason:accepted?'heal verified':'heal invalid state',computed:null};
    }
    if(command.type==='respawn'){
        const deathAge=performance.now()-(previous.deadObservedAt||0);
        const accepted=!previous.alive&&deathAge>=RESPAWN_MS-300&&command.nextLifeId===previous.lifeId+1&&inBounds(command.spawnX,command.spawnY);
        return {accepted,reason:accepted?'respawn verified':`respawn invalid deadAge=${Math.round(deathAge)}ms`,computed:null};
    }
    return {accepted:false,reason:'unsupported',computed:null};
}

function checkpointMatchesLocal(checkpoint,shooterId,shooterState){
    if(!Array.isArray(checkpoint)||checkpoint.length>64) return false;
    const seen=new Set(); let shooterSeen=false;
    for(const item of checkpoint){
        if(!item||typeof item.playerId!=='string'||seen.has(item.playerId)||![item.x,item.y].every(Number.isFinite)||!Number.isSafeInteger(item.lifeId)||!inBounds(item.x,item.y)) return false;
        seen.add(item.playerId);
        if(item.playerId===shooterId){ shooterSeen=true; if(Math.hypot(shooterState.x-item.x,shooterState.y-item.y)>1.5||item.lifeId!==shooterState.lifeId) return false; }
        const local=item.playerId===shooterId?shooterState:confirmedWorld[item.playerId];
        // Evidence is self-contained; if this verifier also has the actor directly, cross-check it.
        if(local&&Math.hypot(local.x-item.x,local.y-item.y)>3.5) return false;
        if(local&&local.lifeId!==item.lifeId) return false;
    }
    return shooterSeen;
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
