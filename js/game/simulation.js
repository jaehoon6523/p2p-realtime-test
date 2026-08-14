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

function buildMoveProfile(distance,startSpeed){
    const d=Math.max(0,distance);
    const v0=Math.max(0,startSpeed);
    if(d<=1e-6) return {startSpeed:v0,peakSpeed:0,accelTime:0,cruiseTime:0,decelTime:0,accelDistance:0,cruiseDistance:0,totalTime:0,startsDecelerating:true};

    // A retarget begins at the currently rendered speed. Speed cannot drop at the retarget instant.
    // Deceleration starts only when the remaining distance is at or below the braking distance.
    const brakeDistance=v0*v0/(2*MOVE_DECEL);
    if(d<=brakeDistance+1e-6){
        const decel=Math.max(MOVE_DECEL,v0*v0/(2*d));
        return {startSpeed:v0,peakSpeed:v0,accelTime:0,cruiseTime:0,decelTime:v0/decel,accelDistance:0,cruiseDistance:0,decel,startsDecelerating:true,totalTime:v0/decel};
    }

    const cap=Math.max(MOVE_SPEED,v0);
    const accelDistance=Math.max(0,(cap*cap-v0*v0)/(2*MOVE_ACCEL));
    const decelDistance=cap*cap/(2*MOVE_DECEL);
    if(accelDistance+decelDistance<=d){
        const cruiseDistance=d-accelDistance-decelDistance;
        const accelTime=(cap-v0)/MOVE_ACCEL;
        const cruiseTime=cruiseDistance/cap;
        const decelTime=cap/MOVE_DECEL;
        return {startSpeed:v0,peakSpeed:cap,accelTime,cruiseTime,decelTime,accelDistance,cruiseDistance,decel:MOVE_DECEL,startsDecelerating:false,totalTime:accelTime+cruiseTime+decelTime};
    }

    const peakSquared=(d+v0*v0/(2*MOVE_ACCEL))*2*MOVE_ACCEL*MOVE_DECEL/(MOVE_ACCEL+MOVE_DECEL);
    const peak=Math.sqrt(Math.max(v0*v0,peakSquared));
    const accelTime=Math.max(0,(peak-v0)/MOVE_ACCEL);
    const actualAccelDistance=Math.max(0,(peak*peak-v0*v0)/(2*MOVE_ACCEL));
    const decelTime=peak/MOVE_DECEL;
    return {startSpeed:v0,peakSpeed:peak,accelTime,cruiseTime:0,decelTime,accelDistance:actualAccelDistance,cruiseDistance:0,decel:MOVE_DECEL,startsDecelerating:false,totalTime:accelTime+decelTime};
}
function evalMove(movement,now){
    const elapsed=Math.max(0,Math.min(movement.profile.totalTime,(now-movement.startTime)/1000));
    const p=movement.profile;
    let travelled=0,speed=0,phase='finished';
    if(elapsed<p.accelTime){
        travelled=p.startSpeed*elapsed+.5*MOVE_ACCEL*elapsed*elapsed;
        speed=p.startSpeed+MOVE_ACCEL*elapsed;
        phase='accelerating';
    }else if(elapsed<p.accelTime+p.cruiseTime){
        const t=elapsed-p.accelTime;
        travelled=p.accelDistance+p.peakSpeed*t;
        speed=p.peakSpeed;
        phase='cruising';
    }else if(elapsed<p.totalTime){
        const t=elapsed-p.accelTime-p.cruiseTime;
        travelled=p.accelDistance+p.cruiseDistance+p.peakSpeed*t-.5*p.decel*t*t;
        speed=Math.max(0,p.peakSpeed-p.decel*t);
        phase='decelerating';
    }else{
        travelled=movement.distance;
    }
    const ratio=movement.distance>0?Math.max(0,Math.min(1,travelled/movement.distance)):1;
    return {x:movement.startX+movement.dirX*movement.distance*ratio,y:movement.startY+movement.dirY*movement.distance*ratio,speed,phase,finished:elapsed>=p.totalTime||now>=movement.hardStopAt};
}
function flushActiveMoveToNow(now=performance.now()){
    const movement=moveState[myId];
    if(!movement) return {sample:null,tail:getPredictedTail(myId)};
    if(localCommandBackpressured()) return {sample:{x:movement.sampleX,y:movement.sampleY,speed:0,phase:'backpressure',finished:false},tail:getPredictedTail(myId)};
    tracePosition('flush:before',{force:true,now});
    const sample=evalMove(movement,now);
    const dx=sample.x-movement.sampleX,dy=sample.y-movement.sampleY;
    if(Math.abs(dx)>1e-6||Math.abs(dy)>1e-6){
        const command=makeMoveCommand(dx,dy);
        if(!command) return {sample,tail:getPredictedTail(myId)};
        executeLocal(command);
        movement.sampleX=sample.x; movement.sampleY=sample.y;
        const tail=getPredictedTail(myId);
        if(tail){ movement.lastX=tail.x; movement.lastY=tail.y; }
        else{ movement.lastX=sample.x; movement.lastY=sample.y; }
    }
    const result={sample,tail:getPredictedTail(myId)};
    tracePosition('flush:after',{force:true,now,extra:`delta=${dx.toFixed(3)},${dy.toFixed(3)}`});
    return result;
}
function startMove(playerId,fromX,fromY,toX,toY){
    if(playerId!==myId) return;
    const now=performance.now();
    tracePosition('retarget:input',{force:true,now,extra:`fromArg=${fromX.toFixed(2)},${fromY.toFixed(2)} click=${toX.toFixed(2)},${toY.toFixed(2)}`});
    const previous=moveState[myId];
    let sampled=null;
    let alignedTail=getPredictedTail(myId);
    if(previous){
        const flushed=flushActiveMoveToNow(now);
        sampled=flushed.sample;
        alignedTail=flushed.tail||alignedTail;
    }
    // 새 세그먼트는 화면 보간 좌표가 아니라 event chain에 실제 기록된 predicted tail에서 시작한다.
    const startX=alignedTail?.x??fromX,startY=alignedTail?.y??fromY;
    const dx=toX-startX,dy=toY-startY,distance=Math.hypot(dx,dy);
    if(distance<=1e-6){ delete moveState[myId]; return; }
    const currentSpeed=sampled&&!sampled.finished?sampled.speed:0;
    const profile=buildMoveProfile(distance,currentSpeed);
    moveState[myId]={startX,startY,targetX:toX,targetY:toY,dirX:dx/distance,dirY:dy/distance,distance,startTime:now,profile,hardStopAt:now+Math.max(MOVE_MAX_DURATION,(profile.totalTime+1)*1000),sampleX:startX,sampleY:startY,lastX:startX,lastY:startY,lastWallAt:now};
    tracePosition('retarget:armed',{force:true,now,extra:`start=${startX.toFixed(2)},${startY.toFixed(2)} speed0=${currentSpeed.toFixed(2)} dist=${distance.toFixed(2)}`});
}
function rebaseLocalMovementAfterRejection(sequence,reason){
    const movement=moveState[myId];
    if(!movement) return;
    const targetX=movement.targetX,targetY=movement.targetY;
    delete moveState[myId];
    const base=confirmedWorld[myId];
    if(!base?.alive) return;
    if(Math.hypot(targetX-base.x,targetY-base.y)<=0.5) return;
    startMove(myId,base.x,base.y,targetX,targetY);
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
    const now=performance.now(); const movement=moveState[myId]; if(!movement) return;
    const wallDelta=Math.max(0,now-(movement.lastWallAt||now));
    movement.lastWallAt=now;
    if(localCommandBackpressured()){
        // Freeze the motion profile while the event stream is backpressured; otherwise a later sample becomes one giant invalid move.
        movement.startTime+=wallDelta;
        movement.hardStopAt+=wallDelta;
        return;
    }
    const me=getPredictedTail(myId); if(!me?.alive){ delete moveState[myId]; return; }
    const evaluated=evalMove(movement,now),dx=evaluated.x-movement.sampleX,dy=evaluated.y-movement.sampleY;
    tracePosition('move:sample',{now});
    const shouldEmit=evaluated.finished?(Math.abs(dx)>1e-6||Math.abs(dy)>1e-6):(Math.abs(dx)>.05||Math.abs(dy)>.05);
    if(shouldEmit){
        tracePosition('move:emit-before',{force:true,now,extra:`delta=${dx.toFixed(3)},${dy.toFixed(3)}`});
        const command=makeMoveCommand(dx,dy);
        if(!command) return;
        executeLocal(command);
        movement.sampleX=evaluated.x; movement.sampleY=evaluated.y;
        const tail=getPredictedTail(myId);
        if(tail){ movement.lastX=tail.x; movement.lastY=tail.y; }
        tracePosition('move:emit-after',{force:true,now});
    }
    if(evaluated.finished){
        // 최종 보간점까지 반드시 chain에 반영된 뒤 렌더 source를 predicted state로 넘긴다.
        tracePosition('move:finish-before',{force:true,now});
        flushActiveMoveToNow(now);
        for(let i=0;i<8;i++){ const tail=getPredictedTail(myId); if(!tail) break; const dx=movement.targetX-tail.x,dy=movement.targetY-tail.y; if(Math.hypot(dx,dy)<=0.01) break; const command=makeMoveCommand(dx,dy); if(!command) break; executeLocal(command); }
        delete moveState[myId];
        queueLocalRenderTarget(getPredictedTail(myId));
        tracePosition('move:finish-after',{force:true,now});
    }
}
function tickCombat(){
    if(!roomReady) return;
    if(AUTO_MODE) tickAutoMode();
    const me=getPredictedTail(myId); if(!me) return;
    if(!me.alive){ delete moveState[myId]; const confirmed=confirmedWorld[myId]; if(confirmed&&!hasPendingType(myId,'respawn')&&performance.now()-(confirmed.deadObservedAt||0)>=RESPAWN_MS) executeLocal(makeRespawnCommand()); return; }
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
function sendSnapshot(remoteId){
    if(!isPeerOpen(remoteId)) return;
    const state=confirmedWorld[myId];
    const snapshot={
        protocol:PROTOCOL,rulesetRevision:RULESET_REVISION,senderId:myId,clockTick:currentTick(),eventSequence:confirmedEventSeq.get(myId)||0,
        state:{...state,deadObservedAt:0},stateHash:stateHash(state),historyTail:snapshotHistoryTail()
    };
    safeDataSend(remoteId,{kind:'snapshot',snapshot});
}
function receiveSnapshot(remoteId,snapshot){
    if(!snapshot||snapshot.protocol!==PROTOCOL||snapshot.rulesetRevision!==RULESET_REVISION||snapshot.senderId!==remoteId||!snapshot.state) return;
    relayWorld.delete(remoteId);
    const state=snapshot.state;
    if(![state.x,state.y].every(Number.isFinite)||!Number.isSafeInteger(state.sequence)||!Number.isSafeInteger(state.lifeId)||!Number.isSafeInteger(state.hp)) return;
    const historyImported=importHistoricalStates(remoteId,snapshot.historyTail);
    const localSeq=confirmedSeq.get(remoteId)||0;
    if(state.sequence<localSeq){
        if(historyImported) acceptDeferred(remoteId,'event');
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
    log('t-sys',`snapshot merged from=${remoteId} seq=${normalized.sequence}/e${confirmedEventSeq.get(remoteId)||0} alive=${normalized.alive} history=${historyImported}`);
    if(AUTO_MODE) setTimeout(tickAutoMode,0);
    acceptDeferred(remoteId,'simulation');
    acceptDeferred(remoteId,'event');
}
