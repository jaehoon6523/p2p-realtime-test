'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Browser-native AUTO MODE
// 이 peer는 별도 서버봇이 아니다. 일반 브라우저 peer와 동일한 signaling/WebRTC/
// command/verification 경로를 사용하며 입력만 AI가 대신 생성한다.
// ─────────────────────────────────────────────────────────────────────────────
const autoBrain = {
    targetId:null,
    nextRetargetAt:0,
    nextFireAt:0,
    nextWanderAt:0,
    nextDecisionLogAt:0,
    lastActionAt:0,
    strafeSign:Math.random()<.5?-1:1,
    wanderX:null,
    wanderY:null
};

function autoCandidates(){
    const me=getPredictedTail(myId);
    if(!me?.alive) return [];
    const result=[];
    for(const id of directOpenPeerIds()){
        if(id===myId) continue;
        const state=visibleWorld[id]||confirmedWorld[id];
        if(!state?.alive) continue;
        const render=getRenderPosition(id)||state;
        const distance=Math.hypot(render.x-me.x,render.y-me.y);
        result.push({id,state,render,distance});
    }
    result.sort((a,b)=>a.distance-b.distance||a.id.localeCompare(b.id));
    return result;
}

function autoChooseTarget(){
    const candidates=autoCandidates();
    const current=candidates.find(item=>item.id===autoBrain.targetId);
    // 히스테리시스: 현재 타깃이 너무 멀어지지 않았다면 유지해 불필요한 떨림을 줄인다.
    if(current && current.distance <= Math.max(AOI_RADIUS, MAX_COMBAT_RANGE*1.15)) return current;
    const next=candidates[0]||null;
    autoBrain.targetId=next?.id||null;
    return next;
}

function autoMoveAround(target,now){
    const me=getPredictedTail(myId);
    if(!me?.alive) return;

    if(!target){
        if(now<autoBrain.nextWanderAt) return;
        autoBrain.nextWanderAt=now+AUTO_WANDER_MS*(.8+Math.random()*.4);
        const point=clampWorldPoint(
            WORLD_MARGIN+Math.random()*(WORLD_WIDTH-WORLD_MARGIN*2),
            WORLD_MARGIN+Math.random()*(WORLD_HEIGHT-WORLD_MARGIN*2)
        );
        autoBrain.wanderX=point.x; autoBrain.wanderY=point.y;
        const render=getRenderPosition(myId)||me;
        startMove(myId,render.x,render.y,point.x,point.y);
        return;
    }

    if(now<autoBrain.nextRetargetAt) return;
    autoBrain.nextRetargetAt=now+AUTO_RETARGET_MS*(.82+Math.random()*.36);

    const tx=target.render.x, ty=target.render.y;
    let dx=me.x-tx, dy=me.y-ty;
    let distance=Math.hypot(dx,dy);
    if(distance<1){ dx=1; dy=0; distance=1; }
    const nx=dx/distance, ny=dy/distance;
    const px=-ny*autoBrain.strafeSign, py=nx*autoBrain.strafeSign;

    // 사거리 안쪽을 유지하면서 옆으로 흘러 피하기 쉬운 움직임을 만든다.
    const desiredRange=Math.min(MAX_RANGE-28, Math.max(105, MAX_RANGE*(.58+.16*Math.random())));
    const strafe=34+Math.random()*58;
    const desired=clampWorldPoint(
        tx + nx*desiredRange + px*strafe,
        ty + ny*desiredRange + py*strafe
    );

    if(Math.random()<.18) autoBrain.strafeSign*=-1;
    const render=getRenderPosition(myId)||me;
    startMove(myId,render.x,render.y,desired.x,desired.y);
}

function autoShoot(target,now){
    if(!target || now<autoBrain.nextFireAt) return false;
    const me=getPredictedTail(myId);
    if(!me?.alive) return false;

    const tr=getRenderPosition(target.id)||target.render||target.state;
    if(!tr) return false;
    const distance=Math.hypot(tr.x-me.x,tr.y-me.y);
    const ability=ABILITY_DEFINITIONS.Q;
    if(distance<1 || distance>ability.range-4) return false;

    // 판단만 AUTO가 한다. 실행/쿨다운/후딜/ability lineage는 인간 Q와 동일한 gate를 사용한다.
    const aimPoint={x:tr.x+(Math.random()-.5)*7,y:tr.y+(Math.random()-.5)*7};
    autoBrain.nextFireAt=now+AUTO_FIRE_MS*(.78+Math.random()*.44);
    lastAimWorld=aimPoint;
    tryCastAbility('Q',{aimPoint,source:'AUTO'});
    autoBrain.lastActionAt=now;
    return true;
}

function tickAutoMode(){
    if(!AUTO_MODE || !roomReady) return;
    if(!bootstrapReadyForAuto()){
        const now=performance.now();
        if(AUTO_DEBUG && now>=autoBrain.nextDecisionLogAt){
            autoBrain.nextDecisionLogAt=now+1000;
            const direct=directOpenPeerIds();
            log('t-sys',`AUTO_BOOTSTRAP_WAIT sent=${direct.filter(id=>bootstrapSentPeers.has(id)).length}/${direct.length}`);
        }
        return;
    }
    const me=getPredictedTail(myId);
    if(!me||!me.alive) return;

    const now=performance.now();
    const target=autoChooseTarget();
    autoMoveAround(target,now);
    const fired=autoShoot(target,now);
    if(AUTO_DEBUG && now>=autoBrain.nextDecisionLogAt){
        autoBrain.nextDecisionLogAt=now+1000;
        log('t-sys',`AUTO_TICK target=${target?.id||'-'} distance=${Number.isFinite(target?.distance)?target.distance.toFixed(1):'-'} qRange=${ABILITY_DEFINITIONS.Q.range} fired=${fired?'yes':'no'} move=${moveState[myId]?'active':'idle'}`);
    }
}
