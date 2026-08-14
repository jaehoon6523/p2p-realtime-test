#!/usr/bin/env node
'use strict';
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const sim=fs.readFileSync(path.join(root,'js/game/simulation.js'),'utf8');
const state=fs.readFileSync(path.join(root,'js/core/config-state.js'),'utf8');
function must(cond,msg){ if(!cond) throw new Error(msg); }
must(state.includes('const bootstrapSentPeers = new Set()'),'missing bootstrap sent-state');
must(!state.includes('bootstrapCommandBacklog'),'obsolete ACK backlog still exists');
must(sim.includes("if(!bootstrapSentPeers.has(remoteId) && !sendSnapshot(remoteId,{bootstrap:true})) return false;"),'command sender does not enforce bootstrap-before-command ordering');
must(sim.includes("return safeDataSend(remoteId,{kind:'command',command});"),'command is still blocked by ACK');
must(!sim.includes('queueCommandUntilBootstrap'),'obsolete ACK command queue remains');
must(!sim.includes('flushBootstrapBacklog'),'obsolete ACK command flush remains');
must(sim.includes('function sendInstalledBootstrapAck(remoteId)'),'stale/retry bootstrap ACK helper missing');
must(sim.includes("if(snapshot.bootstrap) sendInstalledBootstrapAck(remoteId);"),'stale bootstrap does not ACK installed prefix');
console.log('PSSF bootstrap ordered transport: PASS');
