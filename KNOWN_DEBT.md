# KNOWN_DEBT

새 기능보다 아래 순서로 닫는 것이 우선입니다.

1. **Evidence / repair authenticity**: r5는 checkpoint를 historical simulation sequence와 교차검증하고 missing ref는 snapshot history tail / targeted history repair로 복구하지만, cache가 없던 verifier에게 owner가 제공한 repair state 자체는 아직 cryptographic proof가 아님.
2. **Heal rule truth**: `1초 정지`는 현재 command 생성측 규칙이고 validator의 독립 evidence가 없음.
3. **Deterministic respawn time**: `performance.now()` 기반 판정 제거 필요.
4. **Cryptographic commitment**: 32-bit `stableHash()`는 보안 commitment가 아님.
5. **Authenticated event identity**: equivocation/command-id conflict는 현재 관측 가능한 fault 후보일 뿐, actor signature가 없어서 자동 Trust penalty 근거로 쓰면 안 됨.
6. **Identity / Sybil / Trust Policy**: self-issued peerId와 validator assignment의 신뢰 경계가 약함.
7. **Real finalization**: certificate 발급과 canonical state mutation/persistence가 아직 분리되어 있음.
8. **Dense AOI scale**: 100/200/400 peer가 같은 spatial cell에 몰리는 worst-case benchmark 필요.

## 유지 규칙

- 규칙은 `js/game/ruleset.js`에서 한 번만 정의한다.
- AUTO/netem은 입력 및 고장 주입만 담당한다.
- server-only signal type은 peer relay surface에 들어가지 않는다.
- UI는 protocol state를 소유하지 않는다.
- 목표 설계와 현재 런타임 상태를 같은 단어로 부르지 않는다.

## r3 clock/reject correction

- Remote clock anchors are updated from command arrival/snapshot observations, never delayed commit time.
- Large tick disagreement is CLOCK_MODEL_DIVERGED -> RESYNC, not an attributable protocol fault.
- A rejected event only invalidates later pending events whose previousStateHash no longer matches the canonical prefix.
- Late certificates cannot resurrect dependency-invalidated events.

## r4 dual-stream correction

- SHOOT은 simulation sequence에서 분리되어 독립 `eventSeq`로 finalize된다.
- SHOOT evidence는 `simulationRef(sequence,stateHash) + aim`으로 발사 당시 pose를 참조한다.
- unresolved/rejected SHOOT은 movement sequence finality를 head-of-line block하지 않는다.
- SHOOT rejection은 movement profile을 rebase하지 않는다.
- checkpoint local consistency check는 current position이 아니라 checkpoint의 historical sequence를 사용한다.
- heal/respawn은 아직 actor state mutation 때문에 simulation stream에 남아 있다.


## r5 history repair correction

- snapshot은 현재 state 한 점뿐 아니라 최근 simulation history tail을 함께 전달한다.
- `SIMULATION_REF_MISSING`은 무작정 current snapshot을 반복하지 않고 요청한 `sequence/stateHash`를 targeted history repair로 요청한다.
- history repair 수신은 historical cache만 채우며 current confirmed sequence를 rewind하지 않는다.
- respawn commit 직후 local peer는 direct peers에 snapshot을 즉시 broadcast하고 signaling presence를 즉시 갱신한다.
- 목적은 reconnect/topology churn/respawn 이후 늦게 도착한 SHOOT이 과거 `simulationRef`를 잃어버리는 liveness failure를 막는 것이다.


## r6 prefix convergence
- Repeated identical snapshot repair followed by the same `STATE_HASH_MISMATCH` escalates to `PREFIX_CONFLICT` instead of looping forever.
- `REBASE_REQUIRED` is peer-issued in this demo and therefore is a liveness mechanism, not a cryptographically authoritative finality proof. The actor only accepts it when the requested canonical sequence/hash exactly matches its own confirmed prefix; with 2+ direct peers, two distinct peers must request the same rebase before it is applied.
- The actor consumes its already-issued contiguous speculative simulation suffix as `PREFIX_REBASE_INVALIDATED` no-ops. Sequence numbers are never deleted or reused.


## r7 shoot pipeline

- SHOOT event는 최대 4개 unresolved까지 허용한다. 그 이상은 `EVENT_BACKPRESSURE`로 명시적으로 억제/로그한다.
- 입력 억제와 validator의 `SHOOT_INVALID`는 다른 개념이다.
- heal/respawn은 여전히 simulation stream이라 movement head-of-line blocking 가능성이 남아 있다.

- Ability cooldown/cast/recovery definitions are hard-coded in `ABILITY_DEFINITIONS`; XML Ability/Component loading is TODO. Validator-side cross-command cooldown proof is not yet a signed/anchored contract, so local cooldown enforcement is UX/runtime policy rather than final anti-cheat evidence.

## r10 optimistic correction

- Q/W projectile trails and local E pose are optimistic UX only. HP/death/kill remain certificate-gated.
- Dash correction currently reconciles through the existing canonical simulation rebuild/rebase path; there is no bespoke animation blend yet.
- Projectile correction fades the speculative trail rather than reconstructing a physically bounced/blocked cosmetic projectile.

## r18 movement rejection recovery
- MOVE_INVALID/rejection이 동기적으로 movement state를 rebase하면 이전 movement 객체를 즉시 폐기하고 현재 tick 후처리를 중단합니다.
- 프레임/타이머 지연으로 한 번의 movement delta가 커진 경우 BASE_MAX_STEP보다 보수적인 chunk로 분할해 정상 입력이 MOVE_INVALID를 유발하지 않게 합니다.
- 회귀 테스트: `tests/movement-stale-ref.js`.
