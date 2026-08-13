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
    if(current && current.distance <= Math.max(AOI_RADIUS, MAX_RANGE*1.7)) return current;
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
    if(!target || now<autoBrain.nextFireAt) return;
    const me=getPredictedTail(myId);
    if(!me?.alive || hasPendingType(myId,'shoot')) return;

    const tr=getRenderPosition(target.id)||target.render||target.state;
    if(!tr) return;
    const dx=tr.x-me.x, dy=tr.y-me.y;
    const distance=Math.hypot(dx,dy);
    if(distance<1 || distance>MAX_RANGE-4) return;

    autoBrain.nextFireAt=now+AUTO_FIRE_MS*(.78+Math.random()*.44);
    flushActiveMoveToNow(now);
    const shooter=getPredictedTail(myId);
    if(!shooter?.alive) return;

    // 작은 오차를 섞되 거의 항상 실제 target 주변을 조준한다.
    const aimX=tr.x+(Math.random()-.5)*7;
    const aimY=tr.y+(Math.random()-.5)*7;
    const adx=aimX-shooter.x, ady=aimY-shooter.y;
    const len=Math.hypot(adx,ady)||1;
    executeLocal(makeShootCommand(adx/len,ady/len));
}

function tickAutoMode(){
    if(!AUTO_MODE || !roomReady) return;
    const me=getPredictedTail(myId);
    if(!me) return;
    // heal/respawn은 기존 tickCombat이 동일 경로로 처리한다.
    if(!me.alive) return;

    const now=performance.now();
    const target=autoChooseTarget();
    autoMoveAround(target,now);
    autoShoot(target,now);
}
