# PSSF Render deploy

기존 Render 서비스 경로를 유지합니다.

## Render

- Root Directory: `mmo-server`
- Build Command: `npm install`
- Start Command: `npm start`

현재 `mmo-server/package.json`은 `node signaling-server.js`를 직접 실행합니다. `start.js`, `server-bots/bot-runner.js`, `werift`는 기본 Render 실행 경로에 필요하지 않습니다.

Expected startup log:

```text
[p2p-arena-signaling] protocol=5 ruleset=pssf-v13-r5 base<=5 sim<=16 listening ws://0.0.0.0:<PORT>
```

## GitHub Pages

기존 공개 URL을 유지합니다.

```text
https://jaehoon6523.github.io/p2p-realtime-test/p2p-mmo-demo-hardened.html?signal=wss://p2p-realtime-test.onrender.com&room=test1
```

정적 HTML은 저장소 루트에 두고, 분리된 런타임 코드는 루트의 `js/`를 상대 경로로 참조합니다.


## r5 확인 포인트

재접속/부활 후 정상 로그는 `simulation-ref-missing`이 지속 반복되지 않아야 합니다. 필요 시 한 번의 `HISTORY REPAIR sent/merged` 뒤 deferred event가 재평가되어야 합니다. local respawn 직후 direct peer에는 새 snapshot이 즉시 전송됩니다.
