#!/usr/bin/env node
'use strict';
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const sim=fs.readFileSync(path.join(root,'js/game/simulation.js'),'utf8');
if(!sim.includes('if(moveState[myId]!==movement)')) throw new Error('movement replacement guard missing');
if(!sim.includes('const MOVE_COMMAND_CHUNK = BASE_MAX_STEP * 0.85;')) throw new Error('conservative movement chunk limit missing');
if(sim.includes('movement.sampleX')||sim.includes('movement.sampleY')) throw new Error('stale sample cursor returned');
console.log('PSSF movement stale-reference recovery: PASS');
