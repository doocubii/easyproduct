#!/usr/bin/env python3
"""sdd_check.py — SDD 강제 하네스 검사기 (참조 구현). 무의존 Python 3.8+ (표준 라이브러리만).

**정본은 `../references/checker-pseudocode.md`다.** 알고리즘·메시지·종료코드는 그 문서를 따르고,
이 파일은 그것의 Python 구현이다. 같은 정책·같은 저장소면 Node 구현(`sdd-check.mjs`)과 **동일한
위반 목록·종료코드**를 낸다(그 동일성은 두 구현을 나란히 돌려 --json으로 비교해 확인한다).

이 파일은 **정책(`sdd-policy.json`)만** 읽는다 — 프로젝트 이름·경로를 로직에 박지 않는다.
easyproduct 개념(FEAT/DATA/POL·check-docs)을 import하지 않는다. 어댑터는 "frontmatter가 가리키는
json 블록에서 id를 긁는다"는 일반 절차이며, 접두어·태그 이름은 전부 정책 문자열로 받는다.

사용:
    python3 sdd_check.py --full [--json] [--policy <path>]
    python3 sdd_check.py --changed <file> [<file>...] [--json]
종료코드: 0 = block 위반 없음(경고는 있어도 0) · 1 = block 위반 · 2 = 설정 오류
"""

import hashlib
import json
import os
import re
import subprocess
import sys

HEAD_LINES = 25          # 출처 태그를 찾을 파일 앞부분 범위(전체 스캔은 느리고 오탐이 난다)
SKIP_DIRS = {
    '.git', 'node_modules', 'dist', 'build', 'out', 'target', 'vendor',
    '.venv', 'venv', '__pycache__', '.next', '.nuxt', 'coverage', '.turbo', '.cache',
}


def fail(msg):
    print(f"설정 오류: {msg}", file=sys.stderr)
    sys.exit(2)


def usage():
    print("""sdd_check — SDD 강제 하네스 검사기
  --full                전체 검사(verify·CI). 7규칙 모두.
  --changed <files...>  변경 파일만(편집 훅). ① 하드, ③④⑥ 경고, ⑤⑦ 스킵.
  --json                기계 판독 출력
  --policy <path>       정책 파일 경로(기본: sdd-policy.json 탐색)""")


# ─────────────────────────────── 인자 ───────────────────────────────

def parse_args(argv):
    opts = {'mode': None, 'json': False, 'policy': None, 'files': []}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == '--full':
            opts['mode'] = 'full'
        elif a == '--changed':
            opts['mode'] = 'changed'
            while i + 1 < len(argv) and not argv[i + 1].startswith('--'):
                i += 1
                opts['files'].append(argv[i])
        elif a == '--json':
            opts['json'] = True
        elif a == '--policy':
            i += 1
            opts['policy'] = argv[i] if i < len(argv) else None
        elif a in ('--help', '-h'):
            usage()
            sys.exit(0)
        else:
            fail(f"알 수 없는 인자: {a}")
        i += 1
    return opts


OPTS = parse_args(sys.argv[1:])
if not OPTS['mode']:
    usage()
    sys.exit(2)


# ─────────────────────────────── 기본 유틸 ───────────────────────────────

def _root():
    try:
        out = subprocess.run(['git', 'rev-parse', '--show-toplevel'],
                             capture_output=True, text=True, check=True)
        return out.stdout.strip()
    except Exception:
        return os.getcwd()


ROOT = _root()


def git(args, allow_fail=False):
    """원문 그대로 반환한다 — `git status --porcelain`은 선행 상태 문자(예: " M path")가 의미를
    가지므로 여기서 strip하면 경로 오프셋이 밀린다. 단일 값이 필요한 곳만 호출부가 strip한다."""
    try:
        out = subprocess.run(['git'] + args, cwd=ROOT, capture_output=True, text=True, check=True)
        return out.stdout
    except Exception:
        if allow_fail:
            return None
        raise


def git_value(args):
    out = (git(args, True) or '').strip()
    return out or None


def status_paths():
    """`git status --porcelain`의 각 줄에서 경로만 뽑는다(이름 변경은 화살표 뒤가 현재 경로)."""
    paths = []
    for line in (git(['status', '--porcelain'], True) or '').split('\n'):
        m = re.match(r'^..\s+(.+)$', line)
        if not m:
            continue
        p = m.group(1)
        if ' -> ' in p:
            p = p.split(' -> ')[1]
        paths.append(p.strip('"'))
    return paths


def read_text(rel):
    with open(os.path.join(ROOT, rel), encoding='utf-8') as f:
        return f.read()


def exists(rel):
    return os.path.exists(os.path.join(ROOT, rel))


def sha256(text):
    return 'sha256:' + hashlib.sha256(text.replace('\r\n', '\n').encode('utf-8')).hexdigest()


def glob_to_regex(glob):
    """glob → 정규식. 지원: ** · * · ? · {a,b}"""
    out = ''
    i = 0
    while i < len(glob):
        c = glob[i]
        if c == '*':
            if i + 1 < len(glob) and glob[i + 1] == '*':
                i += 1
                if i + 1 < len(glob) and glob[i + 1] == '/':
                    i += 1
                    out += r'(?:.*/)?'
                else:
                    out += '.*'
            else:
                out += '[^/]*'
        elif c == '?':
            out += '[^/]'
        elif c == '{':
            end = glob.find('}', i)
            if end == -1:
                out += r'\{'
            else:
                opts = glob[i + 1:end].split(',')
                out += '(?:' + '|'.join(re.escape(o) for o in opts) + ')'
                i = end
        else:
            out += re.escape(c)
        i += 1
    return re.compile('^' + out + '$')


def make_matcher(globs):
    res = [glob_to_regex(g) for g in (globs or [])]
    return lambda p: any(r.match(p) for r in res)


def walk_files():
    acc = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        rel_dir = os.path.relpath(dirpath, ROOT)
        for fn in filenames:
            rel = fn if rel_dir == '.' else f"{rel_dir}/{fn}"
            acc.append(rel.replace(os.sep, '/'))
    # 정렬은 결정성 때문 — 같은 입력이면 위반 순서가 항상 같아야 CI diff·구현 간 비교가 가능하다.
    return sorted(acc)


# ─────────────────────────────── 정책 ───────────────────────────────

def find_policy():
    """정책 탐색은 **cwd 기준을 먼저, 저장소 루트 기준을 나중에** 본다.

    모노레포에서는 ROOT(git 루트) ≠ spec-kit 루트라, ROOT 기준으로만 찾으면 트랙 안에 있는 정책을
    영영 못 찾아 `--policy`가 사실상 필수가 된다(그리고 `--policy`에 준 상대경로마저 ROOT 기준으로
    해석돼 어긋난다). 자세한 것은 `references/monorepo.md`."""
    candidates = []
    if OPTS['policy']:
        c = OPTS['policy']
        candidates += [c] if os.path.isabs(c) else [os.path.join(os.getcwd(), c), os.path.join(ROOT, c)]
    for n in ('sdd-policy.json', '.specify/sdd-policy.json'):
        candidates += [os.path.join(os.getcwd(), n), os.path.join(ROOT, n)]
    for p in candidates:
        if os.path.exists(p):
            return p
    return None


POLICY_PATH = find_policy()
if not POLICY_PATH:
    fail('sdd-policy.json을 찾지 못했다(--policy로 지정하라).')
try:
    with open(POLICY_PATH, encoding='utf-8') as f:
        POLICY = json.load(f)
except Exception as e:
    fail(f"정책 파싱 실패: {POLICY_PATH} — {e}")

# 템플릿 자리표시자(<…>)가 남아 있으면 검사가 조용히 아무것도 안 보게 된다 → 설정 오류로 막는다.
_unresolved = []


def _scan(v, path):
    if isinstance(v, str):
        if re.search(r'[<>]', v) and not path.startswith('$comment'):
            _unresolved.append(f"{path}: {v}")
    elif isinstance(v, list):
        for i, x in enumerate(v):
            _scan(x, f"{path}[{i}]")
    elif isinstance(v, dict):
        for k, x in v.items():
            if not k.startswith('$comment'):
                _scan(x, f"{path}.{k}" if path else k)


_scan(POLICY, '')
# 핀 위치 표기(specs/<slug>/sources.json)는 자리표시자가 정상이다.
_real = [u for u in _unresolved if not u.startswith('pins.location') and not u.startswith('reviewRecord.path')]
if _real:
    fail('정책에 채우지 않은 자리표시자가 있다 — 검사가 무의미해진다:\n  - ' + '\n  - '.join(_real))


def pget(key, default):
    v = POLICY.get(key)
    return default if v is None else v


P = {
    'specsDir': pget('specsDir', 'specs'),
    'requiredPhaseFiles': pget('requiredPhaseFiles', ['spec.md', 'plan.md', 'tasks.md']),
    'requiredPinFile': pget('requiredPinFile', 'sources.json'),
    'governedGlobs': pget('governedGlobs', []),
    'allowlist': pget('allowlist', []),
    'unmatchedNewFiles': pget('unmatchedNewFiles', 'off'),
    'provenanceTag': pget('provenanceTag', '@sdd'),
    'commentSyntaxes': pget('commentSyntaxes', ['//', '#', '/*']),
    'upstream': pget('upstreamDocs', {'globs': [], 'docsAdapter': 'generic', 'anchorRegistry': {}}),
    'pins': pget('pins', {}),
    'sources': pget('sources', {}),
    'specRefs': pget('specRefs', {}),
    'reviewRecord': pget('reviewRecord', {}),
    'delegated': pget('delegated', {}),
    'mainBranch': pget('mainBranch', 'main'),
    'exempt': pget('exempt', {'fileTag': '@sdd:exempt', 'commitTrailer': 'SDD-Exempt'}),
    'mode': pget('mode', 'block'),
    'severity': pget('severity', {}),
    'hooks': pget('hooks', {}),
}

skipped = []      # 무엇을 안 봤는지 — 리포트 머리말에 반드시 드러낸다
notes = []        # 위반은 아니지만 **알아야 하는 것**(정책이 세트를 못 따라간 흔적 등)
violations = []


def sev(rule):
    # 브라운필드 `mode: "warn"`은 **완료 게이트(verify·CI) 층에만** 적용한다.
    # 훅(--changed)까지 warn으로 덮으면 종료코드가 0이 되어 **에이전트에 아무것도 주입되지 않고**,
    # 정작 안내가 가장 필요한 도입 기간에 ①층이 통째로 죽는다(조용한 실패). 훅은 방금 편집한
    # 파일 하나만 보므로 브라운필드 홍수 논리도 적용되지 않는다.
    if P['mode'] == 'warn' and OPTS['mode'] != 'changed':
        return 'warn'
    s = P['severity'].get(rule, 'block')
    # --changed(훅)에서는 diff 범위 규칙을 경고로 낮춘다(정본 §0).
    if OPTS['mode'] == 'changed' and rule in ('coupling', 'freshness', 'reverseCoupling') and s == 'block':
        return 'warn'
    return s


def violate(rule, target, message, action=None, severity=None, **extra):
    s = severity or sev(rule)
    if s == 'off':
        return
    v = {'rule': rule, 'severity': s, 'target': target, 'message': message}
    if action:
        v['action'] = action
    v.update(extra)
    violations.append(v)


# ─────────────────────────────── 대상 집합 ───────────────────────────────

is_allowlisted = make_matcher(P['allowlist'])
_inc = make_matcher(P['governedGlobs'])


def is_governed(p):
    return _inc(p) and not is_allowlisted(p)


ALL_FILES = walk_files()
GOVERNED = [f for f in ALL_FILES if is_governed(f)]

BASE_REF = None


def compute_changed():
    global BASE_REF
    if OPTS['mode'] == 'changed':
        out = []
        for f in OPTS['files']:
            f = f.replace('\\', '/')
            if f.startswith(ROOT):
                f = f[len(ROOT) + 1:]
            out.append(f)
        return sorted(out)
    mb = git_value(['merge-base', P['mainBranch'], 'HEAD'])
    BASE_REF = mb or git_value(['rev-parse', 'HEAD~1'])
    if not mb:
        skipped.append(f"③⑥의 base: merge-base({P['mainBranch']}) 실패 → "
                       f"{'HEAD~1' if BASE_REF else '워킹트리만'} 기준"
                       ' — CI라면 얕은 클론일 수 있다(GitLab `GIT_DEPTH: 0` / GH Actions `fetch-depth: 0` 확인)')
    items = set()
    if BASE_REF:
        for f in (git(['diff', '--name-only', f'{BASE_REF}..HEAD'], True) or '').split('\n'):
            if f.strip():
                items.add(f.strip())
    for p in status_paths():
        items.add(p)
    return sorted(items)


CHANGED = compute_changed()
CHANGED_SET = set(CHANGED)


def compute_exempt_only():
    """면제 커밋(트레일러)이 '단독으로' 건드린 파일 집합."""
    if OPTS['mode'] != 'full' or not BASE_REF:
        return set()
    raw = git(['log', f'{BASE_REF}..HEAD', '--pretty=format:%H%x1f%B%x1e'], True) or ''
    exempt, normal = set(), set()
    trailer_re = re.compile(r'^\s*' + re.escape(P['exempt'].get('commitTrailer', 'SDD-Exempt')) + r'\s*:',
                            re.M | re.I)
    for entry in raw.split('\x1e'):
        if not entry.strip():
            continue
        parts = entry.split('\x1f')
        h = parts[0].strip()
        body = parts[1] if len(parts) > 1 else ''
        is_exempt = bool(trailer_re.search(body))
        files = [s.strip() for s in (git(['show', '--name-only', '--format=', h], True) or '').split('\n') if s.strip()]
        for f in files:
            (exempt if is_exempt else normal).add(f)
    for p in status_paths():        # 미커밋 변경은 면제로 치지 않는다
        normal.add(p)
    return {f for f in exempt if f not in normal}


EXEMPT_ONLY = compute_exempt_only()


# ─────────────────────────────── ① 출처 ───────────────────────────────

TAG_RE = re.compile(re.escape(P['provenanceTag']) + r'\s+([A-Za-z0-9._\-/]+)')
EXEMPT_RE = re.compile(re.escape(P['exempt'].get('fileTag', '@sdd:exempt')) + r'\s+(\S.*)')


def in_comment(line, idx):
    for c in P['commentSyntaxes']:
        i = line.find(c)
        if i != -1 and i < idx:
            return True
    return False


def read_tag(rel):
    try:
        head = '\n'.join(read_text(rel).split('\n')[:HEAD_LINES])
    except Exception:
        return {'kind': 'unreadable'}
    for line in head.split('\n'):
        em = EXEMPT_RE.search(line)
        if em and in_comment(line, em.start()):
            return {'kind': 'exempt', 'reason': em.group(1).strip()}
        m = TAG_RE.search(line)
        if m and in_comment(line, m.start()):
            return {'kind': 'tag', 'slug': m.group(1)}
    return {'kind': 'none'}


used_slugs = []          # 순서 보존(결정적 출력)


def add_slug(s):
    if s not in used_slugs:
        used_slugs.append(s)


provenance_targets = [f for f in CHANGED if is_governed(f)] if OPTS['mode'] == 'changed' else GOVERNED
for f in provenance_targets:
    t = read_tag(f)
    if t['kind'] == 'exempt':
        continue
    if t['kind'] == 'tag':
        add_slug(t['slug'])
    elif t['kind'] == 'none':
        violate('provenance', f, '출처 태그 없음',
                f"이 파일이 파생된 슬라이스를 `{P['provenanceTag']} <slug>`로 선언하거나, "
                f"사유와 함께 `{P['exempt'].get('fileTag', '@sdd:exempt')}`")

# --changed에서도 ②④의 대상 집합은 전체 태그에서 모은다(훅이 일부 파일만 받기 때문).
if OPTS['mode'] == 'changed':
    for f in GOVERNED:
        t = read_tag(f)
        if t['kind'] == 'tag':
            add_slug(t['slug'])

# ②④⑤⑦의 대상 slug 범위.
# 태그만으로 범위를 잡으면 **태그가 하나도 없는 브라운필드에서 ②④⑤⑦가 통째로 침묵**한다
# (①만 걸리고 나머지는 "위반 0"으로 보여 검증됐다는 착각을 준다). 그래서 --full 기본은
# specsDir 에 실재하는 슬라이스 전부를 대상으로 삼는다(`sliceScope: "tagged"`로 좁힐 수 있다).
declared_slugs = sorted(
    d for d in (os.listdir(os.path.join(ROOT, P['specsDir'])) if exists(P['specsDir']) else [])
    if os.path.isdir(os.path.join(ROOT, P['specsDir'], d))
)
slice_scope = POLICY.get('sliceScope', 'all')
if OPTS['mode'] == 'full' and slice_scope == 'all':
    scoped_slugs = sorted(set(declared_slugs) | set(used_slugs))
    if len(declared_slugs) > len(used_slugs):
        skipped.append(f"slug 범위: specsDir의 선언 슬라이스 {len(declared_slugs)}개 전부"
                       f"(태그된 slug {len(used_slugs)}개) — sliceScope: \"tagged\"로 좁힐 수 있다")
else:
    scoped_slugs = sorted(used_slugs)

# 관장 사각 — 어느 glob에도 안 걸리는 신규 소스
if P['unmatchedNewFiles'] != 'off' and OPTS['mode'] == 'full' and BASE_REF:
    added = [s.strip() for s in (git(['diff', '--name-only', '--diff-filter=A', f'{BASE_REF}..HEAD'], True) or '').split('\n') if s.strip()]
    untracked = [s.strip() for s in (git(['ls-files', '--others', '--exclude-standard'], True) or '').split('\n') if s.strip()]
    code_ext = re.compile(r'\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|swift)$')
    for f in added + untracked:
        if not code_ext.search(f) or is_governed(f) or is_allowlisted(f):
            continue
        violate('unmatchedNewFile', f, '관장 범위 밖 신규 소스 파일',
                'governedGlobs를 넓히거나, 사유와 함께 allowlist에 등록하라',
                severity=P['unmatchedNewFiles'])


# ─────────────────────────────── ② 완결 ───────────────────────────────

if P['delegated'].get('ciGuard'):
    skipped.append('② 완결(산출물 존재·완결성) → CI Guard 위임 · 핀 파일 검사만 유지')

for slug in scoped_slugs:
    d = f"{P['specsDir']}/{slug}"
    if not exists(d):
        violate('completeness', slug, f'슬라이스 폴더 없음: {d}',
                '태그의 slug가 실제 spec-kit 슬라이스를 가리키게 하라')
        continue
    if not P['delegated'].get('ciGuard') and sev('completeness') != 'off':
        for pf in P['requiredPhaseFiles']:
            p = f"{d}/{pf}"
            if not exists(p):
                violate('completeness', slug, f'단계 산출물 없음: {pf}', 'spec→plan→tasks 순서로 채워라')
            elif read_text(p).strip() == '':
                violate('completeness', slug, f'단계 산출물이 비어 있음: {pf}',
                        '내용을 채워라(빈 파일은 통과시키지 않는다)')
    # 핀 파일은 위임 여부와 무관하게 항상 본다 — ④의 전제이기 때문
    if not exists(f"{d}/{P['requiredPinFile']}"):
        violate('completeness', slug, f"핀 파일 없음: {P['requiredPinFile']}",
                '이 슬라이스가 근거로 삼은 상위 문서를 version+contentHash로 핀하라(없으면 ④가 침묵한다)')


# ─────────────────────────────── ③ 결합 ───────────────────────────────

slice_changed_dirs = set()
for f in CHANGED:
    if f.startswith(P['specsDir'] + '/'):
        parts = f.split('/')
        if len(parts) > 1 and parts[1]:
            slice_changed_dirs.add(parts[1])

for f in CHANGED:
    if not is_governed(f) or f in EXEMPT_ONLY:
        continue
    t = read_tag(f) if exists(f) else {'kind': 'none'}
    if t['kind'] == 'exempt' or t['kind'] != 'tag':   # 태그 없음은 ①이 이미 잡았다
        continue
    if t['slug'] not in slice_changed_dirs:
        violate('coupling', f, f"코드가 바뀌었는데 슬라이스({P['specsDir']}/{t['slug']})에 변경이 없음",
                f"spec/plan/tasks를 먼저 갱신하거나, 사유와 함께 커밋 트레일러 "
                f"`{P['exempt'].get('commitTrailer', 'SDD-Exempt')}: …`", slug=t['slug'])


# ─────────────────────────────── ⑥ 역결합 ───────────────────────────────

upstream_matcher = make_matcher(P['upstream'].get('globs', []))


# easyproduct 세트의 **색인 매니페스트**와 `upstreamDocs.globs`를 대조한다.
# 정책은 사람이 읽을 수 있어야 하므로 런타임에 매니페스트로 **대체하지 않는다** — 대신 **어긋남을 보고**한다.
# 실제 사고: 세트가 새 채널(`interface-requests/`)을 얻었는데 글롭에 없어, 그 채널 전체가 ④⑥ 밖이었다.
MANIFEST_RE = re.compile(r'```json\s+docbundle\.docs\n(.*?)```', re.S)


def manifest_gaps():
    if (P['upstream'].get('docsAdapter') or 'generic') != 'easyproduct':
        return None
    out = {}
    seen_manifest = False
    for f in [x for x in ALL_FILES if x.endswith('00-index.md')]:
        m = MANIFEST_RE.search(read_text(f))
        if not m:
            continue
        try:
            man = json.loads(m.group(1))
        except Exception:
            continue
        if not isinstance(man.get('docs'), list):
            continue
        seen_manifest = True
        base = f[:-len('00-index.md')]
        for d in man['docs']:
            if not isinstance(d, dict) or not d.get('path'):
                continue
            if d.get('role') not in ('ssot', 'handoff'):
                continue
            full = (base + d['path']).replace('\\', '/')
            if upstream_matcher(full):
                continue
            k = d.get('docType') or '(unknown)'
            out[k] = out.get(k, 0) + 1
    return out if seen_manifest else None


# **등기부에 없는 접두사** 감지. 이 하네스의 가장 조용한 사각이다 — `idPrefixes`에 없는 접두사는
# ref_pattern이 아예 안 만들어서, 그런 참조는 **죽은 링크로도 안 잡히고 근거로도 안 세어진다.**
# 상위 문서 세트가 새 네임스페이스를 얻으면(예: easyproduct 0.8.0의 `IO`) 프로젝트가 정책을 고칠 때까지
# **검사받던 참조가 검사 안 받는 참조로 조용히 바뀐다**(실제 사고). 오탐 여지가 있어 위반이 아니라 보고다.
ANCHORISH = re.compile(r'\b([A-Z][A-Z0-9]{1,15})\.[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*(?![A-Za-z0-9_-])')


def unregistered_prefixes(texts, known):
    seen = {}
    known_set = set(known)
    for t in texts:
        for m in ANCHORISH.finditer(t):
            pfx = m.group(1)
            if pfx in known_set:
                continue
            seen[pfx] = seen.get(pfx, 0) + 1
    return sorted(seen.items(), key=lambda kv: -kv[1])
upstream_changed = [f for f in CHANGED if upstream_matcher(f) and f not in EXEMPT_ONLY]

# 훅(--changed)에서도 경고로는 본다 — severity는 sev()가 낮춘다.
if upstream_changed and not slice_changed_dirs:
    violate('reverseCoupling', ', '.join(upstream_changed), '상위 문서만 바뀌고 슬라이스가 하나도 안 바뀜',
            '이 변경을 어느 슬라이스가 흡수하는지 SDD로 재검토하고 그 슬라이스에 흔적을 남겨라'
            f"(무해한 오탈자·포맷이면 `{P['exempt'].get('commitTrailer', 'SDD-Exempt')}` 트레일러로 면제)")


# ─────────────────────────────── ④ 신선도 ───────────────────────────────

def parse_frontmatter(text):
    if not text.startswith('---'):
        return {}
    end = text.find('\n---', 3)
    if end == -1:
        return {}
    fm = {}
    parent = None
    for raw in text[3:end].split('\n'):
        if not raw.strip() or raw.strip().startswith('#'):
            continue
        indented = bool(re.match(r'^\s{2,}\S', raw))
        m = re.match(r'^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$', raw)
        if not m:
            continue
        k, v_raw = m.group(1), m.group(2)
        v = v_raw.strip().strip('"\'')
        if indented and parent:
            fm[parent][k] = v
        elif v == '':
            parent = k
            fm[k] = {}
        else:
            fm[k] = v
            parent = None
    return fm


def read_version(rel):
    if not exists(rel):
        return None
    text = read_text(rel)
    fm = parse_frontmatter(text)
    version = fm.get('version') if isinstance(fm.get('version'), str) else None
    if not version and P['sources'].get('semverLine'):
        m = re.search(re.escape(P['sources']['semverLine']) + r'\s*`?([0-9]+\.[0-9]+\.[0-9]+[^\s`]*)', text)
        if m:
            version = m.group(1)
    return {'version': version, 'hash': sha256(text)}


def read_pins(rel):
    if not exists(rel):
        return []
    try:
        data = json.loads(read_text(rel))
    except Exception as e:
        violate('freshness', rel, f'핀 파일 파싱 실패 — {e}', 'JSON 형식을 고쳐라')
        return []
    items = data if isinstance(data, list) else data.get('sources', [])
    return [p for p in items if isinstance(p, dict) and isinstance(p.get('path'), str)]


def check_pins(pins, label):
    for pin in pins:
        cur = read_version(pin['path'])
        if not cur:
            violate('freshness', label, f"핀 대상 파일이 없음: {pin['path']}",
                    '경로를 고치거나 핀에서 빼라', path=pin['path'])
            continue
        if pin.get('version') and cur['version'] and pin['version'] != cur['version']:
            violate('freshness', label, f"{pin['path']} 핀({pin['version']}) != 현재({cur['version']})",
                    'SDD로 재검토하고 그 결과를 기록한 뒤 핀을 갱신하라', path=pin['path'])
        elif pin.get('contentHash') and not re.search(r'[<>]', pin['contentHash']) \
                and pin['contentHash'] != cur['hash']:
            violate('freshness', label, f"{pin['path']}가 버전업 없이 수정됨(핀 hash 불일치)",
                    '상위 문서의 version을 먼저 올리고, 재검토 후 슬라이스 핀을 갱신하라', path=pin['path'])


if P['pins'].get('impactUnit', 'file') == 'anchor':
    skipped.append('④의 앵커 단위 영향 분석 미구현 → 파일 단위로 판정(과탐 가능)')
for slug in scoped_slugs:
    check_pins(read_pins(f"{P['specsDir']}/{slug}/{P['requiredPinFile']}"), slug)
if P['pins'].get('globalPinFile'):
    check_pins(read_pins(P['pins']['globalPinFile']), '<project>')   # 전역 원칙은 한 번만 본다


# ─────────────────────────────── 등기부(어댑터) ───────────────────────────────

FENCE_RE = re.compile(r'```json\s+([^\n`]+)\n(.*?)```', re.S)
DOTTED = re.compile(r'^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)+$')


def fenced_blocks(md, tag):
    out = []
    for m in FENCE_RE.finditer(md):
        if not tag or m.group(1).strip() == tag:
            try:
                out.append(json.loads(m.group(2)))
            except Exception:
                pass          # 블록 파싱 실패는 등기부 축소로만 취급
    return out


def collect_ids(node, prefixes, acc):
    if isinstance(node, str):
        if DOTTED.match(node) and (not prefixes or node.split('.')[0] in prefixes):
            acc.add(node)
        return acc
    if isinstance(node, list):
        for v in node:
            collect_ids(v, prefixes, acc)
        return acc
    if isinstance(node, dict):
        for k, v in node.items():
            if k == 'id' and isinstance(v, str):
                acc.add(v)
            collect_ids(v, prefixes, acc)
    return acc


def build_registry():
    reg = set()
    adapter = P['upstream'].get('docsAdapter', 'generic')
    ar = P['upstream'].get('anchorRegistry', {})
    prefixes = ar.get('idPrefixes') if isinstance(ar.get('idPrefixes'), list) else []
    docs = [f for f in ALL_FILES if upstream_matcher(f) and f.endswith('.md')]
    for doc in docs:
        text = read_text(doc)
        if adapter == 'easyproduct':
            fm = parse_frontmatter(text)
            tag_field = ar.get('blockTagField', 'machine.tag')
            tag = fm
            for k in tag_field.split('.'):
                tag = tag.get(k) if isinstance(tag, dict) else None
            for block in fenced_blocks(text, tag if isinstance(tag, str) else None):
                collect_ids(block, prefixes, reg)
        else:
            if ar.get('genericIdPattern'):
                for m in re.finditer(ar['genericIdPattern'], text):
                    reg.add(m.group(0))
            for m in re.finditer(r'^#{2,6}\s+(.+)$', text, re.M):
                reg.add(m.group(1).strip())
    return reg


# ─────────────────────────────── ⑤ 근거 ───────────────────────────────

def ref_pattern():
    """참조 패턴. 두 개의 가드가 **필수**다(둘 다 실전 오탐에서 나왔다):
      (?![A-Za-z0-9_-])  토큰 경계 — 없으면 `FEAT.billing.*`에서 백트래킹으로 `FEAT.billin`이 매칭된다.
      (?!\\.\\*)           와일드카드 — `FEAT.billing.*` 같은 계열 표기를 **참조로 치지 않는다**.
    세그먼트 문자 클래스에 `.`을 넣지 않는 것도 같은 이유다(넣으면 `FEAT.billing.`을 삼키고,
    후행점을 잘라 **존재하지 않는 `FEAT.billing`**을 만들어낸다 — 옛 구현의 실제 결함)."""
    if P['specRefs'].get('refPattern'):
        return re.compile(P['specRefs']['refPattern'])
    ar = P['upstream'].get('anchorRegistry', {})
    prefixes = ar.get('idPrefixes') or []
    if prefixes:
        return re.compile(r'\b(?:' + '|'.join(re.escape(p) for p in prefixes)
                          + r')(?:\.[A-Za-z0-9_-]+)+(?![A-Za-z0-9_-])(?!\.\*)')
    if ar.get('genericIdPattern'):
        return re.compile(ar['genericIdPattern'])
    return None


def wildcard_pattern():
    """건너뛴 와일드카드 참조를 **세어서 리포트에 드러낸다**(무엇을 안 봤는지 숨기지 않는다)."""
    prefixes = P['upstream'].get('anchorRegistry', {}).get('idPrefixes') or []
    if not prefixes:
        return None
    return re.compile(r'\b(?:' + '|'.join(re.escape(p) for p in prefixes) + r')(?:\.[A-Za-z0-9_-]+)*\.\*')


def requirement_units(text, unit):
    """"요구 1건"의 단위. **spec-kit 기본은 `frId`**다 — spec-template.md가 찍는 헤딩
    (`### User Story N` · `### Edge Cases` · `### Key Entities`)은 요구가 아니라 **골격**이라,
    헤딩을 요구로 보면 spec-kit 전용 스킬이 spec-kit 자기 템플릿에 걸려 운다(실전 오탐 52건).
    실제 요구 단위는 `**FR-001**`·`**SC-001**`이다."""
    if unit == 'frId':
        id_re = re.compile(P['specRefs'].get('frIdPattern', r'(?:FR|SC)-[0-9]+'))
        units = []
        cur = None
        for line in text.split('\n'):
            m = id_re.search(line)
            if m:
                if cur:
                    units.append(cur)
                cur = {'title': m.group(0), 'body': line + '\n'}
            elif cur is not None:
                if line.strip() == '' or re.match(r'^#{1,6}\s', line):
                    units.append(cur)
                    cur = None
                else:
                    cur['body'] += line + '\n'      # 이어지는 줄(들여쓴 설명)까지 한 요구로
        if cur:
            units.append(cur)
        return units
    if unit == 'listItem':
        return [{'title': l.strip()[:80], 'body': l}
                for l in text.split('\n') if re.match(r'^\s{0,3}[-*]\s+\S', l)]
    units = []
    cur = None
    for line in text.split('\n'):
        h = re.match(r'^(#{3,6})\s+(.+)$', line)
        if h:
            if cur:
                units.append(cur)
            cur = {'title': h.group(2).strip(), 'body': ''}
        elif cur is not None:
            cur['body'] += line + '\n'
    if cur:
        units.append(cur)
    return [u for u in units if u['body'].strip() != '']


if OPTS['mode'] == 'changed':
    skipped.append('⑤⑦ → --changed(훅)에서는 스킵(diff 단위 규칙)')
elif sev('specRefs') == 'off':
    skipped.append('⑤ 근거 → severity off')
else:
    registry = build_registry()
    rp = ref_pattern()
    wp = wildcard_pattern()
    wildcard_skipped = 0
    if not registry or not rp:
        skipped.append(f"⑤ 근거 → 상위 등기부를 만들 수 없음"
                       f"(adapter={P['upstream'].get('docsAdapter', 'generic')}, 앵커 {len(registry)}개)")
    else:
        for slug in scoped_slugs:
            for fname in P['specRefs'].get('scanFiles', ['spec.md', 'plan.md']):
                path = f"{P['specsDir']}/{slug}/{fname}"
                if not exists(path):
                    continue
                text = read_text(path)
                if wp:
                    wildcard_skipped += len(wp.findall(text))
                for m in rp.finditer(text):
                    ref = m.group(0)
                    if ref not in registry:
                        violate('specRefs', slug, f'죽은 링크: {ref} (상위 문서 등기부에 없음) — {fname}',
                                '상위 문서에서 실제 ID를 확인하거나, 그 결정을 상위 문서에 먼저 추가하라')
                orphan = P['specRefs'].get('orphanRequirement', 'off')
                if orphan != 'off':
                    for u in requirement_units(text, P['specRefs'].get('requirementUnit', 'frId')):
                        if not rp.search(f"{u['title']}\n{u['body']}"):
                            violate('specRefs', slug, f"근거 없는 요구: \"{u['title']}\" — {fname}",
                                    '이 결정을 상위 문서로 이관하고 그 앵커를 참조하라(spec이 결정을 발명하지 않는다)',
                                    severity='warn' if P['mode'] == 'warn' else orphan)
    if wildcard_skipped > 0:
        skipped.append(f"⑤ 와일드카드 참조 {wildcard_skipped}건 건너뜀"
                       "(`FEAT.x.*` 같은 계열 표기 — 특정 ID가 아니라 대조 대상 아님)")
    # 등기부에 없는 접두사 — 위반이 아니라 **보고**다(오탐 여지가 있고, 판단은 사람 몫).
    _prefixes = P['upstream'].get('anchorRegistry', {}).get('idPrefixes') or []
    if _prefixes:
        _texts = []
        for slug in scoped_slugs:
            for fname in P['specRefs'].get('scanFiles', ['spec.md', 'plan.md']):
                path = f"{P['specsDir']}/{slug}/{fname}"
                if exists(path):
                    _texts.append(read_text(path))
        _unreg = unregistered_prefixes(_texts, _prefixes)
        if _unreg:
            _head = ' · '.join(f'{p2}({n}건)' for p2, n in _unreg[:6])
            notes.append(f"⑤ 등기부에 없는 접두사 참조: {_head}"
                         + (f" 외 {len(_unreg) - 6}종" if len(_unreg) > 6 else ''))
            notes.append('     → 상위 문서 세트가 새 네임스페이스를 얻었을 수 있다. '
                         '`upstreamDocs.anchorRegistry.idPrefixes`에 넣으면 검사받는다.')
            notes.append('     → 지금은 이 참조들이 **죽은 링크로도 안 잡히고 근거로도 안 세어진다**(검사 밖).')

# 매니페스트 대조(easyproduct 어댑터일 때만). 위반이 아니라 **보고** — 정책을 사람이 고치게 한다.
_gaps = manifest_gaps()
if _gaps:
    _total = sum(_gaps.values())
    _detail = ' · '.join(f'{k} {v}' for k, v in _gaps.items())
    notes.append(f"④⑥ 매니페스트에 있는데 upstreamDocs.globs가 안 덮는 상위 문서 {_total}건 ({_detail})")
    notes.append('     → 그 문서들은 상위 변경 감지(⑥)·신선도(④) 밖이다. globs에 그 폴더를 더하세요.')


# ─────────────────────────────── ⑦ 리뷰 기록 ───────────────────────────────

if OPTS['mode'] != 'changed' and sev('reviewRecord') != 'off':
    watch = P['reviewRecord'].get('requireOnChangeOf', ['spec.md', 'plan.md'])
    touched = {}
    for f in CHANGED:
        if not f.startswith(P['specsDir'] + '/'):
            continue
        parts = f.split('/')
        if len(parts) < 3:
            continue
        slug, rel = parts[1], '/'.join(parts[2:])
        if rel not in watch:
            continue
        touched.setdefault(slug, []).append(rel)
    for slug, files in touched.items():
        rec_path = P['reviewRecord'].get('path', f"{P['specsDir']}/<slug>/upstream-check.md").replace('<slug>', slug)
        pin_path = f"{P['specsDir']}/{slug}/{P['requiredPinFile']}"
        rec_changed = rec_path in CHANGED_SET
        pin_has_review = exists(pin_path) and '"reviewedAt"' in read_text(pin_path) and pin_path in CHANGED_SET
        if not rec_changed and not pin_has_review:
            violate('reviewRecord', slug, f"{'·'.join(files)}를 고쳤는데 상위 대조 기록이 갱신되지 않음",
                    f"`{P['reviewRecord'].get('suggestedCommand', '/speckit.analyze')}`를 돌리고 "
                    f"근거 앵커·확인 내용·checkedAt을 {rec_path}에 기록하라")
            continue
        if rec_changed:
            text = read_text(rec_path)
            for field in P['reviewRecord'].get('fields', []):
                if field not in text:
                    violate('reviewRecord', slug, f'기록에 {field} 없음 — {rec_path}', '템플릿의 필드를 채워라')


# ─────────────────────────────── 보고 ───────────────────────────────

counts = {'block': 0, 'warn': 0}
for v in violations:
    counts[v['severity']] = counts.get(v['severity'], 0) + 1
ok = counts['block'] == 0

if OPTS['json']:
    print(json.dumps({
        'ok': ok, 'mode': OPTS['mode'], 'adapter': P['upstream'].get('docsAdapter', 'generic'),
        'policyMode': P['mode'], 'skipped': skipped, 'notes': notes, 'violations': violations, 'counts': counts,
    }, ensure_ascii=False, indent=2))
else:
    RULE_LABEL = {
        'provenance': '① 출처', 'completeness': '② 완결', 'coupling': '③ 결합',
        'freshness': '④ 신선도', 'reverseCoupling': '⑥ 역결합', 'specRefs': '⑤ 근거',
        'reviewRecord': '⑦ 리뷰 기록', 'unmatchedNewFile': '관장 사각',
    }
    print(f"SDD 하네스 검사 ({'--full' if OPTS['mode'] == 'full' else '--changed'})")
    print(f"  adapter: {P['upstream'].get('docsAdapter', 'generic')} · "
          f"impactUnit: {P['pins'].get('impactUnit', 'file')} · "
          f"관장 {len(GOVERNED)}개 · slug {len(scoped_slugs)}개(태그 {len(used_slugs)}개)")
    if P['mode'] == 'warn':
        print('  mode: warn (브라운필드) — 모든 위반을 경고로 보고하고 종료코드 0')
    for s in skipped:
        print(f"  skipped: {s}")
    for n in notes:
        print(f"  {n if n.startswith(' ') else 'note: ' + n}")
    print('')
    for v in violations:
        print(f"{'✗' if v['severity'] == 'block' else '⚠'} [{RULE_LABEL.get(v['rule'], v['rule'])}] {v['target']}")
        print(f"    {v['message']}")
        if v.get('action'):
            print(f"    → {v['action']}")
    if not violations:
        print('위반 없음.')
    print(f"\n요약: block {counts['block']} · warn {counts['warn']} → {'통과' if ok else '실패'}")
    if not ok:
        print('기계 통과 ≠ 검증 완료 — 이 검사는 의례·공존만 본다(의미 정합은 리뷰 몫).')

# 종료코드.
#  --full   : 0 통과(경고 있어도) · 1 block 위반          — 완료 게이트/CI가 읽는 값
#  --changed: 0 통과 · **2 위반**                          — 훅이 에이전트에 주입하려면 2여야 한다
#             (호스트 규약: PostToolUse는 exit 2일 때만 stderr를 에이전트 컨텍스트에 넣는다)
#             warn만 있을 때 주입할지는 `hooks.injectOnWarn`(기본 true)이 정한다.
if OPTS['mode'] == 'changed':
    inject_on_warn = P['hooks'].get('injectOnWarn') is not False
    should_inject = counts['block'] > 0 or (inject_on_warn and counts['warn'] > 0)
    if should_inject and not OPTS['json']:
        print('\n위 위반을 먼저 정리하라 — SDD 게이트(훅 층). 계속 진행하면 verify·CI에서 다시 막힌다.',
              file=sys.stderr)
    sys.exit(2 if should_inject else 0)
sys.exit(0 if ok else 1)
