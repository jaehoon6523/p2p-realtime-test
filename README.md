# p2p-realtime-test

## 바로가기

Demo  
https://jaehoon6523.github.io/p2p-realtime-test/p2p-mmo-demo-hardened.html?signal=wss://p2p-realtime-test.onrender.com\&room=test1

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
├─ KNOWN\_DEBT.md
└─ LICENSE
```

`client/` 또는 `server/` 같은 새 상위 디렉터리로 공개 진입점을 이동하지 않습니다. 내부 로직만 `js/` 아래로 분리합니다.

## 프로토콜

* game protocol: **13**
* signaling protocol: **5**
* ruleset: **pssf-v13-r2**
* server-assigned actor policy: `assignmentId / topologyEpoch / validatorIds / quorum`
* move: L1 deterministic local verification
* shoot/heal/respawn: validator receipt → signaling server aggregation → verification certificate

## Event disposition

수신 이벤트를 모두 `reject`로 뭉개지 않습니다.

|분류|의미|처리|Trust 입력|
|-|-|-|-|
|`IGNORE`|이미 처리한 동일 이벤트 / 정상 중복|상태 변경 없음|없음|
|`DEFER`|sequence gap, 짧은 clock lead 등 아직 판단 불가|buffer 후 재평가|없음|
|`RESYNC`|state/log prefix 불일치|snapshot repair|없음|
|`REJECTED-NOOP`|규칙상 유효하지 않은 이벤트|sequence는 소비, state mutation 없음|자동 penalty 없음|
|`FAULT`|동일 seq의 상충 이벤트, 동일 commandId의 다른 내용 등 객관화 가능한 충돌 후보|격리/기록/repair|TODO: 인증 후에만 사용|

`REJECTED-NOOP`은 sequence를 삭제하지 않습니다. 따라서 하나의 reject 때문에 이후 모든 명령이 영구적인 sequence hole에 갇히지 않습니다.

## 실행

수동 데모:

```text
p2p-mmo-demo-hardened.html?signal=wss://p2p-realtime-test.onrender.com\&room=test1
```

AUTO peer:

```text
p2p-mmo-demo-auto.html?signal=wss://p2p-realtime-test.onrender.com\&room=test1\&auto=1
```

AUTO 다중 실행:

```text
p2p-mmo-auto-launcher.html?signal=wss://p2p-realtime-test.onrender.com\&room=test1\&count=3
```

Render signaling server:

```bash
cd mmo-server
npm install
npm start
```

설계 차용 범위와 원 논문은 `RESEARCH\_REFERENCES.md`에 기록합니다.

현재 서버는 topology/validator assignment/receipt aggregation/certificate 발급까지 수행합니다. canonical world persistence까지 구현된 상태는 아니므로 런타임 구현 범위와 목표인 `Server-Finalized` 아키텍처를 구분합니다.

