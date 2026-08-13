'use strict';

function validateEnvelope(remoteId,command){
    if(!command||command.protocol!==PROTOCOL||command.rulesetRevision!==RULESET_REVISION) return {ok:false,code:'PROTOCOL_RULESET',reason:'unsupported protocol/ruleset',fault:true};
    if(!['move','shoot','heal','respawn'].includes(command.type)) return {ok:false,code:'COMMAND_TYPE',reason:'unsupported command',fault:true};
    const expectedStream=command.type==='shoot'?'event':'simulation';
    if(command.stream!==expectedStream) return {ok:false,code:'STREAM_TYPE',reason:`command type ${command.type} must use ${expectedStream} stream`,fault:true};
    if(command.playerId!==remoteId) return {ok:false,code:'IDENTITY_MISMATCH',reason:`identity mismatch channel=${remoteId} payload=${command.playerId}`,fault:true};
    if(typeof command.commandId!=='string'||command.commandId.length>160) return {ok:false,code:'COMMAND_ID',reason:'invalid commandId',fault:true};
    if(!Number.isSafeInteger(command.tick)||command.tick<0) return {ok:false,code:'TICK',reason:'invalid tick',fault:true};
    if(typeof command.assignmentId!=='string'||command.assignmentId.length>64||!Number.isSafeInteger(command.topologyEpoch)) return {ok:false,code:'ASSIGNMENT_SHAPE',reason:'invalid assignment',fault:true};
    if(!Number.isFinite(command.aoiRadius)||command.aoiRadius<120||command.aoiRadius>1400) return {ok:false,code:'AOI',reason:'invalid AOI radius',fault:true};

    if(expectedStream==='simulation'){
        if(!Number.isSafeInteger(command.sequence)||command.sequence<1) return {ok:false,code:'SEQUENCE',reason:'invalid simulation sequence',fault:true};
        if(typeof command.previousStateHash!=='string') return {ok:false,code:'PREVIOUS_HASH',reason:'invalid previousStateHash',fault:true};
    }else{
        if(!Number.isSafeInteger(command.eventSeq)||command.eventSeq<1) return {ok:false,code:'EVENT_SEQUENCE',reason:'invalid event sequence',fault:true};
        if(!command.simulationRef||!Number.isSafeInteger(command.simulationRef.sequence)||command.simulationRef.sequence<0||typeof command.simulationRef.stateHash!=='string') return {ok:false,code:'SIMULATION_REF',reason:'invalid simulation reference',fault:true};
    }

    if(command.type==='move'&&![command.dx,command.dy,command.claimedX,command.claimedY].every(Number.isFinite)) return {ok:false,code:'MOVE_SHAPE',reason:'invalid move values',fault:true};
    if(command.type==='shoot'&&(![command.aimX,command.aimY].every(Number.isFinite)||!Array.isArray(command.checkpoint)||command.checkpoint.length>64)) return {ok:false,code:'SHOOT_SHAPE',reason:'invalid shoot values',fault:true};
    if(command.type==='heal'&&!Number.isSafeInteger(command.claimedHp)) return {ok:false,code:'HEAL_SHAPE',reason:'invalid heal value',fault:true};
    if(command.type==='respawn'&&(!Number.isFinite(command.spawnX)||!Number.isFinite(command.spawnY)||!Number.isSafeInteger(command.nextLifeId))) return {ok:false,code:'RESPAWN_SHAPE',reason:'invalid respawn values',fault:true};
    return {ok:true};
}

function verificationRequired(commandOrType){
    const type=typeof commandOrType==='string'?commandOrType:commandOrType?.type;
    return type==='shoot'||type==='heal'||type==='respawn';
}

function rememberCommandId(command){
    const id=command.commandId;
    seenCommandIds.add(id);
    seenCommandFingerprintById.set(id,commandFingerprint(command));
    seenCommandQueue.push(id);
    if(seenCommandQueue.length>10000){
        const old=seenCommandQueue.shift();
        seenCommandIds.delete(old);
        seenCommandFingerprintById.delete(old);
    }
}

function classifyCommandIdReplay(command){
    if(!seenCommandIds.has(command.commandId)) return null;
    const first=seenCommandFingerprintById.get(command.commandId);
    const now=commandFingerprint(command);
    if(first===now) return {kind:ARRIVAL_DISPOSITION.IGNORE,code:'COMMAND_ID_DUPLICATE',reason:'same commandId and same event already observed'};
    return {kind:ARRIVAL_DISPOSITION.FAULT,code:'COMMAND_ID_CONFLICT',reason:'same commandId reused with different event content'};
}

function makeNoopState(previous,command,{advanceTick=false}={}){
    return {
        ...previous,
        sequence:command.sequence,
        tick:advanceTick?Math.max(previous.tick,command.tick):previous.tick,
        tentative:true,
    };
}

function addPending(command,remote,{verdict=null,rejectCode=null,rejectReason=null,advanceTick=false,noOp=false,previousState=null}={}){
    const stream=commandStream(command);
    const previous=previousState||(stream==='event'?null:getPredictedTail(command.playerId));
    if(!previous) return null;
    const nextState=stream==='event'
        ? {...previous,tentative:false}
        : noOp?makeNoopState(previous,command,{advanceTick}):predictNextState(previous,command);
    const pending={
        command,
        previousState:{...previous},
        nextState,
        verdict,
        rejectCode,
        rejectReason,
        advanceTick,
        stalled:false,
        timeoutId:null,
        remote,
        receivedAt:performance.now(),
    };
    pendingById.set(command.commandId,pending);
    const orders=stream==='event'?pendingEventOrderByPlayer:pendingOrderByPlayer;
    const order=orders.get(command.playerId)||[];
    order.push(command.commandId);
    order.sort((a,b)=>(commandStreamSequence(pendingById.get(a)?.command)||0)-(commandStreamSequence(pendingById.get(b)?.command)||0));
    orders.set(command.playerId,order);
    if(stream==='simulation') rebuildVisible(command.playerId);
    return pending;
}

function removePending(command){
    const pending=pendingById.get(command.commandId);
    if(pending) clearTimeout(pending.timeoutId);
    pendingById.delete(command.commandId);
    const orders=commandStream(command)==='event'?pendingEventOrderByPlayer:pendingOrderByPlayer;
    orders.set(command.playerId,(orders.get(command.playerId)||[]).filter(id=>id!==command.commandId));
}

function executeLocal(command){
    if(!command) return;
    ingestCommand(command,false);
    const policy=policyForCommand(command);
    for(const id of policy?.directPeers||[]) if(isPeerOpen(id)) safeDataSend(id,{kind:'command',command});
}

function receiveCommand(remoteId,command){
    const validation=validateEnvelope(remoteId,command);
    if(!validation.ok){
        if(validation.fault) reportProtocolFault(command||{playerId:remoteId,sequence:null},validation.code,validation.reason,{remote:true});
        else invalidCounter++;
        return;
    }
    ingestCommand(command,true);
}

function handleRuleResult(command,pending,result){
    if(!pending) return;
    if(result.disposition===RULE_DISPOSITION.ACCEPT){
        pending.verdict='accepted';
        pending.advanceTick=result.advanceTick!==false;
        pending.rejectCode=null;
        pending.rejectReason=null;
        return;
    }
    if(result.disposition===RULE_DISPOSITION.REJECT){
        pending.verdict='rejected';
        pending.rejectCode=result.code||'RULE_REJECTED';
        pending.rejectReason=result.reason||'rule rejected';
        pending.advanceTick=result.advanceTick===true;
        return;
    }
    if(result.disposition===RULE_DISPOSITION.DEFER){
        removePending(command);
        deferCommand(command,pending.remote,result.code,result.reason,{retryMs:result.retryMs});
        return;
    }
    if(result.disposition===RULE_DISPOSITION.RESYNC){
        removePending(command);
        deferCommand(command,pending.remote,result.code,result.reason);
        if(pending.remote) requestPeerResync(command.playerId,result.code);
        else log('t-warn',`local RESYNC requested code=${result.code} ${commandSequenceText(command)}`);
        return;
    }
    if(result.disposition===RULE_DISPOSITION.FAULT){
        removePending(command);
        reportProtocolFault(command,result.code,result.reason,{remote:pending.remote});
    }
}

function ingestCommand(command,remote,{reentry=false}={}){
    if(!reentry){
        const replay=classifyCommandIdReplay(command);
        if(replay?.kind===ARRIVAL_DISPOSITION.IGNORE){ noteIgnored(command,replay.code,replay.reason); return; }
        if(replay?.kind===ARRIVAL_DISPOSITION.FAULT){ reportProtocolFault(command,replay.code,replay.reason,{remote}); return; }
        rememberCommandId(command);
    }

    const sequenceDisposition=classifySequenceArrival(command);
    if(sequenceDisposition.kind===ARRIVAL_DISPOSITION.IGNORE){ noteIgnored(command,sequenceDisposition.code,sequenceDisposition.reason); return; }
    if(sequenceDisposition.kind===ARRIVAL_DISPOSITION.FAULT){ reportProtocolFault(command,sequenceDisposition.code,sequenceDisposition.reason,{remote}); return; }
    if(sequenceDisposition.kind===ARRIVAL_DISPOSITION.DEFER){ deferCommand(command,remote,sequenceDisposition.code,sequenceDisposition.reason); return; }

    let previous=null;
    if(commandStream(command)==='event'){
        const ref=resolveSimulationReference(command.playerId,command.simulationRef);
        if(ref.status==='pending'){
            deferCommand(command,remote,'SIMULATION_REF_PENDING',`waiting for simulation seq=${command.simulationRef.sequence}`,{retryMs:TEMPORAL_RETRY_MIN_MS*2});
            return;
        }
        if(ref.status==='missing'||ref.status==='invalid'){
            deferCommand(command,remote,'SIMULATION_REF_MISSING',`historical simulation ref unavailable seq=${command.simulationRef?.sequence??'-'}`);
            if(remote) requestPeerResync(command.playerId,'simulation-ref-missing',{requestedSequence:command.simulationRef?.sequence,requestedStateHash:command.simulationRef?.stateHash});
            return;
        }
        previous=ref.state; // mismatch is intentionally audited/rejected, not treated as a transport fault.
    }else{
        previous=getPredictedTail(command.playerId);
        if(!previous){
            deferCommand(command,remote,'NO_BASE_STATE','missing base state');
            if(remote) requestPeerResync(command.playerId,'missing-base-state');
            return;
        }

        if(stateHash(previous)!==command.previousStateHash){
            if(previousDispositionSupportsDependencyReject(command)){
                const pending=addPending(command,remote,{verdict:'rejected',rejectCode:'DEPENDENCY_INVALIDATED',rejectReason:`depends on rejected/invalidated seq=${command.sequence-1}`,advanceTick:false,noOp:true});
                if(pending){ log('t-sys',`REJECT-NOOP dependency player=${command.playerId} seq=${command.sequence}`); drainCommits(command.playerId); }
                return;
            }
            deferCommand(command,remote,'STATE_HASH_MISMATCH',`previous state hash mismatch seq=${command.sequence}`);
            if(remote) requestPeerResync(command.playerId,'state-hash-mismatch');
            return;
        }
    }

    const pending=addPending(command,remote,{previousState:previous});
    if(!pending) return;
    if(command.type==='shoot') spawnBullet(command,previous);

    const orphan=orphanCertificates.get(command.commandId);
    if(orphan){ orphanCertificates.delete(command.commandId); applyVerificationCertificate(orphan); }

    if(command.type==='move'){
        const result=evaluateCommand(command,pending);
        handleRuleResult(command,pending,result);
        const live=pendingById.get(command.commandId);
        if(live?.verdict){
            log(live.verdict==='accepted'?'t-cmd':'t-warn',`move L1 ${live.verdict} code=${live.rejectCode||'OK'} id=${command.commandId} seq=${command.sequence}`);
            drainCommits(command.playerId);
        }
        return;
    }

    if(!pendingById.has(command.commandId)) return;
    const validators=validatorsFor(command),quorum=quorumFor(command);
    if(!validators.length||!quorum){
        if(serverPeerCount<=1&&directOpenPeerIds().length===0){
            const result=evaluateCommand(command,pending);
            handleRuleResult(command,pending,result);
            const live=pendingById.get(command.commandId);
            if(live?.verdict){
                log('t-sys',`${command.type} solo fallback ${live.verdict} id=${command.commandId}`);
                if(commandStream(command)==='event') drainEventCommits(command.playerId); else drainCommits(command.playerId);
            }
        }else{
            pending.stalled=true;
            stalledCounter++;
            log('t-warn',`STALLED ${command.type} id=${command.commandId}: validators unavailable; q0 fallback disabled in multiplayer`);
        }
        return;
    }

    log('t-cmd',`${command.type} tentative id=${command.commandId} ${commandSequenceText(command)}${command.type==='shoot'?` refSim=${command.simulationRef.sequence}`:''} validators=${validators.join(',')} quorum=${quorum}`);
    if(validators.includes(myId)) runAudit(command);
    pending.timeoutId=setTimeout(()=>{
        const live=pendingById.get(command.commandId);
        if(live&&!live.verdict&&!live.stalled){
            live.stalled=true;
            stalledCounter++;
            log('t-warn',`STALLED id=${command.commandId} ${commandSequenceText(command)} committee=${validators.join(',')} certificate pending`);
        }
    },AUDIT_STALL_MS);
}

function drainCommits(playerId){
    let hadRejected=false,lastRejectCode=null;
    while(true){
        const expected=(confirmedSeq.get(playerId)||0)+1;
        const pending=pendingAtSequence(playerId,expected);
        if(!pending||!pending.verdict) break;
        if(pending.verdict==='accepted') commitCommand(pending.command,pending);
        else { lastRejectCode=pending.rejectCode||'REJECTED'; finalizeRejectedCommand(pending.command,pending); hadRejected=true; }
    }
    rebuildVisible(playerId);
    if(hadRejected&&playerId===myId) rebaseLocalMovementAfterRejection(confirmedSeq.get(myId)||0,lastRejectCode||'REJECTED');
    acceptDeferred(playerId,'simulation');
    // A newly committed simulation pose may unlock a shoot that arrived earlier.
    acceptDeferred(playerId,'event');
}

function commitCommand(command,pending){
    const current=confirmedWorld[command.playerId]||pending.previousState;
    const beforeHash=stateHash(current);
    let state={...pending.nextState,tentative:false};

    if(command.type==='move'){
        state={...state,hp:current.hp,alive:current.alive,lifeId:current.lifeId,deadObservedAt:current.deadObservedAt,deadServerAt:Number(current.deadServerAt)||0};
    }else if(command.type==='heal'){
        state={...state,hp:current.alive?Math.min(MAX_HP,current.hp+1):current.hp,alive:current.alive,lifeId:current.lifeId,deadObservedAt:current.deadObservedAt,deadServerAt:Number(current.deadServerAt)||0};
    }

    confirmedWorld[command.playerId]=state;
    confirmedSeq.set(command.playerId,command.sequence);
    rememberSimulationState(command.playerId,state);
    const commitNow=performance.now();
    const activity=activityAnchors.get(command.playerId)||{lastMoveAt:commitNow,lastDamageAt:commitNow,lastHealAt:commitNow};
    if(command.type==='move') activity.lastMoveAt=commitNow;
    if(command.type==='heal') activity.lastHealAt=commitNow;
    if(command.type==='respawn') activity.lastMoveAt=activity.lastDamageAt=activity.lastHealAt=commitNow;
    activityAnchors.set(command.playerId,activity);

    removePending(command);
    confirmedCounter++;
    const latency=Math.max(0,performance.now()-pending.receivedAt);
    commitLatencySamples.push(latency);
    if(commitLatencySamples.length>COMMIT_LATENCY_SAMPLES) commitLatencySamples.shift();
    if(command.type==='respawn') onRespawnCommitted(command,state);
    recordFinalizedEvent(command,FINAL_DISPOSITION.ACCEPTED,'accepted',{beforeHash,afterHash:stateHash(state),code:'ACCEPTED'});
    log('t-audit',`CONFIRMED seq=${command.sequence} type=${command.type} id=${command.commandId}`);
}

function finalizeRejectedCommand(command,pending){
    const current=confirmedWorld[command.playerId]||pending.previousState;
    const beforeHash=stateHash(current);
    const state={...current,sequence:command.sequence,tick:pending.advanceTick?Math.max(current.tick,command.tick):current.tick,tentative:false};
    confirmedWorld[command.playerId]=state;
    confirmedSeq.set(command.playerId,command.sequence);
    rememberSimulationState(command.playerId,state);
    removePending(command);
    rejectedCounter++;
    recordFinalizedEvent(command,pending.rejectCode==='DEPENDENCY_INVALIDATED'?FINAL_DISPOSITION.INVALIDATED:FINAL_DISPOSITION.REJECTED,pending.rejectReason||'rejected',{beforeHash,afterHash:stateHash(state),code:pending.rejectCode});
    log('t-warn',`REJECTED-NOOP seq=${command.sequence} id=${command.commandId} code=${pending.rejectCode||'REJECTED'} reason=${pending.rejectReason||'-'}`);
    reconcilePendingDependencies(command.playerId);
}

function drainEventCommits(playerId){
    while(true){
        const expected=(confirmedEventSeq.get(playerId)||0)+1;
        const pending=pendingAtEventSequence(playerId,expected);
        if(!pending||!pending.verdict) break;
        if(pending.verdict==='accepted') finalizeAcceptedEvent(pending.command,pending);
        else finalizeRejectedEvent(pending.command,pending);
    }
    // Event rejection/latency must never rebase or block the movement stream.
    acceptDeferred(playerId,'event');
}

function finalizeAcceptedEvent(command,pending){
    const current=confirmedWorld[command.playerId]||pending.previousState;
    const beforeHash=current?stateHash(current):null;
    confirmedEventSeq.set(command.playerId,command.eventSeq);
    removePending(command);
    confirmedCounter++;
    const latency=Math.max(0,performance.now()-pending.receivedAt);
    commitLatencySamples.push(latency);
    if(commitLatencySamples.length>COMMIT_LATENCY_SAMPLES) commitLatencySamples.shift();
    if(command.type==='shoot'&&command.claimedHitId) registerConfirmedHit(command,pending.certificateServerTime);
    recordFinalizedEvent(command,FINAL_DISPOSITION.ACCEPTED,'accepted',{beforeHash,afterHash:beforeHash,code:'ACCEPTED'});
    log('t-audit',`CONFIRMED eventSeq=${command.eventSeq} type=${command.type} refSim=${command.simulationRef?.sequence??'-'} id=${command.commandId}`);
}

function finalizeRejectedEvent(command,pending){
    const current=confirmedWorld[command.playerId]||pending.previousState;
    const beforeHash=current?stateHash(current):null;
    confirmedEventSeq.set(command.playerId,command.eventSeq);
    removePending(command);
    rejectedCounter++;
    recordFinalizedEvent(command,FINAL_DISPOSITION.REJECTED,pending.rejectReason||'rejected',{beforeHash,afterHash:beforeHash,code:pending.rejectCode});
    log('t-warn',`REJECTED-EVENT-NOOP eventSeq=${command.eventSeq} id=${command.commandId} code=${pending.rejectCode||'REJECTED'} reason=${pending.rejectReason||'-'}`);
}

function reconcilePendingDependencies(playerId){
    let state=confirmedWorld[playerId];
    if(!state) return;
    let expected=(confirmedSeq.get(playerId)||0)+1;
    const ids=[...(pendingOrderByPlayer.get(playerId)||[])].sort((a,b)=>(pendingById.get(a)?.command.sequence||0)-(pendingById.get(b)?.command.sequence||0));
    for(const id of ids){
        const pending=pendingById.get(id);
        if(!pending) continue;
        const command=pending.command;
        if(command.sequence<expected) continue;
        if(command.sequence>expected) break;

        pending.previousState={...state};
        const dependencyMatches=command.previousStateHash===stateHash(state);
        if(!dependencyMatches){
            clearTimeout(pending.timeoutId);
            pending.verdict='rejected';
            pending.rejectCode='DEPENDENCY_INVALIDATED';
            pending.rejectReason=`previousStateHash no longer matches canonical prefix at seq=${command.sequence-1}`;
            pending.advanceTick=false;
            pending.nextState=makeNoopState(state,command,{advanceTick:false});
        }else if(pending.verdict==='rejected'){
            pending.nextState=makeNoopState(state,command,{advanceTick:pending.advanceTick});
        }else{
            pending.nextState=predictNextState(state,command);
        }
        state={...pending.nextState};
        expected++;
    }
}

function rebuildVisible(playerId){
    const base=confirmedWorld[playerId];
    if(!base) return;
    let state={...base,tentative:false};
    const ids=[...(pendingOrderByPlayer.get(playerId)||[])].sort((a,b)=>(pendingById.get(a)?.command.sequence||0)-(pendingById.get(b)?.command.sequence||0));
    for(const id of ids){
        const pending=pendingById.get(id);
        if(!pending) continue;
        pending.previousState={...state};
        if(pending.verdict==='rejected') pending.nextState=makeNoopState(state,pending.command,{advanceTick:pending.advanceTick});
        else pending.nextState=predictNextState(state,pending.command);
        state={...pending.nextState};
    }
    visibleWorld[playerId]=state;
    if(playerId===myId) queueLocalRenderTarget(state);
    else queueRemoteRenderTarget(playerId,state);
}

function acceptDeferred(playerId,stream='simulation'){
    let progressed=true;
    while(progressed){
        progressed=false;
        const expected=expectedSequenceFor(playerId,stream);
        const item=deferredAtStreamSequence(playerId,expected,stream);
        if(!item) break;
        clearDeferredCommand(item.command.commandId);
        ingestCommand(item.command,item.remote,{reentry:true});
        progressed=true;
        if(deferredAtStreamSequence(playerId,expected,stream)) break;
    }
}
