'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { performance } = require('perf_hooks');
const { webcrypto } = require('crypto');

function classList(){ return { add(){}, remove(){}, toggle(){}, contains(){ return false; } }; }
function makeElement(id=''){
  return {
    id,
    textContent:'', innerHTML:'', className:'', style:{}, dataset:{}, classList:classList(),
    clientWidth:1000, clientHeight:760, width:1000, height:760,
    scrollHeight:0, scrollTop:0,
    append(){}, appendChild(){}, remove(){}, setAttribute(){},
    querySelectorAll(){ return []; }, addEventListener(){},
    getBoundingClientRect(){ return {left:0,top:0,width:1000,height:760}; },
  };
}

const elements = new Map();
const canvas = makeElement('canvas');
canvas.getContext = () => ({
  setTransform(){}, clearRect(){}, beginPath(){}, arc(){}, stroke(){}, fill(){}, fillRect(){},
  moveTo(){}, lineTo(){}, setLineDash(){}, save(){}, restore(){}, fillText(){},
});
elements.set('canvas', canvas);

const document = {
  title:'', body:makeElement('body'),
  getElementById(id){ if(!elements.has(id)) elements.set(id, makeElement(id)); return elements.get(id); },
  querySelectorAll(){ return []; },
  createElement(tag){ return makeElement(tag); },
  createTextNode(text){ return {textContent:String(text)}; },
  createDocumentFragment(){ return makeElement('fragment'); },
};

const context = {
  console,
  document,
  location:{ search:'?room=test1', href:'http://localhost/p2p-mmo-demo-hardened.html?room=test1', pathname:'/p2p-mmo-demo-hardened.html', protocol:'http:' },
  URL, URLSearchParams, TextEncoder,
  performance, crypto:webcrypto,
  Math, Date, Map, Set, Object, Array, Number, String, Boolean, JSON, RegExp,
  setTimeout, clearTimeout, setInterval, clearInterval,
  requestAnimationFrame(){ return 1; },
  devicePixelRatio:1,
  getComputedStyle(){ return {getPropertyValue(){ return '#777'; }}; },
};
context.window = context;
context.window.addEventListener = () => {};
context.WebSocket = class { static CONNECTING=0; static OPEN=1; constructor(){ this.readyState=3; } close(){} send(){} };
context.RTCPeerConnection = class {};
vm.createContext(context);

const root = path.join(__dirname, '..', 'js');
for (const file of [
  'core/config-state.js',
  'core/membership-topology.js',
  'game/ruleset.js',
  'core/pssf-kernel.js',
  'game/simulation.js',
  'testing/netem.js',
  'transport/network.js',
  'ui/input.js',
  'testing/auto-brain.js',
  'ui/runtime-ui.js',
]) {
  vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'), context, {filename:file});
}

vm.runInContext(`
  initializePlayer(myId, 100, 100, myColor);
  queueLocalRenderTarget(visibleWorld[myId], {snap:true});
  refreshMembership('smoke');
  if (!confirmedWorld[myId]) throw new Error('state split failed');
  if (typeof evaluateCommand !== 'function' || typeof startMove !== 'function' || typeof handleSignalMessage !== 'function') throw new Error('symbol split failed');

  const prev={...confirmedWorld[myId]};
  const cmd={
    protocol:PROTOCOL,rulesetRevision:RULESET_REVISION,type:'move',commandId:'future',
    playerId:myId,sequence:1,previousStateHash:stateHash(prev),tick:currentTick()+10000,
    topologyEpoch:0,assignmentId:'none',aoiRadius:AOI_RADIUS,
    dx:1,dy:0,claimedX:101,claimedY:100
  };
  pendingById.set(cmd.commandId,{command:cmd,previousState:prev});
  const verdict=evaluateCommand(cmd);
  pendingById.delete(cmd.commandId);
  if (verdict.accepted || !String(verdict.reason).includes('future local tick')) throw new Error('tick guard failed');

  const before=invalidCounter;
  handleSignalMessage({type:'verification-certificate',from:'evil'});
  if (invalidCounter !== before+1) throw new Error('server-only guard failed');
`, context, {filename:'smoke-assertions.js'});

const server = fs.readFileSync(path.join(__dirname,'..','mmo-server','signaling-server.js'),'utf8');
if (!server.includes("PEER_RELAY_TYPES = new Set(['offer', 'answer', 'ice', 'wire'])")) throw new Error('server allowlist missing');
if (!server.includes('if (!PEER_RELAY_TYPES.has(message.type))')) throw new Error('server allowlist unused');

console.log('PSSF smoke: PASS');
