#!/usr/bin/env node
'use strict';
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const rev='pssf-v13-r24';
for(const name of ['p2p-mmo-demo-hardened.html','p2p-mmo-demo-auto.html']){
  const html=fs.readFileSync(path.join(root,name),'utf8');
  const scripts=[...html.matchAll(/<script src="([^"]+\.js\?v=[^"]+)"><\/script>/g)].map(m=>m[1]);
  if(scripts.length<10) throw new Error(`${name}: version-pinned scripts missing`);
  for(const src of scripts){ if(!src.endsWith(`?v=${rev}`)) throw new Error(`${name}: unpinned script ${src}`); }
  if(!html.includes(`window.PSSF_PAGE_BUILD='${rev}'`)) throw new Error(`${name}: page build marker missing`);
}
const launcher=fs.readFileSync(path.join(root,'p2p-mmo-auto-launcher.html'),'utf8');
if(!launcher.includes(`const build='${rev}'`)) throw new Error('launcher build marker missing');
if(!launcher.includes('&build=${encodeURIComponent(build)}')) throw new Error('launcher child build query missing');
console.log('PSSF asset version pin: PASS');
