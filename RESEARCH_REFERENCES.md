# PSSF research references

이 파일은 PSSF가 어디에서 아이디어를 빌렸는지와 **무엇을 그대로 가져오지 않았는지**를 기록합니다. 이름만 분산시스템처럼 보이게 만드는 장식용 참고문헌은 피합니다.

## 1. 늦음 / 재정렬 / playout 불확실성

**Nathaniel E. Baughman, Marc Liberatore, Brian Neil Levine. _Cheat-Proof Playout for Centralized and Peer-to-Peer Gaming_. IEEE/ACM Transactions on Networking 15(1), 2007.**

- 원문/저자 페이지: https://people.cs.umass.edu/~liberato/home/publication/cheat-proof-playout-for-centralized-and/
- 논문에서 확인되는 점: asynchronous synchronization은 serverless 환경에서 anti-cheating 보장을 유지하면서 packet loss에 강건하도록 설계된다.
- **PSSF adaptation**: 네트워크 시간 불확실성을 곧바로 semantic cheating 판정으로 승격하지 않는다. 작은 clock lead는 `ACCEPT`, 더 큰 불확실성은 `DEFER`, 극단적으로 설명하기 어려운 경우만 `FAULT` 후보로 분리한다. 이 구간값 자체는 PSSF 정책이며 논문의 수치를 복사한 것이 아니다.
- 가져오지 않은 것: 논문의 전체 asynchronous synchronization / zero-knowledge protocol을 그대로 구현하지 않는다.

## 2. sequence + equivocation accountability

**Andreas Haeberlen, Petr Kuznetsov, Peter Druschel. _PeerReview: Practical Accountability for Distributed Systems_. SOSP 2007.**

- 프로젝트/논문: https://peerreview.mpi-sws.org/
- 논문에서 빌린 점: tamper-evident history와 deterministic replay를 이용해 Byzantine misbehavior를 사후에 객관적으로 입증하는 accountability 모델.
- **PSSF adaptation**: 최근 finalized sequence의 event fingerprint를 보존하고, 동일 sequence/동일 fingerprint는 `IGNORE`, 동일 sequence/다른 fingerprint 또는 동일 `commandId`/다른 fingerprint는 `FAULT` 후보로 분리한다.
- 아직 TODO: 현재 fingerprint는 demo용 32-bit hash이며 actor signature / recursive tamper-evident log가 없다. **따라서 현재 FAULT는 trust 점수를 자동 차감하지 않는다.**

## 3. mismatch는 공격이 아니라 repair 대상으로 먼저 본다

**Diego Ongaro, John Ousterhout. _In Search of an Understandable Consensus Algorithm (Raft)_. USENIX ATC 2014.**

- 공식 페이지: https://raft.github.io/
- 논문에서 확인되는 점: Raft는 replicated log의 일치성을 유지하고 불일치 follower log를 leader log와 맞추는 repair 절차를 갖는다.
- **PSSF adaptation**: `previousStateHash` 불일치는 공격 판정이 아니라 `RESYNC`로 분류하고 snapshot repair를 요청한다. snapshot이 덮는 prefix 이후의 이미 받은 명령은 버리지 않고 다시 `DEFER` 큐에서 재평가한다.
- 가져오지 않은 것: PSSF actor stream에 leader election, replicated log consensus, Raft safety proof를 적용하지 않는다. 여기서는 **repair 원칙만 차용**한다.

## 4. quorum certificate는 정확한 evidence에 묶는다

**Maofan Yin, Dahlia Malkhi, Michael K. Reiter, Guy Golan Gueta, Ittai Abraham. _HotStuff: BFT Consensus in the Lens of Blockchain_. PODC 2019.**

- preprint: https://arxiv.org/abs/1803.05069
- 논문에서 확인되는 점: HotStuff의 QC는 특정 node/proposal에 대한 quorum vote를 묶는 안전성 구성요소다.
- **PSSF adaptation**: 전역 BFT 합의를 구현하지 않고, assigned validator receipt를 `evidenceHash + computedHash (+ reject resultCode)`가 완전히 같은 그룹끼리만 certificate로 묶는다. client도 certificate의 evidence hash가 자기 command와 같은지 확인한다.
- 가져오지 않은 것: HotStuff의 view/leader/3-chain/global consensus는 사용하지 않는다.

## 5. AOI / interest-driven game distribution

**Ashwin Bharambe, Jeffrey Pang, Srinivasan Seshan. _Colyseus: A Distributed Architecture for Online Multiplayer Games_. NSDI 2006.**

- USENIX: https://www.usenix.org/legacy/event/nsdi06/tech/full_papers/bharambe/bharambe_html/main.html
- PSSF에 빌린 점: 게임 상태 전체를 모든 peer에게 동일 빈도로 전송하지 않고 area-of-interest를 중심으로 분산한다.

**Ashwin Bharambe et al. _Donnybrook: Enabling Large-Scale, High-Speed, Peer-to-Peer Games_. SIGCOMM 2008.**

- 저자 페이지: https://www.cs.cmu.edu/~srini/papers/distapps/2008-Bharambe-sigcomm/
- PSSF에 빌린 점: 관심 집합과 latency-sensitive dissemination을 별도 문제로 다룬다.
- 현재 적용: topology backbone과 AOI simulation link, 1.5-hop discovery를 권위가 다른 계층으로 유지한다.

## 현재 PSSF의 의도적 비적용

- 전역 blockchain / PoW
- 모든 world state에 대한 total-order consensus
- permissionless validator set
- PeerReview 전체 secure-log/signature 체계
- Raft leader/replicated log
- HotStuff view-change/3-chain consensus

즉 논문을 가져오는 기준은 "유명하니까"가 아니라 **지금 가진 문제와 동일한 실패 모드에 대해 이미 검증된 원칙이 있는가**입니다.

## 6. numbered movement timeline + historical shot resolution

**Riot Games. _Peeking into VALORANT's Netcode_ (2020).**

- Riot: https://www.riotgames.com/en/news/peeking-valorants-netcode
- 공개 설명에서 확인되는 점: movement를 fixed-timestep의 numbered move로 다루고, client/server가 move timeline의 대응 관계를 유지한다. 발사 시 server는 현재 world가 아니라 발사자가 보고 있던 simulation time으로 world state를 rewind해 hit registration을 수행한다.
- **PSSF r4 adaptation**: simulation state의 `sequence`와 quorum 대상 `eventSeq`를 분리한다. SHOOT은 `simulationRef(sequence,stateHash)`를 통해 발사 origin/life를 고정하고, `aimX/aimY`만 의도 입력으로 전달한다. event certificate가 늦어도 movement simulation sequence를 막지 않는다.
- 차이: VALORANT는 중앙 authoritative server history를 사용한다. PSSF는 peer가 보존한 bounded historical simulation state와 self-contained checkpoint를 validator가 교차검증한다.

**Yahn W. Bernier / Valve. _Latency Compensating Methods in Client/Server In-game Protocol Design and Optimization_.**

- Valve Developer Community: https://developer.valvesoftware.com/w/index.php?title=Latency_Compensating_Methods_in_Client%2FServer_In-game_Protocol_Design_and_Optimization&uselang=en
- 공개 설명에서 확인되는 점: `usercmd_t`는 view angles, movement intent, attack buttons와 command simulation duration을 전달하며, lag compensation은 command가 생성된 시점의 historical player state로 다른 player들을 되감아 weapon firing을 실행한다.
- **PSSF r4 adaptation**: 발사자가 임의의 authoritative origin을 주장하게 하지 않고 historical simulation reference에서 origin을 얻는다. checkpoint 검증도 validator의 **현재** 좌표와 비교하지 않고 checkpoint item의 simulation sequence에 해당하는 history와 비교한다.
- 가져오지 않은 것: Source/VALORANT의 중앙 서버 rewind 전체를 복제하지 않는다. PSSF의 bounded history/evidence 구조에 필요한 원칙만 사용한다.
