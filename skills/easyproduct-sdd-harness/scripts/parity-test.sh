#!/usr/bin/env bash
# parity-test.sh — 두 참조 구현(Node·Python)의 **동등성 + 회귀** 검사.
#
# 정본(`../references/checker-pseudocode.md`)을 고치면 두 구현을 함께 고치고 **이 스크립트를 돌린다.**
# 임시 디렉터리에 spec-kit 더미 프로젝트 2종(generic / easyproduct 어댑터)을 만들어
# 시나리오마다 `--json` 출력과 종료코드가 **완전히 같은지** 비교하고, 회귀 케이스를 함께 본다.
#
# 사용: bash scripts/parity-test.sh          (종료코드 0 = 전부 일치·회귀 없음)
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_IMPL="$HERE/sdd-check.mjs"
PY_IMPL="$HERE/sdd_check.py"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0; fail=0
ok()   { echo "  ✓ $1"; pass=$((pass+1)); }
bad()  { echo "  ✗ $1"; fail=$((fail+1)); }

# ── 두 구현 대조 ────────────────────────────────────────────────────────────
cmp_case() {
  local name="$1"; shift
  local a b ea eb
  a=$(node "$NODE_IMPL" "$@" --json 2>&1); ea=$?
  b=$(python3 "$PY_IMPL" "$@" --json 2>&1); eb=$?
  if [ "$a" == "$b" ] && [ "$ea" == "$eb" ]; then
    ok "$name (exit $ea · 위반 $(grep -c '"rule"' <<<"$a"))"
  else
    bad "$name — 불일치 (node exit $ea / py exit $eb)"
    diff <(echo "$a") <(echo "$b") | head -20
  fi
}

# ── 회귀 단언(내용 검사) ────────────────────────────────────────────────────
expect() {   # expect <이름> <python 조건식(v=위반목록, d=전체)> -- <검사기 인자...>
  local name="$1" cond="$2"; shift 3
  node "$NODE_IMPL" "$@" --json > "$WORK/out.json" 2>"$WORK/out.err"
  if python3 -c "
import json,sys
d=json.load(open('$WORK/out.json'))
v=d['violations']
sys.exit(0 if ($cond) else 1)
"; then ok "$name"; else bad "$name — 조건 불충족: $cond"; fi
}

# ─────────────────────────── 픽스처 만들기 ───────────────────────────
make_fixture() {   # $1 = generic | ep
  local d="$WORK/$1"
  mkdir -p "$d/.specify/memory" "$d/specs/001-login" "$d/src/auth" "$d/app_docs/ssot"
  cd "$d" || exit 1
  git init -q -b main && git config user.email t@t && git config user.name t

  printf '# Constitution\n\n**Version**: 1.0.0\n\n## I. Spec-First\n소스부터 고치지 않는다.\n' > .specify/memory/constitution.md
  printf '// @sdd 001-login\nexport const login = 1;\n' > src/auth/login.ts
  printf '# plan\n' > specs/001-login/plan.md
  printf '# tasks\n' > specs/001-login/tasks.md

  cat > app_docs/ssot/ia.md <<'MD'
---
doc_type: ia
version: 1
ssot: prose
machine:
  tag: ia.features
  schema: ../schemas/ia.v1.schema.json
---

# 화면·기능 구조

```json ia.features
{
  "features": [
    { "id": "FEAT.auth.login", "label": "로그인", "state": "확정" },
    { "id": "FEAT.order.list", "label": "주문 목록", "state": "초안" },
    { "id": "FEAT.billing.plan", "label": "요금제", "state": "초안" }
  ]
}
```
MD

  # spec: FR-/SC- 요구 단위 + 와일드카드 계열 표기 + 죽은 링크 1건
  cat > specs/001-login/spec.md <<'MD'
# 로그인 슬라이스

## User Scenarios & Testing

### User Story 1 - 사용자가 로그인한다 (Priority: P1)
로그인 흐름 서술.

### Edge Cases
- 비밀번호 5회 오류

## Requirements

### Functional Requirements

- **FR-001**: FEAT.auth.login 화면의 정의대로 이메일 로그인을 제공해야 한다.
- **FR-002**: FEAT.billing.* 계열 화면은 로그인 후에만 노출해야 한다.
- **FR-003**: 비밀번호는 8자 이상이어야 한다.

### Key Entities
- 회원

## Success Criteria

- **SC-001**: FEAT.ghost.social 진입까지 3초 이내.
MD

  local adapter='"generic"' registry='{ "genericIdPattern": "REQ-[0-9]+" }' upstream='".specify/memory/constitution.md"'
  if [ "$1" == "ep" ]; then
    adapter='"easyproduct"'
    registry='{ "blockTagField": "machine.tag", "idPrefixes": ["FEAT","POL","UI"], "genericIdPattern": "REQ-[0-9]+" }'
    upstream='"app_docs/**/*.md", ".specify/memory/constitution.md"'
  fi

  cat > sdd-policy.json <<JSON
{
  "specsDir": "specs",
  "requiredPhaseFiles": ["spec.md","plan.md","tasks.md"],
  "requiredPinFile": "sources.json",
  "governedGlobs": ["src/**/*.ts"],
  "allowlist": ["src/main.ts"],
  "unmatchedNewFiles": "warn",
  "provenanceTag": "@sdd",
  "commentSyntaxes": ["//","#","/*"],
  "upstreamDocs": {
    "globs": [$upstream],
    "docsAdapter": $adapter,
    "anchorRegistry": $registry
  },
  "pins": { "location": "specs/<slug>/sources.json", "record": ["version","contentHash"],
            "globalPinFile": ".specify/sdd-sources.json", "impactUnit": "file" },
  "sources": { "semverLine": "**Version**:" },
  "specRefs": { "scanFiles": ["spec.md","plan.md"], "requirementUnit": "frId",
                "frIdPattern": "(?:FR|SC)-[0-9]+", "orphanRequirement": "warn" },
  "reviewRecord": { "path": "specs/<slug>/upstream-check.md", "requireOnChangeOf": ["spec.md","plan.md"],
                    "fields": ["anchors","checkedAt","by"], "suggestedCommand": "/speckit.analyze" },
  "delegated": { "ciGuard": false, "gates": false, "blueprintIndex": false },
  "mainBranch": "main",
  "exempt": { "fileTag": "@sdd:exempt", "commitTrailer": "SDD-Exempt" },
  "mode": "block",
  "severity": { "provenance":"block","completeness":"block","coupling":"block","freshness":"block",
                "reverseCoupling":"block","specRefs":"warn","reviewRecord":"warn" },
  "hooks": { "sessionStart": true, "postToolUse": true, "preToolUseDeny": false, "injectOnWarn": true }
}
JSON

  local H
  H=$(node -e "const{createHash}=require('crypto');const fs=require('fs');console.log('sha256:'+createHash('sha256').update(fs.readFileSync('.specify/memory/constitution.md','utf8')).digest('hex'))")
  printf '{ "sources": [ { "path": ".specify/memory/constitution.md", "version": "1.0.0", "contentHash": "%s" } ] }\n' "$H" > specs/001-login/sources.json
  git add -A && git commit -qm baseline
}

# ─────────────────────────── 시나리오 ───────────────────────────
run_scenarios() {   # $1 = 픽스처 이름
  cd "$WORK/$1" || exit 1
  echo "[$1]"
  cmp_case "0 정상"                  --full
  printf 'export const rogue=1;\n' > src/auth/rogue.ts
  cmp_case "C1 태그 없는 새 파일"     --full
  cmp_case "C1 훅 모드"               --changed src/auth/rogue.ts
  rm -f src/auth/rogue.ts
  printf '// @sdd 001-login\nexport const login=2;\n' > src/auth/login.ts
  cmp_case "C1b 코드만 수정"          --full
  cmp_case "C1b 훅 모드"              --changed src/auth/login.ts
  git checkout -q .
  printf '\n## 추가 원칙\n' >> .specify/memory/constitution.md
  cmp_case "C2 상위 무버전 수정"      --full
  git checkout -q .
  printf '\n- **FR-004**: 추가 요구.\n' >> specs/001-login/spec.md
  cmp_case "C3 spec 수정·기록 없음"   --full
  git checkout -q .
  printf '// @sdd:exempt 자동 생성\nexport const g=1;\n' > src/auth/gen.ts
  cmp_case "예외 파일 태그"           --full
  rm -f src/auth/gen.ts
  sed -i 's/"mode": "block"/"mode": "warn"/' sdd-policy.json
  printf 'export const rogue=1;\n' > src/auth/rogue.ts
  cmp_case "브라운필드 warn(--full)"  --full
  cmp_case "브라운필드 warn(훅)"      --changed src/auth/rogue.ts
  rm -f src/auth/rogue.ts
  sed -i 's/"mode": "warn"/"mode": "block"/' sdd-policy.json
  sed -i 's/"ciGuard": false/"ciGuard": true/' sdd-policy.json
  rm -f specs/001-login/sources.json
  cmp_case "위임(ciGuard)"            --full
  git checkout -q . && sed -i 's/"ciGuard": true/"ciGuard": false/' sdd-policy.json
  # 모노레포: 저장소 루트가 아닌 하위 폴더에 정책이 있고 거기서 실행해도 찾아야 한다(cwd 우선 탐색).
  mkdir -p track && cp sdd-policy.json track/ && cd track || exit 1
  cmp_case "모노레포: 하위 폴더 정책 자동 발견" --full
  cmp_case "모노레포: --policy 상대경로(cwd 기준)" --full --policy sdd-policy.json
  cd .. && rm -rf track
}

# ─────────────────────────── 회귀 단언 ───────────────────────────
run_regressions() {
  cd "$WORK/ep" || exit 1
  echo "[회귀]"
  # A: 와일드카드 계열 표기(FEAT.billing.*)를 유령 ID로 만들지 않는다. 죽은 링크는 FEAT.ghost.social 하나뿐.
  expect "A 와일드카드 → 유령 ID 없음" \
    "[x for x in v if '죽은 링크' in x['message'] and 'FEAT.billing' in x['message']]==[]" -- --full
  expect "A 진짜 죽은 링크는 잡는다" \
    "any('FEAT.ghost.social' in x['message'] for x in v)" -- --full
  expect "A 건너뛴 와일드카드를 리포트에 드러낸다" \
    "any('와일드카드' in s for s in d['skipped'])" -- --full
  # B: 요구 단위는 FR-/SC- — 템플릿 헤딩(Edge Cases·Key Entities·User Story)은 요구가 아니다.
  expect "B 템플릿 헤딩을 요구로 오판하지 않음" \
    "[x for x in v if '근거 없는 요구' in x['message'] and ('Edge Cases' in x['message'] or 'Key Entities' in x['message'] or 'User Story' in x['message'])]==[]" -- --full
  expect "B 앵커 없는 FR은 잡는다(FR-003)" \
    "any('근거 없는 요구' in x['message'] and 'FR-003' in x['message'] for x in v)" -- --full
  expect "B 앵커 있는 FR은 통과(FR-001)" \
    "[x for x in v if '근거 없는 요구' in x['message'] and 'FR-001' in x['message']]==[]" -- --full
  # D: warn 모드여도 훅(--changed)은 침묵하지 않는다 → exit 2.
  sed -i 's/"mode": "block"/"mode": "warn"/' sdd-policy.json
  printf 'export const rogue=1;\n' > src/auth/rogue.ts
  node "$NODE_IMPL" --changed src/auth/rogue.ts >/dev/null 2>&1
  [ $? -eq 2 ] && ok "D warn 모드에서도 훅은 exit 2로 주입(node)" || bad "D 훅이 침묵함(node)"
  python3 "$PY_IMPL" --changed src/auth/rogue.ts >/dev/null 2>&1
  [ $? -eq 2 ] && ok "D warn 모드에서도 훅은 exit 2로 주입(py)" || bad "D 훅이 침묵함(py)"
  node "$NODE_IMPL" --full >/dev/null 2>&1
  [ $? -eq 0 ] && ok "D warn 모드의 --full은 여전히 exit 0" || bad "D --full이 warn 모드에서 실패함"
  rm -f src/auth/rogue.ts && sed -i 's/"mode": "warn"/"mode": "block"/' sdd-policy.json
}

make_fixture generic
make_fixture ep
run_scenarios generic
run_scenarios ep
run_regressions

echo
echo "결과: 통과 $pass · 실패 $fail"
exit $((fail > 0 ? 1 : 0))
