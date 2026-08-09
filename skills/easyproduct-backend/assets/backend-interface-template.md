---
doc_type: backend-interface
version: 1
revision: 1
ssot: prose
machine:
  lang: json
  tag: backend.interfaces
  item: domain
  schema: ../schemas/backend-interface.v1.schema.json
  namespace: BEITF
---

# 인터페이스 계약: [서비스 이름] — [범위(사용자 앱 / 백오피스)]

> 이 문서는 **인터페이스 계약**에 관해 다른 어떤 문서보다 우선하는 기준(SSOT)이다. 프론트의 API 요청서
> 요구(화면 io·요청서·운영 요구)는 "무엇을 보내고 받아야 하는지"이고, **경로·method·상태코드·오류
> 체계·응답 봉투·인증 적용은 이 문서가 확정한다.** 요청서의 `example`은 예시였을 뿐이므로 이 문서와
> 다르면 **이 문서가 맞다.**
>
> 다만 **데이터의 뜻과 필드 구성은 데이터 모델 문서가, 제품 규칙은 정책서가** 여전히 기준이다.
>
> 이 문서를 고칠 때는 아래를 지킨다:
> - `BEITF.*` ID는 한 번 부여하면 바꾸지 않는다. 뜻이 바뀌면 새 ID를 만든다.
> - 산문을 고치면 아래 JSON 블록을 **산문 기준으로 다시 생성**한다(JSON을 손으로 고치지 않는다).
> - **쓰기 인터페이스에는 반드시 멱등성**(같은 요청이 두 번 와도 안전한가)을 적는다.
> - 오류는 상태코드만이 아니라 **언제 나는지**를 함께 적는다.
> - **언어·프레임워크는 이 문서가 정하지 않는다.**
>
> **함께 보는 문서**: 아키텍처 `backend-architecture.md`(인증 모드 등기부·횡단 규약) · 저장 설계
> `backend-storage.md` · 데이터 모델 `data-model.md` · API 요청서 `api-requests/`

## 공통 규약

[아키텍처 문서의 횡단 규약을 한 번 요약해 옮긴다 — 응답 봉투·오류 코드 체계·페이징·정렬·시간 표기.
정본은 아키텍처 문서이며 여기서 다시 정하지 않는다.]

## 인증 모드

[여기서 쓰는 모드 목록만 한 줄씩. 정의는 아키텍처 문서의 `authModes`가 정본이다.]

---

## [도메인 한글 이름] (`[domain]`)

[이 도메인이 무엇을 다루는지 한두 줄.]

### `BEITF.[scope].[domain].[name]` — [한 줄 요약]

- **경로**: `[METHOD] [path]`
- **인증**: `[mode]` — [무엇을 막고 무엇을 통과시키나] · 추가 판정: [소유자 본인 등, 근거 `POL.*`]
- **보내는 것**: [필드 목록 — 어디로(경로/질의/본문), 뜻, 데이터 모델 변수]
- **돌려주는 것**: `[성공 상태코드]` — [필드 목록]
- **오류**: `[상태코드] [코드]` — [언제] (근거 `POL.*`)
- **멱등성**: [같은 요청이 두 번 오면 어떻게 되나]
- **근거(basis)**: [갈래와 참조를 나열 — 예: 화면 `FEAT.order.create.submit` · 운영 요구 "야간 정산"(사유 필수)]
- **읽고 쓰는 저장소**: `BESTORE.*`
- **비고**: [요청서와 다르게 확정했으면 그 이유]

[인터페이스마다 위 구조를 반복한다.]

---

## 기계용 블록

아래 블록은 위 산문의 **미러**다. 산문이 원본이며, 산문을 고치면 이 블록을 다시 생성한다.
**손으로 고치지 않는다.** 도메인 하나 = 블록 하나이며, **산문에 적은 인터페이스를 빠짐없이 담는다.**

```json backend.interfaces
{
  "domain": "[domain]",
  "scope": "user",
  "basePath": "[공유 경로 접두]",
  "interfaces": [
    {
      "id": "BEITF.user.[domain].[name]",
      "summary": "[한 줄]",
      "transport": "rest",
      "binding": { "method": "POST", "path": "[경로]", "status": 200 },
      "auth": {
        "mode": "[모드]",
        "desc": "[무엇을 막고 통과시키나]",
        "checks": ["[추가 판정] (POL.[도메인].[규칙])"]
      },
      "request": {
        "contentType": "application/json",
        "fields": [
          { "name": "[이름]", "in": "body", "type": "string", "required": true, "desc": "[뜻]", "dataModel": "[group].[field]" }
        ]
      },
      "response": {
        "successStatus": 200,
        "envelope": "[봉투 이름]",
        "fields": [
          { "name": "[이름]", "type": "string", "desc": "[뜻]", "dataModel": "[group].[field]" }
        ],
        "errors": [
          { "status": 403, "code": "[코드]", "when": "[언제]", "policy": "POL.[도메인].[규칙]" }
        ]
      },
      "basis": [
        { "kind": "screen-io", "ref": "FEAT.[도메인].[화면].[동작]" },
        { "kind": "ops", "ref": "[화면 없는 요구 이름]", "why": "[왜 이 인터페이스가 필요한지]" }
      ],
      "reads": ["BESTORE.[저장소]"],
      "writes": ["BESTORE.[저장소]"],
      "idempotency": "[같은 요청이 두 번 오면]",
      "notes": ""
    }
  ]
}
```

### 이 블록으로 소프트웨어가 자동 점검할 수 있는 것

- **ID 형식** — `BEITF.<scope>.<도메인>.<이름>`이 규칙대로인지, 전역 유일한지.
- **요청 커버리지** — 모든 요구(화면 io·요청서·운영 요구)가 어느 인터페이스의 `basis`에 담겼는지(빠진 요청 = 프론트가
  부를 API 없음).
- **죽은 링크** — `auth.mode`가 아키텍처의 `authModes`에, `reads`/`writes`가 저장 설계의 `stores`에,
  `dataModel`이 데이터 모델에, `basis[].ref`가 그 갈래의 등기부에 실재하는지(등기부 없는 갈래는 `why`가 있는지).
- **경로 충돌** — 같은 `method`+`path`가 둘 이상인지.
- **빠진 내용** — 쓰기 인터페이스에 `idempotency`가, 필드에 `desc`가 비어 있지 않은지.

이 계약이 제품 규칙을 맞게 반영했는지(이 오류가 정말 이 상황에서 나야 하는가)는 소프트웨어가 판단할 수
없다 — 사람 또는 LLM의 풀 리뷰 몫이다.
