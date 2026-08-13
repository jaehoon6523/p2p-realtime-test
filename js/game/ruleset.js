'use strict';

const RULE_DISPOSITION = Object.freeze({
    ACCEPT:'ACCEPT',
    REJECT:'REJECT',
    DEFER:'DEFER',
    RESYNC:'RESYNC',
    FAULT:'FAULT',
});

function allowedStepForTicks(previousTick,commandTick){
    const elapsedTicks=Math.max(1,Math.min(MAX_TICK_ADVANCE,commandTick-previousTick));
    const elapsedSteps=elapsedTicks/(STEP_INTERVAL_MS/TICK_MS);
    return BASE_MAX_STEP*Math.max(1,elapsedSteps)*STEP_JITTER_ALLOWANCE+STEP_EPSILON;
}

function computeMove(prev,dx,dy,tick){
    const maxStep=allowedStepForTicks(prev.tick,tick);
    const distance=Math.hypot(dx,dy);
    const scale=distance>maxStep&&distance>0?maxStep/distance:1;
    const point=clampWorldPoint(prev.x+dx*scale,prev.y+dy*scale);
    return {x:round6(point.x),y:round6(point.y),distance:round6(distance),maxStep:round6(maxStep),speedViolation:distance>maxStep+1e-9,tickViolation:tick<prev.tick};
}

// Partial-synchrony rule: timing uncertainty first becomes DEFER, not REJECT.
// This is deliberately tolerant of ordinary RTT/jitter. Only grossly implausible time is a fault candidate.
function checkCommandTick(playerId,tick,previousTick){
    if(tick<previousTick){
        return {disposition:RULE_DISPOSITION.REJECT,code:'TICK_REGRESSION',reason:`tick regression previous=${previousTick} got=${tick}`,advanceTick:false};
    }

    if(playerId===myId){
        const max=currentTick()+6;
        if(tick<=max) return {disposition:RULE_DISPOSITION.ACCEPT,code:'TICK_OK',reason:'local tick ok',advanceTick:true};
        return {disposition:RULE_DISPOSITION.RESYNC,code:'LOCAL_CLOCK_DRIFT',reason:`future local tick got=${tick} max=${max}`,advanceTick:false};
    }

    const anchor=tickAnchors.get(playerId);
    if(!anchor){
        const hard=previousTick+MAX_TICK_ADVANCE;
        if(tick<=hard) return {disposition:RULE_DISPOSITION.ACCEPT,code:'TICK_UNANCHORED_OK',reason:'unanchored tick within bounded advance',advanceTick:true};
        return {disposition:RULE_DISPOSITION.RESYNC,code:'TICK_UNANCHORED_FAR',reason:`unanchored future tick got=${tick} max=${hard}`,advanceTick:false};
    }

    const elapsed=Math.max(0,Math.floor((performance.now()-anchor.localTime)/TICK_MS));
    const expected=anchor.remoteTick+elapsed;
    const softMax=expected+REMOTE_TICK_SOFT_AHEAD;
    const hardMax=expected+REMOTE_TICK_HARD_AHEAD;
    if(tick<=softMax) return {disposition:RULE_DISPOSITION.ACCEPT,code:'TICK_OK',reason:`remote tick ok expected~${expected} got=${tick}`,advanceTick:true};
    if(tick<=hardMax){
        const retryMs=Math.max(TEMPORAL_RETRY_MIN_MS,(tick-softMax)*TICK_MS);
        return {disposition:RULE_DISPOSITION.DEFER,code:'TICK_AHEAD',reason:`remote tick slightly ahead expected~${expected} got=${tick} softMax=${softMax}`,retryMs,advanceTick:false};
    }
    return {disposition:RULE_DISPOSITION.FAULT,code:'TICK_FAR_FUTURE',reason:`remote tick implausibly ahead expected~${expected} got=${tick} hardMax=${hardMax}`,advanceTick:false};
}

function inBounds(x,y){
    return Number.isFinite(x)&&Number.isFinite(y)&&x>=WORLD_MARGIN&&y>=WORLD_MARGIN&&x<=WORLD_WIDTH-WORLD_MARGIN&&y<=WORLD_HEIGHT-WORLD_MARGIN;
}

function predictNextState(previous,command){
    if(command.type==='move'){
        const result=computeMove(previous,command.dx,command.dy,command.tick);
        return {...previous,x:result.x,y:result.y,tick:command.tick,sequence:command.sequence,tentative:true};
    }
    if(command.type==='heal') return {...previous,hp:Math.min(MAX_HP,previous.hp+1),tick:command.tick,sequence:command.sequence,tentative:true};
    if(command.type==='respawn') return {...previous,x:command.spawnX,y:command.spawnY,hp:MAX_HP,alive:true,lifeId:command.nextLifeId,tick:command.tick,sequence:command.sequence,deadObservedAt:0,tentative:true};
    return {...previous,tick:command.tick,sequence:command.sequence,tentative:true};
}

function evaluateCommand(command,pendingOverride=null){
    const pending=pendingOverride||pendingById.get(command.commandId);
    if(!pending) return {disposition:RULE_DISPOSITION.RESYNC,code:'MISSING_PENDING',reason:'missing pending context',computed:null,advanceTick:false};
    const previous=pending.previousState;

    if(!commandPolicyMatches(command)){
        return {disposition:RULE_DISPOSITION.RESYNC,code:'ASSIGNMENT_MISMATCH',reason:'server assignment mismatch',computed:null,advanceTick:false};
    }

    const tickCheck=checkCommandTick(command.playerId,command.tick,previous.tick);
    if(tickCheck.disposition!==RULE_DISPOSITION.ACCEPT) return {...tickCheck,computed:null};

    if(command.type==='move'){
        const result=computeMove(previous,command.dx,command.dy,command.tick);
        const accepted=previous.alive&&!result.speedViolation&&!result.tickViolation&&result.x===command.claimedX&&result.y===command.claimedY&&inBounds(result.x,result.y);
        return accepted
            ? {disposition:RULE_DISPOSITION.ACCEPT,code:'MOVE_VALID',reason:'move verified',computed:result,advanceTick:true}
            : {disposition:RULE_DISPOSITION.REJECT,code:'MOVE_INVALID',reason:`move invalid distance=${result.distance} max=${result.maxStep}`,computed:result,advanceTick:true};
    }

    if(command.type==='shoot'){
        const length=Math.hypot(command.dirX,command.dirY);
        const originMatches=Math.hypot(previous.x-command.originX,previous.y-command.originY)<1.5;
        const checkpointOk=stableHash(command.checkpoint)===command.checkpointHash&&checkpointMatchesLocal(command.checkpoint,command.playerId,previous);
        const world=Object.create(null);
        for(const item of command.checkpoint) world[item.playerId]=item;
        const hit=rayHit(command.originX,command.originY,command.dirX,command.dirY,world,command.playerId);
        const life=hit?world[hit]?.lifeId:null;
        const accepted=previous.alive&&Math.abs(length-1)<0.02&&originMatches&&checkpointOk&&hit===command.claimedHitId&&life===command.claimedHitLifeId;
        return accepted
            ? {disposition:RULE_DISPOSITION.ACCEPT,code:'SHOOT_VALID',reason:'shoot verified',computed:{hit,life},advanceTick:true}
            : {disposition:RULE_DISPOSITION.REJECT,code:'SHOOT_INVALID',reason:`shoot invalid hit=${hit||'none'} checkpoint=${checkpointOk}`,computed:{hit,life},advanceTick:true};
    }

    if(command.type==='heal'){
        const accepted=previous.alive&&previous.hp<MAX_HP&&command.claimedHp===previous.hp+1;
        return accepted
            ? {disposition:RULE_DISPOSITION.ACCEPT,code:'HEAL_VALID',reason:'heal verified',computed:null,advanceTick:true}
            : {disposition:RULE_DISPOSITION.REJECT,code:'HEAL_INVALID',reason:'heal invalid state',computed:null,advanceTick:true};
    }

    if(command.type==='respawn'){
        if(previous.alive) return {disposition:RULE_DISPOSITION.REJECT,code:'RESPAWN_WHILE_ALIVE',reason:'respawn while alive',computed:null,advanceTick:true};
        const deathAge=performance.now()-(previous.deadObservedAt||0);
        if(deathAge<RESPAWN_MS-300){
            return {disposition:RULE_DISPOSITION.DEFER,code:'RESPAWN_EARLY',reason:`respawn waiting deadAge=${Math.round(deathAge)}ms`,retryMs:Math.max(TEMPORAL_RETRY_MIN_MS,RESPAWN_MS-300-deathAge),computed:null,advanceTick:false};
        }
        const accepted=command.nextLifeId===previous.lifeId+1&&inBounds(command.spawnX,command.spawnY);
        return accepted
            ? {disposition:RULE_DISPOSITION.ACCEPT,code:'RESPAWN_VALID',reason:'respawn verified',computed:null,advanceTick:true}
            : {disposition:RULE_DISPOSITION.REJECT,code:'RESPAWN_INVALID',reason:'respawn invalid state',computed:null,advanceTick:true};
    }

    return {disposition:RULE_DISPOSITION.FAULT,code:'UNSUPPORTED_COMMAND',reason:'unsupported command',computed:null,advanceTick:false};
}

function checkpointMatchesLocal(checkpoint,shooterId,shooterState){
    if(!Array.isArray(checkpoint)||checkpoint.length>64) return false;
    const seen=new Set(); let shooterSeen=false;
    for(const item of checkpoint){
        if(!item||typeof item.playerId!=='string'||seen.has(item.playerId)||![item.x,item.y].every(Number.isFinite)||!Number.isSafeInteger(item.lifeId)||!inBounds(item.x,item.y)) return false;
        seen.add(item.playerId);
        if(item.playerId===shooterId){
            shooterSeen=true;
            if(Math.hypot(shooterState.x-item.x,shooterState.y-item.y)>1.5||item.lifeId!==shooterState.lifeId) return false;
        }
        const local=item.playerId===shooterId?shooterState:confirmedWorld[item.playerId];
        // Evidence is self-contained, but direct local knowledge is used as an additional consistency check.
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
