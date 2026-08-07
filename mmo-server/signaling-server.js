'use strict';

/**
 * P2P Arena signaling relay v2
 *
 * Responsibilities only:
 * - verify the signaling protocol version
 * - check/create a room and acknowledge the result
 * - relay announce/offer/answer/ice/leave messages inside that room
 *
 * It remains non-authoritative for gameplay state.
 */
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT) || 8090;
const SIGNAL_PROTOCOL = 2;
const MAX_ROOM_LENGTH = 96;
const MAX_PEER_LENGTH = 96;

/** @type {Map<string, Map<string, import('ws').WebSocket>>} */
const rooms = new Map();

function normalizeId(value, fallback = '') {
    if (typeof value !== 'string') return fallback;
    const normalized = value.trim().replace(/[^a-zA-Z0-9._:-]/g, '_');
    return normalized.slice(0, MAX_ROOM_LENGTH) || fallback;
}

function safeSend(socket, message) {
    if (socket.readyState !== WebSocket.OPEN) return false;
    try {
        socket.send(JSON.stringify(message));
        return true;
    } catch {
        return false;
    }
}

function removeRegistration(socket) {
    const { channelId, peerId } = socket.session || {};
    if (!channelId || !peerId) return;
    const room = rooms.get(channelId);
    if (!room) return;
    if (room.get(peerId) === socket) room.delete(peerId);
    if (room.size === 0) rooms.delete(channelId);
    socket.session = null;
}

const wss = new WebSocketServer({ port: PORT, maxPayload: 128 * 1024 });

wss.on('connection', socket => {
    socket.session = null;

    socket.on('message', raw => {
        let message;
        try {
            message = JSON.parse(raw.toString());
        } catch {
            safeSend(socket, { type: 'join-error', reason: 'invalid JSON', signalProtocol: SIGNAL_PROTOCOL });
            return;
        }

        if (message.type === 'join') {
            if (message.signalProtocol !== SIGNAL_PROTOCOL) {
                safeSend(socket, {
                    type: 'join-error',
                    reason: `unsupported signaling protocol ${message.signalProtocol}; expected ${SIGNAL_PROTOCOL}`,
                    signalProtocol: SIGNAL_PROTOCOL
                });
                socket.close(4406, 'unsupported signaling protocol');
                return;
            }

            const channelId = normalizeId(message.channelId, 'default');
            const peerId = normalizeId(message.peerId).slice(0, MAX_PEER_LENGTH);
            if (!peerId) {
                safeSend(socket, { type: 'join-error', reason: 'peerId is required', signalProtocol: SIGNAL_PROTOCOL });
                return;
            }

            removeRegistration(socket);
            const roomExisted = rooms.has(channelId);
            const room = rooms.get(channelId) || new Map();
            if (!roomExisted) rooms.set(channelId, room);

            const previous = room.get(peerId);
            if (previous && previous !== socket) {
                safeSend(previous, { type: 'join-error', reason: 'peerId replaced by a newer connection', signalProtocol: SIGNAL_PROTOCOL });
                try { previous.close(4001, 'peer replaced'); } catch {}
            }

            room.set(peerId, socket);
            socket.session = { channelId, peerId };

            safeSend(socket, {
                type: 'joined',
                channelId,
                peerId,
                roomExisted,
                peerCount: room.size,
                signalProtocol: SIGNAL_PROTOCOL,
                serverTime: Date.now()
            });
            return;
        }

        const session = socket.session;
        if (!session) {
            safeSend(socket, { type: 'join-error', reason: 'join is required before relay', signalProtocol: SIGNAL_PROTOCOL });
            return;
        }

        const room = rooms.get(session.channelId);
        if (!room) return;

        // Do not trust a forged `from` field from the client.
        const relay = { ...message, from: session.peerId, signalProtocol: SIGNAL_PROTOCOL };
        if (typeof message.to === 'string' && message.to) {
            const target = room.get(message.to);
            if (target) safeSend(target, relay);
            return;
        }

        for (const [otherPeerId, otherSocket] of room) {
            if (otherPeerId !== session.peerId) safeSend(otherSocket, relay);
        }
    });

    socket.on('close', () => removeRegistration(socket));
    socket.on('error', () => removeRegistration(socket));
});

console.log(`[p2p-arena-signaling] protocol=${SIGNAL_PROTOCOL} listening on ws://0.0.0.0:${PORT}`);
