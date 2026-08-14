#!/usr/bin/env node
'use strict';
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const sim=fs.readFileSync(path.join(root,'js/game/simulation.js'),'utf8');
if(!sim.includes('if(moveState[myId]!==movement) return')) throw new Error('missing stale movement guard');
if(!sim.includes('const MOVE_COMMAND_CHUNK = BASE_MAX_STEP * 0.85;')) throw new Error('missing conservative movement chunk limit');
if(!sim.includes('function emitMoveDeltaChunked(movement,dx,dy)')) throw new Error('missing chunked move emission');
const direct=/executeLocal\(command\);\s*movement\.sampleX=evaluated\.x/.test(sim);
if(direct) throw new Error('tickMovement still mutates stale movement after executeLocal');
console.log('PSSF movement stale-reference recovery: PASS');
