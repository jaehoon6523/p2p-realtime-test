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
  'game/ability-definitions.js',
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

  // Ordinary clock lead is uncertainty, not cheating.
  initializePlayer('peerA',200,200,colorFor('peerA'),{tick:100,sequence:0});
  storeServerPolicy({peerId:'peerA',assignmentId:'peer-a1',topologyEpoch:1,validatorIds:[],quorum:0,rulesetRevision:RULESET_REVISION,directPeers:[],topologyPeers:[],simulationPeers:[]});
  tickAnchors.set('peerA',{remoteTick:100,localTime:performance.now()});
  const nearFuture=checkCommandTick('peerA',113,100);
  if(nearFuture.disposition!=='ACCEPT') throw new Error('ordinary clock lead was not tolerated: '+JSON.stringify(nearFuture));
  tickAnchors.set('peerA',{remoteTick:100,localTime:performance.now()});
  const uncertainFuture=checkCommandTick('peerA',119,100);
  if(uncertainFuture.disposition!=='DEFER') throw new Error('moderate clock uncertainty should defer: '+JSON.stringify(uncertainFuture));
  tickAnchors.set('peerA',{remoteTick:100,localTime:performance.now()});
  const absurdFuture=checkCommandTick('peerA',191,100);
  if(absurdFuture.disposition!=='RESYNC'||absurdFuture.code!=='CLOCK_MODEL_DIVERGED') throw new Error('gross clock disagreement should repair: '+JSON.stringify(absurdFuture));

  // Simulation semantic rejection consumes only the simulation sequence.
  localSequence=1;
  const prev={...confirmedWorld[myId]};
  const badMove={protocol:PROTOCOL,rulesetRevision:RULESET_REVISION,stream:'simulation',type:'move',commandId:'bad-move-1',playerId:myId,sequence:1,previousStateHash:stateHash(prev),tick:currentTick(),topologyEpoch:1,assignmentId:'self-a1',aoiRadius:AOI_RADIUS,dx:500,dy:0,claimedX:600,claimedY:100};
  ingestCommand(badMove,false);
  if((confirmedSeq.get(myId)||0)!==1) throw new Error('rejected simulation event did not consume sequence');
  if((confirmedEventSeq.get(myId)||0)!==0) throw new Error('simulation rejection advanced event stream');
  const r1=finalizedRecord(myId,1);
  if(!r1||r1.disposition!=='REJECTED') throw new Error('rejected simulation event was not canonical no-op');

  const ignoredBefore=ignoredCounter;
  ingestCommand(badMove,false);
  if(ignoredCounter<=ignoredBefore) throw new Error('duplicate was not ignored');
  const faultBefore=faultCounter;
  const conflict={...badMove,commandId:'conflict-1',dx:1,claimedX:101};
  ingestCommand(conflict,false);
  if(faultCounter<=faultBefore) throw new Error('same simulation sequence conflict was not a fault candidate');

  localSequence=2;
  const dep={...badMove,commandId:'dependent-2',sequence:2,previousStateHash:'deadbeef',dx:1,claimedX:101,tick:currentTick()};
  ingestCommand(dep,false);
  if((confirmedSeq.get(myId)||0)!==2) throw new Error('dependency invalidation did not consume simulation sequence');
  if(finalizedRecord(myId,2)?.disposition!=='INVALIDATED') throw new Error('dependency invalidation not recorded');

  // r4 core regression: unresolved SHOOT uses eventSeq and MUST NOT block simulation movement.
  storeServerPolicy({peerId:myId,assignmentId:'self-a2',topologyEpoch:2,validatorIds:['peerA'],quorum:1,rulesetRevision:RULESET_REVISION,directPeers:['peerA'],topologyPeers:['peerA'],simulationPeers:[]},{self:true});
  serverPeerCount=2;
  const base={...confirmedWorld[myId]};
  localEventSequence=1;
  const checkpoint=[{playerId:myId,x:base.x,y:base.y,alive:true,lifeId:base.lifeId,sequence:base.sequence,tick:base.tick}];
  const shootReleaseTick=currentTick(); const shoot={protocol:PROTOCOL,rulesetRevision:RULESET_REVISION,stream:'event',type:'shoot',abilityId:'basic_attack',abilitySeq:1,castStartTick:shootReleaseTick,previousAbilityRef:null,previousSameAbilityRef:null,commandId:'shoot-e1',playerId:myId,eventSeq:1,simulationRef:{sequence:base.sequence,stateHash:simulationRefHash(base)},tick:shootReleaseTick,topologyEpoch:2,assignmentId:'self-a2',aoiRadius:AOI_RADIUS,aimX:1,aimY:0,checkpoint,checkpointHash:stableHash(checkpoint),claimedHitId:null,claimedHitLifeId:null};
  ingestCommand(shoot,false);
  if(!pendingAtEventSequence(myId,1)||pendingAtEventSequence(myId,1).verdict) throw new Error('shoot did not remain independently pending');
  if((confirmedEventSeq.get(myId)||0)!==0) throw new Error('pending shoot prematurely advanced event stream');

  localSequence=3;
  const simBase={...confirmedWorld[myId]};
  const move3={protocol:PROTOCOL,rulesetRevision:RULESET_REVISION,stream:'simulation',type:'move',commandId:'move-s3',playerId:myId,sequence:3,previousStateHash:stateHash(simBase),tick:currentTick(),topologyEpoch:2,assignmentId:'self-a2',aoiRadius:AOI_RADIUS,dx:1,dy:0,claimedX:round6(simBase.x+1),claimedY:simBase.y};
  ingestCommand(move3,false);
  if((confirmedSeq.get(myId)||0)!==3) throw new Error('pending shoot blocked movement simulation finality');
  if(!pendingAtEventSequence(myId,1)) throw new Error('movement commit incorrectly consumed shoot event');

  applyVerificationCertificate({signalProtocol:SIGNAL_PROTOCOL,commandId:'shoot-e1',playerId:myId,stream:'event',streamSeq:1,assignmentId:'self-a2',verdict:'rejected',evidenceHash:commandFingerprint(shoot),resultCode:'SHOOT_INVALID',serverTime:Date.now()});
  if((confirmedEventSeq.get(myId)||0)!==1) throw new Error('rejected shoot did not consume eventSeq');
  if((confirmedSeq.get(myId)||0)!==3) throw new Error('shoot rejection rewound/advanced simulation sequence');
  if(finalizedEventRecord(myId,1)?.disposition!=='REJECTED') throw new Error('shoot reject not recorded in event history');
  if(finalizedRecord(myId,3)?.disposition!=='ACCEPTED') throw new Error('move was not independently finalized');

  // r8 ability regression: Q/W ranges differ and E dash is bounded.
  const testWorld={target:{x:base.x+300,y:base.y,alive:true,lifeId:1}};
  if(rayHit(base.x,base.y,1,0,testWorld,myId,ABILITY_DEFINITIONS.Q.range)!==null) throw new Error('Q exceeded basic range');
  if(rayHit(base.x,base.y,1,0,testWorld,myId,ABILITY_DEFINITIONS.W.range)!=='target') throw new Error('W long range not applied');
  finalizedAbilityHistory.delete(myId); pendingAbilityTerminals.delete(myId); confirmedAbilitySeq.set(myId,0);
  const dashPrev={...confirmedWorld[myId]};
  const dashCast=currentTick();
  const dash={protocol:PROTOCOL,rulesetRevision:RULESET_REVISION,stream:'simulation',type:'dash',abilityId:'dash',abilitySeq:1,castStartTick:dashCast,previousAbilityRef:null,previousSameAbilityRef:null,commandId:'dash-test',playerId:myId,sequence:4,previousStateHash:stateHash(dashPrev),tick:dashCast+6,topologyEpoch:2,assignmentId:'self-a2',aoiRadius:AOI_RADIUS,dx:Math.min(DASH_DISTANCE,50),dy:0,claimedX:round6(dashPrev.x+Math.min(DASH_DISTANCE,50)),claimedY:dashPrev.y};
  const dashPending={previousState:dashPrev};
  pendingById.set(dash.commandId,{...dashPending,command:dash});
  const dashResult=evaluateCommand(dash,pendingById.get(dash.commandId));
  pendingById.delete(dash.commandId);
  if(dashResult.disposition!==RULE_DISPOSITION.ACCEPT) throw new Error('legal E dash rejected');


  // r9 ability consensus: validators independently enforce cast, recovery and cooldown lineage.
  finalizedAbilityHistory.delete('abilityActor'); pendingAbilityTerminals.delete('abilityActor'); confirmedAbilitySeq.set('abilityActor',0);
  const mkAbility=(abilityId,abilitySeq,castStartTick,releaseTick,prev=null,prevSame=null)=>({playerId:'abilityActor',abilityId,abilitySeq,castStartTick,tick:releaseTick,previousAbilityRef:prev,previousSameAbilityRef:prevSame});
  const q1=mkAbility('basic_attack',1,100,100,null,null);
  let ar=evaluateAbilityContract(q1); if(ar.disposition!==RULE_DISPOSITION.ACCEPT) throw new Error('valid Q timing rejected '+JSON.stringify(ar));
  ar=evaluateAbilityContract(mkAbility('basic_attack',1,100,101,null,null)); if(ar.code!=='ABILITY_CAST_TOO_LATE') throw new Error('Q was not enforced as instant '+JSON.stringify(ar));
  const q1rec={abilitySeq:1,abilityId:'basic_attack',castStartTick:100,releaseTick:100,abilityHash:abilityEvidenceHash(q1),disposition:'ACCEPTED',commandId:'q1'};
  abilityHistoryFor('abilityActor').set(1,q1rec); confirmedAbilitySeq.set('abilityActor',1);
  const q1ref={abilitySeq:1,abilityId:'basic_attack',castStartTick:100,releaseTick:100,abilityHash:q1rec.abilityHash};
  ar=evaluateAbilityContract(mkAbility('long_shot',2,104,110,q1ref,null)); if(ar.code!=='ABILITY_RECOVERY_LOCK') throw new Error('recovery lock not verified '+JSON.stringify(ar));
  ar=evaluateAbilityContract(mkAbility('basic_attack',2,112,112,q1ref,q1ref)); if(ar.code!=='ABILITY_COOLDOWN') throw new Error('Q cooldown not verified '+JSON.stringify(ar));
  ar=evaluateAbilityContract(mkAbility('long_shot',2,112,113,q1ref,null)); if(ar.code!=='ABILITY_CAST_TOO_FAST') throw new Error('cast delay not verified '+JSON.stringify(ar));
  ar=evaluateAbilityContract(mkAbility('long_shot',2,112,118,q1ref,null)); if(ar.disposition!==RULE_DISPOSITION.ACCEPT) throw new Error('valid W lineage rejected '+JSON.stringify(ar));

  // Historical checkpoint validation: moving later must not invalidate an older checkpoint.
  initializePlayer('target',300,300,colorFor('target'),{tick:10,sequence:0});
  const targetOld={...confirmedWorld.target};
  storeServerPolicy({peerId:'target',assignmentId:'target-a1',topologyEpoch:1,validatorIds:[],quorum:0,rulesetRevision:RULESET_REVISION,directPeers:[],topologyPeers:[],simulationPeers:[]});
  const targetMove={protocol:PROTOCOL,rulesetRevision:RULESET_REVISION,stream:'simulation',type:'move',commandId:'target-s1',playerId:'target',sequence:1,previousStateHash:stateHash(targetOld),tick:11,topologyEpoch:1,assignmentId:'target-a1',aoiRadius:AOI_RADIUS,dx:1,dy:0,claimedX:301,claimedY:300};
  const targetPending=addPending(targetMove,true,{verdict:'accepted'});
  commitCommand(targetMove,targetPending);
  const histCheckpoint=[{playerId:myId,x:confirmedWorld[myId].x,y:confirmedWorld[myId].y,alive:true,lifeId:confirmedWorld[myId].lifeId,sequence:confirmedWorld[myId].sequence,tick:confirmedWorld[myId].tick},{playerId:'target',x:targetOld.x,y:targetOld.y,alive:true,lifeId:targetOld.lifeId,sequence:0,tick:targetOld.tick}];
  if(!checkpointMatchesLocal(histCheckpoint,myId,confirmedWorld[myId],{sequence:confirmedWorld[myId].sequence,stateHash:simulationRefHash(confirmedWorld[myId])})) throw new Error('historical checkpoint was compared against target current position');

  // Delayed commit must not rewrite remote clock anchor.
  initializePlayer('peerClock',350,350,colorFor('peerClock'),{tick:300,sequence:0});
  storeServerPolicy({peerId:'peerClock',assignmentId:'peer-c1',topologyEpoch:1,validatorIds:[],quorum:0,rulesetRevision:RULESET_REVISION,directPeers:[],topologyPeers:[],simulationPeers:[]});
  tickAnchors.set('peerClock',{remoteTick:350,localTime:performance.now()});
  const clockBase={...confirmedWorld.peerClock};
  const clockCmd={protocol:PROTOCOL,rulesetRevision:RULESET_REVISION,stream:'simulation',type:'move',commandId:'peerClock-1',playerId:'peerClock',sequence:1,previousStateHash:stateHash(clockBase),tick:301,topologyEpoch:1,assignmentId:'peer-c1',aoiRadius:AOI_RADIUS,dx:1,dy:0,claimedX:round6(clockBase.x+1),claimedY:clockBase.y};
  const clockPending=addPending(clockCmd,true,{verdict:'accepted'});
  commitCommand(clockCmd,clockPending);
  if(tickAnchors.get('peerClock')?.remoteTick!==350) throw new Error('delayed commit rewound remote clock anchor');

  // Snapshot repairs both independent stream prefixes and preserves future commands.
  initializePlayer('peerB',300,300,colorFor('peerB'),{tick:200,sequence:5,eventSequence:2});
  storeServerPolicy({peerId:'peerB',assignmentId:'peer-b1',topologyEpoch:1,validatorIds:[],quorum:0,rulesetRevision:RULESET_REVISION,directPeers:[],topologyPeers:[],simulationPeers:[]});
  const b5={...confirmedWorld.peerB};
  const b6={protocol:PROTOCOL,rulesetRevision:RULESET_REVISION,stream:'simulation',type:'move',commandId:'peerB-6',playerId:'peerB',sequence:6,previousStateHash:stateHash(b5),tick:201,topologyEpoch:1,assignmentId:'peer-b1',aoiRadius:AOI_RADIUS,dx:1,dy:0,claimedX:round6(b5.x+1),claimedY:b5.y};
  const p6=addPending(b6,true,{verdict:'accepted'});
  const b6state={...p6.nextState,tentative:false};
  const b7={protocol:PROTOCOL,rulesetRevision:RULESET_REVISION,stream:'simulation',type:'move',commandId:'peerB-7',playerId:'peerB',sequence:7,previousStateHash:stateHash(p6.nextState),tick:202,topologyEpoch:1,assignmentId:'peer-b1',aoiRadius:AOI_RADIUS,dx:1,dy:0,claimedX:round6(p6.nextState.x+1),claimedY:p6.nextState.y};
  addPending(b7,true,{verdict:'accepted'});
  reconcileEventStreamFromSnapshot('peerB',6,2);
  if(!deferredAtSequence('peerB',7)) throw new Error('future simulation command discarded during snapshot repair');
  confirmedWorld.peerB=b6state; visibleWorld.peerB={...b6state}; confirmedSeq.set('peerB',6); rememberSimulationState('peerB',b6state); tickAnchors.set('peerB',{remoteTick:201,localTime:performance.now()});
  acceptDeferred('peerB','simulation');
  if((confirmedSeq.get('peerB')||0)!==7) throw new Error('post-resync simulation replay failed');

  // r25 multiplayer regression: remote verified command audits even when the actor policy
  // is absent from this peer's local cache. The server will bind/filter the receipt.
  initializePlayer('auditActor',420,420,colorFor('auditActor'),{tick:currentTick(),sequence:0,eventSequence:0});
  const auditBase={...confirmedWorld.auditActor};
  const auditTick=currentTick();
  const auditCheckpoint=[{playerId:'auditActor',x:auditBase.x,y:auditBase.y,alive:true,lifeId:auditBase.lifeId,sequence:auditBase.sequence,tick:auditBase.tick}];
  const auditCommand={protocol:PROTOCOL,rulesetRevision:RULESET_REVISION,stream:'event',type:'shoot',abilityId:'basic_attack',abilitySeq:1,castStartTick:auditTick,previousAbilityRef:null,previousSameAbilityRef:null,commandId:'audit-remote-e1',playerId:'auditActor',eventSeq:1,simulationRef:{sequence:auditBase.sequence,stateHash:simulationRefHash(auditBase)},tick:auditTick,topologyEpoch:999,assignmentId:'server-only-assignment',aoiRadius:AOI_RADIUS,aimX:1,aimY:0,checkpoint:auditCheckpoint,checkpointHash:stableHash(auditCheckpoint),claimedHitId:null,claimedHitLifeId:null};
  receiveCommand('auditActor',auditCommand);
  if(!pendingVerificationReceipts.has('audit-remote-e1:server-only-assignment')) throw new Error('remote audit was suppressed by missing local actor policy');

  const invalidBefore=invalidCounter;
  handleSignalMessage({type:'verification-certificate',from:'evil'});
  if(invalidCounter!==invalidBefore+1) throw new Error('server-only guard failed');

  if(typeof drainEventCommits!=='function'||typeof resolveSimulationReference!=='function'||typeof requestPeerResync!=='function') throw new Error('dual-stream symbols missing');
`,context,{filename:'smoke-assertions.js'});

const server=fs.readFileSync(path.join(__dirname,'..','mmo-server','signaling-server.js'),'utf8');
if(!server.includes("PEER_RELAY_TYPES = new Set(['offer', 'answer', 'ice', 'wire'])")) throw new Error('server allowlist missing');
if(!server.includes('rejectGroups = new Map()')) throw new Error('reject QC grouping missing');
if(!server.includes('certifiedEvidenceHash')) throw new Error('certificate evidence binding missing');
if(!server.includes("const stream = r.stream === 'event' ? 'event' : r.stream === 'simulation' ? 'simulation' : null;")) throw new Error('server stream binding missing');
if(!server.includes('streamSeq: bucket.streamSeq')) throw new Error('certificate stream sequence binding missing');

console.log('PSSF smoke: PASS');
process.exit(0);
