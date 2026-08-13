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
- ruleset: **pssf-v13-r4**
- server-assigned actor policy: `assignmentId / topologyEpoch / validatorIds / quorum`
- simulation stream (`move/heal/respawn`): actor state sequence + deterministic dependency chain
- shoot event stream: independent `eventSeq` + `simulationRef(sequence,stateHash)` + aim vector
- shoot/heal/respawn verification: validator receipt → signaling server aggregation → verification certificate

## Event disposition

수신 이벤트를 모두 `reject`로 뭉개지 않습니다.

| 분류 | 의미 | 처리 | Trust 입력 |
|---|---|---|---|
| `IGNORE` | 이미 처리한 동일 이벤트 / 정상 중복 | 상태 변경 없음 | 없음 |
| `DEFER` | sequence gap, 짧은 clock lead 등 아직 판단 불가 | buffer 후 재평가 | 없음 |
| `RESYNC` | state/log prefix 불일치 | snapshot repair | 없음 |
| `REJECTED-NOOP` | 규칙상 유효하지 않은 이벤트 | sequence는 소비, state mutation 없음 | 자동 penalty 없음 |
| `FAULT` | 동일 seq의 상충 이벤트, 동일 commandId의 다른 내용 등 객관화 가능한 충돌 후보 | 격리/기록/repair | TODO: 인증 후에만 사용 |

`REJECTED-NOOP`은 sequence를 삭제하지 않습니다. 따라서 하나의 reject 때문에 이후 모든 명령이 영구적인 sequence hole에 갇히지 않습니다.

## r4 dual-stream ordering

`shoot`은 더 이상 actor simulation sequence를 소비하지 않습니다.

```text
Simulation stream             Consequential event stream
seq 201 MOVE                  eventSeq 40 SHOOT -> ref sim 201
seq 202 MOVE                  eventSeq 41 SHOOT -> ref sim 203
seq 203 MOVE
seq 204 MOVE
```

`eventSeq 40`의 quorum certificate가 늦어져도 `seq 202~204`의 movement finality는 진행됩니다. 반대로 SHOOT은 `simulationRef`로 발사 당시 actor pose/life를 고정합니다. validator는 현재 위치가 아니라 해당 historical simulation sequence를 조회해 origin을 재구성하고, `aimX/aimY`로 ray를 다시 계산합니다.

현재 r4에서 별도 event stream으로 분리한 것은 **SHOOT**입니다. `heal/respawn`은 actor state 자체를 변경하므로 simulation stream에 남겨 두었습니다. combat-state overlay까지 추가로 분리하는 것은 별도 단계입니다.

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

설계 차용 범위와 원 논문은 `RESEARCH_REFERENCES.md`에 기록합니다.

현재 서버는 topology/validator assignment/receipt aggregation/certificate 발급까지 수행합니다. canonical world persistence까지 구현된 상태는 아니므로 런타임 구현 범위와 목표인 `Server-Finalized` 아키텍처를 구분합니다.

## Runtime panel

Runtime 탭의 상단은 현재 상태 판단용 지표만 표시합니다.

- committee
- pending now
- stalled now
- fault events
- avg commit
- msg/sec
- traffic

누적 confirmed/rejected/ignored/deferred/resync, epoch, AOI, checkpoint, relay 내부 통계는 `Advanced Diagnostics`에 접어 두었습니다. 프로토콜 동작은 변경하지 않은 UI 정리입니다.
