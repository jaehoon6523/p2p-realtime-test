'use strict';

// HotStuff-inspired narrow borrowing: a certificate must be bound to one exact evidence/proposal hash.
// This is NOT global consensus; the signaling server only aggregates the assigned validator receipts.
function runAudit(command){
    const pending=pendingById.get(command.commandId);
    if(!pending) return;
    const result=evaluateCommand(command,pending);
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
        sequence:command.sequence,
        assignmentId:command.assignmentId,
        decision,
        reason:result.reason,
        resultCode:result.code,
        computedHash:stableHash(result.computed||null),
        evidenceHash,
    };
    scheduleNetem('tx','SERVER-AUDIT','verification-receipt',()=>{
        if(!sendSignal({type:'verification-receipt',receipt})) log('t-warn',`verification receipt signaling failed id=${command.commandId}`);
    });

    // Timing uncertainty is not a negative vote. Retry after the uncertainty window instead.
    if(result.disposition===RULE_DISPOSITION.DEFER&&Number.isFinite(result.retryMs)){
        setTimeout(()=>{
            const live=pendingById.get(command.commandId);
            if(live&&!live.verdict&&validatorsFor(command).includes(myId)) runAudit(command);
        },Math.max(TEMPORAL_RETRY_MIN_MS,result.retryMs));
    }else if(result.disposition===RULE_DISPOSITION.RESYNC){
        requestPeerResync(command.playerId,`audit:${result.code}`);
    }else if(result.disposition===RULE_DISPOSITION.FAULT){
        reportProtocolFault(command,result.code,result.reason,{remote:command.playerId!==myId});
    }
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
    if(certificate.playerId!==command.playerId||certificate.sequence!==command.sequence||certificate.assignmentId!==command.assignmentId){
        reportProtocolFault(command,'CERTIFICATE_BINDING_MISMATCH',`certificate identity/sequence/assignment mismatch id=${certificate.commandId}`,{remote:false});
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
    pending.advanceTick=true;
    clearTimeout(pending.timeoutId);
    log(pending.verdict==='accepted'?'t-audit':'t-warn',`CERTIFICATE ${pending.verdict.toUpperCase()} seq=${command.sequence} id=${command.commandId} evidence=${certificate.evidenceHash||'-'}`);
    drainCommits(command.playerId);
}
