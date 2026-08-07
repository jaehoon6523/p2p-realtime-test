# PSSF v5 Render deploy

Default server bots use the existing signaling WebSocket as a sparse transport.
No UDP/TURN/werift is required for the default Render path. Human-to-human peers still use WebRTC.

## Render
Root Directory: `mmo-server`
Build Command: `npm install`
Start Command: `npm start`

Environment:
- `BOT_COUNT=3`
- `ROOM_ID=test1`
- `BOT_TRANSPORT=ws` (default)

Expected logs:
```
[start-v5] signal=signaling-server.js bots=3 botTransport=ws
[p2p-arena-signaling] protocol=5 ruleset=pssf-v13-r1 ...
[bot-runner:v5] JOIN phase room=test1 bots=3 transport=ws ...
[bot-runner:v5] joined 3/3 ...
[bot-runner:v5] RUN phase topology ready=3/3
```

## Optional real WebRTC bot transport
Only on a host where ICE/TURN connectivity is available:
- set `BOT_TRANSPORT=webrtc`
- additionally run `npm --prefix server-bots install` during build

Render Web Services expose public HTTP/WebSocket ingress, so `ws` is the recommended server-bot transport there.
