'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
let source=fs.readFileSync(path.join(__dirname,'..','mmo-server','signaling-server.js'),'utf8');
source=source.slice(0,source.indexOf('const httpServer='));
const fakeWS={OPEN:1};
const context={console,require:(name)=>name==='http'?require('http'):name==='ws'?{WebSocketServer:class{},WebSocket:fakeWS}:require(name),process:{env:{}},Map,Set,Date,Math,JSON,String,Number,Object,Array,setTimeout,clearTimeout};
vm.createContext(context); vm.runInContext(source,context,{filename:'signaling-server.js'});
vm.runInContext(`
 const room=makeRoom('test1');
 const sent=[];
 function sock(id){ return {readyState:1,send(text){sent.push({id,msg:JSON.parse(text)})}}; }
 const actorPolicy={peerId:'actor',topologyEpoch:1,assignmentId:'a1',transport:'webrtc',topologyPeers:['v1','v2','v3'],simulationPeers:[],directPeers:['v1','v2','v3'],validatorIds:['v1','v2','v3'],quorum:2};
 room.peers.set('actor',{socket:sock('actor'),policy:actorPolicy});
 for(const id of ['v1','v2','v3']) room.peers.set(id,{socket:sock(id),policy:{peerId:id,directPeers:['actor']}});
 room.policyHistory.set('a1',{...actorPolicy,expiresAt:Date.now()+10000});
 function vote(validator,commandId,stream,seq,evidence,computed){ handleVerificationReceipt(room,{peerId:validator},{receipt:{protocol:13,rulesetRevision:RULESET_REVISION,playerId:'actor',commandId,assignmentId:'a1',stream,streamSeq:seq,decision:'accept',resultCode:'ABILITY_VALID',evidenceHash:evidence,computedHash:computed}}); }
 const cases=[['Q','event',1],['W','event',2],['E','simulation',3]];
 for(const [name,stream,seq] of cases){
   vote('v1',name,stream,seq,name+'-ev',name+'-computed');
   const progressBefore=sent.filter(x=>x.msg.type==='verification-progress'&&x.msg.commandId===name).length;
   vote('v1',name,stream,seq,name+'-ev',name+'-computed');
   const progressAfter=sent.filter(x=>x.msg.type==='verification-progress'&&x.msg.commandId===name).length;
   if(progressAfter!==progressBefore) throw new Error(name+' duplicate validator progress was resent');
   vote('v2',name,stream,seq,name+'-ev',name+'-computed');
   const cert=sent.map(x=>x.msg).find(m=>m.type==='verification-certificate'&&m.commandId===name); if(!cert||cert.verdict!=='accepted'||cert.quorum!==2||cert.computedHash!==name+'-computed') throw new Error(name+' q2 certificate missing');
 }
`,context,{filename:'qc-assertions.js'});
console.log('PSSF ability QC q2: PASS');
