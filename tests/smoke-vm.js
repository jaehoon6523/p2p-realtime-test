'use strict';

const fs=require('fs');
const path=require('path');
const vm=require('vm');
const {performance}=require('perf_hooks');
const {webcrypto}=require('crypto');

function classList(){ return {add(){},remove(){},toggle(){},contains(){return false;}}; }
function makeElement(id=''){
  return {id,textContent:'',innerHTML:'',className:'',style:{},dataset:{},classList:classList(),clientWidth:1000,clientHeight:760,width:1000,height:760,scrollHeight:0,scrollTop:0,append(){},appendChild(){},remove(){},setAttribute(){},querySelectorAll(){return[];},addEventListener(){},getBoundingClientRect(){return{left:0,top:0,width:1000,height:760}}};
}
const elements=new Map();
const canvas=makeElement('canvas');
canvas.getContext=()=>({setTransform(){},clearRect(){},beginPath(){},arc(){},stroke(){},fill(){},fillRect(){},moveTo(){},lineTo(){},setLineDash(){},save(){},restore(){},fillText(){}});
elements.set('canvas',canvas);
const document={title:'',body:makeElement('body'),getElementById(id){if(!elements.has(id))elements.set(id,makeElement(id));return elements.get(id);},querySelectorAll(){return[];},createElement(tag){return makeElement(tag);},createTextNode(text){return{textContent:String(text)};},createDocumentFragment(){return makeElement('fragment');}};
const context={console,document,location:{search:'?room=test1',href:'http://localhost/p2p-mmo-demo-hardened.html?room=test1',pathname:'/p2p-mmo-demo-hardened.html',protocol:'http:'},URL,URLSearchParams,TextEncoder,performance,crypto:webcrypto,Math,Date,Map,Set,Object,Array,Number,String,Boolean,JSON,RegExp,setTimeout,clearTimeout,setInterval,clearInterval,requestAnimationFrame(){return 1;},devicePixelRatio:1,getComputedStyle(){return{getPropertyValue(){return'#777';}}}};
context.window=context;
context.window.addEventListener=()=>{};
context.WebSocket=class{static CONNECTING=0;static OPEN=1;constructor(){this.readyState=3;}close(){}send(){}};
context.RTCPeerConnection=class{};
vm.createContext(context);

const root=path.join(__dirname,'..','js');
for(const file of [
  'core/config-state.js',
  'core/membership-topology.js',
  'game/ruleset.js',
  'core/command-factory.js',
  'core/disposition.js',
  'core/event-stream.js',
  'game/simulation.js',
  'testing/netem.js',
  'core/verification.js',
  'transport/network.js',
  'ui/input.js',
  'testing/auto-brain.js',
  'ui/runtime-ui.js',
]) vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),context,{filename:file});

vm.runInContext(`
  initializePlayer(myId,100,100,myColor);
  storeServerPolicy({peerId:myId,assignmentId:'self-a1',topologyEpoch:1,validatorIds:[],quorum:0,rulesetRevision:RULESET_REVISION,directPeers:[],topologyPeers:[],simulationPeers:[]},{self:true});
  serverPeerCount=1;

  // Regression from the real 180ms+jitter log: one tick beyond the old boundary must not be rejected.
  initializePlayer('peerA',200,200,colorFor('peerA'),{tick:100,sequence:0});
  storeServerPolicy({peerId:'peerA',assignmentId:'peer-a1',topologyEpoch:1,validatorIds:[],quorum:0,rulesetRevision:RULESET_REVISION,directPeers:[],topologyPeers:[],simulationPeers:[]});
  tickAnchors.set('peerA',{remoteTick:100,localTime:performance.now()});
  const nearFuture=checkCommandTick('peerA',113,100);
  if(nearFuture.disposition!=='ACCEPT') throw new Error('ordinary clock lead was not tolerated: '+JSON.stringify(nearFuture));
  const uncertainFuture=checkCommandTick('peerA',119,100);
  if(uncertainFuture.disposition!=='DEFER') throw new Error('moderate clock uncertainty should defer, not reject/fault: '+JSON.stringify(uncertainFuture));
  const absurdFuture=checkCommandTick('peerA',191,100);
  if(absurdFuture.disposition!=='FAULT') throw new Error('grossly implausible clock lead was not isolated as a fault candidate: '+JSON.stringify(absurdFuture));

  // A semantic rejection is a canonical no-op and consumes its sequence.
  localSequence=1;
  const prev={...confirmedWorld[myId]};
  const badMove={protocol:PROTOCOL,rulesetRevision:RULESET_REVISION,type:'move',commandId:'bad-move-1',playerId:myId,sequence:1,previousStateHash:stateHash(prev),tick:currentTick(),topologyEpoch:1,assignmentId:'self-a1',aoiRadius:AOI_RADIUS,dx:500,dy:0,claimedX:600,claimedY:100};
  ingestCommand(badMove,false);
  if((confirmedSeq.get(myId)||0)!==1) throw new Error('rejected event did not consume sequence');
  const r1=finalizedRecord(myId,1);
  if(!r1||r1.disposition!=='REJECTED') throw new Error('rejected event was not recorded as canonical no-op');

  // Duplicate replay is ignored; same sequence with different content is an equivocation fault candidate.
  const ignoredBefore=ignoredCounter;
  ingestCommand(badMove,false);
  if(ignoredCounter<=ignoredBefore) throw new Error('duplicate was not ignored');
  const faultBefore=faultCounter;
  const conflict={...badMove,commandId:'conflict-1',dx:1,claimedX:101};
  ingestCommand(conflict,false);
  if(faultCounter<=faultBefore) throw new Error('same-sequence conflicting event was not classified as fault');
  const commandIdFaultBefore=faultCounter;
  const sameIdConflict={...badMove,dx:2,claimedX:102};
  ingestCommand(sameIdConflict,false);
  if(faultCounter<=commandIdFaultBefore) throw new Error('same commandId with different event content was not classified as fault');

  // A command built on a rejected speculative predecessor is invalidated/no-op, not a permanent hole.
  localSequence=2;
  const dep={...badMove,commandId:'dependent-2',sequence:2,previousStateHash:'deadbeef',dx:1,claimedX:101,tick:currentTick()};
  ingestCommand(dep,false);
  if((confirmedSeq.get(myId)||0)!==2) throw new Error('dependency-invalidated event did not consume sequence');
  const r2=finalizedRecord(myId,2);
  if(!r2||r2.disposition!=='INVALIDATED') throw new Error('dependency invalidation was not recorded');

  // Delayed quorum reject must consume the rejected sequence AND invalidate already-issued dependents without a hole.
  storeServerPolicy({peerId:myId,assignmentId:'self-a2',topologyEpoch:2,validatorIds:['peerA'],quorum:1,rulesetRevision:RULESET_REVISION,directPeers:['peerA'],topologyPeers:['peerA'],simulationPeers:[]},{self:true});
  serverPeerCount=2;
  localSequence=3;
  const base3={...confirmedWorld[myId]};
  const checkpoint3=[{playerId:myId,x:base3.x,y:base3.y,alive:true,lifeId:base3.lifeId,sequence:base3.sequence}];
  const shoot3={protocol:PROTOCOL,rulesetRevision:RULESET_REVISION,type:'shoot',commandId:'shoot-3',playerId:myId,sequence:3,previousStateHash:stateHash(base3),tick:currentTick(),topologyEpoch:2,assignmentId:'self-a2',aoiRadius:AOI_RADIUS,originX:base3.x,originY:base3.y,dirX:1,dirY:0,checkpoint:checkpoint3,checkpointHash:stableHash(checkpoint3),claimedHitId:null,claimedHitLifeId:null};
  ingestCommand(shoot3,false);
  if(!pendingAtSequence(myId,3)||pendingAtSequence(myId,3).verdict) throw new Error('quorum event did not remain pending');
  const speculative3=getPredictedTail(myId);
  localSequence=4;
  const move4={protocol:PROTOCOL,rulesetRevision:RULESET_REVISION,type:'move',commandId:'move-4',playerId:myId,sequence:4,previousStateHash:stateHash(speculative3),tick:currentTick(),topologyEpoch:2,assignmentId:'self-a2',aoiRadius:AOI_RADIUS,dx:1,dy:0,claimedX:round6(speculative3.x+1),claimedY:speculative3.y};
  ingestCommand(move4,false);
  if(!pendingAtSequence(myId,4)||pendingAtSequence(myId,4).verdict!=='accepted') throw new Error('dependent event setup failed');
  applyVerificationCertificate({signalProtocol:SIGNAL_PROTOCOL,commandId:'shoot-3',playerId:myId,sequence:3,assignmentId:'self-a2',verdict:'rejected',evidenceHash:commandFingerprint(shoot3),resultCode:'SHOOT_INVALID',serverTime:Date.now()});
  if((confirmedSeq.get(myId)||0)!==4) throw new Error('quorum rejection left a sequence hole');
  if(finalizedRecord(myId,3)?.disposition!=='REJECTED') throw new Error('quorum reject not finalized as noop');
  if(finalizedRecord(myId,4)?.disposition!=='INVALIDATED') throw new Error('dependent event not invalidated as noop');
  if(localSequence!==4) throw new Error('local sequence was rewound/reused after rejection');

  // Snapshot repair must preserve commands beyond the repaired prefix for replay.
  initializePlayer('peerB',300,300,colorFor('peerB'),{tick:200,sequence:5});
  storeServerPolicy({peerId:'peerB',assignmentId:'peer-b1',topologyEpoch:1,validatorIds:[],quorum:0,rulesetRevision:RULESET_REVISION,directPeers:[],topologyPeers:[],simulationPeers:[]});
  const b5={...confirmedWorld.peerB};
  const b6={protocol:PROTOCOL,rulesetRevision:RULESET_REVISION,type:'move',commandId:'peerB-6',playerId:'peerB',sequence:6,previousStateHash:stateHash(b5),tick:201,topologyEpoch:1,assignmentId:'peer-b1',aoiRadius:AOI_RADIUS,dx:1,dy:0,claimedX:round6(b5.x+1),claimedY:b5.y};
  const p6=addPending(b6,true,{verdict:'accepted'});
  const b6state={...p6.nextState,tentative:false};
  const b7={protocol:PROTOCOL,rulesetRevision:RULESET_REVISION,type:'move',commandId:'peerB-7',playerId:'peerB',sequence:7,previousStateHash:stateHash(p6.nextState),tick:202,topologyEpoch:1,assignmentId:'peer-b1',aoiRadius:AOI_RADIUS,dx:1,dy:0,claimedX:round6(p6.nextState.x+1),claimedY:p6.nextState.y};
  addPending(b7,true,{verdict:'accepted'});
  reconcileEventStreamFromSnapshot('peerB',6);
  if(!deferredAtSequence('peerB',7)) throw new Error('post-snapshot future command was discarded instead of preserved');
  confirmedWorld.peerB=b6state; visibleWorld.peerB={...b6state}; confirmedSeq.set('peerB',6); tickAnchors.set('peerB',{remoteTick:201,localTime:performance.now()});
  acceptDeferred('peerB');
  if((confirmedSeq.get('peerB')||0)!==7) throw new Error('post-resync replay did not continue from repaired prefix');

  // Server-only control frames cannot be forged by a peer relay.
  const invalidBefore=invalidCounter;
  handleSignalMessage({type:'verification-certificate',from:'evil'});
  if(invalidCounter!==invalidBefore+1) throw new Error('server-only guard failed');

  if(typeof runAudit!=='function'||typeof ingestCommand!=='function'||typeof requestPeerResync!=='function') throw new Error('split symbols missing');
`,context,{filename:'smoke-assertions.js'});

const server=fs.readFileSync(path.join(__dirname,'..','mmo-server','signaling-server.js'),'utf8');
if(!server.includes("PEER_RELAY_TYPES = new Set(['offer', 'answer', 'ice', 'wire'])")) throw new Error('server allowlist missing');
if(!server.includes('rejectGroups = new Map()')) throw new Error('reject QC grouping missing');
if(!server.includes('certifiedEvidenceHash')) throw new Error('certificate evidence binding missing');
if(!server.includes("const decision = ['accept', 'reject', 'abstain'].includes(r.decision) ? r.decision : null;")) throw new Error('strict receipt decision validation missing');

console.log('PSSF smoke: PASS');
