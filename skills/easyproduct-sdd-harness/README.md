# easyproduct-sdd-harness

> spec-kit(SDD) 프로젝트에서 "모든 개발이 실제로 spec-kit을 거치도록" 강제하는 **게이트를 설치·배선**해 주는 개발자용 스킬입니다(installer/wirer). 정책 파일·검사기·훅·CI 배선과 규약 README를 깔아 주되, **제품 요구·설계의 SSOT(기획서·spec·plan)는 저작하지 않습니다** — 그건 사용자와 spec-kit의 몫이고, 하네스는 그것이 지켜지는지를 봅니다.

[easyproduct 스킬 세트](../../README.md)의 일부입니다. 다만 이 스킬은 **다른 스킬과 완전히 독립**이며, easyproduct 문서가 하나도 없는 순수 spec-kit 프로젝트에서도 완결 동작합니다.

## 무엇을 하나
- **실전 실패 3종을 막습니다**: ① 에이전트가 SDD 절차 없이 **소스부터 고치는 것**, ② 기획서·SSOT·헌법 같은 **상위 문서가 바뀌었는데 spec-kit 흐름을 타지 못하는 것**, ③ **상위와 충돌하는 spec 수정**.
- **7규칙 3축**을 검사합니다 — 코드 층(출처 태그·완결·결합), 전파 층(역결합·신선도 이중 핀), 내용 층(근거 앵커·리뷰 기록).
- **조사(audit)를 먼저** 합니다: spec-kit 유무·스택·상위 문서 형식·SDD 규범 유무·기존 게이트·**이미 깔린 spec-kit 확장**·관장 사각·하네스 설치 상태·**모노레포 여부** 9항목.
- **4층으로 배선**합니다: 세션 브리핑 → 편집 훅 → `verify` → **CI(실제 차단)**.
- **남이 이미 하는 검사는 위임**합니다: 아티팩트 완결성은 CI Guard에, 의미 리뷰 실행은 `/speckit.analyze`에, 배선은 Gates의 3경계에.
- 브라운필드는 **`warn`으로 시작**해 정리 후 `block`으로 전환하고, **핀 → 태그 → ⑤⑦ 순서**로 롤아웃합니다(핀이 없으면 신선도가 침묵해 핵심 가치가 0으로 남습니다).

## 언제 쓰나
- "SDD가 안 지켜진다", "에이전트가 spec 없이 코드부터 고친다", "spec-kit을 강제하고 싶다"고 할 때.
- "기획서(SSOT)를 고쳤는데 spec에 반영이 안 된다", "상위 문서 변경이 흐름을 안 탄다"고 할 때.
- "spec이 기획서와 어긋나는 걸 막고 싶다"고 할 때.
- 이미 깔린 하네스를 점검·업그레이드할 때(재실행은 멱등).

**발동 조건은 대상 프로젝트의 spec-kit(`.specify/`) 존재**입니다. 없으면 "spec-kit init 먼저"를 안내하고 중단합니다.

## 산출물 (대상 프로젝트에 설치)
- `sdd-policy.json` — 검사기·훅이 읽는 유일한 설정. 프로젝트마다 이 파일만 다릅니다.
- 검사기 파일 — **무의존 단일 파일**. Node·Python은 동봉된 참조 구현을 복사하고, 그 외 런타임은 수도코드로 생성합니다. 종료코드 `0`(통과)/`1`(위반)/`2`(설정 오류), `--full`·`--changed`·`--json` 지원.
- 배선 — `verify`·CI·pre-commit, (Claude Code면) `SessionStart`·`PostToolUse` 훅.
- `specs/<slug>/sources.json`(이중 핀) · `specs/<slug>/upstream-check.md`(리뷰 기록) · `.specify/sdd-sources.json`(전역 핀) 템플릿.
- 짧은 README — 태그 규약·핀·예외·재검토 절차.

## 단독 실행 vs 세트
- **완전히 단독으로 동작합니다.** 다른 easyproduct 스킬을 호출하지 않고, easyproduct 문서를 전제하지 않습니다.
- easyproduct 문서가 있으면 **문서 어댑터**가 켜져 정밀도가 올라갑니다(기계 블록에서 앵커 등기부를 만들고, 상위 변경의 영향을 **앵커 단위**로 좁힙니다). 없으면 `generic` 어댑터로 헤딩·`REQ-*` 규칙을 쓰고, 등기부를 만들 수 없으면 해당 규칙만 끄고 그 사실을 리포트에 적습니다.
- 세트의 문서 점검기(`check-docs.mjs`)와는 **별개**입니다 — 그쪽은 easyproduct 문서 세트의 앵커를, 이쪽은 spec-kit 프로세스·코드 출처를 봅니다. 서로 전제하거나 import하지 않습니다.

## 정직한 한계
7규칙은 **의례·공존을 강제**할 뿐 **인과적 파생·의미 정합을 검증하지 않습니다.** 태그만 붙이기, 슬라이스 no-op 편집, 핀 숫자만 갱신, 기록 형식만 채우기로 우회할 수 있습니다. **기계 통과 ≠ 검증 완료** — 프로세스 생략을 가시화·유료화하는 forcing function이고, 우회 흔적이 커밋 히스토리와 리뷰에 남는 것이 실제 효용입니다. 에이전트가 로컬 훅 배선을 고칠 수 있으므로 **CI가 최종 backstop**입니다.

## 구성 파일
- `SKILL.md` — 스킬 본문(경계·7규칙·설치 절차 Step 0~6·위임 규칙·한계).
- `scripts/sdd-check.mjs` · `scripts/sdd_check.py` — **참조 구현 2종**(무의존 Node ESM / Python 3.8+). 7규칙 전부 구현, 정책 파일만 읽으며, 같은 입력에서 서로 동일한 결과를 냅니다.
- `scripts/parity-test.sh` — 임시 더미 프로젝트를 만들어 **두 구현의 `--json`·종료코드 동등성과 회귀**를 검사합니다(구현·정본 수정 후 필수).
- `references/checker-pseudocode.md` — **검사기 정본**. 7규칙 알고리즘·자료구조·리포트·종료코드(언어 무관).
- `references/stack-adapters.md` — 스택별 관장 glob·주석 문법·allowlist·통합 지점 기본값.
- `references/monorepo.md` — 저장소 루트가 spec-kit 루트와 다를 때(모노레포)의 함정과 처치.
- `references/ecosystem-overlap.md` — spec-kit 본체·커뮤니티 확장 조사와 위임 판단표.
- `assets/` — 정책·핀·리뷰 기록·프로젝트 README 템플릿.

## 버전
- easyproduct 세트 `0.12.2`의 일부입니다. 버전 규칙은 [VERSIONING.md](../../VERSIONING.md), 변경 내역은 [CHANGELOG.md](../../CHANGELOG.md)를 보세요.
