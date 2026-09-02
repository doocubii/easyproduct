#!/usr/bin/env node
// sdd-check.mjs — SDD 강제 하네스 검사기 (참조 구현). 무의존 Node(ESM).
//
// **정본은 `../references/checker-pseudocode.md`다.** 알고리즘·메시지·종료코드는 그 문서를 따르고,
// 이 파일은 그것의 JS 구현일 뿐이다. 다른 언어로 이식할 때도 정본을 근거로 삼는다.
//
// 이 파일은 **정책(`sdd-policy.json`)만** 읽는다 — 프로젝트 이름·경로를 로직에 박지 않는다.
// easyproduct 개념(FEAT/DATA/POL·check-docs)을 import하지 않는다. 어댑터는 "frontmatter가 가리키는
// json 블록에서 id를 긁는다"는 일반 절차이며, 접두어·태그 이름은 전부 정책 문자열로 받는다.
//
// 사용:
//   node sdd-check.mjs --full [--json] [--policy <path>]
//   node sdd-check.mjs --changed <file> [<file>...] [--json]
// 종료코드: 0 = block 위반 없음(경고는 있어도 0) · 1 = block 위반 · 2 = 설정 오류

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const HEAD_LINES = 25;            // 출처 태그를 찾을 파일 앞부분 범위(전체 스캔은 느리고 오탐이 난다)
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'target', 'vendor',
  '.venv', 'venv', '__pycache__', '.next', '.nuxt', 'coverage', '.turbo', '.cache',
]);

// ─────────────────────────────── 인자 ───────────────────────────────

const argv = process.argv.slice(2);
const opts = { mode: null, json: false, policy: null, files: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--full') opts.mode = 'full';
  else if (a === '--changed') { opts.mode = 'changed'; while (argv[i + 1] && !argv[i + 1].startsWith('--')) opts.files.push(argv[++i]); }
  else if (a === '--json') opts.json = true;
  else if (a === '--policy') opts.policy = argv[++i];
  else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
  else fail(`알 수 없는 인자: ${a}`);
}
if (!opts.mode) { usage(); process.exit(2); }

function usage() {
  console.log(`sdd-check — SDD 강제 하네스 검사기
  --full                전체 검사(verify·CI). 7규칙 모두.
  --changed <files...>  변경 파일만(편집 훅). ① 하드, ③④⑥ 경고, ⑤⑦ 스킵.
  --json                기계 판독 출력
  --policy <path>       정책 파일 경로(기본: sdd-policy.json 탐색)`);
}
function fail(msg) { console.error(`설정 오류: ${msg}`); process.exit(2); }

// ─────────────────────────────── 기본 유틸 ───────────────────────────────

// 원문 그대로 반환한다 — `git status --porcelain`은 선행 상태 문자(예: " M path")가 의미를 가지므로
// 여기서 trim하면 경로 오프셋이 밀린다. 단일 값이 필요한 곳에서만 호출부가 trim한다.
function git(args, allowFail = false) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (allowFail) return null;
    throw e;
  }
}
const gitValue = (args) => (git(args, true) ?? '').trim() || null;

// `git status --porcelain`의 각 줄에서 경로만 뽑는다(이름 변경은 화살표 뒤가 현재 경로).
function statusPaths() {
  const out = [];
  for (const line of (git(['status', '--porcelain'], true) ?? '').split('\n')) {
    const m = /^..\s+(.+)$/.exec(line);
    if (!m) continue;
    const p = m[1].includes(' -> ') ? m[1].split(' -> ')[1] : m[1];
    out.push(p.replace(/^"|"$/g, ''));
  }
  return out;
}
const toPosix = (p) => p.split('\\').join('/');
const readText = (p) => readFileSync(join(ROOT, p), 'utf8');
const sha256 = (s) => 'sha256:' + createHash('sha256').update(s.split('\r\n').join('\n')).digest('hex');

const ROOT = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch { return process.cwd(); }
})();

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// glob → RegExp. 지원: ** · * · ? · {a,b}
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) re += '\\{';
      else { re += '(?:' + glob.slice(i + 1, end).split(',').map((o) => o.split('').map(escapeRe).join('')).join('|') + ')'; i = end; }
    } else re += escapeRe(c);
  }
  return new RegExp('^' + re + '$');
}
function makeMatcher(globs) {
  const res = (globs ?? []).map(globToRegExp);
  return (p) => res.some((r) => r.test(p));
}

function walkFiles(dir = '', acc = []) {
  const abs = join(ROOT, dir);
  let entries;
  try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (e.name.startsWith('.') && SKIP_DIRS.has(e.name)) continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) walkFiles(rel, acc);
    else if (e.isFile()) acc.push(rel);
  }
  return acc;
}

// ─────────────────────────────── 정책 ───────────────────────────────

// 정책 탐색은 **cwd 기준을 먼저, 저장소 루트 기준을 나중에** 본다.
// 모노레포에서는 ROOT(git 루트) ≠ spec-kit 루트라, ROOT 기준으로만 찾으면 트랙 안에 있는 정책을
// 영영 못 찾아 `--policy`가 사실상 필수가 된다(그리고 `--policy`에 준 상대경로마저 ROOT 기준으로
// 해석돼 어긋난다). 자세한 것은 `references/monorepo.md`.
function findPolicy() {
  const names = ['sdd-policy.json', '.specify/sdd-policy.json'];
  const candidates = [];
  if (opts.policy) candidates.push(resolve(process.cwd(), opts.policy), resolve(ROOT, opts.policy));
  for (const n of names) candidates.push(resolve(process.cwd(), n), resolve(ROOT, n));
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

const policyPath = findPolicy();
if (!policyPath) fail('sdd-policy.json을 찾지 못했다(--policy로 지정하라).');
let policy;
try { policy = JSON.parse(readFileSync(policyPath, 'utf8')); }
catch (e) { fail(`정책 파싱 실패: ${policyPath} — ${e.message}`); }

// 템플릿 자리표시자(<…>)가 남아 있으면 검사가 조용히 아무것도 안 보게 된다 → 설정 오류로 막는다.
{
  const unresolved = [];
  const scan = (v, path) => {
    if (typeof v === 'string') { if (/[<>]/.test(v) && !path.startsWith('$comment')) unresolved.push(`${path}: ${v}`); }
    else if (Array.isArray(v)) v.forEach((x, i) => scan(x, `${path}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (!k.startsWith('$comment')) scan(x, path ? `${path}.${k}` : k); }
  };
  scan(policy, '');
  // 핀 위치 표기(specs/<slug>/sources.json)는 자리표시자가 정상이다.
  const real = unresolved.filter((u) => !u.startsWith('pins.location') && !u.startsWith('reviewRecord.path'));
  if (real.length) fail(`정책에 채우지 않은 자리표시자가 있다 — 검사가 무의미해진다:\n  - ${real.join('\n  - ')}`);
}

const P = {
  specsDir: policy.specsDir ?? 'specs',
  requiredPhaseFiles: policy.requiredPhaseFiles ?? ['spec.md', 'plan.md', 'tasks.md'],
  requiredPinFile: policy.requiredPinFile ?? 'sources.json',
  governedGlobs: policy.governedGlobs ?? [],
  allowlist: policy.allowlist ?? [],
  unmatchedNewFiles: policy.unmatchedNewFiles ?? 'off',
  provenanceTag: policy.provenanceTag ?? '@sdd',
  commentSyntaxes: policy.commentSyntaxes ?? ['//', '#', '/*'],
  upstream: policy.upstreamDocs ?? { globs: [], docsAdapter: 'generic', anchorRegistry: {} },
  pins: policy.pins ?? {},
  sources: policy.sources ?? {},
  specRefs: policy.specRefs ?? {},
  reviewRecord: policy.reviewRecord ?? {},
  delegated: policy.delegated ?? {},
  mainBranch: policy.mainBranch ?? 'main',
  exempt: policy.exempt ?? { fileTag: '@sdd:exempt', commitTrailer: 'SDD-Exempt' },
  mode: policy.mode ?? 'block',
  severity: policy.severity ?? {},
  hooks: policy.hooks ?? {},
};

const skipped = [];   // 무엇을 안 봤는지 — 리포트 머리말에 반드시 드러낸다
const notes = [];     // 위반은 아니지만 **알아야 하는 것**(정책이 세트를 못 따라간 흔적 등)
const bareExempt = [];      // 사유 없이 적힌 면제 트레일러의 커밋(면제로 **안** 쳤다 — 원인을 알려 준다)
const bareFileExempt = [];  // 사유 없는 파일 태그(면제는 **인정**하되 알린다 — 상태 선언이라 막지 않는다)
const violations = [];

// 브라운필드 `mode: "warn"`은 **완료 게이트(verify·CI) 층에만** 적용한다.
// 훅(--changed)까지 warn으로 덮으면 종료코드가 0이 되어 **에이전트에 아무것도 주입되지 않고**,
// 정작 안내가 가장 필요한 도입 기간에 ①층이 통째로 죽는다(조용한 실패). 훅은 방금 편집한
// 파일 하나만 보므로 브라운필드 홍수 논리도 적용되지 않는다.
function sev(rule) {
  if (P.mode === 'warn' && opts.mode !== 'changed') return 'warn';
  const s = P.severity[rule] ?? 'block';
  // --changed(훅)에서는 diff 범위 규칙을 경고로 낮춘다(정본 §0).
  if (opts.mode === 'changed' && ['coupling', 'freshness', 'reverseCoupling'].includes(rule) && s === 'block') return 'warn';
  return s;
}
function violate(rule, target, message, action, extra = {}) {
  const severity = extra.severity ?? sev(rule);
  if (severity === 'off') return;
  violations.push({ rule, severity, target, message, action, ...extra });
}

// ─────────────────────────────── 대상 집합 ───────────────────────────────

const isAllowlisted = makeMatcher(P.allowlist);
const isGoverned = (() => {
  const inc = makeMatcher(P.governedGlobs);
  return (p) => inc(p) && !isAllowlisted(p);
})();

// 정렬은 결정성 때문 — 같은 입력이면 위반 순서가 항상 같아야 CI diff·구현 간 비교가 가능하다.
const allFiles = walkFiles().sort();
const governed = allFiles.filter(isGoverned);

// git 변경 집합
let baseRef = null;
const changed = (() => {
  if (opts.mode === 'changed') return opts.files.map((f) => toPosix(f.startsWith(ROOT) ? f.slice(ROOT.length + 1) : f)).sort();
  const mb = gitValue(['merge-base', P.mainBranch, 'HEAD']);
  baseRef = mb || gitValue(['rev-parse', 'HEAD~1']);
  if (!mb) {
    skipped.push(`③⑥의 base: merge-base(${P.mainBranch}) 실패 → ${baseRef ? 'HEAD~1' : '워킹트리만'} 기준`
      + ' — CI라면 얕은 클론일 수 있다(GitLab `GIT_DEPTH: 0` / GH Actions `fetch-depth: 0` 확인)');
  }
  const list = new Set();
  if (baseRef) for (const f of (git(['diff', '--name-only', `${baseRef}..HEAD`], true) ?? '').split('\n')) if (f.trim()) list.add(f.trim());
  for (const p of statusPaths()) list.add(p);
  return [...list].sort();
})();

// 면제 커밋(트레일러)이 '단독으로' 건드린 파일 집합
const exemptOnlyFiles = (() => {
  if (opts.mode !== 'full' || !baseRef) return new Set();
  const raw = git(['log', `${baseRef}..HEAD`, '--pretty=format:%H%x1f%B%x1e'], true) ?? '';
  const exempt = new Set(), normal = new Set();
  for (const entry of raw.split('\x1e')) {
    if (!entry.trim()) continue;
    const [hash, body = ''] = entry.split('\x1f');
    // **사유 없는 면제는 면제가 아니다.** 콜론까지만 보면 한 줄로 ③⑥을 끌 수 있고, 그러면
    // **나중에 "왜 못 막았는지"를 확인할 근거가 없다** — 면제의 존재 이유가 그 기록이다.
    // 파일 태그는 처음부터 사유를 요구했는데 여기만 새고 있었다(비대칭 회복).
    const isExempt = new RegExp(`^\\s*${escapeRe(P.exempt.commitTrailer)}\\s*:\\s*(\\S.*)`, 'mi').test(body);
    if (!isExempt && new RegExp(`^\\s*${escapeRe(P.exempt.commitTrailer)}\\s*:\\s*$`, 'mi').test(body)) {
      bareExempt.push(hash.trim().slice(0, 7));
    }
    const files = (git(['show', '--name-only', '--format=', hash.trim()], true) ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
    for (const f of files) (isExempt ? exempt : normal).add(f);
  }
  for (const p of statusPaths()) normal.add(p);      // 미커밋 변경은 면제로 치지 않는다
  return new Set([...exempt].filter((f) => !normal.has(f)));
})();

// ─────────────────────────────── ① 출처 ───────────────────────────────

const tagRe = new RegExp(`${escapeRe(P.provenanceTag)}\\s+([A-Za-z0-9._\\-/]+)`);
// **파일 태그는 사유가 없어도 면제로 인정한다(경고만).** 면제하려던 의도가 분명한데 막는 것은 과하다.
// 트레일러와 다르게 가는 이유: 파일 태그는 "이 파일은 SDD 대상이 아니다"라는 **상태 선언**이고,
// 트레일러는 "이번엔 넘어간다"는 **일회성 예외**라 그때그때 근거가 남아야 한다.
const exemptRe = new RegExp(`${escapeRe(P.exempt.fileTag)}(?:\\s+(\\S.*))?\\s*$`);

function readTag(file) {
  let head;
  try { head = readText(file).split('\n').slice(0, HEAD_LINES).join('\n'); } catch { return { kind: 'unreadable' }; }
  const inComment = (line, idx) => P.commentSyntaxes.some((c) => { const i = line.indexOf(c); return i !== -1 && i < idx; });
  for (const line of head.split('\n')) {
    const em = exemptRe.exec(line);
    if (em && inComment(line, em.index)) return { kind: 'exempt', reason: (em[1] ?? '').trim() };
    const m = tagRe.exec(line);
    if (m && inComment(line, m.index)) return { kind: 'tag', slug: m[1] };
  }
  return { kind: 'none' };
}

const usedSlugs = new Set();
const provenanceTargets = opts.mode === 'changed' ? changed.filter(isGoverned) : governed;

for (const f of provenanceTargets) {
  const t = readTag(f);
  if (t.kind === 'exempt') { if (!t.reason) bareFileExempt.push(f); continue; }
  if (t.kind === 'tag') usedSlugs.add(t.slug);
  else if (t.kind === 'none') {
    violate('provenance', f, '출처 태그 없음',
      `이 파일이 파생된 슬라이스를 \`${P.provenanceTag} <slug>\`로 선언하거나, 사유와 함께 \`${P.exempt.fileTag}\``);
  }
}
// --changed에서도 ②④의 대상 집합은 전체 태그에서 모은다(훅이 일부 파일만 받기 때문).
if (opts.mode === 'changed') for (const f of governed) { const t = readTag(f); if (t.kind === 'tag') usedSlugs.add(t.slug); }

// ②④⑤⑦의 대상 slug 범위.
// 태그만으로 범위를 잡으면 **태그가 하나도 없는 브라운필드에서 ②④⑤⑦가 통째로 침묵**한다
// (①만 걸리고 나머지는 "위반 0"으로 보여 검증됐다는 착각을 준다). 그래서 --full 기본은
// `specsDir`에 실재하는 슬라이스 전부를 대상으로 삼는다(`sliceScope: "tagged"`로 좁힐 수 있다).
const declaredSlugs = existsSync(join(ROOT, P.specsDir))
  ? readdirSync(join(ROOT, P.specsDir), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
  : [];
const sliceScope = policy.sliceScope ?? 'all';
const scopedSlugs = (opts.mode === 'full' && sliceScope === 'all')
  ? [...new Set([...declaredSlugs, ...usedSlugs])].sort()
  : [...usedSlugs].sort();
if (opts.mode === 'full' && sliceScope === 'all' && declaredSlugs.length > usedSlugs.size) {
  skipped.push(`slug 범위: specsDir의 선언 슬라이스 ${declaredSlugs.length}개 전부(태그된 slug ${usedSlugs.size}개) — sliceScope: "tagged"로 좁힐 수 있다`);
}

// 관장 사각 — 어느 glob에도 안 걸리는 신규 소스
if (P.unmatchedNewFiles !== 'off' && opts.mode === 'full' && baseRef) {
  const added = (git(['diff', '--name-only', '--diff-filter=A', `${baseRef}..HEAD`], true) ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
  const untracked = (git(['ls-files', '--others', '--exclude-standard'], true) ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
  const codeExt = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|swift)$/;
  for (const f of [...added, ...untracked]) {
    if (!codeExt.test(f) || isGoverned(f) || isAllowlisted(f)) continue;
    violate('unmatchedNewFile', f, '관장 범위 밖 신규 소스 파일',
      'governedGlobs를 넓히거나, 사유와 함께 allowlist에 등록하라', { severity: P.unmatchedNewFiles });
  }
}

if (bareExempt.length) {
  notes.push(`사유 없는 ${P.exempt.commitTrailer} ${bareExempt.length}건 — **면제로 치지 않았습니다**: `
    + bareExempt.slice(0, 5).join(' · ') + (bareExempt.length > 5 ? ` 외 ${bareExempt.length - 5}건` : ''));
  notes.push('     → 트레일러 뒤에 **왜 괜찮은지** 적으세요. 나중에 "왜 못 막았는지" 확인할 근거가 그것뿐입니다.');
}
if (bareFileExempt.length) {
  notes.push(`사유 없는 ${P.exempt.fileTag} ${bareFileExempt.length}건 — 면제는 인정했습니다: `
    + bareFileExempt.slice(0, 5).join(' · ') + (bareFileExempt.length > 5 ? ` 외 ${bareFileExempt.length - 5}건` : ''));
  notes.push('     → 왜 SDD 대상이 아닌지 한 줄 적어 두면 다음 사람이 안 헤맵니다(막지는 않습니다).');
}

// ─────────────────────────────── ② 완결 ───────────────────────────────

if (P.delegated.ciGuard) skipped.push('② 완결(산출물 존재·완결성) → CI Guard 위임 · 핀 파일 검사만 유지');

for (const slug of scopedSlugs) {
  const dir = `${P.specsDir}/${slug}`;
  if (!existsSync(join(ROOT, dir))) {
    violate('completeness', slug, `슬라이스 폴더 없음: ${dir}`, '태그의 slug가 실제 spec-kit 슬라이스를 가리키게 하라');
    continue;
  }
  if (!P.delegated.ciGuard && sev('completeness') !== 'off') {
    for (const pf of P.requiredPhaseFiles) {
      const p = `${dir}/${pf}`;
      if (!existsSync(join(ROOT, p))) violate('completeness', slug, `단계 산출물 없음: ${pf}`, 'spec→plan→tasks 순서로 채워라');
      else if (readText(p).trim() === '') violate('completeness', slug, `단계 산출물이 비어 있음: ${pf}`, '내용을 채워라(빈 파일은 통과시키지 않는다)');
    }
  }
  // 핀 파일은 위임 여부와 무관하게 항상 본다 — ④의 전제이기 때문
  if (!existsSync(join(ROOT, `${dir}/${P.requiredPinFile}`))) {
    violate('completeness', slug, `핀 파일 없음: ${P.requiredPinFile}`,
      '이 슬라이스가 근거로 삼은 상위 문서를 version+contentHash로 핀하라(없으면 ④가 침묵한다)');
  }
}

// ─────────────────────────────── ③ 결합 ───────────────────────────────

const changedSet = new Set(changed);
// 슬러그는 **`specsDir` 바로 다음 마디**다. `split('/')[1]`로 뽑으면 `specsDir`가 한 마디일 때만 맞는데,
// 모노레포는 `frontend-user/specs`처럼 **두 마디 이상**이 정상이다(`references/monorepo.md`가 그렇게 권한다).
// 그때 `[1]`은 `"specs"`가 되어 어떤 슬러그와도 안 맞고, ③ 결합이 **항상 발화**한다 —
// `warn`에서는 소음이지만 `block`으로 졸업하는 순간 **관장 파일을 건드리는 모든 커밋이 막힌다**(실측).
// **「슬라이스가 바뀌었다」는 폴더 안 아무 파일이다 — 좁히지 않는다.**
// `spec`·`plan`·`tasks` 로 좁히자는 제안이 실사용에서 왔는데, 재 보니 **정상 작업을 새로 막았다**
// (구현 중 `handoff.md` 만 고친 커밋 2건). 좁힘의 최종형인 "내용이 실제로 바뀐 파일만"은 **이미 지금
// 동작이다** — `git diff` 가 내용이 바뀐 것만 낸다.
//
// ⚠ **「무엇이 바뀌었나」로는 이 구멍을 못 닫는다.** 닫으려면 **순서**(spec 이 먼저였나)를 봐야 하는데
// 이 검사는 범위의 **동시성**만 본다. 한계로 적고, 대신 **문구가 ⓑ「spec 을 먼저 고쳐라」를 말하게** 한다.
const sliceChangedDirs = new Set(
  changed
    .filter((f) => f.startsWith(`${P.specsDir}/`))
    .map((f) => f.slice(P.specsDir.length + 1).split('/')[0])
    .filter(Boolean),
);

for (const f of changed) {
  if (!isGoverned(f)) continue;
  if (exemptOnlyFiles.has(f)) continue;
  const t = existsSync(join(ROOT, f)) ? readTag(f) : { kind: 'none' };
  if (t.kind === 'exempt') continue;
  if (t.kind !== 'tag') continue;                       // 태그 없음은 ①이 이미 잡았다
  if (!sliceChangedDirs.has(t.slug)) {
    violate('coupling', f, `코드가 바뀌었는데 슬라이스(${P.specsDir}/${t.slug})에 변경이 없음`,
      // **「흡수」를 말한다(⑥과 같은 어휘).** 예전엔 "먼저 갱신하거나 … 면제"였는데, 읽는 쪽에서
      // 「갱신」은 *닫힌 슬라이스를 다시 여는 것*으로, 「면제」는 *규칙을 피하는 것*으로 보였다.
      // 그래서 **문구에 없는 셋째 길(새 슬라이스를 만들고 태그를 옮긴다)이 제일 떳떳해 보였고**,
      // 실사용에서 슬라이스가 78개까지 늘었다(절반 이상이 제품 기능이 아니었다).
      // **선택지만 나열하면 「가장 싸게 조용히 시키는 법」만 배운다.** 예전 두 갈래는 「갱신」·「면제」
      // 둘 다 *코드는 그대로 두는* 길이라, SDD 가 정작 말하려는 갈래 — *"spec 에 없는 것을 코드로
      // 정했으면 코드가 아니라 spec 을 먼저 고쳐라"* — 가 화면에 없었다. 그래서 **물음을 먼저** 세운다.
      '이 변경은 **어디서 나왔나?**\n'
      + '      ⓐ 승인된 spec 에서 나왔다\n'
      + '         → 그 슬라이스의 spec/plan/tasks 에 흔적을 남겨라. **기존 슬라이스여도 된다**(새로 만들지 않는다)\n'
      + '      ⓑ spec 에 없는 것을 **코드로 새로 정했다**\n'
      + '         → **코드가 아니라 spec 을 먼저 고쳐라.** 그것이 SDD 이고, 이 검사가 보는 것이 그 순서다\n'
      + '      ⓒ spec 과 무관하다(오탈자·포맷·기계적 수정)\n'
      + `         → 커밋 트레일러 \`${P.exempt.commitTrailer}: <사유>\` (**사유가 없으면 면제로 안 친다**)\n`
      + '      ⚠ 셋 중 무엇인지는 **사람만 안다.** 이 검사는 흔적이 있나만 본다.',
      { slug: t.slug });
  }
}

// ─────────────────────────────── ⑥ 역결합 ───────────────────────────────

const upstreamMatcher = makeMatcher(P.upstream.globs ?? []);

// easyproduct 세트의 **색인 매니페스트**와 `upstreamDocs.globs`를 대조한다.
// 정책은 사람이 읽을 수 있어야 하므로 런타임에 매니페스트로 **대체하지 않는다** — 대신 **어긋남을 보고**한다.
// 실제 사고: 세트가 새 채널(`interface-requests/`)을 얻었는데 글롭에 없어, 그 채널 전체가 ④⑥ 밖이었다.
// 문서가 상위 층에 있는지는 `role`로 판정한다(`ssot`=결정이 사는 곳 · `handoff`=다른 팀에 넘기는 계약 갈래).
function manifestGaps() {
  if ((P.upstream.docsAdapter ?? 'generic') !== 'easyproduct') return null;
  const idx = allFiles.filter((f) => f.endsWith('00-index.md'));
  const out = new Map();          // docType → 안 덮이는 경로 수
  let seenManifest = false;
  for (const f of idx) {
    const m = /```json\s+docbundle\.docs\n([\s\S]*?)```/.exec(readText(f));
    if (!m) continue;
    let man; try { man = JSON.parse(m[1]); } catch { continue; }
    if (!Array.isArray(man.docs)) continue;
    seenManifest = true;
    const base = f.replace(/00-index\.md$/, '');
    for (const d of man.docs) {
      if (!d || !d.path) continue;
      if (d.role !== 'ssot' && d.role !== 'handoff') continue;
      const full = (base + d.path).replace(/\\/g, '/');
      if (upstreamMatcher(full)) continue;
      const k = d.docType || '(unknown)';
      out.set(k, (out.get(k) || 0) + 1);
    }
  }
  return seenManifest ? out : null;
}
const upstreamChanged = changed.filter((f) => upstreamMatcher(f) && !exemptOnlyFiles.has(f));

// 훅(--changed)에서도 경고로는 본다 — severity는 sev()가 낮춘다.
if (upstreamChanged.length > 0 && sliceChangedDirs.size === 0) {
  violate('reverseCoupling', upstreamChanged.join(', '), '상위 문서만 바뀌고 슬라이스가 하나도 안 바뀜',
    '상위가 바뀌었다. **구현은 어떻게 되나?**\n'
    + '      ⓐ 구현을 고쳐야 한다 → 그 슬라이스로 재검토해 **코드까지** 간다\n'
    + '      ⓑ 문서 정합만 맞추면 된다 → 흡수할 슬라이스에 흔적을 남긴다\n'
    + '      ⓒ 무해한 오탈자·포맷이다\n'
    + `         → 커밋 트레일러 \`${P.exempt.commitTrailer}: <사유>\` (**사유가 없으면 면제로 안 친다**)`);
}

// ─────────────────────────────── ④ 신선도 ───────────────────────────────

function parseFrontmatter(text) {
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end === -1) return {};
  const fm = {};
  let parent = null;
  for (const raw of text.slice(3, end).split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indented = /^\s{2,}\S/.test(raw);
    const m = /^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(raw);
    if (!m) continue;
    const [, k, vRaw] = m;
    const v = vRaw.trim().replace(/^["']|["']$/g, '');
    if (indented && parent) fm[parent][k] = v;
    else if (v === '') { parent = k; fm[k] = {}; }
    else { fm[k] = v; parent = null; }
  }
  return fm;
}

// **"문서가 개정됐다"를 나타내는 축은 상위 문서 계열마다 다르다.**
//   generic  : 문서 자체의 버전 표식(헌법의 `**Version**: 1.0.0` 등) — 올리는 게 맞다.
//   easyproduct: **`revision`(결정 개정 번호)**이다. frontmatter의 `version`은 **payload 계약(스키마) 버전**이라
//                내용이 바뀌어도 **안 올라간다** — 그걸 개정 축으로 쓰면 "version을 올려라"가 오지시가 되고,
//                실제로 v1 스키마로 검증되는 문서에 `version: 13`이 박히는 오염이 일어났다(실측).
// 그래서 어댑터에 따라 축을 갈라 읽는다.
function readVersion(path) {
  if (!existsSync(join(ROOT, path))) return null;
  const text = readText(path);
  const fm = parseFrontmatter(text);
  const ep = (P.upstream.docsAdapter ?? 'generic') === 'easyproduct';
  const revision = fm.revision != null && String(fm.revision).trim() !== '' ? String(fm.revision).trim() : null;
  let version = ep ? revision : (typeof fm.version === 'string' ? fm.version : null);
  if (!version && P.sources.semverLine) {
    const re = new RegExp(`${escapeRe(P.sources.semverLine)}\\s*\`?([0-9]+\\.[0-9]+\\.[0-9]+[^\\s\`]*)`);
    const m = re.exec(text);
    if (m) version = m[1];
  }
  return { version, hash: sha256(text), revision, axis: ep ? 'revision' : 'version' };
}

function readPins(file) {
  if (!existsSync(join(ROOT, file))) return [];
  let data;
  try { data = JSON.parse(readText(file)); } catch (e) { violate('freshness', file, `핀 파일 파싱 실패 — ${e.message}`, 'JSON 형식을 고쳐라'); return []; }
  const list = Array.isArray(data) ? data : (data.sources ?? []);
  return list.filter((p) => p && typeof p.path === 'string');
}

function checkPins(pins, label) {
  for (const pin of pins) {
    const cur = readVersion(pin.path);
    if (!cur) {
      violate('freshness', label, `핀 대상 파일이 없음: ${pin.path}`, '경로를 고치거나 핀에서 빼라', { path: pin.path });
      continue;
    }
    // 핀의 개정 축. 옛 핀은 `version`만 갖고 있으므로 둘 다 본다.
    const pinAxis = cur.axis === 'revision' ? (pin.revision != null ? String(pin.revision) : (pin.version ?? null)) : (pin.version ?? null);
    const axisName = cur.axis === 'revision' ? 'revision' : 'version';
    if (pinAxis && cur.version && pinAxis !== cur.version) {
      // **진짜 할 일**: 결정이 개정됐다. 재검토가 필요하다.
      violate('freshness', label, `${pin.path} 개정됨(${axisName} ${pinAxis}→${cur.version})`,
        'SDD로 재검토하고 그 결과를 기록한 뒤 핀을 갱신하라', { path: pin.path });
    } else if (pin.contentHash && !/[<>]/.test(pin.contentHash) && pin.contentHash !== cur.hash) {
      // 개정 번호는 그대로인데 내용이 다르다 — **문구·서식 손질이거나, 개정인데 번호를 안 올린 것**이다.
      // 옛 문구는 여기서 "상위 문서의 version을 먼저 올리라"고 했는데, easyproduct 문서에서 그건
      // **스키마 계약 버전을 오염시키는 오지시**다. 축 이름을 어댑터에서 받아 말한다.
      const fix = cur.axis === 'revision'
        ? '내용을 확인하고 핀을 갱신하라. **결정이 바뀐 것이면 상위 문서의 `revision`을 올린다** — '
          + '`version`은 payload 계약(스키마) 버전이라 올리지 않는다.'
        : '상위 문서의 version을 먼저 올리고, 재검토 후 슬라이스 핀을 갱신하라';
      violate('freshness', label, `${pin.path}가 핀 이후 수정됨(${axisName} ${pinAxis ?? '없음'} 그대로 · 내용 해시 불일치)`,
        fix, { path: pin.path });
    }
  }
}

if ((P.pins.impactUnit ?? 'file') === 'anchor') {
  skipped.push('④의 앵커 단위 영향 분석 미구현 → 파일 단위로 판정(과탐 가능)');
}
for (const slug of scopedSlugs) checkPins(readPins(`${P.specsDir}/${slug}/${P.requiredPinFile}`), slug);
if (P.pins.globalPinFile) checkPins(readPins(P.pins.globalPinFile), '<project>');   // 전역 원칙은 한 번만 본다

// ─────────────────── 접을 후보 가시화 (위반 아님 · 정보 등급) ───────────────────
// 규칙 일곱이 전부 **변화**에 반응하고 **은퇴**를 말하는 자리가 없으면 슬라이스는 단조증가한다
// (실사용: 다섯 달에 78개, 절반 이상이 제품 기능이 아니었다). 접기는 원래 막힌 적이 없는데
// **접어도 된다는 말과 순서가 없었을 뿐**이다. 그래서 여기서 **후보를 세어 준다**.
//
// **위반이 아니라 정보(`·`)다** — 아직 코드를 안 쓴 진행 중 슬라이스도 걸리므로 종료코드를 안 바꾼다.
if (opts.mode === 'full' && scopedSlugs.length) {
  // ① 구속력 있는 태그가 없는 슬라이스. **allowlist 안의 태그는 세지 않는다** —
  //    ③이 `isGoverned`를 먼저 보므로 그 태그는 검사기가 안 본다(장식이다).
  const binding = new Set();
  for (const f of governed) {
    const t = readTag(f);
    if (t && t.slug) binding.add(t.slug);
  }
  const foldable = scopedSlugs.filter((g) => !binding.has(g));

  // ② **이 슬라이스만** 핀한 상위 문서. 그냥 접으면 그 문서가 바뀌어도 ④가 **아무 데서도 안 운다**.
  const pinners = new Map();
  for (const g of scopedSlugs) {
    for (const pin of readPins(`${P.specsDir}/${g}/${P.requiredPinFile}`)) {
      if (!pinners.has(pin.path)) pinners.set(pin.path, new Set());
      pinners.get(pin.path).add(g);
    }
  }
  const sole = [...pinners.entries()].filter(([, gs]) => gs.size === 1)
    .map(([doc, gs]) => [doc, [...gs][0]]).sort((a, b) => (a[0] < b[0] ? -1 : 1));

  if (foldable.length) {
    notes.push(`구속력 있는 태그가 없는 슬라이스 ${foldable.length}개 — 접을 수 있는지 보세요: `
      + foldable.slice(0, 8).join(', ') + (foldable.length > 8 ? ` 외 ${foldable.length - 8}개` : ''));
    notes.push('     (allowlist 안 태그는 안 셉니다 — ③이 그걸 안 보기 때문입니다)');
    notes.push('     → 접는 순서: SKILL.md 「슬라이스를 언제 열고 언제 접나」');
  }
  if (sole.length) {
    notes.push(`이 슬라이스만 핀한 상위 문서 ${sole.length}건 — 그냥 접으면 ④가 아무 데서도 안 웁니다`);
    for (const [doc, g] of sole.slice(0, 5)) notes.push(`     ${g} → ${doc}`);
    if (sole.length > 5) notes.push(`     외 ${sole.length - 5}건`);
    notes.push('     → 접기 전에 핀을 옮기세요(접는 순서 2번)');
  }
}

// ─────────────────────────────── 등기부(어댑터) ───────────────────────────────

function fencedBlocks(md, tag) {
  const out = [];
  for (const m of md.matchAll(/```json\s+([^\n`]+)\n([\s\S]*?)```/g)) {
    if (!tag || m[1].trim() === tag) { try { out.push(JSON.parse(m[2])); } catch { /* 블록 파싱 실패는 등기부 축소로만 취급 */ } }
  }
  return out;
}
const DOTTED = /^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)+$/;
function collectIds(node, prefixes, acc) {
  if (typeof node === 'string') {
    if (DOTTED.test(node) && (prefixes.length === 0 || prefixes.includes(node.split('.')[0]))) acc.add(node);
    return acc;
  }
  if (Array.isArray(node)) { for (const v of node) collectIds(v, prefixes, acc); return acc; }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'id' && typeof v === 'string') acc.add(v);
      collectIds(v, prefixes, acc);
    }
  }
  return acc;
}

function buildRegistry() {
  const reg = new Set();
  const adapter = P.upstream.docsAdapter ?? 'generic';
  const ar = P.upstream.anchorRegistry ?? {};
  const prefixes = Array.isArray(ar.idPrefixes) ? ar.idPrefixes : [];
  const docs = allFiles.filter((f) => upstreamMatcher(f) && f.endsWith('.md'));
  for (const doc of docs) {
    const text = readText(doc);
    if (adapter === 'easyproduct') {
      const fm = parseFrontmatter(text);
      const tagField = ar.blockTagField ?? 'machine.tag';
      const tag = tagField.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), fm);
      for (const block of fencedBlocks(text, typeof tag === 'string' ? tag : null)) collectIds(block, prefixes, reg);
    } else {
      if (ar.genericIdPattern) for (const m of text.matchAll(new RegExp(ar.genericIdPattern, 'g'))) reg.add(m[0]);
      for (const m of text.matchAll(/^#{2,6}\s+(.+)$/gm)) reg.add(m[1].trim());
    }
  }
  return reg;
}

// ─────────────────────────────── ⑤ 근거 ───────────────────────────────

// 참조 패턴. 토큰 경계 가드 `(?![A-Za-z0-9_-])`가 **필수**다 — 없으면 `FEAT.billing.*`에서
// 백트래킹으로 `FEAT.billin`이 매칭된다. 세그먼트 문자 클래스에 `.`을 넣지 않는 것도 같은 이유다
// (넣으면 `FEAT.billing.`을 삼키고, 후행점을 잘라 **존재하지 않는 `FEAT.billing`**을 만든다).
//
// **와일드카드 가드는 패턴 안에 두지 않는다(중요).** 예전엔 `(?!\.\*)`를 붙였는데, **마디가 넷 이상이면
// 되짚기로 뚫린다** — `BEITF.user.law.*`에서 가드가 실패하면 한 마디 물러나 `BEITF.user`로 다시 맞고,
// 그 자리는 뒤에 `.law`가 오므로 **두 가드를 모두 통과한다.** 그래서 **아무도 적은 적 없는 이름**이
// 죽은 링크로 떴다(`죽은 링크: BEITF.user`). 마디 셋(`POL.a.b.*`)은 안 뚫려서, 정책 계열은 멀쩡한데
// 계약·화면 계열만 유령이 뜨는 비대칭까지 있었다 — 한쪽만 보면 "우리 문서가 이상한가"로 읽힌다.
// **매치한 뒤 뒤따르는 두 글자를 보고 버린다**(아래 `isSeriesRef`). 되짚기가 닿지 않는 자리다.
// 매치 **뒤**에서 계열 표기(`…*`)를 가른다. 패턴 안의 전방탐색은 되짚기로 뚫리지만 여기는 안 뚫린다.
function isSeriesRef(text, end) { return text.slice(end, end + 2) === '.*'; }

function refPattern() {
  if (P.specRefs.refPattern) return new RegExp(P.specRefs.refPattern, 'g');
  const prefixes = P.upstream.anchorRegistry?.idPrefixes ?? [];
  if (prefixes.length) {
    return new RegExp(`\\b(?:${prefixes.map(escapeRe).join('|')})(?:\\.[A-Za-z0-9_-]+)+(?![A-Za-z0-9_-])`, 'g');
  }
  if (P.upstream.anchorRegistry?.genericIdPattern) return new RegExp(P.upstream.anchorRegistry.genericIdPattern, 'g');
  return null;
}

// **등기부에 없는 접두사** 감지. 이 하네스의 가장 조용한 사각이다 — `idPrefixes`에 없는 접두사는
// refPattern이 아예 안 만들어서, 그런 참조는 **죽은 링크로도 안 잡히고 근거로도 안 세어진다.**
// 상위 문서 세트가 새 네임스페이스를 얻으면(예: easyproduct 0.8.0의 `IO`) 프로젝트가 정책을 고칠 때까지
// **검사받던 참조가 검사 안 받는 참조로 조용히 바뀐다**(실제 사고). 그래서 "참조처럼 생긴 것"을 따로 훑어
// 등록 안 된 접두사를 집계한다. 오탐이 있을 수 있으므로(상수·환경변수 표기) **위반이 아니라 보고**다.
const ANCHORISH = /\b([A-Z][A-Z0-9]{1,15})\.[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*(?![A-Za-z0-9_-])/g;

// **문서 파일 이름은 앵커가 아니다.** `ROADMAP.md`·`CLAUDE.md`가 `접두사 ROADMAP + 마디 md`로 읽혀
// "등기부에 없는 접두사"로 보고됐다(실사용: 한 트리에서 `ROADMAP.md` 28곳·`CLAUDE.md` 14곳).
// **등기부에 넣는 것으로는 안 풀린다** — 파일 이름이라 넣으면 이번엔 **죽은 링크로 잡힌다.**
const DOC_EXTS = new Set(['md', 'markdown', 'txt', 'json', 'jsonc', 'yml', 'yaml', 'toml', 'ini', 'cfg',
  'html', 'htm', 'csv', 'tsv', 'xml', 'pdf', 'png', 'jpg', 'jpeg', 'svg', 'webp',
  'lock', 'sh', 'py', 'mjs', 'cjs', 'js', 'ts', 'tsx', 'jsx']);
const looksLikeFilename = (ref) => DOC_EXTS.has(ref.split('.').pop().toLowerCase());
function unregisteredPrefixes(texts, known) {
  const seen = new Map();
  const knownSet = new Set(known);
  for (const t of texts) for (const m of t.matchAll(ANCHORISH)) {
    const pfx = m[1];
    if (knownSet.has(pfx)) continue;
    if (looksLikeFilename(m[0])) continue;   // `ROADMAP.md` 는 파일 이름이지 앵커가 아니다
    seen.set(pfx, (seen.get(pfx) || 0) + 1);
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]);
}

// 건너뛴 와일드카드 참조를 **세어서 리포트에 드러낸다**(무엇을 안 봤는지 숨기지 않는다).
function wildcardPattern() {
  const prefixes = P.upstream.anchorRegistry?.idPrefixes ?? [];
  if (!prefixes.length) return null;
  return new RegExp(`\\b(?:${prefixes.map(escapeRe).join('|')})(?:\\.[A-Za-z0-9_-]+)*\\.\\*`, 'g');
}

// "요구 1건"의 단위. **spec-kit 기본은 `frId`**다 — spec-template.md가 찍는 헤딩
// (`### User Story N` · `### Edge Cases` · `### Key Entities`)은 요구가 아니라 **골격**이라,
// 헤딩을 요구로 보면 spec-kit 전용 스킬이 spec-kit 자기 템플릿에 걸려 운다(실전 오탐 52건).
// 실제 요구 단위는 `**FR-001**`·`**SC-001**`이다.
function requirementUnits(text, unit) {
  if (unit === 'frId') {
    const idRe = new RegExp(P.specRefs.frIdPattern ?? '(?:FR|SC)-[0-9]+');
    const units = [];
    let cur = null;
    for (const line of text.split('\n')) {
      const m = idRe.exec(line);
      if (m) { if (cur) units.push(cur); cur = { title: m[0], body: line + '\n' }; }
      else if (cur) {
        if (line.trim() === '' || /^#{1,6}\s/.test(line)) { units.push(cur); cur = null; }
        else cur.body += line + '\n';                      // 이어지는 줄(들여쓴 설명)까지 한 요구로
      }
    }
    if (cur) units.push(cur);
    return units;
  }
  if (unit === 'listItem') {
    return text.split('\n').filter((l) => /^\s{0,3}[-*]\s+\S/.test(l)).map((l) => ({ title: l.trim().slice(0, 80), body: l }));
  }
  const units = [];
  const lines = text.split('\n');
  let cur = null;
  for (const line of lines) {
    const h = /^(#{3,6})\s+(.+)$/.exec(line);
    if (h) { if (cur) units.push(cur); cur = { title: h[2].trim(), body: '' }; }
    else if (cur) cur.body += line + '\n';
  }
  if (cur) units.push(cur);
  return units.filter((u) => u.body.trim() !== '');
}

if (opts.mode === 'changed') {
  skipped.push('⑤⑦ → --changed(훅)에서는 스킵(diff 단위 규칙)');
} else if (sev('specRefs') === 'off') {
  skipped.push('⑤ 근거 → severity off');
} else {
  const registry = buildRegistry();
  const rp = refPattern();
  const wp = wildcardPattern();
  let wildcardSkipped = 0;
  if (registry.size === 0 || !rp) {
    skipped.push(`⑤ 근거 → 상위 등기부를 만들 수 없음(adapter=${P.upstream.docsAdapter}, 앵커 ${registry.size}개)`);
  } else {
    for (const slug of scopedSlugs) {
      for (const file of (P.specRefs.scanFiles ?? ['spec.md', 'plan.md'])) {
        const path = `${P.specsDir}/${slug}/${file}`;
        if (!existsSync(join(ROOT, path))) continue;
        const text = readText(path);
        if (wp) wildcardSkipped += [...text.matchAll(wp)].length;
        for (const m of text.matchAll(rp)) {
          if (isSeriesRef(text, m.index + m[0].length)) continue;   // 계열 표기 — 참조가 아니다
          const ref = m[0];
          if (!registry.has(ref)) {
            violate('specRefs', slug, `죽은 링크: ${ref} (상위 문서 등기부에 없음) — ${file}`,
              '상위 문서에서 실제 ID를 확인하거나, 그 결정을 상위 문서에 먼저 추가하라');
          }
        }
        if ((P.specRefs.orphanRequirement ?? 'off') !== 'off') {
          for (const u of requirementUnits(text, P.specRefs.requirementUnit ?? 'frId')) {
            rp.lastIndex = 0;
            if (!rp.test(`${u.title}\n${u.body}`)) {
              violate('specRefs', slug, `근거 없는 요구: "${u.title}" — ${file}`,
                '이 결정을 상위 문서로 이관하고 그 앵커를 참조하라(spec이 결정을 발명하지 않는다)',
                { severity: P.mode === 'warn' ? 'warn' : P.specRefs.orphanRequirement });
            }
          }
        }
      }
    }
  }
  if (wildcardSkipped > 0) {
    skipped.push(`⑤ 와일드카드 참조 ${wildcardSkipped}건 건너뜀(\`FEAT.x.*\` 같은 계열 표기 — 특정 ID가 아니라 대조 대상 아님)`);
  }
  // 등기부에 없는 접두사 — 위반이 아니라 **보고**다(오탐 여지가 있고, 판단은 사람 몫).
  const prefixes = P.upstream.anchorRegistry?.idPrefixes ?? [];
  if (prefixes.length) {
    const texts = [];
    for (const slug of scopedSlugs) {
      for (const file of (P.specRefs.scanFiles ?? ['spec.md', 'plan.md'])) {
        const path = `${P.specsDir}/${slug}/${file}`;
        if (existsSync(join(ROOT, path))) texts.push(readText(path));
      }
    }
    const unreg = unregisteredPrefixes(texts, prefixes);
    if (unreg.length) {
      notes.push(`⑤ 등기부에 없는 접두사 참조: ${unreg.slice(0, 6).map(([p2, n]) => `${p2}(${n}건)`).join(' · ')}`
        + (unreg.length > 6 ? ` 외 ${unreg.length - 6}종` : ''));
      notes.push('     → 상위 문서 세트가 새 네임스페이스를 얻었을 수 있다. `upstreamDocs.anchorRegistry.idPrefixes`에 넣으면 검사받는다.');
      notes.push('     → 지금은 이 참조들이 **죽은 링크로도 안 잡히고 근거로도 안 세어진다**(검사 밖).');
    }
  }
}

// ─────────────────────────────── ⑦ 리뷰 기록 ───────────────────────────────

if (opts.mode !== 'changed' && sev('reviewRecord') !== 'off') {
  const watch = P.reviewRecord.requireOnChangeOf ?? ['spec.md', 'plan.md'];
  const touched = new Map();       // slug → 바뀐 파일들
  for (const f of changed) {
    if (!f.startsWith(`${P.specsDir}/`)) continue;
    // **슬러그는 specsDir 바로 다음 마디다.** `split('/')[1]`로 뽑으면 specsDir가 한 마디일 때만
    // 맞는데, 모노레포는 `backend/specs`처럼 두 마디 이상이 정상이다(references/monorepo.md 권장).
    // 그때 slug는 'specs'가 되고 rel이 '<slug>/spec.md'가 되어 **watch와 절대 안 맞는다** →
    // `continue` → **⑦이 통째로 안 돈다.**
    //
    // ③ 결합은 같은 함정을 이미 고쳤는데 ⑦은 안 고쳤다. **③은 "항상 운다"로 나타나 즉시 들켰고,
    // ⑦은 "영원히 안 운다"로 나타나 안 들켰다** — 같은 코드, 반대 증상(실측 제보).
    // ⚠ 대조 시험으로도 안 잡혔다: **두 구현이 같게 틀려서** 결과가 일치했다.
    const parts = f.slice(P.specsDir.length + 1).split('/');
    if (parts.length < 2) continue;
    const slug = parts[0];
    const rel = parts.slice(1).join('/');
    if (!watch.includes(rel)) continue;
    if (!touched.has(slug)) touched.set(slug, []);
    touched.get(slug).push(rel);
  }
  for (const [slug, files] of touched) {
    const recPath = (P.reviewRecord.path ?? `${P.specsDir}/<slug>/upstream-check.md`).replace('<slug>', slug);
    const pinPath = `${P.specsDir}/${slug}/${P.requiredPinFile}`;
    const recChanged = changedSet.has(recPath);
    const pinHasReview = existsSync(join(ROOT, pinPath)) && /"reviewedAt"/.test(readText(pinPath)) && changedSet.has(pinPath);
    if (!recChanged && !pinHasReview) {
      violate('reviewRecord', slug, `${files.join('·')}를 고쳤는데 상위 대조 기록이 갱신되지 않음`,
        `\`${P.reviewRecord.suggestedCommand ?? '/speckit.analyze'}\`를 돌리고 근거 앵커·확인 내용·checkedAt을 ${recPath}에 기록하라`);
      continue;
    }
    if (recChanged) {
      const text = readText(recPath);
      for (const field of (P.reviewRecord.fields ?? [])) {
        if (!text.includes(field)) violate('reviewRecord', slug, `기록에 ${field} 없음 — ${recPath}`, '템플릿의 필드를 채워라');
      }
    }
  }
}

// ─────────────────────────────── 보고 ───────────────────────────────

const counts = { block: 0, warn: 0 };
for (const v of violations) counts[v.severity] = (counts[v.severity] ?? 0) + 1;
const ok = counts.block === 0;

// 매니페스트 대조(easyproduct 어댑터일 때만). 위반이 아니라 **보고** — 정책을 사람이 고치게 한다.
{
  const gaps = manifestGaps();
  if (gaps === null) {
    // 어댑터가 generic이거나 매니페스트가 없다 — 대조할 근거가 없으므로 아무 말도 하지 않는다.
  } else if (gaps.size) {
    const total = [...gaps.values()].reduce((a, b) => a + b, 0);
    notes.push(`④⑥ 매니페스트에 있는데 upstreamDocs.globs가 안 덮는 상위 문서 ${total}건`
      + ` (${[...gaps.entries()].map(([k, v]) => `${k} ${v}`).join(' · ')})`);
    notes.push('     → 그 문서들은 상위 변경 감지(⑥)·신선도(④) 밖이다. globs에 그 폴더를 더하세요.');
  }
}

if (opts.json) {
  console.log(JSON.stringify({
    ok, mode: opts.mode, adapter: P.upstream.docsAdapter ?? 'generic',
    policyMode: P.mode, skipped, notes, violations, counts,
  }, null, 2));
} else {
  const RULE_LABEL = {
    provenance: '① 출처', completeness: '② 완결', coupling: '③ 결합',
    freshness: '④ 신선도', reverseCoupling: '⑥ 역결합', specRefs: '⑤ 근거',
    reviewRecord: '⑦ 리뷰 기록', unmatchedNewFile: '관장 사각',
  };
  console.log(`SDD 하네스 검사 (${opts.mode === 'full' ? '--full' : '--changed'})`);
  console.log(`  adapter: ${P.upstream.docsAdapter ?? 'generic'} · impactUnit: ${P.pins.impactUnit ?? 'file'} · 관장 ${governed.length}개 · slug ${scopedSlugs.length}개(태그 ${usedSlugs.size}개)`);
  if (P.mode === 'warn') console.log('  mode: warn (브라운필드) — 모든 위반을 경고로 보고하고 종료코드 0');
  for (const s of skipped) console.log(`  skipped: ${s}`);
  for (const n of notes) console.log(`  ${n.startsWith(' ') ? n : `note: ${n}`}`);
  console.log('');
  for (const v of violations) {
    console.log(`${v.severity === 'block' ? '✗' : '⚠'} [${RULE_LABEL[v.rule] ?? v.rule}] ${v.target}`);
    console.log(`    ${v.message}`);
    if (v.action) console.log(`    → ${v.action}`);
  }
  if (violations.length === 0) console.log('위반 없음.');
  console.log(`\n요약: block ${counts.block ?? 0} · warn ${counts.warn ?? 0} → ${ok ? '통과' : '실패'}`);
  if (!ok) console.log('기계 통과 ≠ 검증 완료 — 이 검사는 의례·공존만 본다(의미 정합은 리뷰 몫).');
}

// 종료코드.
//  --full   : 0 통과(경고 있어도) · 1 block 위반          — 완료 게이트/CI가 읽는 값
//  --changed: 0 통과 · **2 위반**                          — 훅이 에이전트에 주입하려면 2여야 한다
//             (호스트 규약: PostToolUse는 exit 2일 때만 stderr를 에이전트 컨텍스트에 넣는다)
//             warn만 있을 때 주입할지는 `hooks.injectOnWarn`(기본 true)이 정한다.
if (opts.mode === 'changed') {
  const injectOnWarn = P.hooks.injectOnWarn !== false;
  const shouldInject = counts.block > 0 || (injectOnWarn && counts.warn > 0);
  if (shouldInject && !opts.json) {
    console.error('\n위 위반을 먼저 정리하라 — SDD 게이트(훅 층). 계속 진행하면 verify·CI에서 다시 막힌다.');
  }
  process.exit(shouldInject ? 2 : 0);
}
process.exit(ok ? 0 : 1);
