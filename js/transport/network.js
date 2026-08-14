'use strict';

const SERVER_ONLY_SIGNAL_TYPES = new Set(['joined','join-error','topology-update','membership-summary','verification-certificate','relay-error']);

function byteLength(text){ return new TextEncoder().encode(text).byteLength; }
function noteTraffic(direction,kind,bytes){
    const prefix=direction==='tx'?'tx':'rx'; networkMetrics[`${prefix}Bytes`]+=bytes; networkMetrics[`${prefix}Messages`]++; networkMetrics[`${prefix}BytesWindow`]+=bytes; networkMetrics[`${prefix}MessagesWindow`]++;
    const key=`${direction}:${kind||'unknown'}`; networkMetrics.byKind[key]=(networkMetrics.byKind[key]||0)+bytes;
}
function sendWireNow(remoteId,message){
    const peer=peers.get(remoteId); if(!peer||!isPeerOpen(remoteId)) return false;
    try{
        const payload=JSON.stringify(message);
        if(peer.transport==='ws-bot'){
            const sent=sendSignal({type:'wire',to:remoteId,wire:message});
            if(sent) noteTraffic('tx',message.kind,byteLength(payload));
            return sent;
        }
        peer.dc.send(payload);
        noteTraffic('tx',message.kind,byteLength(payload));
        return true;
    }
    catch(error){
        log('t-sys',`send skipped peer=${remoteId}: ${error.message}`);
        removePeer(remoteId,'send failed');
        return false;
    }
}
function safeDataSend(remoteId,message){
    if(!peers.get(remoteId)||!isPeerOpen(remoteId)) return false;
    return scheduleNetem('tx',remoteId,message?.kind||'wire',()=>sendWireNow(remoteId,message));
}
function deliverWireMessage(remoteId,raw){
    return scheduleNetem('rx',remoteId,'wire',()=>{
        if(pageUnloading||!peers.get(remoteId)||!isPeerOpen(remoteId)) return;
        handleWireMessage(remoteId,raw);
    });
}
function receiveBotTelegraph(remoteId,telegraph){
    if(!telegraph||telegraph.protocol!==PROTOCOL||telegraph.botId!==remoteId) return;
    if(!Number.isFinite(telegraph.targetX)||!Number.isFinite(telegraph.targetY)||!Number.isFinite(telegraph.leadMs)) return;
    const leadMs=Math.max(150,Math.min(2500,telegraph.leadMs));
    botTelegraphs.set(remoteId,{...telegraph,receivedAt:performance.now(),fireAt:performance.now()+leadMs,expiresAt:performance.now()+leadMs+260});
}
function handleWireMessage(remoteId,raw){
    let message; try{ if(typeof raw!=='string'||raw.length>128*1024) throw new Error('message too large'); message=JSON.parse(raw); noteTraffic('rx',message.kind,byteLength(raw)); }catch(error){ invalidCounter++; log('t-err',`invalid JSON from=${remoteId}: ${error.message}`); return; }
    if(message.kind==='command') receiveCommand(remoteId,message.command);
    else if(message.kind==='snapshot') receiveSnapshot(remoteId,message.snapshot);
    else if(message.kind==='historyRepair') receiveHistoryRepair(remoteId,message.repair);
    else if(message.kind==='neighborDigest') receiveNeighborDigest(remoteId,message.digest);
    else if(message.kind==='botTelegraph') receiveBotTelegraph(remoteId,message.telegraph);
    else if(message.kind==='resyncRequest') receiveResyncRequest(remoteId,message.request);
    else if(message.kind==='rebaseRequired') receiveRebaseRequired(remoteId,message.request);
    else invalidCounter++;
}

function setRoomGate(state,title,detail=''){
    roomGate.dataset.state=state;
    roomGateTitle.textContent=title;
    roomGateDetail.textContent=detail;
    roomGate.classList.toggle('hidden',state==='ready');
    roomGate.setAttribute('aria-busy',state==='ready'?'false':'true');
}
function markRoomUnavailable(title,detail){ roomReady=false; setRoomGate('error',title,detail); }
function updateSignalStatus(state,label=state){ const el=document.getElementById('signalState'); el.dataset.state=state; el.textContent=label; }
function signalLog(className,message,detail=null){ const line=`[SIGNAL] ${message}`; log(className,line); const method=className==='t-err'?'error':className==='t-sig'?'info':'debug'; detail==null?console[method](line):console[method](line,detail); }
function startSignaling(){
    if(!SIGNAL_URL){ updateSignalStatus('error','missing signal URL'); markRoomUnavailable('방 확인 실패','signal 쿼리 파라미터가 없습니다.'); signalLog('t-err','signal query parameter is required'); return; }
    signalManualClose=false; connectSignaling();
}
function connectSignaling(){
    if(signalManualClose||!SIGNAL_URL) return;
    if(signalingSocket&&[WebSocket.CONNECTING,WebSocket.OPEN].includes(signalingSocket.readyState)) return;
    clearTimeout(signalReconnectTimer); clearTimeout(signalConnectTimeout); clearTimeout(roomJoinTimeout); roomReady=false; const generation=++signalingGeneration;
    setRoomGate('checking','방 확인 중',`시그널 서버 연결 중 · ${ROOM_ID}`);
    updateSignalStatus('connecting','connecting'); signalLog('t-sig',`connecting url=${SIGNAL_URL} room=${ROOM_ID} attempt=${signalReconnectAttempt+1}`);
    let socket; try{ socket=new WebSocket(SIGNAL_URL); }catch(error){ signalLog('t-err',`constructor failed: ${error.message}`); scheduleReconnect('constructor failure'); return; }
    signalingSocket=socket;
    signalConnectTimeout=setTimeout(()=>{ if(generation===signalingGeneration&&socket.readyState===WebSocket.CONNECTING) try{socket.close(4000,'connect timeout');}catch(_){} },SIGNAL_CONNECT_TIMEOUT_MS);
    socket.onopen=()=>{
        if(generation!==signalingGeneration) return; clearTimeout(signalConnectTimeout); signalReconnectAttempt=0; updateSignalStatus('joining','checking room'); signalLog('t-sig',`open url=${SIGNAL_URL}`);
        setRoomGate('checking','방 확인 중',`방 ${ROOM_ID} 참가 확인을 기다리는 중입니다.`);
        socket.send(JSON.stringify({type:'join',channelId:ROOM_ID,peerId:myId,signalProtocol:SIGNAL_PROTOCOL,rulesetRevision:RULESET_REVISION,aoiRadius:AOI_RADIUS})); signalLog('t-sig',`join sent room=${ROOM_ID} peer=${myId}`);
        roomJoinTimeout=setTimeout(()=>{
            if(generation!==signalingGeneration||roomReady) return;
            markRoomUnavailable('방 확인 시간 초과','서버가 join 확인 응답(joined)을 보내지 않았습니다. signaling protocol v5 transport-policy 서버가 필요합니다.');
            updateSignalStatus('error','join timeout');
            signalLog('t-err',`room join timeout: missing joined ACK room=${ROOM_ID}`);
            try{ socket.close(4408,'join acknowledgement timeout'); }catch(_){}
        },ROOM_JOIN_TIMEOUT_MS);
    };
    socket.onmessage=event=>{ if(generation!==signalingGeneration||typeof event.data!=='string') return; try{ handleSignalMessage(JSON.parse(event.data)); }catch(error){ signalLog('t-err',`invalid signaling JSON: ${error.message}`); } };
    socket.onerror=event=>{ if(generation!==signalingGeneration) return; roomReady=false; updateSignalStatus('error','error'); setRoomGate('checking','연결 재시도 중','시그널 서버 연결 오류가 발생했습니다.'); signalLog('t-err','WebSocket error',event); };
    socket.onclose=event=>{ if(generation!==signalingGeneration) return; clearTimeout(signalConnectTimeout); clearTimeout(roomJoinTimeout); clearInterval(signalKeepaliveTimer); roomReady=false; signalingSocket=null; setRoomGate('checking','방 연결 복구 중',`연결 종료 코드 ${event.code} · 재접속을 준비합니다.`); updateSignalStatus('closed',`closed ${event.code}`); signalLog(signalManualClose?'t-sys':'t-err',`closed code=${event.code} reason=${event.reason||'none'}`); scheduleReconnect(`close ${event.code}`); };
}
function sendSignal(message){
    if(signalingSocket?.readyState!==WebSocket.OPEN||!roomReady) return false;
    try{ signalingSocket.send(JSON.stringify({...message,from:myId,signalProtocol:SIGNAL_PROTOCOL,signalTick:currentTick()})); return true; }catch(error){ signalLog('t-err',`send failed type=${message.type}: ${error.message}`); return false; }
}
function scheduleReconnect(reason){
    if(signalManualClose) return; clearTimeout(signalReconnectTimer); const base=Math.min(SIGNAL_RECONNECT_MAX_MS,SIGNAL_RECONNECT_BASE_MS*(2**Math.min(signalReconnectAttempt,6))); const delay=Math.round(base*(.85+Math.random()*.3)); signalReconnectAttempt++; updateSignalStatus('reconnecting',`retry ${Math.ceil(delay/1000)}s`); signalLog('t-sig',`reconnect in ${delay}ms reason=${reason}`); signalReconnectTimer=setTimeout(connectSignaling,delay);
}
async function handleSignalMessage(message){
    if(!message) return;
    if(message.from && SERVER_ONLY_SIGNAL_TYPES.has(message.type)){
        invalidCounter++; signalLog('t-err',`rejected peer-forged server control type=${message.type} from=${message.from}`); return;
    }
    if(message.type==='joined'){
        if(message.signalProtocol!==SIGNAL_PROTOCOL||message.channelId!==ROOM_ID||message.peerId!==myId||message.rulesetRevision!==RULESET_REVISION){ markRoomUnavailable('방 확인 응답 불일치','서버가 다른 방/프로토콜/ruleset 응답을 보냈습니다.'); return; }
        clearTimeout(roomJoinTimeout); roomReady=true; updateSignalStatus('open','joined');
        serverMembershipEpoch=typeof message.membershipEpoch==='string'?message.membershipEpoch:null;
        serverPeerCount=Number.isFinite(message.peerCount)?message.peerCount:0;
        serverMembershipRoot=typeof message.membershipRoot==='string'?message.membershipRoot:null;
        applyPolicyView(message);
        await applyTopologyAssignment(message.selfPolicy||{},'joined');
        const roomResult=message.roomExisted?'기존 방 확인됨':'새 방 생성됨';
        setRoomGate('ready',roomResult,`현재 참가자 ${serverPeerCount}명 · topology ${selfTopologyPolicy?.topologyEpoch??'-'}`);
        signalLog('t-sig',`joined room=${ROOM_ID} peers=${serverPeerCount} assignment=${selfTopologyPolicy?.assignmentId||'n/a'}`);
        clearInterval(signalKeepaliveTimer); signalKeepaliveTimer=setInterval(()=>sendSignal({type:'keepalive'}),SIGNAL_KEEPALIVE_MS);
        sendPresence();
        return;
    }
    if(message.type==='join-error'){
        clearTimeout(roomJoinTimeout); markRoomUnavailable('방 확인 실패',message.reason||'서버가 참가를 거절했습니다.'); updateSignalStatus('error','join rejected'); signalLog('t-err',`join rejected: ${message.reason||'unknown'}`); return;
    }
    if(message.type==='topology-update'){
        if(message.channelId!==ROOM_ID||message.signalProtocol!==SIGNAL_PROTOCOL||message.peerId!==myId) return;
        serverMembershipEpoch=typeof message.membershipEpoch==='string'?message.membershipEpoch:serverMembershipEpoch;
        serverMembershipRoot=typeof message.membershipRoot==='string'?message.membershipRoot:serverMembershipRoot;
        serverPeerCount=Number.isFinite(message.peerCount)?message.peerCount:serverPeerCount;
        applyPolicyView(message);
        await applyTopologyAssignment(message.selfPolicy||{},message.reason||'update');
        refreshMembership('server topology update');
        signalLog('t-sig',`topology base=${desiredTopologyPeers.size} sim=${desiredSimulationPeers.size} direct=${desiredDirectPeers.size} assignment=${selfTopologyPolicy?.assignmentId||'n/a'}`);
        return;
    }
    if(message.type==='verification-certificate'){
        scheduleNetem('rx','SERVER-AUDIT','verification-certificate',()=>applyVerificationCertificate(message));
        return;
    }
    if(message.type==='wire'){
        if(!roomReady||message.from===myId||typeof message.from!=='string'||message.to!==myId||!message.wire) return;
        deliverWireMessage(message.from,JSON.stringify(message.wire)); return;
    }
    if(message.type==='membership-summary'){ if(message.channelId===ROOM_ID){ serverPeerCount=Number.isFinite(message.peerCount)?message.peerCount:serverPeerCount; serverMembershipEpoch=typeof message.membershipEpoch==='string'?message.membershipEpoch:serverMembershipEpoch; serverMembershipRoot=typeof message.membershipRoot==='string'?message.membershipRoot:serverMembershipRoot; refreshMembership('membership summary'); } return; }
    if(message.type==='relay-error'){ signalLog('t-warn',`relay rejected to=${message.to||'-'} reason=${message.reason||'unknown'}`); return; }
    if(!roomReady||message.from===myId||typeof message.from!=='string'||(message.to&&message.to!==myId)) return;
    try{
        if(message.type==='offer') await createPeer(message.from,false,message.sdp);
        else if(message.type==='answer'){ const peer=peers.get(message.from); if(peer?.pc){ await peer.pc.setRemoteDescription(message.sdp); await flushIce(peer); } }
        else if(message.type==='ice'){
            const peer=peers.get(message.from); if(peer?.pc){ if(peer.pc.remoteDescription) await peer.pc.addIceCandidate(message.candidate); else peer.pendingIce.push(message.candidate); }
            else{ const list=prePeerIce.get(message.from)||[]; list.push(message.candidate); prePeerIce.set(message.from,list); }
        }
    }catch(error){ signalLog('t-err',`handling failed type=${message.type} from=${message.from}: ${error.message}`); }
}
async function applyTopologyAssignment(policy,reason='update'){
    const topology=new Set((Array.isArray(policy?.topologyPeers)?policy.topologyPeers:[]).filter(id=>typeof id==='string'&&id!==myId));
    const simulation=new Set((Array.isArray(policy?.simulationPeers)?policy.simulationPeers:[]).filter(id=>typeof id==='string'&&id!==myId));
    const next=new Set((Array.isArray(policy?.directPeers)?policy.directPeers:[...topology,...simulation]).filter(id=>typeof id==='string'&&id!==myId).slice(0,24));
    desiredTopologyPeers.clear(); for(const id of topology) desiredTopologyPeers.add(id);
    desiredSimulationPeers.clear(); for(const id of simulation) desiredSimulationPeers.add(id);
    desiredDirectPeers.clear(); for(const id of next) desiredDirectPeers.add(id);
    for(const id of [...peers.keys()]) if(!next.has(id)) removePeer(id,`topology removed: ${reason}`);
    for(const id of next){
        const transport=peerTransport(id);
        const existing=peers.get(id);
        if(existing&&existing.transport===transport) continue;
        if(existing) removePeer(id,'transport changed');
        if(transport==='ws-bot'){
            peers.set(id,{transport:'ws-bot',pc:null,dc:null,state:'open',remoteId:id,pendingIce:[]});
            relayWorld.delete(id); sendSnapshot(id);
            continue;
        }
        if(myId<id) await createPeer(id,true);
        else peers.set(id,{transport:'webrtc',pc:null,dc:null,state:'awaiting-offer',remoteId:id,pendingIce:[...(prePeerIce.get(id)||[])]});
    }
    refreshMembership(`topology assignment ${reason}`); updatePeerList();
}
function sendPresence(){
    if(!roomReady) return;
    const me=getPredictedTail(myId)||confirmedWorld[myId];
    if(me) sendSignal({type:'presence',x:round6(me.x),y:round6(me.y),aoiRadius:AOI_RADIUS});
}
function reconnectSignaling(){
    clearTimeout(signalReconnectTimer); clearTimeout(signalConnectTimeout); clearTimeout(roomJoinTimeout); clearInterval(signalKeepaliveTimer); roomReady=false; setRoomGate('checking','방 확인 중',`방 ${ROOM_ID}에 다시 연결합니다.`); signalManualClose=false;
    const old=signalingSocket; signalingSocket=null; signalingGeneration++; try{old?.close(1000,'manual reconnect');}catch(_){} signalReconnectAttempt=0; connectSignaling();
}
window.reconnectSignaling=reconnectSignaling;

async function flushIce(peer){
    if(!peer?.pc?.remoteDescription) return; const queued=peer.pendingIce||[]; peer.pendingIce=[];
    for(const candidate of queued) try{ await peer.pc.addIceCandidate(candidate); }catch(error){ log('t-err',`ICE rejected peer=${peer.remoteId}: ${error.message}`); }
}
async function createPeer(remoteId,isOfferer,remoteSdp){
    const existing=peers.get(remoteId); if(existing?.pc&&!['closed','failed'].includes(existing.pc.connectionState)) return;
    const pc=new RTCPeerConnection(STUN); const entry={transport:'webrtc',pc,dc:null,state:'connecting',remoteId,pendingIce:[...(existing?.pendingIce||[]),...(prePeerIce.get(remoteId)||[])]}; prePeerIce.delete(remoteId); peers.set(remoteId,entry);
    pc.onicecandidate=event=>{ if(event.candidate) sendSignal({type:'ice',to:remoteId,candidate:event.candidate}); };
    pc.onconnectionstatechange=()=>{
        if(pageUnloading||tearingDownPeers.has(remoteId)||peers.get(remoteId)!==entry) return; entry.state=pc.connectionState; clearTimeout(disconnectTimers.get(remoteId)); disconnectTimers.delete(remoteId);
        if(pc.connectionState==='disconnected'){ const timer=setTimeout(()=>{ if(peers.get(remoteId)===entry&&entry.pc.connectionState==='disconnected') removePeer(remoteId,'disconnect timeout'); },DISCONNECT_GRACE_MS); disconnectTimers.set(remoteId,timer); }
        else if(['failed','closed'].includes(pc.connectionState)) removePeer(remoteId,`peer connection ${pc.connectionState}`);
        updatePeerList();
    };
    const bindChannel=dc=>{
        entry.dc=dc;
        dc.onopen=()=>{ if(pageUnloading||peers.get(remoteId)!==entry) return; log('t-sig',`DataChannel open ↔ ${remoteId}`); refreshMembership('data channel open'); relayWorld.delete(remoteId); sendSnapshot(remoteId); sendPresence(); sendNeighborDigest(remoteId); if(AUTO_MODE) setTimeout(tickAutoMode,0); updatePeerList(); };
        dc.onmessage=event=>{ if(!pageUnloading&&peers.get(remoteId)===entry) deliverWireMessage(remoteId,event.data); };
        dc.onclose=()=>{ if(!pageUnloading&&peers.get(remoteId)===entry) removePeer(remoteId,'data channel closed'); };
        dc.onerror=event=>{ if(!pageUnloading) log('t-err',`DataChannel error ↔ ${remoteId}: ${event?.message||'unknown'}`); };
    };
    if(isOfferer){ bindChannel(pc.createDataChannel('arena-v13',{ordered:true})); const offer=await pc.createOffer(); await pc.setLocalDescription(offer); sendSignal({type:'offer',to:remoteId,sdp:offer}); }
    else{ pc.ondatachannel=event=>bindChannel(event.channel); await pc.setRemoteDescription(remoteSdp); await flushIce(entry); const answer=await pc.createAnswer(); await pc.setLocalDescription(answer); sendSignal({type:'answer',to:remoteId,sdp:answer}); }
    updatePeerList();
}
function removePeer(remoteId,reason='unknown'){
    if(!remoteId||remoteId===myId||tearingDownPeers.has(remoteId)) return false; const peer=peers.get(remoteId); if(!peer) return false; tearingDownPeers.add(remoteId); const wasMember=isPeerOpen(remoteId);
    try{
        peers.delete(remoteId); clearTimeout(disconnectTimers.get(remoteId)); disconnectTimers.delete(remoteId);
        if(peer.dc){ peer.dc.onopen=peer.dc.onmessage=peer.dc.onclose=peer.dc.onerror=null; }
        if(peer.pc){ peer.pc.onicecandidate=peer.pc.onconnectionstatechange=peer.pc.ondatachannel=null; }
        try{ if(peer.dc?.readyState!=='closed') peer.dc?.close(); }catch(_){} try{ if(peer.pc?.connectionState!=='closed') peer.pc?.close(); }catch(_){}
        delete confirmedWorld[remoteId]; delete visibleWorld[remoteId]; delete moveState[remoteId]; delete remoteRenderState[remoteId]; delete hitFlashes[remoteId]; confirmedSeq.delete(remoteId); confirmedEventSeq.delete(remoteId); simulationStateHistory.delete(remoteId); tickAnchors.delete(remoteId); activityAnchors.delete(remoteId); prePeerIce.delete(remoteId);
        for(const [id,pending] of [...pendingById]) if(pending.command.playerId===remoteId){ clearTimeout(pending.timeoutId); pendingById.delete(id); }
        pendingOrderByPlayer.delete(remoteId); pendingEventOrderByPlayer.delete(remoteId);
        if(!pageUnloading){ if(wasMember) refreshMembership('peer removed'); updatePeerList(); log('t-sys',`peer removed ↔ ${remoteId} (${reason})`); }
        return true;
    }finally{ tearingDownPeers.delete(remoteId); }
}
