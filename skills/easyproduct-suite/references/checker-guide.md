# 점검자 개발 가이드 (checker-guide) — frontmatter·기계 블록 계약

> **독자**: easyproduct 문서 세트를 **읽고 점검하는 소프트웨어(점검자·하네스·CI)를 만드는 개발자 또는 에이전트.**
> 이 문서는 각 문서의 frontmatter와 기계 블록이 **무엇을 뜻하고, 점검자가 그 값으로 무엇을 해야 하는지**를 규정하는 단일 근거다.
> (문서를 *만드는* 규칙은 각 스킬의 SKILL.md에 있다. 이 문서는 *소비하는* 쪽의 계약이다.)

## 왜 이 문서가 필요한가

각 문서는 사람용 표현(표·산문)과 **기계용 블록**(태그된 ```json 코드블록)을 함께 담는다. 문서 맨 앞 **frontmatter**가 "이게 무슨 문서이고, 기계 블록을 어디서·어떤 계약으로 찾는지"를 선언한다.

**스키마는 값의 *구조*만 강제한다(예: `ssot`는 `table|prose`). 값으로 *무엇을 할지*(행동)는 스키마가 정의하지 못한다 — 그건 이 계약서가 규정하고, 점검자 코드가 구현한다.** 즉 점검자는 frontmatter를 보고 이 문서의 규정대로 동작해야 하며, 필드 자체가 사용법을 알려주지는 않는다.

## frontmatter 필드 명세

| 필드 | 필수 | 값 | 점검자가 할 일 |
|---|---|---|---|
| `doc_type` | ✅ | kebab-case (아래 레지스트리) | 문서 종류 식별. 매니페스트의 `docType`과 대조. |
| `version` | ✅ | 정수 | payload 계약 버전. `v1` 문서는 언제나 v1 스키마로 검증. |
| `ssot` | ✅ | `table` \| `prose` | drift 수리 방향. `table`=사람용 표가 원본·기계 블록은 미러 / `prose`=산문이 원본. 표↔블록이 어긋나면 **원본 쪽 기준으로** 블록을 재생성해야 한다(점검자는 어긋남을 보고, 재생성 주체는 스킬/LLM). |
| `machine.lang` | – | `json` | 기계 블록의 언어(현재 항상 json). |
| `machine.tag` | 기계블록 있으면 ✅ | info-string (아래) | 이 tag를 info-string으로 가진 fenced 코드블록만 "공식 기계 표현"이다. 추측하지 말고 이 tag로 찾는다. |
| `machine.item` | – | 설명용 라벨 | 블록 1개의 단위(group / feature-list 등). 정보성. |
| `machine.schema` | 기계블록 있으면 ✅ | 상대경로 | 그 문서 옆 `./schemas/*.json`. 기계 블록을 이 JSON Schema로 검증. |
| `machine.namespace` | – | `DATA`/`FEAT`/`POL`/`UI`/`SCN`/`token` | 이 문서가 소유·발행하는 anchor의 접두사. |

- **`machine.*`가 없는 frontmatter**: 그 문서는 기계 블록이 없는 **식별 전용**(예: `plan`·`terms-privacy`·`screen-design-index`). 점검자는 `doc_type`만 읽고 스키마 검증은 건너뛴다.

## 기계 블록을 찾는 법

1. frontmatter에서 `machine.tag`를 읽는다(없으면 이 문서는 스킵).
2. 본문에서 info-string이 그 tag와 **정확히 일치**하는 fenced 코드블록만 고른다:
   ` ```json <tag> ` … ` ``` `. (info-string 첫 토큰 `json`은 하이라이트용, 그다음 토큰이 tag.)
3. 각 블록을 JSON 파싱 → `machine.schema`가 가리키는 스키마로 검증.

## doc_type 레지스트리

| doc_type | 기계 블록 tag | 스키마 | 소유 anchor | ssot |
|---|---|---|---|---|
| `plan` | (없음) | – | – | prose |
| `design-doc` | (없음) | – | – | prose |
| `user-stories` | (없음) | – | – | prose |
| `ia` | `ia.features` | ia.v1 | `FEAT.<domain>.<name>` | prose |
| `data-model` | `datamodel.group` | data-model.v1 | `DATA.<group>` | table |
| `design-concept` | `design.tokens` | design.v1 | `token`(color.*/spacing.*/…) | prose |
| `policy` | `policy.rules` | policy.v1 | `POL.<domain>.<rule>` | prose |
| `terms-privacy` | (없음) | – | – | prose |
| `screen-design` | `screendesign.screens` | screen-design.v1 | 화면 `FEAT.<d>.<n>[.<화면종류>]` | prose |
| `screen-design-index` | (없음) | – | – | prose |
| `ui-components` | `uicomponents.list` | ui-components.v1 | `UI.*` | prose |
| `scenario` | `scenario.trace` | scenario.v1 | `SCN.<domain>.<name>` | prose |
| `doc-bundle-index` | `docbundle.docs` | docbundle.v1 | (세트 매니페스트) | table |

## anchor·네임스페이스 레지스트리 (크로스도큐먼트 참조 라우팅)

문서 어디에 아래 ID가 나오면, **접두사가 곧 "어느 등기부에서 조회할지"의 타입 표시**다. 점검자는 접두사로 라우팅해 실재 여부를 확인한다(끊긴 참조=죽은 링크).

| 참조 형태 | 무엇 | 어느 블록에서 조회 |
|---|---|---|
| `FEAT.<domain>.<name>` | 기능 | `ia.features`의 `features[].id` |
| `FEAT.<d>.<n>.<list\|detail\|write\|edit>` | 화면 | `screendesign.screens`의 `screens[].id` |
| `<group>` 또는 `DATA.<group>` | 데이터 그룹 | `datamodel.group`의 `id`/`group` |
| `<group>.<field>` | 데이터 필드 | `datamodel.group`의 해당 그룹 `fields[].name` |
| `POL.<domain>.<rule>` | 정책 규칙 | `policy.rules`의 `rules[].id` |
| `UI.*` | 컴포넌트 | `uicomponents.list`의 `components[].id`(+ 화면 파일의 로컬) |
| `SCN.<domain>.<name>` | 시나리오 | `scenario.trace`의 `scenarios[].id` |
| `color.*` `spacing.*` `radius.*` `type.*` | 디자인 토큰 | `design.tokens`의 `tokens.<category>.<name>` |

> **데이터 필드만 접두사가 없다**(`user.email`처럼). 규칙: `<X>.<Y>` 꼴이고 `X`가 `datamodel.group`의 어떤 그룹 로컬 이름과 같으면 데이터 필드로 해석한다. (그룹 anchor는 `DATA.` 접두사가 붙지만 필드는 안 붙인다 — 사람용 표 가독성 유지 결정.)

## 점검자가 해야 할 일 (권장 알고리즘)

1. **문서 발견**: `doc-bundle-index`(00-index.md)의 `docbundle.docs` 매니페스트에서 세트의 모든 문서·타입·경로를 얻는다. 매니페스트가 없으면 폴더를 훑는다.
2. **경로·frontmatter 대조**: 각 `path`가 실재하고, 그 파일 frontmatter의 `doc_type`이 매니페스트 `docType`과 같은지.
3. **스키마 검증**: `machine.tag` 블록을 `machine.schema`로 검증(형식·enum·anchor 패턴). 위반은 그 문서의 문제.
4. **크로스도큐먼트 참조 무결성**: 위 레지스트리대로 접두사 라우팅 → 실재 확인. 끊긴 참조 보고.
5. **drift(정합) 점검**: 사람용 표현과 기계 블록이 어긋나는지. `ssot`가 가리키는 원본 쪽을 진실로 보고 보고한다(자동 재생성은 스킬/LLM 몫, 점검자는 보고까지).
6. **커버리지**(선택): 기획서의 핵심 행동·유스케이스가 시나리오에 닿는지 등 세트 규칙.

## 스키마 위치·버전 규약

- 스키마는 각 문서 **옆 `./schemas/*.v1.schema.json`에 vendoring(복사)**된다. 스킬이 소유한 고정 자산의 사본이며, **버전이 파일명에 박혀 있어** v1 문서는 영원히 v1으로 검증된다(복사본이지만 drift 아님 — 얼어붙은 계약).
- 계약을 바꿔야 하면 기존 파일을 고치지 말고 **새 버전(`v2`)**으로 낸다.

## frontmatter 형식 (파싱 시 주의)

이 세트의 frontmatter는 **YAML 블록 스타일의 통제된 부분집합**이다:
- 최상위 `key: value` (문자열/정수) + `machine:` 아래 **2칸 들여쓰기 중첩**.
- inline 플로우(`machine: {tag: ..., schema: ...}`)는 쓰지 않는다 — 스킬 템플릿은 전부 블록 스타일이다.
- 값 뒤 `# 주석` 허용, 따옴표 선택. 정식 YAML 파서(js-yaml/pyyaml)를 써도 되고, 이 부분집합만 처리하는 소형 파서로도 충분하다.

## 참조 구현 · 사용법

이 계약서대로 동작하는 **무의존 참조 점검기**가 저장소에 있다: **`tools/check-docs.mjs`** (Node.js, npm 의존성 없음).

```
node tools/check-docs.mjs <문서세트-루트>
```

- `<루트>/00-index.md`의 `docbundle.docs` 매니페스트가 있으면 그걸로 문서를 발견, 없으면 `*.md`를 스캔.
- 하는 일: frontmatter·doc_type 확인 → 기계 블록을 `machine.schema`로 검증 → 접두사 라우팅으로 크로스도큐먼트 참조 무결성(죽은 링크) 점검. 문제가 있으면 종료코드 1.
- 이 점검기는 위 스키마 부분집합(type·required·enum·const·pattern·minItems·minProperties·properties·items·additionalProperties)만 구현한다. **완전한 JSON Schema 준수가 필요하면 `ajv`로 교체**하면 된다(스키마 파일은 그대로 재사용).

## 커버리지 한계 (점검기가 "블록만으로는" 못 잡는 것)

정직하게 밝힌다 — 아래는 기계 블록에 담기지 않아 자동 대조가 제한된다:
- **디자인 토큰 참조**(`color.primary`·`spacing.md`): 화면 설계서의 **산문(규격)**에 있고 `screendesign.screens` 블록엔 없다. `design.tokens` 등기부는 적재되지만, 참조 쪽이 블록에 없어 대조는 산문 파싱이 필요하다.
- **로컬 컴포넌트**(`UI.FEAT.*`): 도메인 파일의 산문 정의라 중앙 `uicomponents.list`엔 없다. 점검기는 `UI.FEAT.*` 참조를 **로컬로 간주해 스킵**한다.
- **유스케이스**(`UC.*`): 현재 기계 블록/등기부가 없다(doc-builder·ia-designer의 유스케이스는 산문). 시나리오의 `usecase` 참조는 스킵된다.
- 필요해지면 각 항목을 블록에 추가하거나(예: 화면 블록에 `tokens` 배열), 산문 파싱을 더해 확장한다.

## 한 줄 요약

frontmatter는 **payload(기계 블록)를 가리키는 계약**이고, 스키마는 그 payload의 **구조**를 강제한다. 이 문서는 스키마가 못 담는 **행동(무엇을 조회·대조·수리할지)**을 규정한다. 점검자는 이 계약서대로 구현한다 — 필드가 스스로 사용법을 알려주지는 않는다.
