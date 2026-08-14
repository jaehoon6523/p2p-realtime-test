'use strict';

function draw(){
    beginWorldFrame(); const now=performance.now();
    const localRender=getRenderPosition(myId); if(localRender){ context.beginPath(); context.arc(localRender.x,localRender.y,AOI_RADIUS,0,Math.PI*2); context.strokeStyle='rgba(61,220,151,.32)'; context.lineWidth=1.5; context.setLineDash([6,6]); context.stroke(); context.setLineDash([]); }
    for(let i=bullets.length-1;i>=0;i--){ const bullet=bullets[i],age=now-bullet.born; if(now>(bullet.expiresAt||bullet.born+BULLET_TRAIL_MS)){ bullets.splice(i,1); optimisticEffects.delete(bullet.commandId); continue; } const life=Math.max(1,(bullet.expiresAt||bullet.born+BULLET_TRAIL_MS)-bullet.born); context.globalAlpha=Math.max(.12,1-age/life)*(bullet.status==='rejected'?.45:1); context.strokeStyle=bullet.color; context.lineWidth=bullet.status==='tentative'?1.5:bullet.status==='confirmed'?2:1; if(bullet.status==='tentative') context.setLineDash([4,3]); context.beginPath(); context.moveTo(bullet.x1,bullet.y1); context.lineTo(bullet.x2,bullet.y2); context.stroke(); context.setLineDash([]); context.globalAlpha=1; }
    // Server-side bot prefire hint. Purely visual: shot authority still comes from the normal shoot command.
    for(const [botId,t] of [...botTelegraphs]){
        if(t.expiresAt<=now){ botTelegraphs.delete(botId); continue; }
        const bot=getRenderPosition(botId)||visibleWorld[botId]||confirmedWorld[botId]; if(!bot) continue;
        const remaining=Math.max(0,t.fireAt-now), ratio=Math.max(0,Math.min(1,remaining/Math.max(1,t.leadMs)));
        context.save();
        context.globalAlpha=.35+.45*(1-ratio);
        context.strokeStyle='#c77dff'; context.lineWidth=2; context.setLineDash([5,5]);
        context.beginPath(); context.moveTo(bot.x,bot.y); context.lineTo(t.targetX,t.targetY); context.stroke();
        context.setLineDash([]); context.beginPath(); context.arc(t.targetX,t.targetY,18+8*ratio,0,Math.PI*2); context.stroke();
        context.font='9px monospace'; context.fillStyle='#c77dff'; context.fillText(`LOCK ${Math.ceil(remaining)}ms · ping ${Math.round(t.pingMs||0)}ms`,t.targetX+22,t.targetY-8);
        context.restore();
    }
    // 1.5-hop 상태는 발견/사전 로딩용 유령 표시일 뿐, 전투 판정에는 절대 들어가지 않는다.
    const localState=visibleWorld[myId];
    for(const entry of relayWorld.values()){
        if(!localState||entry.expiresAt<=now||distanceBetweenStates(localState,entry)>RELAY_PREFETCH_RADIUS) continue;
        context.save(); context.setLineDash([3,4]); context.strokeStyle='rgba(122,165,255,.72)'; context.lineWidth=1.5; context.beginPath(); context.arc(entry.x,entry.y,8,0,Math.PI*2); context.stroke(); context.restore();
        context.font='9px monospace'; context.fillStyle='rgba(122,165,255,.8)'; context.fillText(`${entry.ownerId} · relay via ${entry.sourcePeerId}`,entry.x+11,entry.y+3);
    }
    for(const playerId in visibleWorld){
        const state=visibleWorld[playerId],render=getRenderPosition(playerId); if(!render) continue; const isMe=playerId===myId; if(!isMe&&!isInLocalAoi(playerId)) continue; const flashing=now<(hitFlashes[playerId]||0),pending=(pendingOrderByPlayer.get(playerId)||[]).length>0;
        context.beginPath(); context.arc(render.x,render.y,isMe?9:7,0,Math.PI*2); context.fillStyle=!state.alive?getComputedStyle(document.documentElement).getPropertyValue('--dead'):flashing?'#fff':state.color||'#888'; context.fill();
        if(pending){ context.lineWidth=2; context.strokeStyle='#f2a93b'; context.stroke(); } else if(isMe){ context.lineWidth=2; context.strokeStyle='#fff'; context.stroke(); }
        context.font='10px monospace'; context.fillStyle='#8fa3b0'; const statusLabel=state.alive?'':` · DEAD ${Math.max(0,Math.ceil((RESPAWN_MS-(now-(state.deadObservedAt||now)))/1000))}s`; context.fillText(`${playerId}${isMe?' (you)':''}${statusLabel}`,render.x+12,render.y+4);
        if(state.alive){ const barWidth=34; context.fillStyle='rgba(28,39,51,.9)'; context.fillRect(render.x-barWidth/2,render.y-17,barWidth,4); context.fillStyle=state.hp===1?'#ef5b6e':state.hp===2?'#f2a93b':'#3ddc97'; context.fillRect(render.x-barWidth/2,render.y-17,barWidth*(state.hp/MAX_HP),4); }
    }
    updateOverlay(); requestAnimationFrame(draw);
}
function updateOverlay(){
    const me=visibleWorld[myId]; if(!me) return;
    document.querySelectorAll('#healthMeter .healthPip').forEach((pip,index)=>{ pip.classList.toggle('on',me.alive&&index<me.hp); pip.dataset.level=String(Math.max(1,me.hp)); });
    const status=document.getElementById('localStatus');
    if(me.alive){ status.textContent='alive'; status.style.color='var(--accent)'; }
    else{ const remain=Math.max(0,Math.ceil((RESPAWN_MS-(performance.now()-(me.deadObservedAt||performance.now())))/1000)); status.textContent=`dead · respawn ${remain}s`; status.style.color='var(--err)'; }
}
function updateKda(){
    const cutoff=Date.now()-KDA_WINDOW_MS; let k=0,d=0,a=0;
    for(const event of killEvents.values()){ if(event.occurredAt<cutoff) continue; if(event.killerId===myId) k++; if(event.victimId===myId) d++; if(event.assists.includes(myId)) a++; }
    document.getElementById('kdaValue').innerHTML=`<b>${k}</b> / ${d} / ${a}`;
}
function renderKillFeed(){
    const rows=document.getElementById('killFeedRows'); const events=[...killEvents.values()].sort((a,b)=>b.occurredAt-a.occurredAt).slice(0,KILL_FEED_LIMIT); rows.textContent='';
    if(!events.length){ const empty=document.createElement('div'); empty.className='killEmpty'; empty.textContent='아직 처치 기록 없음'; rows.appendChild(empty); return; }
    for(const event of events){ const row=document.createElement('div'); row.className='killRow'; const killer=document.createElement('span'); killer.className='killKiller'; killer.textContent=displayName(event.killerId); const victim=document.createElement('span'); victim.className='killVictim'; victim.textContent=displayName(event.victimId); row.append(killer,document.createTextNode('  →  '),victim); if(event.assists.length){ const assist=document.createElement('span'); assist.className='killAssist'; assist.textContent=`  (+${event.assists.map(displayName).join(', ')})`; row.appendChild(assist); } rows.appendChild(row); }
}
function displayName(id){ return id===myId?`${id} (나)`:id; }
function updatePeerList(){
    document.getElementById('connCount').textContent=directOpenPeerIds().length; const element=document.getElementById('peerList'); element.textContent='';
    if(!peers.size){ const empty=document.createElement('span'); empty.style.color='var(--dim)'; empty.textContent='다른 유저 대기 중...'; element.appendChild(empty); return; }
    for(const [id,peer] of peers){ const row=document.createElement('div'); row.className='peerRow'; const connected=isPeerOpen(id); const left=document.createElement('span'); const dot=document.createElement('span'); dot.className='dot'; dot.style.background=connected?'var(--accent)':'var(--warn)'; left.append(dot,document.createTextNode(id)); const right=document.createElement('span'); right.textContent=connected?(peer.transport==='ws-bot'?'BOT/WS':desiredSimulationPeers.has(id)?'SIM/AOI':desiredTopologyPeers.has(id)?'TOPO':'direct'):peer.state; right.style.color=connected?'var(--accent)':'var(--warn)'; row.append(left,right); element.appendChild(row); }
}

const logElement=document.getElementById('log'); const logEmpty=document.getElementById('logEmpty');
function classifyLog(className,message){
    if(className==='t-err') return {level:'error',category:'system'}; if(message.startsWith('[POS#')) return {level:className==='t-warn'?'warn':'info',category:'position'}; if(className==='t-warn') return {level:'warn',category:message.includes('DEAD')?'combat':'system'}; if(className==='t-sig'||message.startsWith('[SIGNAL]')) return {level:'info',category:'signal'}; if(className==='t-cmd'||className==='t-audit') return {level:'info',category:'combat'}; if(className==='t-pos'||message.startsWith('[POS#')) return {level:'info',category:'position'}; return {level:'info',category:'system'};
}
function log(className,message){ const meta=classifyLog(className,message); pendingLogs.push({className,message,level:meta.level,category:meta.category,time:new Date().toLocaleTimeString('ko-KR',{hour12:false})}); }
function matchesLog(item){ if(activeLogFilter==='all') return true; if(activeLogFilter==='error'||activeLogFilter==='warn') return item.level===activeLogFilter; return item.category===activeLogFilter; }
function renderLogs(){
    const wasNearBottom=logElement.scrollHeight-logElement.scrollTop-logElement.clientHeight<40; for(const item of pendingLogs){ logHistory.push(item); if(logHistory.length>LOG_HISTORY_LIMIT) logHistory.shift(); } pendingLogs=[];
    logElement.querySelectorAll('[data-log-row]').forEach(node=>node.remove()); let visible=0; const fragment=document.createDocumentFragment();
    for(const item of logHistory){ if(!matchesLog(item)) continue; const row=document.createElement('div'); row.dataset.logRow='1'; row.className=item.className; row.textContent=`[${item.time}] ${item.message}`; fragment.appendChild(row); visible++; }
    logElement.appendChild(fragment); logEmpty.style.display=visible?'none':'block'; updateLogCounts(); if(wasNearBottom) logElement.scrollTop=logElement.scrollHeight;
}
function updateLogCounts(){
    const counts={all:logHistory.length,error:0,warn:0,signal:0,combat:0,position:0}; for(const item of logHistory){ if(item.level==='error')counts.error++; if(item.level==='warn')counts.warn++; if(item.category==='signal')counts.signal++; if(item.category==='combat')counts.combat++; if(item.category==='position')counts.position++; }
    document.getElementById('logCountAll').textContent=counts.all; document.getElementById('logCountError').textContent=counts.error; document.getElementById('logCountWarn').textContent=counts.warn; document.getElementById('logCountSignal').textContent=counts.signal; document.getElementById('logCountCombat').textContent=counts.combat; document.getElementById('logCountPosition').textContent=counts.position;
}
function setLogFilter(filter){ activeLogFilter=filter; document.querySelectorAll('.logFilter[data-filter]').forEach(button=>button.classList.toggle('active',button.dataset.filter===filter)); renderLogs(); }
function clearLogs(){ logHistory.length=0; pendingLogs=[]; renderLogs(); }

async function copyLogsToClipboard(){
    const snapshot=[...logHistory,...pendingLogs];
    const header=[
        '# PSSF Runtime Log',
        `peer=${myId} mode=${AUTO_MODE?'AUTO':'MANUAL'} protocol=${PROTOCOL} ruleset=${RULESET_REVISION} room=${ROOM_ID}`,
        `connections=${directOpenPeerIds().length} membership=${serverPeerCount} room / ${directOpenPeerIds().length} direct`,
        ''
    ];
    const body=snapshot.map(item=>`[${item.time}] ${item.message}`);
    const text=[...header,...body].join('\n');
    let copied=false;
    try{
        if(navigator.clipboard?.writeText){ await navigator.clipboard.writeText(text); copied=true; }
    }catch(_){}
    if(!copied){
        const area=document.createElement('textarea'); area.value=text; area.setAttribute('readonly',''); area.style.position='fixed'; area.style.opacity='0'; document.body.appendChild(area); area.select();
        try{ copied=document.execCommand('copy'); }catch(_){} area.remove();
    }
    const button=document.getElementById('copyLogsBtn');
    if(button){ const old=button.textContent; button.textContent=copied?'복사됨':'복사 실패'; setTimeout(()=>{button.textContent=old;},1200); }
    return copied;
}
window.setLogFilter=setLogFilter; window.clearLogs=clearLogs; window.copyLogsToClipboard=copyLogsToClipboard;
