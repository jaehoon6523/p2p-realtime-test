/**
 * MMO 데모용 시그널링 릴레이 서버
 *
 * 기존 클라이언트(p2p-mmo-demo-hardened.html)가 BroadcastChannel로 주고받던
 * 메시지 형태({type, to?, from, tick, ...})를 그대로 유지한 채, 전송 계층만
 * WebSocket으로 바꾼 것. 클라이언트 쪽 프로토콜/검증 로직은 전혀 안 건드림 —
 * 이 서버는 순수 "누구한테 이 메시지를 전달할지"만 판단하는 릴레이.
 *
 * 규칙:
 *  - `to` 필드가 있으면: 같은 방(room) 안의 그 특정 peer에게만 전달 (offer/answer/ice)
 *  - `to` 필드가 없으면: 같은 방의 나를 제외한 전원에게 전달 (announce)
 *
 * 실행: node signaling-server.js
 * 필요 패키지: ws
 */

const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8090;
const wss = new WebSocketServer({ port: PORT });

/** rooms: Map<channelId, Map<peerId, ws>> */
const rooms = new Map();

function getRoom(channelId) {
  if (!rooms.has(channelId)) rooms.set(channelId, new Map());
  return rooms.get(channelId);
}

function safeSend(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

wss.on('connection', (ws) => {
  let channelId = null;
  let peerId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // 최초 메시지는 반드시 join (방 배정)
    if (msg.type === 'join') {
      channelId = msg.channelId || 'default';
      peerId = msg.peerId;
      if (!peerId) return;
      getRoom(channelId).set(peerId, ws);
      return;
    }

    if (!channelId || !peerId) return; // join 전에는 아무것도 릴레이하지 않음
    const room = getRoom(channelId);

    if (msg.to) {
      const target = room.get(msg.to);
      if (target) safeSend(target, msg);
    } else {
      for (const [otherId, otherWs] of room) {
        if (otherId !== peerId) safeSend(otherWs, msg);
      }
    }
  });

  ws.on('close', () => {
    if (!channelId || !peerId) return;
    const room = rooms.get(channelId);
    if (!room) return;
    room.delete(peerId);
    if (room.size === 0) rooms.delete(channelId);
  });
});

console.log(`[mmo-signaling] listening on ws://0.0.0.0:${PORT}`);
