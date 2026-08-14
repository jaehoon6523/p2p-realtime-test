'use strict';
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const network=fs.readFileSync(path.join(root,'js/transport/network.js'),'utf8');
const sim=fs.readFileSync(path.join(root,'js/game/simulation.js'),'utf8');
const auto=fs.readFileSync(path.join(root,'js/testing/auto-brain.js'),'utf8');
function assert(ok,msg){ if(!ok) throw new Error(msg); }
assert(network.includes("message.kind==='snapshotAck'"),'snapshotAck wire handling missing');
assert(network.includes('markBootstrapPending(remoteId);')&&network.includes('sendSnapshot(remoteId,{bootstrap:true})'),'webrtc open must send bootstrap snapshot');
assert(network.includes('markBootstrapPending(id); sendSnapshot(id,{bootstrap:true})'),'ws-bot open must send bootstrap snapshot');
assert(sim.includes('if(bootstrap){')&&sim.includes('sendWireNow(remoteId,message)'),'bootstrap snapshot must bypass synthetic netem');
assert(sim.includes("sendWireNow(remoteId,{kind:'snapshotAck'"),'receiver must ACK installed snapshot');
assert(sim.includes('bootstrapAckPeers.add(remoteId)'),'snapshot ACK must mark peer ready');
assert(auto.includes('if(!bootstrapReadyForAuto())'),'AUTO must wait until bootstrap has been sent to open direct peers');
assert(auto.includes("tryCastAbility('Q',{aimPoint,source:'AUTO'})"),'AUTO must still use shared Q ability path');
console.log('PSSF bootstrap ordering: PASS');
