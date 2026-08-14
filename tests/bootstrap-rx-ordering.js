'use strict';
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const net=fs.readFileSync(path.join(root,'js/transport/network.js'),'utf8');
function must(re,msg){ if(!re.test(net)) throw new Error(msg); }
must(/function isBootstrapControlWire\(raw\)/,'bootstrap classifier missing');
must(/message\?\.kind==='snapshot'\s*&&\s*message\?\.snapshot\?\.bootstrap===true/,'bootstrap snapshot classifier missing');
must(/message\?\.kind==='snapshotAck'/,'snapshotAck classifier missing');
must(/if\(isBootstrapControlWire\(raw\)\)\{[\s\S]*?handleWireMessage\(remoteId,raw\);[\s\S]*?return true;/,'bootstrap RX must bypass scheduleNetem');
const ordinary=net.match(/return scheduleNetem\('rx',remoteId,'wire',[\s\S]*?handleWireMessage\(remoteId,raw\)/);
if(!ordinary) throw new Error('ordinary RX must still use netem');
console.log('PSSF bootstrap RX ordering: PASS');
