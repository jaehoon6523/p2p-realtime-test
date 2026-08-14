
- r23: click-movement keeps a continuous `vx/vy` velocity vector across retargets; direction changes obey acceleration/deceleration limits instead of rotating scalar speed instantly. Direct-mesh recovery treats DataChannel-open as transport readiness and accepts a fresh offer to replace a half-open WebRTC edge.
# PSSF Render deploy

기존 Render 서비스 경로를 유지합니다.

## Render

- Root Directory: `mmo-server`
- Build Command: `npm install`
- Start Command: `npm start`

현재 `mmo-server/package.json`은 `node signaling-server.js`를 직접 실행합니다. `start.js`, `server-bots/bot-runner.js`, `werift`는 기본 Render 실행 경로에 필요하지 않습니다.

Expected startup log:

```text
[p2p-arena-signaling] protocol=5 ruleset=pssf-v13-r27 base<=5 sim<=16 listening ws://0.0.0.0:<PORT>
```

## GitHub Pages

기존 공개 URL을 유지합니다.

```text
https://jaehoon6523.github.io/p2p-realtime-test/p2p-mmo-demo-hardened.html?signal=wss://p2p-realtime-test.onrender.com&room=test1
```

정적 HTML은 저장소 루트에 두고, 분리된 런타임 코드는 루트의 `js/`를 상대 경로로 참조합니다.

## r19 movement single-source state machine
- MOVE_INVALID/rejection이 동기적으로 movement state를 rebase하면 이전 movement 객체를 즉시 폐기하고 현재 tick 후처리를 중단합니다.
- 프레임/타이머 지연으로 한 번의 movement delta가 커진 경우 BASE_MAX_STEP보다 보수적인 chunk로 분할해 정상 입력이 MOVE_INVALID를 유발하지 않게 합니다.
- 회귀 테스트: `tests/movement-stale-ref.js`.

## Browser asset version pin

- Expected build/ruleset: `pssf-v13-r27`
- Demo HTML script URLs are pinned with `?v=pssf-v13-r27`.
- Public test URLs should include `&build=pssf-v13-r27` so the HTML document itself also gets a distinct cache key.
- After deploy, reject any browser log whose `local peer boot` line is not `ruleset=pssf-v13-r27`.


After deployment, verify the first boot line reports `ruleset=pssf-v13-r27`. For multiplayer diagnostics, AUTO pages with `autodebug=1` should show `AUDIT_EVAL` and `AUDIT_RECEIPT_TX` when receiving Q/W/E.
