
- r22: Q/W shooting no longer flushes or cancels click-movement; dash replaces click-movement. Direct-mesh health is now DataChannel-open based, not RTCPeerConnection.connected based.
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
- ruleset: **pssf-v13-r22**
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

## r7 dual-stream ordering + history repair + prefix convergence

`shoot`은 더 이상 actor simulation sequence를 소비하지 않습니다.

```text
Simulation stream             Consequential event stream
seq 201 MOVE                  eventSeq 40 SHOOT -> ref sim 201
seq 202 MOVE                  eventSeq 41 SHOOT -> ref sim 203
seq 203 MOVE
seq 204 MOVE
```

`eventSeq 40`의 quorum certificate가 늦어져도 `seq 202~204`의 movement finality는 진행됩니다. 반대로 SHOOT은 `simulationRef`로 발사 당시 actor pose/life를 고정합니다. validator는 현재 위치가 아니라 해당 historical simulation sequence를 조회해 origin을 재구성하고, `aimX/aimY`로 ray를 다시 계산합니다.

현재 r7에서 별도 event stream으로 분리한 것은 **SHOOT**입니다. `heal/respawn`은 actor state 자체를 변경하므로 simulation stream에 남겨 두었습니다. combat-state overlay까지 추가로 분리하는 것은 별도 단계입니다.

### Snapshot / historical repair

새 direct 연결이나 재접속이 현재 `seq=N` snapshot 한 점만 받으면, 늦게 도착한 SHOOT이 `refSim < N`을 가리킬 때 historical pose가 비어 있을 수 있습니다. r7은 이를 두 단계로 복구합니다.

- snapshot에 최근 simulation history tail을 함께 전송
- 특정 `simulationRef(sequence,stateHash)`가 여전히 없으면 해당 sequence만 `historyRepair`로 요청/응답
- history repair는 current simulation state를 되감지 않고 event validation cache만 채움
- local respawn commit 직후 direct peers에 snapshot + signaling presence를 즉시 재전파하여 새 `lifeId/alive`를 알림

`historyRepair`는 현재 owner가 제공하는 liveness repair 자료이며 cryptographic proof는 아닙니다. 증거 진위성은 `KNOWN_DEBT.md`의 별도 보안 부채로 남깁니다.


### SHOOT 입력 / backpressure

SHOOT은 simulation stream과 독립된 event stream에서 최대 4개까지 unresolved 상태를 허용합니다. 이전처럼 pending SHOOT 하나가 있다는 이유만으로 다음 클릭을 조용히 버리지 않습니다. 발사가 억제되면 Runtime 로그에 반드시 이유가 남습니다.

```text
SHOOT_SUPPRESSED code=DEAD
SHOOT_SUPPRESSED code=NO_LOCAL_STATE
SHOOT_SUPPRESSED code=INVALID_AIM
SHOOT_SUPPRESSED code=EVENT_BACKPRESSURE pendingShoot=4/4
```

`SHOOT_INVALID`는 입력 억제가 아니라, 생성·전파된 SHOOT이 validator quorum에서 규칙상 거절된 경우입니다. 이 경우 `CERTIFICATE REJECTED`와 `REJECTED-EVENT-NOOP ... code=SHOOT_INVALID`가 별도로 기록됩니다.

## 실행

수동 데모:

```text
https://jaehoon6523.github.io/p2p-realtime-test/p2p-mmo-demo-hardened.html?signal=wss://p2p-realtime-test.onrender.com&room=test1
```

AUTO peer:

```text
https://jaehoon6523.github.io/p2p-realtime-test/p2p-mmo-demo-auto.html?signal=wss://p2p-realtime-test.onrender.com&room=test1&auto=1
```

AUTO 다중 실행:

```text
https://jaehoon6523.github.io/p2p-realtime-test/p2p-mmo-auto-launcher.html?signal=wss://p2p-realtime-test.onrender.com&room=test1&count=3
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



## AUTO combat policy (r13)

AUTO peers use **Q/basic_attack only** for combat. They never cast W or E. Targeting/movement stays autonomous, but attack execution uses the same Q `makeShootCommand` → validation → QC path as a normal peer.

## Optimistic UX / authoritative correction (r11)

The local client predicts only effects that are cheap to correct:

- Q/W: after the 0.2 s cast, the projectile/trail is rendered immediately as `tentative` before QC.
- E: after the 0.2 s cast, the local predicted pose dashes immediately before QC.
- Shared consequences (`hp`, `death`, `kill`, assists) are **not** predicted. They are applied only after a server-issued quorum certificate accepts the event.
- Accepted predictions log `PREDICT_CONFIRM`.
- Rejected Q/W predictions fade and log `PREDICT_CORRECT ... action=fade`.
- Rejected E predictions reconcile to the canonical simulation prefix and log `PREDICT_CORRECT ... action=canonical-snap`.

This deliberately keeps correction cheap: visual/projected motion may be corrected, but an enemy is never locally killed and resurrected merely because a speculative hit was rejected.

## Ability controls (r9)

- `Q` basic attack: range 230, cooldown 0.5s, cast **0s (instant)**, recovery 0.2s.
- `W` long shot: range 460, cooldown 2s, cast 0.2s, recovery 0.2s.
- `E` dash: distance 150, cooldown 3s, cast 0.2s, recovery 0.2s.
- Mouse position supplies aim. Right click remains destination movement. Left click no longer attacks.


### Ability consensus contract (r9)

Q/W/E now carry a shared `abilitySeq` lineage across both the event and simulation streams. Each ability command binds `castStartTick`, `previousAbilityRef`, and `previousSameAbilityRef`. Validators independently verify cast delay, global recovery lock, and same-ability cooldown before computing the action result. The ability verdict is included in the deterministic computed hash, and the signaling server still requires q2 matching receipts for the exact evidence/computed hash.

This means network latency changes when a validator finishes, not the logical cast/cooldown facts it evaluates. Terminal accepted/rejected ability commands advance the ability lineage so rejected casts cannot permanently strand later skills.

### TODO: XML Ability / Component data

Runtime values currently live in `ABILITY_DEFINITIONS`. The intended next refactor is to load them from an XML Ability/Component definition rather than hard-code per-skill branches. Keep protocol validation authoritative after loading. Suggested data shape only, not implemented yet:

```xml
<Ability id="basic_attack" key="Q">
  <Cooldown seconds="0.5"/>
  <CastDelay seconds="0.2"/>
  <Recovery seconds="0.2"/>
  <Projectile range="230"/>
</Ability>
<Ability id="long_shot" key="W">
  <Cooldown seconds="2.0"/>
  <CastDelay seconds="0.2"/>
  <Recovery seconds="0.2"/>
  <Projectile range="460"/>
</Ability>
<Ability id="dash" key="E">
  <Cooldown seconds="3.0"/>
  <CastDelay seconds="0.2"/>
  <Recovery seconds="0.2"/>
  <Movement type="Dash" distance="150"/>
</Ability>
```

### Ability data location

Canonical Q/W/E gameplay values live in **`js/game/ability-definitions.js`**. Runtime input, command construction, validator timing/range checks, AUTO behavior, and tests all read `ABILITY_DEFINITIONS` / `ABILITY_BY_ID` from this file. Do not duplicate cooldown/cast/recovery/range/distance numbers in validator code.

Current values:

```text
Q basic_attack: cast 0ms, recovery 200ms, cooldown 500ms, range 230
W long_shot:    cast 200ms, recovery 200ms, cooldown 2000ms, range 460
E dash:         cast 200ms, recovery 200ms, cooldown 3000ms, distance 150
```

TODO(XML): replace `ability-definitions.js` as the data source with the planned XML Ability/Component loader while preserving the same immutable runtime shape.

## r13 AUTO Q runtime fix
- AUTO combat decision is executed from the same `tickCombat()` lifecycle instead of a separate timer.
- AUTO may choose only Q. W/E are never selected.
- AUTO Q calls `tryCastAbility('Q', { source: 'AUTO' })`, so local cooldown, recovery lock, ability lineage, optimistic prediction, validator replay and QC are identical to human Q.
- DataChannel open/snapshot merge wakes AUTO immediately; AUTO_DEBUG logs `AUTO_TICK`.
- HUD text reflects Q cast=0 and W/E cast=0.2s.


## r14 AUTO bootstrap ordering
- Initial peer snapshot bypasses synthetic netem so it cannot be reordered behind seq=1 commands.
- Receiver sends `snapshotAck` only after installing the base state.
- AUTO movement/Q remains gated until every direct peer has ACKed the local bootstrap snapshot.

### r17 bootstrap receive ordering

Bootstrap `snapshot` and `snapshotAck` bypass both TX and RX synthetic netem queues. This preserves the required invariant: the receiver installs sequence-0/base state before any sequence-1+ command is admitted. Normal gameplay traffic still uses netem.


## r17 AUTO mesh repair
- AUTO launcher staggers iframe joins by 900ms by default (`launchGap=` override).
- Desired direct WebRTC edges are actively repaired by the deterministic offerer.
- Launcher badges show live `mesh open/desired` status from each AUTO iframe.

## r19 movement single-source state machine

Movement command generation now has one position authority: `getPredictedTail(myId)`. The movement plan stores only start/target/time/profile data. Cached incremental fields such as `sampleX/sampleY` and `lastX/lastY` were removed.

Each tick evaluates an absolute desired position from the time profile, then emits bounded move commands from the current predicted chain tail toward that absolute point. `finished` only ends the plan after the predicted tail is actually within the target epsilon, so a completed path cannot keep replaying the original start-to-target delta.

Large frame gaps are still chunked below the movement validation limit. Retarget, rejection/rebase, and backpressure all re-enter through the same predicted-tail boundary.
