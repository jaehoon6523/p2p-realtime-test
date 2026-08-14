'use strict';

function initializePlayer(playerId,x,y,color=colorFor(playerId),options={}){
    const tick = Number.isSafeInteger(options.tick) ? options.tick : currentTick();
    const state = {
        x:round6(x), y:round6(y), color,
        sequence:Number.isSafeInteger(options.sequence)?options.sequence:0,
        tick,
        hp:Number.isSafeInteger(options.hp)?Math.max(0,Math.min(MAX_HP,options.hp)):MAX_HP,
        alive:options.alive!==false,
        lifeId:Number.isSafeInteger(options.lifeId)?options.lifeId:1,
        deadObservedAt:options.alive===false?performance.now():0,
        deadServerAt:Number.isFinite(options.deadServerAt)?options.deadServerAt:0,
        tentative:false
    };
    confirmedWorld[playerId]={...state};
    visibleWorld[playerId]={...state};
    confirmedSeq.set(playerId,state.sequence);
    confirmedEventSeq.set(playerId,Number.isSafeInteger(options.eventSequence)?options.eventSequence:0);
    rememberSimulationState(playerId,state);
    const now=performance.now();
    tickAnchors.set(playerId,{remoteTick:tick,localTime:now});
    activityAnchors.set(playerId,{lastMoveAt:now,lastDamageAt:now,lastHealAt:now});
}

function currentMembershipIds(){
    // Compatibility name: this is the currently open sparse direct set, never full room membership.
    return [myId,...directOpenPeerIds()].sort();
}
function storeServerPolicy(policy,{self=false}={}){
    if(!policy||typeof policy.peerId!=='string'||typeof policy.assignmentId!=='string') return;
    const now=performance.now();
    const previous=currentPolicyByPeer.get(policy.peerId);
    if(previous&&previous.assignmentId!==policy.assignmentId){ previous.expiresAt=now+POLICY_GRACE_MS; policyByAssignment.set(previous.assignmentId,previous); }
    const copy={...policy,expiresAt:now+POLICY_GRACE_MS};
    policyByAssignment.set(copy.assignmentId,copy);
    currentPolicyByPeer.set(copy.peerId,copy);
    if(self||copy.peerId===myId) selfTopologyPolicy=copy;
}
function pruneServerPolicies(){
    const now=performance.now();
    for(const [assignmentId,policy] of policyByAssignment){
        if(policy.expiresAt<=now&&currentPolicyByPeer.get(policy.peerId)?.assignmentId!==assignmentId) policyByAssignment.delete(assignmentId);
    }
}
function applyPolicyView(message){
    if(message?.selfPolicy) storeServerPolicy(message.selfPolicy,{self:true});
    for(const policy of Array.isArray(message?.peerPolicies)?message.peerPolicies:[]) storeServerPolicy(policy);
    pruneServerPolicies();
}
function policyForCommand(command){
    const policy=policyByAssignment.get(command?.assignmentId);
    return policy&&policy.peerId===command.playerId?policy:null;
}
function membershipDescriptor(){
    const p=selfTopologyPolicy;
    return {
        membershipEpoch:serverMembershipEpoch||'unassigned', // informational only
        membershipRoot:serverMembershipRoot||'unassigned',  // informational only
        topologyEpoch:p?.topologyEpoch??0,
        assignmentId:p?.assignmentId||'unassigned',
        validatorIds:[...(p?.validatorIds||[])],
        quorum:p?.quorum||0
    };
}
function validatorsFor(command){ return [...(policyForCommand(command)?.validatorIds||[])]; }
function quorumFor(command){ return policyForCommand(command)?.quorum||0; }
function commandPolicyMatches(command){
    const p=policyForCommand(command);
    return Boolean(p)&&p.topologyEpoch===command.topologyEpoch&&p.rulesetRevision===RULESET_REVISION;
}
function refreshMembership(reason=''){
    membershipRevision++;
    const direct=directOpenPeerIds().length;
    document.getElementById('membershipVersion').textContent=`${serverPeerCount} room / ${direct} direct`;
    document.getElementById('epochStat').textContent=serverMembershipEpoch||'-';
    const signature=`${serverPeerCount}|${direct}|${serverMembershipEpoch||'-'}|${serverMembershipRoot||'-'}`;
    if(reason && (reason!=='membership summary'||signature!==lastMembershipLogSignature)){
        log('t-sys',`membership room=${serverPeerCount} direct=${direct} epoch=${serverMembershipEpoch||'-'} root=${serverMembershipRoot||'-'} reason=${reason}`);
    }
    lastMembershipLogSignature=signature;
}
function distanceBetweenStates(a,b){ return a&&b?Math.hypot(a.x-b.x,a.y-b.y):Infinity; }
function isInLocalAoi(playerId){ if(playerId===myId) return true; return distanceBetweenStates(visibleWorld[myId],visibleWorld[playerId])<=AOI_RADIUS; }
function localAoiPeerIds(){ return currentMembershipIds().filter(id=>id!==myId&&isInLocalAoi(id)); }
function peerTransport(playerId){ return currentPolicyByPeer.get(playerId)?.transport || peers.get(playerId)?.transport || 'webrtc'; }
function isPeerOpen(playerId){ const peer=peers.get(playerId); return Boolean(peer) && (peer.transport==='ws-bot' ? peer.state==='open' : peer.dc?.readyState==='open'); }
function directOpenPeerIds(){ return [...peers].filter(([id])=>isPeerOpen(id)).map(([id])=>id); }
function relayRecordKey(entry){ return `${entry.ownerId}:${entry.sequence}:${entry.stateHash}`; }
function buildRelayEntry(ownerId){
    const state=confirmedWorld[ownerId];
    if(!state||ownerId===myId) return null;
    return {
        ownerId,
        sourcePeerId:myId,
        relayDepth:1,
        sequence:state.sequence,
        tick:state.tick,
        x:round6(state.x),
        y:round6(state.y),
        alive:Boolean(state.alive),
        lifeId:state.lifeId,
        stateHash:stateHash(state)
    };
}
function sendNeighborDigest(remoteId){
    if(!isPeerOpen(remoteId)) return;
    const recipient=confirmedWorld[remoteId]||visibleWorld[remoteId];
    const candidates=[];
    for(const ownerId of directOpenPeerIds()){
        if(ownerId===remoteId) continue;
        const entry=buildRelayEntry(ownerId); if(!entry) continue;
        const state=confirmedWorld[ownerId];
        const distance=recipient?distanceBetweenStates(recipient,state):Infinity;
        if(distance<=RELAY_PREFETCH_RADIUS||isInLocalAoi(ownerId)) candidates.push({entry,distance});
    }
    candidates.sort((a,b)=>a.distance-b.distance||a.entry.ownerId.localeCompare(b.entry.ownerId));
    const entries=candidates.slice(0,RELAY_MAX_ENTRIES).map(item=>item.entry);
    safeDataSend(remoteId,{kind:'neighborDigest',digest:{protocol:PROTOCOL,senderId:myId,relayDepth:1,ttlMs:RELAY_TTL_MS,entries}});
}
function broadcastNeighborDigests(){ for(const id of desiredTopologyPeers) if(isPeerOpen(id)) sendNeighborDigest(id); }
function validRelayEntry(remoteId,entry){
    return entry&&entry.sourcePeerId===remoteId&&entry.relayDepth===1&&typeof entry.ownerId==='string'&&entry.ownerId!==myId&&entry.ownerId!==remoteId&&
        Number.isSafeInteger(entry.sequence)&&entry.sequence>=0&&Number.isSafeInteger(entry.tick)&&entry.tick>=0&&
        Number.isFinite(entry.x)&&Number.isFinite(entry.y)&&Number.isSafeInteger(entry.lifeId)&&entry.lifeId>=1&&
        typeof entry.alive==='boolean'&&typeof entry.stateHash==='string'&&entry.stateHash.length<=32;
}
function receiveNeighborDigest(remoteId,digest){
    if(!desiredTopologyPeers.has(remoteId)){ relayDroppedCounter++; return; }
    if(!digest||digest.protocol!==PROTOCOL||digest.senderId!==remoteId||digest.relayDepth!==1||!Array.isArray(digest.entries)||digest.entries.length>RELAY_MAX_ENTRIES){
        invalidCounter++; log('t-warn',`invalid 1.5-hop digest from=${remoteId}`); return;
    }
    const now=performance.now();
    const ttl=Math.max(300,Math.min(RELAY_TTL_MS,Number(digest.ttlMs)||RELAY_TTL_MS));
    for(const entry of digest.entries){
        if(!validRelayEntry(remoteId,entry)){ relayDroppedCounter++; continue; }
        // 직접 연결/직접 상태가 있으면 간접 정보는 저장하지 않는다.
        if(isPeerOpen(entry.ownerId)||confirmedWorld[entry.ownerId]){ relayDroppedCounter++; continue; }
        const key=relayRecordKey(entry);
        const seenUntil=seenRelayRecords.get(key)||0;
        if(seenUntil>now){ relayDroppedCounter++; continue; }
        seenRelayRecords.set(key,now+ttl);
        const existing=relayWorld.get(entry.ownerId);
        if(existing&&(entry.sequence<existing.sequence||(entry.sequence===existing.sequence&&entry.stateHash===existing.stateHash))){ relayDroppedCounter++; continue; }
        relayWorld.set(entry.ownerId,{...entry,receivedAt:now,expiresAt:now+ttl});
        relayAcceptedCounter++;
    }
}
function pruneRelayWorld(){
    const now=performance.now();
    for(const [key,until] of seenRelayRecords) if(until<=now) seenRelayRecords.delete(key);
    for(const [ownerId,entry] of relayWorld){
        if(entry.expiresAt<=now||isPeerOpen(ownerId)||confirmedWorld[ownerId]) relayWorld.delete(ownerId);
    }
}
