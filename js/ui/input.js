'use strict';

function resizeCanvas(){ canvas.width=canvas.clientWidth*devicePixelRatio; canvas.height=canvas.clientHeight*devicePixelRatio; }
function beginWorldFrame(){
    const sx=canvas.clientWidth/WORLD_WIDTH,sy=canvas.clientHeight/WORLD_HEIGHT;
    context.setTransform(devicePixelRatio*sx,0,0,devicePixelRatio*sy,0,0);
    context.clearRect(0,0,WORLD_WIDTH,WORLD_HEIGHT);
}
window.addEventListener('resize',resizeCanvas); resizeCanvas();

function aimVectorFromWorld(me,point=lastAimWorld){
    const dx=point.x-me.x,dy=point.y-me.y,length=Math.hypot(dx,dy);
    return length>1e-9?{x:dx/length,y:dy/length}:null;
}
function abilitySuppressed(ability,code,detail=''){
    log('warn',`ABILITY_SUPPRESSED key=${ability.key} ability=${ability.id} code=${code}${detail?` ${detail}`:''}`);
}
function tryCastAbility(key){
    const ability=ABILITY_DEFINITIONS[key];
    if(!ability||!roomReady) return;
    const now=performance.now();
    const castStartTick=currentTick();
    const me=getPredictedTail(myId);
    if(!me){ abilitySuppressed(ability,'NO_LOCAL_STATE'); return; }
    if(!me.alive){ abilitySuppressed(ability,'DEAD',`life=${me.lifeId}`); return; }
    const readyAt=localAbilityReadyAt.get(ability.id)||0;
    if(now<readyAt){ abilitySuppressed(ability,'COOLDOWN',`remaining=${Math.ceil(readyAt-now)}ms`); return; }
    if(now<localAbilityLockUntil){ abilitySuppressed(ability,'ACTION_LOCK',`remaining=${Math.ceil(localAbilityLockUntil-now)}ms`); return; }
    const aim=aimVectorFromWorld(me);
    if(!aim){ abilitySuppressed(ability,'INVALID_AIM'); return; }

    localAbilityReadyAt.set(ability.id,now+ability.cooldownMs);
    localAbilityLockUntil=now+ability.castMs;
    log('t-cmd',`ABILITY_CAST key=${ability.key} ability=${ability.id} cast=${ability.castMs}ms cooldown=${ability.cooldownMs}ms`);
    const release=()=>{
        if(!roomReady) return abilitySuppressed(ability,'ROOM_NOT_READY_AFTER_CAST');
        flushActiveMoveToNow();
        const current=getPredictedTail(myId);
        if(!current?.alive) return abilitySuppressed(ability,'DEAD_DURING_CAST');
        const releaseCastStartTick=ability.castMs===0?currentTick():castStartTick;
        let command=null;
        if(ability.kind==='shoot') command=makeShootCommand(aim.x,aim.y,ability.id,releaseCastStartTick);
        else if(ability.kind==='dash') command=makeDashCommand(aim.x,aim.y,releaseCastStartTick);
        if(command){
            executeLocal(command);
            log('t-cmd',`ABILITY_RELEASE key=${ability.key} ability=${ability.id} ${commandSequenceText(command)}`);
        }else abilitySuppressed(ability,'COMMAND_NOT_CREATED');
        localAbilityLockUntil=Math.max(localAbilityLockUntil,performance.now()+ability.recoveryMs);
    };
    if(ability.castMs===0) release();
    else setTimeout(release,ability.castMs);
}

canvas.addEventListener('pointermove',event=>{ lastAimWorld=screenToWorld(event.clientX,event.clientY); });
canvas.addEventListener('contextmenu',event=>{
    event.preventDefault(); if(!roomReady) return; const me=getPredictedTail(myId); if(!me?.alive) return;
    const point=screenToWorld(event.clientX,event.clientY); lastAimWorld=point; const render=getRenderPosition(myId)||me;
    tracePosition('click:right',{force:true,extra:`worldClick=${point.x.toFixed(2)},${point.y.toFixed(2)}`});
    startMove(myId,render.x,render.y,point.x,point.y);
});
window.addEventListener('keydown',event=>{
    if(!roomReady||event.repeat) return;
    const key=String(event.key||'').toUpperCase();
    if(ABILITY_DEFINITIONS[key]){ event.preventDefault(); tryCastAbility(key); return; }
    let dx=0,dy=0; const step=16;
    if(event.key==='ArrowUp')dy=-step; else if(event.key==='ArrowDown')dy=step; else if(event.key==='ArrowLeft')dx=-step; else if(event.key==='ArrowRight')dx=step; else return;
    event.preventDefault(); const me=getPredictedTail(myId); if(!me?.alive) return; delete moveState[myId]; executeLocal(makeMoveCommand(dx,dy));
});
