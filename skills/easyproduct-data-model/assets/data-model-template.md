---
doc_type: data-model
doc_id: [서비스-slug]
title: "데이터 모델: [서비스 이름]"
version: 1
ssot: table                 # 원본은 표, JSON 블록은 파생 미러
machine:
  lang: json
  tag: datamodel.group      # 이 info-string을 가진 코드블록이 '공식 기계 표현'
  item: group               # 블록 1개 = 데이터 그룹 1개
  schema: ./schemas/data-model.v1.schema.json
  namespace: DATA           # 그룹 anchor는 DATA.<group> (크로스도큐먼트 참조용)
---

# 데이터 모델: [서비스 이름]

> 이 데이터 모델은 데이터(정보 항목·이름·구조)에 관해 기획서를 포함한 다른 어떤 문서보다
> 우선하는 기준(SSOT)이다. 데이터를 바꿀 때는 이 문서에서 바꾼다.
>
> 이 표를 고칠 때는 아래를 지킨다:
> - 이름은 `그룹.필드` 형식을 유지한다(그룹=영문 소문자 단수, 필드=camelCase).
> - 새 필드를 추가하기 전에 같은 뜻의 필드가 이미 있는지 표를 먼저 훑는다(중복 방지).
> - 필드를 삭제하거나 이름을 바꾸면, 그 변수를 쓰는 화면·코드 전체를 함께 갱신한다.
> - 새 그룹(덩어리) 추가는 정보 구조를 바꾸는 일이니 신중히 판단한다. 되도록 기존 그룹 안에서 해결한다.
> - 애매하면 임의로 만들지 말고 기존 규칙(공통 관리 필드·표준 프리셋)을 참고해 일관되게 정한다.
>
> **각 그룹 표 바로 아래에는 그 그룹 구조를 담은 JSON 블록**이 있습니다(소프트웨어가 바로 읽도록).
> **표가 원본(SSOT)이고 JSON은 그 미러**입니다 — 표를 고치면 JSON을 다시 생성해 맞추고, **JSON을 손으로 고치지 않습니다.**
> JSON 표기 규칙: 코드블록은 ` ```json datamodel.group `으로 태깅하고, 각 블록 맨 위에 그룹 anchor `"id": "DATA.<group>"`를 둔다.
> 타입은 영문(`string`/`number`/`datetime`/`date`/`boolean`/`list`/`image`),
> `filledBy`는 `system`/`user`, 필드명은 그룹 상단 `group` + 짧은 `name`(전체 변수는 `그룹.name`).
> 다른 문서는 이 그룹을 `DATA.<group>`으로, 필드를 `<group>.<name>`으로 참조한다.

---

## 그룹(정보 묶음) 한글 대응표

| 그룹(영문) | 한글 이름 | 무엇을 담나 |
|---|---|---|
| `user` | 회원 | 이 서비스에 가입한 사용자 |
| `request` | 요청 | 회원이 올리는 요청 |

> 그룹 = 성격이 같은 데이터의 묶음. 아래에 그룹마다 표가 하나씩 있습니다.

---

## 회원 (`user`)

이 서비스에 가입한 사용자.

| 변수명 | 한글명 | 종류 | 필수 | 설명 | 누가 넣나 |
|---|---|---|---|---|---|
| `user.id` | 회원의 고유 번호 | 글자 | 필수 | 회원을 구별하는 고유 식별값 | 시스템 |
| `user.createdAt` | 회원의 가입 일시 | 날짜 | 필수 | 데이터가 처음 만들어진 시각 | 시스템 |
| `user.updatedAt` | 회원의 수정 일시 | 날짜 | 필수 | 데이터가 마지막으로 바뀐 시각 | 시스템 |
| `user.status` | 회원의 상태 | 글자 | 필수 | 활성/정지/탈퇴 등 | 시스템 |
| `user.email` | 회원의 이메일 | 글자 | 필수 | 로그인·연락에 쓰는 이메일 | 사용자 |
| `user.nickname` | 회원의 닉네임 | 글자 | 선택 | 다른 사용자에게 보이는 이름 | 사용자 |

**관계**: 회원 한 명은 요청(`request`)을 여러 개 만들 수 있다.

```json datamodel.group
{
  "id": "DATA.user",
  "group": "user",
  "label": "회원",
  "description": "이 서비스에 가입한 사용자.",
  "fields": [
    { "name": "id",        "label": "회원의 고유 번호", "type": "string",   "required": true,  "filledBy": "system", "description": "회원을 구별하는 고유 식별값" },
    { "name": "createdAt", "label": "회원의 가입 일시", "type": "datetime", "required": true,  "filledBy": "system", "description": "데이터가 처음 만들어진 시각" },
    { "name": "updatedAt", "label": "회원의 수정 일시", "type": "datetime", "required": true,  "filledBy": "system", "description": "데이터가 마지막으로 바뀐 시각" },
    { "name": "status",    "label": "회원의 상태",     "type": "string",   "required": true,  "filledBy": "system", "description": "활성/정지/탈퇴 등" },
    { "name": "email",     "label": "회원의 이메일",   "type": "string",   "required": true,  "filledBy": "user",   "description": "로그인·연락에 쓰는 이메일" },
    { "name": "nickname",  "label": "회원의 닉네임",   "type": "string",   "required": false, "filledBy": "user",   "description": "다른 사용자에게 보이는 이름" }
  ],
  "relations": [
    { "type": "hasMany", "target": "request", "description": "회원 한 명은 요청을 여러 개 만들 수 있다." }
  ]
}
```

---

## 요청 (`request`)

회원이 올리는 요청.

| 변수명 | 한글명 | 종류 | 필수 | 설명 | 누가 넣나 |
|---|---|---|---|---|---|
| `request.id` | 요청의 고유 번호 | 글자 | 필수 | 요청을 구별하는 고유 식별값 | 시스템 |
| `request.createdAt` | 요청의 등록 일시 | 날짜 | 필수 | 요청이 처음 만들어진 시각 | 시스템 |
| `request.updatedAt` | 요청의 수정 일시 | 날짜 | 필수 | 요청이 마지막으로 바뀐 시각 | 시스템 |
| `request.title` | 요청의 제목 | 글자 | 필수 | 목록에 보이는 제목 | 사용자 |
| `request.applicantCount` | 요청의 지원자 수 | 숫자 | 선택 | 이 요청에 지원한 사람 수 | 시스템 |

**관계**: 요청 하나는 회원(`user`) 한 명에게 속한다.

```json datamodel.group
{
  "id": "DATA.request",
  "group": "request",
  "label": "요청",
  "description": "회원이 올리는 요청.",
  "fields": [
    { "name": "id",             "label": "요청의 고유 번호", "type": "string",   "required": true,  "filledBy": "system", "description": "요청을 구별하는 고유 식별값" },
    { "name": "createdAt",      "label": "요청의 등록 일시", "type": "datetime", "required": true,  "filledBy": "system", "description": "요청이 처음 만들어진 시각" },
    { "name": "updatedAt",      "label": "요청의 수정 일시", "type": "datetime", "required": true,  "filledBy": "system", "description": "요청이 마지막으로 바뀐 시각" },
    { "name": "title",          "label": "요청의 제목",     "type": "string",   "required": true,  "filledBy": "user",   "description": "목록에 보이는 제목" },
    { "name": "applicantCount", "label": "요청의 지원자 수", "type": "number",   "required": false, "filledBy": "system", "description": "이 요청에 지원한 사람 수" }
  ],
  "relations": [
    { "type": "belongsTo", "target": "user", "description": "요청 하나는 회원 한 명에게 속한다." }
  ]
}
```

---

## "누가 넣나" 읽는 법

이 열은 **그 값을 누가 채우는지** 한 가지만 알려 줍니다.

- **시스템**: 서비스가 자동으로 만들어 관리하는 값입니다(고유 번호·만든 시각·수정 시각·상태, 자동으로
  세는 개수 등). 사람이 입력하지 않으므로 **입력 화면에 칸이 생기지 않습니다.**
- **사용자**: 사람이 직접 입력하거나 선택해서 들어오는 값입니다. **입력 화면에 칸이 필요합니다.**

> 이 열은 "값을 누가 채우나"만 말합니다. **이 항목이 어디서 왔는지**(외부 연동·가져오기 등)나
> **이 항목을 누가 문서에 넣었는지**(스킬이 자동으로 깔았는지, 직접 요청했는지)와는 상관없습니다.

---

## 이 JSON 블록으로 소프트웨어가 자동 점검할 수 있는 것

각 그룹 표 아래의 JSON 블록은 사람이 아니라 **소프트웨어가 읽는 사본**입니다. 이 블록이 있으면 아래를 자동으로 확인할 수 있습니다(직접 하실 일은 아니고, 참고용입니다).

- **형식 검증** — `type`·`filledBy` 등 값이 정해진 목록에 맞는지. 오타·잘못된 값(예: `type:"text"`)을 자동으로 잡아냅니다.
- **표↔JSON 정합** — 사람용 표의 필드와 JSON 사본의 필드가 서로 어긋나지 않는지.
- **이름 규칙** — `id`가 `DATA.<group>` 꼴이고 `group` 값과 맞는지, 변수명이 `<group>.<name>` 꼴인지.
- **관계 확인** — `relations`의 `target`이 실제 존재하는 그룹을 가리키는지.
- **다른 문서와의 참조** — 다른 문서·화면이 가리키는 `DATA.<group>`/필드가 실제로 여기 있는지(끊긴 참조 적발), 반대로 아무 데서도 안 쓰는 필드 탐지.

---

## 자동으로 넣은 것
스킬이 자동으로 채운 것. 확인하고 필요 없으면 빼 달라고 하세요.
- 모든 그룹에 관리 필드(`id`·`createdAt`·`updatedAt`) 자동 포함
- `user` 그룹에 회원 표준 필드(`email`·`nickname`·`status`) 자동 포함

## 가정
사용자가 말하지 않아 임의로 정한 것.
- 회원 로그인은 이메일 기준으로 가정

## 아직 안 정한 것
나중에 정하면 되는 것들.
- [확인 필요: `request`에 마감일(`dueDate`)이 필요한지]
