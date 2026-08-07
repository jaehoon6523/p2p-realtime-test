'use strict';

const { WebSocket } = require('ws');
const { ProtocolState, PROTOCOL, validatorsFor } = require('./bot-protocol');
const { DodgeBotAI } = require('./bot-ai');

const SIGNAL_PROTOCOL=2;
function wait(ms){ return new Promise(r=>setTimeout(r,ms)); }

class BotPeer {
  constructor({id,signalUrl,room='test1',committeeSize=3,verbose=false}){
    this.id=id; this.signalUrl=signalUrl; this.room=room; this.committeeSize=committeeSize; this.verbose=verbose;
    this.ws=null; this.joined=false; this.peers=new Map(); this.WebRTC=null; this.protocol=new ProtocolState({id,committeeSize}); this.ai=new DodgeBotAI(this);
    this.aiTimer=null; this.announceTimer=null; this.stableSince=0;
  }
  log(...args){ if(this.verbose) console.log(`[${this.id}]`,...args); }
  async loadWebRTC(){
    if(this.WebRTC) return;
    try{ this.WebRTC=await import('werift'); }
    catch(error){ throw new Error(`werift가 없습니다. 봇 실행 시에만 'npm i werift'를 설치하세요. 원본 signaling 서버에는 필요 없습니다. (${error.message})`); }
  }
  async start(){
    await this.loadWebRTC();
    await this.connectSignal();
    this.aiTimer=setInterval(()=>{ if(this.isStable()) this.ai.tick().catch(e=>this.log('ai',e.message)); },90);
    this.announceTimer=setInterval(()=>this.sendSignal({type:'announce'}),3000);
  }
  isStable(){ return this.joined && this.protocol.openPeers.size>0 && performance.now()-this.stableSince>700; }
  async connectSignal(){
    await new Promise((resolve,reject)=>{
      const ws=new WebSocket(this.signalUrl); this.ws=ws;
      const timeout=setTimeout(()=>reject(new Error('signaling connect timeout')),12000);
      ws.on('open',()=>ws.send(JSON.stringify({type:'join',channelId:this.room,peerId:this.id,signalProtocol:SIGNAL_PROTOCOL})));
      ws.on('message',data=>{ let m; try{m=JSON.parse(data.toString())}catch{return;} this.handleSignal(m).catch(e=>this.log('signal',e.message)); if(m.type==='joined'&&m.peerId===this.id){ clearTimeout(timeout); this.joined=true; this.sendSignal({type:'announce'}); resolve(); } });
      ws.on('error',reject);
      ws.on('close',()=>{ this.joined=false; });
    });
  }
  sendSignal(message){ if(!this.joined||this.ws?.readyState!==WebSocket.OPEN) return false; this.ws.send(JSON.stringify({...message,from:this.id,signalProtocol:SIGNAL_PROTOCOL})); return true; }
  async handleSignal(message){
    if(!message||message.from===this.id||(message.to&&message.to!==this.id)) return;
    if(message.type==='announce'){
      if(this.id<message.from&&!this.peers.has(message.from)) await this.createPeer(message.from,true);
      else if(!this.peers.has(message.from)) this.peers.set(message.from,{pc:null,dc:null,pendingIce:[]});
    } else if(message.type==='offer') await this.createPeer(message.from,false,message.sdp);
    else if(message.type==='answer'){
      const p=this.peers.get(message.from); if(p?.pc){ await p.pc.setRemoteDescription(message.sdp); await this.flushIce(p); }
    } else if(message.type==='ice'){
      const p=this.peers.get(message.from); if(p?.pc){ if(p.pc.remoteDescription) await p.pc.addIceCandidate(message.candidate); else p.pendingIce.push(message.candidate); }
      else this.peers.set(message.from,{pc:null,dc:null,pendingIce:[message.candidate]});
    } else if(message.type==='leave') this.removePeer(message.from);
  }
  async createPeer(remoteId,isOfferer,remoteSdp){
    const old=this.peers.get(remoteId); if(old?.pc) return;
    const { RTCPeerConnection }=this.WebRTC; const pc=new RTCPeerConnection({}); const entry={pc,dc:null,pendingIce:[...(old?.pendingIce||[])]}; this.peers.set(remoteId,entry);
    if(pc.iceConnectionStateChange?.subscribe) pc.iceConnectionStateChange.subscribe(state=>{ if(['failed','closed','disconnected'].includes(state)) this.removePeer(remoteId); });
    if(pc.onDataChannel?.subscribe) pc.onDataChannel.subscribe(dc=>this.bindDataChannel(remoteId,entry,dc));
    if(isOfferer){
      const dc=pc.createDataChannel('arena-v12'); this.bindDataChannel(remoteId,entry,dc);
      await pc.setLocalDescription(await pc.createOffer());
      this.sendSignal({type:'offer',to:remoteId,sdp:pc.localDescription});
    } else {
      await pc.setRemoteDescription(remoteSdp); await this.flushIce(entry); await pc.setLocalDescription(await pc.createAnswer());
      this.sendSignal({type:'answer',to:remoteId,sdp:pc.localDescription});
    }
  }
  async flushIce(entry){ const q=entry.pendingIce.splice(0); for(const c of q){ try{ await entry.pc.addIceCandidate(c); }catch(e){ this.log('ice reject',e.message); } } }
  bindDataChannel(remoteId,entry,dc){
    entry.dc=dc;
    const onOpen=()=>{ this.protocol.setOpenPeer(remoteId,true); this.stableSince=performance.now(); this.safeSend(remoteId,{kind:'snapshot',snapshot:this.protocol.snapshot()}); this.log('dc open',remoteId); };
    if(dc.stateChanged?.subscribe) dc.stateChanged.subscribe(v=>{ if(v==='open') onOpen(); if(v==='closed') this.removePeer(remoteId); });
    if(dc.onMessage?.subscribe) dc.onMessage.subscribe(data=>this.handleWire(remoteId,data.toString()));
    if(dc.readyState==='open') onOpen();
  }
  safeSend(remoteId,message){ const p=this.peers.get(remoteId); if(!p?.dc||p.dc.readyState!=='open') return false; try{ p.dc.send(JSON.stringify(message)); return true; }catch{return false;} }
  broadcast(message){ for(const id of this.protocol.openPeers) this.safeSend(id,message); }
  broadcastTelegraph({targetId,targetX,targetY,leadMs,pingMs}){
    this.broadcast({kind:'botTelegraph',telegraph:{protocol:PROTOCOL,botId:this.id,targetId,targetX,targetY,leadMs,pingMs,createdAt:Date.now()}});
  }
  async sendCommand(command){
    const accepted=this.protocol.acceptCommand(command); if(!accepted.ok){ this.log('self command rejected locally',accepted.reason); return false; }
    this.broadcast({kind:'command',command});
    const validators=validatorsFor(command,this.committeeSize);
    if(validators.includes(this.id)){ const receipt=this.protocol.makeReceipt(command); this.protocol.applyReceipt(receipt); this.broadcast({kind:'receipt',receipt}); }
    return true;
  }
  handleWire(remoteId,raw){
    let m; try{m=JSON.parse(raw);}catch{return;}
    if(m.kind==='snapshot'){ this.protocol.mergeSnapshot(remoteId,m.snapshot); return; }
    if(m.kind==='command'){
      const c=m.command; const a=this.protocol.acceptCommand(c); if(!a.ok){ this.log('remote command reject',remoteId,a.reason); return; }
      const validators=validatorsFor(c,this.committeeSize);
      if(validators.includes(this.id)){ const receipt=this.protocol.makeReceipt(c); this.protocol.applyReceipt(receipt); this.broadcast({kind:'receipt',receipt}); }
      return;
    }
    if(m.kind==='receipt'){ this.protocol.applyReceipt(m.receipt); return; }
  }
  removePeer(remoteId){
    const p=this.peers.get(remoteId); if(!p) return; this.peers.delete(remoteId); this.protocol.setOpenPeer(remoteId,false); this.stableSince=performance.now();
    try{p.dc?.close();}catch{} try{p.pc?.close();}catch{}
  }
  async stop(){ clearInterval(this.aiTimer); clearInterval(this.announceTimer); for(const id of [...this.peers.keys()]) this.removePeer(id); try{this.ws?.close();}catch{} await wait(20); }
}
module.exports={BotPeer};
