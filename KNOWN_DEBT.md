# KNOWN_DEBT

새 기능보다 아래 순서로 닫는 것이 우선입니다.

1. **Evidence authenticity**: shoot checkpoint가 실제 관측 상태였음을 validator가 독립적으로 증명하지 못함.
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
