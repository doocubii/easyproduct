---
doc_type: screen-design
doc_id: [scope]-[domain]
title: "화면 설계서 · 도메인: [도메인 한국어 이름]"
version: 1
ssot: prose                 # 글 정의가 원본, screens 블록은 파생 미러
machine:
  lang: json
  tag: screendesign.screens # 이 info-string 블록이 '공식 기계 표현'(화면 인덱스)
  item: screen-list
  schema: ./schemas/screen-design.v1.schema.json
  namespace: FEAT           # 화면 anchor는 FEAT.<domain>.<name>[.<화면종류>]
---

# 화면 설계서 · 도메인: [도메인 한국어 이름]  ({scope} / `FEAT.{domain}.*`)

> 공통 UI 정의·전역 정책은 **인덱스**(`screen-design-{scope}-index.md`)를 참조합니다. 여기서 복제하지 않습니다.
> 화면은 **IA 사이트맵 순서**(홈/허브 → 목록 → 상세 → 쓰기/편집)로 나열합니다.
> 표준·근거는 글 정의(SSOT). 목업은 참고물. 데이터 SSOT는 데이터 모델. 컴포넌트 SSOT는 인벤토리.

## 이 파일 전용 컴포넌트 (로컬)
> 이 도메인 화면(들)에서만 쓰이고 재사용 가능성이 낮은 컴포넌트. 재사용 단위는 중앙 인벤토리(`ssot/ui-components-{scope}.md`)에 둡니다.
> 로컬이라도 ID·파라미터·규격은 동일하게 적습니다(모든 컴포넌트는 ID를 가짐).

### UI.FEAT.{domain}.{기능명}[.{화면종류}].{컴포넌트명}
- 기본 문구(default): …
- 파라미터: label, title 등 (넘기면 그 값, 안 넘기면 기본값)
- Variants / States: …
- 규격: 크기·radius 등 실제 값 (디자인 컨셉 토큰 참조). (백오피스면 절제된 변형 적용)

---

## [화면 이름] (FEAT.{domain}.{기능명}.{화면종류})   ← 예: 멤버 찾기 결과 (FEAT.member.search.list)

### 글 정의
- **구현하는 기능**: `FEAT.{domain}.{기능명}` — IA에서 그대로 가져옴(만들거나 바꾸지 않음).
- **로그인 필요**: `필수` / `무관(콘텐츠 분리)` / `무관(동일)` 중 하나. (GNB 노출 조건과는 별개 — 진입/콘텐츠 문제.)
  - `필수` → 진입 차단. "권한 없음 상태 표준"(index 1부) 적용, "상태·예외"에서는 참조만.
  - `무관(콘텐츠 분리)` → 아래 "보이는 것"·"할 수 있는 일"을 **로그인/비로그인 두 버전**으로.
  - `무관(동일)` → 한 버전.
- **목적**: 한 문장.
- **진입 경로**: 어디서 들어오나.
- **보이는 것 (컴포넌트 · 배치 · 문구 — 전부 고정, 순서 있는 번호 목록)**:
  1. [영역 이름]: `UI.카테고리.컴포넌트(파라미터="값")` 또는 데이터 변수
     - 배치: (예: "가로 3열 그리드(모바일 1열)")
     - 크기: (예: "카드 균등분할, 높이 auto")
     - 간격: (디자인 컨셉 여백 척도 참조 — 예: "gap: spacing.md"; 새 숫자 짓지 않음)
     - 텍스트 위계: (디자인 컨셉 타이포 위계 이름 — 예: "제목 = 큰제목 tier")
     - 문구: 전환 핵심만 리터럴 (title="…", label="…")
  2. …
  - 반응형 전환 지점은 전역 정책의 브레이크포인트 참조. 아이콘·이미지는 **"자리(placeholder)"만 표시**(리소스는 개발 단계).
  - 긴 텍스트는 전역 "긴 텍스트 처리 표준" 참조. 로그인 콘텐츠 분리는 "(조건) → label=…로 교체"로 명시.
- **여기서 할 수 있는 일**: [동작] → [결과]. **동작 대상 컴포넌트(UI ID)를 명시.**
- **상태·예외**: 로딩·빈·오류·권한 없음 → 전역 표준 **참조만**, 이 화면 고유 분기만 서술.
- **(목록형이면 필수)**: 기본 정렬 기준 · 필터 · 페이지네이션 여부.
- **이어지는 화면**: …
- **레이아웃**: 공통 요소는 "공통 GNB 사용"처럼 참조, 고유 영역만 상세히.
- **규칙·금지**: 기획서/IA에서 해당 기능 ID로 지목해 인용 (예: "규칙: `FEAT.{domain}.{기능명}`의 조건 참조").

### 데이터 정의  → 데이터 모델 문서 변수 참조
- **보여주는 정보(읽기)**: `{group}.{field}`, …
- **주고받는 정보(동작 시 입력→출력)**: 동작 "…" → 보냄 `{…}` · 받음 `{…}`
- **요소 ↔ 변수 바인딩**: [요소/컴포넌트 파라미터] ← `{group}.{field}`

### 목업
- (있으면) `temp/mockups/{scope}/목업-[한글이름]([화면 ID]).html` ← 참고물(temp, 재생성 가능). 파일명에 화면 ID 포함. 표준은 위 글 정의.
- (없으면) "목업 없음 — 원하시면 그려드립니다."

---

## [다음 화면 이름] (FEAT.{domain}.{기능명}.{화면종류})
(같은 항목 반복 — 사이트맵 순서로)

---

## (기계 표현) 화면 인덱스

위 화면들의 글 정의에서 뽑은, **소프트웨어가 읽는 사본**입니다. 글 정의(위)가 원본이고, 화면·참조가 바뀌면 이 블록도 함께 갱신합니다. 각 화면의 부모 기능·참조 컴포넌트·참조 데이터를 담아, 소프트웨어가 끊긴 참조를 자동 조회하게 합니다.

```json screendesign.screens
{
  "screens": [
    {
      "id": "FEAT.member.search.list",
      "feat": "FEAT.member.search",
      "components": ["UI.card.default", "UI.FEAT.member.search.list.resultRow"],
      "data": {
        "display": ["request.title", "request.price"],
        "io": [
          { "action": "필터 적용", "ui": "UI.input.select", "sends": ["request.status"], "receives": [] }
        ],
        "bindings": [
          { "ui": "UI.FEAT.member.search.list.resultRow", "vars": ["request.title", "request.price"] }
        ]
      }
    }
  ]
}
```

- `id` = 화면 anchor `FEAT.<도메인>.<기능명>[.<화면종류>]`, `feat` = 부모 기능 ID(IA 확정), `components` = 참조 `UI.*`(UI 축).
- **`data`(데이터 축)는 방향별로 나눈다** — 산문 "데이터 정의"를 그대로 미러(한 통에 뭉뚱그리지 않는다):
  - `display` = 보여주는(읽기) 변수 전부(없으면 `[]`), `io` = 각 동작 `{action,(선택)ui,(선택)op,sends[],receives[]}`(없으면 `[]`), `bindings`(선택) = 요소↔변수 `{ui, vars[]}`.
  - `display`·`io.sends`·`io.receives`·`bindings.vars`는 **데이터 모델 실재 변수만**(내비게이션·결과값은 산문에만). `io.ui`·`bindings.ui`는 컴포넌트 참조.
- 위 예시 1개는 형식 안내용입니다 — 실제로는 이 파일의 **모든 화면**을 담습니다.

### 이 블록으로 소프트웨어가 자동 점검할 수 있는 것

이 인덱스는 사람이 아니라 소프트웨어가 읽는 사본이라, 아래를 자동으로 확인할 수 있습니다(직접 하실 일은 아니고, 참고용입니다).

- **형식 검증** — 화면 `id`가 `FEAT.<도메인>.<기능명>[.<화면종류>]` 꼴인지(화면종류는 list/detail/write/edit), `feat`가 기능 ID 꼴인지.
- **글 정의 ↔ 인덱스 정합** — 위 화면들과 이 인덱스가 서로 어긋나지 않는지.
- **다른 문서와의 참조** — `feat`가 IA(`ia.features`)에, `components`(+`data.io.ui`·`data.bindings.ui`)가 UI 인벤토리(`uicomponents.list`)에, `data.display`·`data.io.sends`·`data.io.receives`·`data.bindings.vars`가 데이터 모델(`datamodel.group`)에 실재하는지(끊긴 참조 적발). 화면 설계서가 FEAT·UI·DATA를 잇는 매듭이라 여기서 세 방향을 한꺼번에 점검한다.
