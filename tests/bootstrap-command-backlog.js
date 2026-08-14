'use strict';
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const sim=fs.readFileSync(path.join(root,'js/game/simulation.js'),'utf8');
const events=fs.readFileSync(path.join(root,'js/core/event-stream.js'),'utf8');
const state=fs.readFileSync(path.join(root,'js/core/config-state.js'),'utf8');
function must(re,msg){ if(!re.test(sim+events+state)) throw new Error(msg); }
must(/const bootstrapCommandBacklog = new Map\(\)/,'missing per-peer bootstrap command backlog');
must(/function queueCommandUntilBootstrap\(/,'missing bootstrap queue');
must(/function flushBootstrapBacklog\(/,'missing bootstrap flush');
must(/function sendCommandToPeer\(/,'missing gated peer sender');
must(/if\(!bootstrapAckPeers\.has\(remoteId\)\)[\s\S]{0,160}queueCommandUntilBootstrap/,'commands are not gated before ACK');
must(/eventSequence:confirmedEventSeq\.get\(remoteId\)\|\|0/,'snapshot ACK lacks event sequence');
must(/for\(const id of policy\?\.directPeers\|\|\[\]\) if\(isPeerOpen\(id\)\) sendCommandToPeer\(id,command\)/,'executeLocal bypasses bootstrap gate');
must(/retryPendingBootstraps/,'bootstrap retry loop missing');
console.log('PSSF bootstrap command backlog: PASS');
