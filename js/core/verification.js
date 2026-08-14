'use strict';

// HotStuff-inspired narrow borrowing: a certificate is bound to one exact evidence hash.
// Finality remains per command stream; this is not global consensus.
// Receipt delivery is durable across transient signaling disconnects. The server still decides
// whether this peer is an assigned validator for command.assignmentId.
const pendingVerificationReceipts=new Map();
const lastVerificationReceiptSignature=new Map();
const lastAuditEvaluationSignature=new Map();
const auditTemporalRetryTimers=new Map();
const AUDIT_RECEIPT_RETRY_MS=400;
const AUDIT_RECEIPT_RETRY_TTL_MS=10000;
function verificationReceiptKey(receipt){ return `${receipt.commandId}:${receipt.assignmentId}`; }
function verificationReceiptSignature(receipt){
    return `${receipt.decision}|${receipt.resultCode||''}|${receipt.evidenceHash||''}|${receipt.computedHash||''}`;
}
function clearAbilityAuditWaiter(commandId){
    const ref=abilityAuditWaiterByCommand.get(commandId);
    if(!ref) return;
    abilityAuditWaiterByCommand.delete(commandId);
    const bySeq=abilityAuditWaiters.get(ref.playerId);
    const set=bySeq?.get(ref.requiredSeq);
    if(set){ set.delete(commandId); if(!set.size) bySeq.delete(ref.requiredSeq); }
    if(bySeq&&!bySeq.size) abilityAuditWaiters.delete(ref.playerId);
}
function clearAuditTemporalRetry(commandId){
    const timer=auditTemporalRetryTimers.get(commandId);
    if(timer){ clearTimeout(timer); auditTemporalRetryTimers.delete(commandId); }
}
function clearVerificationTracking(command){
    if(!command?.commandId) return;
    clearAbilityAuditWaiter(command.commandId);
    clearAuditTemporalRetry(command.commandId);
    auditWakeQueued.delete(command.commandId);
    lastAuditEvaluationSignature.delete(command.commandId);
    const key=verificationReceiptKey({commandId:command.commandId,assignmentId:command.assignmentId});
    pendingVerificationReceipts.delete(key);
    lastVerificationReceiptSignature.delete(key);
}
function trySendVerificationReceipt(key){
    const item=pendingVerificationReceipts.get(key);
    if(!item||!item.ready) return false;
    if(performance.now()-item.queuedAt>AUDIT_RECEIPT_RETRY_TTL_MS){
        pendingVerificationReceipts.delete(key);
        log('t-warn',`AUDIT_RECEIPT_EXPIRED id=${item.receipt.commandId}`);
        return false;
    }
    const sent=sendSignal({type:'verification-receipt',receipt:item.receipt});
    if(sent){
        pendingVerificationReceipts.delete(key);
        lastVerificationReceiptSignature.set(key,item.signature);
        log('t-audit',`AUDIT_RECEIPT_TX id=${item.receipt.commandId} decision=${item.receipt.decision} code=${item.receipt.resultCode} evidence=${item.receipt.evidenceHash} computed=${item.receipt.computedHash}`);
        return true;
    }
    if(AUTO_DEBUG&&!item.sendFailureLogged){
        item.sendFailureLogged=true;
        log('t-warn',`AUDIT_RECEIPT_WAIT_SIGNAL id=${item.receipt.commandId}`);
    }
    return false;
}
function queueVerificationReceipt(receipt){
    const key=verificationReceiptKey(receipt),signature=verificationReceiptSignature(receipt);
    const existing=pendingVerificationReceipts.get(key);
    if(existing?.signature===signature||lastVerificationReceiptSignature.get(key)===signature) return false;
    const item={receipt,signature,queuedAt:existing?.queuedAt||performance.now(),ready:false,sendFailureLogged:false};
    pendingVerificationReceipts.set(key,item);
    scheduleNetem('tx','SERVER-AUDIT','verification-receipt',()=>{
        const live=pendingVerificationReceipts.get(key);
        if(!live||live.signature!==signature) return;
        live.ready=true;
        trySendVerificationReceipt(key);
    });
    return true;
}
function flushPendingVerificationReceipts(){
    for(const key of [...pendingVerificationReceipts.keys()]) trySendVerificationReceipt(key);
}
setInterval(flushPendingVerificationReceipts,AUDIT_RECEIPT_RETRY_MS);

function scheduleAuditWake(commandId){
    if(!commandId||auditWakeQueued.has(commandId)) return false;
    auditWakeQueued.add(commandId);
    const wake=()=>{
        auditWakeQueued.delete(commandId);
        const live=pendingById.get(commandId);
        if(live&&!live.verdict) runAudit(live.command);
    };
    if(typeof queueMicrotask==='function') queueMicrotask(wake); else setTimeout(wake,0);
    return true;
}
function registerAbilityAuditWaiter(command,result){
    const known=confirmedAbilitySeq.get(command.playerId)||0;
    const requiredSeq=result.code==='ABILITY_LINEAGE_PENDING'
        ? Math.max(1,(Number.isSafeInteger(result.computed?.known)?result.computed.known:known)+1)
        : result.code==='ABILITY_PREVIOUS_PENDING'
            ? Math.max(1,command.abilitySeq-1)
            : null;
    if(!requiredSeq) return false;
    clearAbilityAuditWaiter(command.commandId);
    let bySeq=abilityAuditWaiters.get(command.playerId);
    if(!bySeq){ bySeq=new Map(); abilityAuditWaiters.set(command.playerId,bySeq); }
    let set=bySeq.get(requiredSeq);
    if(!set){ set=new Set(); bySeq.set(requiredSeq,set); }
    set.add(command.commandId);
    abilityAuditWaiterByCommand.set(command.commandId,{playerId:command.playerId,requiredSeq});
    if(AUTO_DEBUG) log('t-audit',`AUDIT_WAIT id=${command.commandId} dependency=ability:${command.playerId}:a${requiredSeq}`);
    return true;
}
function wakeAbilityAuditDependencies(playerId){
    const bySeq=abilityAuditWaiters.get(playerId);
    if(!bySeq) return 0;
    const confirmed=confirmedAbilitySeq.get(playerId)||0;
    const ready=[];
    for(const [requiredSeq,set] of bySeq){
        if(requiredSeq>confirmed) continue;
        for(const commandId of set) ready.push(commandId);
    }
    for(const commandId of ready){ clearAbilityAuditWaiter(commandId); scheduleAuditWake(commandId); }
    return ready.length;
}
function scheduleAuditTemporalRetry(command,retryMs){
    clearAuditTemporalRetry(command.commandId);
    const delay=Math.max(TEMPORAL_RETRY_MIN_MS,Math.min(TEMPORAL_DEFER_MAX_MS,retryMs));
    const timer=setTimeout(()=>{
        auditTemporalRetryTimers.delete(command.commandId);
        const live=pendingById.get(command.commandId);
        if(live&&!live.verdict&&(live.remote||validatorsFor(command).includes(myId))) runAudit(command);
    },delay);
    auditTemporalRetryTimers.set(command.commandId,timer);
}

function runAudit(command){
    const pending=pendingById.get(command.commandId);
    if(!pending) return null;
    // The server owns assignment membership. A validator must be able to replay the command
    // even if its local peer-policy cache is stale or missing.
    const result=evaluateCommand(command,pending,{skipPolicyCheck:true});
    const evidenceHash=commandFingerprint(command);
    const decision=result.disposition===RULE_DISPOSITION.ACCEPT
        ? 'accept'
        : result.disposition===RULE_DISPOSITION.REJECT||result.disposition===RULE_DISPOSITION.FAULT
            ? 'reject'
            : 'abstain';
    const computedHash=stableHash(result.computed||null);
    const receipt={
        protocol:PROTOCOL,
        rulesetRevision:RULESET_REVISION,
        commandId:command.commandId,
        playerId:command.playerId,
        stream:commandStream(command),
        streamSeq:commandStreamSequence(command),
        assignmentId:command.assignmentId,
        decision,
        reason:result.reason,
        resultCode:result.code,
        computedHash,
        evidenceHash,
    };
    const evaluationSignature=`${decision}|${result.code||''}|${computedHash}|${evidenceHash}`;
    const evaluationChanged=lastAuditEvaluationSignature.get(command.commandId)!==evaluationSignature;
    lastAuditEvaluationSignature.set(command.commandId,evaluationSignature);
    queueVerificationReceipt(receipt);
    if(AUTO_DEBUG&&evaluationChanged) log('t-audit',`AUDIT_EVAL id=${command.commandId} actor=${command.playerId} decision=${decision} code=${result.code}`);

    clearAuditTemporalRetry(command.commandId);
    if(result.disposition===RULE_DISPOSITION.DEFER){
        if(registerAbilityAuditWaiter(command,result)) return result;
        clearAbilityAuditWaiter(command.commandId);
        // Only genuinely time-dependent uncertainty keeps a timer. Data/lineage dependencies wake on state change.
        if(Number.isFinite(result.retryMs)) scheduleAuditTemporalRetry(command,result.retryMs);
    }else{
        clearAbilityAuditWaiter(command.commandId);
        if(result.disposition===RULE_DISPOSITION.RESYNC){
            requestPeerResync(command.playerId,`audit:${result.code}`);
        }else if(result.disposition===RULE_DISPOSITION.FAULT){
            reportProtocolFault(command,result.code,result.reason,{remote:command.playerId!==myId});
        }
    }
    return result;
}

function applyVerificationProgress(progress){
    if(!progress||progress.signalProtocol!==SIGNAL_PROTOCOL||typeof progress.commandId!=='string') return;
    const pending=pendingById.get(progress.commandId);
    if(!pending||pending.command.playerId!==myId) return;
    const received=Number.isSafeInteger(progress.received)?progress.received:0;
    const quorum=Number.isSafeInteger(progress.quorum)?progress.quorum:0;
    log('t-audit',`AUDIT_PROGRESS id=${progress.commandId} validator=${progress.validatorId||'-'} decision=${progress.decision||'-'} code=${progress.resultCode||'-'} votes=${received}/${quorum} evidence=${progress.evidenceHash||'-'} computed=${progress.computedHash||'-'}`);
}

function applyVerificationCertificate(certificate){
    if(!certificate||certificate.signalProtocol!==SIGNAL_PROTOCOL||certificate.playerId==null||certificate.assignmentId==null) return;
    if(!['accepted','rejected'].includes(certificate.verdict)){
        invalidCounter++;
        log('t-err',`invalid certificate verdict id=${certificate.commandId||'-'} verdict=${certificate.verdict}`);
        return;
    }
    const pending=pendingById.get(certificate.commandId);
    if(!pending){
        orphanCertificates.set(certificate.commandId,certificate);
        setTimeout(()=>orphanCertificates.delete(certificate.commandId),10000);
        return;
    }
    const command=pending.command;
    if(pending.verdict==='rejected'&&pending.rejectCode==='DEPENDENCY_INVALIDATED'){
        ignoredCounter++;
        if(AUTO_DEBUG) log('t-sys',`IGNORE late certificate for invalidated dependency ${commandSequenceText(command)} id=${command.commandId}`);
        return;
    }
    if(certificate.playerId!==command.playerId||certificate.stream!==commandStream(command)||certificate.streamSeq!==commandStreamSequence(command)||certificate.assignmentId!==command.assignmentId){
        reportProtocolFault(command,'CERTIFICATE_BINDING_MISMATCH',`certificate identity/stream/sequence/assignment mismatch id=${certificate.commandId}`,{remote:false});
        return;
    }
    const expectedEvidenceHash=commandFingerprint(command);
    if(typeof certificate.evidenceHash!=='string'||certificate.evidenceHash!==expectedEvidenceHash){
        reportProtocolFault(command,'CERTIFICATE_EVIDENCE_MISMATCH',`expected=${expectedEvidenceHash} got=${certificate.evidenceHash||'-'}`,{remote:false});
        return;
    }

    pending.verdict=certificate.verdict;
    pending.certificateServerTime=Number.isFinite(certificate.serverTime)?certificate.serverTime:null;
    pending.rejectCode=pending.verdict==='accepted'?null:(certificate.resultCode||'QUORUM_REJECTED');
    pending.rejectReason=pending.verdict==='accepted'?null:'server quorum certificate rejected';
    pending.advanceTick=commandStream(command)==='simulation';
    clearTimeout(pending.timeoutId);
    log(pending.verdict==='accepted'?'t-audit':'t-warn',`CERTIFICATE ${pending.verdict.toUpperCase()} ${commandSequenceText(command)} id=${command.commandId} evidence=${certificate.evidenceHash||'-'}`);
    if(commandStream(command)==='event') drainEventCommits(command.playerId); else drainCommits(command.playerId);
}
