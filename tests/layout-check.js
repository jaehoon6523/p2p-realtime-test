'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
function must(rel){ const p=path.join(root,rel); if(!fs.existsSync(p)) throw new Error(`missing required path: ${rel}`); return p; }
function mustNot(rel){ const p=path.join(root,rel); if(fs.existsSync(p)) throw new Error(`unexpected compatibility-breaking path: ${rel}`); }

const hardened = must('p2p-mmo-demo-hardened.html');
must('p2p-mmo-demo-auto.html');
const launcher = must('p2p-mmo-auto-launcher.html');
must('mmo-server/signaling-server.js');
must('mmo-server/package.json');
must('README.md');
must('DEPLOY.md');

mustNot('client');
mustNot('server');

const html = fs.readFileSync(hardened,'utf8');
const refs = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map(m=>m[1]);
if(!refs.length) throw new Error('hardened entrypoint does not reference split runtime');
for(const ref of refs){ if(/^https?:/.test(ref)) continue; must(ref); }

const launchText = fs.readFileSync(launcher,'utf8');
if(!launchText.includes("const client=p.get('client')||'p2p-mmo-demo-auto.html';")) throw new Error('launcher default client path changed');

const readme = fs.readFileSync(must('README.md'),'utf8');
const demoUrl='https://jaehoon6523.github.io/p2p-realtime-test/p2p-mmo-demo-hardened.html?signal=wss://p2p-realtime-test.onrender.com&room=test1';
const renderUrl='https://dashboard.render.com/web/srv-d9pttum7bikc7383brig/env';
if(!readme.includes(demoUrl)) throw new Error('README lost public demo URL');
if(!readme.includes(renderUrl)) throw new Error('README lost Render dashboard URL');

const deploy = fs.readFileSync(must('DEPLOY.md'),'utf8');
if(!deploy.includes('Root Directory: `mmo-server`')) throw new Error('Render root directory changed');

const config = fs.readFileSync(must('js/core/config-state.js'),'utf8');
const server = fs.readFileSync(must('mmo-server/signaling-server.js'),'utf8');
for(const expected of ["const SIGNAL_PROTOCOL = 5;", "const RULESET_REVISION = 'pssf-v13-r1';"]){
  if(!config.includes(expected)) throw new Error(`client missing ${expected}`);
  if(!server.includes(expected)) throw new Error(`server missing ${expected}`);
}
console.log('PSSF layout: PASS');
