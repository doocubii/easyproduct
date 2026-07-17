---
doc_type: ui-components
doc_id: [scope]
title: "UI 컴포넌트 인벤토리 ({scope})"
version: 1
ssot: prose                 # 컴포넌트 정의(사람용)가 원본, list 블록은 파생 ID 인덱스
machine:
  lang: json
  tag: uicomponents.list    # 이 info-string 블록이 '공식 기계 표현'(컴포넌트 ID 인덱스)
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

## UI.카테고리.컴포넌트명[.variant]
- 기본 문구(default): 화면에서 값을 안 넘기면 쓰이는 기본값.
- 파라미터: 호출 시 넘길 수 있는 값(예: label, title, desc).
- Variants / States: (예: primary / ghost / disabled, hover)
- 규격: 크기·radius 등 실제 값 (디자인 컨셉 토큰 참조).

### 예시
## UI.button.primary
- 기본 문구(default): "확인"
- 파라미터: label
- Variants / States: primary / secondary / ghost / disabled, hover·pressed
- 규격: 높이 44px, radius `radius.md`, 배경 `color.primary`, 글자 `color.onPrimary`

---

## (기계 표현) 컴포넌트 인덱스

위 컴포넌트 정의의 **ID 목록을 소프트웨어가 읽는 사본**으로 옮긴 것입니다. 위 정의(사람용)가 원본이고, 컴포넌트를 더하거나 빼면 이 블록도 함께 갱신합니다. 이 블록은 전체 스펙이 아니라 **ID 인덱스**입니다(참조 무결성 점검용).

```json uicomponents.list
{
  "components": [
    { "id": "UI.button.primary", "scope": "central", "label": "기본 버튼" }
  ]
}
```

- `id` = 컴포넌트 anchor `UI.*`, `scope` = `central`(중앙 재사용)/`local`(화면 전용).
- 위 예시 1줄은 형식 안내용입니다 — 실제로는 이 인벤토리의 **모든 컴포넌트**를 담습니다(로컬 컴포넌트는 도메인 파일의 인덱스에 담깁니다).

### 이 블록으로 소프트웨어가 자동 점검할 수 있는 것

이 인덱스는 사람이 아니라 소프트웨어가 읽는 사본이라, 아래를 자동으로 확인할 수 있습니다(직접 하실 일은 아니고, 참고용입니다).

- **형식 검증** — `id`가 `UI.*` 꼴인지, `scope` 값이 정해진 목록에 맞는지.
- **정의 ↔ 인덱스 정합** — 위 컴포넌트 정의와 이 인덱스가 서로 어긋나지 않는지.
- **다른 문서와의 참조** — 화면 설계서가 가리키는 `UI.*` 컴포넌트가 실제로 이 인벤토리에 있는지(끊긴 참조 적발), 반대로 아무 화면도 안 쓰는 컴포넌트 탐지.
