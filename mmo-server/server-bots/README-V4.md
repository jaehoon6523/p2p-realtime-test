# PSSF server bots v4 (fixed)

이 봇은 `PROTOCOL=13`, `SIGNAL_PROTOCOL=4`, `RULESET=pssf-v13-r1`을 사용합니다.
기존 signaling server는 bot 모듈을 import하지 않습니다.

## Render에서 같은 Web Service에 테스트 봇 같이 실행

봇을 쓸 때만 Build Command에 server-bots 의존성 설치를 추가합니다.

```bash
npm install && npm --prefix server-bots install
```

Start Command:

```bash
node start-v4.js
```

Environment:

```text
BOT_COUNT=3
ROOM_ID=test1
```

`BOT_COUNT=0`이면 `start-v4.js`는 signaling server만 실행하며 bot-runner를 시작하지 않습니다.
봇 프로세스는 같은 Render 컨테이너의 `ws://127.0.0.1:$PORT`로 signaling server에 접속합니다.

## 의존성을 아예 설치하지 않는 일반 서버 모드

Build Command는 기존 그대로 두고 Start Command도 다음처럼 사용합니다.

```bash
node signaling-server-sparse-v4.js
```

이 경우 server-bots/와 werift는 전혀 사용되지 않습니다.

## 별도 Worker에서 실행

```bash
cd server-bots
npm install
SIGNAL_URL=wss://YOUR-SERVER.onrender.com ROOM_ID=test1 BOT_COUNT=400 node bot-runner.js
```

옵션: `JOIN_BATCH`, `AOI_RADIUS`, `BOT_VERBOSE=1`.
