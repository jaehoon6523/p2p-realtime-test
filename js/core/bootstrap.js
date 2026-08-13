'use strict';

initializePlayer(myId, randomSpawnX(), randomSpawnY(), myColor);
queueLocalRenderTarget(visibleWorld[myId],{snap:true});
refreshMembership('boot');
startSignaling();
requestAnimationFrame(draw);

function shutdown(){
    if(pageUnloading) return; pageUnloading=true; signalManualClose=true;
    try{ sendSignal({type:'leave'}); }catch(_){}
    for(const [id] of [...peers]) removePeer(id,'page unload');
    clearTimeout(signalReconnectTimer); clearTimeout(signalConnectTimeout); clearTimeout(roomJoinTimeout); clearInterval(signalKeepaliveTimer); try{signalingSocket?.close(1000,'page unload');}catch(_){}
}
window.addEventListener('pagehide',shutdown); window.addEventListener('beforeunload',shutdown);

setInterval(tickMovement,STEP_INTERVAL_MS);
setInterval(tickCombat,100);
setInterval(tickAutoMode,100);
setInterval(renderLogs,150);
setInterval(updateKda,1000);
setInterval(()=>{ pruneRelayWorld(); pruneServerPolicies(); broadcastNeighborDigests(); },RELAY_INTERVAL_MS);
setInterval(sendPresence,PRESENCE_INTERVAL_MS);
setInterval(()=>document.getElementById('tick').textContent=`TICK ${currentTick()}`,100);
setInterval(()=>{
    const descriptor=membershipDescriptor();
    const localCommittee=[...(selfTopologyPolicy?.validatorIds||[])];
    document.getElementById('epochStat').textContent=`m:${serverMembershipEpoch||'-'} / t:${selfTopologyPolicy?.topologyEpoch??'-'}`;
    document.getElementById('aoiPeerStat').textContent=`${localAoiPeerIds().length} / ${directOpenPeerIds().length} direct · ${serverPeerCount} room`;
    document.getElementById('committeeStat').textContent=`${localCommittee.join(',')||'-'} · q${selfTopologyPolicy?.quorum||0}`;
    document.getElementById('confirmedStat').textContent=confirmedCounter;
    document.getElementById('tentativeStat').textContent=`${(pendingOrderByPlayer.get(myId)||[]).length} sim / ${(pendingEventOrderByPlayer.get(myId)||[]).length} event`;
    document.getElementById('rejectedStat').textContent=rejectedCounter;
    document.getElementById('ignoredStat').textContent=ignoredCounter;
    document.getElementById('deferredStat').textContent=deferredCounter;
    document.getElementById('resyncStat').textContent=resyncCounter;
    const faultEl=document.getElementById('faultStat');
    faultEl.textContent=faultCounter;
    faultEl.dataset.state=faultCounter>0?'bad':'';
    const stalledNow=[...pendingById.values()].filter(p=>p?.stalled&&!p?.verdict).length;
    const stalledNowEl=document.getElementById('stalledCurrentStat');
    stalledNowEl.textContent=stalledNow;
    stalledNowEl.dataset.state=stalledNow>0?'warn':'';
    document.getElementById('stalledStat').textContent=stalledCounter;
    document.getElementById('membershipMismatchStat').textContent=membershipMismatchCounter;
    const relayVisible=[...relayWorld.values()].filter(entry=>entry.expiresAt>performance.now()).length;
    document.getElementById('relayStat').textContent=`${relayVisible} / ${directOpenPeerIds().length}`;
    document.getElementById('trafficStat').textContent=`${(networkMetrics.txBytes/1024).toFixed(1)} / ${(networkMetrics.rxBytes/1024).toFixed(1)} KB`;
    document.getElementById('messageRateStat').textContent=`${networkMetrics.txRate} / ${networkMetrics.rxRate}`;
    const avg=commitLatencySamples.length?commitLatencySamples.reduce((a,b)=>a+b,0)/commitLatencySamples.length:null;
    document.getElementById('commitLatencyStat').textContent=avg==null?'-':`${avg.toFixed(0)} ms`;
    document.getElementById('checkpointStat').textContent=`${networkMetrics.lastCheckpointPlayers} players`;
    document.getElementById('relayMetricStat').textContent=`${relayAcceptedCounter} / ${relayDroppedCounter}`;
},500);
setInterval(()=>{ networkMetrics.txRate=networkMetrics.txMessagesWindow; networkMetrics.rxRate=networkMetrics.rxMessagesWindow; networkMetrics.txByteRate=networkMetrics.txBytesWindow; networkMetrics.rxByteRate=networkMetrics.rxBytesWindow; networkMetrics.txMessagesWindow=networkMetrics.rxMessagesWindow=networkMetrics.txBytesWindow=networkMetrics.rxBytesWindow=0; },1000);

log('t-sys',`local peer boot id=${myId} mode=${AUTO_MODE?'AUTO':'MANUAL'} protocol=${PROTOCOL} ruleset=${RULESET_REVISION} signalProtocol=${SIGNAL_PROTOCOL} room=${ROOM_ID} world=${WORLD_WIDTH}x${WORLD_HEIGHT} margin=${WORLD_MARGIN} aoi=${AOI_RADIUS} committee=${COMMITTEE_SIZE} relay=1.5-hop netem=${NETEM_ENABLED?`rtt:${NETEM_PING_MS} jitter:${NETEM_JITTER_MS} loss:${NETEM_LOSS_PCT} drop:${NETEM_DROP_PCT} spike:${NETEM_SPIKE_PCT}/${NETEM_SPIKE_MS}`:'off'}`);
