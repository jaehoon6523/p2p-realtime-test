'use strict';

const PROTOCOL = 13;
const SIGNAL_PROTOCOL = 5;
const RULESET_REVISION = 'pssf-v13-r16';
const params = new URLSearchParams(location.search);
const ROOM_ID = sanitizeRoomId(params.get('room') || 'default');
const SIGNAL_URL = normalizeSignalUrl((params.get('signal') || '').trim());
const AOI_RADIUS = clampNumber(params.get('aoi'), 260, 120, 1400);
const AUTO_MODE = /^(1|true|on|yes)$/i.test(params.get('auto') || '');
const AUTO_DEBUG = /^(1|true|on|yes)$/i.test(params.get('autodebug') || '');
const AUTO_FIRE_MS = clampNumber(params.get('fireMs'), 850, 250, 5000);
const AUTO_RETARGET_MS = clampNumber(params.get('retargetMs'), 700, 250, 5000);
const AUTO_WANDER_MS = clampNumber(params.get('wanderMs'), 1400, 500, 10000);

// Browser-native network emulation.
// ping = 목표 추가 RTT. 한 netem peer 경계에서 tx/rx 각각 절반씩 적용한다.
// AUTO↔AUTO는 양쪽 peer가 각각 tx 절반을 담당하므로 rx 지연을 중복 적용하지 않는다.
// loss는 ordered/reliable DataChannel의 패킷 손실을 흉내내므로 앱 메시지를 버리지 않고
// retransmission penalty + head-of-line blocking으로 모델링한다. 실제 hard drop은 drop= 으로 별도 지정.
const NETEM_DISABLED = /^(0|false|off|no)$/i.test(params.get('netem') || '');
const NETEM_PING_MS = NETEM_DISABLED ? 0 : clampNumber(params.get('ping'), AUTO_MODE ? 180 : 0, 0, 5000);
const NETEM_JITTER_MS = NETEM_DISABLED ? 0 : clampNumber(params.get('jitter'), AUTO_MODE ? 40 : 0, 0, 2000);
const NETEM_LOSS_PCT = NETEM_DISABLED ? 0 : clampNumber(params.get('loss'), AUTO_MODE ? 1.0 : 0, 0, 30);
const NETEM_DROP_PCT = NETEM_DISABLED ? 0 : clampNumber(params.get('drop'), 0, 0, 30);
const NETEM_RETRANSMIT_MS = NETEM_DISABLED ? 0 : clampNumber(params.get('retransmit'), Math.max(120, NETEM_PING_MS * 0.75), 0, 5000);
const NETEM_SPIKE_PCT = NETEM_DISABLED ? 0 : clampNumber(params.get('spike'), AUTO_MODE ? 3 : 0, 0, 50);
const NETEM_SPIKE_MS = NETEM_DISABLED ? 0 : clampNumber(params.get('spikeMs'), AUTO_MODE ? 250 : 0, 0, 5000);
const NETEM_ENABLED = [NETEM_PING_MS,NETEM_JITTER_MS,NETEM_LOSS_PCT,NETEM_DROP_PCT,NETEM_SPIKE_PCT].some(v=>v>0);

const COMMITTEE_SIZE = 3; // 실제 validator/quorum은 signaling server의 assignment가 결정한다.
const STUN = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// 모든 피어가 공유하는 논리 월드. 브라우저/canvas 크기는 렌더 viewport일 뿐 게임 경계가 아니다.
const WORLD_WIDTH = 1000;
const WORLD_HEIGHT = 760;
const WORLD_MARGIN = 14;

const TICK_MS = 1000 / 30;
const STEP_INTERVAL_MS = 90;
const BASE_MAX_STEP = 50;
const STEP_JITTER_ALLOWANCE = 1.35;
const STEP_EPSILON = 0.75;
const MAX_TICK_ADVANCE = 120;
// Partial-synchrony tolerance. Small remote clock lead is normal network uncertainty, not cheating.
const REMOTE_TICK_SOFT_AHEAD = 18;   // ~600ms at 30Hz: accept without drama
const REMOTE_TICK_HARD_AHEAD = 90;   // ~3s: request repair / fault candidate, never instant trust penalty
const TEMPORAL_DEFER_MAX_MS = 1600;
const TEMPORAL_RETRY_MIN_MS = 40;
const MAX_DEFERRED_PER_PLAYER = 256;
const MAX_LOCAL_PENDING = 32;
const MAX_LOCAL_EVENT_PENDING = 6;
const MAX_PENDING_SHOOTS = 4;
const OPTIMISTIC_REJECT_FADE_MS = 90;
const OPTIMISTIC_CONFIRM_FADE_MS = 160; // visual-only prediction; shared HP/death remains certificate-gated

// Ability data lives in js/game/ability-definitions.js and is loaded before this runtime state.
// Timing conversion is shared by local prediction and deterministic validator replay.
function abilityTicks(ms){ return Math.max(0,Math.round(ms/TICK_MS)); }
function abilityTimingFor(ability){ return {cooldownTicks:abilityTicks(ability.cooldownMs),castTicks:abilityTicks(ability.castMs),recoveryTicks:abilityTicks(ability.recoveryMs)}; }
const MAX_COMBAT_RANGE = Math.max(...Object.values(ABILITY_DEFINITIONS).filter(v=>v.kind==='shoot').map(v=>v.range));
const DASH_DISTANCE = ABILITY_DEFINITIONS.E.distance;
const SIMULATION_HISTORY_LIMIT = 512;
const FINALIZED_HISTORY_LIMIT = 512;
const MAX_RANGE = ABILITY_DEFINITIONS.Q.range; // legacy/basic attack range alias
const HIT_RADIUS = 14;
const MAX_HP = 3;
const RESPAWN_MS = 5000;
const REGEN_INTERVAL_TICKS = 30;
const BULLET_TRAIL_MS = 160;
const MOVE_SPEED = 220;
const MOVE_ACCEL = 620;
const MOVE_DECEL = 560;
const MOVE_MAX_DURATION = 5000;
const AUDIT_STALL_MS = 1200;
const DISCONNECT_GRACE_MS = 5000;
const SIGNAL_CONNECT_TIMEOUT_MS = 45000;
const SIGNAL_RECONNECT_BASE_MS = 800;
const SIGNAL_RECONNECT_MAX_MS = 15000;
const SIGNAL_KEEPALIVE_MS = 25000;
const ROOM_JOIN_TIMEOUT_MS = 12000;
const POLICY_GRACE_MS = 15000;
const PRESENCE_INTERVAL_MS = 1000;
const KDA_WINDOW_MS = 5 * 60 * 1000;
const KILL_FEED_LIMIT = 8;
const COMMIT_LATENCY_SAMPLES = 240;
const REMOTE_INTERPOLATION_MS = 115;
const REMOTE_SNAP_DISTANCE = 180;
const RELAY_INTERVAL_MS = 750;
const RELAY_TTL_MS = 2500;
const RELAY_MAX_ENTRIES = 12;
const RELAY_PREFETCH_RADIUS = Math.min(1800, AOI_RADIUS * 1.5);
const COLORS = ['#3ddc97','#f2a93b','#7aa5ff','#ef5b6e','#c77dff','#4fd6d6','#e0c341'];

const myId = AUTO_MODE ? `AUTO-${randomId(6)}` : randomId(8);
const myColor = colorFor(myId);
const roomEpoch = performance.now();

const peers = new Map();
const prePeerIce = new Map();
const disconnectTimers = new Map();
const tearingDownPeers = new Set();
const confirmedWorld = Object.create(null);
const visibleWorld = Object.create(null);
const confirmedSeq = new Map(); // simulation stream sequence
const confirmedEventSeq = new Map(); // consequential event stream sequence (shoot)
const simulationStateHistory = new Map(); // playerId -> Map(simulation seq -> state variants)
const tickAnchors = new Map();
const activityAnchors = new Map();
const moveState = Object.create(null); // local input segment only
const POSITION_TRACE_INTERVAL_MS=100;
const POSITION_TRACE_DIVERGENCE_WARN=1.5;
let lastPositionTraceAt=0;
let positionTraceSeq=0;
function fmtPos(v){ return v&&Number.isFinite(v.x)&&Number.isFinite(v.y)?`${v.x.toFixed(2)},${v.y.toFixed(2)}`:'-'; }
function posDist(a,b){ return a&&b&&[a.x,a.y,b.x,b.y].every(Number.isFinite)?Math.hypot(a.x-b.x,a.y-b.y):null; }
function fmtDist(v){ return Number.isFinite(v)?v.toFixed(3):'-'; }
function tracePosition(reason,{force=false,now=performance.now(),extra=''}={}){
    if(AUTO_MODE&&!AUTO_DEBUG) return;
    if(!force&&now-lastPositionTraceAt<POSITION_TRACE_INTERVAL_MS) return;
    lastPositionTraceAt=now;
    const render=getRenderPosition(myId);
    const predicted=getPredictedTail(myId);
    const visible=visibleWorld[myId];
    const confirmed=confirmedWorld[myId];
    const movement=moveState[myId];
    const evaluated=movement?evalMove(movement,now):null;
    const dRP=posDist(render,predicted),dPV=posDist(predicted,visible),dPC=posDist(predicted,confirmed),dRT=movement?posDist(render,{x:movement.targetX,y:movement.targetY}):null;
    // Render interpolation may intentionally lag predicted state. Only protocol-state divergence is a warning.
    const diverged=[dPV,dPC].some(v=>Number.isFinite(v)&&v>POSITION_TRACE_DIVERGENCE_WARN);
    const phase=evaluated?.phase||'-';
    const seq=++positionTraceSeq;
    const text=`[POS#${seq}] ${reason} render=${fmtPos(render)} predicted=${fmtPos(predicted)} visible=${fmtPos(visible)} confirmed=${fmtPos(confirmed)} eval=${fmtPos(evaluated)} target=${movement?`${movement.targetX.toFixed(2)},${movement.targetY.toFixed(2)}`:'-'} last=${movement?`${movement.lastX.toFixed(2)},${movement.lastY.toFixed(2)}`:'-'} dR-P=${fmtDist(dRP)} dP-V=${fmtDist(dPV)} dP-C=${fmtDist(dPC)} dR-T=${fmtDist(dRT)} seq=${predicted?.sequence??'-'} phase=${phase}${extra?` ${extra}`:''}`;
    log(diverged?'t-warn':'t-pos',text);
}
const localRenderState={fromX:null,fromY:null,toX:null,toY:null,startedAt:0,duration:1};
const remoteRenderState = Object.create(null); // remote authoritative interpolation only
const relayWorld = new Map(); // discovery-only 1.5-hop summaries; never authoritative
const seenRelayRecords = new Map();
const bullets = []; // optimistic projectile trails; never authoritative damage
const optimisticEffects = new Map(); // commandId -> {kind,status,createdAt,...}; UX/correction only
const botTelegraphs = new Map();
const bootstrapAckPeers = new Set();
const bootstrapPendingSince = new Map(); // optional server-bot prefire hints; never gameplay authority
const hitFlashes = Object.create(null);
const pendingById = new Map();
const pendingOrderByPlayer = new Map(); // simulation stream
const pendingEventOrderByPlayer = new Map(); // consequential event stream
const deferredCommands = new Map();
const temporalRetryTimers = new Map();
const finalizedEventHistory = new Map(); // simulation stream: playerId -> Map(sequence -> disposition)
const finalizedCombatEventHistory = new Map(); // event stream: playerId -> Map(eventSeq -> disposition)
const seenCommandIds = new Set();
const seenCommandFingerprintById = new Map(); // commandId -> first observed event fingerprint
const seenCommandQueue = [];
const orphanCertificates = new Map();
const policyByAssignment = new Map();
const currentPolicyByPeer = new Map();
const damageContributors = new Map();
const killEvents = new Map();
const commitLatencySamples = [];
const networkMetrics = {
    txBytes:0, rxBytes:0, txMessages:0, rxMessages:0,
    txBytesWindow:0, rxBytesWindow:0, txMessagesWindow:0, rxMessagesWindow:0,
    txRate:0, rxRate:0, txByteRate:0, rxByteRate:0,
    byKind:Object.create(null), lastCheckpointPlayers:0
};

let membershipRevision = 0;
const localAbilityReadyAt = new Map();
let localAbilityLockUntil = 0;
let localAbilitySequence = 0;
let lastLocalAbilityRef = null;
const lastLocalAbilityRefById = new Map();
const finalizedAbilityHistory = new Map(); // playerId -> Map(abilitySeq -> terminal ability record)
const pendingAbilityTerminals = new Map(); // playerId -> Map(abilitySeq -> terminal awaiting earlier abilitySeq)
const confirmedAbilitySeq = new Map();
let lastAimWorld = {x:WORLD_WIDTH/2,y:WORLD_HEIGHT/2};

let localSequence = 0; // simulation stream
let localEventSequence = 0; // consequential event stream
let confirmedCounter = 0;
let rejectedCounter = 0;
let ignoredCounter = 0;
let deferredCounter = 0;
let resyncCounter = 0;
let faultCounter = 0;
let duplicateCounter = 0;
let invalidCounter = 0;
let stalledCounter = 0;
let membershipMismatchCounter = 0;
let relayAcceptedCounter = 0;
let relayDroppedCounter = 0;
let signalingSocket = null;
let signalingGeneration = 0;
let signalReconnectAttempt = 0;
let signalReconnectTimer = null;
let signalConnectTimeout = null;
let signalKeepaliveTimer = null;
let roomJoinTimeout = null;
let roomReady = false;
let serverMembershipEpoch = null;
let serverPeerCount = 0;
let serverMembershipRoot = null;
const desiredTopologyPeers = new Set();
const desiredSimulationPeers = new Set();
const desiredDirectPeers = new Set();
let selfTopologyPolicy = null;
let signalManualClose = false;
let pageUnloading = false;
let pendingLogs = [];
const logHistory = [];
const LOG_HISTORY_LIMIT = 1000;
let activeLogFilter = 'all';
let lastMembershipLogSignature = null;

const canvas = document.getElementById('canvas');
const context = canvas.getContext('2d');
const roomGate = document.getElementById('roomGate');
const roomGateTitle = document.getElementById('roomGateTitle');
const roomGateDetail = document.getElementById('roomGateDetail');
document.getElementById('peerId').textContent = AUTO_MODE ? `${myId} · AUTO` : myId;
document.getElementById('signalRoom').textContent = ROOM_ID;
if(AUTO_MODE){
    const netemLabel=NETEM_ENABLED?`NETEM RTT~${Math.round(NETEM_PING_MS)}ms jitter±${Math.round(NETEM_JITTER_MS)} loss ${NETEM_LOSS_PCT}% spike ${NETEM_SPIKE_PCT}%`:'NETEM off';
    document.title = `AUTO ${myId} · ${ROOM_ID} · ${NETEM_ENABLED?Math.round(NETEM_PING_MS)+'ms':'clean'}`;
    const hint=document.getElementById('hint');
    if(hint) hint.textContent=`AUTO MODE · 일반 P2P peer와 동일 경로 · ${netemLabel} · ?autodebug=1 상세 로그`;
}


function currentTick(){ return Math.floor((performance.now() - roomEpoch) / TICK_MS); }
function round6(value){ return Math.round(value * 1e6) / 1e6; }
function clampNumber(value,fallback,min,max){ if(value==null||String(value).trim()==='') return fallback; const number=Number(value); return Number.isFinite(number)?Math.max(min,Math.min(max,number)):fallback; }
function randomId(length=12){
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID().replaceAll('-','').slice(0,length);
    const bytes = new Uint8Array(Math.ceil(length/2));
    crypto.getRandomValues(bytes);
    return [...bytes].map(v=>v.toString(16).padStart(2,'0')).join('').slice(0,length);
}
function colorFor(id){ return COLORS[[...id].reduce((s,c)=>s+c.charCodeAt(0),0)%COLORS.length]; }
function stableHash(value){
    const text = JSON.stringify(value); let hash = 2166136261;
    for(let i=0;i<text.length;i++){ hash ^= text.charCodeAt(i); hash = Math.imul(hash,16777619); }
    return (hash>>>0).toString(16).padStart(8,'0');
}
function stateHash(state){
    return stableHash({x:round6(state.x),y:round6(state.y),sequence:state.sequence,tick:state.tick,hp:state.hp,alive:state.alive,lifeId:state.lifeId,deadServerAt:Number(state.deadServerAt)||0});
}
function simulationRefHash(state){
    // Combat events bind to the actor's historical simulation pose/life, not mutable HP bookkeeping.
    return stableHash({x:round6(state.x),y:round6(state.y),sequence:state.sequence,tick:state.tick,alive:Boolean(state.alive),lifeId:state.lifeId});
}
function commandStream(command){ return command?.type==='shoot'?'event':'simulation'; }
function commandStreamSequence(command){ return commandStream(command)==='event'?command?.eventSeq:command?.sequence; }
function commandSequenceText(command){ return commandStream(command)==='event'?`eventSeq=${command?.eventSeq??'-'}`:`seq=${command?.sequence??'-'}`; }
function historyVariantsFor(playerId){
    let history=simulationStateHistory.get(playerId);
    if(!history){ history=new Map(); simulationStateHistory.set(playerId,history); }
    return history;
}
function rememberSimulationState(playerId,state){
    if(!playerId||!state||!Number.isSafeInteger(state.sequence)) return;
    const history=historyVariantsFor(playerId);
    const variants=history.get(state.sequence)||[];
    const hash=simulationRefHash(state);
    if(!variants.some(v=>simulationRefHash(v)===hash)) variants.push({...state,tentative:false});
    if(variants.length>4) variants.shift();
    history.set(state.sequence,variants);
    while(history.size>SIMULATION_HISTORY_LIMIT){ const oldest=history.keys().next().value; history.delete(oldest); }
}
function simulationStateCandidates(playerId,sequence){
    const result=[];
    const push=state=>{ if(!state||state.sequence!==sequence) return; const h=simulationRefHash(state); if(!result.some(v=>simulationRefHash(v)===h)) result.push(state); };
    push(confirmedWorld[playerId]);
    for(const id of pendingOrderByPlayer.get(playerId)||[]) push(pendingById.get(id)?.nextState);
    for(const state of simulationStateHistory.get(playerId)?.get(sequence)||[]) push(state);
    return result;
}
function resolveSimulationReference(playerId,ref){
    if(!ref||!Number.isSafeInteger(ref.sequence)||ref.sequence<0||typeof ref.stateHash!=='string') return {status:'invalid',state:null};
    const candidates=simulationStateCandidates(playerId,ref.sequence);
    const exact=candidates.find(state=>simulationRefHash(state)===ref.stateHash);
    if(exact) return {status:'ok',state:{...exact}};
    if(candidates.length) return {status:'mismatch',state:{...candidates[0]}};
    const maxKnown=Math.max(confirmedSeq.get(playerId)||0,...(pendingOrderByPlayer.get(playerId)||[]).map(id=>pendingById.get(id)?.command.sequence||0));
    return {status:ref.sequence>maxKnown?'pending':'missing',state:null};
}
function sanitizeRoomId(value){ return (String(value||'default').trim().slice(0,64)||'default').replace(/[^a-zA-Z0-9_.:-]/g,'_'); }
function normalizeSignalUrl(value){
    if(!value) return null;
    try{ const url=new URL(value,location.href); if(!['ws:','wss:'].includes(url.protocol)) return null; if(location.protocol==='https:'&&url.protocol!=='wss:') return null; url.hash=''; return url.toString(); }catch(_){ return null; }
}
function randomSpawnX(){ return 60 + Math.random()*Math.max(120,WORLD_WIDTH-120); }
function randomSpawnY(){ return 70 + Math.random()*Math.max(140,WORLD_HEIGHT-140); }
function clampWorldPoint(x,y){ return {x:Math.max(WORLD_MARGIN,Math.min(WORLD_WIDTH-WORLD_MARGIN,x)),y:Math.max(WORLD_MARGIN,Math.min(WORLD_HEIGHT-WORLD_MARGIN,y))}; }
function screenToWorld(clientX,clientY){
    const rect=canvas.getBoundingClientRect();
    const x=(clientX-rect.left)/Math.max(1,rect.width)*WORLD_WIDTH;
    const y=(clientY-rect.top)/Math.max(1,rect.height)*WORLD_HEIGHT;
    return clampWorldPoint(x,y);
}
function createCommandId(playerId,sequence,stream='simulation'){ return `${playerId}:${stream==='event'?'e':'s'}${sequence}:${randomId(12)}`; }
