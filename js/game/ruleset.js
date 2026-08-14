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
        if(tick<=hard){ tickAnchors.set(playerId,{remoteTick:tick,localTime:performance.now()}); return {disposition:RULE_DISPOSITION.ACCEPT,code:'TICK_UNANCHORED_OK',reason:'unanchored tick within bounded advance',advanceTick:true}; }
        return {disposition:RULE_DISPOSITION.RESYNC,code:'TICK_UNANCHORED_FAR',reason:`unanchored future tick got=${tick} max=${hard}`,advanceTick:false};
    }

    const elapsed=Math.max(0,Math.floor((performance.now()-anchor.localTime)/TICK_MS));
    const expected=anchor.remoteTick+elapsed;
    const softMax=expected+REMOTE_TICK_SOFT_AHEAD;
    const hardMax=expected+REMOTE_TICK_HARD_AHEAD;
    if(tick<=softMax){ if(tick>anchor.remoteTick) tickAnchors.set(playerId,{remoteTick:tick,localTime:performance.now()}); return {disposition:RULE_DISPOSITION.ACCEPT,code:'TICK_OK',reason:`remote tick ok expected~${expected} got=${tick}`,advanceTick:true}; }
    if(tick<=hardMax){
        const retryMs=Math.max(TEMPORAL_RETRY_MIN_MS,(tick-softMax)*TICK_MS);
        return {disposition:RULE_DISPOSITION.DEFER,code:'TICK_AHEAD',reason:`remote tick slightly ahead expected~${expected} got=${tick} softMax=${softMax}`,retryMs,advanceTick:false};
    }
    return {disposition:RULE_DISPOSITION.RESYNC,code:'CLOCK_MODEL_DIVERGED',reason:`remote tick exceeds current clock model expected~${expected} got=${tick} hardMax=${hardMax}`,advanceTick:false};
}

function inBounds(x,y){
    return Number.isFinite(x)&&Number.isFinite(y)&&x>=WORLD_MARGIN&&y>=WORLD_MARGIN&&x<=WORLD_WIDTH-WORLD_MARGIN&&y<=WORLD_HEIGHT-WORLD_MARGIN;
}

function predictNextState(previous,command){
    if(command.type==='move'){
        const result=computeMove(previous,command.dx,command.dy,command.tick);
        return {...previous,x:result.x,y:result.y,tick:command.tick,sequence:command.sequence,tentative:true};
    }
    if(command.type==='dash') return {...previous,x:command.claimedX,y:command.claimedY,tick:command.tick,sequence:command.sequence,tentative:true};
    if(command.type==='heal') return {...previous,hp:Math.min(MAX_HP,previous.hp+1),tick:command.tick,sequence:command.sequence,tentative:true};
    if(command.type==='respawn') return {...previous,x:command.spawnX,y:command.spawnY,hp:MAX_HP,alive:true,lifeId:command.nextLifeId,tick:command.tick,sequence:command.sequence,deadObservedAt:0,tentative:true};
    return {...previous,tick:command.tick,sequence:command.sequence,tentative:true};
}

function evaluateAbilityContract(command){
    const ability=ABILITY_BY_ID[command.abilityId];
    if(!ability) return {disposition:RULE_DISPOSITION.REJECT,code:'ABILITY_UNKNOWN',reason:`unknown ability ${command.abilityId}`,computed:null,advanceTick:false};
    const timing=abilityTimingFor(ability);
    const castTicks=command.tick-command.castStartTick;
    if(timing.castTicks===0&&castTicks!==0) return {disposition:RULE_DISPOSITION.REJECT,code:'ABILITY_CAST_TOO_LATE',reason:`instant ability requires cast ticks=0 got=${castTicks}`,computed:{castTicks,timing},advanceTick:false};
    if(timing.castTicks>0&&castTicks<Math.max(1,timing.castTicks-1)) return {disposition:RULE_DISPOSITION.REJECT,code:'ABILITY_CAST_TOO_FAST',reason:`cast ticks=${castTicks} required~${timing.castTicks}`,computed:{castTicks,timing},advanceTick:false};
    if(timing.castTicks>0&&castTicks>timing.castTicks+6) return {disposition:RULE_DISPOSITION.REJECT,code:'ABILITY_CAST_TOO_LATE',reason:`cast ticks=${castTicks} expected~${timing.castTicks}`,computed:{castTicks,timing},advanceTick:false};

    const known=confirmedAbilitySeq.get(command.playerId)||0;
    if(command.abilitySeq>known+1) return {disposition:RULE_DISPOSITION.DEFER,code:'ABILITY_LINEAGE_PENDING',reason:`waiting abilitySeq=${known+1} before ${command.abilitySeq}`,computed:{known},advanceTick:false};
    if(command.abilitySeq<=known){
        const existing=finalizedAbilityRecord(command.playerId,command.abilitySeq);
        const same=existing&&existing.abilityHash===abilityEvidenceHash(command);
        return same
            ? {disposition:RULE_DISPOSITION.ACCEPT,code:'ABILITY_ALREADY_FINALIZED',reason:'ability lineage already finalized identically',computed:{abilitySeq:command.abilitySeq},advanceTick:false}
            : {disposition:RULE_DISPOSITION.FAULT,code:'ABILITY_EQUIVOCATION',reason:`abilitySeq ${command.abilitySeq} conflicts with finalized lineage`,computed:{abilitySeq:command.abilitySeq},advanceTick:false};
    }

    const previous=command.abilitySeq===1?null:finalizedAbilityRecord(command.playerId,command.abilitySeq-1);
    if(command.abilitySeq>1&&!previous) return {disposition:RULE_DISPOSITION.DEFER,code:'ABILITY_PREVIOUS_PENDING',reason:`waiting previous abilitySeq=${command.abilitySeq-1}`,computed:null,advanceTick:false};
    if(!abilityRefMatchesRecord(command.previousAbilityRef,previous)) return {disposition:RULE_DISPOSITION.REJECT,code:'ABILITY_PREVIOUS_REF_MISMATCH',reason:'previous ability reference mismatch',computed:null,advanceTick:false};

    if(previous){
        const previousAbility=ABILITY_BY_ID[previous.abilityId];
        const recoveryTicks=abilityTimingFor(previousAbility).recoveryTicks;
        const gap=command.castStartTick-previous.releaseTick;
        if(gap<Math.max(1,recoveryTicks-1)) return {disposition:RULE_DISPOSITION.REJECT,code:'ABILITY_RECOVERY_LOCK',reason:`recovery gap=${gap} required~${recoveryTicks}`,computed:{gap,recoveryTicks},advanceTick:false};
    }

    const previousSame=previousSameAbilityRecord(command.playerId,command.abilityId,command.abilitySeq);
    if(!abilityRefMatchesRecord(command.previousSameAbilityRef,previousSame)) return {disposition:RULE_DISPOSITION.REJECT,code:'ABILITY_COOLDOWN_REF_MISMATCH',reason:'same-ability cooldown reference mismatch',computed:null,advanceTick:false};
    if(previousSame){
        const gap=command.castStartTick-previousSame.castStartTick;
        if(gap<Math.max(1,timing.cooldownTicks-1)) return {disposition:RULE_DISPOSITION.REJECT,code:'ABILITY_COOLDOWN',reason:`cooldown gap=${gap} required~${timing.cooldownTicks}`,computed:{gap,cooldownTicks:timing.cooldownTicks},advanceTick:false};
    }
    return {disposition:RULE_DISPOSITION.ACCEPT,code:'ABILITY_VALID',reason:'ability timing and lineage verified',computed:{abilitySeq:command.abilitySeq,abilityId:command.abilityId,castTicks,timing},advanceTick:false};
}

function evaluateCommand(command,pendingOverride=null,{skipPolicyCheck=false}={}){
    const pending=pendingOverride||pendingById.get(command.commandId);
    if(!pending) return {disposition:RULE_DISPOSITION.RESYNC,code:'MISSING_PENDING',reason:'missing pending context',computed:null,advanceTick:false};
    const previous=pending.previousState;

    // Remote validator liveness must not depend on a locally cached copy of the actor policy.
    // The signaling server is the authority that binds assignmentId -> validatorIds/quorum and
    // rejects receipts from peers that are not validators for that assignment.
    if(!skipPolicyCheck&&!commandPolicyMatches(command)){
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

    if(command.type==='dash'){
        const abilityCheck=evaluateAbilityContract(command);
        if(abilityCheck.disposition!==RULE_DISPOSITION.ACCEPT) return abilityCheck;
        const ability=ABILITY_BY_ID[command.abilityId];
        const distance=Math.hypot(command.dx,command.dy);
        const point=clampWorldPoint(previous.x+command.dx,previous.y+command.dy);
        const accepted=previous.alive&&ability?.kind==='dash'&&distance<=ability.distance+0.01&&point.x===command.claimedX&&point.y===command.claimedY&&inBounds(point.x,point.y);
        return accepted
            ? {disposition:RULE_DISPOSITION.ACCEPT,code:'DASH_VALID',reason:'dash verified',computed:{x:point.x,y:point.y,distance,ability:abilityCheck.computed},advanceTick:true}
            : {disposition:RULE_DISPOSITION.REJECT,code:'DASH_INVALID',reason:`dash invalid distance=${distance.toFixed(2)}`,computed:{x:point.x,y:point.y,distance,ability:abilityCheck.computed},advanceTick:true};
    }

    if(command.type==='shoot'){
        const abilityCheck=evaluateAbilityContract(command);
        if(abilityCheck.disposition!==RULE_DISPOSITION.ACCEPT) return abilityCheck;
        const ability=ABILITY_BY_ID[command.abilityId];
        const length=Math.hypot(command.aimX,command.aimY);
        const refMatches=command.simulationRef?.sequence===previous.sequence&&command.simulationRef?.stateHash===simulationRefHash(previous);
        const checkpointOk=stableHash(command.checkpoint)===command.checkpointHash&&checkpointMatchesLocal(command.checkpoint,command.playerId,previous,command.simulationRef);
        const world=Object.create(null);
        for(const item of command.checkpoint) world[item.playerId]=item;
        const hit=rayHit(previous.x,previous.y,command.aimX,command.aimY,world,command.playerId,ability?.range||0);
        const life=hit?world[hit]?.lifeId:null;
        const accepted=previous.alive&&ability?.kind==='shoot'&&Math.abs(length-1)<0.02&&refMatches&&checkpointOk&&hit===command.claimedHitId&&life===command.claimedHitLifeId;
        return accepted
            ? {disposition:RULE_DISPOSITION.ACCEPT,code:'SHOOT_VALID',reason:'shoot verified against historical simulation reference',computed:{hit,life,simulationRef:command.simulationRef,ability:abilityCheck.computed},advanceTick:false}
            : {disposition:RULE_DISPOSITION.REJECT,code:'SHOOT_INVALID',reason:`shoot invalid hit=${hit||'none'} checkpoint=${checkpointOk} ref=${refMatches}`,computed:{hit,life,simulationRef:command.simulationRef,ability:abilityCheck.computed},advanceTick:false};
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

function checkpointMatchesLocal(checkpoint,shooterId,shooterState,simulationRef=null){
    if(!Array.isArray(checkpoint)||checkpoint.length>64) return false;
    const seen=new Set(); let shooterSeen=false;
    for(const item of checkpoint){
        if(!item||typeof item.playerId!=='string'||seen.has(item.playerId)||![item.x,item.y].every(Number.isFinite)||!Number.isSafeInteger(item.lifeId)||!Number.isSafeInteger(item.sequence)||!Number.isSafeInteger(item.tick)||!inBounds(item.x,item.y)) return false;
        seen.add(item.playerId);
        if(item.playerId===shooterId){
            shooterSeen=true;
            if(item.sequence!==simulationRef?.sequence||Math.hypot(shooterState.x-item.x,shooterState.y-item.y)>1.5||item.lifeId!==shooterState.lifeId||Boolean(item.alive)!==Boolean(shooterState.alive)) return false;
            continue;
        }

        // VALORANT/Source-style historical check: compare the evidence to the peer's state at
        // the checkpoint's simulation sequence, never to its *current* position.
        const historical=simulationStateCandidates(item.playerId,item.sequence);
        if(historical.length){
            const matches=historical.some(local=>Math.hypot(local.x-item.x,local.y-item.y)<=3.5&&local.lifeId===item.lifeId&&Boolean(local.alive)===Boolean(item.alive));
            if(!matches) return false;
        }
        // If this validator no longer has that historical state, the self-contained checkpoint
        // remains usable evidence; absence of a cache entry is not a negative vote.
    }
    return shooterSeen;
}

function rayHit(originX,originY,dirX,dirY,world,excludeId,maxRange=MAX_RANGE){
    let closest=null,closestProjection=Infinity;
    for(const [id,state] of Object.entries(world)){
        if(id===excludeId||!state||!state.alive) continue;
        const px=state.x-originX,py=state.y-originY,projection=px*dirX+py*dirY;
        if(projection<0||projection>maxRange) continue;
        const cx=originX+dirX*projection,cy=originY+dirY*projection;
        if(Math.hypot(state.x-cx,state.y-cy)<=HIT_RADIUS&&projection<closestProjection){ closest=id; closestProjection=projection; }
    }
    return closest;
}
