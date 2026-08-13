# p2p-realtime-test

## 바로가기

Demo  
https://jaehoon6523.github.io/p2p-realtime-test/p2p-mmo-demo-hardened.html?signal=wss://p2p-realtime-test.onrender.com&room=test1

Render dashboard  
https://dashboard.render.com/web/srv-d9pttum7bikc7383brig/env

## 저장소 구조

기존 GitHub Pages URL과 Render Root Directory를 유지합니다.

```text
p2p-realtime-test/
├─ p2p-mmo-demo-hardened.html   # 기존 공개 URL, 단독 실행
├─ p2p-mmo-demo-auto.html       # AUTO peer, 단독 실행
├─ p2p-mmo-auto-launcher.html   # 다중 AUTO 실행
├─ mmo-server/                  # Render Root Directory
│  ├─ signaling-server.js
│  └─ package.json
├─ tests/
├─ DEPLOY.md
├─ KNOWN_DEBT.md
└─ LICENSE
```

두 데모 HTML은 실행 코드를 파일 내부에 포함합니다. GitHub Pages에는 별도 런타임 JS 파일을 추가할 필요가 없습니다.

## 프로토콜

- game protocol: **13**
- signaling protocol: **5**
- ruleset: **pssf-v13-r1**
- server-assigned actor policy: `assignmentId / topologyEpoch / validatorIds / quorum`
- move: L1 deterministic local verification
- shoot/heal/respawn: validator receipt → signaling server aggregation → verification certificate

## 실행

수동 데모:

```text
p2p-mmo-demo-hardened.html?signal=wss://HOST&room=test1
```

AUTO peer:

```text
p2p-mmo-demo-auto.html?signal=wss://HOST&room=test1&auto=1
```

AUTO 다중 실행:

```text
p2p-mmo-auto-launcher.html?signal=wss://HOST&room=test1&count=3
```

Render signaling server:

```bash
cd mmo-server
npm install
npm start
```

현재 서버 구현 범위는 topology/validator assignment/receipt aggregation/certificate 발급까지입니다. 목표인 `Server-Finalized`와 현재 runtime 구현 범위를 구분합니다.
