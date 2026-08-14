'use strict';
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const event=fs.readFileSync(path.join(root,'js/core/event-stream.js'),'utf8');
const sim=fs.readFileSync(path.join(root,'js/game/simulation.js'),'utf8');
const ui=fs.readFileSync(path.join(root,'js/ui/runtime-ui.js'),'utf8');
const config=fs.readFileSync(path.join(root,'js/core/config-state.js'),'utf8');
function must(cond,msg){ if(!cond) throw new Error(msg); }

must(event.includes("if(command.type==='shoot') spawnBullet(command,previous);"),'shoot is not optimistically rendered on ingest');
must(event.includes("PREDICT_APPLY kind=dash"),'dash optimistic apply telemetry missing');
must(event.includes("if(command.type==='shoot') confirmOptimisticEffect(command);"),'shoot confirmation hook missing');
must(event.includes("if(command.type==='shoot') rejectOptimisticEffect(command"),'shoot correction hook missing');
must(event.includes("if(command.type==='dash'&&command.playerId===myId) rejectOptimisticEffect(command"),'dash correction hook missing');
must(sim.includes("PREDICT_CORRECT kind=shoot"),'shoot correction telemetry missing');
must(sim.includes("action=canonical-snap"),'dash canonical correction telemetry missing');
must(ui.includes("bullet.status==='tentative'"),'tentative projectile rendering missing');
must(ui.includes("bullet.status==='rejected'"),'rejected projectile fade missing');
must(config.includes('const optimisticEffects = new Map()'),'optimistic effect registry missing');

const acceptedStart=event.indexOf('function finalizeAcceptedEvent');
const rejectedStart=event.indexOf('function finalizeRejectedEvent');
const hitCall=event.indexOf('registerConfirmedHit(command,pending.certificateServerTime)');
must(acceptedStart>=0&&rejectedStart>acceptedStart&&hitCall>acceptedStart&&hitCall<rejectedStart,'HP/damage is not certificate-gated to accepted event finalization');
const ingestStart=event.indexOf('function ingestCommand');
must(!(hitCall>ingestStart&&hitCall<acceptedStart),'damage call leaked into speculative ingest path');

console.log('PSSF optimistic correction: PASS');
