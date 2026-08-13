'use strict';

function resizeCanvas(){ canvas.width=canvas.clientWidth*devicePixelRatio; canvas.height=canvas.clientHeight*devicePixelRatio; }
function beginWorldFrame(){
    const sx=canvas.clientWidth/WORLD_WIDTH,sy=canvas.clientHeight/WORLD_HEIGHT;
    context.setTransform(devicePixelRatio*sx,0,0,devicePixelRatio*sy,0,0);
    context.clearRect(0,0,WORLD_WIDTH,WORLD_HEIGHT);
}
window.addEventListener('resize',resizeCanvas); resizeCanvas();
canvas.addEventListener('click',event=>{
    if(!roomReady) return;
    flushActiveMoveToNow();
    const me=getPredictedTail(myId); if(!me?.alive) return;
    const point=screenToWorld(event.clientX,event.clientY);
    const dx=point.x-me.x,dy=point.y-me.y,distance=Math.hypot(dx,dy)||1;
    executeLocal(makeShootCommand(dx/distance,dy/distance));
});
canvas.addEventListener('contextmenu',event=>{
    event.preventDefault(); if(!roomReady) return; const me=getPredictedTail(myId); if(!me?.alive) return;
    const point=screenToWorld(event.clientX,event.clientY); const render=getRenderPosition(myId)||me;
    tracePosition('click:right',{force:true,extra:`worldClick=${point.x.toFixed(2)},${point.y.toFixed(2)}`});
    startMove(myId,render.x,render.y,point.x,point.y);
});
window.addEventListener('keydown',event=>{
    if(!roomReady) return;
    let dx=0,dy=0; const step=16; if(event.key==='ArrowUp')dy=-step; else if(event.key==='ArrowDown')dy=step; else if(event.key==='ArrowLeft')dx=-step; else if(event.key==='ArrowRight')dx=step; else return;
    event.preventDefault(); const me=getPredictedTail(myId); if(!me?.alive) return; delete moveState[myId]; executeLocal(makeMoveCommand(dx,dy));
});

