'use strict';

// Arrival handling is deliberately separate from game-rule verdicts.
// PeerReview-inspired rule: same sequence + different event is evidence of equivocation;
// ordinary duplicates, reordering and repairable state mismatch are not trust faults.
const ARRIVAL_DISPOSITION = Object.freeze({
    PROCEED:'PROCEED',
    IGNORE:'IGNORE',
    DEFER:'DEFER',
    RESYNC:'RESYNC',
    FAULT:'FAULT',
});

const FINAL_DISPOSITION = Object.freeze({
    ACCEPTED:'ACCEPTED',
    REJECTED:'REJECTED',
    INVALIDATED:'INVALIDATED',
});

const lastResyncRequestAt = new Map();

function commandFingerprint(command){
    // TODO(Security): replace the 32-bit demo hash with SHA-256/BLAKE3 + actor authentication.
    return stableHash(command);
}

function historyFor(playerId){
    let history=finalizedEventHistory.get(playerId);
    if(!history){ history=new Map(); finalizedEventHistory.set(playerId,history); }
    return history;
}

function finalizedRecord(playerId,sequence){
    return finalizedEventHistory.get(playerId)?.get(sequence)||null;
}

function recordFinalizedEvent(command,disposition,reason,{beforeHash=null,afterHash=null,code=null}={}){
    const history=historyFor(command.playerId);
    history.set(command.sequence,{
        sequence:command.sequence,
        commandId:command.commandId,
        fingerprint:commandFingerprint(command),
        disposition,
        code:code||disposition,
        reason:String(reason||''),
        beforeHash,
        afterHash,
        finalizedAt:Date.now(),
    });
    while(history.size>FINALIZED_HISTORY_LIMIT){
        const oldest=history.keys().next().value;
        history.delete(oldest);
    }
}

function pendingAtSequence(playerId,sequence){
    for(const id of pendingOrderByPlayer.get(playerId)||[]){
        const pending=pendingById.get(id);
        if(pending?.command.sequence===sequence) return pending;
    }
    return null;
}

function deferredAtSequence(playerId,sequence){
    for(const item of deferredCommands.values()) if(item.command.playerId===playerId&&item.command.sequence===sequence) return item;
    return null;
}

function expectedSequenceFor(playerId){
    let expected=(confirmedSeq.get(playerId)||0)+1;
    const pendingSeqs=new Set((pendingOrderByPlayer.get(playerId)||[]).map(id=>pendingById.get(id)?.command.sequence).filter(Number.isSafeInteger));
    while(pendingSeqs.has(expected)) expected++;
    return expected;
}

function classifySequenceArrival(command){
    const fingerprint=commandFingerprint(command);
    const finalized=finalizedRecord(command.playerId,command.sequence);
    if(finalized){
        if(finalized.fingerprint===fingerprint) return {kind:ARRIVAL_DISPOSITION.IGNORE,code:'FINALIZED_DUPLICATE',reason:`already finalized seq=${command.sequence}`};
        return {kind:ARRIVAL_DISPOSITION.FAULT,code:'EQUIVOCATION_FINALIZED',reason:`same sequence carries a different finalized event seq=${command.sequence}`};
    }

    const pending=pendingAtSequence(command.playerId,command.sequence);
    if(pending){
        if(commandFingerprint(pending.command)===fingerprint) return {kind:ARRIVAL_DISPOSITION.IGNORE,code:'PENDING_DUPLICATE',reason:`already pending seq=${command.sequence}`};
        return {kind:ARRIVAL_DISPOSITION.FAULT,code:'EQUIVOCATION_PENDING',reason:`same sequence carries a different pending event seq=${command.sequence}`};
    }

    const deferred=deferredAtSequence(command.playerId,command.sequence);
    if(deferred){
        if(commandFingerprint(deferred.command)===fingerprint) return {kind:ARRIVAL_DISPOSITION.IGNORE,code:'DEFERRED_DUPLICATE',reason:`already deferred seq=${command.sequence}`};
        return {kind:ARRIVAL_DISPOSITION.FAULT,code:'EQUIVOCATION_DEFERRED',reason:`same sequence carries a different deferred event seq=${command.sequence}`};
    }

    const expected=expectedSequenceFor(command.playerId);
    if(command.sequence>expected) return {kind:ARRIVAL_DISPOSITION.DEFER,code:'SEQUENCE_GAP',reason:`waiting for seq=${expected}; got=${command.sequence}`};
    if(command.sequence<expected){
        // History may have been pruned. Without two conflicting authenticators, stale data is not a trust fault.
        return {kind:ARRIVAL_DISPOSITION.IGNORE,code:'STALE_UNTRACKED',reason:`stale seq=${command.sequence}; expected=${expected}`};
    }
    return {kind:ARRIVAL_DISPOSITION.PROCEED,code:'EXPECTED',reason:'expected sequence'};
}

function noteIgnored(command,code,reason){
    ignoredCounter++;
    if(code.includes('DUPLICATE')) duplicateCounter++;
    if(AUTO_DEBUG) log('t-sys',`IGNORE ${code} player=${command.playerId} seq=${command.sequence} ${reason}`);
}

function reportProtocolFault(command,code,reason,{remote=false}={}){
    faultCounter++;
    invalidCounter++;
    log('t-err',`FAULT ${code} player=${command?.playerId||'-'} seq=${command?.sequence??'-'} reason=${reason}`);
    // TODO(Trust Policy): only cryptographically attributable faults should affect trust/reputation.
    if(remote&&command?.playerId) requestPeerResync(command.playerId,`fault:${code}`);
}

function countDeferredForPlayer(playerId){
    let count=0;
    for(const item of deferredCommands.values()) if(item.command.playerId===playerId) count++;
    return count;
}

function clearTemporalTimer(commandId){
    const timer=temporalRetryTimers.get(commandId);
    if(timer){ clearTimeout(timer); temporalRetryTimers.delete(commandId); }
}

function clearDeferredCommand(commandId){
    clearTemporalTimer(commandId);
    deferredCommands.delete(commandId);
}

function deferCommand(command,remote,code,reason,{retryMs=null,reentry=false}={}){
    const existing=deferredCommands.get(command.commandId);
    if(!existing&&countDeferredForPlayer(command.playerId)>=MAX_DEFERRED_PER_PLAYER){
        log('t-warn',`DEFER overflow player=${command.playerId}; requesting resync instead of growing memory`);
        if(remote) requestPeerResync(command.playerId,'deferred-overflow');
        return false;
    }
    const firstDeferredAt=existing?.firstDeferredAt??performance.now();
    deferredCommands.set(command.commandId,{command,remote,code,reason,firstDeferredAt,lastDeferredAt:performance.now()});
    if(!existing) deferredCounter++;
    if(AUTO_DEBUG||code!=='SEQUENCE_GAP') log('t-sys',`DEFER ${code} player=${command.playerId} seq=${command.sequence} reason=${reason}`);

    clearTemporalTimer(command.commandId);
    if(Number.isFinite(retryMs)){
        const delay=Math.max(TEMPORAL_RETRY_MIN_MS,Math.min(TEMPORAL_DEFER_MAX_MS,retryMs));
        const timer=setTimeout(()=>retryDeferredCommand(command.commandId),delay);
        temporalRetryTimers.set(command.commandId,timer);
    }
    return true;
}

function retryDeferredCommand(commandId){
    clearTemporalTimer(commandId);
    const item=deferredCommands.get(commandId);
    if(!item) return;
    if(performance.now()-item.firstDeferredAt>TEMPORAL_DEFER_MAX_MS&&item.code==='TICK_AHEAD'){
        deferredCommands.delete(commandId);
        if(item.remote) requestPeerResync(item.command.playerId,'temporal-defer-timeout');
        log('t-warn',`RESYNC temporal timeout player=${item.command.playerId} seq=${item.command.sequence}`);
        return;
    }
    deferredCommands.delete(commandId);
    ingestCommand(item.command,item.remote,{reentry:true});
}

function requestPeerResync(playerId,reason){
    if(!playerId||playerId===myId||!isPeerOpen(playerId)) return false;
    const now=performance.now();
    if(now-(lastResyncRequestAt.get(playerId)||0)<500) return false;
    lastResyncRequestAt.set(playerId,now);
    resyncCounter++;
    const local=confirmedWorld[playerId];
    safeDataSend(playerId,{kind:'resyncRequest',request:{protocol:PROTOCOL,requesterId:myId,playerId,knownSequence:confirmedSeq.get(playerId)||0,knownStateHash:local?stateHash(local):null,reason:String(reason||'state mismatch').slice(0,120)}});
    log('t-sys',`RESYNC request player=${playerId} known=${confirmedSeq.get(playerId)||0} reason=${reason}`);
    return true;
}

function receiveResyncRequest(remoteId,request){
    if(!request||request.protocol!==PROTOCOL||request.requesterId!==remoteId||request.playerId!==myId) return;
    log('t-sys',`RESYNC requested by=${remoteId} peerKnown=${request.knownSequence??'-'} reason=${request.reason||'-'}`);
    sendSnapshot(remoteId);
}

function reconcileEventStreamFromSnapshot(playerId,snapshotSequence){
    // Raft-inspired repair principle, without Raft consensus: the snapshot covers every event
    // through snapshotSequence. Later commands are not evidence of misbehavior; preserve them
    // and replay from the repaired prefix instead of manufacturing a permanent sequence hole.
    const future=[];
    for(const id of [...(pendingOrderByPlayer.get(playerId)||[])]){
        const pending=pendingById.get(id);
        if(!pending) continue;
        clearTimeout(pending.timeoutId);
        if(pending.command.sequence>snapshotSequence) future.push({command:pending.command,remote:pending.remote});
        pendingById.delete(id);
    }
    pendingOrderByPlayer.set(playerId,[]);
    for(const [id,item] of [...deferredCommands]){
        if(item.command.playerId!==playerId) continue;
        if(item.command.sequence<=snapshotSequence) clearDeferredCommand(id);
        else future.push({command:item.command,remote:item.remote});
    }
    for(const item of future){
        clearDeferredCommand(item.command.commandId);
        deferCommand(item.command,item.remote,'POST_RESYNC_REPLAY',`replay after repaired prefix seq=${snapshotSequence}`,{reentry:true});
    }
    resyncCounter++;
}

function previousDispositionSupportsDependencyReject(command){
    const prior=finalizedRecord(command.playerId,command.sequence-1);
    return prior&&[FINAL_DISPOSITION.REJECTED,FINAL_DISPOSITION.INVALIDATED].includes(prior.disposition);
}
