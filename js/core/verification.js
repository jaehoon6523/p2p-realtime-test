'use strict';

// HotStuff-inspired narrow borrowing: a certificate is bound to one exact evidence hash.
// Finality remains per command stream; this is not global consensus.
// Receipt delivery is durable across transient signaling disconnects. The server still decides
// whether this peer is an assigned validator for command.assignmentId.
const pendingVerificationReceipts=new Map();
const AUDIT_RECEIPT_RETRY_MS=400;
const AUDIT_RECEIPT_RETRY_TTL_MS=10000;
function verificationReceiptKey(receipt){ return `${receipt.commandId}:${receipt.assignmentId}`; }
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
    const key=verificationReceiptKey(receipt);
    const existing=pendingVerificationReceipts.get(key);
    const item={receipt,queuedAt:existing?.queuedAt||performance.now(),ready:false,sendFailureLogged:false};
    pendingVerificationReceipts.set(key,item);
    scheduleNetem('tx','SERVER-AUDIT','verification-receipt',()=>{
        const live=pendingVerificationReceipts.get(key);
        if(!live) return;
        live.ready=true;
        trySendVerificationReceipt(key);
    });
}
function flushPendingVerificationReceipts(){
    for(const key of [...pendingVerificationReceipts.keys()]) trySendVerificationReceipt(key);
}
setInterval(flushPendingVerificationReceipts,AUDIT_RECEIPT_RETRY_MS);

function runAudit(command){
    const pending=pendingById.get(command.commandId);
    if(!pending) return;
    // The server owns assignment membership. A validator must be able to replay the command
    // even if its local peer-policy cache is stale or missing.
    const result=evaluateCommand(command,pending,{skipPolicyCheck:true});
    const evidenceHash=commandFingerprint(command);
    const decision=result.disposition===RULE_DISPOSITION.ACCEPT
        ? 'accept'
        : result.disposition===RULE_DISPOSITION.REJECT||result.disposition===RULE_DISPOSITION.FAULT
            ? 'reject'
            : 'abstain';
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
        computedHash:stableHash(result.computed||null),
        evidenceHash,
    };
    queueVerificationReceipt(receipt);
    if(AUTO_DEBUG) log('t-audit',`AUDIT_EVAL id=${command.commandId} actor=${command.playerId} decision=${decision} code=${result.code}`);

    if(result.disposition===RULE_DISPOSITION.DEFER&&Number.isFinite(result.retryMs)){
        setTimeout(()=>{
            const live=pendingById.get(command.commandId);
            // Remote audit retry must not fall back to the same stale client-side policy cache
            // that the initial server-bound audit deliberately bypassed.
            if(live&&!live.verdict&&(live.remote||validatorsFor(command).includes(myId))) runAudit(command);
        },Math.max(TEMPORAL_RETRY_MIN_MS,result.retryMs));
    }else if(result.disposition===RULE_DISPOSITION.RESYNC){
        requestPeerResync(command.playerId,`audit:${result.code}`);
    }else if(result.disposition===RULE_DISPOSITION.FAULT){
        reportProtocolFault(command,result.code,result.reason,{remote:command.playerId!==myId});
    }
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
