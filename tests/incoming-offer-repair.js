#!/usr/bin/env node
'use strict';
const fs=require('fs');
const path=require('path');
const vm=require('vm');
const root=path.resolve(__dirname,'..');
const network=fs.readFileSync(path.join(root,'js/transport/network.js'),'utf8');
const start=network.indexOf('async function createPeer(');
const end=network.indexOf('\nfunction removePeer(',start);
if(start<0||end<0) throw new Error('createPeer block not found');
const block=network.slice(start,end);
if(!block.includes('DIRECT_OFFER_REPLACE')) throw new Error('incoming half-open offer replacement log missing');
if(!block.includes("removePeer(remoteId,'incoming offer replaces non-open edge')")) throw new Error('incoming offer does not replace half-open edge');

class FakePC{
  constructor(){this.connectionState='new';this.signalingState='stable';this.remoteDescription=null;this.localDescription=null;}
  async setRemoteDescription(sdp){this.remoteDescription=sdp;this.signalingState='have-remote-offer';}
  async createAnswer(){return {type:'answer',sdp:'answer'};}
  async setLocalDescription(sdp){this.localDescription=sdp;this.signalingState='stable';}
  async addIceCandidate(){}
  createDataChannel(){return {readyState:'connecting'};}
  async createOffer(){return {type:'offer',sdp:'offer'};}
}
const old={pc:{connectionState:'connected'},dc:null,pendingIce:[{candidate:'old'}]};
const c={
  peers:new Map([['z',old]]),prePeerIce:new Map(),RTCPeerConnection:FakePC,STUN:{},performance:{now:()=>1000},
  removed:0,signals:[],pageUnloading:false,tearingDownPeers:new Set(),disconnectTimers:new Map(),AUTO_MODE:false,
  isPeerOpen:id=>c.peers.get(id)?.dc?.readyState==='open',
  signalLog:()=>{},sendSignal:m=>c.signals.push(m),updatePeerList:()=>{},refreshMembership:()=>{},markBootstrapPending:()=>{},sendSnapshot:()=>{},sendPresence:()=>{},sendNeighborDigest:()=>{},deliverWireMessage:()=>{},tickAutoMode:()=>{},log:()=>{},
  flushIce:async()=>{},
  removePeer:(id)=>{c.removed++;c.peers.delete(id);return true;},
};
vm.createContext(c);vm.runInContext(block+'\nthis.createPeerFn=createPeer;',c);
(async()=>{
  await c.createPeerFn('z',false,{type:'offer',sdp:'fresh'});
  if(c.removed!==1) throw new Error('half-open existing peer was not replaced');
  const entry=c.peers.get('z');
  if(!entry?.pc?.remoteDescription) throw new Error('fresh incoming offer was not accepted');
  if(!c.signals.some(x=>x.type==='answer'&&x.to==='z')) throw new Error('fresh incoming offer was not answered');
  console.log('PSSF incoming offer repair: PASS');
})().catch(e=>{console.error(e);process.exit(1);});
