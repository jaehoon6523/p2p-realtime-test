#!/usr/bin/env node
'use strict';
const fs=require('fs');
const path=require('path');
const vm=require('vm');
const root=path.resolve(__dirname,'..');
const cfg=fs.readFileSync(path.join(root,'js/core/config-state.js'),'utf8');
const disp=fs.readFileSync(path.join(root,'js/core/disposition.js'),'utf8');

for(const name of ['prefixRepairState','rebaseRequestState']){
  if(!new RegExp(`const\\s+${name}\\s*=\\s*new Map\\(\\)`).test(cfg)) throw new Error(`${name} is used by disposition.js but not declared in config-state.js`);
}

function extractFunction(name){
  const start=disp.indexOf(`function ${name}(`);
  if(start<0) throw new Error(`${name} not found`);
  let i=disp.indexOf('{',start), depth=0;
  for(;i<disp.length;i++){
    if(disp[i]==='{') depth++;
    else if(disp[i]==='}') { depth--; if(depth===0){ i++; break; } }
  }
  return disp.slice(start,i);
}

const c={
  confirmedWorld:Object.create(null), confirmedEventSeq:new Map(),
  prefixRepairState:new Map(), rebaseRequestState:new Map(),
  performance:{now:()=>1234},
  stateHash:s=>`hash-${s.sequence}`,
};
c.confirmedWorld.peer={sequence:7};
vm.createContext(c);
vm.runInContext([
  extractFunction('prefixRepairSignature'),
  extractFunction('noteAppliedPrefixRepair'),
  extractFunction('notePrefixMismatch'),
  'this.noteAppliedPrefixRepair=noteAppliedPrefixRepair;',
  'this.notePrefixMismatch=notePrefixMismatch;'
].join('\n'),c);

c.noteAppliedPrefixRepair('peer');
const installed=c.prefixRepairState.get('peer');
if(!installed||installed.signature!=='7:hash-7:e0') throw new Error('installed prefix repair state not recorded');
const mismatch=c.notePrefixMismatch('peer',8);
if(!mismatch||mismatch.failures!==1||mismatch.conflictSequence!==8) throw new Error('prefix mismatch state not recorded');

// Catch this class of browser-only failure generically: any shared *State Map used via
// get/set/has/delete/clear must have an actual declaration somewhere in the loaded JS set.
const jsRoot=path.join(root,'js');
const jsFiles=[];
(function walk(dir){ for(const ent of fs.readdirSync(dir,{withFileTypes:true})){ const full=path.join(dir,ent.name); if(ent.isDirectory()) walk(full); else if(ent.isFile()&&ent.name.endsWith('.js')) jsFiles.push(full); } })(jsRoot);
const allJs=jsFiles.map(f=>fs.readFileSync(f,'utf8')).join('\n');
const stateReceivers=new Set([...allJs.matchAll(/\b([A-Za-z_$][\w$]*State)\.(?:get|set|has|delete|clear)\s*\(/g)].map(m=>m[1]));
for(const name of stateReceivers){
  if(!new RegExp(`\\b(?:const|let|var)\\s+${name}\\b`).test(allJs)) throw new Error(`shared runtime state ${name} is used but never declared`);
}

console.log('PSSF runtime state contract: PASS');
