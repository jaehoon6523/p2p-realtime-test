# p2p-realtime-test

## 바로가기

Demo  
https://jaehoon6523.github.io/p2p-realtime-test/p2p-mmo-demo-hardened.html?signal=wss://p2p-realtime-test.onrender.com&room=test1

Render dashboard  
https://dashboard.render.com/web/srv-d9pttum7bikc7383brig/env

## 저장소 경로 불변식

GitHub Pages는 이 저장소 루트에서 정적 파일을 서비스하므로 기존 공개 진입점은 그대로 유지합니다.

```text
p2p-realtime-test/
├─ p2p-mmo-demo-hardened.html   # 기존 공개 URL. 이름/위치 유지
├─ p2p-mmo-demo-auto.html       # AUTO peer 진입점
├─ p2p-mmo-auto-launcher.html   # 다중 AUTO 실행
├─ js/                          # 공용 런타임 모듈
├─ mmo-server/                  # Render Root Directory. 이름/위치 유지
│  ├─ signaling-server.js
│  └─ package.json
├─ tests/
├─ DEPLOY.md
├─ KNOWN_DEBT.md
└─ LICENSE
```

`client/` 또는 `server/` 같은 새 상위 디렉터리로 공개 진입점을 이동하지 않습니다. 내부 로직만 `js/` 아래로 분리합니다.

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

현재 서버는 topology/validator assignment/receipt aggregation/certificate 발급까지 수행합니다. canonical world persistence까지 구현된 상태는 아니므로 런타임 구현 범위와 목표인 `Server-Finalized` 아키텍처를 구분합니다.
