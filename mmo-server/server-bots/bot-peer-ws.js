'use strict';

const { WebSocket } = require('ws');
const { ProtocolState, PROTOCOL, RULESET_REVISION, AOI_RADIUS, round6 } = require('./bot-protocol');
const { DodgeBotAI } = require('./bot-ai');

const SIGNAL_PROTOCOL=5;
const wait=ms=>new Promise(r=>setTimeout(r,ms));

class WsBotPeer {
  constructor({id,signalUrl,room='test1',verbose=false}){
    this.id=id; this.signalUrl=signalUrl; this.room=room; this.verbose=verbose;
    this.ws=null; this.joined=false; this.desiredDirectPeers=new Set();
    this.protocol=new ProtocolState({id,aoiRadius:AOI_RADIUS}); this.ai=new DodgeBotAI(this);
    this.aiTimer=null; this.presenceTimer=null; this.keepaliveTimer=null; this.stableSince=0; this.aiEnabled=false;
    this.orphanCertificates=new Map();
  }
  log(...args){ if(this.verbose) console.log(`[${this.id}]`,...args); }
  async start(){
    await this.connectSignal();
    this.aiTimer=setInterval(()=>{ if(this.aiEnabled&&this.isStable()) this.ai.tick().catch(e=>this.log('ai',e.message)); },90);
    this.presenceTimer=setInterval(()=>this.sendPresence(),1000);
    this.keepaliveTimer=setInterval(()=>this.sendSignal({type:'keepalive'}),25000);
  }
  enableAI(){ this.aiEnabled=true; }
  isStable(){ return this.joined&&Boolean(this.protocol.selfPolicy)&&[...this.desiredDirectPeers].every(id=>this.protocol.openPeers.has(id))&&performance.now()-this.stableSince>250; }
  topologyStatus(){ return {desired:this.desiredDirectPeers.size,open:this.protocol.openPeers.size,ready:this.isStable()}; }
  async connectSignal(){
    await new Promise((resolve,reject)=>{
      const ws=new WebSocket(this.signalUrl); this.ws=ws; let settled=false;
      const timeout=setTimeout(()=>finishReject(new Error(`signaling join timeout url=${this.signalUrl}`)),12000);
      const finishReject=err=>{ if(settled)return; settled=true;clearTimeout(timeout);reject(err); };
      const finishResolve=()=>{ if(settled)return; settled=true;clearTimeout(timeout);resolve(); };
      ws.on('open',()=>ws.send(JSON.stringify({type:'join',channelId:this.room,peerId:this.id,transport:'ws-bot',signalProtocol:SIGNAL_PROTOCOL,rulesetRevision:RULESET_REVISION,aoiRadius:AOI_RADIUS})));
      ws.on('message',data=>{ let m;try{m=JSON.parse(data.toString())}catch{return;}
        if(m.type==='join-error') return finishReject(new Error(`signaling join rejected: ${m.reason||'unknown'}`));
        if(m.type==='joined'&&m.peerId===this.id){
          if(m.signalProtocol!==SIGNAL_PROTOCOL||m.rulesetRevision!==RULESET_REVISION) return finishReject(new Error('joined protocol mismatch'));
          this.joined=true; this.protocol.applyPolicyView(m); this.applyTopologyAssignment(m.selfPolicy||{}); this.sendPresence(); finishResolve(); return;
        }
        if(!this.joined) return;
        this.handleSignal(m);
      });
      ws.on('error',finishReject);
      ws.on('close',(code,reason)=>{this.joined=false;if(!settled)finishReject(new Error(`signaling closed before join code=${code} reason=${reason||''}`));});
    });
  }
  sendSignal(message){ if(!this.joined||this.ws?.readyState!==WebSocket.OPEN)return false; try{this.ws.send(JSON.stringify({...message,from:this.id,signalProtocol:SIGNAL_PROTOCOL}));return true;}catch{return false;} }
  sendPresence(){ const me=this.protocol.predictedTail(this.id)||this.protocol.confirmedWorld[this.id]; if(me)this.sendSignal({type:'presence',x:round6(me.x),y:round6(me.y),aoiRadius:AOI_RADIUS}); }
  handleSignal(message){
    if(!message)return;
    if(message.type==='topology-update'){
      if(message.peerId!==this.id||message.signalProtocol!==SIGNAL_PROTOCOL)return;
      this.protocol.applyPolicyView(message); this.applyTopologyAssignment(message.selfPolicy||{}); return;
    }
    if(message.type==='verification-certificate'){
      if(!this.protocol.applyCertificate(message))this.orphanCertificates.set(message.commandId,message); return;
    }
    if(message.type==='wire'&&typeof message.from==='string'&&message.to===this.id&&message.wire){ this.handleWire(message.from,message.wire); return; }
  }
  applyTopologyAssignment(policy){
    const next=new Set((Array.isArray(policy?.directPeers)?policy.directPeers:[]).filter(id=>typeof id==='string'&&id!==this.id).slice(0,24));
    for(const id of this.desiredDirectPeers) if(!next.has(id))this.protocol.setOpenPeer(id,false);
    this.desiredDirectPeers=next;
    for(const id of next)this.protocol.setOpenPeer(id,true);
    this.stableSince=performance.now();
    for(const id of next)this.safeSend(id,{kind:'snapshot',snapshot:this.protocol.snapshot()});
  }
  safeSend(remoteId,message){ if(!this.protocol.openPeers.has(remoteId))return false; return this.sendSignal({type:'wire',to:remoteId,wire:message}); }
  broadcastToPolicy(message,command=null){ const ids=command?(this.protocol.policyForCommand(command)?.directPeers||[]):[...this.protocol.openPeers]; for(const id of ids)if(this.protocol.openPeers.has(id))this.safeSend(id,message); }
  broadcastTelegraph({targetId,targetX,targetY,leadMs,pingMs}){ this.broadcastToPolicy({kind:'botTelegraph',telegraph:{protocol:PROTOCOL,botId:this.id,targetId,targetX,targetY,leadMs,pingMs,createdAt:Date.now()}}); }
  maybeSendReceipt(command){ if(!this.protocol.validatorsFor(command).includes(this.id))return; this.sendSignal({type:'verification-receipt',receipt:this.protocol.makeVerificationReceipt(command)}); }
  async sendCommand(command){
    if(!command)return false; const accepted=this.protocol.acceptCommand(command,this.id); if(!accepted.ok){this.log('self command reject',accepted.reason);return false;}
    this.broadcastToPolicy({kind:'command',command},command); if(command.type!=='move')this.maybeSendReceipt(command);
    const orphan=this.orphanCertificates.get(command.commandId);if(orphan){this.orphanCertificates.delete(command.commandId);this.protocol.applyCertificate(orphan);} this.sendPresence();return true;
  }
  handleWire(remoteId,m){
    if(!m||typeof m!=='object')return;
    if(m.kind==='snapshot'){this.protocol.mergeSnapshot(remoteId,m.snapshot);return;}
    if(m.kind==='command'){
      const c=m.command,result=this.protocol.acceptCommand(c,remoteId); if(!result.ok&&!result.deferred){this.log('remote command reject',remoteId,result.reason);return;}
      if(result.ok&&c.type!=='move')this.maybeSendReceipt(c);
      const orphan=this.orphanCertificates.get(c.commandId);if(orphan){this.orphanCertificates.delete(c.commandId);this.protocol.applyCertificate(orphan);} return;
    }
  }
  async stop(){ clearInterval(this.aiTimer);clearInterval(this.presenceTimer);clearInterval(this.keepaliveTimer);this.aiEnabled=false;try{this.sendSignal({type:'leave'});}catch{}try{this.ws?.close();}catch{}await wait(20); }
}
module.exports={BotPeer:WsBotPeer};
