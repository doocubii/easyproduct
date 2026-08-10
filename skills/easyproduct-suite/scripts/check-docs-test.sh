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
     { "id": "IO.auth.login.submit", "action": "로그인", "target": "server",
       "sends": ["member.phone"], "receives": ["member.id"] } ] } },
 { "id": "FEAT.home.main", "feat": "FEAT.home.main", "components": ["UI.x"],
   "data": { "display": [], "bindings": [], "io": [
     { "id": "IO.home.main.login", "action": "홈에서 바로 로그인", "target": "server",
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
     { "id": "IO.order.detail.load", "action": "상세 보기", "target": "server", "sends": ["order.id"],
       "receives": ["order.status","order.amount","order.pickupSlot","order.itemNote","order.createdAt"] } ] } },
 { "id": "FEAT.order.list", "feat": "FEAT.order.list", "components": ["UI.x"],
   "data": { "display": [], "bindings": [], "io": [
     { "id": "IO.order.list.row", "action": "목록 한 줄", "target": "server", "sends": ["order.id"],
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
    { "id": "IO.auth.login.submit", "action": "로그인", "target": "server",
      "sends": ["member.phone"], "receives": ["member.id","member.name"] } ] } } ] }
```
MD
} > "$WORK/split/screens/user/screen-design-user-auth.md"
{ mkfront; cat <<'MD'
```json screendesign.screens
{ "screens": [ { "id": "FEAT.mypage.home", "feat": "FEAT.mypage.home", "components": ["UI.x"],
  "data": { "display": [], "bindings": [], "io": [
    { "id": "IO.mypage.home.load", "action": "내 정보", "target": "server",
      "sends": ["member.phone"], "receives": ["member.id","member.name"] } ] } } ] }
```
MD
} > "$WORK/split/screens/user/screen-design-user-mypage.md"
{ mkfront; cat <<'MD'
```json screendesign.screens
{ "screens": [ { "id": "FEAT.member.list", "feat": "FEAT.member.list", "components": ["UI.x"],
  "data": { "display": [], "bindings": [], "io": [
    { "id": "IO.member.list.load", "action": "회원 조회", "target": "server",
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
echo "결과: 통과 $pass · 실패 $fail"
exit $((fail > 0 ? 1 : 0))
