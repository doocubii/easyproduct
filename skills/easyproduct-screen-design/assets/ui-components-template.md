---
doc_type: ui-components
doc_id: [scope]
title: "UI 컴포넌트 인벤토리 ({scope})"
version: 1
ssot: prose                 # 컴포넌트 정의(사람용)가 원본, list 블록은 그 파생 미러
machine:
  lang: json
  tag: uicomponents.list    # 이 info-string 블록이 '공식 기계 표현'(컴포넌트 정의)
  item: component-list
  schema: ./schemas/ui-components.v1.schema.json
  namespace: UI             # 컴포넌트 anchor는 UI.*
---

# UI 컴포넌트 인벤토리 ({scope})

> **컴포넌트의 SSOT입니다.** 화면과 목업은 여기 정의된 값을 **참조**합니다(목업에서 스타일을 새로 짓지 않음).
> 재사용 원자·분자 단위(버튼·입력창·카드·배지·모달·GNB·footer·탭바 등, **2개 이상 화면에서 쓰이는 것**)만 여기 등록합니다.
> 특정 화면 하나의 고유 조합은 **그 도메인 파일의 로컬 컴포넌트**로 둡니다.
> 색·글꼴·크기·radius 등 규격 값은 **디자인 컨셉의 토큰을 참조**해 구체화합니다. (백오피스 범위면 "절제된 변형" 적용.)
>
> **다국어 확장 대비**: 지금은 문구를 문자열 하나로 두되, 나중에 `{ko:"…", en:"…"}` 같은 언어별 키로 확장 가능한 구조입니다.
> (백오피스 인벤토리는 상단에 "사용자 앱 디자인 컨셉의 절제된 변형 — 무엇을 어떻게 조정했는지"를 한 줄씩 명시.)

## 조회 먼저 → 기존 흡수
새 컴포넌트가 필요하면 먼저 이 파일을 조회해 비슷한 게 있으면 재사용하고, 진짜 다를 때만 신규 등록합니다.

---

## UI.카테고리.컴포넌트명[.variant] — [컴포넌트 이름]
- 기본 문구(default): 화면에서 값을 안 넘기면 쓰이는 기본값. (없으면 생략)
- 파라미터: **항목별로 이름·종류·필수·뜻을 풀어쓴다**(뜻 없는 이름만 나열 금지 — 뜻을 모르면 나중에 기계·사람이 판단 못 한다).
  - `paramName` (`string`/`number`/`boolean`/`list`/`node` · 필수/선택) — 무엇을 뜻하는지 한 줄. (값이 정해지면) 값: `a` / `b` / `c`
- Variants / States: **항목별로 이름·뜻**.
  - `variantName` — 그 상태가 무엇인지 한 줄
- 규격: 크기·radius 등 실제 값 (디자인 컨셉 토큰 참조).

### 예시
## UI.button.primary — 기본 버튼
- 기본 문구(default): "확인"
- 파라미터:
  - `label` (`string` · 선택) — 버튼에 표시할 문구. 안 넘기면 "확인".
  - `disabled` (`boolean` · 선택) — 비활성 여부.
  - `loading` (`boolean` · 선택) — 처리 중 스피너 표시.
- Variants / States:
  - `primary` — 기본(주색 채움)
  - `hover` — 마우스 오버(진남색)
  - `disabled` — 비활성(면색 배경·흐린 글자)
  - `loading` — 처리 중(스피너·비활성)
- 규격: 높이 44px, radius `radius.md`, 배경 `color.primary`, 글자 `color.onPrimary`

---

## (기계 표현) 컴포넌트 정의

위 컴포넌트 정의를 **소프트웨어가 읽는 사본**으로 옮긴 것입니다. 위 정의(사람용)가 원본이고, 컴포넌트를 더하거나 빼거나 고치면 이 블록도 함께 갱신합니다. **id 목록에 그치지 않고 각 컴포넌트의 파라미터·variants·규격까지** 담아, 소프트웨어가 산문을 파싱하지 않고도 컴포넌트를 이해하게 합니다.

```json uicomponents.list
{
  "components": [
    {
      "id": "UI.button.primary",
      "scope": "central",
      "label": "기본 버튼",
      "default": "확인",
      "params": [
        { "name": "label",    "type": "string",  "required": false, "desc": "버튼에 표시할 문구(안 넘기면 \"확인\")" },
        { "name": "disabled", "type": "boolean", "required": false, "desc": "비활성 여부" },
        { "name": "loading",  "type": "boolean", "required": false, "desc": "처리 중 스피너 표시" }
      ],
      "variants": [
        { "name": "primary",  "desc": "기본(주색 채움)" },
        { "name": "hover",    "desc": "마우스 오버(진남색)" },
        { "name": "disabled", "desc": "비활성(면색 배경·흐린 글자)" },
        { "name": "loading",  "desc": "처리 중(스피너·비활성)" }
      ],
      "spec": "높이 44px, radius radius.md, 배경 color.primary, 글자 color.onPrimary"
    }
  ]
}
```

- `id`·`scope`·`spec`은 필수. `default`는 있으면. **`params`·`variants`는 이름만이 아니라 `desc`(뜻)까지** 담는다 — 이름만 있으면 나중에 기계·사람이 뜻을 판단할 수 없다(뜻 없는 항목 금지). `params`의 `type`은 영문(`string`/`number`/`boolean`/`list`/`node`), 값이 정해지면 `values`에 담는다(예: `state` → `["guest","member","orgAdmin"]`).
- 위 예시는 형식 안내용입니다 — 실제로는 이 인벤토리의 **모든 컴포넌트**를 위 산문 정의 그대로 옮겨 담습니다(로컬 컴포넌트는 도메인 파일의 인덱스에 담깁니다).

### 이 블록으로 소프트웨어가 자동 점검할 수 있는 것

이 인덱스는 사람이 아니라 소프트웨어가 읽는 사본이라, 아래를 자동으로 확인할 수 있습니다(직접 하실 일은 아니고, 참고용입니다).

- **형식 검증** — `id`가 `UI.*` 꼴인지, `scope` 값이 정해진 목록에 맞는지.
- **정의 ↔ 인덱스 정합** — 위 컴포넌트 정의와 이 인덱스가 서로 어긋나지 않는지.
- **다른 문서와의 참조** — 화면 설계서가 가리키는 `UI.*` 컴포넌트가 실제로 이 인벤토리에 있는지(끊긴 참조 적발), 반대로 아무 화면도 안 쓰는 컴포넌트 탐지.
