'use strict';

// Arrival handling is separate from game-rule verdicts.
// Sequence identity is per stream: simulation and consequential events do not block each other.
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

function historyFor(playerId,stream='simulation'){
    const root=stream==='event'?finalizedCombatEventHistory:finalizedEventHistory;
    let history=root.get(playerId);
    if(!history){ history=new Map(); root.set(playerId,history); }
    return history;
}

function finalizedRecord(playerId,sequence){ return finalizedEventHistory.get(playerId)?.get(sequence)||null; }
function finalizedEventRecord(playerId,eventSeq){ return finalizedCombatEventHistory.get(playerId)?.get(eventSeq)||null; }

function finalizedRecordForCommand(command){
    const stream=commandStream(command),seq=commandStreamSequence(command);
    return stream==='event'?finalizedEventRecord(command.playerId,seq):finalizedRecord(command.playerId,seq);
}

function recordFinalizedEvent(command,disposition,reason,{beforeHash=null,afterHash=null,code=null}={}){
    const stream=commandStream(command),sequence=commandStreamSequence(command);
    const history=historyFor(command.playerId,stream);
    history.set(sequence,{
        stream,
        sequence,
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

function orderForStream(playerId,stream='simulation'){
    return (stream==='event'?pendingEventOrderByPlayer:pendingOrderByPlayer).get(playerId)||[];
}

function pendingAtStreamSequence(playerId,sequence,stream='simulation'){
    for(const id of orderForStream(playerId,stream)){
        const pending=pendingById.get(id);
        if(pending&&commandStreamSequence(pending.command)===sequence) return pending;
    }
    return null;
}
function pendingAtSequence(playerId,sequence){ return pendingAtStreamSequence(playerId,sequence,'simulation'); }
function pendingAtEventSequence(playerId,eventSeq){ return pendingAtStreamSequence(playerId,eventSeq,'event'); }

function deferredAtStreamSequence(playerId,sequence,stream='simulation'){
    for(const item of deferredCommands.values()){
        if(item.command.playerId===playerId&&commandStream(item.command)===stream&&commandStreamSequence(item.command)===sequence) return item;
    }
    return null;
}
function deferredAtSequence(playerId,sequence){ return deferredAtStreamSequence(playerId,sequence,'simulation'); }
function deferredAtEventSequence(playerId,eventSeq){ return deferredAtStreamSequence(playerId,eventSeq,'event'); }

function confirmedStreamSequence(playerId,stream='simulation'){
    return stream==='event'?(confirmedEventSeq.get(playerId)||0):(confirmedSeq.get(playerId)||0);
}

function expectedSequenceFor(playerId,stream='simulation'){
    let expected=confirmedStreamSequence(playerId,stream)+1;
    const pendingSeqs=new Set(orderForStream(playerId,stream).map(id=>commandStreamSequence(pendingById.get(id)?.command)).filter(Number.isSafeInteger));
    while(pendingSeqs.has(expected)) expected++;
    return expected;
}

function classifySequenceArrival(command){
    const stream=commandStream(command),sequence=commandStreamSequence(command),fingerprint=commandFingerprint(command);
    const finalized=finalizedRecordForCommand(command);
    if(finalized){
        if(finalized.fingerprint===fingerprint) return {kind:ARRIVAL_DISPOSITION.IGNORE,code:'FINALIZED_DUPLICATE',reason:`already finalized ${stream} seq=${sequence}`};
        return {kind:ARRIVAL_DISPOSITION.FAULT,code:'EQUIVOCATION_FINALIZED',reason:`same ${stream} sequence carries a different finalized event seq=${sequence}`};
    }

    const pending=pendingAtStreamSequence(command.playerId,sequence,stream);
    if(pending){
        if(commandFingerprint(pending.command)===fingerprint) return {kind:ARRIVAL_DISPOSITION.IGNORE,code:'PENDING_DUPLICATE',reason:`already pending ${stream} seq=${sequence}`};
        return {kind:ARRIVAL_DISPOSITION.FAULT,code:'EQUIVOCATION_PENDING',reason:`same ${stream} sequence carries a different pending event seq=${sequence}`};
    }

    const deferred=deferredAtStreamSequence(command.playerId,sequence,stream);
    if(deferred){
        if(commandFingerprint(deferred.command)===fingerprint) return {kind:ARRIVAL_DISPOSITION.IGNORE,code:'DEFERRED_DUPLICATE',reason:`already deferred ${stream} seq=${sequence}`};
        return {kind:ARRIVAL_DISPOSITION.FAULT,code:'EQUIVOCATION_DEFERRED',reason:`same ${stream} sequence carries a different deferred event seq=${sequence}`};
    }

    const expected=expectedSequenceFor(command.playerId,stream);
    if(sequence>expected) return {kind:ARRIVAL_DISPOSITION.DEFER,code:'SEQUENCE_GAP',reason:`waiting for ${stream} seq=${expected}; got=${sequence}`};
    if(sequence<expected){
        return {kind:ARRIVAL_DISPOSITION.IGNORE,code:'STALE_UNTRACKED',reason:`stale ${stream} seq=${sequence}; expected=${expected}`};
    }
    return {kind:ARRIVAL_DISPOSITION.PROCEED,code:'EXPECTED',reason:'expected stream sequence'};
}

function noteIgnored(command,code,reason){
    ignoredCounter++;
    if(code.includes('DUPLICATE')) duplicateCounter++;
    if(AUTO_DEBUG) log('t-sys',`IGNORE ${code} player=${command.playerId} ${commandSequenceText(command)} ${reason}`);
}

function reportProtocolFault(command,code,reason,{remote=false}={}){
    faultCounter++;
    invalidCounter++;
    log('t-err',`FAULT ${code} player=${command?.playerId||'-'} ${command?commandSequenceText(command):'seq=-'} reason=${reason}`);
    // TODO(Trust Policy): only cryptographically attributable faults should affect trust/reputation.
    if(remote&&command?.playerId) requestPeerResync(command.playerId,`fault:${code}`);
}

function countDeferredForPlayer(playerId,stream=null){
    let count=0;
    for(const item of deferredCommands.values()) if(item.command.playerId===playerId&&(!stream||commandStream(item.command)===stream)) count++;
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
    const existing=deferredCommands.get(command.commandId),stream=commandStream(command);
    if(!existing&&countDeferredForPlayer(command.playerId,stream)>=MAX_DEFERRED_PER_PLAYER){
        log('t-warn',`DEFER overflow player=${command.playerId} stream=${stream}; requesting resync instead of growing memory`);
        if(remote) requestPeerResync(command.playerId,'deferred-overflow');
        return false;
    }
    const firstDeferredAt=existing?.firstDeferredAt??performance.now();
    deferredCommands.set(command.commandId,{command,remote,code,reason,firstDeferredAt,lastDeferredAt:performance.now()});
    if(!existing) deferredCounter++;
    if(AUTO_DEBUG||code!=='SEQUENCE_GAP') log('t-sys',`DEFER ${code} player=${command.playerId} ${commandSequenceText(command)} reason=${reason}`);

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
        log('t-warn',`RESYNC temporal timeout player=${item.command.playerId} ${commandSequenceText(item.command)}`);
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
    safeDataSend(playerId,{kind:'resyncRequest',request:{protocol:PROTOCOL,requesterId:myId,playerId,knownSequence:confirmedSeq.get(playerId)||0,knownEventSequence:confirmedEventSeq.get(playerId)||0,knownStateHash:local?stateHash(local):null,reason:String(reason||'state mismatch').slice(0,120)}});
    log('t-sys',`RESYNC request player=${playerId} known=${confirmedSeq.get(playerId)||0}/e${confirmedEventSeq.get(playerId)||0} reason=${reason}`);
    return true;
}

function receiveResyncRequest(remoteId,request){
    if(!request||request.protocol!==PROTOCOL||request.requesterId!==remoteId||request.playerId!==myId) return;
    log('t-sys',`RESYNC requested by=${remoteId} peerKnown=${request.knownSequence??'-'}/e${request.knownEventSequence??'-'} reason=${request.reason||'-'}`);
    sendSnapshot(remoteId);
}

function reconcileEventStreamFromSnapshot(playerId,snapshotSequence,snapshotEventSequence=confirmedEventSeq.get(playerId)||0){
    // Simulation repair preserves commands after the snapshot prefix.
    const futureSimulation=[];
    for(const id of [...(pendingOrderByPlayer.get(playerId)||[])]){
        const pending=pendingById.get(id);
        if(!pending) continue;
        clearTimeout(pending.timeoutId);
        if(pending.command.sequence>snapshotSequence) futureSimulation.push({command:pending.command,remote:pending.remote});
        pendingById.delete(id);
    }
    pendingOrderByPlayer.set(playerId,[]);

    // Event finality is independent. Snapshot eventSeq only trims events already represented by the snapshot.
    const futureEvents=[];
    for(const id of [...(pendingEventOrderByPlayer.get(playerId)||[])]){
        const pending=pendingById.get(id);
        if(!pending) continue;
        clearTimeout(pending.timeoutId);
        if(pending.command.eventSeq>snapshotEventSequence) futureEvents.push({command:pending.command,remote:pending.remote});
        pendingById.delete(id);
    }
    pendingEventOrderByPlayer.set(playerId,[]);

    for(const [id,item] of [...deferredCommands]){
        if(item.command.playerId!==playerId) continue;
        const stream=commandStream(item.command),seq=commandStreamSequence(item.command);
        const covered=stream==='event'?seq<=snapshotEventSequence:seq<=snapshotSequence;
        if(covered) clearDeferredCommand(id);
        else if(stream==='event') futureEvents.push({command:item.command,remote:item.remote});
        else futureSimulation.push({command:item.command,remote:item.remote});
    }
    for(const item of [...futureSimulation,...futureEvents]){
        clearDeferredCommand(item.command.commandId);
        deferCommand(item.command,item.remote,'POST_RESYNC_REPLAY',`replay after repaired prefix sim=${snapshotSequence} event=${snapshotEventSequence}`,{reentry:true});
    }
    resyncCounter++;
}

function previousDispositionSupportsDependencyReject(command){
    if(commandStream(command)!=='simulation') return false;
    const prior=finalizedRecord(command.playerId,command.sequence-1);
    return prior&&[FINAL_DISPOSITION.REJECTED,FINAL_DISPOSITION.INVALIDATED].includes(prior.disposition);
}
