'use strict';

function getPredictedTail(playerId){
    const ids=pendingOrderByPlayer.get(playerId)||[];
    for(let i=ids.length-1;i>=0;i--){ const pending=pendingById.get(ids[i]); if(pending?.nextState) return pending.nextState; }
    return confirmedWorld[playerId]||null;
}
function makeBaseCommand(type,previous){
    const sequence=++localSequence; const membership=membershipDescriptor();
    return {protocol:PROTOCOL,rulesetRevision:RULESET_REVISION,type,commandId:createCommandId(myId,sequence),playerId:myId,sequence,previousStateHash:stateHash(previous),tick:currentTick(),topologyEpoch:membership.topologyEpoch,assignmentId:membership.assignmentId,aoiRadius:AOI_RADIUS};
}
function makeMoveCommand(dx,dy){
    const prev=getPredictedTail(myId); if(!prev||!prev.alive) return null;
    // 입력이 월드 밖을 향해도 command 자체는 항상 canonical world 안에 머물게 한다.
    const desired=clampWorldPoint(prev.x+dx,prev.y+dy);
    const safeDx=desired.x-prev.x,safeDy=desired.y-prev.y;
    if(Math.abs(safeDx)<=1e-9&&Math.abs(safeDy)<=1e-9) return null;
    const command=makeBaseCommand('move',prev); const result=computeMove(prev,safeDx,safeDy,command.tick);
    return {...command,dx:round6(safeDx),dy:round6(safeDy),claimedX:result.x,claimedY:result.y};
}
function buildShootCheckpoint(shooter){
    const membership=membershipDescriptor(); const checkpoint=[]; const world=Object.create(null);
    const interestRadius=Math.max(AOI_RADIUS,MAX_RANGE+HIT_RADIUS+24);
    for(const id of [myId,...directOpenPeerIds()]){
        const state=id===myId?shooter:confirmedWorld[id];
        if(!state) continue;
        if(id!==myId&&distanceBetweenStates(shooter,state)>interestRadius) continue;
        const item={playerId:id,x:round6(state.x),y:round6(state.y),alive:Boolean(state.alive),lifeId:state.lifeId,sequence:state.sequence};
        checkpoint.push(item); world[id]=item;
    }
    checkpoint.sort((a,b)=>a.playerId.localeCompare(b.playerId));
    networkMetrics.lastCheckpointPlayers=checkpoint.length;
    return {membership,checkpoint,world};
}
function makeShootCommand(dirX,dirY){
    const shooter=getPredictedTail(myId); if(!shooter||!shooter.alive) return null;
    const data=buildShootCheckpoint(shooter); if(!data){ log('t-warn','shoot blocked: checkpoint incomplete'); return null; }
    const command=makeBaseCommand('shoot',shooter); const originX=round6(shooter.x),originY=round6(shooter.y);
    const hitId=rayHit(originX,originY,dirX,dirY,data.world,myId);
    return {...command,originX,originY,dirX:round6(dirX),dirY:round6(dirY),checkpoint:data.checkpoint,checkpointHash:stableHash(data.checkpoint),claimedHitId:hitId,claimedHitLifeId:hitId?data.world[hitId].lifeId:null};
}
function makeHealCommand(){
    const prev=getPredictedTail(myId); if(!prev||!prev.alive||prev.hp>=MAX_HP) return null;
    const command=makeBaseCommand('heal',prev); return {...command,claimedHp:prev.hp+1};
}
function makeRespawnCommand(){
    const prev=getPredictedTail(myId); if(!prev||prev.alive) return null;
    const command=makeBaseCommand('respawn',prev); return {...command,spawnX:round6(randomSpawnX()),spawnY:round6(randomSpawnY()),nextLifeId:prev.lifeId+1};
}

function validateEnvelope(remoteId,command){
    if(!command||command.protocol!==PROTOCOL||command.rulesetRevision!==RULESET_REVISION) return 'unsupported protocol/ruleset';
    if(!['move','shoot','heal','respawn'].includes(command.type)) return 'unsupported command';
    if(command.playerId!==remoteId) return `identity mismatch channel=${remoteId} payload=${command.playerId}`;
    if(typeof command.commandId!=='string'||command.commandId.length>160) return 'invalid commandId';
    if(!Number.isSafeInteger(command.sequence)||command.sequence<1) return 'invalid sequence';
    if(!Number.isSafeInteger(command.tick)||command.tick<0) return 'invalid tick';
    if(typeof command.previousStateHash!=='string') return 'invalid previousStateHash';
    if(typeof command.assignmentId!=='string'||command.assignmentId.length>64||!Number.isSafeInteger(command.topologyEpoch)) return 'invalid assignment';
    if(!commandPolicyMatches(command)) return 'unknown server assignment';
    if(!Number.isFinite(command.aoiRadius)||command.aoiRadius<120||command.aoiRadius>1400) return 'invalid AOI radius';
    if(command.type==='move'&&![command.dx,command.dy,command.claimedX,command.claimedY].every(Number.isFinite)) return 'invalid move values';
    if(command.type==='shoot'&&(![command.originX,command.originY,command.dirX,command.dirY].every(Number.isFinite)||!Array.isArray(command.checkpoint)||command.checkpoint.length>64)) return 'invalid shoot values';
    if(command.type==='heal'&&!Number.isSafeInteger(command.claimedHp)) return 'invalid heal value';
    if(command.type==='respawn'&&(!Number.isFinite(command.spawnX)||!Number.isFinite(command.spawnY)||!Number.isSafeInteger(command.nextLifeId))) return 'invalid respawn values';
    return null;
}
function verificationRequired(commandOrType){ const type=typeof commandOrType==='string'?commandOrType:commandOrType?.type; return type==='shoot'||type==='heal'||type==='respawn'; }

function executeLocal(command){
    if(!command) return;
    acceptCommand(command,false);
    const policy=policyForCommand(command);
    for(const id of policy?.directPeers||[]) if(isPeerOpen(id)) safeDataSend(id,{kind:'command',command});
}
function receiveCommand(remoteId,command){
    const error=validateEnvelope(remoteId,command); if(error){ invalidCounter++; log('t-err',`command rejected before audit: ${error}`); return; }
    acceptCommand(command,true);
}
function rememberCommandId(id){ seenCommandIds.add(id); seenCommandQueue.push(id); if(seenCommandQueue.length>10000){ const old=seenCommandQueue.shift(); seenCommandIds.delete(old); } }
function acceptCommand(command,remote){
    if(seenCommandIds.has(command.commandId)){ duplicateCounter++; return; }
    rememberCommandId(command.commandId);
    const expected=(confirmedSeq.get(command.playerId)||0)+(pendingOrderByPlayer.get(command.playerId)||[]).length+1;
    if(command.sequence>expected){ deferredCommands.set(command.commandId,{command,remote}); log('t-warn',`command deferred player=${command.playerId} expected=${expected} got=${command.sequence}`); return; }
    if(command.sequence<expected){ rejectedCounter++; log('t-warn',`stale command player=${command.playerId} expected=${expected} got=${command.sequence}`); return; }
    const previous=getPredictedTail(command.playerId);
    if(!previous||stateHash(previous)!==command.previousStateHash){ rejectedCounter++; log('t-warn',`state hash mismatch id=${command.commandId}`); return; }
    const pending={command,previousState:{...previous},nextState:predictNextState(previous,command),verdict:null,rejectReason:null,stalled:false,timeoutId:null,remote,receivedAt:performance.now()};
    pendingById.set(command.commandId,pending);
    const order=pendingOrderByPlayer.get(command.playerId)||[]; order.push(command.commandId); pendingOrderByPlayer.set(command.playerId,order);
    rebuildVisible(command.playerId);
    if(command.type==='shoot') spawnBullet(command);

    const orphan=orphanCertificates.get(command.commandId);
    if(orphan){ orphanCertificates.delete(command.commandId); applyVerificationCertificate(orphan); }

    if(command.type==='move'&&!pending.verdict){
        const result=evaluateCommand(command);
        pending.verdict=result.accepted?'accepted':'rejected'; pending.rejectReason=result.reason;
        log(result.accepted?'t-cmd':'t-warn',`move L1 ${result.accepted?'accepted':'rejected'} id=${command.commandId} seq=${command.sequence}`);
        drainCommits(command.playerId);
        return;
    }

    if(pending.verdict) return;
    const validators=validatorsFor(command),quorum=quorumFor(command);
    if(!validators.length||!quorum){ const result=evaluateCommand(command); pending.verdict=result.accepted?'accepted':'rejected'; pending.rejectReason=result.reason; log('t-sys',`${command.type} q0 fallback ${pending.verdict} id=${command.commandId}`); drainCommits(command.playerId); return; }
    log('t-cmd',`${command.type} tentative id=${command.commandId} seq=${command.sequence} validators=${validators.join(',')} quorum=${quorum}`);
    if(validators.includes(myId)) runAudit(command);
    pending.timeoutId=setTimeout(()=>{ const live=pendingById.get(command.commandId); if(live&&!live.verdict&&!live.stalled){ live.stalled=true; stalledCounter++; log('t-warn',`STALLED id=${command.commandId} committee=${validators.join(',')} certificate pending`); } },AUDIT_STALL_MS);
}

function runAudit(command){
    const result=evaluateCommand(command);
    const receipt={protocol:PROTOCOL,rulesetRevision:RULESET_REVISION,commandId:command.commandId,playerId:command.playerId,sequence:command.sequence,assignmentId:command.assignmentId,decision:result.accepted?'accept':'reject',reason:result.reason,computedHash:stableHash(result.computed||null),evidenceHash:stableHash(command)};
    // Audit transport도 같은 client-side netem 경계를 통과시킨다.
    // offer/ICE/join 같은 연결 제어면까지 느리게 하지는 않고 검증 receipt/certificate만 지연시킨다.
    scheduleNetem('tx','SERVER-AUDIT','verification-receipt',()=>{
        if(!sendSignal({type:'verification-receipt',receipt})) log('t-warn',`verification receipt signaling failed id=${command.commandId}`);
    });
}


function applyVerificationCertificate(certificate){
    if(!certificate||certificate.signalProtocol!==SIGNAL_PROTOCOL||certificate.playerId==null||certificate.assignmentId==null) return;
    const pending=pendingById.get(certificate.commandId);
    if(!pending){ orphanCertificates.set(certificate.commandId,certificate); setTimeout(()=>orphanCertificates.delete(certificate.commandId),10000); return; }
    const command=pending.command;
    if(certificate.playerId!==command.playerId||certificate.sequence!==command.sequence||certificate.assignmentId!==command.assignmentId){ invalidCounter++; log('t-err',`certificate mismatch id=${certificate.commandId}`); return; }
    pending.verdict=certificate.verdict==='accepted'?'accepted':'rejected';
    pending.certificateServerTime=Number.isFinite(certificate.serverTime)?certificate.serverTime:null;
    pending.rejectReason=pending.verdict==='accepted'?null:'server quorum certificate rejected';
    clearTimeout(pending.timeoutId);
    log(pending.verdict==='accepted'?'t-audit':'t-warn',`CERTIFICATE ${pending.verdict.toUpperCase()} seq=${command.sequence} id=${command.commandId}`);
    drainCommits(command.playerId);
}
function drainCommits(playerId){
    while(true){
        const expected=(confirmedSeq.get(playerId)||0)+1;
        const order=pendingOrderByPlayer.get(playerId)||[];
        const id=order.find(commandId=>pendingById.get(commandId)?.command.sequence===expected);
        if(!id) break;
        const pending=pendingById.get(id); if(!pending.verdict) break;
        if(pending.verdict==='accepted') commitCommand(pending.command,pending);
        else rejectCommand(pending.command,pending.rejectReason||'validator rejected');
    }
    rebuildVisible(playerId);
    acceptDeferred(playerId);
}
function commitCommand(command,pending){
    const current=confirmedWorld[command.playerId]||pending.previousState;
    let state={...pending.nextState,tentative:false};

    // 이동·사격 명령이 대기 중일 때 피격되더라도 옛 HP로 되돌리지 않는다.
    if(command.type==='move'||command.type==='shoot'){
        state={...state,hp:current.hp,alive:current.alive,lifeId:current.lifeId,deadObservedAt:current.deadObservedAt,deadServerAt:Number(current.deadServerAt)||0};
    }else if(command.type==='heal'){
        state={...state,hp:current.alive?Math.min(MAX_HP,current.hp+1):current.hp,alive:current.alive,lifeId:current.lifeId,deadObservedAt:current.deadObservedAt,deadServerAt:Number(current.deadServerAt)||0};
    }

    confirmedWorld[command.playerId]=state;
    confirmedSeq.set(command.playerId,command.sequence);
    const commitNow=performance.now();
    tickAnchors.set(command.playerId,{remoteTick:command.tick,localTime:commitNow});
    const activity=activityAnchors.get(command.playerId)||{lastMoveAt:commitNow,lastDamageAt:commitNow,lastHealAt:commitNow};
    if(command.type==='move') activity.lastMoveAt=commitNow;
    if(command.type==='heal') activity.lastHealAt=commitNow;
    if(command.type==='respawn') activity.lastMoveAt=activity.lastDamageAt=activity.lastHealAt=commitNow;
    activityAnchors.set(command.playerId,activity);
    removePending(command);
    confirmedCounter++;
    const latency=Math.max(0,performance.now()-pending.receivedAt); commitLatencySamples.push(latency); if(commitLatencySamples.length>COMMIT_LATENCY_SAMPLES) commitLatencySamples.shift();
    if(command.type==='shoot'&&command.claimedHitId) registerConfirmedHit(command,pending.certificateServerTime);
    if(command.type==='respawn') onRespawnCommitted(command,state);
    log('t-audit',`CONFIRMED seq=${command.sequence} type=${command.type} id=${command.commandId}`);
}
function rejectCommand(command,reason){
    removePending(command); rejectedCounter++; log('t-warn',`REJECTED seq=${command.sequence} id=${command.commandId} reason=${reason}`);
    if(command.playerId===myId) localSequence=(confirmedSeq.get(myId)||0)+(pendingOrderByPlayer.get(myId)||[]).length;
    rejectDependents(command.playerId,command.sequence);
}
function rejectDependents(playerId,sequence){
    for(const id of [...(pendingOrderByPlayer.get(playerId)||[])]){ const pending=pendingById.get(id); if(pending&&pending.command.sequence>sequence){ clearTimeout(pending.timeoutId); pendingById.delete(id); rejectedCounter++; log('t-warn',`dependent rollback id=${id}`); } }
    pendingOrderByPlayer.set(playerId,(pendingOrderByPlayer.get(playerId)||[]).filter(id=>pendingById.has(id)));
    // rejected sequence 뒤에 이미 만들어진 deferred 명령을 남기면 sequence hole이 영구화된다.
    for(const [id,item] of [...deferredCommands]){
        if(item.command.playerId===playerId&&item.command.sequence>=sequence){ deferredCommands.delete(id); seenCommandIds.delete(id); log('t-warn',`deferred dropped after rejection id=${id}`); }
    }
    if(playerId===myId){
        localSequence=(confirmedSeq.get(myId)||0)+(pendingOrderByPlayer.get(myId)||[]).length;
        const tail=getPredictedTail(myId); const movement=moveState[myId];
        if(movement&&tail){ movement.lastX=tail.x; movement.lastY=tail.y; }
        tracePosition('sequence:recovered',{force:true,extra:`rejected=${sequence} localSequence=${localSequence}`});
    }
}
function removePending(command){
    const pending=pendingById.get(command.commandId); if(pending) clearTimeout(pending.timeoutId);
    pendingById.delete(command.commandId);
    pendingOrderByPlayer.set(command.playerId,(pendingOrderByPlayer.get(command.playerId)||[]).filter(id=>id!==command.commandId));
}
function rebuildVisible(playerId){
    const base=confirmedWorld[playerId]; if(!base) return;
    let state={...base,tentative:false};
    for(const id of pendingOrderByPlayer.get(playerId)||[]){ const pending=pendingById.get(id); if(!pending) continue; pending.previousState={...state}; pending.nextState=predictNextState(state,pending.command); state={...pending.nextState}; }
    visibleWorld[playerId]=state;
    if(playerId===myId) queueLocalRenderTarget(state);
    else queueRemoteRenderTarget(playerId,state);
}
function acceptDeferred(playerId){
    let progressed=true;
    while(progressed){ progressed=false; const expected=(confirmedSeq.get(playerId)||0)+(pendingOrderByPlayer.get(playerId)||[]).length+1;
        const item=[...deferredCommands.values()].find(entry=>entry.command.playerId===playerId&&entry.command.sequence===expected);
        if(item){ deferredCommands.delete(item.command.commandId); seenCommandIds.delete(item.command.commandId); acceptCommand(item.command,item.remote); progressed=true; }
    }
}
