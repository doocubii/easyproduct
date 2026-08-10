# spec-kit 생태계와의 중복·빈칸 — 위임 판단 근거

> **조사일 2026-07-28.** Step 0-6(기존 확장 조사)과 "남이 이미 하는 건 하지 않는다" 원칙의 근거다.
> 생태계는 빠르게 바뀌므로, 조사 시점에 대상 프로젝트에서 **실제로 무엇이 깔려 있는지**를 확인한 뒤
> 이 표를 적용한다(이 문서는 판단 틀이지 최신 목록 보장이 아니다).

## 1. `/speckit.analyze`가 실제로 하는 일

| 항목 | 사실 |
|---|---|
| 읽는 것 | `spec.md` · `plan.md` · `tasks.md` · `memory/constitution.md` — **딱 4개** |
| 검사 | 중복 · 모호성 · 미명세 · **헌법 정렬** · 커버리지 갭(요구↔태스크) · 불일치(용어 드리프트·모순) |
| 성격 | **읽기 전용 리포트**(파일 수정 안 함). CRITICAL이면 implement 전 해결 **권고**. 상한 50건 |
| 시점·주체 | **사람이 수동 호출**(tasks.md 생성 후), 수행은 **LLM** |

**우리 규칙과의 관계**

- **⑤·⑦(C3)와 부분 중복**: "spec이 **헌법**을 위반하나"는 analyze가 이미 본다.
- **대체는 불가**: ⓐ 상위 문서가 **헌법 하나뿐** — 기획서·IA·데이터 모델 등은 스코프 밖
  ⓑ **호출해야만 돈다** — 안 돌리면 흔적조차 없다 ⓒ **게이트가 아니다**(권고).
- → **⑦의 설계가 여기서 나왔다.** analyze는 "돌리면 잘 보는 눈"이고, 없는 것은 **"돌렸다는 증거의 강제"**다.
  그래서 ⑦은 리뷰를 **발명하지 않고 analyze에 위임**하며, 검사기는 기록의 **존재·최신성**만 본다.
- **④⑥(C2)와는 중복 0**: analyze는 상위 문서를 읽지 않고 git diff를 보지 않으며 버전·핀 개념이 없다.

## 2. spec-kit 본체의 강제 장치 — 전부 "LLM이 읽는 규범" 층

| 장치 | 강제력 |
|---|---|
| **Constitution Check**(plan 템플릿) | "Phase 0 전에 통과해야 한다"는 게이트지만, 위반해도 **Complexity Tracking에 사유를 적으면 통과**. 스크립트·CI 강제 없음 |
| `/speckit.checklist` | 명세 품질 체크리스트 생성 — LLM |
| `/speckit.review` | 제안 단계 |
| **Extensions 훅**(`.specify/extensions.yml`) | `before_/after_<command>` — **spec-kit 커맨드 실행 시점에만** 발화. 임의 파일 편집·git 커밋은 감시 못 하고, **abort/blocking 메커니즘이 없다** |

> **핵심**: 본체에는 **C1(소스부터 고치기)을 막는 기계 장치가 없다.** 훅은 "spec-kit을 쓸 때"만 걸리는데,
> C1은 정확히 **spec-kit을 안 쓰는** 실패라 원리적으로 안 잡힌다. 그래서 우리 배선은 **에디터 훅·git·CI**
> 쪽에 건다(spec-kit 커맨드 시점이 아니라).

## 3. 커뮤니티 확장 — 이미 존재하는 하네스

| 확장 | 하는 일 | 우리와의 관계 |
|---|---|---|
| **Gates** | 동일 검사를 **에이전트 훅 · git 훅 · CI 3경계**에서 실행. `PreToolUse(Write\|Edit)` 차단, pre-commit, CI. `policy.json` | **배선 사상이 우리 Step 3과 동일.** 검사 내용은 린트·테스트·보호파일·수용기준 실행이지 "spec 없는 코드"가 아니다 → **공존·재사용**: 훅을 새로 깔지 말고 tool gate로 등록 |
| **CI Guard** | 아티팩트 **존재·완결성**, 태스크 완료율 임계, spec↔code 정렬(REQ 매트릭스), 드리프트. `.speckit-ci.yml`, exit 0/1 | **② 완결과 정면 중복** → 있으면 `completeness: "off"`(단 **핀 파일 검사만은 유지** — ④의 전제). ③은 부분 중복이나 우리 쪽은 **명시 태그 기반 결정론**이라 유지 |
| **Blueprint Index** | 맵↔spec↔코드 결정론 CI 게이트. hard(드리프트·dangling)/soft(stale·unmapped), 코드 경로에 `sha=` 베이스라인 | ③⑥과 사상이 유사(마커+베이스라인)하나 축이 **코드↔아키텍처 맵**이다. 있으면 메시지가 겹치지 않게 조정 |
| **Architecture Guard · DocGuard · MemoryLint** | 아키텍처 거버넌스 / 문서↔코드 무결성 / 에이전트 메모리 드리프트 | 축이 다르다. DocGuard는 문서↔코드이고 **상위 문서 버전 추적은 하지 않는다** |

## 4. 위임 결정표 (Step 0-6에서 이 표를 적용한다)

| 우리 규칙 | 기존 도구 | 판정 | 조치 |
|---|---|---|---|
| ① 출처 태그 | 없음 | 고유 | 유지 |
| ② 완결 | **CI Guard** | 중복 | **`off` + 위임 표기**, 핀 파일 검사만 유지 |
| ③ 결합 | CI Guard 정렬(부분)·Blueprint soft | 부분 중복 | 유지(태그 기반이 차별점), 메시지 중복만 조정 |
| ④ 신선도 | **없음** | **고유·핵심** | 유지 |
| ⑤ 근거 | analyze 헌법 정렬(헌법만·LLM) | 거의 고유 | 유지(등기부 결정론) |
| ⑥ 역결합 | **없음** | **고유·핵심** | 유지 |
| ⑦ 리뷰 기록 | 없음 | 고유 | 유지하되 **리뷰 실행은 `/speckit.analyze`에 위임** |

**왜 C2(④⑥)가 빈칸인가**: spec-kit은 **"spec이 세계의 시작"**이라 가정해 **spec 위층 문서가 존재한다는
모델 자체가 없다.** 기획서·SSOT를 먼저 만드는 팀에서만 생기는 실패라서 생태계가 아직 안 본다.

## 4-1. 같은 세트 안의 경계 — `check-docs` ↔ `sdd-check`

위 표는 **외부 도구**를 다룬다. 그런데 easyproduct 세트를 쓰는 프로젝트에는 점검기가 **둘** 있고,
그 경계가 어디에도 안 적혀 있었다. 실제로 한 프로젝트는 `check-docs`를 CI에 안 물려 두어,
새로 생긴 채널(요청서 96건)이 **어느 쪽에서도 검증되지 않는** 상태였다.

```
check-docs.mjs   (easyproduct-suite)   세트 문서 내부   스키마 · 죽은 링크 · 파장 · 신선도
sdd-check.mjs    (이 스킬)             문서 → spec → 코드   핀 · 태그 · 근거 · 역결합
```

- 서로 **import하지 않고 전제하지도 않는다.** 순수 spec-kit 프로젝트에는 `check-docs`가 아예 없다.
- **세트 문서가 있으면 둘 다 CI에 나란히 건다.** 순서는 **문서 세트를 먼저 정합시키고 → 그다음 spec 전파**다
  (반대로 하면 아직 흔들리는 상위를 spec에 핀하게 된다).
- 겹치지 않는다: `ia.md`가 바뀌었을 때 **화면·요청서가 따라가야 하는지**는 `check-docs`,
  **spec 슬라이스가 재검토돼야 하는지**는 `sdd-check`(④)다.

**Step 0 조사에서 세트 문서를 발견하면**(`00-index.md`의 `docbundle.docs`) 리포트에 이 경계를 적고,
`check-docs`가 CI에 물려 있는지 확인해 **안 물려 있으면 함께 걸자고 제안**한다(이 스킬이 대신 깔지는 않는다 —
그건 suite의 자산이다).

## 5. 배포 형태 — 확장으로 포장하지 않는다 (2026-07-28 결정)

이 하네스를 spec-kit 확장으로 포장하는 것은 **배포·발견 경로일 뿐 강제력을 늘리지 않는다**
(본체 훅이 blocking이 아니고 커맨드 시점에만 발화 — 실제 차단은 어차피 git hook/CI).
대신 **나중 포장이 싸도록 규약만 호환**시킨다: 종료코드 `0=pass / 1=fail`, `--json` 출력, 무의존 단일 파일.

## 출처

- [analyze.md](https://github.com/github/spec-kit/blob/main/templates/commands/analyze.md) ·
  [plan-template.md](https://github.com/github/spec-kit/blob/main/templates/plan-template.md) ·
  [extensions.md](https://github.com/github/spec-kit/blob/main/docs/reference/extensions.md)
- [Gates](https://speckit-community.github.io/extensions/gates) ·
  [CI Guard](https://speckit-community.github.io/extensions/ci-guard) ·
  [Blueprint Index](https://speckit-community.github.io/extensions/blueprint-index) ·
  [DocGuard](https://speckit-community.github.io/extensions/docguard) ·
  [커뮤니티 카탈로그](https://github.com/github/spec-kit/blob/main/extensions/catalog.community.json)
