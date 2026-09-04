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
bare_exempt = []       # 사유 없이 적힌 면제 트레일러의 커밋(면제로 **안** 쳤다 — 원인을 알려 준다)
bare_file_exempt = []  # 사유 없는 파일 태그(면제는 **인정**하되 알린다 — 상태 선언이라 막지 않는다)
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
    # **사유 없는 면제는 면제가 아니다.** 콜론까지만 보면 `SDD-Exempt:` 한 줄로 ③⑥을 끌 수 있고,
    # 그러면 **나중에 "왜 못 막았는지"를 확인할 근거가 없다** — 면제의 존재 이유가 그 기록이다.
    # 파일 태그(`@sdd:exempt <사유>`)는 처음부터 사유를 요구했는데 여기만 새고 있었다(비대칭 회복).
    # 실측: 실사용 저장소 세 곳의 트레일러 55건 전부 사유가 있어 **깨지는 것이 없다.**
    trailer_re = re.compile(r'^\s*' + re.escape(P['exempt'].get('commitTrailer', 'SDD-Exempt')) + r'\s*:\s*(\S.*)',
                            re.M | re.I)
    bare_re = re.compile(r'^\s*' + re.escape(P['exempt'].get('commitTrailer', 'SDD-Exempt')) + r'\s*:\s*$',
                         re.M | re.I)
    for entry in raw.split('\x1e'):
        if not entry.strip():
            continue
        parts = entry.split('\x1f')
        h = parts[0].strip()
        body = parts[1] if len(parts) > 1 else ''
        is_exempt = bool(trailer_re.search(body))
        if not is_exempt and bare_re.search(body):
            bare_exempt.append(h[:7])       # 왜 안 먹었는지 알려 준다(아래 note)
        files = [s.strip() for s in (git(['show', '--name-only', '--format=', h], True) or '').split('\n') if s.strip()]
        for f in files:
            (exempt if is_exempt else normal).add(f)
    for p in status_paths():        # 미커밋 변경은 면제로 치지 않는다
        normal.add(p)
    return {f for f in exempt if f not in normal}


EXEMPT_ONLY = compute_exempt_only()


# ─────────────────────────────── ① 출처 ───────────────────────────────

TAG_RE = re.compile(re.escape(P['provenanceTag']) + r'\s+([A-Za-z0-9._\-/]+)')
# **파일 태그는 사유가 없어도 면제로 인정한다(경고만).** 예전엔 사유가 없으면 정규식이 안 맞아
# `출처 태그 없음`(block)으로 떨어졌는데, **면제하려던 의도가 분명한데 막는 것은 과하다.**
# 커밋 트레일러와 다르게 가는 이유: 파일 태그는 "이 파일은 SDD 대상이 아니다"라는 **상태 선언**이라
# 한 번 쓰면 계속 있고, 트레일러는 "이번엔 넘어간다"는 **일회성 예외**라 그때그때 근거가 남아야 한다.
EXEMPT_RE = re.compile(re.escape(P['exempt'].get('fileTag', '@sdd:exempt')) + r'(?:\s+(\S.*))?\s*$')


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
            return {'kind': 'exempt', 'reason': (em.group(1) or '').strip()}
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
        if not t['reason']:
            bare_file_exempt.append(f)      # 면제는 인정하되 사유가 비었음을 알린다
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


if bare_exempt:
    notes.append(f"사유 없는 {P['exempt'].get('commitTrailer', 'SDD-Exempt')} {len(bare_exempt)}건 — "
                 f"**면제로 치지 않았습니다**: {' · '.join(bare_exempt[:5])}"
                 + (f" 외 {len(bare_exempt) - 5}건" if len(bare_exempt) > 5 else ''))
    notes.append('     → 트레일러 뒤에 **왜 괜찮은지** 적으세요. 나중에 "왜 못 막았는지" 확인할 근거가 그것뿐입니다.')
if bare_file_exempt:
    notes.append(f"사유 없는 {P['exempt'].get('fileTag', '@sdd:exempt')} {len(bare_file_exempt)}건 — "
                 f"면제는 인정했습니다: {' · '.join(bare_file_exempt[:5])}"
                 + (f" 외 {len(bare_file_exempt) - 5}건" if len(bare_file_exempt) > 5 else ''))
    notes.append('     → 왜 SDD 대상이 아닌지 한 줄 적어 두면 다음 사람이 안 헤맵니다(막지는 않습니다).')

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

# 슬러그는 **specsDir 바로 다음 마디**다. split('/')[1]로 뽑으면 specsDir가 한 마디일 때만 맞는데,
# 모노레포는 'frontend-user/specs'처럼 두 마디 이상이 정상이다(references/monorepo.md가 그렇게 권한다).
# 그때 [1]은 'specs'가 되어 어떤 슬러그와도 안 맞고, ③ 결합이 항상 발화한다 —
# warn에서는 소음이지만 block으로 졸업하는 순간 관장 파일을 건드리는 모든 커밋이 막힌다(실측).
# **「슬라이스가 바뀌었다」는 폴더 안 아무 파일이다 — 좁히지 않는다.**
# `spec`·`plan`·`tasks` 로 좁히자는 제안이 실사용에서 왔는데, 재 보니 **정상 작업을 새로 막았다**
# (구현 중 `handoff.md` 만 고친 커밋 2건). 그리고 좁힘의 최종형인 "내용이 실제로 바뀐 파일만 센다"는
# **이미 지금 동작이다** — `git diff` 가 내용이 바뀐 것만 낸다.
#
# ⚠ **그래서 「무엇이 바뀌었나」로는 이 구멍을 못 닫는다.** 주석 한 줄과 정당한 작업을 내용만 보고
# 가를 방법이 없다. 닫으려면 **순서**(spec 이 먼저였나)를 봐야 하는데 이 검사는 범위의 **동시성**만 본다.
# 한계로 적어 두고, 대신 **문구가 ⓑ「spec 을 먼저 고쳐라」를 말하게** 한다(그게 실제로 듣는 사람에게 닿는다).
slice_changed_dirs = set()
for f in CHANGED:
    if f.startswith(P['specsDir'] + '/'):
        rest = f[len(P['specsDir']) + 1:].split('/')[0]
        if rest:
            slice_changed_dirs.add(rest)

for f in CHANGED:
    if not is_governed(f) or f in EXEMPT_ONLY:
        continue
    t = read_tag(f) if exists(f) else {'kind': 'none'}
    if t['kind'] == 'exempt' or t['kind'] != 'tag':   # 태그 없음은 ①이 이미 잡았다
        continue
    if t['slug'] not in slice_changed_dirs:
        violate('coupling', f, f"코드가 바뀌었는데 슬라이스({P['specsDir']}/{t['slug']})에 변경이 없음",
                # **「흡수」를 말한다(⑥과 같은 어휘).** 예전엔 "먼저 갱신하거나 … 면제"였는데,
                # 읽는 쪽에서 「갱신」은 *닫힌 슬라이스를 다시 여는 것*으로, 「면제」는 *규칙을 피하는 것*으로
                # 보였다. 그래서 **문구에 없는 셋째 길(새 슬라이스를 만들고 태그를 옮긴다)이 제일 떳떳해
                # 보였고**, 실사용에서 슬라이스가 78개까지 늘었다(절반 이상이 제품 기능이 아니었다).
                # **선택지만 나열하면 「가장 싸게 조용히 시키는 법」만 배운다.** 예전 두 갈래는
                # 「갱신」·「면제」 둘 다 *코드는 그대로 두는* 길이라, SDD 가 정작 말하려는 갈래 —
                # *"spec 에 없는 것을 코드로 정했으면 코드가 아니라 spec 을 먼저 고쳐라"* — 가
                # 화면에 없었다. 그게 막으려는 C1 그 자체인데도. 그래서 **물음을 먼저** 세운다.
                "이 변경은 **어디서 나왔나?**\n"
                "      ⓐ 승인된 spec 에서 나왔다\n"
                "         → 그 슬라이스의 spec/plan/tasks 에 흔적을 남겨라. "
                "**기존 슬라이스여도 된다**(새로 만들지 않는다)\n"
                "      ⓑ spec 에 없는 것을 **코드로 새로 정했다**\n"
                "         → **코드가 아니라 spec 을 먼저 고쳐라.** 그것이 SDD 이고, 이 검사가 보는 것이 그 순서다\n"
                "      ⓒ spec 과 무관하다(오탈자·포맷·기계적 수정)\n"
                f"         → 커밋 트레일러 `{P['exempt'].get('commitTrailer', 'SDD-Exempt')}: <사유>` "
                "(**사유가 없으면 면제로 안 친다**)\n"
                "      ⚠ 셋 중 무엇인지는 **사람만 안다.** 이 검사는 흔적이 있나만 본다.", slug=t['slug'])


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

# **문서 파일 이름은 앵커가 아니다.** `ROADMAP.md`·`CLAUDE.md`가 `접두사 ROADMAP + 마디 md`로 읽혀
# "등기부에 없는 접두사"로 보고됐다(실사용: 한 트리에서 `ROADMAP.md` 28곳·`CLAUDE.md` 14곳 —
# 문서가 다른 문서를 이름으로 가리킬 때마다 걸린다).
#
# **등기부에 넣는 것으로는 안 풀린다** — `ROADMAP`은 네임스페이스가 아니라 파일 이름이라, 넣으면
# 이번엔 **죽은 링크로 잡힌다**(`ROADMAP.md`라는 앵커는 어디에도 없다). 그래서 안내가 오히려
# **틀린 길로 이끈다.** 마지막 마디가 문서·설정 확장자면 앵커로 보지 않는다.
DOC_EXTS = {'md', 'markdown', 'txt', 'json', 'jsonc', 'yml', 'yaml', 'toml', 'ini', 'cfg',
            'html', 'htm', 'csv', 'tsv', 'xml', 'pdf', 'png', 'jpg', 'jpeg', 'svg', 'webp',
            'lock', 'sh', 'py', 'mjs', 'cjs', 'js', 'ts', 'tsx', 'jsx'}


def looks_like_filename(ref):
    """마지막 마디가 알려진 확장자면 **파일 이름**이지 앵커가 아니다."""
    return ref.rsplit('.', 1)[-1].lower() in DOC_EXTS


def unregistered_prefixes(texts, known):
    seen = {}
    known_set = set(known)
    for t in texts:
        for m in ANCHORISH.finditer(t):
            pfx = m.group(1)
            if pfx in known_set:
                continue
            if looks_like_filename(m.group(0)):   # `ROADMAP.md` 는 파일 이름이지 앵커가 아니다
                continue
            seen[pfx] = seen.get(pfx, 0) + 1
    return sorted(seen.items(), key=lambda kv: -kv[1])
upstream_changed = [f for f in CHANGED if upstream_matcher(f) and f not in EXEMPT_ONLY]

# 훅(--changed)에서도 경고로는 본다 — severity는 sev()가 낮춘다.
if upstream_changed and not slice_changed_dirs:
    violate('reverseCoupling', ', '.join(upstream_changed), '상위 문서만 바뀌고 슬라이스가 하나도 안 바뀜',
            '상위가 바뀌었다. **구현은 어떻게 되나?**\n'
            '      ⓐ 구현을 고쳐야 한다 → 그 슬라이스로 재검토해 **코드까지** 간다\n'
            '      ⓑ 문서 정합만 맞추면 된다 → 흡수할 슬라이스에 흔적을 남긴다\n'
            '      ⓒ 무해한 오탈자·포맷이다\n'
            f"         → 커밋 트레일러 `{P['exempt'].get('commitTrailer', 'SDD-Exempt')}: <사유>` "
            "(**사유가 없으면 면제로 안 친다**)")


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
    """**"문서가 개정됐다"를 나타내는 축은 상위 문서 계열마다 다르다.**
      generic    : 문서 자체의 버전 표식(헌법의 `**Version**: 1.0.0` 등) — 올리는 게 맞다.
      easyproduct: **revision(결정 개정 번호)**이다. frontmatter의 version은 payload 계약(스키마) 버전이라
                   내용이 바뀌어도 안 올라간다 — 그걸 개정 축으로 쓰면 "version을 올려라"가 오지시가 되고,
                   실제로 v1 스키마로 검증되는 문서에 version: 13이 박히는 오염이 일어났다(실측)."""
    if not exists(rel):
        return None
    text = read_text(rel)
    fm = parse_frontmatter(text)
    ep = (P['upstream'].get('docsAdapter') or 'generic') == 'easyproduct'
    rev = fm.get('revision')
    revision = str(rev).strip() if rev is not None and str(rev).strip() != '' else None
    version = revision if ep else (fm.get('version') if isinstance(fm.get('version'), str) else None)
    if not version and P['sources'].get('semverLine'):
        m = re.search(re.escape(P['sources']['semverLine']) + r'\s*`?([0-9]+\.[0-9]+\.[0-9]+[^\s`]*)', text)
        if m:
            version = m.group(1)
    return {'version': version, 'hash': sha256(text), 'revision': revision,
            'axis': 'revision' if ep else 'version'}


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
        # 핀의 개정 축. 옛 핀은 version만 갖고 있으므로 둘 다 본다.
        if cur['axis'] == 'revision':
            pin_axis = str(pin['revision']) if pin.get('revision') is not None else pin.get('version')
        else:
            pin_axis = pin.get('version')
        axis_name = 'revision' if cur['axis'] == 'revision' else 'version'
        if pin_axis and cur['version'] and pin_axis != cur['version']:
            # **진짜 할 일**: 결정이 개정됐다. 재검토가 필요하다.
            violate('freshness', label, f"{pin['path']} 개정됨({axis_name} {pin_axis}→{cur['version']})",
                    'SDD로 재검토하고 그 결과를 기록한 뒤 핀을 갱신하라', path=pin['path'])
        elif pin.get('contentHash') and not re.search(r'[<>]', pin['contentHash']) \
                and pin['contentHash'] != cur['hash']:
            # 개정 번호는 그대로인데 내용이 다르다 — 문구·서식 손질이거나, 개정인데 번호를 안 올린 것이다.
            # 옛 문구는 "상위 문서의 version을 먼저 올리라"고 했는데, easyproduct 문서에서 그건
            # 스키마 계약 버전을 오염시키는 오지시다. 축 이름을 어댑터에서 받아 말한다.
            if cur['axis'] == 'revision':
                fix = ('내용을 확인하고 핀을 갱신하라. **결정이 바뀐 것이면 상위 문서의 `revision`을 올린다** — '
                       '`version`은 payload 계약(스키마) 버전이라 올리지 않는다.')
            else:
                fix = '상위 문서의 version을 먼저 올리고, 재검토 후 슬라이스 핀을 갱신하라'
            violate('freshness', label,
                    f"{pin['path']}가 핀 이후 수정됨({axis_name} {pin_axis or '없음'} 그대로 · 내용 해시 불일치)",
                    fix, path=pin['path'])


if P['pins'].get('impactUnit', 'file') == 'anchor':
    skipped.append('④의 앵커 단위 영향 분석 미구현 → 파일 단위로 판정(과탐 가능)')
for slug in scoped_slugs:
    check_pins(read_pins(f"{P['specsDir']}/{slug}/{P['requiredPinFile']}"), slug)
if P['pins'].get('globalPinFile'):
    check_pins(read_pins(P['pins']['globalPinFile']), '<project>')   # 전역 원칙은 한 번만 본다


# ─────────────────── 접을 후보 가시화 (위반 아님 · 정보 등급) ───────────────────
# 규칙 일곱이 전부 **변화**에 반응하고 **은퇴**를 말하는 자리가 없으면 슬라이스는 단조증가한다
# (실사용: 다섯 달에 78개, 절반 이상이 제품 기능이 아니었다). 접기는 원래 막힌 적이 없는데
# **접어도 된다는 말과 순서가 없었을 뿐**이다. 그래서 여기서 **후보를 세어 준다**.
#
# **위반이 아니라 정보(`·`)다** — 아직 코드를 안 쓴 진행 중 슬라이스도 걸리므로 종료코드를 안 바꾼다.
# 판단은 사람이 한다.
if OPTS['mode'] == 'full' and scoped_slugs:
    # ① 구속력 있는 태그가 없는 슬라이스. **allowlist 안의 태그는 세지 않는다** —
    #    ③이 `is_governed`를 먼저 보므로 그 태그는 검사기가 안 본다(장식이다).
    #    실사용자가 이걸 몰라 시험·하네스의 태그까지 세는 바람에 처음에 일곱 개밖에 못 줄였다.
    binding = set()
    for f in GOVERNED:
        t = read_tag(f)
        if t and t.get('slug'):
            binding.add(t['slug'])
    foldable = [g for g in scoped_slugs if g not in binding]

    # ② **이 슬라이스만** 핀한 상위 문서. 그냥 접으면 그 문서가 바뀌어도 ④가 **아무 데서도 안 운다** —
    #    하네스가 존재하는 이유를 스스로 깎는 자리라, 접기 전에 핀을 옮겨야 한다.
    #    실사용자는 이걸 스크립트를 짜서 셌다.
    pinners = {}
    for g in scoped_slugs:
        for pin in read_pins(f"{P['specsDir']}/{g}/{P['requiredPinFile']}"):
            pinners.setdefault(pin['path'], set()).add(g)
    sole = sorted((doc, next(iter(gs))) for doc, gs in pinners.items() if len(gs) == 1)

    if foldable:
        notes.append(f"구속력 있는 태그가 없는 슬라이스 {len(foldable)}개 — 접을 수 있는지 보세요: "
                     + ', '.join(foldable[:8]) + (f" 외 {len(foldable) - 8}개" if len(foldable) > 8 else ""))
        notes.append('     (allowlist 안 태그는 안 셉니다 — ③이 그걸 안 보기 때문입니다)')
        notes.append('     → 접는 순서: SKILL.md 「슬라이스를 언제 열고 언제 접나」')
    if sole:
        notes.append(f"이 슬라이스만 핀한 상위 문서 {len(sole)}건 — 그냥 접으면 ④가 아무 데서도 안 웁니다")
        for doc, g in sole[:5]:
            notes.append(f"     {g} → {doc}")
        if len(sole) > 5:
            notes.append(f"     외 {len(sole) - 5}건")
        notes.append('     → 접기 전에 핀을 옮기세요(접는 순서 2번)')


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

def is_series_ref(text, end):
    r"""매치 **뒤**에서 계열 표기(`…*`)를 가른다.

    와일드카드 가드를 패턴 안에 `(?!\.\*)`로 두면 **마디가 넷 이상일 때 되짚기로 뚫린다** —
    `BEITF.user.law.*`에서 가드가 실패하면 한 마디 물러나 `BEITF.user`로 다시 맞고, 그 자리는
    뒤에 `.law`가 오므로 두 가드를 모두 통과한다. 그래서 **아무도 적은 적 없는 이름**이 죽은
    링크로 떴다. 여기는 되짚기가 닿지 않는다.
    """
    return text[end:end + 2] == '.*'


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
                          + r')(?:\.[A-Za-z0-9_-]+)+(?![A-Za-z0-9_-])')
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
                    if is_series_ref(text, m.end()):    # 계열 표기 — 참조가 아니다
                        continue
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
        # **슬러그는 specsDir 바로 다음 마디다.** `split('/')[1]`로 뽑으면 specsDir가 한 마디일 때만
        # 맞는데, 모노레포는 `backend/specs`처럼 두 마디 이상이 정상이다(references/monorepo.md 권장).
        # 그때 [1]은 'specs'가 되고 rel이 '<slug>/spec.md'가 되어 **watch와 절대 안 맞는다** →
        # `continue` → **⑦이 통째로 안 돈다.**
        #
        # ③ 결합은 같은 함정을 이미 고쳤는데 ⑦은 안 고쳤다. **③은 "항상 운다"로 나타나 즉시 들켰고,
        # ⑦은 "영원히 안 운다"로 나타나 안 들켰다** — 같은 코드, 반대 증상(실측 제보).
        # ⚠ 대조 시험으로도 안 잡혔다: **두 구현이 같게 틀려서** 결과가 일치했다.
        rest = f[len(P['specsDir']) + 1:].split('/')
        if len(rest) < 2:
            continue
        slug, rel = rest[0], '/'.join(rest[1:])
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
