#!/usr/bin/env bash
# check-docs-test.sh — 점검기 회귀 검사.
#
# 특히 **파장·신선도 층**(상위 결정이 바뀌었는데 하류가 안 따라간 경우)을 본다.
# 소재는 실제 사고다: "계정 2개 → 계정 1개 + 워크스페이스 전환" 개정에서
#   ① IA는 고쳤는데 화면 설계서 GNB 정의가 옛 표현 그대로 (산문이라 죽은 링크로 안 잡힘)
#   ② 화면이 요구하는 값을 받을 컴포넌트 파라미터가 아예 없음 (없는 것은 죽은 링크가 아님)
#   ③ 약관이 계정 정의를 서술하는데 목록에서 통째로 빠짐
# 셋 다 기존 검사로는 **원리적으로** 안 잡히고, 파장 지도 + 리뷰 스냅샷으로만 시야에 들어온다.
#
# 사용: bash scripts/check-docs-test.sh     (종료코드 0 = 전부 통과)
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK="$HERE/check-docs.mjs"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0; fail=0
ok()  { echo "  ✓ $1"; pass=$((pass+1)); }
bad() { echo "  ✗ $1"; fail=$((fail+1)); }
expect_out() {   # expect_out <이름> <있어야 할 문자열>
  if grep -qF "$2" "$WORK/out.txt"; then ok "$1"; else bad "$1 — 출력에 없음: $2"; fi
}
expect_no_out() {
  if grep -qF "$2" "$WORK/out.txt"; then bad "$1 — 나오면 안 되는 출력: $2"; else ok "$1"; fi
}
run() { node "$CHECK" "$WORK/set" "$@" > "$WORK/out.txt" 2>&1; echo $?; }

# ── 픽스처: 최소 문서 세트 ──
SET="$WORK/set"; mkdir -p "$SET/ssot" "$SET/screens/user" "$SET/reference/reviews" "$SET/schemas"
# 스키마 사본은 스킬마다 다른 폴더에 있다 — 이름으로 찾아 복사한다(사본 일치성 검사까지 통과하도록).
for n in ia.v1.schema.json review.v1.schema.json docbundle.v1.schema.json; do
  src="$(find "$HERE/../.." -name "$n" -path '*/schemas/*' | head -1)"
  [ -n "$src" ] && cp "$src" "$SET/schemas/"
done

cat > "$SET/ssot/plan.md" <<'MD'
---
doc_type: plan
version: 1
revision: 2
ssot: prose
---
# 기획서
계정은 **하나**이고 워크스페이스를 전환한다(개정: 계정 2개 → 1개 + 전환).
MD

cat > "$SET/ssot/ia.md" <<'MD'
---
doc_type: ia
version: 1
revision: 2
ssot: prose
machine:
  lang: json
  tag: ia.features
  schema: ../schemas/ia.v1.schema.json
---
# 화면·기능 구조
GNB는 N개 워크스페이스를 전환한다.

```json ia.features
{ "features": [ { "id": "FEAT.auth.login", "label": "로그인", "state": "확정" } ] }
```
MD

cat > "$SET/screens/user/screen-design-user-index.md" <<'MD'
---
doc_type: screen-design-index
version: 1
revision: 1
ssot: prose
---
# 화면 설계 색인
GNB: (개인 ↔ 조직) 2항 전환.   ← IA는 N개로 바뀌었는데 여기가 안 따라옴(산문이라 죽은 링크 아님)
MD

cat > "$SET/ssot/terms-privacy.md" <<'MD'
---
doc_type: terms-privacy
version: 1
revision: 1
ssot: prose
---
# 이용약관
회원은 개인 계정 또는 기관 계정을 만든다.   ← 옛 계정 정의(파장 목록에서 빠졌던 문서)
MD

cat > "$SET/00-index.md" <<'MD'
---
doc_type: doc-bundle-index
version: 1
ssot: table
machine:
  lang: json
  tag: docbundle.docs
  schema: schemas/docbundle.v1.schema.json
---
# 색인

```json docbundle.docs
{ "docs": [
  { "docType": "plan", "path": "ssot/plan.md", "role": "ssot" },
  { "docType": "ia", "path": "ssot/ia.md", "role": "ssot" },
  { "docType": "screen-design-index", "path": "screens/user/screen-design-user-index.md", "role": "ssot" },
  { "docType": "terms-privacy", "path": "ssot/terms-privacy.md", "role": "ssot" }
] }
```
MD

echo "[1] 리뷰 산출물이 없을 때 — 기계 통과를 '완료'로 읽지 못하게 한다"
run >/dev/null
expect_out "리뷰 산출물 없음을 알린다" "리뷰 산출물이 없습니다"
expect_out "LLM 층 미실행임을 밝힌다" "미실행"
expect_out "파장 지도가 관계를 계산한다" "파장 지도: 상류"

echo
echo "[2] 스냅샷 출력(--print-snapshot)"
run --print-snapshot >/dev/null
expect_out "sources에 붙일 스냅샷을 준다" "\"contentHash\": \"sha256:"

echo
echo "[3] 리뷰 이후 상류(plan·ia)가 또 개정된 경우 — 하류를 지목해야 한다"
# 리뷰는 r1 시점에 했는데 지금 문서는 r2다(=결정이 바뀌었는데 리뷰가 안 따라옴)
cat > "$SET/reference/reviews/review-2026-08-01.md" <<'MD'
---
doc_type: review
version: 1
ssot: prose
machine:
  lang: json
  tag: review.snapshot
  schema: ../../schemas/review.v1.schema.json
---
# 풀 리뷰 — 2026-08-01

```json review.snapshot
{
  "reviewedAt": "2026-08-01",
  "trigger": "최초 완성",
  "sources": [
    { "path": "ssot/plan.md", "revision": 1, "contentHash": "sha256:old" },
    { "path": "ssot/ia.md", "revision": 1, "contentHash": "sha256:old" }
  ],
  "checked": [
    { "from": "ssot/plan.md", "to": "ssot/ia.md", "result": "영향없음" }
  ]
}
```
MD
python3 - "$SET/00-index.md" <<'PY'
import sys
p=sys.argv[1]; s=open(p,encoding='utf-8').read()
s=s.replace('{ "docType": "terms-privacy", "path": "ssot/terms-privacy.md", "role": "ssot" }',
            '{ "docType": "terms-privacy", "path": "ssot/terms-privacy.md", "role": "ssot" },\n  { "docType": "review", "path": "reference/reviews/review-2026-08-01.md", "role": "reference" }')
open(p,'w',encoding='utf-8').write(s)
PY
run >/dev/null
expect_out "① IA 개정 → 화면 설계 색인을 지목"  "screens/user/screen-design-user-index.md"
expect_out "③ 기획 개정 → 약관도 지목(잊힌 문서)" "ssot/terms-privacy.md"
expect_out "개정 사실을 revision으로 말한다"      "개정됨(r1→r2)"

echo
echo "[4] 개정 번호 없이 내용만 바뀐 경우 — 다른 메시지로 잡는다"
python3 - "$SET/reference/reviews/review-2026-08-01.md" "$SET" <<'PY'
import sys,hashlib,json,re
rev,setroot=sys.argv[1],sys.argv[2]
def h(p):
    t=open(p,encoding='utf-8').read().replace('\r\n','\n')
    return 'sha256:'+hashlib.sha256(t.encode()).hexdigest()
s=open(rev,encoding='utf-8').read()
# 현재 상태를 그대로 스냅샷에 반영(=신선함) 후, plan만 산문을 살짝 고쳐 hash만 어긋나게 만든다
s=s.replace('"revision": 1, "contentHash": "sha256:old" }, ', f'"revision": 2, "contentHash": "{h(setroot+"/ssot/plan.md")}" }}, ')
s=s.replace('{ "path": "ssot/plan.md", "revision": 1, "contentHash": "sha256:old" }',
            f'{{ "path": "ssot/plan.md", "revision": 2, "contentHash": "{h(setroot+"/ssot/plan.md")}" }}')
s=s.replace('{ "path": "ssot/ia.md", "revision": 1, "contentHash": "sha256:old" }',
            f'{{ "path": "ssot/ia.md", "revision": 2, "contentHash": "{h(setroot+"/ssot/ia.md")}" }}')
open(rev,'w',encoding='utf-8').write(s)
PY
run >/dev/null
expect_out "스냅샷이 최신이면 조용하다" "리뷰 이후 상류 변경 없음"
printf '\n오타 고침.\n' >> "$SET/ssot/plan.md"
run >/dev/null
expect_out "개정 번호 없이 수정됨을 잡는다" "개정 번호 없이 수정됨"
expect_no_out "그 경우엔 '개정됨' 메시지가 아니다" "개정됨(r2→"

echo
echo "[5] 기준선에 revision이 없을 때 — '개정 번호 없이 수정됨'으로 오인하지 않는다"
# 도그푸드에서 실제로 나온 오보다: revision을 올렸는데도 "개정 번호 없이 수정됨"이라고 했다.
# 원인은 기준선 스냅샷에 revision이 없어 비교가 불가능했던 것인데, 메시지가 **엉뚱한 조치**를 지시했다.
sed -i 's/"revision": [0-9]*, //g' "$SET/reference/reviews/review-2026-08-01.md"
run >/dev/null
expect_out "기준선에 개정 번호가 없음을 밝힌다" "기준선에 개정 번호 없음"
expect_out "그래도 하류를 지목한다" "하류 재검토 필요"
expect_no_out "'개정 번호 없이 수정됨'으로 오인하지 않는다" "개정 번호 없이 수정됨"

echo
echo "[6] 옛 형식 세트(revision 없음) — '업그레이드 필요'를 집계해 알려준다"
# 계약을 바꾸면 **기존 문서를 올려 주는 경로**도 함께 내야 한다(CLAUDE.md "기존 문서의 업그레이드 경로").
# 그 경로의 마지막 고리가 '가시화'다 — 누락을 집계해 알려주지 않으면 기존 세트는 조용히 통과하고
# 새 기능(파장·신선도)을 영원히 못 얻는다.
sed -i '/^revision: /d' "$SET"/ssot/*.md "$SET"/screens/user/*.md
run >/dev/null
expect_out "revision 없는 문서를 센다" "없는 문서"
expect_out "업그레이드가 필요하다고 말한다" "업그레이드 필요"
expect_out "무엇을 하라고 알려준다" "gap-fill"

echo
echo "[7] 백엔드 — 요구·계약의 방향과 갈래"
# io는 서버 통신 전용이 아니다(로컬 저장·화면 안 상태도 동작이다). target의 첫 마디로 갈래를 판정하고
# server인 것만 요구로 수확해야, 로컬 저장에 서버 인터페이스를 지어내지 않는다.
mkdir -p "$SET/ssot/backend"
for n in backend-interface.v1 screen-design.v1; do
  src="$(find "$HERE/../.." -name "$n.schema.json" -path '*/schemas/*' | head -1)"
  [ -n "$src" ] && cp "$src" "$SET/schemas/"
done
cat > "$SET/screens/user/screen-design-user-order.md" <<'MD'
---
doc_type: screen-design
version: 1
revision: 1
ssot: prose
machine:
  lang: json
  tag: screendesign.screens
  schema: ../../schemas/screen-design.v1.schema.json
---
# 주문 화면
```json screendesign.screens
{ "screens": [
  { "id": "FEAT.auth.login", "feat": "FEAT.auth.login", "components": ["UI.x"],
    "data": { "display": [], "bindings": [],
      "io": [
        { "id": "FEAT.auth.login.submit", "action": "로그인", "target": "server", "sends": [], "receives": [] },
        { "id": "FEAT.auth.login.saveDraft", "action": "임시저장", "target": "local", "sends": [], "receives": [] },
        { "action": "미분류", "sends": [], "receives": [] },
        { "action": "옛 참조", "op": "API.auth.login", "sends": [], "receives": [] }
      ] } } ] }
```
MD
cat > "$SET/ssot/backend/backend-interface.md" <<'MD'
---
doc_type: backend-interface
version: 1
revision: 1
ssot: prose
machine:
  lang: json
  tag: backend.interfaces
  schema: ../../schemas/backend-interface.v1.schema.json
---
# 인터페이스 계약
```json backend.interfaces
{ "domain": "auth", "scope": "user",
  "interfaces": [
    { "id": "BEITF.user.auth.login", "summary": "로그인", "transport": "grpc",
      "binding": { "service": "AuthService", "rpc": "Login" },
      "auth": { "mode": "public", "desc": "공개" }, "request": { "fields": [] }, "response": { "fields": [] },
      "basis": [ { "kind": "screen-io", "ref": "FEAT.auth.login.submit" } ] },
    { "id": "BEITF.user.auth.purge", "summary": "보존기간 경과 파기", "transport": "queue",
      "binding": { "topic": "auth.purge" },
      "auth": { "mode": "public", "desc": "공개" }, "request": { "fields": [] },
      "response": { "fields": [], "errors": [ { "code": "PURGE_FAILED", "when": "대상 조회 실패" } ] },
      "basis": [ { "kind": "ops", "ref": "야간 파기 배치" } ] }
  ] }
```
MD
# 매니페스트에 등록해야 발견된다(세트 계약 그대로).
python3 - "$SET/00-index.md" <<'PY'
import sys
p=sys.argv[1]; s=open(p,encoding='utf-8').read()
s=s.replace('{ "docType": "terms-privacy", "path": "ssot/terms-privacy.md", "role": "ssot" }',
            '{ "docType": "terms-privacy", "path": "ssot/terms-privacy.md", "role": "ssot" },\n'
            '  { "docType": "screen-design", "path": "screens/user/screen-design-user-order.md", "role": "ssot" },\n'
            '  { "docType": "backend-interface", "path": "ssot/backend/backend-interface.md", "role": "ssot" }')
open(p,'w',encoding='utf-8').write(s)
PY
run >/dev/null
expect_out "REST가 아닌 전송(grpc·queue)도 계약이 통과한다" "죽은 링크"
expect_no_out "server 요구가 덮였으면 미덮임 보고 없음" "덮이지 않은 요구"
expect_out "target 미분류를 업그레이드 필요로 집계" "미분류 동작 2건"
expect_out "폐기된 op를 이관 필요로 집계" "이관 필요"
expect_out "등기부 없는 갈래(ops)에 why가 없으면 잡는다" "why 없음"
expect_no_out "local 동작을 서버 요구로 세지 않는다" "FEAT.auth.login.saveDraft"
# 상태코드는 전송별 규격이다 — 큐·gRPC엔 없다. 도그푸드에서 response.successStatus가 필수로 남아 있어
# 큐 인터페이스가 스키마 위반이 났다(REST 전제의 잔재).
expect_no_out "상태코드 없이도 큐·gRPC 계약이 통과한다" "successStatus 누락"
expect_no_out "오류에 status 없이 code·when만으로 통과한다" "errors[0].status 누락"

echo
echo "[8] 실제 세트에서 드러난 두 구멍 — 조용히 빠지는 문서를 드러낸다"
# 실제 프로젝트(문서 65개)에 돌려보니 ⓐ 26건이 매니페스트에 없어 **점검 대상 밖**이었고
# ⓑ 20건이 파장 지도에 없는 종류라 **파장 대상 밖**이었다. 둘 다 "통과"로 읽히던 조용한 누락이다.
mkdir -p "$SET/supporting"
cat > "$SET/supporting/notes.md" <<'MD'
---
doc_type: project-notes
version: 1
revision: 1
ssot: prose
---
# 프로젝트 고유 메모 (세트 표준 밖)
MD
run >/dev/null
expect_out "매니페스트에 없는 문서를 센다" "매니페스트에 없는 문서"
expect_out "점검 대상에서 빠졌음을 말한다" "점검 대상에서 빠졌다"
# 매니페스트에 넣으면 발견되지만, 파장 지도에 없는 종류라 이번엔 '파장 대상 밖'으로 뜬다
python3 - "$SET/00-index.md" <<'PY'
import sys
p=sys.argv[1]; s=open(p,encoding='utf-8').read()
s=s.replace('{ "docType": "terms-privacy", "path": "ssot/terms-privacy.md", "role": "ssot" }',
            '{ "docType": "terms-privacy", "path": "ssot/terms-privacy.md", "role": "ssot" },\n'
            '  { "docType": "project-notes", "path": "supporting/notes.md", "role": "supporting" }')
open(p,'w',encoding='utf-8').write(s)
PY
run >/dev/null
expect_no_out "매니페스트에 넣으면 누락 보고가 사라진다" "매니페스트에 없는 문서"
expect_out "파장 지도에 없는 종류를 센다" "파장 지도에 없는 문서 종류"
expect_out "탈출구(derivesFrom)를 알려준다" "derivesFrom"

echo
echo "[9] 서버 요구 기계 추출(--emit-needs)"
# 화면 동작에는 요구가 이미 구조화돼 있다 — 목록은 LLM 판단 없이 기계로 나와야 한다.
node "$CHECK" "$SET" --emit-needs > "$WORK/needs.json" 2>/dev/null
if python3 -c "
import json,sys
d=json.load(open('$WORK/needs.json'))
n=d['needs']
assert any(x['id']=='FEAT.auth.login.submit' for x in n), 'server 요구가 추출되지 않음'
assert not any(x['id']=='FEAT.auth.login.saveDraft' for x in n), 'local 동작이 섞여 들어옴'
assert any(x['coveredBy'] for x in n), '덮은 인터페이스가 함께 오지 않음'
assert d['untargeted']>0, 'target 미분류 건수가 보고되지 않음'
assert '의미 요건' in d['limits'], '한계가 함께 나오지 않음'
"; then ok "server 요구만 추출 · 덮은 인터페이스·미분류·한계 동반"; else bad "--emit-needs 출력이 계약과 다름"; fi
if python3 -c "import json;json.load(open('$WORK/needs.json'))" 2>/dev/null; then ok "stdout이 순수 JSON(리포트는 stderr)"; else bad "stdout에 리포트가 섞임"; fi

echo
echo "결과: 통과 $pass · 실패 $fail"
exit $((fail > 0 ? 1 : 0))
