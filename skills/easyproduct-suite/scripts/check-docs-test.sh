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
  if grep -qF -- "$2" "$WORK/out.txt"; then ok "$1"; else bad "$1 — 출력에 없음: $2"; fi
}
expect_no_out() {
  if grep -qF -- "$2" "$WORK/out.txt"; then bad "$1 — 나오면 안 되는 출력: $2"; else ok "$1"; fi
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
cat > "$SET/ssot/policy.md" <<'MD'
---
doc_type: policy
version: 1
revision: 1
ssot: prose
machine:
  lang: json
  tag: policy.rules
  schema: ../schemas/policy.v1.schema.json
---
# 정책서
```json policy.rules
{ "rules": [ { "id": "POL.member.phoneOnly", "label": "휴대폰 번호 로그인", "domain": "member" } ] }
```
MD
src="$(find "$HERE/../.." -name "policy.v1.schema.json" -path '*/schemas/*' | head -1)"; [ -n "$src" ] && cp "$src" "$SET/schemas/"
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
        { "id": "IO.auth.login.submit", "action": "로그인", "target": "server", "sends": [], "receives": [],
          "policies": ["POL.member.phoneOnly"], "semantics": "자격 오류 시 어느 쪽이 틀렸는지 구분하지 않는다" },
        { "id": "IO.auth.login.saveDraft", "action": "임시저장", "target": "local", "sends": [], "receives": [] },
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
      "basis": [ { "kind": "screen-io", "ref": "IO.auth.login.submit" } ] },
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
            '  { "docType": "backend-interface", "path": "ssot/backend/backend-interface.md", "role": "ssot" },\n'
            '  { "docType": "policy", "path": "ssot/policy.md", "role": "ssot" }')
open(p,'w',encoding='utf-8').write(s)
PY
run >/dev/null
expect_out "REST가 아닌 전송(grpc·queue)도 계약이 통과한다" "죽은 링크"
expect_no_out "server 요구가 덮였으면 미덮임 보고 없음" "덮이지 않은 요구"
expect_out "target 미분류를 업그레이드 필요로 집계" "미분류 동작 2건"
expect_out "폐기된 op를 이관 필요로 집계" "이관 필요"
expect_out "등기부 없는 갈래(ops)에 why가 없으면 잡는다" "why 없음"
expect_no_out "local 동작을 서버 요구로 세지 않는다" "IO.auth.login.saveDraft"
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
assert any(x['id']=='IO.auth.login.submit' for x in n), 'server 요구가 추출되지 않음'
assert not any(x['id']=='IO.auth.login.saveDraft' for x in n), 'local 동작이 섞여 들어옴'
assert any(x['coveredBy'] for x in n), '덮은 인터페이스가 함께 오지 않음'
assert d['untargeted']>0, 'target 미분류 건수가 보고되지 않음'
assert any(x['policies'] and x['semantics'] for x in n), '정책·의미 요건이 실려 나오지 않음'
"; then ok "server 요구만 추출 · 덮은 인터페이스·미분류·한계 동반"; else bad "--emit-needs 출력이 계약과 다름"; fi
if python3 -c "import json;json.load(open('$WORK/needs.json'))" 2>/dev/null; then ok "stdout이 순수 JSON(리포트는 stderr)"; else bad "stdout에 리포트가 섞임"; fi

echo
echo "[10] 인터페이스 요청서 — 기계 생성 · 등록 · 낡음 판정"
# 백엔드가 화면 설계서를 뒤지지 않도록 프론트가 넘기는 인계 산출물. SSOT가 아니라 파생물이라
# 출처 스냅샷으로 낡음이 잡혀야 한다(파일로 굳히는 대가를 관리하는 유일한 장치다).
src="$(find "$HERE/../.." -name "interface-request.v1.schema.json" -path '*/schemas/*' | head -1)"
[ -n "$src" ] && cp "$src" "$SET/schemas/"
node "$CHECK" "$SET" --emit-interface-request --scope user --domain order --transport grpc > "$SET/interface-request.md" 2>/dev/null
if grep -q "preferredTransport" "$SET/interface-request.md" && grep -q "IO.auth.login.submit" "$SET/interface-request.md"; then
  ok "요청서를 기계로 생성(희망 전송·요구 포함)"; else bad "요청서 생성 실패"; fi
if grep -q "requestMessage" "$SET/interface-request.md"; then ok "전송별 채울 자리(bindingSlots)를 낸다"; else bad "bindingSlots 없음"; fi
if grep -q "saveDraft" "$SET/interface-request.md"; then bad "local 동작이 요청서에 섞임"; else ok "server 동작만 담는다"; fi
sed -i 's|{ "docType": "policy", "path": "ssot/policy.md", "role": "ssot" }|{ "docType": "policy", "path": "ssot/policy.md", "role": "ssot" },\n  { "docType": "interface-request", "path": "interface-request.md", "role": "handoff" }|' "$SET/00-index.md"
run >/dev/null
expect_no_out "갓 생성한 요청서는 낡지 않았다" "가 낡았다"
sed -i 's/^revision: 1$/revision: 2/' "$SET/screens/user/screen-design-user-order.md"
run >/dev/null
expect_out "화면 개정 후 요청서가 낡았음을 잡는다" "가 낡았다"
expect_out "다시 생성하라고 알려준다" "다시 생성"

echo
echo "[11] 중복 동작 id — 참조가 갈리는 것을 막는다"
# io id는 사람/LLM이 동작 이름에서 지어내는 값이라 실제로 충돌한다(도그푸드에서 한글 동작명을 기계적으로
# 옮기다 `IO.auth.login.action`이 둘 생겼다). 중복이면 요청서·백엔드 basis가 조용히 엉뚱한 동작에 붙는다.
mkdir -p "$WORK/dup/screens" "$WORK/dup/schemas"
cp "$SET/schemas/screen-design.v1.schema.json" "$WORK/dup/schemas/"
cat > "$WORK/dup/screens/s.md" <<'MD'
---
doc_type: screen-design
version: 1
ssot: prose
machine:
  lang: json
  tag: screendesign.screens
  schema: ../schemas/screen-design.v1.schema.json
---
```json screendesign.screens
{ "screens": [ { "id": "FEAT.auth.login", "feat": "FEAT.auth.login", "components": ["UI.x"],
  "data": { "display": [], "bindings": [], "io": [
    { "id": "IO.auth.login.action", "action": "개인 가입", "target": "client", "sends": [], "receives": [] },
    { "id": "IO.auth.login.action", "action": "비밀번호 찾기", "target": "client", "sends": [], "receives": [] } ] } } ] }
```
MD
node "$CHECK" "$WORK/dup" > "$WORK/out.txt" 2>&1
expect_out "중복 동작 id를 잡는다" "중복 동작 id"
expect_out "어느 동작끼리 겹쳤는지 보여준다" "비밀번호 찾기"

echo
echo "[12] 같은 데이터를 여러 화면이 쓸 때 — 묶을 후보만 짚고 자동으로 묶지 않는다"
# 데이터 변수는 참조라 여러 화면이 같은 걸 쓰는 게 정상이다(원본은 데이터 모델 하나).
# 다만 보내고 받는 것이 똑같은 요구가 여러 화면에 흩어져 있으면 인터페이스 하나로 묶을 후보다.
mkdir -p "$WORK/same/screens/user" "$WORK/same/schemas"
cp "$SET/schemas/screen-design.v1.schema.json" "$WORK/same/schemas/"
cat > "$WORK/same/screens/user/s.md" <<'MD'
---
doc_type: screen-design
version: 1
ssot: prose
machine:
  lang: json
  tag: screendesign.screens
  schema: ../../schemas/screen-design.v1.schema.json
---
```json screendesign.screens
{ "screens": [
 { "id": "FEAT.auth.login", "feat": "FEAT.auth.login", "components": ["UI.x"],
   "data": { "display": [], "bindings": [], "io": [
     { "id": "IO.auth.login.submit", "action": "로그인", "target": "server", "auth": { "required": false },
       "sends": ["member.phone"], "receives": ["member.id"] } ] } },
 { "id": "FEAT.home.main", "feat": "FEAT.home.main", "components": ["UI.x"],
   "data": { "display": [], "bindings": [], "io": [
     { "id": "IO.home.main.login", "action": "홈에서 바로 로그인", "target": "server", "auth": { "required": false },
       "sends": ["member.phone"], "receives": ["member.id"] } ] } } ] }
```
MD
node "$CHECK" "$WORK/same" --emit-interface-request --scope user --domain s > "$WORK/same-req.md" 2>/dev/null
if grep -q "묶을 후보" "$WORK/same-req.md"; then ok "같은 형태 요구를 묶을 후보로 짚는다"; else bad "묶을 후보를 안 짚음"; fi
if grep -q "IO.auth.login.submit" "$WORK/same-req.md" && grep -q "IO.home.main.login" "$WORK/same-req.md"; then
  ok "두 요구가 모두 살아 있다(자동으로 합치지 않는다)"; else bad "요구가 사라짐"; fi
if grep -q "판단은 백엔드 몫" "$WORK/same-req.md"; then ok "판단 주체를 밝힌다"; else bad "판단 주체 문구 없음"; fi

echo
echo "[13] 부분집합 요구 — 기존 인터페이스로 덮을 후보를 짚는다"
# 받는 값 5개 중 4개만 쓰는 화면에 새 인터페이스를 만들 이유가 없다. 다만 남는 값이 함께 가므로
# 자동으로 묶지 않고 후보만 짚는다(권한·정책·성격이 다르면 묶으면 안 된다).
mkdir -p "$WORK/subset/screens/user" "$WORK/subset/schemas"
cp "$SET/schemas/screen-design.v1.schema.json" "$WORK/subset/schemas/"
cat > "$WORK/subset/screens/user/s.md" <<'MD'
---
doc_type: screen-design
version: 1
ssot: prose
machine:
  lang: json
  tag: screendesign.screens
  schema: ../../schemas/screen-design.v1.schema.json
---
```json screendesign.screens
{ "screens": [
 { "id": "FEAT.order.detail", "feat": "FEAT.order.detail", "components": ["UI.x"],
   "data": { "display": [], "bindings": [], "io": [
     { "id": "IO.order.detail.load", "action": "상세 보기", "target": "server", "auth": { "required": true }, "sends": ["order.id"],
       "receives": ["order.status","order.amount","order.pickupSlot","order.itemNote","order.createdAt"] } ] } },
 { "id": "FEAT.order.list", "feat": "FEAT.order.list", "components": ["UI.x"],
   "data": { "display": [], "bindings": [], "io": [
     { "id": "IO.order.list.row", "action": "목록 한 줄", "target": "server", "auth": { "required": true }, "sends": ["order.id"],
       "receives": ["order.status","order.amount","order.pickupSlot","order.createdAt"] } ] } } ] }
```
MD
node "$CHECK" "$WORK/subset" --emit-interface-request --scope user --domain s > "$WORK/subset-req.md" 2>/dev/null
if grep -q "덮을 수 있는 후보" "$WORK/subset-req.md"; then ok "부분집합 재사용 후보를 짚는다"; else bad "부분집합 후보를 안 짚음"; fi
if grep -q "order.itemNote" "$WORK/subset-req.md"; then ok "더 오는 값이 무엇인지 알려준다"; else bad "더 오는 값 표시 없음"; fi
if grep -q "판단은 백엔드 몫" "$WORK/subset-req.md"; then ok "자동으로 묶지 않음을 밝힌다"; else bad "판단 주체 문구 없음"; fi

echo
echo "[14] 요청서의 입자 — 범위는 폴더, 도메인은 파일 (담당자가 갈린다)"
# 파생물의 입자는 **출처 문서의 입자**를 따라야 한다. 통짜면 화면 하나만 고쳐도 전체가 낡음이 되어
# 어디가 낡았는지 알 수 없고, 담당 개발자가 갈리는 경계(사용자 앱/백오피스)도 파일에서 안 보인다.
mkdir -p "$WORK/split/screens/user/schemas" "$WORK/split/screens/backoffice/schemas"
cp "$SET/schemas/screen-design.v1.schema.json" "$WORK/split/screens/user/schemas/"
cp "$SET/schemas/screen-design.v1.schema.json" "$WORK/split/screens/backoffice/schemas/"
mkfront() { printf -- '---\ndoc_type: screen-design\nversion: 1\nrevision: 1\nssot: prose\nmachine:\n  lang: json\n  tag: screendesign.screens\n  schema: schemas/screen-design.v1.schema.json\n---\n'; }
{ mkfront; cat <<'MD'
```json screendesign.screens
{ "screens": [ { "id": "FEAT.auth.login", "feat": "FEAT.auth.login", "components": ["UI.x"],
  "data": { "display": [], "bindings": [], "io": [
    { "id": "IO.auth.login.submit", "action": "로그인", "target": "server", "auth": { "required": true },
      "sends": ["member.phone"], "receives": ["member.id","member.name"] } ] } } ] }
```
MD
} > "$WORK/split/screens/user/screen-design-user-auth.md"
{ mkfront; cat <<'MD'
```json screendesign.screens
{ "screens": [ { "id": "FEAT.mypage.home", "feat": "FEAT.mypage.home", "components": ["UI.x"],
  "data": { "display": [], "bindings": [], "io": [
    { "id": "IO.mypage.home.load", "action": "내 정보", "target": "server", "auth": { "required": true },
      "sends": ["member.phone"], "receives": ["member.id","member.name"] } ] } } ] }
```
MD
} > "$WORK/split/screens/user/screen-design-user-mypage.md"
{ mkfront; cat <<'MD'
```json screendesign.screens
{ "screens": [ { "id": "FEAT.member.list", "feat": "FEAT.member.list", "components": ["UI.x"],
  "data": { "display": [], "bindings": [], "io": [
    { "id": "IO.member.list.load", "action": "회원 조회", "target": "server", "auth": { "required": true, "roles": ["operator"] },
      "sends": ["member.phone"], "receives": ["member.id","member.name"] } ] } } ] }
```
MD
} > "$WORK/split/screens/backoffice/screen-design-backoffice-member.md"

node "$CHECK" "$WORK/split" --emit-interface-request > "$WORK/o.txt" 2>&1
if [ $? -ne 0 ] && grep -q -- "--scope 가 필요" "$WORK/o.txt"; then ok "범위를 빼면 막는다(권한 섞임 방지)"; else bad "scope 없이도 뽑힘"; fi
node "$CHECK" "$WORK/split" --emit-interface-request --scope user > "$WORK/o.txt" 2>&1
if [ $? -ne 0 ] && grep -q -- "--domain 이 필요" "$WORK/o.txt"; then ok "도메인을 빼면 막는다(통짜 방지)"; else bad "domain 없이도 뽑힘"; fi
if grep -q "auth · mypage" "$WORK/o.txt"; then ok "그 범위의 도메인을 알려준다"; else bad "도메인 안내 없음"; fi
node "$CHECK" "$WORK/split" --emit-interface-request --scope user --list-domains 2>/dev/null > "$WORK/d.txt"
if [ "$(cat "$WORK/d.txt" | tr '\n' ' ')" = "auth mypage " ]; then ok "--list-domains 가 뽑을 도메인만 낸다"; else bad "도메인 목록이 다름: $(cat "$WORK/d.txt")"; fi

node "$CHECK" "$WORK/split" --emit-interface-request --scope user --domain auth > "$WORK/req-auth.md" 2>/dev/null
if [ "$(grep -c '"path": "screens/' "$WORK/req-auth.md")" = "1" ]; then ok "출처가 하나다(낡음 판정이 정확해진다)"; else bad "출처가 여럿"; fi
if grep -q '"domain": "auth"' "$WORK/req-auth.md"; then ok "블록에 도메인을 밝힌다"; else bad "domain 없음"; fi
if grep -q "IO.mypage.home.load" "$WORK/req-auth.md"; then ok "묶기 후보는 범위 전체로 계산한다(도메인을 가로지름)"; else bad "다른 도메인 후보가 사라짐"; fi
if grep -q "(mypage)" "$WORK/req-auth.md"; then ok "상대가 어느 도메인 요청서에 있는지 밝힌다"; else bad "상대 도메인 표시 없음"; fi
if grep -q "IO.member.list.load" "$WORK/req-auth.md"; then bad "범위를 넘는 묶기를 제안함(권한 경계 침범)"; else ok "범위를 넘는 묶기는 제안하지 않는다"; fi
if [ "$(grep -c '^| `IO' "$WORK/req-auth.md")" = "1" ]; then ok "요구 표에는 자기 도메인만 담는다"; else bad "남의 도메인 요구가 표에 섞임"; fi

# 옛 배치(통짜) 감지 — 이미 만들어 둔 세트가 새 규칙을 얻는 경로
mkdir -p "$WORK/split/interface-requests" "$WORK/split/schemas"
irsrc="$(find "$HERE/../.." -name "interface-request.v1.schema.json" -path '*/schemas/*' | head -1)"
[ -n "$irsrc" ] && cp "$irsrc" "$WORK/split/schemas/"
cat > "$WORK/split/interface-requests/interface-request-user.md" <<'MD'
---
doc_type: interface-request
version: 1
ssot: prose
machine:
  lang: json
  tag: interface.requests
  item: request-list
  schema: ../schemas/interface-request.v1.schema.json
---
```json interface.requests
{ "generatedAt": "2026-08-01", "scope": "user",
  "from": [ { "path": "screens/user/screen-design-user-auth.md", "contentHash": "sha256:x" },
            { "path": "screens/user/screen-design-user-mypage.md", "contentHash": "sha256:y" } ],
  "requests": [ { "ref": "IO.auth.login.submit", "screen": "FEAT.auth.login", "sends": [], "receives": [] } ] }
```
MD
node "$CHECK" "$WORK/split" > "$WORK/out.txt" 2>&1
expect_out "옛 배치(통짜) 요청서를 집계해 알려준다" "옛 배치"
expect_out "무엇을 하라는지 알려준다" "도메인별로 다시 뽑고"

echo
echo "[15] 왕복 — 규약 경로에 둔 생성물이 실제로 점검을 받는가"
# 0.8.2에서 요청서를 두 단계 아래로 옮기면서 스키마 경로가 어긋났고, 그 결과 **블록이 검사에서 통째로
# 빠졌다**(경고 한 줄 뒤의 조용한 통과). 생성 케이스와 감지 케이스를 따로 봤을 뿐 **생성물을 규약 경로에
# 놓고 다시 점검하는 왕복**을 안 걸어서 못 잡았다. 이 테스트가 그 구멍이다.
mkdir -p "$WORK/split/interface-requests/user/schemas"
[ -n "$irsrc" ] && cp "$irsrc" "$WORK/split/interface-requests/user/schemas/"
rm -f "$WORK/split/interface-requests/interface-request-user.md"    # 앞 케이스의 옛 배치 파일 치움
for d in $(node "$CHECK" "$WORK/split" --emit-interface-request --scope user --list-domains 2>/dev/null); do
  node "$CHECK" "$WORK/split" --emit-interface-request --scope user --domain "$d" --transport rest 2>/dev/null \
    > "$WORK/split/interface-requests/user/interface-request-user-$d.md"
done
node "$CHECK" "$WORK/split" > "$WORK/out.txt" 2>&1
expect_no_out "규약 경로의 생성물이 자기 스키마를 읽는다" "스키마 로드 실패"
expect_no_out "생성물에 revision이 있다(업그레이드 대상이 아니다)" "revision"
expect_no_out "갓 생성한 요청서는 낡지 않았다" "가 낡았다"
expect_no_out "갓 생성한 요청서는 옛 배치가 아니다" "옛 배치"
# 스키마 사본을 치우면 다시 침묵하는가 — "빠뜨리면 조용히 샌다"는 주장 자체를 고정한다
mv "$WORK/split/interface-requests/user/schemas/interface-request.v1.schema.json" "$WORK/ir.bak"
node "$CHECK" "$WORK/split" > "$WORK/out.txt" 2>&1
expect_out "사본이 없으면 스키마 로드 실패를 낸다" "스키마 로드 실패"
expect_out "그래서 무엇이 침묵하는지 밝힌다(조용한 통과 금지)" "이후 검사에서 전부 제외된다"
expect_out "어디에 두라고 알려준다" "문서 옆"
mv "$WORK/ir.bak" "$WORK/split/interface-requests/user/schemas/interface-request.v1.schema.json"
# 요구가 실제로 대조되는가 — 로드가 되면 죽은 링크 검사가 돈다
sed -i 's/"ref": "IO.auth.login.submit"/"ref": "IO.auth.login.gone"/' "$WORK/split/interface-requests/user/interface-request-user-auth.md"
node "$CHECK" "$WORK/split" > "$WORK/out.txt" 2>&1
expect_out "요청서의 요구가 화면 동작과 대조된다" "IO.auth.login.gone"

echo
echo "[16] 보여준다고 했는데 아무도 안 가져오는 데이터 — 빠진 조회 요구를 드러낸다"
# 화면 진입 로드는 '누르는 것'이 아니라 저작 지침에 자리가 없었고, 그래서 화면이 데이터를 보여준다고
# 선언해 놓고 아무도 가져오지 않는 상태가 조용히 남았다(실측: 화면 52개 중 15개가 요청서에 0줄).
mkdir -p "$WORK/unfetched/screens/user/schemas"
cp "$SET/schemas/screen-design.v1.schema.json" "$WORK/unfetched/screens/user/schemas/"
cat > "$WORK/unfetched/screens/user/screen-design-user-support.md" <<'MD'
---
doc_type: screen-design
version: 1
revision: 1
ssot: prose
machine:
  lang: json
  tag: screendesign.screens
  schema: schemas/screen-design.v1.schema.json
---
```json screendesign.screens
{ "screens": [
 { "id": "FEAT.support.inquiry.list", "components": ["UI.x"], "data": {
   "display": ["inquiry.title","inquiry.status","inquiry.createdAt"], "bindings": [],
   "io": [ { "action": "문의하기", "target": "client", "sends": [], "receives": [] } ] } },
 { "id": "FEAT.support.faq", "components": ["UI.x"], "data": {
   "display": ["faq.question","faq.answer"], "bindings": [],
   "io": [ { "id": "IO.support.faq.load", "action": "FAQ 가져오기", "target": "server",
             "sends": [], "receives": ["faq"] } ] } } ] }
```
MD
node "$CHECK" "$WORK/unfetched" > "$WORK/out.txt" 2>&1
expect_out "안 가져오는 데이터를 집계한다" "아무 동작도 가져오지 않는 데이터 3건"
expect_out "어느 화면인지 짚는다" "FEAT.support.inquiry.list"
expect_out "무엇을 하라는지 알려준다" "진입 로드로 담으세요"
expect_out "오탐 처리도 알려준다(지어내지 않게)" "정적 문구"
if grep -qF "· FEAT.support.faq —" "$WORK/out.txt"; then bad "진입 로드가 있는 화면을 잘못 잡음"; else ok "진입 로드가 있으면 잡지 않는다(그룹 단위 receives 인정)"; fi
# client·local 동작으로는 덮이지 않는다 — 서버에서 오는 것만 '가져온다'로 친다
sed -i 's/"action": "문의하기", "target": "client", "sends": \[\], "receives": \[\]/"action": "문의하기", "target": "local", "sends": [], "receives": ["inquiry.title","inquiry.status","inquiry.createdAt"]/' \
  "$WORK/unfetched/screens/user/screen-design-user-support.md"
node "$CHECK" "$WORK/unfetched" > "$WORK/out.txt" 2>&1
expect_out "local 동작이 받아도 서버 조회 요구로 치지 않는다" "아무 동작도 가져오지 않는 데이터 3건"

echo
echo "[17] 저장하지 않는 일회성 입력 — 적을 자리를 주되 뒷문은 막는다"
# 검색어는 데이터 모델에 없는 게 정상인데(저장하지 않으므로), sends가 실재 변수만 받아서 적을 데가 없었다.
# 그 결과 검색 동작이 sends: []로 넘어가 백엔드가 "입력 없는 검색"을 요구로 받았다(실측 결함).
mkdir -p "$WORK/transient/screens/user/schemas" "$WORK/transient/ssot/schemas"
cp "$SET/schemas/screen-design.v1.schema.json" "$WORK/transient/screens/user/schemas/"
dmsrc="$(find "$HERE/../.." -name "data-model.v1.schema.json" -path '*/schemas/*' | head -1)"
[ -n "$dmsrc" ] && cp "$dmsrc" "$WORK/transient/ssot/schemas/"
cat > "$WORK/transient/ssot/data-model.md" <<'MD'
---
doc_type: data-model
version: 1
revision: 1
ssot: prose
machine:
  lang: json
  tag: datamodel.group
  schema: schemas/data-model.v1.schema.json
---
```json datamodel.group
{ "group": "law", "label": "법령", "fields": [
  { "name": "id", "label": "ID", "type": "문자" },
  { "name": "name", "label": "이름", "type": "문자" } ] }
```
MD
mkscreen() {  # $1 = transientSends 항목
cat > "$WORK/transient/screens/user/screen-design-user-lawReview.md" <<MD
---
doc_type: screen-design
version: 1
revision: 1
ssot: prose
machine:
  lang: json
  tag: screendesign.screens
  schema: schemas/screen-design.v1.schema.json
---
\`\`\`json screendesign.screens
{ "screens": [ { "id": "FEAT.lawReview.lawSearch", "components": ["UI.x"], "data": {
  "display": ["law.name"], "bindings": [],
  "io": [ { "id": "IO.lawReview.lawSearch.search", "action": "검색", "target": "server",
            "sends": [], "transientSends": [$1], "receives": ["law.id","law.name"] } ] } } ] }
\`\`\`
MD
}
mkscreen '{ "name": "keyword", "desc": "법령명·조문 검색어" }'
node "$CHECK" "$WORK/transient" > "$WORK/out.txt" 2>&1
expect_no_out "일회성 입력은 데이터 모델 대조를 받지 않는다" "keyword"
node "$CHECK" "$WORK/transient" --emit-interface-request --scope user --domain lawReview 2>/dev/null > "$WORK/tr-req.md"
if grep -q "keyword(법령명·조문 검색어)" "$WORK/tr-req.md"; then ok "요청서 표에 일회성 입력이 실린다"; else bad "요청서 표에 없음"; fi
if grep -q '"transientSends"' "$WORK/tr-req.md"; then ok "요청서 블록에도 실린다(백엔드가 기계로 읽는다)"; else bad "블록에 없음"; fi
# 뒷문 — 실재 변수를 여기 적어 sends 제약을 우회하려 하면 잡는다
mkscreen '{ "name": "law.name", "desc": "법령명" }'
node "$CHECK" "$WORK/transient" > "$WORK/out.txt" 2>&1
expect_out "실재 변수를 일회성 입력에 적으면 잡는다" "데이터 모델 실재 변수다"
expect_out "어디로 옮기라는지 알려준다" "sends"
# 뜻 없는 이름은 스키마가 막는다
mkscreen '{ "name": "keyword" }'
node "$CHECK" "$WORK/transient" > "$WORK/out.txt" 2>&1
expect_out "뜻 없는 일회성 입력은 스키마가 막는다" "desc 누락"

echo
echo "[18] 변경 동작의 응답을 조회로 오인하지 않는다 (미탐 — 조용히 통과하던 자리)"
# receives는 진입 조회만의 것이 아니다. 승인·반려·저장도 결과를 받는다. 그 응답이 화면 값을 덮으면
# "미조회 0"이 되어 **진입 조회가 없는데 통과**한다(실측: 상세 화면 둘이 그렇게 요청서에 0줄로 나갔다).
mkdir -p "$WORK/mutation/screens/backoffice/schemas"
cp "$SET/schemas/screen-design.v1.schema.json" "$WORK/mutation/screens/backoffice/schemas/"
cat > "$WORK/mutation/screens/backoffice/screen-design-backoffice-tenant.md" <<'MD'
---
doc_type: screen-design
version: 1
revision: 1
ssot: prose
machine:
  lang: json
  tag: screendesign.screens
  schema: schemas/screen-design.v1.schema.json
---
```json screendesign.screens
{ "screens": [ { "id": "FEAT.admin.tenantProvision.detail", "components": ["UI.x"], "data": {
  "display": ["orgApplication.orgName","orgApplication.bizNo","orgApplication.phone"], "bindings": [],
  "io": [
    { "id": "IO.admin.tenantProvision.approve", "action": "승인", "target": "server", "ui": "UI.x",
      "sends": ["orgApplication.id"],
      "receives": ["orgApplication.orgName","orgApplication.bizNo","orgApplication.phone"] },
    { "id": "IO.admin.tenantProvision.reject", "action": "반려", "target": "server", "ui": "UI.x",
      "sends": ["orgApplication.id"],
      "receives": ["orgApplication.orgName","orgApplication.bizNo","orgApplication.phone"] } ] } } ] }
```
MD
node "$CHECK" "$WORK/mutation" > "$WORK/out.txt" 2>&1
expect_no_out "옛 신호는 여기서 침묵한다(변경 응답이 값을 덮어서)" "아무 동작도 가져오지 않는 데이터"
expect_out "진입 로드 0건을 따로 잡는다" "진입 로드가 하나도 없는 화면** 1개"
expect_out "어느 화면인지 짚는다" "FEAT.admin.tenantProvision.detail"
expect_out "변경 동작의 응답은 조회가 아님을 밝힌다" "변경 동작의 응답"
# 진입 로드를 채우면 해제된다
sed -i 's|"io": \[|"io": [\n    { "id": "IO.admin.tenantProvision.load", "action": "신청 상세 가져오기", "target": "server",\n      "sends": ["orgApplication.id"],\n      "receives": ["orgApplication.orgName","orgApplication.bizNo","orgApplication.phone"] },|' \
  "$WORK/mutation/screens/backoffice/screen-design-backoffice-tenant.md"
node "$CHECK" "$WORK/mutation" > "$WORK/out.txt" 2>&1
expect_no_out "진입 로드를 채우면 해제된다" "진입 로드가 하나도 없는 화면"

echo
echo "[19] --verbose — 목록을 자르지 않는다"
# 5건에서 자르면 작업 목록을 만들 수 없어, 실사용자가 검사기와 같은 판정을 다시 구현했다.
mkdir -p "$WORK/many/screens/user/schemas"
cp "$SET/schemas/screen-design.v1.schema.json" "$WORK/many/screens/user/schemas/"
{
  printf -- '---\ndoc_type: screen-design\nversion: 1\nrevision: 1\nssot: prose\nmachine:\n  lang: json\n  tag: screendesign.screens\n  schema: schemas/screen-design.v1.schema.json\n---\n'
  printf '```json screendesign.screens\n{ "screens": ['
  for i in 1 2 3 4 5 6 7; do
    [ $i -gt 1 ] && printf ','
    printf '{ "id": "FEAT.d%s.list", "components": ["UI.x"], "data": { "display": ["g%s.f"], "bindings": [], "io": [] } }' "$i" "$i"
  done
  printf '] }\n```\n'
} > "$WORK/many/screens/user/screen-design-user-many.md"
node "$CHECK" "$WORK/many" > "$WORK/out.txt" 2>&1
expect_out "기본은 5건까지 + 안내" "--verbose로 전부"
if [ "$(grep -c '· FEAT.d' "$WORK/out.txt")" -le 12 ]; then ok "기본 출력은 짧게 유지된다"; else bad "기본 출력이 안 잘림"; fi
node "$CHECK" "$WORK/many" --verbose > "$WORK/out.txt" 2>&1
if grep -q "FEAT.d7.list" "$WORK/out.txt"; then ok "--verbose는 전부 낸다"; else bad "--verbose인데 잘림"; fi
expect_no_out "--verbose에는 '외 n건' 안내가 없다" "--verbose로 전부"

echo
echo "[20] 스키마 위반에 형태 힌트를 곁들인다"
# "타입 object 아님"만 받으면 무엇을 써야 하는지 알 수 없다(실사용 왕복).
mkdir -p "$WORK/hint/screens/user/schemas"
cp "$SET/schemas/screen-design.v1.schema.json" "$WORK/hint/screens/user/schemas/"
cat > "$WORK/hint/screens/user/s.md" <<'MD'
---
doc_type: screen-design
version: 1
revision: 1
ssot: prose
machine:
  lang: json
  tag: screendesign.screens
  schema: schemas/screen-design.v1.schema.json
---
```json screendesign.screens
{ "screens": [ { "id": "FEAT.law.search", "components": ["UI.x"], "data": {
  "display": [], "bindings": [],
  "io": [ { "id": "IO.law.search.go", "action": "검색", "target": "server",
            "sends": [], "transientSends": ["keyword"], "receives": [] } ] } } ] }
```
MD
node "$CHECK" "$WORK/hint" > "$WORK/out.txt" 2>&1
expect_out "무엇을 쓰면 되는지 알려준다" "name\": \"keyword\""

echo
echo "[21] 공통 프레임 — 껍데기 동작이 어디에도 못 담기던 자리"
# GNB·LNB·상단바에도 서버와 주고받는 일이 있다(세션 조회·로그아웃). 어느 화면 것도 아니라 지금까지
# 통째로 샜다 — 실측: 요청서 96건에 세션 조회 없음, 로그아웃은 마이페이지 화면에 억지로 귀속.
FR="$WORK/frame"
mkdir -p "$FR/screens/backoffice/schemas" "$FR/ssot/schemas"
cp "$SET/schemas/screen-design.v1.schema.json" "$FR/screens/backoffice/schemas/"
frsrc="$(find "$HERE/../.." -name "screen-design-frame.v1.schema.json" -path '*/schemas/*' | head -1)"
[ -n "$frsrc" ] && cp "$frsrc" "$FR/screens/backoffice/schemas/"
uisrc="$(find "$HERE/../.." -name "ui-components.v1.schema.json" -path '*/schemas/*' | head -1)"
[ -n "$uisrc" ] && cp "$uisrc" "$FR/ssot/schemas/"
[ -n "$dmsrc" ] && cp "$dmsrc" "$FR/ssot/schemas/"
cat > "$FR/ssot/data-model.md" <<'MD'
---
doc_type: data-model
version: 1
revision: 1
ssot: prose
machine:
  lang: json
  tag: datamodel.group
  schema: schemas/data-model.v1.schema.json
---
```json datamodel.group
{ "group": "operator", "label": "운영자", "fields": [
  { "name": "id", "label": "ID", "type": "문자" },
  { "name": "name", "label": "이름", "type": "문자" },
  { "name": "role", "label": "역할", "type": "문자" } ] }
```
MD
cat > "$FR/screens/backoffice/screen-design-backoffice-admin.md" <<'MD'
---
doc_type: screen-design
version: 1
revision: 1
ssot: prose
machine:
  lang: json
  tag: screendesign.screens
  schema: schemas/screen-design.v1.schema.json
---
```json screendesign.screens
{ "screens": [ { "id": "FEAT.admin.login", "components": ["UI.nav.topbar"],
  "data": { "display": [], "bindings": [], "io": [] } } ] }
```
MD
mkframe() {  # $1 = frames 배열 본문
cat > "$FR/screens/backoffice/screen-design-backoffice-index.md" <<MD
---
doc_type: screen-design-index
version: 1
revision: 1
ssot: prose
machine:
  lang: json
  tag: screendesign.frame
  item: frame-list
  schema: schemas/screen-design-frame.v1.schema.json
---
# 백오피스 — 공통 UI 정의

\`\`\`json screendesign.frame
{ "scope": "backoffice", "frames": [$1] }
\`\`\`
MD
}
FRAME_OK='{ "id": "FRAME.backoffice.shell", "label": "공통 껍데기",
  "components": ["UI.nav.lnb","UI.nav.topbar"],
  "appliesTo": { "except": ["FEAT.admin.login"] },
  "data": { "display": ["operator.name","operator.role"], "io": [
    { "id": "IO.backoffice.shell.session", "action": "세션 운영자 조회", "target": "server",
      "sends": [], "receives": ["operator.id","operator.name","operator.role"],
      "semantics": "전 화면 진입 시 일어난다. 응답이 없으면 로그인으로 보낸다." },
    { "id": "IO.backoffice.shell.logout", "action": "로그아웃", "target": "server",
      "ui": "UI.nav.topbar", "sends": [], "receives": [] } ] } }'

# ⓐ 프레임 블록이 없으면 — 껍데기 동작을 담을 자리가 없다고 알린다
rm -f "$FR/screens/backoffice/screen-design-backoffice-index.md"
cat > "$FR/screens/backoffice/screen-design-backoffice-index.md" <<'MD'
---
doc_type: screen-design-index
version: 1
revision: 1
ssot: prose
---
# 백오피스 — 공통 UI 정의 (옛 형식: 기계 블록 없음)
MD
node "$CHECK" "$FR" > "$WORK/out.txt" 2>&1
expect_out "프레임 블록이 없으면 알린다(옛 세트 감지)" "공통 프레임 블록이 없는 화면 설계 index 1개"
expect_out "무엇이 빠지는지 밝힌다" "요청서에 한 줄도 안 나갑니다"

# ⓑ 채우면 — 등기부에 잡히고 경고가 해제된다
mkframe "$FRAME_OK"
node "$CHECK" "$FR" > "$WORK/out.txt" 2>&1
expect_no_out "채우면 경고가 해제된다" "공통 프레임 블록이 없는"
expect_out "프레임을 등기부에 올린다" "프레임 1"

# ⓒ 요청서 — 프레임은 자기 도메인(frame)으로 갈린다. 출처는 index 문서 하나다.
node "$CHECK" "$FR" --emit-interface-request --scope backoffice --list-domains 2>/dev/null > "$WORK/d.txt"
if grep -qx "frame" "$WORK/d.txt"; then ok "요청서 도메인에 frame이 뜬다"; else bad "frame 도메인 없음"; fi
node "$CHECK" "$FR" --emit-interface-request --scope backoffice --domain frame 2>/dev/null > "$WORK/fr-req.md"
if grep -q "IO.backoffice.shell.session" "$WORK/fr-req.md"; then ok "세션 조회가 요청서로 나간다"; else bad "세션 조회가 안 나감"; fi
if [ "$(grep -c '"path": "screens/' "$WORK/fr-req.md")" = "1" ]; then ok "출처가 index 문서 하나다"; else bad "출처가 여럿"; fi
expect_file() { if grep -qF -- "$2" "$3"; then ok "$1"; else bad "$1 — 없음: $2"; fi; }
expect_file "전 화면에 걸린다는 사실을 밝힌다" "걸리는 모든 화면에서" "$WORK/fr-req.md"
expect_file "예외 화면을 싣는다(로그인 순환 방지)" "FEAT.admin.login" "$WORK/fr-req.md"

# ⓓ 프레임도 화면과 같은 죽은 링크 검사를 받는다
mkframe "$(printf '%s' "$FRAME_OK" | sed 's/"UI.nav.lnb"/"UI.nav.ghost"/')"
node "$CHECK" "$FR" > "$WORK/out.txt" 2>&1
expect_out "프레임 컴포넌트도 인벤토리와 대조한다" "프레임 FRAME.backoffice.shell 의 컴포넌트 UI.nav.ghost"
mkframe "$(printf '%s' "$FRAME_OK" | sed 's/"FEAT.admin.login"/"FEAT.admin.ghost"/')"
node "$CHECK" "$FR" > "$WORK/out.txt" 2>&1
expect_out "appliesTo의 화면도 대조한다(오타면 가드가 로그인에 남는다)" "appliesTo FEAT.admin.ghost"

# ⓔ 두 범위가 같은 껍데기 이름을 쓴다 — 동작 id에 범위가 없으면 충돌한다(실측 결함).
#    사용자 앱과 백오피스가 둘 다 껍데기를 `shell`이라 부르므로, `IO.frame.shell.*`처럼 범위를 빼면
#    양쪽이 같은 id가 되어 요청서·백엔드 basis가 조용히 엉뚱한 동작에 붙는다.
mkframe "$FRAME_OK"
mkdir -p "$FR/screens/user/schemas"
cp "$SET/schemas/screen-design.v1.schema.json" "$FR/screens/user/schemas/"
[ -n "$frsrc" ] && cp "$frsrc" "$FR/screens/user/schemas/"
cat > "$FR/screens/user/screen-design-user-index.md" <<'MD'
---
doc_type: screen-design-index
version: 1
revision: 1
ssot: prose
machine:
  lang: json
  tag: screendesign.frame
  item: frame-list
  schema: schemas/screen-design-frame.v1.schema.json
---
```json screendesign.frame
{ "scope": "user", "frames": [ { "id": "FRAME.user.shell", "label": "사용자 앱 껍데기",
  "components": ["UI.nav.topbar"],
  "data": { "display": [], "io": [
    { "id": "IO.user.shell.session", "action": "세션 사용자 조회", "target": "server",
      "sends": [], "receives": ["operator.id"] } ] } } ] }
```
MD
node "$CHECK" "$FR" > "$WORK/out.txt" 2>&1
expect_no_out "범위가 다르면 같은 껍데기 이름이어도 안 겹친다" "중복 동작 id"
# 범위를 뺀 옛 표기로 되돌리면 실제로 겹친다 — 그 사실을 고정한다
sed -i 's/IO.user.shell.session/IO.frame.shell.session/' "$FR/screens/user/screen-design-user-index.md"
sed -i 's/IO.backoffice.shell.session/IO.frame.shell.session/' "$FR/screens/backoffice/screen-design-backoffice-index.md"
node "$CHECK" "$FR" > "$WORK/out.txt" 2>&1
expect_out "범위를 빼면 두 범위가 충돌하는 것을 잡는다" "중복 동작 id: IO.frame.shell.session"

# ⓕ **범위가 하나뿐이면 충돌이 안 나 조용히 통과한다** — 그래서 소유자와 직접 대조한다.
#    (계약을 바꿔 놓고 기존 문서 업그레이드 경로를 안 내면 여기가 영영 안 보인다.)
rm -f "$FR/screens/user/screen-design-user-index.md"
node "$CHECK" "$FR" > "$WORK/out.txt" 2>&1
expect_no_out "범위가 하나면 중복은 안 난다" "중복 동작 id"
expect_out "그래도 소유 프레임과 어긋난 id를 잡는다" "소유 프레임과 어긋난 동작 id"
expect_out "무엇으로 바꾸라는지 알려준다" "IO.backoffice.shell.<동작>"
expect_out "백엔드 basis도 함께 고치라고 알려준다" "죽은 링크로 잡힌다"
mkframe "$FRAME_OK"
node "$CHECK" "$FR" > "$WORK/out.txt" 2>&1
expect_no_out "이관하면 해제된다" "소유 프레임과 어긋난 동작 id"

echo
echo "[22] 검증기의 두 구멍 — 모르는 키와 스키마 참조 (둘 다 미탐이었다)"
# 잘못 썼는데 `위반:0`이 나오면 쓴 사람은 맞게 쓴 줄 안다. 실사용에서 `appliesTo`의 키를 `exclude`로
# 잘못 쓰고도 통과해, 로그인 화면이 껍데기에서 안 빠진 채 "로그인하려면 세션이 있어야 한다"가 될 뻔했다.
VH="$WORK/valhole"
mkdir -p "$VH/screens/user/schemas"
cp "$SET/schemas/screen-design.v1.schema.json" "$VH/screens/user/schemas/"
[ -n "$frsrc" ] && cp "$frsrc" "$VH/screens/user/schemas/"

# (가) additionalProperties: false — 모르는 키
cat > "$VH/screens/user/s.md" <<'MD'
---
doc_type: screen-design
version: 1
revision: 1
ssot: prose
machine:
  lang: json
  tag: screendesign.screens
  schema: schemas/screen-design.v1.schema.json
---
```json screendesign.screens
{ "screens": [ { "id": "FEAT.law.search", "feat": "FEAT.law.search", "components": ["UI.x"],
  "data": { "display": [], "bindings": [], "io": [
    { "id": "IO.law.search.go", "action": "검색", "target": "server",
      "sends": [], "receives": [],
      "transientSends": [ { "name": "keyword", "desc": "검색어", "엉터리키": 1 } ] } ] } } ] }
```
MD
node "$CHECK" "$VH" > "$WORK/out.txt" 2>&1
expect_out "잠근 객체의 모르는 키를 잡는다" "transientSends[0].엉터리키 — 스키마에 없는 키"
expect_out "오타인지 확인하라고 후보를 보여준다" "오타인지 확인"

# (나) 오타로 잠긴 객체를 우회하던 실제 사례 — appliesTo의 키(exclude/except)
cat > "$VH/screens/user/screen-design-user-index.md" <<'MD'
---
doc_type: screen-design-index
version: 1
revision: 1
ssot: prose
machine:
  lang: json
  tag: screendesign.frame
  item: frame-list
  schema: schemas/screen-design-frame.v1.schema.json
---
```json screendesign.frame
{ "scope": "user", "frames": [ { "id": "FRAME.user.shell", "label": "껍데기",
  "components": ["UI.x"], "appliesTo": { "exclude": ["FEAT.law.search"] },
  "data": { "display": [], "io": [] } } ] }
```
MD
node "$CHECK" "$VH" > "$WORK/out.txt" 2>&1
expect_out "appliesTo의 키 오타(exclude)를 잡는다" "appliesTo.exclude — 스키마에 없는 키"

# (다) 참조($ref) — 프레임 io는 그것으로 정의된다. 지원이 없으면 **통째로 무검사**가 된다.
#      편집이 실제로 먹었는지 먼저 증명한다 — 결과가 "아무 일도 안 일어남"인 시험은
#      시험 자체가 아무 일도 안 한 경우와 구분되지 않는다(제보자의 오보가 정확히 그 경로였다).
sed -i 's/"appliesTo": { "exclude": \["FEAT.law.search"\] },//' "$VH/screens/user/screen-design-user-index.md"
sed -i 's/"io": \[\]/"io": [ { "완전히엉터리": 1 } ]/' "$VH/screens/user/screen-design-user-index.md"
if [ "$(grep -c '완전히엉터리' "$VH/screens/user/screen-design-user-index.md")" = "1" ]; then
  ok "픽스처 편집이 실제로 적용됐다(전제 확인)"
else
  bad "픽스처 편집이 안 먹었다 — 아래 결과는 무의미하다"
fi
node "$CHECK" "$VH" > "$WORK/out.txt" 2>&1
expect_out "참조 안의 required가 살아난다(action)" "io[0].action 누락"
expect_out "참조 안의 모르는 키도 잡는다" "완전히엉터리 — 스키마에 없는 키"

# (라) 생성기가 내는 키는 스키마가 알아야 한다 — 요청서의 frame·appliesTo
#      (0.10.0에서 생성기에만 넣고 스키마에 안 넣어, 우리가 만든 파일이 우리 스키마를 위반하고 있었다)
irs="$(find "$HERE/../.." -name "interface-request.v1.schema.json" -path '*/schemas/*' | head -1)"
if [ -n "$irs" ] && node -e "
const k = require('$irs').properties.requests.items.properties;
process.exit(('frame' in k && 'appliesTo' in k) ? 0 : 1)"; then
  ok "요청서 스키마가 frame·appliesTo를 안다(생성기와 어긋나지 않는다)"
else
  bad "요청서 스키마에 frame·appliesTo가 없다 — 생성물이 자기 스키마를 위반한다"
fi

echo
echo "[23] 인증 요건(auth) — 누가 쓸 수 있는지가 요구에 실린다"
# 실측: 서버 동작 135건 중 82건이 권한 정보 없이 백엔드로 나갔고, 그중 27건이 운영자 전용이었다
# (청구 목록·상품 노출 토글 등). 없다고 "인증 불필요"로 간주하면 그 27건이 공개 엔드포인트가 된다.
AU="$WORK/auth"
mkdir -p "$AU/screens/user/schemas" "$AU/ssot/schemas"
cp "$SET/schemas/screen-design.v1.schema.json" "$AU/screens/user/schemas/"
[ -n "$dmsrc" ] && cp "$dmsrc" "$AU/ssot/schemas/"
cat > "$AU/ssot/data-model.md" <<'MD'
---
doc_type: data-model
version: 1
revision: 1
ssot: prose
machine:
  lang: json
  tag: datamodel.group
  schema: schemas/data-model.v1.schema.json
---
```json datamodel.group
{ "group": "product", "label": "상품", "fields": [
  { "name": "id", "label": "ID", "type": "문자" },
  { "name": "name", "label": "이름", "type": "문자" } ] }
```
MD
mkauth() {  # $1 = io 배열 본문
cat > "$AU/screens/user/s.md" <<MD
---
doc_type: screen-design
version: 1
revision: 1
ssot: prose
machine:
  lang: json
  tag: screendesign.screens
  schema: schemas/screen-design.v1.schema.json
---
\`\`\`json screendesign.screens
{ "screens": [ { "id": "FEAT.product.list", "feat": "FEAT.product.list", "components": ["UI.x"],
  "data": { "display": [], "bindings": [], "io": [$1] } },
 { "id": "FEAT.admin.product.list", "feat": "FEAT.admin.product.list", "components": ["UI.x"],
  "data": { "display": [], "bindings": [], "io": [
    { "id": "IO.admin.product.list.load", "action": "운영자 상품 목록", "target": "server",
      "auth": { "required": true, "roles": ["operator"] },
      "sends": [], "receives": ["product.id","product.name"] } ] } } ] }
\`\`\`
MD
}
# (가) server 동작인데 auth가 없으면 **오류**다 — 미분류를 "불필요"로 간주하지 않는다
mkauth '{ "id": "IO.product.list.load", "action": "상품 목록", "target": "server",
      "sends": [], "receives": ["product.id","product.name"] }'
node "$CHECK" "$AU" > "$WORK/out.txt" 2>&1
expect_out "server 동작에 auth가 없으면 잡는다" "인증 요건(\`auth\`)이 없는 서버 동작 1건"
expect_out "어느 동작인지 짚는다" "IO.product.list.load"
expect_out "방식은 적지 말라고 안내한다" "방식(토큰·세션·모드)은 적지 않습니다"
expect_out "지어내지 말라고 안내한다" "[확인 필요: 이 동작의 권한]"

# (나) client·local 동작에는 요구하지 않는다 — 화면 이동까지 강제하면 소음이다
mkauth '{ "id": "IO.product.list.go", "action": "상세로 이동", "target": "client", "sends": [], "receives": [] },
    { "id": "IO.product.list.load", "action": "상품 목록", "target": "server", "auth": { "required": false },
      "sends": [], "receives": ["product.id","product.name"] }'
node "$CHECK" "$AU" > "$WORK/out.txt" 2>&1
expect_no_out "client 동작에는 auth를 요구하지 않는다" "인증 요건"

# (다) **권한이 다르면 묶기 후보로 올리지 않는다** — 백엔드 스킬의 묶기 금지 신호 1번.
#      보내고 받는 것이 같아도 한쪽은 비로그인, 한쪽은 운영자 전용이면 묶으면 그 순간 열린다.
node "$CHECK" "$AU" --emit-interface-request --scope user --domain s 2>/dev/null > "$WORK/au-req.md"
if grep -q "묶을 후보" "$WORK/au-req.md"; then bad "권한이 다른데 묶을 후보로 올림"; else ok "권한이 다르면 묶기 후보에서 가른다"; fi
# 권한을 같게 맞추면 그때는 후보가 된다(형태가 같으므로)
mkauth '{ "id": "IO.product.list.load", "action": "상품 목록", "target": "server",
      "auth": { "required": true, "roles": ["operator"] },
      "sends": [], "receives": ["product.id","product.name"] }'
node "$CHECK" "$AU" --emit-interface-request --scope user --domain s 2>/dev/null > "$WORK/au-req.md"
if grep -q "묶을 후보" "$WORK/au-req.md"; then ok "권한이 같으면 후보로 올린다"; else bad "권한이 같은데 후보가 안 뜸"; fi

# (라) 요청서가 인증 요건을 싣는다 — 미분류는 **빈칸이 아니라 '미분류'**로 적는다
if grep -q "필요 (operator)" "$WORK/au-req.md"; then ok "요청서 표에 역할까지 싣는다"; else bad "요청서에 인증 요건이 없음"; fi
if grep -q '"auth"' "$WORK/au-req.md"; then ok "요청서 블록에도 싣는다(백엔드가 기계로 읽는다)"; else bad "블록에 없음"; fi

echo
echo "[24] IA 범위별 분리 — 파일이 갈리면서 생기는 것들"
# 트랙이 갈린 모노레포에서 IA만 소유자가 둘이라 합칠 때마다 충돌한다(실측: 충돌 원인이 frontmatter
# revision 한 줄). 파일을 나누면 사라지는데, 대신 한 파일일 때는 불가능했던 사고가 생긴다.
IA="$WORK/iasplit"
mkdir -p "$IA/ssot/schemas"
iasrc="$(find "$HERE/../.." -name "ia.v1.schema.json" -path '*/schemas/*' | head -1)"
[ -n "$iasrc" ] && cp "$iasrc" "$IA/ssot/schemas/"
mkia() {  # $1 = 파일명, $2 = features 본문
cat > "$IA/ssot/$1" <<MD
---
doc_type: ia
version: 1
revision: 1
ssot: prose
machine:
  lang: json
  tag: ia.features
  schema: schemas/ia.v1.schema.json
  namespace: FEAT
---
\`\`\`json ia.features
{ "features": [$2] }
\`\`\`
MD
}
# (가) 나눠도 등기부는 하나로 모인다 — 크로스참조가 그대로 돈다
mkia ia-user.md '{ "id": "FEAT.order.create", "label": "주문하기", "audience": "user", "status": "확정" }'
mkia ia-backoffice.md '{ "id": "FEAT.admin.order.list", "label": "주문 관리", "audience": "admin", "status": "확정" }'
node "$CHECK" "$IA" > "$WORK/out.txt" 2>&1
expect_out "나뉜 두 파일의 기능이 한 등기부로 모인다" "FEAT 2"
expect_no_out "정상 분리에는 아무 말도 하지 않는다" "중복 기능 정의"

# (나) **중복 기능 정의** — 파일이 하나일 때는 불가능했던 사고다
mkia ia-backoffice.md '{ "id": "FEAT.order.create", "label": "주문 관리", "audience": "admin", "status": "확정" }'
node "$CHECK" "$IA" > "$WORK/out.txt" 2>&1
expect_out "같은 FEAT이 두 파일에 있으면 잡는다" "중복 기능 정의: FEAT.order.create"
expect_out "어느 두 파일인지 밝힌다" "ia-user.md"

# (다) **범위와 어긋난 기능** — 판정 근거는 파일명이 아니라 audience 다
mkia ia-backoffice.md '{ "id": "FEAT.support.faq", "label": "FAQ", "audience": "user", "status": "확정" }'
node "$CHECK" "$IA" > "$WORK/out.txt" 2>&1
expect_out "나눈 파일에 다른 범위가 섞이면 알린다" "범위와 어긋난 기능 1건"
expect_out "audience 가 정본임을 밝힌다" "audience\` 값이 정본입니다"

# (라) 나누지 않은 세트(범위 표시 없는 파일명)는 대상이 아니다
rm -f "$IA/ssot/ia-user.md" "$IA/ssot/ia-backoffice.md"
mkia ia.md '{ "id": "FEAT.support.faq", "label": "FAQ", "audience": "user", "status": "확정" },
  { "id": "FEAT.admin.order.list", "label": "주문 관리", "audience": "admin", "status": "확정" }'
node "$CHECK" "$IA" > "$WORK/out.txt" 2>&1
expect_no_out "한 파일 세트에는 범위 어긋남을 말하지 않는다" "범위와 어긋난 기능"
expect_no_out "한 파일 안에서는 중복도 아니다" "중복 기능 정의"

echo
echo "[25] 근거가 요청서를 안 탄 인터페이스 — 갈래를 갈라 안내한다"
# 실측 사고: 요청이 이슈로 왔는데 basis가 필수라 엉뚱한 화면 동작 id를 갖다 붙였고, id가 실재하니
# 점검기가 통과시켰다. 그런데 그 4건의 답은 `ops`가 아니라 **화면 설계서**였다 —
# 서버를 거치는 동작이 target: client로 적혀 있어 요청서에서 빠진 것이었다.
# 한 갈래로 뭉쳐 "ops를 쓰라"고 안내하면 엉뚱한 곳을 고치게 된다.
BS="$WORK/basis"
mkdir -p "$BS/screens/user/schemas" "$BS/ssot/backend/schemas" "$BS/interface-requests/user/schemas"
cp "$SET/schemas/screen-design.v1.schema.json" "$BS/screens/user/schemas/"
[ -n "$irsrc" ] && cp "$irsrc" "$BS/interface-requests/user/schemas/"
bisrc="$(find "$HERE/../.." -name "backend-interface.v1.schema.json" -path '*/schemas/*' | head -1)"
[ -n "$bisrc" ] && cp "$bisrc" "$BS/ssot/backend/schemas/"
mkscr() {  # $1 = target — 따옴표 있는 heredoc으로 쓰고 자리표시자만 바꾼다(백틱이 명령 치환되지 않게)
cat > "$BS/screens/user/screen-design-user-law.md" <<'MD'
---
doc_type: screen-design
version: 1
revision: 1
ssot: prose
machine:
  lang: json
  tag: screendesign.screens
  schema: schemas/screen-design.v1.schema.json
---
```json screendesign.screens
{ "screens": [ { "id": "FEAT.law.review", "feat": "FEAT.law.review", "components": ["UI.x"],
  "data": { "display": [], "bindings": [], "io": [
    { "id": "IO.law.review.editList", "action": "법령 담기", "target": "__TARGET__",
      "auth": { "required": true }, "sends": [], "receives": [] } ] } } ] }
```
MD
  sed -i "s/__TARGET__/$1/" "$BS/screens/user/screen-design-user-law.md"
  grep -q "\"target\": \"$1\"" "$BS/screens/user/screen-design-user-law.md" || bad "픽스처 편집이 안 먹었다($1)"
}
cat > "$BS/ssot/backend/backend-interface.md" <<'MD'
---
doc_type: backend-interface
version: 1
revision: 1
ssot: prose
machine:
  lang: json
  tag: backend.interfaces
  schema: schemas/backend-interface.v1.schema.json
  namespace: BEITF
---
```json backend.interfaces
{ "interfaces": [ { "id": "BEITF.user.law.add", "summary": "법령 담기",
  "transport": "rest", "binding": { "method": "POST", "path": "/laws" },
  "auth": { "mode": "session", "desc": "로그인 필요" },
  "request": { "fields": [ { "name": "lawId", "in": "body", "type": "string", "desc": "법령 ID",
                             "enum": ["a","b"], "optional": true } ] },
  "response": { "fields": [ { "name": "ok", "type": "boolean", "desc": "성공" } ] },
  "basis": [ { "kind": "screen-io", "ref": "IO.law.review.editList" } ] } ] }
```
MD
# 요청서는 있으나 그 동작이 안 실렸다(화면이 client라 생성에서 빠짐)
cat > "$BS/interface-requests/user/interface-request-user-other.md" <<'MD'
---
doc_type: interface-request
version: 1
revision: 1
ssot: prose
machine:
  lang: json
  tag: interface.requests
  item: request-list
  schema: schemas/interface-request.v1.schema.json
---
```json interface.requests
{ "generatedAt": "2026-08-27", "scope": "user", "domain": "other",
  "from": [ { "path": "screens/user/screen-design-user-law.md", "contentHash": "sha256:x" } ],
  "requests": [ { "ref": "IO.law.other.load", "screen": "FEAT.law.other", "action": "다른 것",
                  "sends": [], "receives": [] } ] }
```
MD
# (가) target: client → **화면 설계서를 고치라**고 안내해야 한다
mkscr client
node "$CHECK" "$BS" > "$WORK/out.txt" 2>&1
expect_out "요청서를 안 탄 근거를 잡는다" "요청서에 없는 동작을 근거로 든 인터페이스 1건"
expect_out "화면 설계서를 고치라고 안내한다" "화면 설계서를 고치세요"
expect_out "ops로 바꾸지 말라고 못박는다" "\`ops\`로 바꾸지 마세요"

# (나) target: server 인데 요청서에 없음 → **요청서를 다시 뽑으라**고 안내해야 한다
mkscr server
node "$CHECK" "$BS" > "$WORK/out.txt" 2>&1
expect_out "이때는 요청서 재생성을 안내한다" "요청서를 다시 뽑으세요"
expect_no_out "이때는 화면 설계서를 고치라고 하지 않는다" "화면 설계서를 고치세요"

# (다) 요청서에 실리면 조용하다
sed -i 's|"ref": "IO.law.other.load", "screen": "FEAT.law.other", "action": "다른 것"|"ref": "IO.law.review.editList", "screen": "FEAT.law.review", "action": "법령 담기"|' \
  "$BS/interface-requests/user/interface-request-user-other.md"
node "$CHECK" "$BS" > "$WORK/out.txt" 2>&1
expect_no_out "요청서에 실려 있으면 아무 말도 하지 않는다" "요청서에 없는 동작을 근거로"

# (라) 별칭 키 집계 — 표준은 values·required 다
expect_out "허용값 별칭(enum)을 집계한다" "enum 1건"
expect_out "필수 여부 별칭(optional)도 집계한다" "optional 1건"
expect_out "표준 이름을 알려준다" "허용값 \`values\` · 필수 여부 \`required\`"

# (마) **수확된 적 없는 화면 문서**의 동작은 판정하지 않는다 — 한 트랙 요청서만 가진 리포에서
#      그 트랙 전체가 통째로 위반으로 뜨는 오탐을 막는다. 요청서가 이 화면에서 나온 적이 없으면
#      "아직 요청서가 없는 것"이지 근거가 틀린 것이 아니다.
mkscr client
sed -i 's|"path": "screens/user/screen-design-user-law.md"|"path": "screens/user/screen-design-user-other.md"|' \
  "$BS/interface-requests/user/interface-request-user-other.md"
sed -i 's|"ref": "IO.law.review.editList", "screen": "FEAT.law.review", "action": "법령 담기"|"ref": "IO.law.other.load", "screen": "FEAT.law.other", "action": "다른 것"|' \
  "$BS/interface-requests/user/interface-request-user-other.md"
node "$CHECK" "$BS" > "$WORK/out.txt" 2>&1
expect_no_out "수확된 적 없는 화면의 동작은 근거 판정에서 빼둔다" "요청서에 없는 동작을 근거로"
# 같은 화면이 한 번이라도 수확됐으면 다시 판정한다(위 제외가 검사를 통째로 끄지 않는다)
sed -i 's|"path": "screens/user/screen-design-user-other.md"|"path": "screens/user/screen-design-user-law.md"|' \
  "$BS/interface-requests/user/interface-request-user-other.md"
node "$CHECK" "$BS" > "$WORK/out.txt" 2>&1
expect_out "그 화면이 수확되면 다시 판정한다" "요청서에 없는 동작을 근거로 든 인터페이스 1건"

echo
echo "[26] 목록의 항목 모양 · 근거 갈래 · 받는 쪽 일회성"
IT="$WORK/items"
mkdir -p "$IT/ssot/backend/schemas" "$IT/screens/user/schemas"
[ -n "$bisrc" ] && cp "$bisrc" "$IT/ssot/backend/schemas/"
cp "$SET/schemas/screen-design.v1.schema.json" "$IT/screens/user/schemas/"
mkitf() {  # $1 = interfaces 배열 JSON
cat > "$IT/ssot/backend/backend-interface.md" <<'MD'
---
doc_type: backend-interface
version: 1
revision: 1
ssot: prose
machine:
  lang: json
  tag: backend.interfaces
  schema: schemas/backend-interface.v1.schema.json
  namespace: BEITF
---
```json backend.interfaces
__BODY__
```
MD
  python3 - "$IT/ssot/backend/backend-interface.md" "$1" <<'PY'
import sys
p, body = sys.argv[1], sys.argv[2]
s = open(p, encoding='utf-8').read().replace('__BODY__', body)
open(p, 'w', encoding='utf-8').write(s)
PY
  grep -q '__BODY__' "$IT/ssot/backend/backend-interface.md" && bad "픽스처 치환이 안 먹었다"
}
# 파생 출처·일회성 결과 대조에 쓸 데이터 모델(없으면 "실재 변수"가 성립하지 않아 시험이 아무것도 안 한다)
mkdir -p "$IT/ssot/schemas"
dmsrc="$(find "$HERE/../.." -name "data-model.v1.schema.json" -path '*/schemas/*' | head -1)"
[ -n "$dmsrc" ] && cp "$dmsrc" "$IT/ssot/schemas/"
cat > "$IT/ssot/data-model.md" <<'MD'
---
doc_type: data-model
version: 1
revision: 1
ssot: prose
machine:
  lang: json
  tag: datamodel.group
  item: group
  schema: schemas/data-model.v1.schema.json
---
```json datamodel.group
{ "group": "law", "label": "법령", "fields": [
  { "name": "id", "type": "string", "required": true, "filledBy": "system" } ] }
```
MD

base='{"id":"BEITF.user.x.list","summary":"목록","transport":"rest","binding":{"method":"GET","path":"/x"},"auth":{"mode":"session","desc":"로그인"},"request":{"fields":[]},"basis":[{"kind":"ops","ref":"운영 요구","why":"배치"}],'

# (가) 목록인데 items 없음 + 근거 갈래 없음
mkitf "{\"interfaces\":[${base}\"response\":{\"fields\":[{\"name\":\"laws\",\"type\":\"list\",\"desc\":\"법령 목록\"}]}}]}"
node "$CHECK" "$IT" > "$WORK/out.txt" 2>&1
expect_out "목록인데 항목 모양이 없으면 잡는다" "목록인데 항목 모양이 없는 계약 필드 1건"
expect_out "원소 모양을 적으라고 안내한다" "원소 모양을 적으세요"
expect_out "근거 갈래 미기재도 잡는다" "근거 갈래가 안 적힌 계약 필드 1건"
expect_out "반대편(파생인데 dataModel)은 기계가 못 잡는다고 밝힌다" "반대편이 더 위험합니다"

# (나) 펼쳐 적은 것은 **고칠 자리가 다르다** — 형제를 모으는 일이다
mkitf "{\"interfaces\":[${base}\"response\":{\"fields\":[{\"name\":\"laws\",\"type\":\"list\",\"desc\":\"법령 목록\"},{\"name\":\"laws[].id\",\"type\":\"string\",\"desc\":\"법령 ID\",\"dataModel\":\"law.id\"}]}}]}"
node "$CHECK" "$IT" > "$WORK/out.txt" 2>&1
expect_out "펼쳐 적었으면 형제를 모으라고 안내한다" "형제 필드를 모으세요"
expect_no_out "이때는 원소 모양을 새로 적으라고 하지 않는다" "원소 모양을 적으세요"

# (다) items·근거를 갖추면 조용하다
mkitf "{\"interfaces\":[${base}\"response\":{\"fields\":[{\"name\":\"laws\",\"type\":\"list\",\"desc\":\"법령 목록\",\"transient\":true,\"items\":{\"type\":\"object\",\"desc\":\"법령 하나\",\"fields\":[{\"name\":\"id\",\"type\":\"string\",\"desc\":\"법령 ID\"}]}}]}}]}"
node "$CHECK" "$IT" > "$WORK/out.txt" 2>&1
expect_no_out "항목 모양과 근거를 갖추면 아무 말도 하지 않는다" "목록인데 항목 모양이 없는"
expect_no_out "근거 갈래도 조용하다" "근거 갈래가 안 적힌"

# (라) 근거 갈래를 둘 적으면 오류 · 파생 출처는 등기부 대조를 받는다
mkitf "{\"interfaces\":[${base}\"response\":{\"fields\":[{\"name\":\"masked\",\"type\":\"string\",\"desc\":\"끝 네 자리\",\"dataModel\":\"law.id\",\"derivedFrom\":{\"from\":[\"law.id\"],\"how\":\"끝 네 자리만 남긴다\"}}]}}]}"
node "$CHECK" "$IT" > "$WORK/out.txt" 2>&1
expect_out "근거 갈래를 둘 적으면 오류다" "근거 갈래가 둘"
mkitf "{\"interfaces\":[${base}\"response\":{\"fields\":[{\"name\":\"masked\",\"type\":\"string\",\"desc\":\"끝 네 자리\",\"derivedFrom\":{\"from\":[\"nosuch.field\"],\"how\":\"끝 네 자리만 남긴다\"}}]}}]}"
node "$CHECK" "$IT" > "$WORK/out.txt" 2>&1
expect_out "파생 출처가 데이터 모델에 없으면 죽은 링크다" "파생된 출처 nosuch.field"

# (마) 받는 쪽 일회성 — 실재 변수를 적으면 receives 우회다
cat > "$IT/screens/user/screen-design-user-x.md" <<'MD'
---
doc_type: screen-design
version: 1
revision: 1
ssot: prose
machine:
  lang: json
  tag: screendesign.screens
  schema: schemas/screen-design.v1.schema.json
---
```json screendesign.screens
{ "screens": [ { "id": "FEAT.x.list", "feat": "FEAT.x.list", "components": ["UI.x"],
  "data": { "display": [], "bindings": [], "io": [
    { "id": "IO.x.list.load", "action": "목록 조회", "target": "server",
      "auth": { "required": true }, "sends": [], "receives": [],
      "transientReceives": [ { "name": "totalCount", "desc": "전체 건수" } ] } ] } } ] }
```
MD
node "$CHECK" "$IT" > "$WORK/out.txt" 2>&1
expect_no_out "일회성 결과값은 등기부 대조를 받지 않는다" "일회성 결과 totalCount"
sed -i 's/"name": "totalCount", "desc": "전체 건수"/"name": "law.id", "desc": "전체 건수"/' "$IT/screens/user/screen-design-user-x.md"
node "$CHECK" "$IT" > "$WORK/out.txt" 2>&1
expect_out "실재 변수를 일회성 결과에 적으면 receives 로 옮기라고 한다" "일회성 결과 law.id"

echo
echo "[27] 항목 단위 개정 — 스크립트가 계산하고 사람은 올리기만"
RV="$WORK/rev"
mkdir -p "$RV/ssot/backend/schemas"
[ -n "$bisrc" ] && cp "$bisrc" "$RV/ssot/backend/schemas/"
mkrev() {  # $1 = path 값, $2 = 추가 키(예: ,"revision":5)
cat > "$RV/ssot/backend/backend-interface.md" <<'MD'
---
doc_type: backend-interface
version: 1
revision: 1
ssot: prose
machine:
  lang: json
  tag: backend.interfaces
  schema: schemas/backend-interface.v1.schema.json
  namespace: BEITF
---
```json backend.interfaces
{"interfaces":[{"id":"BEITF.user.x.get"__EXTRA__,"summary":"조회","transport":"rest","binding":{"method":"GET","path":"__PATH__"},"auth":{"mode":"session","desc":"로그인"},"request":{"fields":[]},"response":{"fields":[]},"basis":[{"kind":"ops","ref":"운영","why":"배치"}]}]}
```
MD
  python3 - "$RV/ssot/backend/backend-interface.md" "$1" "$2" <<'PY'
import sys
p, pth, extra = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(p, encoding='utf-8').read().replace('__PATH__', pth).replace('__EXTRA__', extra)
open(p, 'w', encoding='utf-8').write(s)
PY
  grep -q '__PATH__\|__EXTRA__' "$RV/ssot/backend/backend-interface.md" && bad "픽스처 치환이 안 먹었다"
}

# (가) 기록이 없으면 알린다 — 조용히 통과하지 않는다
mkrev "/x" ""
rm -f "$RV/interface-revisions.json"
node "$CHECK" "$RV" > "$WORK/out.txt" 2>&1
expect_out "개정 기록이 없으면 알린다" "항목 단위 개정 기록이 없습니다"
expect_out "과거 이력을 지어내지 않는다고 밝힌다" "지어내지 않습니다"

# (나) sync 하면 전부 1로 시작한다
node "$CHECK" "$RV" --sync-revisions > "$WORK/out.txt" 2>&1
expect_out "sync 하면 기록한다" "인터페이스 1건 (새로 1"
[ -f "$RV/interface-revisions.json" ] || bad "interface-revisions.json 이 안 만들어졌다"
grep -q '"revision": 1' "$RV/interface-revisions.json" || bad "개정 1로 시작하지 않았다"
node "$CHECK" "$RV" > "$WORK/out.txt" 2>&1
expect_out "바뀐 것이 없으면 일치라고 한다" "항목 단위 개정 1건 — 기록과 일치"

# (다) 계약이 바뀌면 오른다
mkrev "/x-v2" ""
node "$CHECK" "$RV" > "$WORK/out.txt" 2>&1
expect_out "계약이 바뀌면 개정이 오른다" "개정 1 → 2"
expect_out "어긋남을 집계한다" "기록되지 않은 변경 1건"
node "$CHECK" "$RV" --check-revisions > /dev/null 2>&1
[ $? -eq 1 ] || bad "--check-revisions 가 어긋남에 1을 안 냈다"

# (라) **근거만 바뀌면 오르지 않는다** — 계약이 바뀐 게 아니다
node "$CHECK" "$RV" --sync-revisions > /dev/null 2>&1
sed -i 's|"why":"배치"|"why":"배치 — 사유를 더 적었다"|' "$RV/ssot/backend/backend-interface.md"
grep -q "사유를 더 적었다" "$RV/ssot/backend/backend-interface.md" || bad "픽스처 편집이 안 먹었다"
node "$CHECK" "$RV" > "$WORK/out.txt" 2>&1
expect_out "근거만 바뀌면 개정이 오르지 않는다" "기록과 일치"

# (마) 사람은 **더 올릴 수만** 있다
mkrev "/x-v2" ',"revision":7'
node "$CHECK" "$RV" > "$WORK/out.txt" 2>&1
expect_out "사람이 올린 것을 존중한다" "사람이 올린 것 1건"
mkrev "/x-v2" ',"revision":1'
node "$CHECK" "$RV" > "$WORK/out.txt" 2>&1
expect_out "계산값보다 작게 적으면 오류다" "보다 작습니다 — 개정은 내려가지 않습니다"

echo
echo "[28] 재생성이 손으로 적은 것을 지울 때 — 조용히 지우지 않는다"
# 요청서는 파생물이라 통째로 다시 만들어지고, 계약 문서는 손질하는 곳이라 성질이 반대다.
# 같은 규약으로 덮으면 요청서 쪽에서만 조용히 샌다(실사용 제보: 스키마에 없는 키를 손으로 넣었는데
# 다음 생성 때 사라졌다). 지우기 전에 무엇이 지워지는지 알려야 한다.
RG="$WORK/regen"
mkdir -p "$RG/screens/user/schemas" "$RG/interface-requests/user/schemas"
cp "$SET/schemas/screen-design.v1.schema.json" "$RG/screens/user/schemas/"
[ -n "$irsrc" ] && cp "$irsrc" "$RG/interface-requests/user/schemas/"
cat > "$RG/screens/user/screen-design-user-auth.md" <<'MD'
---
doc_type: screen-design
version: 1
revision: 1
ssot: prose
machine:
  lang: json
  tag: screendesign.screens
  schema: schemas/screen-design.v1.schema.json
---
```json screendesign.screens
{ "screens": [ { "id": "FEAT.auth.login", "feat": "FEAT.auth.login", "components": ["UI.x"],
  "data": { "display": [], "bindings": [], "io": [
    { "id": "IO.auth.login.submit", "action": "로그인", "target": "server",
      "auth": { "required": false }, "sends": [], "receives": [] } ] } } ] }
```
MD
node "$CHECK" "$RG" --emit-interface-request --scope user --domain auth \
  > "$RG/interface-requests/user/interface-request-user-auth.md" 2>/dev/null
grep -q "IO.auth.login.submit" "$RG/interface-requests/user/interface-request-user-auth.md" || bad "요청서 생성이 안 됐다"

# 아직 손댄 것이 없으면 조용하다 (이 시험이 아무 일도 안 하는 경우와 구분되게 반대편을 먼저 고정한다)
node "$CHECK" "$RG" --emit-interface-request --scope user --domain auth > /dev/null 2>"$WORK/out.txt"
expect_no_out "손댄 것이 없으면 아무 말도 하지 않는다" "재생성이 지웁니다"

# 스키마에 없는 키를 손으로 넣으면 — 지워질 것을 알린다
python3 - "$RG/interface-requests/user/interface-request-user-auth.md" <<'PY'
import sys, re
p = sys.argv[1]; s = open(p, encoding='utf-8').read()
s2 = re.sub(r'(\{\s*\n\s*"ref":)', r'{\n      "items": "손으로 적은 원소 모양",\n      "ref":', s, count=1)
assert s != s2, "픽스처 편집이 안 먹었다"
open(p, 'w', encoding='utf-8').write(s2)
PY
node "$CHECK" "$RG" --emit-interface-request --scope user --domain auth > /dev/null 2>"$WORK/out.txt"
expect_out "손으로 넣은 키가 지워질 것을 알린다" "재생성이 지웁니다"
expect_out "어느 키인지 짚는다" "IO.auth.login.submit 의 items"
expect_out "원본에 적으라고 안내한다" "원본(화면 설계서)에 적고"

echo
echo "[29] 일회성 결과가 **수확 → 백엔드 입력 → 요청서**까지 실려 나가나 (층 끝까지)"
# 도그푸드에서 잡힌 결함: 스키마·검사·생성 코드는 다 있었는데 **수확부(screenIo)가 안 담아서**
# --emit-needs 와 요청서 표가 늘 비어 있었다. 블록에 적어도 백엔드는 그 요구를 영영 모른다.
# 회귀가 "블록이 스키마를 통과하나"만 봤기 때문에 통과했다 — 끝까지 따라가는 시험이 없었다.
TR="$WORK/transrecv"
mkdir -p "$TR/screens/user/schemas" "$TR/interface-requests/user/schemas" "$TR/ssot/schemas"
cp "$SET/schemas/screen-design.v1.schema.json" "$TR/screens/user/schemas/"
[ -n "$irsrc" ] && cp "$irsrc" "$TR/interface-requests/user/schemas/"
[ -n "$dmsrc" ] && cp "$dmsrc" "$TR/ssot/schemas/"
cat > "$TR/screens/user/screen-design-user-order.md" <<'MD'
---
doc_type: screen-design
version: 1
revision: 1
ssot: prose
machine:
  lang: json
  tag: screendesign.screens
  schema: schemas/screen-design.v1.schema.json
---
```json screendesign.screens
{ "screens": [ { "id": "FEAT.order.list", "feat": "FEAT.order.list", "components": ["UI.x"],
  "data": { "display": [], "bindings": [], "io": [
    { "id": "IO.order.list.load", "action": "목록 조회", "target": "server",
      "auth": { "required": true }, "sends": [], "receives": [],
      "transientReceives": [ { "name": "totalCount", "desc": "전체 건수" } ] } ] } } ] }
```
MD
node "$CHECK" "$TR" --emit-needs > "$WORK/needs.json" 2>/dev/null
grep -qF "totalCount" "$WORK/needs.json" \
  && ok "일회성 결과가 백엔드 입력(--emit-needs)에 실린다" \
  || bad "일회성 결과가 --emit-needs 에서 빠졌다 — 백엔드는 그 요구를 모른다"
node "$CHECK" "$TR" --emit-interface-request --scope user --domain order > "$WORK/req.md" 2>/dev/null
grep -qF "totalCount" "$WORK/req.md" \
  && ok "일회성 결과가 요청서 기계 블록·표에 실린다" \
  || bad "일회성 결과가 요청서에서 빠졌다"
grep -qF "일회성 결과" "$WORK/req.md" || bad "요청서 사람용 표에 '일회성 결과' 열이 없다"
# 반대편: 없으면 키를 만들지 않는다(빈 배열을 실어 "생각했는데 없다"와 섞지 않는다)
python3 - "$TR/screens/user/screen-design-user-order.md" <<'PY'
import sys, re
p = sys.argv[1]; s = open(p, encoding='utf-8').read()
s2 = re.sub(r',\s*\n\s*"transientReceives": \[[^\]]*\]', '', s)
assert s != s2, "픽스처 편집이 안 먹었다"
open(p, 'w', encoding='utf-8').write(s2)
PY
grep -q "transientReceives" "$TR/screens/user/screen-design-user-order.md" && bad "픽스처 편집이 안 먹었다"
node "$CHECK" "$TR" --emit-interface-request --scope user --domain order > "$WORK/req2.md" 2>/dev/null
grep -qF '"transientReceives"' "$WORK/req2.md" && bad "없는데도 transientReceives 키를 실었다" || ok "없으면 키를 만들지 않는다"

echo
echo "[30] 목록 컨테이너는 근거 갈래를 지지 않는다 (제대로 적은 문서가 벌받지 않게)"
# 도그푸드에서 잡힌 오탐: items 로 원소 모양을 제대로 적은 목록 컨테이너까지 "근거 미기재"로 잡혔다.
# 값의 근거는 원소 필드가 지고 컨테이너는 그릇일 뿐이다. 반대편(원소 모양이 없는 목록)은 여전히 잡아야 한다.
mkitf "{\"interfaces\":[${base}\"response\":{\"fields\":[{\"name\":\"rows\",\"type\":\"list\",\"desc\":\"목록\",\"items\":{\"type\":\"object\",\"desc\":\"한 줄\",\"fields\":[{\"name\":\"id\",\"type\":\"string\",\"desc\":\"번호\",\"dataModel\":\"law.id\"}]}}]}}]}"
node "$CHECK" "$IT" > "$WORK/out.txt" 2>&1
expect_no_out "items 를 갖춘 목록 컨테이너는 근거를 요구하지 않는다" "근거 갈래가 안 적힌"
expect_no_out "그 컨테이너는 항목 모양 경고도 받지 않는다" "목록인데 항목 모양이 없는"
# 반대편 — items 가 없으면 둘 다 잡는다(이 시험이 아무것도 안 하는 경우와 구분되게)
mkitf "{\"interfaces\":[${base}\"response\":{\"fields\":[{\"name\":\"rows\",\"type\":\"list\",\"desc\":\"목록\"}]}}]}"
node "$CHECK" "$IT" > "$WORK/out.txt" 2>&1
expect_out "items 가 없으면 항목 모양을 요구한다" "목록인데 항목 모양이 없는 계약 필드 1건"
expect_out "items 가 없으면 근거 갈래도 요구한다" "근거 갈래가 안 적힌 계약 필드 1건"

echo
echo "[31] 생성기가 자란 뒤로 다시 안 뽑은 요청서 (화면이 그대로라 아무도 못 보던 자리)"
# 요청서는 화면 + 생성기 로직의 함수인데 신선도 검사는 화면(from[].contentHash)만 본다.
# 실제 사고: 일회성 결과를 싣게 고쳤는데 옛 요청서는 그 열이 빈 채 남았고 점검기는 "세트 점검 통과"라고 답했다.
GN="$WORK/gen"
mkdir -p "$GN/screens/user/schemas" "$GN/interface-requests/user/schemas"
cp "$SET/schemas/screen-design.v1.schema.json" "$GN/screens/user/schemas/"
[ -n "$irsrc" ] && cp "$irsrc" "$GN/interface-requests/user/schemas/"
cat > "$GN/screens/user/screen-design-user-auth.md" <<'MD'
---
doc_type: screen-design
version: 1
revision: 1
ssot: prose
machine:
  lang: json
  tag: screendesign.screens
  schema: schemas/screen-design.v1.schema.json
---
```json screendesign.screens
{ "screens": [ { "id": "FEAT.auth.login", "feat": "FEAT.auth.login", "components": ["UI.x"],
  "data": { "display": [], "bindings": [], "io": [
    { "id": "IO.auth.login.submit", "action": "로그인", "target": "server",
      "auth": { "required": false }, "sends": [], "receives": [] } ] } } ] }
```
MD
node "$CHECK" "$GN" --emit-interface-request --scope user --domain auth \
  > "$GN/interface-requests/user/interface-request-user-auth.md" 2>/dev/null
# 갓 뽑은 것은 조용하다 (이 시험이 아무 일도 안 하는 경우와 구분되게 먼저 고정)
node "$CHECK" "$GN" > "$WORK/out.txt" 2>&1
expect_no_out "갓 뽑은 요청서는 아무 말도 하지 않는다" "생성기가 자란 뒤로"
grep -qF '"generatedWith"' "$GN/interface-requests/user/interface-request-user-auth.md" \
  && ok "생성물에 뽑은 판이 찍혀 있다" || bad "생성물에 generatedWith 가 없다 — 판정 근거가 사라진다"
# 판 표시를 지우면(= 옛 생성기로 뽑힌 것) 다시 뽑으라고 알린다
python3 - "$GN/interface-requests/user/interface-request-user-auth.md" <<'PY'
import sys, re
p = sys.argv[1]; s = open(p, encoding='utf-8').read()
s2 = re.sub(r'\s*"generatedWith": "[^"]*",', '', s)
assert s != s2, "픽스처 편집이 안 먹었다"
open(p, 'w', encoding='utf-8').write(s2)
PY
node "$CHECK" "$GN" > "$WORK/out.txt" 2>&1
expect_out "옛 생성기로 뽑힌 요청서를 잡는다" "생성기가 자란 뒤로 다시 안 뽑은 요청서 1건"
expect_out "다른 검사는 조용하다는 것을 밝힌다" "화면은 그대로라 다른 검사는 아무 말도 하지 않습니다"

echo
echo "결과: 통과 $pass · 실패 $fail"
exit $((fail > 0 ? 1 : 0))
