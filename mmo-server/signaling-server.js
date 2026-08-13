'use strict';

const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT) || 8090;
const SIGNAL_PROTOCOL = 5;
const RULESET_REVISION = 'pssf-v13-r4';
const MAX_ROOM_LENGTH = 96;
const MAX_PEER_LENGTH = 96;
const MAX_PAYLOAD = 128 * 1024;
const BASE_RING_OFFSETS = [1, -1, 2, -2];
const MAX_BASE_DEGREE = 5;       // ring 4 + persistent skip 1
const MAX_SIM_DEGREE = 16;       // AOI simulation links, bounded
const MAX_DIRECT_DEGREE = MAX_BASE_DEGREE + MAX_SIM_DEGREE;
const DEFAULT_AOI = 260;
const MIN_AOI = 120;
const MAX_AOI = 1400;
const SPATIAL_CELL = 240;
const SPATIAL_CANDIDATE_CAP = 48;
const POLICY_GRACE_MS = 15_000;
const RECEIPT_TTL_MS = 10_000;
const TOPOLOGY_RECOMPUTE_DELAY_MS = 120;
const DEFAULT_COMMITTEE = 3;
const PEER_RELAY_TYPES = new Set(['offer', 'answer', 'ice', 'wire']);

/** @type {Map<string, any>} */
const rooms = new Map();

function normalizeId(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().replace(/[^a-zA-Z0-9._:-]/g, '_');
  return normalized.slice(0, MAX_ROOM_LENGTH) || fallback;
}
function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
function stableHash(value) {
  const text = JSON.stringify(value); let hash = 2166136261;
  for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
function safeSend(socket, message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try { socket.send(JSON.stringify(message)); return true; } catch { return false; }
}
function arraysEqual(a = [], b = []) { return a.length === b.length && a.every((v, i) => v === b[i]); }
function sortedSet(set) { return [...set].sort(); }
function pairKey(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}`; }
function edgeAdd(graph, a, b, cap = Infinity) {
  if (!a || !b || a === b) return false;
  const ga = graph.get(a), gb = graph.get(b); if (!ga || !gb) return false;
  if (ga.has(b)) return true;
  if (ga.size >= cap || gb.size >= cap) return false;
  ga.add(b); gb.add(a); return true;
}
function makeRoom(channelId) {
  return {
    channelId,
    peers: new Map(), // peerId -> {socket,aoiRadius,presence,topologyEpoch,policy}
    membershipEpoch: 0,
    skipPartner: new Map(),
    viewHashes: new Map(),
    policyHistory: new Map(),
    receiptBuckets: new Map(),
    recomputeTimer: null,
  };
}
function ensureRoom(channelId) { let room = rooms.get(channelId); if (!room) { room = makeRoom(channelId); rooms.set(channelId, room); } return room; }
function membershipInfo(room) {
  const ids = [...room.peers.keys()].sort();
  return { channelId: room.channelId, peerCount: ids.length, membershipEpoch: `${room.channelId}:m${room.membershipEpoch}`, membershipRoot: stableHash(ids) };
}
function isRingNeighbor(ids, a, b) {
  const ia = ids.indexOf(a), ib = ids.indexOf(b); if (ia < 0 || ib < 0 || ids.length <= 1) return false;
  const n = ids.length;
  return BASE_RING_OFFSETS.some(off => ids[(ia + off + n) % n] === b);
}
function ensureSkipLinks(room) {
  const ids = [...room.peers.keys()].sort();
  for (const [a, b] of [...room.skipPartner]) {
    if (!room.peers.has(a) || !room.peers.has(b) || room.skipPartner.get(b) !== a) {
      room.skipPartner.delete(a); if (room.skipPartner.get(b) === a) room.skipPartner.delete(b);
    }
  }
  const unpaired = ids.filter(id => !room.skipPartner.has(id));
  while (unpaired.length >= 2) {
    const a = unpaired.shift();
    let bestIndex = -1, bestScore = '';
    for (let i = 0; i < unpaired.length; i++) {
      const b = unpaired[i]; if (isRingNeighbor(ids, a, b)) continue;
      const score = stableHash(`${room.channelId}:skip:${a}:${b}`);
      if (bestIndex < 0 || score > bestScore) { bestIndex = i; bestScore = score; }
    }
    if (bestIndex < 0) bestIndex = unpaired.length - 1;
    const b = unpaired.splice(bestIndex, 1)[0];
    room.skipPartner.set(a, b); room.skipPartner.set(b, a);
  }
}
function buildBaseGraph(room) {
  const ids = [...room.peers.keys()].sort();
  const graph = new Map(ids.map(id => [id, new Set()]));
  const n = ids.length;
  for (let i = 0; i < n; i++) for (const off of BASE_RING_OFFSETS) edgeAdd(graph, ids[i], ids[(i + off + n) % n], MAX_BASE_DEGREE);
  ensureSkipLinks(room);
  for (const [a, b] of room.skipPartner) if (a < b) edgeAdd(graph, a, b, MAX_BASE_DEGREE);
  return graph;
}
function buildSpatialGraph(room) {
  const ids = [...room.peers.keys()].sort();
  const graph = new Map(ids.map(id => [id, new Set()]));
  const cells = new Map();
  const cellKey = (cx, cy) => `${cx},${cy}`;
  for (const id of ids) {
    const p = room.peers.get(id)?.presence; if (!p) continue;
    const cx = Math.floor(p.x / SPATIAL_CELL), cy = Math.floor(p.y / SPATIAL_CELL);
    const key = cellKey(cx, cy); const arr = cells.get(key) || []; arr.push(id); cells.set(key, arr);
  }
  const pairCandidates = new Map();
  for (const id of ids) {
    const peer = room.peers.get(id); const p = peer?.presence; if (!p) continue;
    const radius = clampNumber(peer.aoiRadius, DEFAULT_AOI, MIN_AOI, MAX_AOI);
    const maxCellRadius = Math.ceil(radius / SPATIAL_CELL);
    const cx = Math.floor(p.x / SPATIAL_CELL), cy = Math.floor(p.y / SPATIAL_CELL);
    const candidates = [];
    for (let ring = 0; ring <= maxCellRadius && candidates.length < SPATIAL_CANDIDATE_CAP; ring++) {
      for (let dx = -ring; dx <= ring; dx++) for (let dy = -ring; dy <= ring; dy++) {
        if (ring > 0 && Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        for (const otherId of cells.get(cellKey(cx + dx, cy + dy)) || []) {
          if (otherId === id) continue;
          const op = room.peers.get(otherId)?.presence; if (!op) continue;
          const otherRadius = clampNumber(room.peers.get(otherId)?.aoiRadius, DEFAULT_AOI, MIN_AOI, MAX_AOI);
          const d = Math.hypot(op.x - p.x, op.y - p.y);
          if (d <= Math.max(radius, otherRadius)) candidates.push({ otherId, d });
        }
      }
    }
    candidates.sort((a, b) => a.d - b.d || a.otherId.localeCompare(b.otherId));
    for (const c of candidates.slice(0, SPATIAL_CANDIDATE_CAP)) {
      const key = pairKey(id, c.otherId); const old = pairCandidates.get(key);
      if (!old || c.d < old.d) pairCandidates.set(key, { a: id < c.otherId ? id : c.otherId, b: id < c.otherId ? c.otherId : id, d: c.d });
    }
  }
  const ordered = [...pairCandidates.values()].sort((a, b) => a.d - b.d || a.a.localeCompare(b.a) || a.b.localeCompare(b.b));
  for (const edge of ordered) edgeAdd(graph, edge.a, edge.b, MAX_SIM_DEGREE);
  return graph;
}
function chooseValidators(actorId, topologyPeers) {
  const candidates = [...topologyPeers].filter(id => id !== actorId);
  candidates.sort((a, b) => stableHash(`${actorId}:validator:${a}`).localeCompare(stableHash(`${actorId}:validator:${b}`)));
  return candidates.slice(0, Math.min(DEFAULT_COMMITTEE, candidates.length));
}
function policyPayload(policy) {
  if (!policy) return null;
  return {
    peerId: policy.peerId, topologyEpoch: policy.topologyEpoch, assignmentId: policy.assignmentId,
    transport: policy.transport || 'webrtc',
    topologyPeers: policy.topologyPeers, simulationPeers: policy.simulationPeers, directPeers: policy.directPeers,
    validatorIds: policy.validatorIds, quorum: policy.quorum, rulesetRevision: RULESET_REVISION,
  };
}
function storePolicyHistory(room, policy) {
  if (!policy) return;
  room.policyHistory.set(policy.assignmentId, { ...policy, expiresAt: Date.now() + POLICY_GRACE_MS });
}
function pruneRoom(room) {
  const now = Date.now();
  for (const [id, p] of room.policyHistory) if (p.expiresAt <= now && room.peers.get(p.peerId)?.policy?.assignmentId !== id) room.policyHistory.delete(id);
  for (const [id, b] of room.receiptBuckets) if (b.expiresAt <= now) room.receiptBuckets.delete(id);
}
function computePolicies(room) {
  const base = buildBaseGraph(room), sim = buildSpatialGraph(room);
  const policies = new Map();
  for (const [peerId, rec] of room.peers) {
    const topologyPeers = sortedSet(base.get(peerId) || new Set());
    const simulationPeers = sortedSet(sim.get(peerId) || new Set()).filter(id => !topologyPeers.includes(id));
    const directPeers = [...new Set([...topologyPeers, ...simulationPeers])].sort().slice(0, MAX_DIRECT_DEGREE);
    const validatorIds = chooseValidators(peerId, topologyPeers.length ? topologyPeers : directPeers);
    const old = rec.policy;
    const transport = rec.transport || 'webrtc';
    const changed = !old || old.transport !== transport || !arraysEqual(old.topologyPeers, topologyPeers) || !arraysEqual(old.simulationPeers, simulationPeers) || !arraysEqual(old.directPeers, directPeers) || !arraysEqual(old.validatorIds, validatorIds);
    const topologyEpoch = changed ? (rec.topologyEpoch || 0) + 1 : old.topologyEpoch;
    const assignmentId = changed ? stableHash({ room: room.channelId, peerId, topologyEpoch, transport, topologyPeers, simulationPeers, validatorIds, rulesetRevision: RULESET_REVISION }) : old.assignmentId;
    const policy = { peerId, topologyEpoch, assignmentId, transport, topologyPeers, simulationPeers, directPeers, validatorIds, quorum: validatorIds.length ? Math.floor(validatorIds.length / 2) + 1 : 0 };
    if (changed && old) storePolicyHistory(room, old);
    rec.topologyEpoch = topologyEpoch; rec.policy = policy; policies.set(peerId, policy); storePolicyHistory(room, policy);
  }
  return policies;
}
function buildPeerView(room, peerId) {
  const info = membershipInfo(room); const self = room.peers.get(peerId)?.policy; if (!self) return null;
  const peerPolicies = self.directPeers.map(id => policyPayload(room.peers.get(id)?.policy)).filter(Boolean);
  return { signalProtocol: SIGNAL_PROTOCOL, ...info, peerId, selfPolicy: policyPayload(self), peerPolicies };
}
function recomputeRoom(room, reason = 'topology', suppressPeerId = null) {
  pruneRoom(room); computePolicies(room);
  const changedViews = [];
  for (const [peerId, rec] of room.peers) {
    const view = buildPeerView(room, peerId); if (!view) continue;
    const viewHash = stableHash({ selfPolicy: view.selfPolicy, peerPolicies: view.peerPolicies });
    if (room.viewHashes.get(peerId) !== viewHash) { room.viewHashes.set(peerId, viewHash); changedViews.push({ rec, view }); }
  }
  for (const { rec, view } of changedViews) if (view.peerId !== suppressPeerId) safeSend(rec.socket, { type: 'topology-update', ...view, reason });
  return changedViews.length;
}
function scheduleRecompute(room, reason = 'presence') {
  if (room.recomputeTimer) return;
  room.recomputeTimer = setTimeout(() => { room.recomputeTimer = null; recomputeRoom(room, reason); }, TOPOLOGY_RECOMPUTE_DELAY_MS);
}
function unregister(socket, reason = 'disconnect') {
  const session = socket.session; if (!session) return;
  socket.session = null;
  const room = rooms.get(session.channelId); if (!room) return;
  const rec = room.peers.get(session.peerId); if (!rec || rec.socket !== socket) return;
  const partner = room.skipPartner.get(session.peerId); room.skipPartner.delete(session.peerId); if (partner && room.skipPartner.get(partner) === session.peerId) room.skipPartner.delete(partner);
  room.peers.delete(session.peerId); room.viewHashes.delete(session.peerId); room.membershipEpoch++;
  if (room.peers.size === 0) { clearTimeout(room.recomputeTimer); rooms.delete(session.channelId); return; }
  recomputeRoom(room, reason);
}
function policyByAssignment(room, actorId, assignmentId) {
  const current = room.peers.get(actorId)?.policy;
  if (current?.assignmentId === assignmentId) return current;
  const old = room.policyHistory.get(assignmentId);
  return old?.peerId === actorId && old.expiresAt > Date.now() ? old : null;
}
function handleVerificationReceipt(room, session, message) {
  const r = message.receipt; if (!r || typeof r !== 'object' || r.protocol !== 13 || r.rulesetRevision !== RULESET_REVISION) return;
  const actorId = normalizeId(r.playerId); const commandId = typeof r.commandId === 'string' ? r.commandId.slice(0, 160) : '';
  const assignmentId = typeof r.assignmentId === 'string' ? r.assignmentId.slice(0, 64) : '';
  const evidenceHash = typeof r.evidenceHash === 'string' ? r.evidenceHash.slice(0, 64) : '';
  const computedHash = typeof r.computedHash === 'string' ? r.computedHash.slice(0, 64) : '';
  const stream = r.stream === 'event' ? 'event' : r.stream === 'simulation' ? 'simulation' : null;
  const streamSeq = Number.isSafeInteger(r.streamSeq) ? r.streamSeq : null;
  if (!actorId || !commandId || !assignmentId || !evidenceHash || !computedHash || !stream || streamSeq == null || streamSeq < 1) return;
  const policy = policyByAssignment(room, actorId, assignmentId); if (!policy || !policy.validatorIds.includes(session.peerId)) return;
  let bucket = room.receiptBuckets.get(commandId);
  if (!bucket) {
    bucket = { commandId, actorId, stream, streamSeq, assignmentId, policy, receipts: new Map(), expiresAt: Date.now() + RECEIPT_TTL_MS, finalized: false };
    room.receiptBuckets.set(commandId, bucket);
  }
  if (bucket.finalized || bucket.actorId !== actorId || bucket.stream !== stream || bucket.streamSeq !== streamSeq || bucket.assignmentId !== assignmentId) return;
  const decision = ['accept', 'reject', 'abstain'].includes(r.decision) ? r.decision : null;
  const resultCode = String(r.resultCode || '').slice(0, 80);
  if (!decision || (decision === 'reject' && !resultCode)) return;
  bucket.receipts.set(session.peerId, {
    validatorId: session.peerId, decision,
    reason: String(r.reason || '').slice(0, 240), resultCode, computedHash, evidenceHash,
  });
  const decisive = [...bucket.receipts.values()].filter(x => x.decision !== 'abstain');
  const acceptGroups = new Map(), rejectGroups = new Map();
  for (const vote of decisive) {
    const key=vote.decision==='accept'
      ? `${vote.evidenceHash}:${vote.computedHash}`
      : `${vote.evidenceHash}:${vote.computedHash}:${vote.resultCode}`;
    const groups=vote.decision==='accept'?acceptGroups:rejectGroups;
    const arr=groups.get(key)||[]; arr.push(vote); groups.set(key,arr);
  }
  const bestAccept=[...acceptGroups.entries()].sort((a,b)=>b[1].length-a[1].length)[0]||null;
  const bestReject=[...rejectGroups.entries()].sort((a,b)=>b[1].length-a[1].length)[0]||null;
  const quorum = policy.quorum;
  let verdict = null, certifiedEvidenceHash=null, certifiedComputedHash=null, certifiedResultCode=null;
  if (quorum > 0 && bestAccept && bestAccept[1].length >= quorum) {
    verdict='accepted'; [certifiedEvidenceHash,certifiedComputedHash]=bestAccept[0].split(':');
  } else if (quorum > 0 && bestReject && bestReject[1].length >= quorum) {
    verdict='rejected'; [certifiedEvidenceHash,certifiedComputedHash,certifiedResultCode]=bestReject[0].split(':');
  }
  if (!verdict) return;
  bucket.finalized = true;
  const certificate = {
    type: 'verification-certificate', signalProtocol: SIGNAL_PROTOCOL, channelId: room.channelId,
    commandId, playerId: actorId, stream: bucket.stream, streamSeq: bucket.streamSeq, assignmentId, verdict,
    validatorIds: policy.validatorIds, quorum, evidenceHash:certifiedEvidenceHash, computedHash:certifiedComputedHash, resultCode:certifiedResultCode, receipts: [...bucket.receipts.values()], serverTime: Date.now(),
  };
  certificate.certificateHash = stableHash(certificate);
  const recipients = new Set([actorId, ...policy.directPeers]);
  for (const id of recipients) safeSend(room.peers.get(id)?.socket, certificate);
}

const httpServer=http.createServer((req,res)=>{ res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify({ok:true,service:'p2p-arena-signaling',signalProtocol:SIGNAL_PROTOCOL,rulesetRevision:RULESET_REVISION,rooms:rooms.size})); });
const wss = new WebSocketServer({ server:httpServer, maxPayload: MAX_PAYLOAD });

wss.on('connection', socket => {
  socket.session = null;
  socket.on('message', raw => {
    if (raw?.length > 256 * 1024) { try { socket.close(4409, 'message too large'); } catch {} return; }
    let message; try { message = JSON.parse(raw.toString()); } catch { safeSend(socket, { type: 'join-error', reason: 'invalid JSON', signalProtocol: SIGNAL_PROTOCOL }); return; }
    if (message.type === 'join') {
      if (message.signalProtocol !== SIGNAL_PROTOCOL) { safeSend(socket, { type: 'join-error', reason: `unsupported signaling protocol ${message.signalProtocol}; expected ${SIGNAL_PROTOCOL}`, signalProtocol: SIGNAL_PROTOCOL }); try { socket.close(4406, 'unsupported signaling protocol'); } catch {} return; }
      if (message.rulesetRevision && message.rulesetRevision !== RULESET_REVISION) { safeSend(socket, { type: 'join-error', reason: `ruleset mismatch; expected ${RULESET_REVISION}`, signalProtocol: SIGNAL_PROTOCOL }); return; }
      const channelId = normalizeId(message.channelId, 'default'); const peerId = normalizeId(message.peerId).slice(0, MAX_PEER_LENGTH);
      if (!peerId) { safeSend(socket, { type: 'join-error', reason: 'peerId is required', signalProtocol: SIGNAL_PROTOCOL }); return; }
      unregister(socket, 'rejoin');
      const roomExisted = rooms.has(channelId), room = ensureRoom(channelId); const previous = room.peers.get(peerId);
      if (previous && previous.socket !== socket) { safeSend(previous.socket, { type: 'join-error', reason: 'peerId replaced by newer connection', signalProtocol: SIGNAL_PROTOCOL }); try { previous.socket.close(4001, 'peer replaced'); } catch {} }
      const transport = message.transport === 'ws-bot' ? 'ws-bot' : 'webrtc';
      const rec = { socket, transport, aoiRadius: clampNumber(message.aoiRadius, DEFAULT_AOI, MIN_AOI, MAX_AOI), presence: null, topologyEpoch: previous?.topologyEpoch || 0, policy: null };
      room.peers.set(peerId, rec); room.membershipEpoch++; socket.session = { channelId, peerId };
      recomputeRoom(room, 'join', peerId);
      const view = buildPeerView(room, peerId);
      safeSend(socket, { type: 'joined', ...view, roomExisted, serverTime: Date.now(), rulesetRevision: RULESET_REVISION });
      return;
    }
    const session = socket.session; if (!session) { safeSend(socket, { type: 'join-error', reason: 'join required before relay', signalProtocol: SIGNAL_PROTOCOL }); return; }
    const room = rooms.get(session.channelId); if (!room) return; const self = room.peers.get(session.peerId); if (!self) return;
    if (message.type === 'keepalive') return;
    if (message.type === 'leave') { unregister(socket, 'leave'); return; }
    if (message.type === 'presence') {
      const x = Number(message.x), y = Number(message.y); if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      self.presence = { x: Math.max(0, Math.min(1000, x)), y: Math.max(0, Math.min(760, y)), observedAt: Date.now() };
      self.aoiRadius = clampNumber(message.aoiRadius, self.aoiRadius || DEFAULT_AOI, MIN_AOI, MAX_AOI); scheduleRecompute(room, 'presence'); return;
    }
    if (message.type === 'verification-receipt') { handleVerificationReceipt(room, session, message); return; }
    if (!PEER_RELAY_TYPES.has(message.type)) {
      safeSend(socket, { type: 'relay-error', reason: `peer relay type is not allowed: ${String(message.type || 'unknown').slice(0, 64)}`, signalProtocol: SIGNAL_PROTOCOL });
      return;
    }
    const to = typeof message.to === 'string' ? message.to : '';
    const allowed = new Set(self.policy?.directPeers || []);
    if (!to || !allowed.has(to)) { safeSend(socket, { type: 'relay-error', reason: 'target is not in assigned direct topology', to, signalProtocol: SIGNAL_PROTOCOL }); return; }
    const target = room.peers.get(to); if (!target || !(target.policy?.directPeers || []).includes(session.peerId)) return;
    safeSend(target.socket, { ...message, from: session.peerId, channelId: session.channelId, signalProtocol: SIGNAL_PROTOCOL });
  });
  socket.on('close', () => unregister(socket, 'disconnect'));
  socket.on('error', () => unregister(socket, 'error'));
});

setInterval(() => { for (const room of rooms.values()) pruneRoom(room); }, 2000).unref?.();

setInterval(() => {
  for (const room of rooms.values()) {
    const info=membershipInfo(room);
    for (const rec of room.peers.values()) safeSend(rec.socket,{type:'membership-summary',signalProtocol:SIGNAL_PROTOCOL,...info});
  }
}, 5000).unref?.();

httpServer.listen(PORT,()=>console.log(`[p2p-arena-signaling] protocol=${SIGNAL_PROTOCOL} ruleset=${RULESET_REVISION} base<=${MAX_BASE_DEGREE} sim<=${MAX_SIM_DEGREE} listening ws://0.0.0.0:${PORT}`));
