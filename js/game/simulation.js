'use strict';

function contributorKey(victimId,lifeId){ return `${victimId}:${lifeId}`; }
function registerConfirmedHit(command,certificateServerTime=null){
    const victim=confirmedWorld[command.claimedHitId];
    if(!victim||!victim.alive||victim.lifeId!==command.claimedHitLifeId) return;

    const now=performance.now();
    const activity=activityAnchors.get(command.claimedHitId)||{lastMoveAt:now,lastDamageAt:now,lastHealAt:now};
    activity.lastDamageAt=now;
    activityAnchors.set(command.claimedHitId,activity);

    victim.hp=Math.max(0,victim.hp-1);
    hitFlashes[command.claimedHitId]=now+180;
    const key=contributorKey(command.claimedHitId,victim.lifeId);
    const contributors=damageContributors.get(key)||new Map();
    contributors.set(command.playerId,Date.now());
    damageContributors.set(key,contributors);

    if(victim.hp===0){
        victim.alive=false;
        victim.deadObservedAt=now;
        victim.deadServerAt=Number.isFinite(certificateServerTime)?certificateServerTime:Date.now();
        delete moveState[command.claimedHitId];
        if(command.claimedHitId===myId) resetLocalMoveVelocity();
        const assists=[...contributors.keys()].filter(id=>id!==command.playerId);
        registerKillOutcome(command.claimedHitId,victim.lifeId,command.playerId,assists,command.commandId);
        log('t-warn',`DEAD victim=${command.claimedHitId} killer=${command.playerId}`);
    }
    rememberSimulationState(command.claimedHitId,victim);
    rebuildVisible(command.claimedHitId);
}
function registerKillOutcome(victimId,lifeId,killerId,assists,sourceHitId){
    const id=`${victimId}:${lifeId}`;
    if(killEvents.has(id)) return;
    const event={id,killerId,victimId,assists,occurredAt:Date.now(),sourceHitId};
    killEvents.set(id,event);
    log('t-cmd',`KILL ${killerId} → ${victimId}${assists.length?` assists=${assists.join(',')}`:''}`);
    renderKillFeed();
    updateKda();
}
function onRespawnCommitted(command,state){
    for(const key of [...damageContributors.keys()]) if(key.startsWith(`${command.playerId}:`)&&key!==contributorKey(command.playerId,state.lifeId)) damageContributors.delete(key);
    delete hitFlashes[command.playerId];
    if(command.playerId===myId){
        log('t-cmd',`RESPAWN life=${state.lifeId}`);
        // Respawn changes life identity and targetability. Do not wait for the 1s presence timer.
        sendPresence();
        for(const remoteId of directOpenPeerIds()) sendSnapshot(remoteId);
        broadcastNeighborDigests();
    }
}

function spawnBullet(command,shooterState=null){
    const origin=shooterState||resolveSimulationReference(command.playerId,command.simulationRef)?.state;
    if(!origin) return;
    const range=ABILITY_BY_ID[command.abilityId]?.range||MAX_RANGE;
    const born=performance.now();
    const bullet={commandId:command.commandId,abilityId:command.abilityId,x1:origin.x,y1:origin.y,x2:origin.x+command.aimX*range,y2:origin.y+command.aimY*range,born,status:'tentative',expiresAt:born+BULLET_TRAIL_MS,color:visibleWorld[command.playerId]?.color||'#fff'};
    bullets.push(bullet);
    optimisticEffects.set(command.commandId,{kind:'shoot',status:'tentative',createdAt:born,abilityId:command.abilityId});
    log('t-cmd',`PREDICT_APPLY kind=shoot id=${command.commandId} ability=${command.abilityId} refSim=${command.simulationRef?.sequence??'-'}`);
}
function confirmOptimisticEffect(command){
    const effect=optimisticEffects.get(command.commandId);
    if(effect){ effect.status='confirmed'; effect.confirmedAt=performance.now(); }
    for(const bullet of bullets) if(bullet.commandId===command.commandId){ bullet.status='confirmed'; bullet.expiresAt=Math.max(bullet.expiresAt,performance.now()+Math.min(OPTIMISTIC_CONFIRM_FADE_MS,80)); }
    if(command.type==='shoot') log('t-audit',`PREDICT_CONFIRM kind=shoot id=${command.commandId}`);
    else if(command.type==='dash') log('t-audit',`PREDICT_CONFIRM kind=dash id=${command.commandId}`);
}
function rejectOptimisticEffect(command,reason='REJECTED'){
    const now=performance.now();
    const effect=optimisticEffects.get(command.commandId);
    if(effect){ effect.status='rejected'; effect.rejectedAt=now; effect.reason=reason; }
    for(const bullet of bullets) if(bullet.commandId===command.commandId){ bullet.status='rejected'; bullet.rejectedAt=now; bullet.expiresAt=Math.min(bullet.expiresAt,now+OPTIMISTIC_REJECT_FADE_MS); }
    if(command.type==='shoot') log('t-warn',`PREDICT_CORRECT kind=shoot id=${command.commandId} action=fade reason=${reason}`);
    else if(command.type==='dash') log('t-warn',`PREDICT_CORRECT kind=dash id=${command.commandId} action=canonical-snap reason=${reason}`);
}

const MOVE_COMMAND_CHUNK = BASE_MAX_STEP * 0.85;
const MOVE_FINISH_EPSILON = 0.05;
const MOVE_STOP_SPEED_EPSILON = 2.0;
const MOVE_MAX_CHUNKS_PER_TICK = 16;
const MOVE_INTEGRATION_MAX_DT_MS = 160;

function clampVectorDelta(dx,dy,maxMagnitude){
    const magnitude=Math.hypot(dx,dy);
    if(magnitude<=maxMagnitude||magnitude<=1e-12) return {x:dx,y:dy};
    const scale=maxMagnitude/magnitude;
    return {x:dx*scale,y:dy*scale};
}

// Velocity is persistent physics state, not part of a destination plan.
// Retargeting replaces only moveState[myId].target*. It never creates or assigns a new speed.
function readLocalMoveVelocity(){
    const vx=Number.isFinite(localMoveVelocity.vx)?localMoveVelocity.vx:0;
    const vy=Number.isFinite(localMoveVelocity.vy)?localMoveVelocity.vy:0;
    const speed=Math.hypot(vx,vy);
    return {
        vx,vy,
        lastStepAt:Number.isFinite(localMoveVelocity.lastStepAt)?localMoveVelocity.lastStepAt:performance.now(),
        cruiseSpeed:Number.isFinite(localMoveVelocity.cruiseSpeed)?Math.max(speed,localMoveVelocity.cruiseSpeed):speed,
        heading:Number.isFinite(localMoveVelocity.heading)?localMoveVelocity.heading:(speed>1e-9?Math.atan2(vy,vx):0),
    };
}
function writeLocalMoveVelocity(vx,vy,now=performance.now()){
    const nextVx=Number.isFinite(vx)?vx:0;
    const nextVy=Number.isFinite(vy)?vy:0;
    const speed=Math.hypot(nextVx,nextVy);
    localMoveVelocity.vx=nextVx;
    localMoveVelocity.vy=nextVy;
    localMoveVelocity.lastStepAt=now;
    if(speed>1e-9) localMoveVelocity.heading=Math.atan2(nextVy,nextVx);
    // Braking near a destination must not erase the speed already earned by the active click-move chain.
    // A retarget can therefore cancel destination braking without granting speed above the chain's prior peak.
    localMoveVelocity.cruiseSpeed=Math.min(MOVE_SPEED,Math.max(Number(localMoveVelocity.cruiseSpeed)||0,speed));
}
function resetLocalMoveVelocity(now=performance.now()){
    localMoveVelocity.vx=0;
    localMoveVelocity.vy=0;
    localMoveVelocity.lastStepAt=now;
    localMoveVelocity.cruiseSpeed=0;
    localMoveVelocity.heading=0;
}
function stopLocalMovement({resetVelocity=true,now=performance.now()}={}){
    delete moveState[myId];
    if(resetVelocity) resetLocalMoveVelocity(now);
}

// Movement plan answers only "where is the destination?".
// localMoveVelocity answers only "how fast and in which direction are we moving now?".
function moveTowardScalar(current,target,maxDelta){
    if(current<target) return Math.min(target,current+maxDelta);
    if(current>target) return Math.max(target,current-maxDelta);
    return current;
}
function wrapAngle(angle){
    while(angle>Math.PI) angle-=Math.PI*2;
    while(angle<-Math.PI) angle+=Math.PI*2;
    return angle;
}

// Retargeting changes heading intent, not speed.
// Speed magnitude is accelerated/braked separately so a turn cannot accidentally cancel velocity.
function evalMove(movement,now){
    const tail=getPredictedTail(myId)||{x:movement.startX,y:movement.startY,alive:true};
    const velocity=readLocalMoveVelocity();
    const rawDt=Math.max(0,now-velocity.lastStepAt);
    const dt=Math.min(MOVE_INTEGRATION_MAX_DT_MS,rawDt)/1000;
    const vx0=velocity.vx,vy0=velocity.vy;
    const speed0=Math.hypot(vx0,vy0);
    const dx=movement.targetX-tail.x,dy=movement.targetY-tail.y;
    const distance=Math.hypot(dx,dy);

    if(distance<=MOVE_FINISH_EPSILON&&speed0<=MOVE_STOP_SPEED_EPSILON){
        return {x:movement.targetX,y:movement.targetY,vx:0,vy:0,speed:0,phase:'finished',finished:true,dt};
    }
    if(dt<=0){
        return {x:tail.x,y:tail.y,vx:vx0,vy:vy0,speed:speed0,phase:speed0>MOVE_STOP_SPEED_EPSILON?'coasting':'accelerating',finished:false,dt};
    }

    const ux=distance>1e-9?dx/distance:0;
    const uy=distance>1e-9?dy/distance:0;
    const retargetAge=Math.max(0,now-(Number.isFinite(movement.retargetAt)?movement.retargetAt:now));
    const stoppingDistance=speed0>0?(speed0*speed0)/(2*MOVE_DECEL):0;
    const brakingArmed=retargetAge>=MOVE_RETARGET_BRAKE_GRACE_MS;
    const braking=brakingArmed && distance<=Math.max(MOVE_FINISH_EPSILON,stoppingDistance+speed0*dt*0.35);
    const targetSpeed=braking?Math.min(MOVE_SPEED,Math.sqrt(Math.max(0,2*MOVE_DECEL*distance))):MOVE_SPEED;
    const speedRate=targetSpeed<speed0?MOVE_DECEL:MOVE_ACCEL;
    let speed=moveTowardScalar(speed0,targetSpeed,speedRate*dt);

    let heading;
    if(speed0>MOVE_STOP_SPEED_EPSILON){
        const currentAngle=Math.atan2(vy0,vx0);
        const targetAngle=Math.atan2(uy,ux);
        const delta=wrapAngle(targetAngle-currentAngle);
        const limitedTurn=Math.max(-MOVE_STEER_RATE*dt,Math.min(MOVE_STEER_RATE*dt,delta));
        heading=currentAngle+limitedTurn;
    }else{
        heading=Math.atan2(uy,ux);
    }

    let vx=Math.cos(heading)*speed;
    let vy=Math.sin(heading)*speed;

    // Trapezoidal integration preserves continuous motion while steering.
    let nextX=tail.x+(vx0+vx)*0.5*dt;
    let nextY=tail.y+(vy0+vy)*0.5*dt;
    const projected=typeof clampWorldPoint==='function'?clampWorldPoint(nextX,nextY):{x:nextX,y:nextY};
    if(Math.abs(projected.x-nextX)>1e-9) vx=0;
    if(Math.abs(projected.y-nextY)>1e-9) vy=0;
    nextX=projected.x; nextY=projected.y;
    speed=Math.hypot(vx,vy);

    let remaining=Math.hypot(movement.targetX-nextX,movement.targetY-nextY);
    const travel=Math.hypot(nextX-tail.x,nextY-tail.y);
    const towardTarget=distance>1e-9&&travel>1e-9
        ? ((nextX-tail.x)*dx+(nextY-tail.y)*dy)/(travel*distance)
        : 1;
    const arrivalRadius=Math.max(MOVE_FINISH_EPSILON,travel*0.7);
    if(remaining<=MOVE_FINISH_EPSILON || (towardTarget>0.75 && distance<=arrivalRadius)){
        nextX=movement.targetX; nextY=movement.targetY; vx=0; vy=0; speed=0; remaining=0;
        return {x:nextX,y:nextY,vx,vy,speed,phase:'finished',finished:true,dt};
    }

    const currentAngle=speed0>MOVE_STOP_SPEED_EPSILON?Math.atan2(vy0,vx0):Math.atan2(uy,ux);
    const targetAngle=Math.atan2(uy,ux);
    const turnError=Math.abs(wrapAngle(targetAngle-currentAngle));
    let phase='cruising';
    if(braking) phase='decelerating';
    else if(speed0<MOVE_SPEED-2) phase='accelerating';
    else if(turnError>0.03) phase='steering';
    return {x:nextX,y:nextY,vx,vy,speed,phase,finished:false,dt};
}
// Movement has exactly one protocol position source: getPredictedTail(myId).
function emitMoveTowardAbsolute(movement,targetX,targetY){
    for(let i=0;i<MOVE_MAX_CHUNKS_PER_TICK;i++){
        if(moveState[myId]!==movement) return {ok:false,replaced:true,reached:false};
        if(localCommandBackpressured()) return {ok:false,replaced:false,reached:false,backpressured:true};
        const tail=getPredictedTail(myId);
        if(!tail?.alive) return {ok:false,replaced:false,reached:false};
        const dx=targetX-tail.x,dy=targetY-tail.y,distance=Math.hypot(dx,dy);
        if(distance<=MOVE_FINISH_EPSILON) return {ok:true,replaced:false,reached:true};
        const scale=Math.min(1,MOVE_COMMAND_CHUNK/distance);
        const command=makeMoveCommand(dx*scale,dy*scale);
        if(!command) return {ok:false,replaced:false,reached:false};
        const beforeX=tail.x,beforeY=tail.y;
        executeLocal(command);
        if(moveState[myId]!==movement) return {ok:false,replaced:true,reached:false};
        const after=getPredictedTail(myId);
        if(!after?.alive) return {ok:false,replaced:false,reached:false};
        if(Math.hypot(after.x-beforeX,after.y-beforeY)<=1e-9) return {ok:false,replaced:false,reached:false};
    }
    const tail=getPredictedTail(myId);
    return {ok:true,replaced:false,reached:Boolean(tail&&Math.hypot(targetX-tail.x,targetY-tail.y)<=MOVE_FINISH_EPSILON)};
}

function commitMoveVelocity(evaluated,now){
    writeLocalMoveVelocity(evaluated.vx,evaluated.vy,now);
}

function flushActiveMoveToNow(now=performance.now()){
    const movement=moveState[myId];
    if(!movement) return {sample:null,tail:getPredictedTail(myId)};
    const sample=evalMove(movement,now);
    const before=getPredictedTail(myId);
    if(localCommandBackpressured()){
        localMoveVelocity.lastStepAt=now;
        return {sample:{...sample,phase:'backpressure',finished:false},tail:before};
    }
    tracePosition('flush:before',{force:true,now});
    const dx=before?sample.x-before.x:0,dy=before?sample.y-before.y:0;
    // Persist velocity before protocol emission. Even if the command path rebases/replaces the plan,
    // the physics state is not silently reset to the plan's creation velocity.
    commitMoveVelocity(sample,now);
    if(before&&Math.hypot(dx,dy)>MOVE_FINISH_EPSILON){
        const emitted=emitMoveTowardAbsolute(movement,sample.x,sample.y);
        if(!emitted.ok) return {sample,tail:getPredictedTail(myId)};
    }
    const result={sample,tail:getPredictedTail(myId)};
    tracePosition('flush:after',{force:true,now,extra:`desiredDelta=${dx.toFixed(3)},${dy.toFixed(3)} vel=${sample.vx.toFixed(1)},${sample.vy.toFixed(1)}`});
    return result;
}
function startMove(playerId,fromX,fromY,toX,toY,options={}){
    if(playerId!==myId) return;
    const now=performance.now();
    tracePosition('retarget:input',{force:true,now,extra:`fromArg=${fromX.toFixed(2)},${fromY.toFixed(2)} click=${toX.toFixed(2)},${toY.toFixed(2)}`});
    const previous=moveState[myId];
    const explicit=options&&options.initialVelocity;

    // Retarget is not a physics step. Preserve the exact current velocity vector and only
    // move its time anchor to the click instant. Evaluating the old target here used to apply
    // old-target braking during the click itself.
    if(Number.isFinite(explicit?.vx)&&Number.isFinite(explicit?.vy)){
        writeLocalMoveVelocity(explicit.vx,explicit.vy,now);
    }else if(previous){
        const velocity=readLocalMoveVelocity();
        const speed=Math.hypot(velocity.vx,velocity.vy);
        const chainSpeed=Math.min(MOVE_SPEED,Math.max(speed,velocity.cruiseSpeed||0));
        if(chainSpeed>speed+1e-9){
            const heading=speed>1e-9?Math.atan2(velocity.vy,velocity.vx):velocity.heading;
            writeLocalMoveVelocity(Math.cos(heading)*chainSpeed,Math.sin(heading)*chainSpeed,now);
        }else{
            writeLocalMoveVelocity(velocity.vx,velocity.vy,now);
        }
    }else{
        resetLocalMoveVelocity(now);
    }

    const alignedTail=getPredictedTail(myId);
    const startX=alignedTail?.x??fromX,startY=alignedTail?.y??fromY;
    const dx=toX-startX,dy=toY-startY,distance=Math.hypot(dx,dy);
    if(distance<=MOVE_FINISH_EPSILON){ stopLocalMovement({resetVelocity:true,now}); return; }
    moveState[myId]={
        startX,startY,targetX:toX,targetY:toY,
        retargetAt:now,
        hardStopAt:now+MOVE_MAX_DURATION,lastWallAt:now
    };
    const velocity=readLocalMoveVelocity();
    tracePosition('retarget:armed',{force:true,now,extra:`start=${startX.toFixed(2)},${startY.toFixed(2)} vel=${velocity.vx.toFixed(1)},${velocity.vy.toFixed(1)} speed=${Math.hypot(velocity.vx,velocity.vy).toFixed(2)} cruise=${velocity.cruiseSpeed.toFixed(2)} dist=${distance.toFixed(2)}`});
}
function rebaseLocalMovementAfterRejection(sequence,reason){
    const movement=moveState[myId];
    if(!movement) return;
    const targetX=movement.targetX,targetY=movement.targetY;
    const velocity=readLocalMoveVelocity();
    delete moveState[myId];
    const base=confirmedWorld[myId];
    if(!base?.alive){ resetLocalMoveVelocity(); return; }
    if(Math.hypot(targetX-base.x,targetY-base.y)<=MOVE_FINISH_EPSILON){ resetLocalMoveVelocity(); return; }
    startMove(myId,base.x,base.y,targetX,targetY,{initialVelocity:{vx:velocity.vx,vy:velocity.vy}});
    tracePosition('movement:rebased',{force:true,extra:`afterSeq=${sequence} reason=${reason}`});
}

function sampleLocalRender(now=performance.now()){
    const state=getPredictedTail(myId)||visibleWorld[myId]; if(!state) return null;
    const t=localRenderState;
    if(!Number.isFinite(t.toX)||!Number.isFinite(t.toY)) return {x:state.x,y:state.y};
    const p=Math.max(0,Math.min(1,(now-t.startedAt)/Math.max(1,t.duration))); const e=p*p*(3-2*p);
    return {x:t.fromX+(t.toX-t.fromX)*e,y:t.fromY+(t.toY-t.fromY)*e};
}
function queueLocalRenderTarget(state,{snap=false}={}){
    if(!state||![state.x,state.y].every(Number.isFinite)) return;
    const now=performance.now(),cur=sampleLocalRender(now)||state;
    if(snap||!Number.isFinite(localRenderState.toX)||Math.hypot(state.x-cur.x,state.y-cur.y)>REMOTE_SNAP_DISTANCE){
        Object.assign(localRenderState,{fromX:state.x,fromY:state.y,toX:state.x,toY:state.y,startedAt:now,duration:1}); return;
    }
    Object.assign(localRenderState,{fromX:cur.x,fromY:cur.y,toX:state.x,toY:state.y,startedAt:now,duration:Math.max(55,STEP_INTERVAL_MS*1.05)});
}

function sampleRemoteRender(playerId,now=performance.now()){
    const state=visibleWorld[playerId]; if(!state) return null;
    const track=remoteRenderState[playerId]; if(!track) return state;
    const progress=Math.max(0,Math.min(1,(now-track.startedAt)/track.duration));
    const eased=progress*progress*(3-2*progress);
    return {x:track.fromX+(track.toX-track.fromX)*eased,y:track.fromY+(track.toY-track.fromY)*eased};
}
function queueRemoteRenderTarget(playerId,state,{snap=false}={}){
    if(playerId===myId||!state||![state.x,state.y].every(Number.isFinite)) return;
    const now=performance.now();
    const current=sampleRemoteRender(playerId,now)||state;
    const existing=remoteRenderState[playerId];
    if(existing&&Math.abs(existing.toX-state.x)<1e-6&&Math.abs(existing.toY-state.y)<1e-6) return;
    const distance=Math.hypot(state.x-current.x,state.y-current.y);
    if(snap||distance>REMOTE_SNAP_DISTANCE){
        remoteRenderState[playerId]={fromX:state.x,fromY:state.y,toX:state.x,toY:state.y,startedAt:now,duration:1};
        return;
    }
    remoteRenderState[playerId]={fromX:current.x,fromY:current.y,toX:state.x,toY:state.y,startedAt:now,duration:REMOTE_INTERPOLATION_MS};
}
function getRenderPosition(playerId){
    if(playerId===myId) return sampleLocalRender();
    return sampleRemoteRender(playerId);
}
function tickMovement(){
    if(!roomReady) return;
    const now=performance.now();
    const movement=moveState[myId];
    if(!movement) return;

    const wallDelta=Math.max(0,now-(movement.lastWallAt||now));
    movement.lastWallAt=now;
    if(localCommandBackpressured()){
        // Freeze integration during protocol backpressure. Velocity is preserved exactly.
        localMoveVelocity.lastStepAt=now;
        movement.hardStopAt+=wallDelta;
        return;
    }

    const tailBefore=getPredictedTail(myId);
    if(!tailBefore?.alive){ stopLocalMovement({resetVelocity:true,now}); return; }
    const evaluated=evalMove(movement,now);
    const desiredDistance=Math.hypot(evaluated.x-tailBefore.x,evaluated.y-tailBefore.y);
    const velocity=readLocalMoveVelocity();
    tracePosition('move:sample',{now,extra:`vel=${velocity.vx.toFixed(1)},${velocity.vy.toFixed(1)} nextVel=${evaluated.vx.toFixed(1)},${evaluated.vy.toFixed(1)}`});

    // Physics advances once per movement tick, independently of how many protocol chunks are emitted.
    commitMoveVelocity(evaluated,now);

    if(desiredDistance>MOVE_FINISH_EPSILON){
        tracePosition('move:emit-before',{force:true,now,extra:`desiredDelta=${(evaluated.x-tailBefore.x).toFixed(3)},${(evaluated.y-tailBefore.y).toFixed(3)} nextVel=${evaluated.vx.toFixed(1)},${evaluated.vy.toFixed(1)}`});
        const emitted=emitMoveTowardAbsolute(movement,evaluated.x,evaluated.y);
        if(!emitted.ok) return;
        tracePosition('move:emit-after',{force:true,now,extra:`vel=${localMoveVelocity.vx.toFixed(1)},${localMoveVelocity.vy.toFixed(1)}`});
    }

    if(moveState[myId]!==movement) return;
    const tail=getPredictedTail(myId);
    if(!tail?.alive){ stopLocalMovement({resetVelocity:true,now}); return; }
    const remaining=Math.hypot(movement.targetX-tail.x,movement.targetY-tail.y);
    if(remaining>MOVE_FINISH_EPSILON&&now<movement.hardStopAt) return;

    if(remaining>MOVE_FINISH_EPSILON){
        const emitted=emitMoveTowardAbsolute(movement,movement.targetX,movement.targetY);
        if(!emitted.ok||moveState[myId]!==movement) return;
    }
    const after=getPredictedTail(myId);
    if(!after||Math.hypot(movement.targetX-after.x,movement.targetY-after.y)>MOVE_FINISH_EPSILON) return;
    tracePosition('move:finish-before',{force:true,now});
    stopLocalMovement({resetVelocity:true,now});
    queueLocalRenderTarget(getPredictedTail(myId));
    tracePosition('move:finish-after',{force:true,now});
}

function tickCombat(){
    if(!roomReady) return;
    if(AUTO_MODE) tickAutoMode();
    const me=getPredictedTail(myId); if(!me) return;
    if(!me.alive){ stopLocalMovement({resetVelocity:true}); const confirmed=confirmedWorld[myId]; if(confirmed&&!hasPendingType(myId,'respawn')&&performance.now()-(confirmed.deadObservedAt||0)>=RESPAWN_MS) executeLocal(makeRespawnCommand()); return; }
    if(me.hp<MAX_HP&&!hasPendingType(myId,'heal')){ const activity=activityAnchors.get(myId); const idleMs=activity?performance.now()-Math.max(activity.lastMoveAt,activity.lastDamageAt,activity.lastHealAt):0; if(idleMs>=1000) executeLocal(makeHealCommand()); }
}
function hasPendingType(playerId,type){ return [...(pendingOrderByPlayer.get(playerId)||[]),...(pendingEventOrderByPlayer.get(playerId)||[])].some(id=>pendingById.get(id)?.command.type===type); }

function compactHistoryState(state){
    return {
        x:round6(state.x),y:round6(state.y),sequence:state.sequence,tick:state.tick,
        hp:Number.isSafeInteger(state.hp)?state.hp:MAX_HP,alive:Boolean(state.alive),lifeId:state.lifeId,
        deadServerAt:Number(state.deadServerAt)||0,
        refHash:simulationRefHash(state)
    };
}
function validHistoryStateShape(state){
    return state&&[state.x,state.y].every(Number.isFinite)&&Number.isSafeInteger(state.sequence)&&state.sequence>=0&&
        Number.isSafeInteger(state.tick)&&state.tick>=0&&Number.isSafeInteger(state.lifeId)&&state.lifeId>=1&&
        Number.isSafeInteger(state.hp)&&state.hp>=0&&state.hp<=MAX_HP&&typeof state.alive==='boolean'&&
        typeof state.refHash==='string'&&state.refHash.length<=32;
}
function snapshotHistoryTail(){
    const history=simulationStateHistory.get(myId);
    if(!history) return [];
    const sequences=[...history.keys()].sort((a,b)=>b-a).slice(0,SNAPSHOT_HISTORY_TAIL_SEQUENCES).sort((a,b)=>a-b);
    const entries=[];
    for(const sequence of sequences){
        for(const state of history.get(sequence)||[]){
            entries.push(compactHistoryState(state));
            if(entries.length>=SNAPSHOT_HISTORY_TAIL_SEQUENCES*4) return entries;
        }
    }
    return entries;
}
function importHistoricalStates(remoteId,states){
    let imported=0;
    for(const raw of Array.isArray(states)?states:[]){
        if(!validHistoryStateShape(raw)) continue;
        const normalized={...raw,color:colorFor(remoteId),deadObservedAt:raw.alive?0:performance.now(),tentative:false};
        if(simulationRefHash(normalized)!==raw.refHash) continue;
        rememberSimulationState(remoteId,normalized);
        imported++;
    }
    return imported;
}
function sendHistoryRepair(remoteId,requestedSequence,requestedStateHash=null){
    if(!isPeerOpen(remoteId)||!Number.isSafeInteger(requestedSequence)||requestedSequence<0) return false;
    let states=simulationStateCandidates(myId,requestedSequence);
    if(typeof requestedStateHash==='string'&&requestedStateHash){
        const exact=states.filter(state=>simulationRefHash(state)===requestedStateHash);
        if(exact.length) states=exact;
    }
    states=states.slice(0,HISTORY_REPAIR_MAX_STATES);
    if(!states.length) return false;
    const payload={protocol:PROTOCOL,rulesetRevision:RULESET_REVISION,senderId:myId,sequence:requestedSequence,states:states.map(compactHistoryState)};
    safeDataSend(remoteId,{kind:'historyRepair',repair:payload});
    log('t-sys',`HISTORY REPAIR sent to=${remoteId} seq=${requestedSequence} variants=${states.length}`);
    return true;
}
function receiveHistoryRepair(remoteId,repair){
    if(!repair||repair.protocol!==PROTOCOL||repair.rulesetRevision!==RULESET_REVISION||repair.senderId!==remoteId||!Array.isArray(repair.states)||repair.states.length>HISTORY_REPAIR_MAX_STATES) return;
    const imported=importHistoricalStates(remoteId,repair.states);
    if(!imported) return;
    log('t-sys',`HISTORY REPAIR merged from=${remoteId} seq=${repair.sequence??'-'} states=${imported}`);
    // Targeted historical repair is for consequential events. It must not rewind current simulation state.
    acceptDeferred(remoteId,'event');
}
function markBootstrapPending(remoteId){
    bootstrapAckPeers.delete(remoteId);
    bootstrapAckState.delete(remoteId);
    bootstrapSentPeers.delete(remoteId);
    bootstrapPendingSince.set(remoteId,0);
}
function bootstrapReadyForAuto(){
    const direct=directOpenPeerIds();
    return direct.length>0 && direct.every(id=>bootstrapSentPeers.has(id));
}
function sendSnapshot(remoteId,{bootstrap=false}={}){
    if(!isPeerOpen(remoteId)) return false;
    const state=confirmedWorld[myId];
    if(!state){
        log('t-err',`BOOTSTRAP_STATE_MISSING peer=${remoteId}`);
        return false;
    }
    let historyTail;
    try{ historyTail=snapshotHistoryTail(); }
    catch(error){
        log('t-err',`BOOTSTRAP_HISTORY_BUILD_FAILED peer=${remoteId}: ${error.message}`);
        return false;
    }
    const abilityCheckpoint=abilityCheckpointFor(myId);
    const snapshot={
        protocol:PROTOCOL,rulesetRevision:RULESET_REVISION,senderId:myId,clockTick:currentTick(),eventSequence:confirmedEventSeq.get(myId)||0,
        abilityCheckpoint,
        state:{...state,deadObservedAt:0},stateHash:stateHash(state),historyTail,bootstrap:Boolean(bootstrap)
    };
    const message={kind:'snapshot',snapshot};
    // Bootstrap state must precede seq=1 commands. Netem schedules messages independently,
    // so initial state bypasses that queue and relies on the transport's own ordering.
    if(bootstrap){
        const sent=sendWireNow(remoteId,message);
        if(sent){
            bootstrapSentPeers.add(remoteId);
            bootstrapPendingSince.set(remoteId,performance.now());
            log('t-sys',`${AUTO_MODE?'AUTO_':''}BOOTSTRAP_SENT peer=${remoteId} seq=${state.sequence}/e${snapshot.eventSequence}/a${abilityCheckpoint.confirmedAbilitySeq||0}`);
        }
        return sent;
    }
    return safeDataSend(remoteId,message);
}
function sendCommandToPeer(remoteId,command){
    if(!isPeerOpen(remoteId)) return false;
    // DataChannel is reliable+ordered. Bootstrap is inserted synchronously on that transport
    // and bypasses synthetic netem; commands may therefore follow immediately without an ACK gate.
    // ACK remains telemetry/repair information only, never a liveness dependency.
    if(!bootstrapSentPeers.has(remoteId) && !sendSnapshot(remoteId,{bootstrap:true})) return false;
    return safeDataSend(remoteId,{kind:'command',command});
}
function retryPendingBootstraps(){
    if(pageUnloading||!roomReady) return;
    const now=performance.now();
    for(const remoteId of directOpenPeerIds()){
        // DataChannel/WebSocket transports are reliable and ordered. Once the bootstrap write
        // succeeds, ACK is telemetry only; retrying the same snapshot until ACK used to repeatedly
        // reconcile/defer live event streams and could starve quorum progress.
        if(bootstrapSentPeers.has(remoteId)) continue;
        const last=bootstrapPendingSince.get(remoteId)||0;
        if(now-last>=500) sendSnapshot(remoteId,{bootstrap:true});
    }
}
setInterval(retryPendingBootstraps,250);

function receiveSnapshotAck(remoteId,ack){
    if(!ack||ack.protocol!==PROTOCOL||ack.rulesetRevision!==RULESET_REVISION||ack.senderId!==remoteId||ack.ownerId!==myId) return;
    if(!Number.isSafeInteger(ack.sequence)||ack.sequence<0) return;
    const eventSequence=Number.isSafeInteger(ack.eventSequence)&&ack.eventSequence>=0?ack.eventSequence:0;
    const abilitySequence=Number.isSafeInteger(ack.abilitySequence)&&ack.abilitySequence>=0?ack.abilitySequence:0;
    const prev=bootstrapAckState.get(remoteId);
    if(!prev || ack.sequence>prev.sequence || (ack.sequence===prev.sequence&&(eventSequence>prev.eventSequence||abilitySequence>(prev.abilitySequence||0)))){
        bootstrapAckState.set(remoteId,{sequence:ack.sequence,eventSequence,abilitySequence});
    }
    bootstrapAckPeers.add(remoteId);
    bootstrapPendingSince.delete(remoteId);
    log('t-sys',`${AUTO_MODE?'AUTO_':''}BOOTSTRAP_ACK peer=${remoteId} seq=${ack.sequence}/e${eventSequence}/a${abilitySequence}`);
}
function sendInstalledBootstrapAck(remoteId){
    const installed=confirmedWorld[remoteId];
    if(!installed||!isPeerOpen(remoteId)) return false;
    const ack={
        protocol:PROTOCOL,rulesetRevision:RULESET_REVISION,senderId:myId,ownerId:remoteId,
        sequence:confirmedSeq.get(remoteId)||installed.sequence||0,
        eventSequence:confirmedEventSeq.get(remoteId)||0,
        abilitySequence:confirmedAbilitySeq.get(remoteId)||0,
        stateHash:stateHash(installed)
    };
    const sent=sendWireNow(remoteId,{kind:'snapshotAck',ack});
    if(sent&&AUTO_DEBUG) log('t-sys',`BOOTSTRAP_ACK_TX peer=${remoteId} seq=${ack.sequence}/e${ack.eventSequence}/a${ack.abilitySequence}`);
    return sent;
}
function receiveSnapshot(remoteId,snapshot){
    if(!snapshot||snapshot.protocol!==PROTOCOL||snapshot.rulesetRevision!==RULESET_REVISION||snapshot.senderId!==remoteId||!snapshot.state) return;
    relayWorld.delete(remoteId);
    const state=snapshot.state;
    if(![state.x,state.y].every(Number.isFinite)||!Number.isSafeInteger(state.sequence)||!Number.isSafeInteger(state.lifeId)||!Number.isSafeInteger(state.hp)) return;
    const historyImported=importHistoricalStates(remoteId,snapshot.historyTail);
    const abilityImported=importAbilityCheckpoint(remoteId,snapshot.abilityCheckpoint);
    const localSeq=confirmedSeq.get(remoteId)||0;
    if(state.sequence<localSeq){
        if(historyImported) acceptDeferred(remoteId,'event');
        if(snapshot.bootstrap) sendInstalledBootstrapAck(remoteId);
        return;
    }
    const snapshotEventSequence=Number.isSafeInteger(snapshot.eventSequence)?snapshot.eventSequence:(confirmedEventSeq.get(remoteId)||0);
    reconcileEventStreamFromSnapshot(remoteId,state.sequence,snapshotEventSequence);
    const normalized={...state,color:state.color||colorFor(remoteId),hp:Math.max(0,Math.min(MAX_HP,state.hp)),alive:Boolean(state.alive),deadObservedAt:state.alive?0:performance.now(),tentative:false};
    confirmedWorld[remoteId]=normalized; visibleWorld[remoteId]={...normalized}; confirmedSeq.set(remoteId,normalized.sequence); confirmedEventSeq.set(remoteId,Math.max(confirmedEventSeq.get(remoteId)||0,snapshotEventSequence)); rememberSimulationState(remoteId,normalized);
    noteAppliedPrefixRepair(remoteId);
    queueRemoteRenderTarget(remoteId,normalized,{snap:true});
    const now=performance.now();
    tickAnchors.set(remoteId,{remoteTick:Number.isSafeInteger(snapshot.clockTick)?snapshot.clockTick:normalized.tick,localTime:now});
    activityAnchors.set(remoteId,{lastMoveAt:now,lastDamageAt:now,lastHealAt:now});
    log('t-sys',`snapshot merged from=${remoteId} seq=${normalized.sequence}/e${confirmedEventSeq.get(remoteId)||0}/a${confirmedAbilitySeq.get(remoteId)||0} alive=${normalized.alive} history=${historyImported} abilityRefs=${abilityImported}`);
    if(snapshot.bootstrap){
        // ACK only after a base state is installed. A later stale bootstrap retry is ACKed
        // with the newer installed prefix above, so ACK loss can never deadlock command flow.
        sendInstalledBootstrapAck(remoteId);
        log('t-sys',`${AUTO_MODE?'AUTO_':''}BOOTSTRAP_RX peer=${remoteId} seq=${normalized.sequence}/e${confirmedEventSeq.get(remoteId)||0}/a${confirmedAbilitySeq.get(remoteId)||0}`);
    }
    if(AUTO_MODE) setTimeout(tickAutoMode,0);
    acceptDeferred(remoteId,'simulation');
    acceptDeferred(remoteId,'event');
}
