'use strict';

const { WebSocket } = require('ws');
const { ProtocolState, PROTOCOL, RULESET_REVISION, DEFAULT_AOI_RADIUS, verificationRequired } = require('./bot-protocol');
const { DodgeBotAI } = require('./bot-ai');

const SIGNAL_PROTOCOL=4;
function wait(ms){ return new Promise(r=>setTimeout(r,ms)); }

class BotPeer {
  constructor({id,signalUrl,room='test1',aoiRadius=DEFAULT_AOI_RADIUS,verbose=false}){
    this.id=id; this.signalUrl=signalUrl; this.room=room; this.aoiRadius=aoiRadius; this.verbose=verbose;
    this.ws=null; this.joined=false; this.peers=new Map(); this.WebRTC=null; this.protocol=new ProtocolState({id,aoiRadius}); this.ai=new DodgeBotAI(this);
    this.aiTimer=null; this.presenceTimer=null; this.stableSince=0; this.desiredDirect=new Set(); this.topologyPeers=new Set(); this.simulationPeers=new Set();
  }
  log(...args){ if(this.verbose) console.log(`[${this.id}]`,...args); }
  async loadWebRTC(){ if(this.WebRTC)return; try{this.WebRTC=await import('werift');}catch(error){throw new Error(`werift가 없습니다. 봇 실행 시에만 'npm i werift'를 설치하세요. (${error.message})`);} }
  async start(){ await this.loadWebRTC(); await this.connectSignal(); this.presenceTimer=setInterval(()=>this.sendPresence(),1000); this.sendPresence(); }
  startAI(){ if(this.aiTimer)return; this.aiTimer=setInterval(()=>{if(this.isStable())this.ai.tick().catch(e=>this.log('ai',e.message));},90); }
  isStable(){ if(!this.joined||performance.now()-this.stableSince<1000)return false; for(const id of this.desiredDirect)if(!this.protocol.openPeers.has(id))return false; return true; }
  async waitUntilStable(timeoutMs=15000){ const start=performance.now(); while(performance.now()-start<timeoutMs){if(this.isStable())return true;await wait(100);}return false; }
  async connectSignal(){
    await new Promise((resolve,reject)=>{ const ws=new WebSocket(this.signalUrl); this.ws=ws; const timeout=setTimeout(()=>reject(new Error('signaling connect timeout')),12000);
      ws.on('open',()=>ws.send(JSON.stringify({type:'join',channelId:this.room,peerId:this.id,signalProtocol:SIGNAL_PROTOCOL,rulesetRevision:RULESET_REVISION,aoiRadius:this.aoiRadius})));
      ws.on('message',data=>{let m;try{m=JSON.parse(data.toString())}catch{return;}this.handleSignal(m).catch(e=>this.log('signal',e.message));if(m.type==='joined'&&m.peerId===this.id){clearTimeout(timeout);this.joined=true;this.applyNetworkView(m,'joined').catch(e=>this.log('topology',e.message));resolve();}});
      ws.on('error',reject); ws.on('close',()=>{this.joined=false;}); });
  }
  sendSignal(message){ if(!this.joined||this.ws?.readyState!==WebSocket.OPEN)return false; try{this.ws.send(JSON.stringify({...message,from:this.id,signalProtocol:SIGNAL_PROTOCOL}));return true;}catch{return false;} }
  sendPresence(){ const me=this.protocol.predictedTail(this.id); if(me)this.sendSignal({type:'presence',x:me.x,y:me.y,aoiRadius:this.aoiRadius}); }
  async handleSignal(message){
    if(!message)return;
    if(message.type==='topology-update'&&message.peerId===this.id){await this.applyNetworkView(message,message.reason||'update');return;}
    if(message.type==='verification-certificate'){this.protocol.applyCertificate(message);return;}
    if(message.type==='membership-summary'){this.protocol.setNetworkView(message);return;}
    if(message.from===this.id||(message.to&&message.to!==this.id))return;
    if(message.type==='offer')await this.createPeer(message.from,false,message.sdp);
    else if(message.type==='answer'){const p=this.peers.get(message.from);if(p?.pc){await p.pc.setRemoteDescription(message.sdp);await this.flushIce(p);}}
    else if(message.type==='ice'){const p=this.peers.get(message.from);if(p?.pc){if(p.pc.remoteDescription)await p.pc.addIceCandidate(message.candidate);else p.pendingIce.push(message.candidate);}else this.peers.set(message.from,{pc:null,dc:null,pendingIce:[message.candidate]});}
  }
  async applyNetworkView(view,reason='update'){
    this.protocol.setNetworkView(view); const self=view.selfPolicy||{}; this.topologyPeers=new Set(self.topologyPeers||[]); this.simulationPeers=new Set(self.simulationPeers||[]); const next=new Set(self.directPeers||[]); this.desiredDirect=next; this.stableSince=performance.now();
    for(const id of [...this.peers.keys()])if(!next.has(id))this.removePeer(id);
    for(const id of next){if(this.peers.has(id))continue;if(this.id<id)await this.createPeer(id,true);else this.peers.set(id,{pc:null,dc:null,pendingIce:[]});}
    this.log('topology',reason,`base=${[...this.topologyPeers]} sim=${[...this.simulationPeers]}`);
  }
  async createPeer(remoteId,isOfferer,remoteSdp){
    const old=this.peers.get(remoteId);if(old?.pc)return;const {RTCPeerConnection}=this.WebRTC;
    const pc=new RTCPeerConnection({iceConfig:{iceServers:[{urls:'stun:stun.l.google.com:19302'}]}}); const entry={pc,dc:null,pendingIce:[...(old?.pendingIce||[])]};this.peers.set(remoteId,entry);
    if(pc.onIceCandidate?.subscribe)pc.onIceCandidate.subscribe(candidate=>{if(candidate)this.sendSignal({type:'ice',to:remoteId,candidate});});
    if(pc.iceConnectionStateChange?.subscribe)pc.iceConnectionStateChange.subscribe(state=>{if(['failed','closed','disconnected'].includes(state))this.removePeer(remoteId);});
    if(pc.onDataChannel?.subscribe)pc.onDataChannel.subscribe(dc=>this.bindDataChannel(remoteId,entry,dc));
    if(isOfferer){const dc=pc.createDataChannel('arena-v13');this.bindDataChannel(remoteId,entry,dc);await pc.setLocalDescription(await pc.createOffer());this.sendSignal({type:'offer',to:remoteId,sdp:pc.localDescription});}
    else{await pc.setRemoteDescription(remoteSdp);await this.flushIce(entry);await pc.setLocalDescription(await pc.createAnswer());this.sendSignal({type:'answer',to:remoteId,sdp:pc.localDescription});}
  }
  async flushIce(entry){const q=entry.pendingIce.splice(0);for(const c of q){try{await entry.pc.addIceCandidate(c);}catch(e){this.log('ice reject',e.message);}}}
  bindDataChannel(remoteId,entry,dc){entry.dc=dc;const onOpen=()=>{this.protocol.setOpenPeer(remoteId,true);this.stableSince=performance.now();this.safeSend(remoteId,{kind:'snapshot',snapshot:this.protocol.snapshot()});this.log('dc open',remoteId);};if(dc.stateChanged?.subscribe)dc.stateChanged.subscribe(v=>{if(v==='open')onOpen();if(v==='closed')this.removePeer(remoteId);});if(dc.onMessage?.subscribe)dc.onMessage.subscribe(data=>this.handleWire(remoteId,data.toString()));if(dc.readyState==='open')onOpen();}
  safeSend(remoteId,message){const p=this.peers.get(remoteId);if(!p?.dc||p.dc.readyState!=='open')return false;try{p.dc.send(JSON.stringify(message));return true;}catch{return false;}}
  broadcast(message){for(const id of this.protocol.openPeers)this.safeSend(id,message);}
  broadcastTelegraph({targetId,targetX,targetY,leadMs,pingMs}){this.broadcast({kind:'botTelegraph',telegraph:{protocol:PROTOCOL,botId:this.id,targetId,targetX,targetY,leadMs,pingMs,createdAt:Date.now()}});}
  submitReceipt(command){const p=this.protocol.policyFor(command.playerId,command.assignmentId);if(!p?.validatorIds?.includes(this.id))return;const receipt=this.protocol.makeVerificationReceipt(command);this.sendSignal({type:'verification-receipt',receipt});}
  async sendCommand(command){const accepted=this.protocol.acceptCommand(command);if(!accepted.ok){this.log('self command rejected locally',accepted.reason);return false;}const policy=this.protocol.policyFor(command.playerId,command.assignmentId);for(const id of policy?.directPeers||[])if(this.protocol.openPeers.has(id))this.safeSend(id,{kind:'command',command});return true;}
  handleWire(remoteId,raw){let m;try{m=JSON.parse(raw);}catch{return;}if(m.kind==='snapshot'){this.protocol.mergeSnapshot(remoteId,m.snapshot);return;}if(m.kind==='command'){const c=m.command;if(c?.playerId!==remoteId){this.log('identity mismatch',remoteId,c?.playerId);return;}const a=this.protocol.acceptCommand(c);if(!a.ok){this.log('remote command reject',remoteId,a.reason);return;}if(verificationRequired(c))this.submitReceipt(c);return;}if(m.kind==='botTelegraph')return;}
  removePeer(remoteId){const p=this.peers.get(remoteId);if(!p)return;this.peers.delete(remoteId);this.protocol.setOpenPeer(remoteId,false);this.stableSince=performance.now();try{p.dc?.close();}catch{}try{p.pc?.close();}catch{}}
  async stop(){clearInterval(this.aiTimer);clearInterval(this.presenceTimer);for(const id of [...this.peers.keys()])this.removePeer(id);try{this.sendSignal({type:'leave'});}catch{}try{this.ws?.close();}catch{}await wait(20);}
}
module.exports={BotPeer};
