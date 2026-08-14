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
must('RESEARCH_REFERENCES.md');

mustNot('client');
mustNot('server');

const html = fs.readFileSync(hardened,'utf8');
const refs = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map(m=>m[1].split('?')[0]);
if(!refs.length) throw new Error('hardened entrypoint does not reference split runtime');
for(const ref of refs){ if(/^https?:/.test(ref)) continue; must(ref); }
for(const rel of [
  'js/game/ability-definitions.js','js/core/command-factory.js','js/core/disposition.js','js/core/event-stream.js','js/core/verification.js'
]) if(!refs.includes(rel)) throw new Error(`hardened entrypoint missing split module: ${rel}`);
if(refs.includes('js/core/pssf-kernel.js')) throw new Error('legacy pssf-kernel.js reference remained');

for(const id of ['ignoredStat','deferredStat','resyncStat','faultStat','stalledCurrentStat']){
  if(!html.includes(`id="${id}"`)) throw new Error(`hardened entrypoint missing protocol disposition UI: ${id}`);
}

if(!html.includes('<details class="runtimeDiagnostics">')) throw new Error('runtime diagnostics is not collapsed');
if(html.includes('identity trust')) throw new Error('obsolete identity trust row remained in runtime panel');


const launchText = fs.readFileSync(launcher,'utf8');
if(!launchText.includes("const client=p.get('client')||'p2p-mmo-demo-auto.html';")) throw new Error('launcher default client path changed');

const readme = fs.readFileSync(must('README.md'),'utf8');
const demoUrl='https://jaehoon6523.github.io/p2p-realtime-test/p2p-mmo-demo-hardened.html?signal=wss://p2p-realtime-test.onrender.com&room=test1';
const renderUrl='https://dashboard.render.com/web/srv-d9pttum7bikc7383brig/env';
if(!readme.includes(demoUrl)) throw new Error('README lost public demo URL');
if(!readme.includes(renderUrl)) throw new Error('README lost Render dashboard URL');

if(/wss:\/\/HOST|localhost|127\.0\.0\.1/.test(readme)) throw new Error('README contains placeholder/local host address');
for(const url of [
  'https://jaehoon6523.github.io/p2p-realtime-test/p2p-mmo-demo-auto.html?signal=wss://p2p-realtime-test.onrender.com&room=test1&auto=1',
  'https://jaehoon6523.github.io/p2p-realtime-test/p2p-mmo-auto-launcher.html?signal=wss://p2p-realtime-test.onrender.com&room=test1&count=3'
]) if(!readme.includes(url)) throw new Error(`README lost public runtime URL: ${url}`);

const deploy = fs.readFileSync(must('DEPLOY.md'),'utf8');
if(!deploy.includes('Root Directory: `mmo-server`')) throw new Error('Render root directory changed');



const factory = fs.readFileSync(must('js/core/command-factory.js'),'utf8');
if(!factory.includes('eventSeq')) throw new Error('shoot event sequence missing');
if(!factory.includes('simulationRef:{sequence:shooter.sequence,stateHash:simulationRefHash(shooter)}')) throw new Error('shoot simulation reference missing');
const eventStream = fs.readFileSync(must('js/core/event-stream.js'),'utf8');
if(!eventStream.includes('function drainEventCommits')) throw new Error('independent event finality stream missing');

if(factory.includes("hasPendingType(myId,'shoot')")) throw new Error('single pending shoot gate returned');
if(!factory.includes('pendingShootCount(myId)')) throw new Error('shoot-specific pending backpressure missing');
if(!factory.includes("SHOOT_SUPPRESSED code=${code}")) throw new Error('shoot suppression telemetry missing');
const autoBrain = fs.readFileSync(must('js/testing/auto-brain.js'),'utf8');
if(autoBrain.includes("hasPendingType(myId,'shoot')")) throw new Error('AUTO still blocks on any pending shoot');
if(!autoBrain.includes('const ability=ABILITY_DEFINITIONS.Q;')) throw new Error('AUTO Q-only attack path missing');
if(autoBrain.includes('ABILITY_DEFINITIONS.W') || autoBrain.includes('makeDashCommand(')) throw new Error('AUTO must not use W/E abilities');

const bootstrap = fs.readFileSync(must('js/core/bootstrap.js'),'utf8');
if(!bootstrap.includes('requestAnimationFrame(draw);')) throw new Error('render loop bootstrap missing');

const abilityData = fs.readFileSync(must('js/game/ability-definitions.js'),'utf8');
const config = fs.readFileSync(must('js/core/config-state.js'),'utf8');
const server = fs.readFileSync(must('mmo-server/signaling-server.js'),'utf8');
if(!config.includes('const MAX_PENDING_SHOOTS = 4;')) throw new Error('shoot concurrency cap missing');
for(const expected of ["const SIGNAL_PROTOCOL = 5;", "const RULESET_REVISION = 'pssf-v13-r29';"]){
  if(!config.includes(expected)) throw new Error(`client missing ${expected}`);
  if(!server.includes(expected)) throw new Error(`server missing ${expected}`);
}
if(!abilityData.includes("Q:Object.freeze({id:'basic_attack',key:'Q',kind:'shoot',cooldownMs:500,castMs:0,recoveryMs:200,range:230})")) throw new Error('Q instant ability data missing');
if(!abilityData.includes("W:Object.freeze({id:'long_shot',key:'W',kind:'shoot',cooldownMs:2000,castMs:200,recoveryMs:200,range:460})")) throw new Error('W ability data missing');
if(!abilityData.includes("E:Object.freeze({id:'dash',key:'E',kind:'dash',cooldownMs:3000,castMs:200,recoveryMs:200,distance:150})")) throw new Error('E ability data missing');
if(config.includes('const ABILITY_DEFINITIONS')) throw new Error('ability data duplicated in config-state');
if(!readme.includes('js/game/ability-definitions.js')) throw new Error('README missing canonical ability data location');
const input = fs.readFileSync(must('js/ui/input.js'),'utf8');
if(input.includes("canvas.addEventListener('click'")) throw new Error('left click attack handler still present');
if(!input.includes('function tryCastAbility(key')) throw new Error('Q/W/E ability input missing');
console.log('PSSF layout: PASS');


// r13 AUTO runtime contract
const simulationText = fs.readFileSync(path.join(root,'js/game/simulation.js'),'utf8');
if(!autoBrain.includes("tryCastAbility('Q',{aimPoint,source:'AUTO'})")) throw new Error('AUTO must use shared Q ability gate');
if(autoBrain.includes('ABILITY_DEFINITIONS.W') || autoBrain.includes('makeDashCommand(')) throw new Error('AUTO must not select W/E');
if(autoBrain.includes('makeShootCommand(')) throw new Error('AUTO must not bypass ability gate with direct shoot command');
if(!input.includes("source='INPUT'")) throw new Error('shared ability gate source marker missing');
if(bootstrap.includes('setInterval(tickAutoMode')) throw new Error('AUTO must not use detached timer lifecycle');
if(!simulationText.includes('if(AUTO_MODE) tickAutoMode();')) throw new Error('AUTO must run from combat lifecycle');

// r21: active retarget + ordered bootstrap transport
{
 const sim=fs.readFileSync(path.join(root,'js/game/simulation.js'),'utf8');
 if(sim.includes('queueCommandUntilBootstrap')) throw new Error('r21: ACK backlog must be removed');
 if(sim.includes('const previousSample=evalMove(previous,now);')) throw new Error('r26: retarget must not evaluate/brake the old destination');
 if(!sim.includes('writeLocalMoveVelocity(velocity.vx,velocity.vy,now);')) throw new Error('r26: retarget must preserve exact persistent velocity');
 const cfg=fs.readFileSync(path.join(root,'js/core/config-state.js'),'utf8');
 if(!cfg.includes('const localMoveVelocity')) throw new Error('r24: persistent local velocity state missing');
}
