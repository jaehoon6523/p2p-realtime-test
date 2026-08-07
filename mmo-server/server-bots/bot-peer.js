'use strict';

const { WebSocket } = require('ws');
const { ProtocolState, PROTOCOL, RULESET_REVISION, AOI_RADIUS, round6 } = require('./bot-protocol');
const { DodgeBotAI } = require('./bot-ai');

const SIGNAL_PROTOCOL=4;
const DATA_CHANNEL_LABEL='arena-v13';
const STUN={iceServers:[{urls:'stun:stun.l.google.com:19302'}]};
function wait(ms){ return new Promise(r=>setTimeout(r,ms)); }

class BotPeer {
  constructor({id,signalUrl,room='test1',verbose=false}){
    this.id=id; this.signalUrl=signalUrl; this.room=room; this.verbose=verbose;
    this.ws=null; this.joined=false; this.WebRTC=null; this.peers=new Map(); this.prePeerIce=new Map();
    this.desiredDirectPeers=new Set(); this.protocol=new ProtocolState({id,aoiRadius:AOI_RADIUS}); this.ai=new DodgeBotAI(this);
    this.aiTimer=null; this.presenceTimer=null; this.keepaliveTimer=null; this.stableSince=0; this.aiEnabled=false;
    this.preJoinSignals=[]; this.orphanCertificates=new Map();
  }
  log(...args){ if(this.verbose) console.log(`[${this.id}]`,...args); }
  async loadWebRTC(){
    if(this.WebRTC) return;
    try{ this.WebRTC=await import('werift'); }
    catch(error){ throw new Error(`werift가 없습니다. server-bots에서 npm install이 필요합니다. (${error.message})`); }
  }
  async start(){
    await this.loadWebRTC(); await this.connectSignal();
    this.aiTimer=setInterval(()=>{ if(this.aiEnabled&&this.isStable()) this.ai.tick().catch(e=>this.log('ai',e.message)); },90);
    this.presenceTimer=setInterval(()=>this.sendPresence(),1000);
    this.keepaliveTimer=setInterval(()=>this.sendSignal({type:'keepalive'}),25000);
  }
  enableAI(){ this.aiEnabled=true; }
  isStable(){
    if(!this.joined||!this.protocol.selfPolicy) return false;
    const desired=[...this.desiredDirectPeers];
    return desired.every(id=>this.protocol.openPeers.has(id)) && performance.now()-this.stableSince>500;
  }
  topologyStatus(){ return {desired:this.desiredDirectPeers.size,open:this.protocol.openPeers.size,ready:this.isStable()}; }
  async connectSignal(){
    await new Promise((resolve,reject)=>{
      const ws=new WebSocket(this.signalUrl); this.ws=ws; let settled=false;
      const finishReject=err=>{ if(settled) return; settled=true; clearTimeout(timeout); reject(err); };
      const finishResolve=()=>{ if(settled) return; settled=true; clearTimeout(timeout); resolve(); };
      const timeout=setTimeout(()=>finishReject(new Error(`signaling join timeout url=${this.signalUrl}`)),12000);
      ws.on('open',()=>{
        ws.send(JSON.stringify({type:'join',channelId:this.room,peerId:this.id,signalProtocol:SIGNAL_PROTOCOL,rulesetRevision:RULESET_REVISION,aoiRadius:AOI_RADIUS}));
      });
      ws.on('message',data=>{
        let m; try{m=JSON.parse(data.toString())}catch{return;}
        if(m.type==='join-error') return finishReject(new Error(`signaling join rejected: ${m.reason||'unknown'}`));
        if(m.type==='joined'&&m.peerId===this.id){
          if(m.signalProtocol!==SIGNAL_PROTOCOL||m.rulesetRevision!==RULESET_REVISION) return finishReject(new Error(`joined protocol mismatch signal=${m.signalProtocol} ruleset=${m.rulesetRevision}`));
          this.joined=true; this.protocol.applyPolicyView(m);
          this.applyTopologyAssignment(m.selfPolicy||{},'joined').then(async()=>{
            this.sendPresence();
            const queued=this.preJoinSignals.splice(0); for(const q of queued) await this.handleSignal(q);
            finishResolve();
          }).catch(finishReject);
          return;
        }
        if(!this.joined && ['offer','answer','ice','topology-update','verification-certificate'].includes(m.type)){ this.preJoinSignals.push(m); return; }
        this.handleSignal(m).catch(e=>this.log('signal',e.message));
      });
      ws.on('error',finishReject);
      ws.on('close',(code,reason)=>{ this.joined=false; if(!settled) finishReject(new Error(`signaling closed before join code=${code} reason=${reason||''}`)); });
    });
  }
  sendSignal(message){
    if(!this.joined||this.ws?.readyState!==WebSocket.OPEN) return false;
    try{ this.ws.send(JSON.stringify({...message,from:this.id,signalProtocol:SIGNAL_PROTOCOL})); return true; }catch{return false;}
  }
  sendPresence(){ const me=this.protocol.predictedTail(this.id)||this.protocol.confirmedWorld[this.id]; if(me) this.sendSignal({type:'presence',x:round6(me.x),y:round6(me.y),aoiRadius:AOI_RADIUS}); }
  async handleSignal(message){
    if(!message) return;
    if(message.type==='join-error') throw new Error(`signaling join error: ${message.reason||'unknown'}`);
    if(message.type==='topology-update'){
      if(message.peerId!==this.id||message.signalProtocol!==SIGNAL_PROTOCOL) return;
      this.protocol.applyPolicyView(message); await this.applyTopologyAssignment(message.selfPolicy||{},message.reason||'update'); return;
    }
    if(message.type==='verification-certificate'){
      if(!this.protocol.applyCertificate(message)) this.orphanCertificates.set(message.commandId,message);
      return;
    }
    if(message.type==='membership-summary'||message.type==='relay-error') return;
    if(message.from===this.id||(message.to&&message.to!==this.id)||typeof message.from!=='string') return;
    if(message.type==='offer') await this.createPeer(message.from,false,message.sdp);
    else if(message.type==='answer'){
      const p=this.peers.get(message.from); if(p?.pc){ await p.pc.setRemoteDescription(message.sdp); await this.flushIce(p); }
    } else if(message.type==='ice'){
      const p=this.peers.get(message.from);
      if(p?.pc){ if(p.pc.remoteDescription) await p.pc.addIceCandidate(message.candidate); else p.pendingIce.push(message.candidate); }
      else{ const q=this.prePeerIce.get(message.from)||[]; q.push(message.candidate); this.prePeerIce.set(message.from,q); }
    }
  }
  async applyTopologyAssignment(policy,reason='update'){
    const next=new Set((Array.isArray(policy?.directPeers)?policy.directPeers:[]).filter(id=>typeof id==='string'&&id!==this.id).slice(0,24));
    this.desiredDirectPeers=next;
    for(const id of [...this.peers.keys()]) if(!next.has(id)) this.removePeer(id,`topology removed ${reason}`);
    for(const id of next){
      if(this.peers.has(id)) continue;
      if(this.id<id) await this.createPeer(id,true);
      else this.peers.set(id,{pc:null,dc:null,pendingIce:[...(this.prePeerIce.get(id)||[])]});
    }
    this.stableSince=performance.now();
  }
  bindPcEvents(pc,remoteId,entry){
    const onIce=ev=>{ const candidate=ev?.candidate; if(candidate) this.sendSignal({type:'ice',to:remoteId,candidate:typeof candidate.toJSON==='function'?candidate.toJSON():candidate}); };
    const onState=()=>{ const state=pc.connectionState||pc.iceConnectionState; if(['failed','closed'].includes(state)) this.removePeer(remoteId,`pc ${state}`); };
    const onDc=ev=>{ const dc=ev?.channel||ev; if(dc) this.bindDataChannel(remoteId,entry,dc); };
    if(typeof pc.addEventListener==='function'){
      pc.addEventListener('icecandidate',onIce); pc.addEventListener('connectionstatechange',onState); pc.addEventListener('datachannel',onDc);
    } else {
      pc.iceCandidate?.subscribe?.(candidate=>onIce({candidate}));
      pc.connectionStateChange?.subscribe?.(()=>onState());
      pc.iceConnectionStateChange?.subscribe?.(()=>onState());
      pc.onDataChannel?.subscribe?.(dc=>onDc(dc));
    }
  }
  async createPeer(remoteId,isOfferer,remoteSdp){
    const old=this.peers.get(remoteId); if(old?.pc) return;
    const {RTCPeerConnection}=this.WebRTC; const pc=new RTCPeerConnection(STUN);
    const entry={pc,dc:null,pendingIce:[...(old?.pendingIce||[]),...(this.prePeerIce.get(remoteId)||[])]}; this.prePeerIce.delete(remoteId); this.peers.set(remoteId,entry);
    this.bindPcEvents(pc,remoteId,entry);
    if(isOfferer){
      const dc=pc.createDataChannel(DATA_CHANNEL_LABEL,{ordered:true}); this.bindDataChannel(remoteId,entry,dc);
      await pc.setLocalDescription(await pc.createOffer()); this.sendSignal({type:'offer',to:remoteId,sdp:pc.localDescription});
    } else {
      await pc.setRemoteDescription(remoteSdp); await this.flushIce(entry); await pc.setLocalDescription(await pc.createAnswer()); this.sendSignal({type:'answer',to:remoteId,sdp:pc.localDescription});
    }
  }
  async flushIce(entry){ const q=entry.pendingIce.splice(0); for(const c of q){ try{await entry.pc.addIceCandidate(c);}catch(e){this.log('ice reject',e.message);} } }
  bindDataChannel(remoteId,entry,dc){
    if(entry.dc===dc) return; entry.dc=dc; let opened=false;
    const onOpen=()=>{ if(opened) return; opened=true; this.protocol.setOpenPeer(remoteId,true); this.stableSince=performance.now(); this.safeSend(remoteId,{kind:'snapshot',snapshot:this.protocol.snapshot()}); this.sendPresence(); this.log('dc open',remoteId); };
    const onClose=()=>this.removePeer(remoteId,'dc closed');
    const onMessage=ev=>{ const data=ev?.data??ev; const raw=Buffer.isBuffer(data)?data.toString():typeof data==='string'?data:String(data); this.handleWire(remoteId,raw); };
    if(typeof dc.addEventListener==='function'){
      dc.addEventListener('open',onOpen); dc.addEventListener('close',onClose); dc.addEventListener('message',onMessage);
    } else {
      dc.stateChanged?.subscribe?.(v=>{ if(v==='open') onOpen(); if(v==='closed') onClose(); });
      dc.onMessage?.subscribe?.(data=>onMessage(data));
    }
    if(dc.readyState==='open') onOpen();
  }
  safeSend(remoteId,message){ const p=this.peers.get(remoteId); if(!p?.dc||p.dc.readyState!=='open') return false; try{p.dc.send(JSON.stringify(message));return true;}catch{return false;} }
  broadcastToPolicy(message,command=null){ const ids=command?(this.protocol.policyForCommand(command)?.directPeers||[]):[...this.protocol.openPeers]; for(const id of ids) if(this.protocol.openPeers.has(id)) this.safeSend(id,message); }
  broadcastTelegraph({targetId,targetX,targetY,leadMs,pingMs}){
    this.broadcastToPolicy({kind:'botTelegraph',telegraph:{protocol:PROTOCOL,botId:this.id,targetId,targetX,targetY,leadMs,pingMs,createdAt:Date.now()}});
  }
  maybeSendReceipt(command){
    if(!this.protocol.validatorsFor(command).includes(this.id)) return;
    const receipt=this.protocol.makeVerificationReceipt(command); this.sendSignal({type:'verification-receipt',receipt});
  }
  async sendCommand(command){
    if(!command) return false;
    const accepted=this.protocol.acceptCommand(command,this.id); if(!accepted.ok){ this.log('self command reject',accepted.reason); return false; }
    this.broadcastToPolicy({kind:'command',command},command);
    if(command.type!=='move') this.maybeSendReceipt(command);
    const orphan=this.orphanCertificates.get(command.commandId); if(orphan){ this.orphanCertificates.delete(command.commandId); this.protocol.applyCertificate(orphan); }
    this.sendPresence(); return true;
  }
  handleWire(remoteId,raw){
    let m; try{m=JSON.parse(raw);}catch{return;}
    if(m.kind==='snapshot'){ this.protocol.mergeSnapshot(remoteId,m.snapshot); return; }
    if(m.kind==='command'){
      const c=m.command, result=this.protocol.acceptCommand(c,remoteId); if(!result.ok&&!result.deferred){ this.log('remote command reject',remoteId,result.reason); return; }
      if(result.ok&&c.type!=='move') this.maybeSendReceipt(c);
      const orphan=this.orphanCertificates.get(c.commandId); if(orphan){ this.orphanCertificates.delete(c.commandId); this.protocol.applyCertificate(orphan); }
      return;
    }
  }
  removePeer(remoteId,reason='unknown'){
    const p=this.peers.get(remoteId); if(!p) return; this.peers.delete(remoteId); this.protocol.setOpenPeer(remoteId,false); this.stableSince=performance.now();
    try{p.dc?.close();}catch{} try{p.pc?.close();}catch{} this.log('peer removed',remoteId,reason);
  }
  async stop(){
    clearInterval(this.aiTimer); clearInterval(this.presenceTimer); clearInterval(this.keepaliveTimer); this.aiEnabled=false;
    try{this.sendSignal({type:'leave'});}catch{} for(const id of [...this.peers.keys()]) this.removePeer(id,'stop'); try{this.ws?.close();}catch{} await wait(20);
  }
}
module.exports={BotPeer};
