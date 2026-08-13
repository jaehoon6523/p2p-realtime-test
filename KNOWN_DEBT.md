# KNOWN_DEBT

새 기능보다 아래 순서로 닫는 것이 우선입니다.

1. **Evidence authenticity**: shoot checkpoint가 실제 관측 상태였음을 validator가 독립적으로 증명하지 못함.
2. **Heal rule truth**: `1초 정지`는 command 생성측 규칙이고 validator의 독립 evidence가 없음.
3. **Deterministic respawn time**: `performance.now()` 기반 판정 제거 필요.
4. **Cryptographic commitment**: 32-bit `stableHash()`는 보안 commitment가 아님.
5. **Identity / Sybil / Trust Policy**: self-issued peerId와 validator assignment의 신뢰 경계가 약함.
6. **Real finalization**: certificate 발급과 canonical state mutation/persistence가 아직 분리되어 있음.
7. **Dense AOI scale**: 100/200/400 peer가 같은 spatial cell에 몰리는 worst-case benchmark 필요.

## 배포 불변식

- 기존 GitHub Pages 파일명/URL을 바꾸지 않는다.
- `hardened`와 `auto`는 각각 단독 실행 가능하게 유지한다.
- 서버 전용 signal type은 peer relay surface에 허용하지 않는다.
- future tick은 evaluator에서 거부한다.
- 개발 소스를 다시 분리하더라도 배포 산출물은 단일 entrypoint 형태로 만든다.
