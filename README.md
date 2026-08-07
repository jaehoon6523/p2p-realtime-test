https://jaehoon6523.github.io/p2p-realtime-test/p2p-mmo-demo-hardened.html?signal=wss://p2p-realtime-test.onrender.com&room=test1

https://dashboard.render.com/web/srv-d9pttum7bikc7383brig/env


PSSF server bots v4

이 디렉터리는 선택적 부하/플레이 테스트용입니다. signaling server가 이 모듈을 import하지 않습니다.

프로토콜

game protocol: 13

signaling protocol: 4

ruleset: pssf-v13-r1

server-assigned actor policy: assignmentId / topologyEpoch / validatorIds / quorum

move: L1 deterministic local verification

shoot/heal/respawn: validator receipt -> signaling server aggregation -> verification certificate

실행

봇 기능을 사용할 때만 별도 의존성을 설치합니다.

npm i werift ws
SIGNAL_URL=wss://YOUR-SIGNAL.example ROOM_ID=test1 BOT_COUNT=400 node bot-runner.js

옵션:

BOT_COUNT: 1..1000

JOIN_BATCH: 기본 20

AOI_RADIUS: 120..1400, 기본 260

BOT_VERBOSE=1

봇 runner는 모든 봇의 join phase를 먼저 끝낸 뒤 topology/DataChannel settle을 확인하고 AI를 시작합니다.
