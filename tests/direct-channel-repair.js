#!/usr/bin/env node
'use strict';
const fs=require('fs');
const path=require('path');
const vm=require('vm');
const root=path.resolve(__dirname,'..');
const network=fs.readFileSync(path.join(root,'js/transport/network.js'),'utf8');
const start=network.indexOf('function peerNeedsDirectRepair(');
const end=network.indexOf('\nasync function repairDesiredDirectMesh',start);
if(start<0||end<0) throw new Error('peerNeedsDirectRepair block not found');
const block=network.slice(start,end);
if(!network.includes('DIRECT_CHANNEL_STALE_MS')) throw new Error('DataChannel stale timeout missing');
if(!block.includes("state==='connected'&&dcState!=='open'")) throw new Error('connected-PC/dead-DataChannel repair rule missing');
let now=3001;
const c={
  desiredDirectPeers:new Set(['z']),
  peers:new Map(),
  myId:'a',
  DIRECT_CHANNEL_STALE_MS:2500,
  DIRECT_CONNECT_STALE_MS:5000,
  performance:{now:()=>now},
  peerTransport:()=> 'webrtc',
  isPeerOpen:id=>c.peers.get(id)?.dc?.readyState==='open',
};
vm.createContext(c);
vm.runInContext(block+'\nthis.needs=peerNeedsDirectRepair;',c);

c.peers.set('z',{pc:{connectionState:'connected'},dc:null,connectStartedAt:1});
if(!c.needs('z')) throw new Error('connected RTCPeerConnection with missing DataChannel was treated as healthy');
now=1001;
if(c.needs('z')) throw new Error('fresh DataChannel negotiation repaired too early');
now=3001;
c.peers.set('z',{pc:{connectionState:'connected'},dc:{readyState:'open'},connectStartedAt:1});
if(c.needs('z')) throw new Error('open DataChannel incorrectly marked for repair');
console.log('PSSF direct DataChannel repair: PASS');
