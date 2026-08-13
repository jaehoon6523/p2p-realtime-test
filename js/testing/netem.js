'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Application-boundary network emulator for AUTO peers.
//
// 왜 setTimeout 하나가 아닌가:
// DataChannel은 ordered/reliable이므로 앞 메시지가 재전송 지연을 먹으면 뒤 메시지도 HOL에 막힌다.
// peer별 tx/rx due time을 단조 증가시켜 이 성질까지 흉내낸다.
// ─────────────────────────────────────────────────────────────────────────────
const netemDue = {tx:new Map(), rx:new Map()};
const netemStats = {
    txScheduled:0, rxScheduled:0,
    retransmitEvents:0, spikeEvents:0, hardDrops:0,
    totalDelayMs:0, maxDelayMs:0
};

function isAutoPeerId(id){ return typeof id==='string' && id.startsWith('AUTO-'); }

function netemBoundaryApplies(direction,remoteId){
    if(!NETEM_ENABLED) return false;
    // AUTO↔AUTO에서 양쪽이 동일 profile을 켜면 각 sender의 tx half만으로 목표 RTT가 만들어진다.
    // 수신측 rx half까지 더하면 두 배가 되므로 AUTO source에 대해서는 rx 중복 지연을 생략한다.
    if(direction==='rx' && AUTO_MODE && isAutoPeerId(remoteId)) return false;
    return true;
}

function sampleNetemDelay(){
    const halfRtt = NETEM_PING_MS * 0.5;
    // triangular jitter: 극단값보다 중앙값이 더 자주 나와 실제 고정 uniform보다 덜 인공적이다.
    const jitter = (Math.random() + Math.random() - 1) * NETEM_JITTER_MS;
    let delay = Math.max(0, halfRtt + jitter);
    let retransmit = false;
    let spike = false;

    // ordered/reliable DataChannel에서 packet loss는 대개 앱 메시지 소실보다 retransmission/HOL 지연으로 보인다.
    if(NETEM_LOSS_PCT > 0 && Math.random()*100 < NETEM_LOSS_PCT){
        retransmit = true;
        delay += NETEM_RETRANSMIT_MS * (0.72 + Math.random()*0.56);
    }
    if(NETEM_SPIKE_PCT > 0 && Math.random()*100 < NETEM_SPIKE_PCT){
        spike = true;
        delay += NETEM_SPIKE_MS * (0.72 + Math.random()*0.56);
    }
    return {delay,retransmit,spike};
}

function scheduleNetem(direction,remoteId,kind,action){
    if(!netemBoundaryApplies(direction,remoteId)){
        action();
        return true;
    }

    // hard drop은 신뢰형 DataChannel의 일반 packet loss와 다른 고장 주입용 옵션이다.
    if(NETEM_DROP_PCT > 0 && Math.random()*100 < NETEM_DROP_PCT){
        netemStats.hardDrops++;
        if(AUTO_DEBUG) log('t-warn',`[NETEM] HARD DROP ${direction} peer=${remoteId} kind=${kind||'wire'}`);
        return true;
    }

    const sample=sampleNetemDelay();
    if(sample.retransmit) netemStats.retransmitEvents++;
    if(sample.spike) netemStats.spikeEvents++;

    const queue=netemDue[direction];
    const now=performance.now();
    const requestedDue=now+sample.delay;
    // ordered channel HOL. 앞 메시지의 due보다 최소 0.25ms 뒤에 배치한다.
    const due=Math.max(requestedDue,(queue.get(remoteId)||0)+0.25);
    queue.set(remoteId,due);

    const effectiveDelay=Math.max(0,due-now);
    netemStats[direction==='tx'?'txScheduled':'rxScheduled']++;
    netemStats.totalDelayMs+=effectiveDelay;
    netemStats.maxDelayMs=Math.max(netemStats.maxDelayMs,effectiveDelay);

    setTimeout(()=>{
        try{ action(); }
        catch(error){ log('t-err',`[NETEM] ${direction} delivery failed peer=${remoteId}: ${error.message}`); }
    },effectiveDelay);

    if(AUTO_DEBUG && (sample.retransmit||sample.spike)){
        log('t-warn',`[NETEM] ${direction} peer=${remoteId} kind=${kind||'wire'} delay=${effectiveDelay.toFixed(0)}ms${sample.retransmit?' retransmit':''}${sample.spike?' spike':''}`);
    }
    return true;
}
