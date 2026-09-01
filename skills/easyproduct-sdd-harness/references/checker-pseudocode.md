# 검사기 정본 — 7규칙 알고리즘 (언어 무관 수도코드)

> **이 문서가 검사기의 source of truth다.** 어떤 언어로 구현하든 여기 적힌 입력·판정·메시지·종료코드를
> 그대로 따른다. 구현체는 **무의존 단일 파일**이고 **`sdd-policy.json`만** 읽는다 — 프로젝트 이름·경로를
> 로직에 박지 않는다.
>
> **동봉된 참조 구현**: `../scripts/sdd-check.mjs`(Node ESM) · `../scripts/sdd_check.py`(Python 3.8+).
> 둘은 **같은 입력에서 동일한 위반 목록·종료코드**를 내야 하며, 그 동등성은 같은 픽스처에 두 구현을
> 돌려 `--json` 출력을 비교해 확인한다. **정본(이 문서)을 고치면 두 구현을 함께 고치고 다시 대조한다.**
> 결정성을 위해 파일 목록·변경 목록은 **정렬**한 뒤 처리한다(위반 순서가 매번 같아야 비교가 성립한다).

## 0. 인터페이스

```
sdd-check --full [--json] [--policy <path>]
sdd-check --changed <file> [<file>...] [--json] [--policy <path>]
```

| 모드 | 도는 규칙 | 쓰이는 곳 |
|---|---|---|
| `--changed` | **① 하드**, ③④⑥ 경고, ⑤⑦ 스킵(diff 단위 개념이라 훅에서 의미 없음) | 편집 훅(`PostToolUse`)·`pre-commit` |
| `--full` | 7규칙 전부 | `verify`·CI |

**종료코드**

| 모드 | 코드 |
|---|---|
| `--full` | `0` block 위반 없음(경고는 있어도 0) · `1` block 위반 · `2` 설정 오류 |
| `--changed` | `0` 통과 · **`2` 위반**(호스트가 `exit 2`일 때만 stderr를 에이전트에 주입하므로) · `2` 설정 오류 |

**`mode: "warn"`은 완료 게이트(verify·CI) 층에만 적용한다 — 훅 층은 덮지 않는다.**
훅까지 warn으로 덮으면 종료코드가 0이 되어 **아무것도 주입되지 않고**, 정작 안내가 가장 필요한
브라운필드 도입 기간에 ①층이 통째로 죽는다(조용한 실패). 훅은 방금 편집한 파일 하나만 보므로
"위반 홍수" 논리도 적용되지 않는다. warn만 있을 때 주입할지는 `hooks.injectOnWarn`(기본 true)이 정한다.

**`--json` 출력**:
```json
{ "ok": false, "adapter": "easyproduct", "skipped": ["completeness(CI Guard 위임)"],
  "violations": [ { "rule":"freshness", "severity":"block", "slug":"001-x",
                    "path":"app_docs/ssot/data-model.md", "message":"…", "action":"…" } ],
  "counts": { "block": 1, "warn": 3 } }
```

## 1. 공통 준비

```
policy = readJson(policyPath ?? "sdd-policy.json")            // 없으면 exit 2
governed = expandGlobs(policy.governedGlobs) − expandGlobs(policy.allowlist)
changedFiles = gitChanged(policy.mainBranch)                   // §2 참조
adapter = policy.upstreamDocs.docsAdapter                      // "easyproduct" | "generic"
registry = buildAnchorRegistry(policy, adapter)                // §5 — ⑤에서만 필요, 실패하면 ⑤ off
severityOf(rule) = policy.mode == "warn" ? "warn" : policy.severity[rule]   // 전역 warn이 덮어씀
```

`delegated`가 켜진 규칙은 **돌리지 않고 skipped에 기록한다**(리포트에 "누구에게 위임했는지" 명시):

```
if policy.delegated.ciGuard: severity["completeness"] = "off"   // 단 §3-②의 핀 파일 검사만 남긴다
```

### git 변경 집합

```
function gitChanged(mainBranch):
  base    = git merge-base <mainBranch> HEAD        // 실패하면(얕은 클론 등) HEAD~1로 폴백하고 경고
                                                    // 경고 문구에 CI 얕은 클론 힌트를 반드시 넣는다
                                                    // (GitLab `GIT_DEPTH: 0` / GH Actions `fetch-depth: 0`)
  commits = git diff --name-only base..HEAD
  working = git status --porcelain 의 경로          // 미커밋 변경 포함
  return unique(commits + working)
```

## 2. 축 A — 코드 층 (C1)

### ① 출처 (provenance)

```
for f in governed:
  tag = firstTagIn(f, policy.provenanceTag, policy.commentSyntaxes)   // 파일 앞부분 N줄만 스캔
  if tag is exempt(policy.exempt.fileTag): continue                   // 사유 문자열이 비면 위반
  if tag is none:
      VIOLATION("provenance", f, "출처 태그 없음",
                action: "이 파일이 파생된 슬라이스를 `@sdd <slug>`로 선언하거나, 사유와 함께 @sdd:exempt")
  else:
      usedSlugs.add(tag.slug)

// 관장 사각: 어느 glob에도 안 걸리는 신규 소스
for f in changedFiles where isNewFile(f) and isSource(f) and f ∉ governed and f ∉ allowlist:
  VIOLATION("unmatchedNewFile", f, "관장 범위 밖 신규 파일",
            severity: policy.unmatchedNewFiles,
            action: "governedGlobs를 넓히거나 allowlist에 사유와 함께 등록")
```

### ② 완결 (completeness)

```
for slug in usedSlugs:
  dir = policy.specsDir + "/" + slug
  if not exists(dir): VIOLATION("completeness", slug, "슬라이스 폴더 없음")
  if severityOf("completeness") != "off":                 // CI Guard에 위임했으면 건너뜀
    for pf in policy.requiredPhaseFiles:
      if not exists(dir/pf) or isBlank(dir/pf):
        VIOLATION("completeness", slug, "단계 산출물 없음/빔: " + pf)
  // 핀 파일은 위임 여부와 무관하게 항상 본다 — ④의 전제이기 때문
  if not exists(dir/policy.requiredPinFile):
    VIOLATION("completeness", slug, "핀 파일 없음: " + policy.requiredPinFile,
              action: "이 슬라이스가 근거로 삼은 상위 문서를 version+contentHash로 핀하라")
```

### ③ 결합 (coupling)

```
exemptCommits = commits(base..HEAD) with trailer(policy.exempt.commitTrailer)
for f in changedFiles ∩ governed:
  if f is only touched by exemptCommits: continue
  slug = tagSlug(f)                                        // 없으면 ①이 이미 잡았다
  if no changed path under policy.specsDir + "/" + slug:
    VIOLATION("coupling", f, "코드 변경에 슬라이스 변경이 동반되지 않음",
              action: "spec/plan/tasks를 먼저 갱신하거나, 사유와 함께 " + policy.exempt.commitTrailer)
```

## 3. 축 B — 상위→spec 전파 층 (C2)

### ⑥ 역결합 (reverse coupling) — 버전·핀 없이도 도는 1차 게이트

```
upstreamChanged = changedFiles ∩ expandGlobs(policy.upstreamDocs.globs)
sliceChanged    = changedFiles ∩ (policy.specsDir + "/**")
if upstreamChanged ≠ ∅ and sliceChanged == ∅ and not allExemptByTrailer(upstreamChanged):
  VIOLATION("reverseCoupling", upstreamChanged, "상위 문서만 바뀌고 슬라이스가 하나도 안 바뀜",
            action: "이 변경을 어느 슬라이스가 흡수하는지 SDD로 재검토하고 그 슬라이스에 흔적을 남겨라
                     (무해한 오탈자·포맷이면 " + policy.exempt.commitTrailer + " 트레일러로 면제)")
```

### ④ 신선도 (freshness) — 이중 핀

```
for slug in usedSlugs:
  pins = readPins(policy.specsDir/slug/policy.requiredPinFile) + readPins(policy.pins.globalPinFile)
  for pin in pins:                                  // pin = { path, revision?, version?, contentHash?, anchors? }
    cur = readVersion(pin.path, policy)             // §4 — 축(axis)을 함께 돌려준다
    pinAxis = (cur.axis == "revision") ? (pin.revision ?? pin.version) : pin.version   // 옛 핀 호환
    if pinAxis and cur.value and pinAxis != cur.value:
      // **진짜 할 일** — 결정이 개정됐다.
      VIOLATION("freshness", slug, pin.path + " 개정됨(" + cur.axis + " " + pinAxis + "→" + cur.value + ")",
                action: "SDD로 재검토하고 핀을 갱신하라")
    else if pin.contentHash and pin.contentHash != cur.hash:
      // 개정 축은 그대로인데 내용이 바뀐 경우 — 문구 손질이거나, 개정인데 번호를 안 올린 것.
      // **FIX 문구는 축에 따라 갈린다.** easyproduct 문서에 "version을 올려라"라고 하면
      // **스키마 계약 버전을 오염시키는 오지시**가 된다(실측: v1 문서에 version: 13이 박혔다).
      VIOLATION("freshness", slug, pin.path + "가 핀 이후 수정됨(" + cur.axis + " 그대로 · 내용 해시 불일치)",
                action: (cur.axis == "revision")
                  ? "내용을 확인하고 핀을 갱신하라. 결정이 바뀐 것이면 상위 문서의 revision을 올린다 — version은 payload 계약(스키마) 버전이라 올리지 않는다."
                  : "상위 문서의 version을 올리고, 재검토 후 슬라이스 핀을 갱신하라")
    if adapter == "easyproduct" and pin.anchors:
      // 앵커 단위 영향: 바뀐 앵커를 핀한 슬라이스만 stale로 좁힌다(정밀도)
      changedAnchors = diffAnchors(pin.path, pin.contentHash)     // 실패하면 파일 단위로 폴백
      if changedAnchors ∩ pin.anchors == ∅: downgradeLastViolation(to: "warn")
```

## 4. 범용 버전 리더

```
function readVersion(path, policy):
  text = read(path)                                  // 없으면 VIOLATION("freshness", …, "핀 대상 파일 없음")
  // **개정 축은 상위 문서 계열마다 다르다.**
  //   easyproduct : `revision`(결정 개정 번호). frontmatter의 `version`은 **payload 계약(스키마) 버전**이라
  //                 내용이 바뀌어도 안 올라간다 — 개정 축으로 쓰면 안 된다.
  //   generic     : 문서 자체의 버전 표식(헌법의 "**Version**: 1.2.0" 등).
  axis  = (policy.upstreamDocs.docsAdapter == "easyproduct") ? "revision" : "version"
  value = (axis == "revision") ? frontmatterField(text, "revision")
                               : frontmatterField(text, "version")
  value = value ?? semverAfter(text, policy.sources.semverLine) ?? null
  hash  = sha256(normalizeEol(text))                 // 항상 계산한다(폴백이 아니라 병기)
  return { axis, value, hash }
```

- **해시는 폴백이 아니라 상시 기록**이다. 개정 축을 가진 문서도 "번호를 안 올리고 고친 것"을 잡아야 하기 때문.
- **축을 잘못 잡으면 경고가 소음이 된다.** easyproduct 문서에서 `version`을 축으로 쓰면 그 값은 사실상
  안 변하므로 ④가 **항상 해시 갈래로 떨어지고**, "결정 개정"과 "문구 손질"이 한 덩어리가 된다
  (실측: 경고 60건 중 실제 요구 변화는 0건이었다).
- 전역 원칙 문서(헌법·CLAUDE·AGENTS)는 슬라이스마다 핀하지 말고 `policy.pins.globalPinFile` 한 곳에 모은다
  (전역 변경이 모든 슬라이스를 동시에 stale로 만드는 폭풍을 완화).

## 5. 축 C — spec 내용 층 (C3)

### 등기부 만들기 (어댑터)

```
function buildAnchorRegistry(policy, adapter):
  ids = {}
  for doc in expandGlobs(policy.upstreamDocs.globs):
    if adapter == "easyproduct":
      tag = frontmatterField(doc, policy.upstreamDocs.anchorRegistry.blockTagField)  // 예: machine.tag
      block = fencedJsonBlockTagged(doc, tag)          // frontmatter가 가리키는 ```json 블록
      ids += collectIds(block, prefixes: policy.upstreamDocs.anchorRegistry.idPrefixes)
    else:                                              // generic
      ids += matchAll(doc, policy.upstreamDocs.anchorRegistry.genericIdPattern)
      ids += headingAnchors(doc)
  return ids                                           // 비면 ⑤를 off하고 그 사실을 리포트에 적는다
```

> **독립성 제약**: 접두어(`FEAT`·`DATA`…)·블록 태그는 **정책 문자열로만** 받는다. easyproduct 스키마·
> `check-docs.mjs`를 읽거나 import하지 않는다. 어댑터는 "frontmatter가 가리키는 json 블록에서 id를 긁는다"는
> **일반 절차**일 뿐이다.

#### 정책이 상위 세트를 못 따라간 흔적 — 위반이 아니라 **보고**(note)

`idPrefixes`·`globs`는 프로젝트가 손으로 유지한다. 세트가 새 네임스페이스나 새 폴더를 얻으면 정책이
뒤처지고, **검사받던 참조가 검사 안 받는 참조로 조용히 바뀐다**(실제 사고: `IO` 96건). 그래서 두 가지를 센다.

```
// (가) 등기부에 없는 접두사 — 어댑터와 무관하게 돈다(generic 프로젝트에서도)
ANCHORISH = \b([A-Z][A-Z0-9]{1,15})\.[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*(?![A-Za-z0-9_-])
for text in specRefs.scanFiles of scopedSlugs:
  for m in matchAll(text, ANCHORISH):
    if m.prefix not in idPrefixes: unregistered[m.prefix] += 1
note: "⑤ 등기부에 없는 접두사 참조: IO(96건) …"   // 오탐 여지(상수·환경변수 표기) → 위반 아님

// (나) 매니페스트에 있는데 globs가 안 덮는 상위 문서 — adapter == "easyproduct"일 때만
for idx in files matching "**/00-index.md":
  man = fencedJsonBlockTagged(idx, "docbundle.docs")
  for d in man.docs where d.role in ("ssot", "handoff"):
    if not upstreamMatcher(dirname(idx) + d.path): gaps[d.docType] += 1
note: "④⑥ 매니페스트에 있는데 upstreamDocs.globs가 안 덮는 상위 문서 96건 (interface-request 96)"
```

> **정책을 매니페스트로 대체하지 않는다.** 정책은 "무엇을 감시하는지"를 사람이 읽을 수 있어야 하고,
> 런타임에 남의 색인에서 끌어오면 그 성질이 사라진다. **채우는 것은 설치·갱신 때, 어긋남은 매번 보고.**
> 매니페스트가 없거나 어댑터가 generic이면 **아무 말도 하지 않는다**(대조할 근거가 없다).

### ⑤ 근거 (grounding)

**참조 패턴에는 가드 두 개가 필수다**(둘 다 실전 오탐에서 나왔다):

```
anchorPattern = \b(?:<prefixes>)(?:\.[A-Za-z0-9_-]+)+(?![A-Za-z0-9_-])(?!\.\*)
                                                      ^^^^^^^^^^^^^^^^  ^^^^^^^
                                                      토큰 경계          와일드카드 제외
```
- **세그먼트 문자 클래스에 `.`을 넣지 않는다.** 넣으면 `FEAT.billing.*`에서 `FEAT.billing.`을 삼키고,
  후행 구두점을 잘라 **존재하지 않는 `FEAT.billing`을 만들어낸다**(옛 구현의 실제 결함, 오탐 7건).
  후행점을 잘라내는 보정(`strip [.,)]`)은 이 패턴과 함께 쓰면 안 된다 — 또 다른 유령을 만든다.
- **토큰 경계 가드가 없으면 백트래킹으로 `FEAT.billin`이 매칭된다**(`[A-Za-z0-9_-]+`가 `g`를 되돌려줌).
- 와일드카드 참조(`FEAT.x.*`)는 특정 ID가 아니므로 **대조하지 않되, 건너뛴 건수를 리포트 머리말에 적는다**
  (무엇을 안 봤는지 숨기지 않는다).

**요구 단위(`requirementUnit`)의 기본은 `frId`다.** spec-kit `spec-template.md`가 찍는 헤딩
(`### User Story N` · `### Edge Cases` · `### Key Entities` · `### Functional Requirements`)은 요구가 아니라
**템플릿 골격**이라, 헤딩을 요구로 보면 spec-kit 전용 스킬이 spec-kit 자기 템플릿에 걸려 운다(실전 오탐 52건).
실제 요구 단위는 `**FR-001**`·`**SC-001**`이다(`frIdPattern` 기본 `(?:FR|SC)-[0-9]+`).

```
if registry is empty: SKIP("specRefs", reason: "상위 등기부를 만들 수 없음(어댑터=" + adapter + ")")
else:
  for slug in scopedSlugs:
    for file in policy.specRefs.scanFiles:              // spec.md, plan.md
      wildcardSkipped += count(text, wildcardPattern)   // 리포트에 드러낼 값
      for r in matchAll(text, anchorPattern):           // 후행점 보정 없음 — 패턴이 이미 정확하다
        if r ∉ registry:
          VIOLATION("specRefs", slug, "죽은 링크: " + r + " (상위 문서에 없음)",
                    action: "상위 문서에서 실제 ID를 확인하거나, 그 결정을 상위 문서에 먼저 추가하라")
      for req in requirementUnits(text, policy.specRefs.requirementUnit):   // 기본 frId
        if req has no ref:
          VIOLATION("specRefs", slug, "근거 없는 요구: \"" + req.id + "\"",
                    severity: policy.specRefs.orphanRequirement,
                    action: "이 결정을 상위 문서로 이관하고 그 앵커를 참조하라(spec이 결정을 발명하지 않는다)")
```

`requirementUnits(text, "frId")`: `frIdPattern`이 걸린 줄에서 한 요구가 시작되고, **빈 줄이나 헤딩을 만날 때까지
이어지는 줄을 같은 요구로 묶는다**(들여쓴 설명까지 포함). `"heading"`(H3+)·`"listItem"`도 지원한다.

### ⑦ 충돌 리뷰 기록 (review record)

**판정하지 않는다 — 기록을 요구한다.** 의미 충돌 판정은 사람/LLM(`/speckit.analyze`)의 몫이고,
검사기는 "그 리뷰를 돌린 흔적이 이번 변경에 있는가"만 결정론으로 본다.

```
for slug in slugsWithChangedFiles(policy.reviewRecord.requireOnChangeOf):   // spec.md/plan.md가 바뀐 슬라이스
  rec = policy.reviewRecord.path for slug        // 또는 sources.json의 reviewedAt+anchors
  if rec ∉ changedFiles:
    VIOLATION("reviewRecord", slug, "spec/plan을 고쳤는데 상위 대조 기록이 갱신되지 않음",
              action: "`" + policy.reviewRecord.suggestedCommand + "`를 돌리고, 근거 앵커·확인 내용·checkedAt을 기록하라")
  else:
    for field in policy.reviewRecord.fields:     // anchors · checkedAt · by
      if missing(rec, field): VIOLATION("reviewRecord", slug, "기록에 " + field + " 없음")
```

## 5-1. 접을 후보 가시화 (위반 아님 · 정보 등급)

**이 절을 빠뜨리면 그 구현만 조용히 이 정보를 안 낸다.** 규칙 일곱이 전부 **변화**에 반응하고
**은퇴**를 말하는 자리가 없으면 슬라이스 집합은 단조증가한다(실사용: 다섯 달에 78개, 절반 이상이
제품 기능이 아니었다). 접기는 구조적으로 막힌 적이 없고 **접어도 된다는 말과 순서가 없었을 뿐**이라,
검사기가 후보를 세어 준다.

```
if mode == "full" and scopedSlugs:

    # ① 구속력 있는 태그가 없는 슬라이스
    #    **allowlist 안의 태그는 세지 않는다** — ③이 isGoverned를 먼저 보므로 검사기가 안 본다(장식).
    #    이걸 모르면 시험·하네스의 태그까지 세어 후보를 놓친다(실사용자가 그래서 처음에 일곱 개만 줄였다).
    binding = { tag.slug for f in GOVERNED if (tag := readTag(f)) and tag.slug }
    foldable = [g for g in scopedSlugs if g not in binding]

    # ② 이 슬라이스**만** 핀한 상위 문서
    #    그냥 접으면 그 문서가 바뀌어도 ④가 **아무 데서도 안 운다** — 하네스의 존재 이유를 깎는 자리다.
    pinners = {}                       # path -> {slug…}
    for g in scopedSlugs:
        for pin in readPins(f"{specsDir}/{g}/{requiredPinFile}"):
            pinners.setdefault(pin.path, set()).add(g)
    sole = [(path, only(gs)) for path, gs in pinners.items() if len(gs) == 1]

    note(f"구속력 있는 태그가 없는 슬라이스 {len(foldable)}개 — 접을 수 있는지 보세요: …")
    note("     (allowlist 안 태그는 안 셉니다 — ③이 그걸 안 보기 때문입니다)")
    note("     → 접는 순서: SKILL.md 「슬라이스를 언제 열고 언제 접나」")
    note(f"이 슬라이스만 핀한 상위 문서 {len(sole)}건 — 그냥 접으면 ④가 아무 데서도 안 웁니다")
    note("     → 접기 전에 핀을 옮기세요(접는 순서 2번)")
```

- **위반이 아니라 정보(`·`)다.** 아직 코드를 안 쓴 진행 중 슬라이스도 걸리므로 **종료코드를 안 바꾼다.**
  판단은 사람이 한다.
- **숫자만 내지 않는다.** 다음에 무엇을 하라는 줄을 함께 낸다 — 실사용 제보: 자기네 게이트에
  *"건너뛴 시험 N개"* 를 찍었는데 **할 일이 없어서 한동안 아무도 안 봤다.**

## 6. 리포트

사람용 출력은 **위반 하나당 한 블록**: `규칙 · 대상(파일 또는 slug) · 무슨 일 · 조치 한 줄`.
머리말에 **반드시** 적는다:

```
adapter: easyproduct (앵커 단위 영향 분석)
skipped: completeness → CI Guard 위임 · specRefs → 등기부 없음
mode: warn (브라운필드) — block 위반도 경고로 보고, 종료코드 0
```

**무엇을 안 봤는지 숨기지 않는다.** off·skip·위임은 전부 표면에 드러낸다 —
"조용한 통과"가 "검증됨"으로 읽히면 하네스가 오히려 위험해진다.

## 7. 구현 시 확정할 것 (설계 §8 잔여)

1. `requirementUnit` — spec-kit 템플릿 실물을 보고 헤딩/리스트 중 무엇을 "요구 1건"으로 볼지.
2. ⑥의 무해 변경 완화 — 현재는 트레일러 면제만. diff 크기·frontmatter 외 변경 여부로 완화할지.
3. ⑦ 기록 위치 — 별도 `upstream-check.md` vs `sources.json` 필드(둘 다 허용할지).
4. `diffAnchors` 구현 깊이 — 블록 diff로 바뀐 앵커를 실제로 뽑을지, 문서 hash + 앵커 목록 병기로 근사할지.
