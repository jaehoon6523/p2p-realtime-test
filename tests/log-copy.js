#!/usr/bin/env node
'use strict';
const fs=require('fs'),path=require('path');
const root=path.join(__dirname,'..');
for(const name of ['p2p-mmo-demo-hardened.html','p2p-mmo-demo-auto.html']){
  const html=fs.readFileSync(path.join(root,name),'utf8');
  if(!html.includes('id="copyLogsBtn"')||!html.includes('copyLogsToClipboard()')) throw new Error(`${name}: log copy button missing`);
}
const ui=fs.readFileSync(path.join(root,'js','ui','runtime-ui.js'),'utf8');
if(!ui.includes('async function copyLogsToClipboard()')) throw new Error('copyLogsToClipboard missing');
if(!ui.includes('const snapshot=[...logHistory,...pendingLogs]')) throw new Error('copy must include all logs, not only current filter');
if(!ui.includes('navigator.clipboard?.writeText')) throw new Error('clipboard API path missing');
if(!ui.includes("document.execCommand('copy')")) throw new Error('clipboard fallback missing');
console.log('PSSF log clipboard copy: PASS');
