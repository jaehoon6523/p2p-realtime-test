# PSSF deploy

## GitHub Pages

저장소 루트에 아래 세 HTML을 그대로 둡니다.

```text
p2p-mmo-demo-hardened.html
p2p-mmo-demo-auto.html
p2p-mmo-auto-launcher.html
```

`hardened`와 `auto`는 단독 실행 파일입니다. 추가 런타임 JS 디렉터리는 필요하지 않습니다.

기존 공개 URL:

```text
https://jaehoon6523.github.io/p2p-realtime-test/p2p-mmo-demo-hardened.html?signal=wss://p2p-realtime-test.onrender.com&room=test1
```

## Render

- Root Directory: `mmo-server`
- Build Command: `npm install`
- Start Command: `npm start`

현재 `mmo-server/package.json`은 `node signaling-server.js`를 직접 실행합니다. 기존의 별도 시작 래퍼나 서버 봇 모듈은 이 배포본의 기본 실행 경로에 필요하지 않습니다.

Expected startup log:

```text
[p2p-arena-signaling] protocol=5 ruleset=pssf-v13-r1 base<=5 sim<=16 listening ws://0.0.0.0:<PORT>
```
