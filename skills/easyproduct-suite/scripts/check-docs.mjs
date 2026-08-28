#!/usr/bin/env node
// easyproduct 문서 세트 점검기 (무의존 참조 구현)
// 규약: easyproduct-suite/references/checker-guide.md
//
// 이 스크립트는 easyproduct-suite 스킬의 자산이다(스킬 설치 시 함께 깔린다).
// suite 스킬이 문서 세트를 점검할 때(Stage 4) 직접 실행한다. 프로젝트 폴더로 복사되지는 않는다.
// (사용자가 소스를 원하면 suite가 이 파일을 보여주거나 내려준다.)
//
// 사용법:  node <이 파일 경로> <문서세트-루트> [--print-snapshot]
//   - <루트>/00-index.md 의 docbundle.docs 매니페스트가 있으면 그걸로 문서를 발견
//   - 없으면 <루트> 아래 *.md 를 훑는다
//   - 어느 쪽이든, 문서 frontmatter의 machine.includes 로 선언된 부분 파일은 반드시 따라간다
//     (파일이 분리돼 있고 세트 폴더 밖에 있어도 놓치지 않는다. 같은 파일은 실제 경로로 1회만 처리)
// 하는 일: frontmatter 확인 → 기계 블록을 machine.schema 로 검증 →
//          접두사 라우팅으로 크로스도큐먼트 참조 무결성(죽은 링크) 점검
// 종료코드: 문제(경로누락·frontmatter불일치·스키마위반·죽은링크) 있으면 1, 없으면 0

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// 이 점검기·생성기가 속한 **세트 버전**. 생성물(`interface-request`)에 찍혀 나가고, 그 값이 이 값과
// 다르면 "생성기가 그 뒤 자랐다 — 다시 뽑으세요"를 알린다. 요청서는 화면 + 생성기 로직의 함수인데
// 신선도 검사는 화면만 보기 때문이다(실제 사고: 일회성 결과를 실어 나르게 고쳤는데 옛 요청서는
// 그 열이 빈 채 남았고 점검기는 통과라고 답했다).
// **손으로 고치지 않는다** — skill-lint 가 suite SKILL.md 의 버전과 대조해 어긋나면 베타 머지를 막는다.
const TOOL_VERSION = '0.12.6';

// ── frontmatter 파서 (이 세트의 통제된 형식 전용: 최상위 key:value + 1단계 machine 중첩) ──
function parseFrontmatter(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return null;
  const top = {}; let parent = null;
  for (const rawLine of m[1].split(/\r?\n/)) {
    const line = stripComment(rawLine);
    if (!line.trim()) continue;
    let mm;
    if ((mm = line.match(/^([a-zA-Z_][\w-]*):\s*(.*)$/))) {           // 최상위
      const [, k, v] = mm;
      if (v === '') { top[k] = {}; parent = k; } else { top[k] = scalarOrList(v); parent = null; }
    } else if (parent && (mm = line.match(/^\s+([a-zA-Z_][\w-]*):\s*(.*)$/))) { // 중첩
      top[parent][mm[1]] = scalarOrList(mm[2]);
    }
  }
  return top;
}
const unquote = (s) => s.trim().replace(/^["']|["']$/g, '');

// 줄 끝 주석(` #...`)을 떼되, 따옴표 안의 #는 값으로 본다(경로에 #가 있으면 따옴표로 감싼다).
function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; }
    else if (c === '"' || c === "'") q = c;
    else if (c === '#' && i > 0 && /\s/.test(s[i - 1])) return s.slice(0, i);
  }
  return s;
}

// 인라인 플로우 시퀀스 `[a, b]`는 배열로(예: machine.includes). 그 외는 스칼라.
// 항목 구분은 쉼표뿐이라 공백이 든 경로는 그대로 쓸 수 있다.
// 경로에 쉼표(또는 #)가 있으면 따옴표로 감싼다: ["./a, b.md"]
function scalarOrList(v) {
  const t = v.trim();
  if (!/^\[.*\]$/.test(t)) return unquote(t);
  const inner = t.slice(1, -1);
  const out = []; let cur = '', q = null;
  for (const c of inner) {
    if (q) { if (c === q) q = null; else cur += c; }
    else if (c === '"' || c === "'") q = c;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim()).filter(Boolean);
}

// ── JSON Schema 검증기 (이 세트 스키마가 쓰는 부분집합) ──
// 정규식을 사람이 읽을 수 있는 한 줄로 바꾼다. 흔한 anchor 꼴은 **마디 수까지** 밝힌다 —
// "패턴 위반"만으로는 `FEAT.a.b.c`가 왜 안 되는지 알 수 없다.
function patternHint(pat) {
  // 패턴을 마디로 갈라 **실제 형식**을 보여준다. 마디에는 두 갈래가 있다 —
  // 리터럴(`BEARCH.mod.*`의 `mod`처럼 그 글자 그대로)과 자리(문자 클래스). 이걸 뭉뚱그려
  // `<이름>`으로만 안내하면 **그대로 따라 해도 또 틀린다**(도그푸드에서 실제로 그랬다).
  const body = pat.replace(/^\^/, '').replace(/\$$/, '');
  if (!body.includes('\\.')) return `정규식 \`${pat}\`에 맞는 값`;
  const NAMES = { FEAT: '기능', DATA: '데이터 그룹', POL: '정책 규칙', UI: 'UI 컴포넌트', SCN: '시나리오',
                  IO: '화면 동작', FRAME: '공통 프레임', BEITF: '인터페이스', BESTORE: '저장소',
                  BESCHEMA: '논리 테이블', BEARCH: '시스템 조각' };
  const parts = body.split('\\.');
  // 갈라진 마디가 전부 리터럴이거나 단순 자리여야 안내가 정확하다. 아니면 정규식을 그대로 보여준다.
  const shown = [];
  for (const seg of parts) {
    if (/^[A-Za-z][A-Za-z0-9]*$/.test(seg)) shown.push(seg);                 // 리터럴 마디
    else if (/^\[[^\]]+\]/.test(seg)) shown.push('<이름>');                   // 자리 마디
    else return `정규식 \`${pat}\`에 맞는 값`;                                // 모르는 꼴은 지어내지 않는다
  }
  const what = NAMES[parts[0]] ? `${NAMES[parts[0]]} id` : 'id';
  return `\`${shown.join('.')}\` 꼴의 ${what}`;
}

// `root`는 `$ref` 해석의 기준이다(스키마 최상위). 재귀할 때 함께 넘긴다.
function validate(obj, schema, p, errs, root) {
  root = root || schema;
  // **`$ref` 지원.** 없으면 `$ref`만 든 스키마가 `type`도 `required`도 없는 **빈 스키마**로 취급돼
  // 그 안이 통째로 무검사가 된다(0.10.0의 프레임 io가 실제로 그랬다 — `{"엉터리":1}`이 통과했다).
  // 우리 스키마가 쓰는 것은 문서 내부 포인터(`#/$defs/...`)뿐이라 그만 푼다.
  if (schema.$ref) {
    const target = String(schema.$ref).replace(/^#\//, '').split('/')
      .reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), root);
    if (!target) { errs.push(`${p} — 풀 수 없는 $ref: ${schema.$ref}`); return; }
    return validate(obj, target, p, errs, root);
  }
  if (schema.const !== undefined && obj !== schema.const) errs.push(`${p} = ${JSON.stringify(obj)} (const ${JSON.stringify(schema.const)} 아님)`);
  if (schema.enum && !schema.enum.includes(obj)) errs.push(`${p} = ${JSON.stringify(obj)} (허용값 ${schema.enum.join('|')} 아님)`);
  if (schema.type && !typeOk(obj, schema.type)) { errs.push(`${p} 타입 ${schema.type} 아님`); return; }
  // **무엇을 어겼는지 말해 준다.** "패턴 위반"만 내면 규칙을 모르는 사람은 고칠 수가 없다
  // (도그푸드에서 `FEAT.a.b.c`가 거절됐는데 마디가 몇 개여야 하는지 알 길이 없었다).
  if (schema.pattern && typeof obj === 'string' && !new RegExp(schema.pattern).test(obj)) {
    errs.push(`${p} = "${obj}" (형식이 다릅니다 — 이 값은 ${patternHint(schema.pattern)} 이어야 합니다)`);
  }
  if (schema.type === 'array' && Array.isArray(obj)) {
    if (schema.minItems != null && obj.length < schema.minItems) errs.push(`${p} 항목 ${obj.length} < 최소 ${schema.minItems}`);
    if (schema.items) obj.forEach((it, i) => validate(it, schema.items, `${p}[${i}]`, errs, root));
  }
  if (schema.type === 'object' || schema.properties || schema.required) {
    const o = obj && typeof obj === 'object' ? obj : {};
    if (schema.required) for (const r of schema.required) if (!(r in o)) errs.push(`${p}.${r} 누락`);
    if (schema.minProperties != null && Object.keys(o).length < schema.minProperties) errs.push(`${p} 속성 ${Object.keys(o).length} < 최소 ${schema.minProperties}`);
    for (const [k, s] of Object.entries(schema.properties || {})) if (k in o) validate(o[k], s, `${p}.${k}`, errs, root);
    // **`additionalProperties: false` = 모르는 키 금지.** 옛 코드는 `additionalProperties`가 **객체**일 때만
    // (= 나머지 키를 그 규격으로 검사) 다뤘고, `false`는 falsy라 분기가 통째로 건너뛰어졌다.
    // 그래서 키를 한 글자 틀려도(`exclude`/`except`) **조용히 아무 일도 안 일어났다** — 스키마가 명시적으로
    // 잠근 자리인데 검사 층이 비어 있었다(실측: `appliesTo`가 무효인 채 통과해 로그인 화면이 껍데기에 남았다).
    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys(schema.properties || {}));
      for (const k of Object.keys(o)) {
        if (!known.has(k)) errs.push(`${p}.${k} — 스키마에 없는 키(오타인지 확인: ${[...known].slice(0, 6).join(' · ')}${known.size > 6 ? ' …' : ''})`);
      }
    } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      const known = new Set(Object.keys(schema.properties || {}));
      for (const [k, v] of Object.entries(o)) if (!known.has(k)) validate(v, schema.additionalProperties, `${p}.${k}`, errs, root);
    }
  }
}
function typeOk(v, t) {
  if (t === 'array') return Array.isArray(v);
  if (t === 'object') return v && typeof v === 'object' && !Array.isArray(v);
  if (t === 'string') return typeof v === 'string';
  if (t === 'number' || t === 'integer') return typeof v === 'number';
  if (t === 'boolean') return typeof v === 'boolean';
  return true;
}

// ── 기계 블록 추출 (info-string 2번째 토큰 === tag) ──
function extractBlocks(md, tag) {
  return [...md.matchAll(/```json\s+([^\n`]+)\n([\s\S]*?)```/g)]
    .filter(x => x[1].trim() === tag)
    .map(x => { try { return JSON.parse(x[2]); } catch (e) { return { __parseError: e.message }; } });
}

// ── 스키마 사본 일치성 ──
// 문서 옆 schemas/*.json 은 스킬이 소유한 자산의 '사본'이라 스킬 쪽과 같아야 한다.
// 다르면 둘 중 하나가 뒤처진 것인데, **어느 쪽인지는 알 수 없다** — 문서를 옛 스킬로 만들었을 수도,
// 반대로 스킬을 업그레이드하지 않아 스킬 쪽이 옛것일 수도 있다. 그래서 방향을 단정하지 않고
// "다르다"까지만 보고하고 판단은 사람에게 맡긴다.
// 이 검사가 필요한 이유: 사본이 뒤처지면 그 낡은 계약으로 검증하게 되어 위반을 못 잡는다(조용한 통과).
// 스킬 자산은 이 스크립트 기준 <skills>/easyproduct-*/schemas/<같은 파일명>에 있다.
const SKILLS_ROOT = path.resolve(new URL('.', import.meta.url).pathname, '../..');
const canonicalCache = new Map();
const schemaCopyUnchecked = new Set();  // 스킬 자산을 못 찾아 사본 일치를 못 본 스키마들
const versionDrift = [];  // frontmatter version이 스키마 계약 버전과 다름(문서 수정 카운터로 오해한 흔적)
function canonicalSchemaPath(basename) {
  if (canonicalCache.has(basename)) return canonicalCache.get(basename);
  let hit = null;
  try {
    for (const skill of fs.readdirSync(SKILLS_ROOT)) {
      const p = path.join(SKILLS_ROOT, skill, 'schemas', basename);
      if (fs.existsSync(p)) { hit = p; break; }
    }
  } catch { /* 스킬 트리를 못 찾으면 검사 생략 */ }
  canonicalCache.set(basename, hit);
  return hit;
}
// 스키마 위반 메시지에 곁들이는 힌트. **규칙을 다시 적지 않고 "무엇을 쓰면 되는지"만** 한 줄로 말한다
// — 위반 문구는 어디가 틀렸는지는 알려 주지만 무엇이 맞는지는 안 알려 주기 때문이다.
const ERR_HINTS = [
  { when: /transientSends\[\d+\](?:\s|$)|transientSends\[\d+\] 타입/,
    say: '일회성 입력은 `{ "name": "keyword", "desc": "법령명·조문 검색어" }` 꼴이다(문자열 배열이 아니다).' },
  { when: /transientSends 항목 0 < 최소 1/,
    say: '없으면 `transientSends` 필드를 아예 두지 않는다(빈 배열은 "생각했는데 없다"와 구분이 안 된다).' },
  { when: /transientSends\[\d+\]\.desc 누락/,
    say: '`desc`는 필수다 — 등기부 대조를 안 받는 자리라, 뜻이 없으면 백엔드가 계약을 정할 근거가 없다.' },
];

const stable = (o) => JSON.stringify(sortDeep(o));   // 서식·키 순서 차이는 무시하고 내용만 비교
function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortDeep(v[k]);
    return out;
  }
  return v;
}

// ── 옛 계약 흔적 탐지 (※ 한시적 — 0.5.0 이행용) ──
// 0.5.0에서 data-model.v1의 필드 구성을 제자리에서 바꿨다(source→filledBy, usedIn 제거).
// 그 전에 만들어진 문서를 알아보려는 것이고, frontmatter의 version으로는 구분되지 않으므로
// (계약을 제자리에서 다듬었다) 형태로 판별한다.
//
// **이 검사는 이번 이행이 끝나면 필요 없다.** 배포 초기라 옛 형식 문서가 거의 없으므로,
// 다음 업그레이드 때 삭제 여부를 사용자에게 컨펌받고 뺀다.
//
// **data-model 문서에만 적용한다.** `source`·`usedIn`은 흔한 낱말이라 다른 문서 타입이 나중에
// 그 이름을 정당하게 쓸 수 있다 — 전역으로 잡으면 그때 거짓 경보가 된다.
const LEGACY_DOC_TYPE = 'data-model';
const LEGACY_KEYS = ['source', 'usedIn'];
function legacyKeysOf(docType, blocks) {
  if (docType !== LEGACY_DOC_TYPE) return [];
  const found = new Set();
  for (const o of blocks) {
    if (!o || o.__parseError || !Array.isArray(o.fields)) continue;
    for (const f of o.fields) for (const k of LEGACY_KEYS) if (k in f) found.add(k);
  }
  return [...found];
}

// ── 문서 발견 ──
function discover(root) {
  const idxPath = path.join(root, '00-index.md');
  if (fs.existsSync(idxPath)) {
    const man = extractBlocks(fs.readFileSync(idxPath, 'utf8'), 'docbundle.docs')[0];
    if (man && Array.isArray(man.docs)) return { via: 'manifest', docs: man.docs };
  }
  const docs = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'schemas') continue;
      const fp = path.join(d, e.name);
      if (e.isDirectory()) walk(fp);
      else if (e.name.endsWith('.md')) docs.push({ path: path.relative(root, fp).replace(/\\/g, '/') });
    }
  })(root);
  return { via: 'scan', docs };
}

// ── 벤더 설치 ─────────────────────────────────────────────────────────────
// **폴더 구조를 그대로 미러한다.** 점검기가 자기 위치 기준(`../..`)으로 자산·스키마를 찾기 때문에,
// 평평하게 두면 파장 지도와 스키마 사본 대조가 **조용히 생략된다**(경고 없이 검사가 사라진다).
function installKit(dest) {
  const SUITE = path.join(SKILLS_ROOT, 'easyproduct-suite');
  if (!fs.existsSync(SUITE)) {
    console.error('❌ 스킬 트리를 찾을 수 없습니다 — 설치는 스킬이 깔린 곳에서 실행해야 합니다.');
    process.exit(2);
  }
  const prev = (() => { try { return fs.readFileSync(path.join(dest, 'VERSION'), 'utf8').trim(); } catch { return null; } })();
  const written = [];
  const put = (from, to) => {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const changed = !fs.existsSync(to) || fs.readFileSync(to).compare(fs.readFileSync(from)) !== 0;
    fs.copyFileSync(from, to);
    written.push({ rel: path.relative(dest, to), changed });
  };

  // ① 점검기 ② 자산(파장 지도·앵커 등기부) ③ 계약 정본
  put(path.join(SUITE, 'scripts', 'check-docs.mjs'), path.join(dest, 'easyproduct-suite', 'scripts', 'check-docs.mjs'));
  for (const f of ['propagation-map.json', 'anchor-prefixes.json']) {
    const src = path.join(SUITE, 'assets', f);
    if (fs.existsSync(src)) put(src, path.join(dest, 'easyproduct-suite', 'assets', f));
  }
  const guide = path.join(SUITE, 'references', 'checker-guide.md');
  if (fs.existsSync(guide)) put(guide, path.join(dest, 'easyproduct-suite', 'references', 'checker-guide.md'));

  // ④ **스키마 전부.** 이게 없으면 "사본이 스킬 자산과 다름" 대조가 통째로 생략돼,
  //    문서 옆 사본이 뒤처져도 아무도 모른다(실측에서 계약 위반 3건이 그렇게 가려졌다).
  let schemaCount = 0;
  for (const skill of fs.readdirSync(SKILLS_ROOT)) {
    const dir = path.join(SKILLS_ROOT, skill, 'schemas');
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      put(path.join(dir, f), path.join(dest, skill, 'schemas', f));
      schemaCount++;
    }
  }

  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'VERSION'), TOOL_VERSION + '\n');
  const changed = written.filter((w) => w.changed);

  console.log(prev === null
    ? `✅ 점검기 설치 — ${dest} (버전 ${TOOL_VERSION})`
    : prev === TOOL_VERSION
      ? `✅ 이미 최신입니다 — ${dest} (버전 ${TOOL_VERSION})`
      : `✅ 점검기 갱신 — ${dest} (${prev} → ${TOOL_VERSION})`);
  console.log(`   점검기 1 · 자산·계약서 ${written.length - schemaCount - 1} · 스키마 ${schemaCount} · 바뀐 파일 ${changed.length}`);
  if (changed.length && prev !== null) {
    for (const w of changed.slice(0, 8)) console.log(`     · ${w.rel}`);
    if (changed.length > 8) console.log(`     · 외 ${changed.length - 8}개`);
  }
  console.log('');
  console.log('   쓰는 법:  node ' + path.join(path.relative(process.cwd(), dest) || '.', 'easyproduct-suite/scripts/check-docs.mjs') + ' <문서루트>');
  console.log('   ⚠ **파일을 손으로 고치지 마세요** — 다음 갱신 때 사라지고, 그 사이 이곳만 다른 검사를 돌게 됩니다.');
  console.log('   ⚠ **문서 옆 `schemas/*.json` 도 함께 갱신하세요** — 안 하면 새 검사가 조용히 안 돕니다.');
}

// ── 메인 ──
const args = process.argv.slice(2);
const printSnapshot = args.includes('--print-snapshot');
const emitNeeds = args.includes('--emit-needs');
const emitReq = args.includes('--emit-interface-request');
// 목록을 5건에서 자르면 **작업 목록을 만들 수가 없다** — 실사용에서 검사기와 같은 판정을 다시 구현했다는
// 보고가 있었다. 기본 출력은 짧게 두되(리포트가 읽히려면 짧아야 한다) 전부 보는 문을 연다.
const verbose = args.includes('--verbose');
const CAP = (n) => (verbose ? n : 5);
const argVal = (name, dflt = null) => { const i = args.indexOf(name); return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt; };
const reqTransport = argVal('--transport');
const reqScope = argVal('--scope');
const reqDomain = argVal('--domain');
const listDomains = args.includes('--list-domains');
// 점검기를 **대상 프로젝트에 설치**한다(벤더 사본). CI·다른 개발자 기계에는 스킬이 없으므로,
// 이 도구가 **스스로를 복사**한다 — 사람이나 에이전트가 파일을 빠뜨릴 여지를 없앤다
// (실측: 손으로 복사한 사본에 `references/`가 통째로 빠져 있었고, 버전이 세 판 뒤처져 새 검사가
// 한 건도 안 돌았으며, 옛 스키마 사본이 계약의 실제 위반 3건을 가리고 있었다).
const installTo = argVal('--install');
// 항목 단위 개정. **사람이 적게 하면 빈다** — 실측: 계약 130건 중 117건(90%)이 근거를 한 줄만 적었고,
// 그걸 근거로 만든 검사의 "미해결 9건"이 전부 오탐이었다. 그래서 **스크립트가 계산하고 사람은 올리기만** 한다.
const syncRev = args.includes('--sync-revisions');
const checkRev = args.includes('--check-revisions');
// 설치는 **문서 세트가 없어도** 동작한다(빈 저장소에 먼저 깔 수 있어야 한다).
if (installTo) { installKit(installTo); process.exit(0); }

const root = args.find(a => !a.startsWith('--'));
if (!root) {
  console.error('사용법: node check-docs.mjs <문서세트-루트> [--print-snapshot]');
  console.error('  --verbose        : 목록을 자르지 않고 **전부** 출력(기본은 5건까지)');
  console.error('  --print-snapshot : 리뷰 산출물의 sources에 붙일 (revision·contentHash) 스냅샷을 출력');
  console.error('  --emit-needs     : 화면 동작에서 **서버 요구 목록**을 기계 판독 JSON으로 추출(백엔드 설계의 입력)');
  console.error('  --emit-interface-request --scope <범위> --domain <도메인> [--transport rest|grpc|graphql|ws|queue]');
  console.error('                     : 프론트가 백엔드에 넘길 **인터페이스 요청서(md)**를 생성해 stdout으로 출력');
  console.error('                       요청서는 **출처 화면 문서 1개당 1개**다(범위·도메인별로 갈린다).');
  console.error('  --install <경로>   : 점검기·자산·스키마를 그 폴더에 설치(벤더 사본). 다시 돌리면 갱신된다');
  console.error('  --sync-revisions  : 인터페이스마다 개정 번호를 계산해 interface-revisions.json 에 기록(파일을 쓴다)');
  console.error('  --check-revisions : 기록된 개정 번호가 지금 계약과 맞는지 **대조만** 한다(CI용, 어긋나면 1)');
  console.error('  --emit-interface-request --scope <범위> --list-domains');
  console.error('                     : 그 범위에서 요청서를 뽑을 도메인 목록을 출력(호출 측이 돌면서 뽑는다)');
  process.exit(2);
}

const problems = [];
// --emit-needs 는 stdout이 **기계 판독 JSON 전용**이어야 하므로 사람용 리포트를 stderr로 보낸다
// (파이프로 받아 쓰는 쪽이 파싱에 실패하지 않게).
const report = (m) => (emitNeeds || emitReq ? console.error(m) : console.log(m));
const { via, docs } = discover(root);
report(`문서 발견: ${docs.length}개 (${via === 'manifest' ? '매니페스트' : '폴더 스캔'})`);

// 매니페스트로 발견했으면 **폴더와 대조**한다. 색인이 낡아 새 문서가 빠져 있으면 그 문서들은
// 스키마 검증·참조 점검·파장 전부에서 통째로 빠지는데, 알려주지 않으면 "통과"로 읽힌다(조용한 통과).
// 색인은 파생 스냅샷이라 낡는 게 정상이므로, 오류가 아니라 "재생성 필요"로 보고한다.
const unlisted = [];
if (via === 'manifest') {
  const listed = new Set(docs.map((d) => d.path));
  const SKIP_DIR = /(^|\/)(schemas|temp|node_modules|\.git)(\/|$)/;
  const walkMd = (dir, acc = []) => {
    for (const e of fs.readdirSync(path.join(root, dir || '.'), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (SKIP_DIR.test(rel)) continue;
      if (e.isDirectory()) walkMd(rel, acc);
      else if (e.name.endsWith('.md') && rel !== '00-index.md' && !listed.has(rel)) acc.push(rel);
    }
    return acc;
  };
  try { unlisted.push(...walkMd('')); } catch { /* 스캔 실패는 무시 */ }
  if (unlisted.length) {
    report(`  ⚠ 매니페스트에 없는 문서 ${unlisted.length}건 — **점검 대상에서 빠졌다**(색인 재생성 필요)`);
    report(`     ${unlisted.slice(0, CAP(unlisted.length)).join(', ')}${!verbose && unlisted.length > 5 ? ` 외 ${unlisted.length - 5}건 (--verbose로 전부)` : ''}`);
    report('     → 색인(00-index.md)을 다시 만들면 편입된다. `machine.includes`로 딸린 부분 파일은 자동 추적되므로 여기 안 나온다.');
  }
}

// 레지스트리(anchor 등기부)
const reg = { feat: new Set(), screen: new Set(), group: new Map(), pol: new Set(), ui: new Set(), scn: new Set(), token: new Set(), frame: new Set() };
const groupOrigin = new Map(); // group -> 그 그룹을 정의한 문서 경로(중복 정의 적발용)
const featOrigin = new Map();  // FEAT id -> 정의 문서(범위별로 나눈 IA에서 중복 적발용)
const featAudience = [];       // {id, audience, doc} — 파일과 대상이 어긋났나 보기 위한 것
const loaded = []; // {docType, path, md, fm, blocks:[{tag,obj}]} — 기계 블록이 있는 문서만
const allDocs = []; // {docType, path, revision} — 기계 블록 유무와 무관한 전체(파장·신선도용)

// 처리 큐. machine.includes로 선언된 부분 파일을 따라가며 넓힌다(폴더 밖도 가능).
// 같은 파일이 폴더 스캔과 includes 양쪽에서 잡힐 수 있으므로 실제 경로로 중복 제거한다.
const queue = docs.map(d => ({ ...d, abs: path.resolve(root, d.path) }));
const seen = new Set();
const realOf = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

// 1차: frontmatter·스키마 검증 + 레지스트리 적재
report('\n[1] frontmatter · 스키마 검증');
for (let qi = 0; qi < queue.length; qi++) {
  const d = queue[qi];
  const fp = d.abs;
  if (!fs.existsSync(fp)) {
    report(`  ❌ ${d.viaInclude ? `부분 파일 없음: ${d.path} (선언: ${d.viaInclude})` : `경로 없음: ${d.path}`}`);
    problems.push(d.viaInclude ? 'include' : 'path'); continue;
  }
  const rp = realOf(fp);
  if (seen.has(rp)) continue;   // 이미 처리한 파일(중복 발견 경로)
  seen.add(rp);
  const md = fs.readFileSync(fp, 'utf8');
  const fm = parseFrontmatter(md);
  if (!fm) { report(`  · ${d.path} (frontmatter 없음 — 스킵)`); continue; }
  if (d.docType && fm.doc_type !== d.docType) { report(`  ❌ frontmatter 불일치: ${d.path} 매니페스트=${d.docType} 실제=${fm.doc_type}`); problems.push('doctype'); }
  // 파장·신선도는 **기계 블록이 없는 문서도** 대상이다(기획서·약관·화면 색인이 바로 그런 문서이고,
  // 실제로 그 문서들이 파장에서 누락돼 사고가 났다). 그래서 스키마 검증과 별개로 여기서 먼저 적재한다.
  allDocs.push({ docType: fm.doc_type, path: d.path, revision: fm.revision == null ? null : Number(fm.revision) });
  const machine = fm.machine || {};
  // 부분 파일 선언(machine.includes)을 큐에 넣는다 — 세트 폴더 밖이어도 반드시 따라간다.
  // 이 선언이 "이 문서가 무엇으로 이루어졌는가"의 정본이다(폴더 위치·매니페스트에 기대지 않는다).
  const includes = Array.isArray(machine.includes) ? machine.includes : (machine.includes ? [machine.includes] : []);
  for (const rel of includes) {
    const abs = path.resolve(path.dirname(fp), rel);
    queue.push({ path: path.relative(root, abs).replace(/\\/g, '/'), abs, viaInclude: d.path });
  }
  // `version`은 **payload 계약(스키마) 버전**이라 내용이 바뀌어도 안 올라간다. 그런데 그게 지켜지는지
  // 보는 층이 없어, 문서 수정 카운터로 오해해 올린 값(`version: 13`)이 v1 스키마 문서에 박혀도 침묵했다
  // (실측: SDD 하네스가 "상위 문서의 version을 먼저 올려라"라고 오지시했고 그대로 오염됐다).
  // 파일명의 `.v<N>`이 그 문서가 쓰는 계약 버전이므로 둘을 대조한다.
  {
    const m = /\.v([0-9]+)\.schema\.json$/.exec(String(machine.schema || ''));
    const declared = fm.version != null ? String(fm.version).trim() : null;
    if (m && declared && declared !== m[1]) {
      report(`  ❌ ${d.path}: version ${declared} != 스키마 계약 v${m[1]}`);
      versionDrift.push({ path: d.path, declared, want: m[1], revision: fm.revision ?? null });
      problems.push('schema');
    }
  }
  if (!machine.tag || !machine.schema) { report(`  · ${d.path.padEnd(30)} (${fm.doc_type}) 기계블록 없음`); continue; }
  const schemaPath = path.resolve(path.dirname(fp), machine.schema);
  let schema; try { schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8')); }
  // 스키마를 못 읽으면 이 문서의 블록은 `loaded`에 들어가지 못하고, **이후 모든 검사에서 빠진다**
  // (죽은 링크·커버리지·낡음·옛 배치…). 오류 한 줄만 내면 사람은 "스키마 하나 못 읽었네"로 읽고
  // 그 뒤가 조용히 통과한 줄 안다. 그래서 **결과를 명시**한다 — 조용한 통과를 만들지 않는다.
  catch (e) {
    report(`  ❌ 스키마 로드 실패: ${d.path} → ${machine.schema}`);
    report(`       → 이 문서의 기계 블록은 **이후 검사에서 전부 제외된다**(죽은 링크·낡음·커버리지 침묵).`);
    report(`       → 스키마 사본을 문서 옆 \`${path.posix.dirname(machine.schema) || '.'}/\`에 두세요(스킬 자산에서 복사).`);
    problems.push('schema'); continue;
  }
  // 사본이 스킬 자산과 다르면 둘 중 하나가 뒤처진 것 → 어느 쪽인지는 사람이 판단한다.
  const canon = canonicalSchemaPath(path.basename(schemaPath));
  // 스킬 자산을 못 찾으면 이 검사를 **생략한다**(검사기를 스킬 밖으로 옮겨 단독 실행하는 경우).
  // 그때 아무 말도 안 하면 **"검사했는데 같다"와 "아예 안 봤다"가 출력에서 구분되지 않는다** —
  // 실사용에서 사본이 뒤처진 것을 `diff`로 직접 비교하기 전까지 몰랐다. 무엇을 안 봤는지는 밝힌다.
  if (!canon) schemaCopyUnchecked.add(path.basename(schemaPath));
  if (canon) {
    try {
      if (stable(JSON.parse(fs.readFileSync(canon, 'utf8'))) !== stable(schema)) {
        report(`  ⚠ ${d.path.padEnd(30)} 스키마 사본이 스킬 자산과 다름(${machine.schema}) — 어느 쪽이 최신인지 확인 필요`);
        problems.push('schemamismatch');
      }
    } catch { /* 스킬 자산을 못 읽으면 검사 생략 */ }
  }
  const blocks = extractBlocks(md, machine.tag);
  const errs = [];
  for (const obj of blocks) { if (obj.__parseError) { errs.push('JSON 파싱: ' + obj.__parseError); continue; } validate(obj, schema, fm.doc_type, errs); }
  // 옛 계약으로 쓰인 문서를 알아보고 "무엇을 해야 하는지"를 알려 준다(※ 한시적 — 위 주석 참고).
  // (스키마 위반만 나열하면 "필드가 빠졌다"로만 보여, 형식을 옮기면 된다는 걸 알 수 없다.)
  const legacy = legacyKeysOf(fm.doc_type, blocks);
  if (legacy.length) {
    report(`  ⚠ ${d.path.padEnd(30)} 옛 스키마 형식(${legacy.join(', ')}) — 데이터 모델 스킬로 '스키마 이행'이 필요합니다`);
    problems.push('legacy');
  }
  if (errs.length) problems.push('schema');
  report(`  ${errs.length ? '❌' : '✅'} ${d.path.padEnd(30)} (${fm.doc_type}) 블록:${blocks.length} 위반:${errs.length}`);
  // 스키마 위반은 **경로와 규칙**만 말한다. 모양이 헷갈리는 자리는 한 줄 힌트를 곁들여 왕복을 줄인다
  // (실사용: `transientSends`를 문자열 배열로 적고 "타입 object 아님"만 받아 무엇을 쓰라는지 알 수 없었다).
  errs.slice(0, CAP(errs.length)).forEach(e => {
    report('       - ' + e);
    for (const h of ERR_HINTS) if (h.when.test(e)) report(`         ↳ ${h.say}`);
  });
  if (!verbose && errs.length > 5) report(`       - 외 ${errs.length - 5}건 (--verbose로 전부)`);
  loaded.push({ docType: fm.doc_type, path: d.path, blocks });

  // 레지스트리 적재
  for (const o of blocks) {
    if (o.__parseError) continue;
    // 한 기능의 정의도 정확히 한 곳에만 있어야 한다. IA를 범위별 파일로 나눌 수 있게 되면서
    // (`ia-user.md` · `ia-backoffice.md`) **파일이 하나일 때는 불가능했던 중복**이 생길 수 있다.
    // 그냥 `add`하면 나중 것이 조용히 덮어써서, 라벨·상태가 엉뚱한 파일 것으로 잡힌다
    // (데이터 그룹에서 이미 같은 이유로 가드를 뒀다).
    if (Array.isArray(o.features)) for (const f of o.features) {
      const prev = featOrigin.get(f.id);
      if (prev && prev !== d.path) {
        report(`  ❌ 중복 기능 정의: ${f.id} 가 ${prev} 와 ${d.path} 양쪽에 있음`);
        problems.push('dupfeat');
      }
      featOrigin.set(f.id, d.path);
      reg.feat.add(f.id);
      // 범위별로 나눈 파일에 **다른 범위의 기능**이 섞이면, 소유자가 1:1이 되라고 나눈 뜻이 깨진다.
      // 판정 근거는 파일명이 아니라 블록의 `audience`다(그게 정본이다).
      if (f.audience) featAudience.push({ id: f.id, audience: f.audience, doc: d.path });
    }
    if (Array.isArray(o.screens)) o.screens.forEach(s => reg.screen.add(s.id));
    if (Array.isArray(o.frames)) o.frames.forEach(f => reg.frame.add(f.id));
    if (Array.isArray(o.rules)) o.rules.forEach(r => reg.pol.add(r.id));
    if (Array.isArray(o.components)) o.components.forEach(c => reg.ui.add(c.id));
    if (Array.isArray(o.scenarios)) o.scenarios.forEach(s => reg.scn.add(s.id));
    if (o.group && Array.isArray(o.fields)) {
      // 한 그룹의 정의는 정확히 한 곳에만 있어야 한다. 두 파일이 같은 그룹을 정의하면
      // 나중 것이 앞의 것을 덮어써(처리 순서에 좌우) 멀쩡한 필드가 죽은 링크로 둔갑한다.
      const prev = groupOrigin.get(o.group);
      if (prev && prev !== d.path) {
        report(`  ❌ 중복 그룹 정의: DATA.${o.group} 가 ${prev} 와 ${d.path} 양쪽에 있음`);
        problems.push('dupgroup');
      }
      groupOrigin.set(o.group, d.path);
      reg.group.set(o.group, new Set(o.fields.map(f => f.name)));
    }
    if (o.tokens) for (const [cat, kv] of Object.entries(o.tokens)) if (kv && typeof kv === 'object') for (const name of Object.keys(kv)) reg.token.add(`${cat}.${name}`);
  }
}

// ── 백엔드 등기부 적재 (있을 때만 — 백엔드 문서가 없는 세트에서도 그대로 돈다) ──
const be = { itf: new Set(), store: new Set(), table: new Set(), mod: new Set(), ext: new Set(), authMode: new Set() };
const screenIo = [];        // {id, screen, action, target, doc}
const unfetchedDisplay = [];  // 보여준다고 했는데 아무 server 동작도 가져오지 않는 값 {screen, doc, vars}
const noEntryLoad = [];       // 보여주는데 **진입 로드 자체가 없는** 화면 {screen, doc, shown}
const frameIdDrift = [];      // 프레임 동작 id의 앞 두 마디가 소유 프레임과 다름 {id, frame, want, doc}
const beBasis = [];         // {itfId, kind, ref, why, doc}
for (const doc of loaded) {
  for (const o of doc.blocks) {
    if (o.__parseError) continue;
    for (const i of (o.interfaces || [])) {
      be.itf.add(i.id);
      for (const b of (i.basis || [])) beBasis.push({ itfId: i.id, ...b, doc: doc.path });
    }
    for (const s of (o.stores || [])) be.store.add(s.id);
    for (const t of (o.tables || [])) be.table.add(t.id);
    for (const m of (o.modules || [])) be.mod.add(m.id);
    for (const x of (o.integrations || [])) be.ext.add(x.id);
    for (const a of (o.authModes || [])) be.authMode.add(a.mode);
    // 프레임 동작(io) — 화면이 아니라 **껍데기**에서 일어나는 요구.
    // 화면에 억지로 붙이면 그 화면과 운명을 같이하고(실측: GNB 로그아웃이 마이페이지에 귀속),
    // 안 붙이면 통째로 샌다(실측: 요청서 96건에 세션 조회 없음). 그래서 프레임이 자기 자리를 갖는다.
    for (const fr of (o.frames || [])) {
      const dat = (fr.data || {});
      // 동작 id의 **앞 두 마디는 소유자를 드러내야 한다**(`IO.order.create.*` → `FEAT.order.create`).
      // 프레임도 소유자가 `FRAME.<범위>.<이름>`이므로 `IO.<범위>.<이름>.<동작>`이다.
      // 0.10.0이 `IO.frame.<이름>.*`을 예시해 **범위가 빠졌고**, 사용자 앱과 백오피스가 둘 다 껍데기를
      // `shell`이라 불러 양쪽이 겹쳤다(실측). 범위가 하나뿐인 세트는 **충돌도 안 나서 조용히 통과**하므로
      // 중복 검사만으로는 부족하다 — 소유자와 대조해 직접 잡는다.
      const own = String(fr.id || '').split('.').slice(1, 3).join('.');
      for (const a of (dat.io || [])) {
        if (!a.id || !own) continue;
        const head = String(a.id).split('.').slice(1, 3).join('.');
        if (head !== own) frameIdDrift.push({ id: a.id, frame: fr.id, want: `IO.${own}.<동작>`, doc: doc.path });
      }
      for (const a of (dat.io || [])) {
        screenIo.push({ id: a.id || null, screen: fr.id, action: a.action, target: a.target || null,
                        ui: a.ui || null, auth: a.auth || null,
                        sends: a.sends || [], transientSends: a.transientSends || [],
                        receives: a.receives || [], transientReceives: a.transientReceives || [],
                        policies: a.policies || [], semantics: a.semantics || null, op: null,
                        frame: fr.id, appliesTo: fr.appliesTo || null, doc: doc.path });
      }
    }
    // 화면 동작(io) — 백엔드 요구의 출처
    for (const s of (o.screens || [])) {
      const dat = Array.isArray(s.data) ? {} : (s.data || {});
      // 보여준다고 선언한 값 중 **어떤 server 동작도 가져오지 않는 것**을 모은다.
      // `display`는 "보인다", `io[].receives`는 "가져온다"라 뜻이 다르고, 그 차집합이 **빠진 조회 요구**의 신호다.
      // 화면 진입 로드를 io에 안 적으면 그 화면은 요청서에 한 줄도 안 나가는데, 지금까지 그게 **조용히** 빠졌다.
      // 상설 검사다(마이그레이션 도구가 아니다) — 새 화면을 쓸 때마다 같은 누락이 반복되기 때문이다.
      const fetched = new Set();
      for (const a of (dat.io || [])) {
        if ((a.target ? String(a.target).split('.')[0] : null) !== 'server') continue;
        for (const v of (a.receives || [])) { fetched.add(v); fetched.add(String(v).split('.')[0]); }
      }
      const unfetched = (dat.display || []).filter((v) => !fetched.has(v) && !fetched.has(String(v).split('.')[0]));
      if (unfetched.length) unfetchedDisplay.push({ screen: s.id, doc: doc.path, vars: unfetched });
      // **`receives`가 전부 조회인 것은 아니다.** 승인·반려·저장 같은 **변경 동작도 결과를 받는다** —
      // 그 응답이 화면 값을 덮으면 위 `unfetched`가 0이 되어 **진입 조회가 없는데도 조용히 통과**한다
      // (실측: 상세 화면 둘이 그렇게 통과해 요청서에 조회가 한 줄도 안 나갔다).
      // 그래서 두 번째 신호를 따로 낸다 — "보여주는데 **진입 로드로 볼 만한 동작이 하나도 없는** 화면".
      // 진입 로드의 표식은 0.9.0에서 정한 둘이다: id가 `.load*` · 누르는 것이 아니므로 `ui`가 없다.
      if ((dat.display || []).length) {
        const entryish = (dat.io || []).filter((a) => (a.target ? String(a.target).split('.')[0] : null) === 'server'
          && (/\.load[A-Za-z0-9_-]*$/.test(a.id || '') || !a.ui));
        if (!entryish.length) noEntryLoad.push({ screen: s.id, doc: doc.path, shown: (dat.display || []).length });
      }
      for (const a of (dat.io || [])) {
        screenIo.push({ id: a.id || null, screen: s.id, action: a.action, target: a.target || null,
                        ui: a.ui || null, auth: a.auth || null,
                        sends: a.sends || [], transientSends: a.transientSends || [],
                        receives: a.receives || [], transientReceives: a.transientReceives || [],
                        policies: a.policies || [], semantics: a.semantics || null, op: a.op || null, doc: doc.path });
      }
    }
  }
}

// 문서별 현재 상태(개정 번호·내용 해시) — 신선도 판정과 요청서의 출처 스냅샷이 함께 쓴다.
const cur = new Map();   // path → {revision, hash}
// **파생물**(통째로 다시 뽑히는 산출물). 사람이 개정을 매길 자리가 없으므로 개정 지시를 하지 않는다.
const DERIVED_TYPES = new Set(['interface-request']);
const docTypeOf = new Map(); // path → doc_type
for (const d of allDocs) {
  try {
    const text = fs.readFileSync(path.resolve(root, d.path), 'utf8');
    const fm = parseFrontmatter(text) || {};
    const rev = fm.revision == null ? null : Number(fm.revision);
    docTypeOf.set(d.path, d.docType);
    cur.set(d.path, { revision: Number.isNaN(rev) ? null : rev, hash: 'sha256:' + crypto.createHash('sha256').update(text.split('\r\n').join('\n')).digest('hex') });
  } catch { /* 위에서 이미 보고됨 */ }
}

// 데이터 참조 해석: <group> 또는 <group>.<field>
function dataRefOk(ref) {
  const bare = ref.replace(/^DATA\./, '');
  const [g, f] = bare.split('.');
  if (!reg.group.has(g)) return false;
  return f == null ? true : reg.group.get(g).has(f);
}

// 2차: 크로스도큐먼트 참조 무결성
// `version`을 문서 수정 카운터로 오해한 흔적 — **이행 안내를 함께** 낸다(그냥 1로 되돌리면 SDD 핀이 깨진다).
if (versionDrift.length) {
  report(`\n  ⚠ \`version\`이 스키마 계약과 다른 문서 ${versionDrift.length}개 — **이행 필요**`);
  for (const x of versionDrift.slice(0, CAP(versionDrift.length))) {
    report(`     · ${x.path} — version ${x.declared} (계약 v${x.want}${x.revision != null ? ` · revision ${x.revision}` : ' · revision 없음'})`);
  }
  if (!verbose && versionDrift.length > 5) report(`     · 외 ${versionDrift.length - 5}개 (--verbose로 전부)`);
  report('     → `version`은 **payload 계약(스키마) 버전**이다. 문서를 고쳤다고 올리지 않는다 —');
  report('        결정이 바뀐 것은 `revision`으로 나타낸다(다른 축이다).');
  report('     → SDD 하네스를 함께 쓴다면 **핀부터 재생성한 뒤** version을 계약 값으로 되돌리세요.');
  report('        순서를 뒤집으면(먼저 되돌리면) 슬라이스 핀이 한꺼번에 깨집니다.');
}

// 무엇을 안 봤는지 밝힌다 — 조용한 생략은 "봤는데 문제없음"으로 읽힌다.
if (schemaCopyUnchecked.size) {
  report(`  · 스키마 사본 일치를 **확인하지 못함** ${schemaCopyUnchecked.size}종(${[...schemaCopyUnchecked].join(', ')})`);
  report('     스킬 자산을 못 찾았습니다(검사기를 스킬 밖에 두고 실행한 경우). 사본이 뒤처져도 알 수 없으니,');
  report('     스킬 폴더의 검사기로 한 번 돌리거나 사본을 직접 대조하세요.');
}

report('\n[2] 크로스도큐먼트 참조 (죽은 링크)');
let refChecked = 0, dead = 0;
const oldLayoutReq = [];    // 옛 배치(범위 통짜) 요청서 — 도메인별로 다시 뽑아야 한다
const staleGen = [];        // 생성기가 그 뒤 자란 요청서 {path, was}
const basisNotInReq = [];   // basis(screen-io)가 요청서에 안 실린 동작을 가리킴 {itfId, ref, doc, io}
const fieldAliases = [];    // 계약 필드가 별칭 키를 씀 {itfId, field, alias, want, doc}
const listNoItems = [];     // type: list 인데 원소 모양이 없음 {itfId, field, flattened, doc}
const noOrigin = [];        // 필드의 근거 갈래 미기재 {itfId, field, doc}
for (const doc of loaded) {
  for (const o of doc.blocks) {
    if (o.__parseError) continue;
    // 프레임: 컴포넌트 → ui 인벤토리, display·io 변수 → 데이터모델, policies → 정책서,
    //        appliesTo의 화면 → ia.features. 화면 엔트리와 **같은 검사**를 받는다.
    for (const fr of (o.frames || [])) {
      const fdat = fr.data || {};
      for (const c of (fr.components || [])) {
        if (/^UI\.FEAT\./.test(c)) continue;
        refChecked++; if (!reg.ui.has(c)) { report(`  ❌ ${doc.path}: 프레임 ${fr.id} 의 컴포넌트 ${c} → uicomponents.list에 없음`); dead++; }
      }
      const frefs = [...(fdat.display || [])];
      for (const a of (fdat.io || [])) { for (const v of (a.sends || [])) frefs.push(v); for (const v of (a.receives || [])) frefs.push(v); }
      for (const dv of frefs) { refChecked++; if (!dataRefOk(dv)) { report(`  ❌ ${doc.path}: 프레임 ${fr.id} 의 데이터 ${dv} → 데이터 모델에 없음`); dead++; } }
      for (const a of (fdat.io || [])) for (const pol of (a.policies || [])) {
        refChecked++; if (!reg.pol.has(pol)) { report(`  ❌ ${doc.path}: 프레임 ${fr.id} 의 정책 ${pol} → policy.rules에 없음`); dead++; }
      }
      // 걸리는 범위의 화면이 실재해야 한다. 특히 `except`가 오타면 **로그인 화면이 가드에 걸린 채로 남아**
      // "로그인하려면 세션이 있어야 한다"는 순환이 조용히 유지된다.
      const ap = fr.appliesTo || {};
      if (ap.except && ap.only) { report(`  ❌ ${doc.path}: 프레임 ${fr.id} 의 appliesTo에 except와 only가 함께 있음 — 하나만 쓰세요`); dead++; }
      for (const f of [...(ap.except || []), ...(ap.only || [])]) {
        refChecked++;
        if (!reg.feat.has(f) && !reg.screen.has(f)) { report(`  ❌ ${doc.path}: 프레임 ${fr.id} 의 appliesTo ${f} → 기능·화면에 없음`); dead++; }
      }
      // 일회성 입력이 실재 변수면 `sends` 우회다(화면과 같은 규칙).
      for (const a of (fdat.io || [])) for (const t of (a.transientSends || [])) {
        if (t && t.name && dataRefOk(t.name)) {
          report(`  ❌ ${doc.path}: 프레임 ${fr.id} 의 일회성 입력 ${t.name} 은 데이터 모델 실재 변수다 — \`sends\`로 옮기세요`);
        }
      }
      for (const a of (fdat.io || [])) for (const t of (a.transientReceives || [])) {
        if (dataRefOk(t.name)) {
          report(`  ❌ ${doc.path}: 프레임 ${fr.id} 의 일회성 결과 ${t.name} 은 데이터 모델 실재 변수다 — \`receives\`로 옮기세요`);
          dead++;
        }
      }
    }
    // 화면 설계: feat → ia, 컴포넌트(components + io.ui + bindings.ui) → ui(중앙; 로컬 UI.FEAT.* 는 스킵),
    //           데이터(display + io.sends/receives + bindings.var) → 데이터모델. (구 포맷 s.data 는 display로 호환)
    for (const s of (o.screens || [])) {
      refChecked++; if (s.feat && !reg.feat.has(s.feat)) { report(`  ❌ ${doc.path}: 화면 ${s.id} 의 feat ${s.feat} → ia.features에 없음`); dead++; }
      // data는 객체 {display, io, bindings}. 구 포맷(평탄 배열)은 display로 호환.
      const dat = Array.isArray(s.data) ? { display: s.data, io: [], bindings: [] } : (s.data || {});
      const uiRefs = [...(s.components || [])];
      for (const a of (dat.io || [])) if (a.ui) uiRefs.push(a.ui);
      for (const b of (dat.bindings || [])) if (b.ui) uiRefs.push(b.ui);
      for (const c of uiRefs) { if (/^UI\.FEAT\./.test(c)) continue; refChecked++; if (!reg.ui.has(c)) { report(`  ❌ ${doc.path}: 화면 ${s.id} 의 컴포넌트 ${c} → uicomponents.list에 없음`); dead++; } }
      // 동작에 걸린 정책(POL.*) — 산문에 있는 것을 블록이 담았으면 실재 확인까지 받는다.
      for (const a of (dat.io || [])) for (const pol of (a.policies || [])) {
        refChecked++; if (!reg.pol.has(pol)) { report(`  ❌ ${doc.path}: 화면 ${s.id} 동작 "${a.action}" 의 정책 ${pol} → policy.rules에 없음`); dead++; }
      }
      const dataRefs = [...(dat.display || [])];
      for (const a of (dat.io || [])) { for (const v of (a.sends || [])) dataRefs.push(v); for (const v of (a.receives || [])) dataRefs.push(v); }
      for (const b of (dat.bindings || [])) for (const v of (b.vars || (b.var ? [b.var] : []))) dataRefs.push(v);
      for (const dv of dataRefs) { refChecked++; if (!dataRefOk(dv)) { report(`  ❌ ${doc.path}: 화면 ${s.id} 의 데이터 ${dv} → 데이터 모델에 없음`); dead++; } }
      // `transientSends`는 **저장하지 않는 일회성 입력**이라 등기부 대조를 받지 않는다. 그래서 여기가
      // `sends` 제약(데이터 모델 실재 변수만)을 우회하는 **뒷문**이 될 수 있다 — 실재 변수를 여기 적었으면 잡는다.
      for (const a of (dat.io || [])) for (const t of (a.transientSends || [])) {
        if (t && t.name && dataRefOk(t.name)) {
          report(`  ❌ ${doc.path}: 화면 ${s.id} 의 일회성 입력 ${t.name} 은 데이터 모델 실재 변수다 — \`sends\`로 옮기세요`);
        }
      }
      for (const a of (dat.io || [])) for (const t of (a.transientReceives || [])) {
        if (dataRefOk(t.name)) {
          report(`  ❌ ${doc.path}: 화면 ${s.id} 의 일회성 결과 ${t.name} 은 데이터 모델 실재 변수다 — \`receives\`로 옮기세요`);
          dead++;
        }
      }
    }
    // 시나리오: refs 를 kind로 라우팅
    for (const sc of (o.scenarios || [])) for (const r of (sc.refs || [])) {
      refChecked++;
      const ok = r.kind === 'feat' ? reg.feat.has(r.id)
        : r.kind === 'data' ? dataRefOk(r.id)
        : r.kind === 'policy' ? reg.pol.has(r.id)
        : r.kind === 'scenario' ? reg.scn.has(r.id)
        : true; // usecase 등은 등기부 없음 → 스킵
      if (!ok) { report(`  ❌ ${doc.path}: ${sc.id} 의 ${r.kind} 참조 ${r.id} → 원본에 없음`); dead++; }
    }
  }
}
// 같은 io id가 둘이면 그 참조가 어느 동작을 가리키는지 갈린다 — 요청서·백엔드 basis가 조용히 엉뚱한
// 동작에 붙는다. id는 사람/LLM이 동작 이름에서 지어내는 값이라 실제로 충돌하기 쉽다(도그푸드에서 발생).
const ioById = new Map();
{
  const dupSeen = new Set();
  for (const x of screenIo) {
    if (!x.id) continue;
    if (ioById.has(x.id)) {
      if (!dupSeen.has(x.id)) {
        const prev = ioById.get(x.id);
        report(`  ❌ 중복 동작 id: ${x.id} 가 "${prev.action}"(${prev.doc})와 "${x.action}"(${x.doc}) 양쪽에 있음`);
        dead++; dupSeen.add(x.id);
      }
      continue;
    }
    ioById.set(x.id, x);
  }
}
// 인터페이스 요청서: 가리키는 동작·데이터·정책이 실재하나 + 출처가 그 뒤 바뀌지 않았나.
// 요청서는 파생물이라 낡는 게 정상이고, 낡았으면 **다시 생성**하면 된다 — 그래서 경고다.
for (const doc of loaded) {
  for (const o of doc.blocks) {
    if (o.__parseError || !Array.isArray(o.requests)) continue;
    for (const r of o.requests) {
      if (r.ref && !r.ref.includes('#')) {
        refChecked++; if (!ioById.has(r.ref)) { report(`  ❌ ${doc.path}: 요구 ${r.ref} → 화면 동작(data.io[].id)에 없음`); dead++; }
      }
      for (const v of [...(r.sends || []), ...(r.receives || [])]) {
        refChecked++; if (!dataRefOk(v)) { report(`  ❌ ${doc.path}: 요구 ${r.ref} 의 데이터 ${v} → 데이터 모델에 없음`); dead++; }
      }
      for (const pol of (r.policies || [])) {
        refChecked++; if (!reg.pol.has(pol)) { report(`  ❌ ${doc.path}: 요구 ${r.ref} 의 정책 ${pol} → policy.rules에 없음`); dead++; }
      }
    }
    for (const f of (o.from || [])) {
      const c = cur.get(f.path);
      if (!c) { report(`  ❌ ${doc.path}: 출처 ${f.path} 가 세트에 없음`); dead++; continue; }
      const revChanged = f.revision != null && c.revision != null && f.revision !== c.revision;
      if (revChanged || (f.contentHash && f.contentHash !== c.hash)) {
        report(`  ⚠ ${doc.path} 가 낡았다 — 출처 ${f.path} 가 생성 이후 바뀜(요청서를 다시 생성하세요: --emit-interface-request)`);
      }
    }
    // **생성기가 그 뒤 자랐나.** 요청서는 화면 + 생성기 로직의 함수인데 신선도 검사는 화면만 본다.
    // 화면이 그대로여도 생성기가 새 칸을 실어 나르게 되면 옛 요청서는 **그 칸이 빈 채로 남는다**
    // (실제 사고: 일회성 결과를 싣게 고쳤는데 옛 요청서는 빈 열 그대로였고 점검기는 "통과"라고 답했다).
    if (o.generatedWith !== TOOL_VERSION) staleGen.push({ path: doc.path, was: o.generatedWith || null });
    // 옛 배치(범위 통짜) 감지. 출처가 여럿이면 화면 하나만 고쳐도 **요청서 전체가 낡음**이 되어
    // 어디가 낡았는지 알 수 없다. 도메인별로 갈라야 "이 요청서가 낡았다"가 정확해진다.
    if (Array.isArray(o.from) && (o.from.length > 1 || !o.domain)) oldLayoutReq.push(doc.path);
  }
}

// 요청서에 실제로 실린 요구 목록. **아래 basis 대조의 기준**이다.
const reqRefs = new Set();
// **어느 화면 설계서가 요청서로 수확됐나**(`from[].path`). 이게 대조의 게이트다 —
// "요청서가 하나라도 있으면 판정한다"로 잡으면, **한 트랙 요청서만 가진 리포**(사용자 앱 요청서는 있는데
// 백오피스 것은 없는 사본 등)에서 그 트랙 전체가 통째로 위반으로 뜬다. 수확된 적 없는 화면 문서의 동작은
// **아직 요청서가 없는 것**이지 근거가 틀린 것이 아니다.
const harvested = new Set();
for (const doc of loaded) for (const o of doc.blocks) {
  if (o.__parseError || !Array.isArray(o.requests)) continue;
  for (const r of o.requests) if (r.ref) reqRefs.add(r.ref);
  for (const f of (o.from || [])) if (f.path) harvested.add(f.path);
}

// 백엔드 참조: 인터페이스가 가리키는 것들이 실재하나 + 근거(basis) 규칙
for (const doc of loaded) {
  for (const o of doc.blocks) {
    if (o.__parseError) continue;
    for (const i of (o.interfaces || [])) {
      for (const st of [...(i.reads || []), ...(i.writes || [])]) {
        refChecked++; if (!be.store.has(st)) { report(`  ❌ ${doc.path}: ${i.id} 의 저장소 ${st} → backend.stores에 없음`); dead++; }
      }
      // 같은 뜻의 별칭 키를 집계한다(표준: 허용값 `values` · 필수 여부 `required`).
      const ALIAS = { enum: 'values', optional: 'required' };
      for (const side of ['request', 'response']) {
        const fields = (i[side] || {}).fields || [];
        // 이름이 `x[].y`·`x.y` 꼴이면 `x`를 **펼쳐 적은 것**이다. 그런 형제가 있으면 고칠 자리가 다르다
        // (원소 모양을 지어내는 것이 아니라 **형제를 `items.fields`로 모으는** 일이다).
        const flatParents = new Set();
        for (const fl of fields) {
          const m = /^([^.[\]]+)(?:\[\])?\./.exec(String(fl.name || ''));
          if (m) flatParents.add(m[1]);
        }
        for (const fl of fields) {
          for (const [alias, want] of Object.entries(ALIAS)) {
            if (alias in fl) fieldAliases.push({ itfId: i.id, field: `${side}.${fl.name}`, alias, want, doc: doc.path });
          }
          const bare = String(fl.name || '').replace(/\[\]$/, '');
          // **목록인데 원소 모양이 없다.** `type: "list"`에서 멈추면 받는 쪽은 원소가 무엇인지 모른다
          // (실측: 객체 배열을 보냈는데 서버는 문자열 배열을 기다려 422 — 하루 소요).
          if (fl.type === 'list' && !fl.items) {
            listNoItems.push({ itfId: i.id, field: `${side}.${fl.name}`, flattened: flatParents.has(bare), doc: doc.path });
          }
          // **이 값이 어디서 오는지**가 셋 중 하나로 적혀 있나(저장 · 파생 · 일회성).
          const origins = ['dataModel', 'derivedFrom', 'transient'].filter((k) => fl[k] != null && fl[k] !== false);
          if (origins.length > 1) {
            report(`  ❌ ${doc.path}: ${i.id} 의 ${side}.${fl.name} 에 근거 갈래가 둘(${origins.join(' + ')}) — 하나만 적습니다`);
            dead++;
          } else if (origins.length === 0 && !flatParents.has(bare) && !fl.items) {
            // `items`로 원소 모양을 적은 **목록 컨테이너**는 제외한다 — 값의 근거는 원소 필드가 지고,
            // 컨테이너 자신은 담는 그릇일 뿐이다. 여기서 근거를 요구하면 **제대로 적은 문서가 벌을 받는다**
            // (도그푸드에서 잡힌 오탐. 보고된 "컨테이너 45건"이 같은 갈래다).
            noOrigin.push({ itfId: i.id, field: `${side}.${fl.name}`, doc: doc.path });
          }
          // 파생은 **무엇으로부터 왔는지**가 등기부에 실재해야 한다.
          for (const src of ((fl.derivedFrom || {}).from || [])) {
            refChecked++;
            if (!dataRefOk(src)) {
              report(`  ❌ ${doc.path}: ${i.id} 의 ${side}.${fl.name} 이 파생된 출처 ${src} → 데이터 모델에 없음`);
              dead++;
            }
          }
        }
      }
      const mode = i.auth && i.auth.mode;
      if (mode && be.authMode.size) { refChecked++; if (!be.authMode.has(mode)) { report(`  ❌ ${doc.path}: ${i.id} 의 auth.mode ${mode} → backend.system의 authModes에 없음`); dead++; } }
    }
    for (const s of (o.stores || [])) for (const h of (s.holds || [])) {
      if (!h.group) continue;
      refChecked++; if (!dataRefOk(h.group)) { report(`  ❌ ${doc.path}: 저장소 ${s.id} 가 담는 그룹 ${h.group} → 데이터 모델에 없음`); dead++; }
    }
  }
}
// 근거(basis) — 등기부가 있는 갈래는 실재 확인, 없는 갈래는 사유(why) 필수.
for (const b of beBasis) {
  if (b.kind === 'screen-io') {
    if (!b.ref || b.ref.includes('#')) continue;              // 합성 참조(id 없는 옛 문서)는 대조 불가 — 아래에서 집계
    refChecked++;
    if (!ioById.has(b.ref)) { report(`  ❌ ${b.doc}: ${b.itfId} 의 근거 ${b.ref} → 화면 동작(data.io[].id)에 없음`); dead++; continue; }
    // **화면 동작에 실재한다고 근거가 맞는 것은 아니다.** 요청서에 실리지 않은 동작을 근거로 들면
    // 요구 → 계약의 흐름을 타지 않은 인터페이스가 된다(실측: 요청이 이슈로 와서 근거 칸을 채우려고
    // 엉뚱한 동작 id를 갖다 붙였고, id가 실재하니 통과했다).
    // **고칠 자리가 둘로 갈리므로 갈래를 판정해 안내한다** — 안 그러면 엉뚱한 곳을 고친다.
    const io = ioById.get(b.ref);
    if (io && harvested.has(io.doc) && !reqRefs.has(b.ref)) basisNotInReq.push({ ...b, io });
  } else if (b.kind === 'policy') {
    refChecked++; if (!reg.pol.has(b.ref)) { report(`  ❌ ${b.doc}: ${b.itfId} 의 근거 ${b.ref} → policy.rules에 없음`); dead++; }
  } else if (b.kind === 'ops' || b.kind === 'legacy') {
    // 등기부가 없는 갈래다 — 사유가 없으면 "개발자 요구"가 아무 인터페이스나 정당화하는 뒷문이 된다.
    if (!b.why || !String(b.why).trim()) { report(`  ❌ ${b.doc}: ${b.itfId} 의 근거 "${b.ref}"(${b.kind})에 why 없음 — 등기부 없는 갈래는 사유 필수`); dead++; }
  }
}

// 근거는 실재하는데 **요청서에는 없는** 동작 — 갈래를 갈라 안내한다.
// 한 갈래로 뭉쳐 "ops를 쓰라"고만 하면 **엉뚱한 곳을 고치게 된다**(실측 4건은 전부 화면 설계서가 고칠 자리였다:
// 서버를 거치는 동작인데 `target: client`로 적혀 있어 요청서 생성에서 빠졌고, 그래서 담기·빼기가 저장되지 않았다).
if (basisNotInReq.length) {
  const bucket = { screen: [], stale: [], untargeted: [] };
  for (const x of basisNotInReq) {
    const t = x.io && x.io.target ? String(x.io.target).split('.')[0] : null;
    if (!t) bucket.untargeted.push(x);
    else if (t === 'server') bucket.stale.push(x);
    else bucket.screen.push(x);                              // client·local — 화면 설계서가 고칠 자리
  }
  report(`\n  ⚠ 요청서에 없는 동작을 근거로 든 인터페이스 ${basisNotInReq.length}건 — 요구 → 계약 흐름을 안 탔다`);
  const show = (list, head, ...how) => {
    if (!list.length) return;
    report(`     ${head} (${list.length}건)`);
    for (const x of list.slice(0, CAP(list.length))) report(`       · ${x.itfId} → ${x.ref}`);
    if (!verbose && list.length > 5) report(`       · 외 ${list.length - 5}건 (--verbose로 전부)`);
    for (const line of how) report(`       ${line}`);
  };
  show(bucket.screen, '**화면 설계서를 고치세요** — 그 동작이 `client`/`local`로 적혀 있어 요청서에서 빠졌습니다',
    '→ 서버를 거치는 동작이면 `target: server`로 바로잡고 요청서를 다시 뽑으세요.',
    '→ **`ops`로 바꾸지 마세요.** 화면에 있는 동작이라 근거 갈래는 `screen-io`가 맞습니다.');
  show(bucket.stale, '**요청서를 다시 뽑으세요** — 동작은 `server`인데 요청서에 안 실렸습니다',
    '→ 화면을 고친 뒤 재생성을 안 돌렸을 때 이렇게 됩니다(`--emit-interface-request`).');
  show(bucket.untargeted, '**`target`을 먼저 판정하세요** — 미분류라 요청서에 실릴지가 정해지지 않았습니다');
  report('     ※ **화면 자체가 없는 요구**(배치·웹훅·정산·운영)라면 근거 갈래가 다릅니다 —');
  report('        `{"kind": "ops", "ref": "…", "why": "…"}`로 적으세요(`why` 필수).');
}

// 생성기가 자란 뒤로 다시 안 뽑은 요청서. **화면이 그대로라 신선도 검사가 못 보는 자리**다.
if (staleGen.length) {
  report(`\n  ⚠ 생성기가 자란 뒤로 다시 안 뽑은 요청서 ${staleGen.length}건 — 새 칸이 빈 채로 남아 있을 수 있습니다`);
  for (const x of staleGen.slice(0, CAP(staleGen.length))) {
    report(`     · ${x.path} (뽑은 판 ${x.was || '표시 없음'} → 지금 ${TOOL_VERSION})`);
  }
  if (!verbose && staleGen.length > 5) report(`     · 외 ${staleGen.length - 5}건 (--verbose로 전부)`);
  report('     → `--emit-interface-request` 로 다시 뽑으세요. 화면은 그대로라 다른 검사는 아무 말도 하지 않습니다.');
}

// 목록인데 **원소 하나의 모양**이 없나. 고칠 자리가 둘로 갈린다 — 형제를 모으는 일이냐, 새로 적는 일이냐.
if (listNoItems.length) {
  const flat = listNoItems.filter((x) => x.flattened);
  const bare = listNoItems.filter((x) => !x.flattened);
  report(`\n  ⚠ 목록인데 항목 모양이 없는 계약 필드 ${listNoItems.length}건`);
  report('     받는 쪽은 `type: "list"`만 보고 원소가 무엇인지 알 수 없습니다 —');
  report('     실측 사고: 객체 배열을 보냈는데 서버는 문자열 배열을 기다려 422가 났습니다.');
  const show = (list, head, how) => {
    if (!list.length) return;
    report(`     ${head} (${list.length}건)`);
    for (const x of list.slice(0, CAP(list.length))) report(`       · ${x.itfId} 의 ${x.field}`);
    if (!verbose && list.length > 5) report(`       · 외 ${list.length - 5}건 (--verbose로 전부)`);
    report(`       ${how}`);
  };
  show(flat, '**형제 필드를 모으세요** — 원소의 필드를 `이름[].속성`으로 펼쳐 적으셨습니다',
    '→ 형제 배열이라 스키마가 못 봅니다. `items.fields`로 모으면 원소 모양이 한자리에 섭니다.');
  show(bare, '**원소 모양을 적으세요** — 어디에도 원소 정보가 없습니다',
    '→ `items: { "type": "…", "desc": "…" }`. 원소가 객체면 `fields`, 열거형이면 `values`를 함께.');
}

// 값이 **어디서 오는지**가 안 적힌 필드. 저장·파생·일회성 셋 중 하나여야 한다.
if (noOrigin.length) {
  report(`\n  ⚠ 근거 갈래가 안 적힌 계약 필드 ${noOrigin.length}건 — 저장된 값인지, 파생인지, 일회성인지 모릅니다`);
  for (const x of noOrigin.slice(0, CAP(noOrigin.length))) report(`     · ${x.itfId} 의 ${x.field}`);
  if (!verbose && noOrigin.length > 5) report(`     · 외 ${noOrigin.length - 5}건 (--verbose로 전부)`);
  report('     → 저장된 값이면 `dataModel` · 계산·가공해 만들면 `derivedFrom` · 저장 안 하면 `transient: true`.');
  report('     ※ **반대편이 더 위험합니다** — `dataModel`이 붙었는데 사실은 **파생**인 것은 기계가 못 잡습니다');
  report('        (이름이 실재하니 통과). 끝 네 자리 발췌·건수·결합 같은 값이 원본 개념에 걸려 있으면,');
  report('        저장 설계를 읽는 쪽이 **원본을 저장한다고 오해합니다.** 풀 리뷰의 미러 충실도에서 봅니다.');
}

// 계약 필드가 **같은 뜻을 다른 이름으로** 적고 있나. 스키마가 한쪽만 선언해 두어 나머지가 조용히 통과했다
// (실측: 허용값 `values` 50 · `enum` 26 / 필수 `required` 295 · `optional` 2).
// 소비자가 표준 이름만 읽으면 **별칭으로 적힌 것은 그 값이 없는 필드로 보인다.**
// 지금 막지 않고 **집계만** 한다 — `additionalProperties: false`로 즉시 잠그면 990필드 문서가 그날로 실패한다.
if (fieldAliases.length) {
  const byAlias = new Map();
  for (const x of fieldAliases) byAlias.set(x.alias, (byAlias.get(x.alias) || 0) + 1);
  report(`\n  ⚠ 같은 뜻을 다른 이름으로 적은 계약 필드 ${fieldAliases.length}건 — **이관 필요**`);
  report(`     ${[...byAlias.entries()].map(([k, v]) => `${k} ${v}건`).join(' · ')}`);
  for (const x of fieldAliases.slice(0, CAP(fieldAliases.length))) {
    report(`     · ${x.itfId} 의 ${x.field}: \`${x.alias}\` → \`${x.want}\``);
  }
  if (!verbose && fieldAliases.length > 5) report(`     · 외 ${fieldAliases.length - 5}건 (--verbose로 전부)`);
  report('     → 표준 이름은 **허용값 `values` · 필수 여부 `required`**입니다.');
  report('        소비자가 표준 이름만 읽으면 별칭으로 적힌 것은 **그 값이 없는 필드로 보입니다.**');
}

// ── 인터페이스 항목 단위 개정 ──────────────────────────────────────────────
// 계약 문서 하나에 인터페이스가 20개 넘게 살면, **문서 단위 `revision`으로는 소비자가 "내가 맞춘 판이
// 아직 유효한가"를 물을 수 없다.** 그렇다고 사람에게 항목마다 적으라고 하면 빈다(실측: 130건 중 117건이
// 근거를 한 줄만 적었고, 그걸 근거로 만든 검사의 "미해결 9건"이 전부 오탐이었다).
// 그래서 **스크립트가 계약 내용의 해시로 계산**하고, 사람은 **더 올릴 수만** 있다.
const REV_FILE = 'interface-revisions.json';
const revPath = path.join(root, REV_FILE);
// 개정 계산에 넣는 것은 **계약 내용뿐**이다. `basis`(근거)·`notes`·산문 위치는 바뀌어도 계약이 바뀐 게 아니다.
const CONTRACT_KEYS = ['id', 'transport', 'binding', 'method', 'path', 'auth', 'request', 'response', 'errors', 'async', 'idempotency'];
const canon = (v) => {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canon(v[k]);
    return o;
  }
  return v;
};
const itfHash = (i) => {
  const picked = {};
  for (const k of CONTRACT_KEYS) if (i[k] !== undefined) picked[k] = canon(i[k]);
  return 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(picked)).digest('hex');
};
const liveItf = [];
for (const doc of loaded) for (const o of doc.blocks) {
  if (o.__parseError) continue;
  for (const i of (o.interfaces || [])) liveItf.push({ id: i.id, hash: itfHash(i), stated: i.revision ?? null, doc: doc.path });
}
if (liveItf.length) {
  let snap = null;
  try { snap = JSON.parse(fs.readFileSync(revPath, 'utf8')); } catch { snap = null; }
  const prev = (snap && snap.interfaces) || {};
  const next = {};
  const bumped = [], fresh = [], lowered = [], raised = [];
  for (const x of liveItf) {
    const was = prev[x.id];
    // 계산 규칙: 없던 것 → 1 / 계약이 그대로 → 유지 / 계약이 바뀜 → +1.
    // **옛 세트를 채울 때 과거 이력을 지어내지 않는다** — 몇 번 고쳐졌든 지금을 1세대로 본다.
    let rev = !was ? 1 : (was.hash === x.hash ? was.revision : was.revision + 1);
    if (!was) fresh.push(x); else if (was.hash !== x.hash) bumped.push({ ...x, from: was.revision, to: rev });
    // 사람은 **더 올릴 수만** 있다 — 기계가 못 보는 변경(필드는 그대로인데 뜻이 바뀐 것)의 통로다.
    if (x.stated != null) {
      if (x.stated > rev) { raised.push({ ...x, to: x.stated }); rev = x.stated; }
      else if (x.stated < rev) lowered.push({ ...x, computed: rev });
    }
    next[x.id] = { revision: rev, hash: x.hash };
  }
  for (const x of lowered) {
    report(`  ❌ ${x.doc}: ${x.id} 의 revision ${x.stated} 가 계산값 ${x.computed} 보다 작습니다 — 개정은 내려가지 않습니다`);
    dead++;
  }
  const drift = bumped.length + fresh.length;
  if (syncRev) {
    const out = { generatedBy: 'check-docs', note: '인터페이스 항목 단위 개정 번호. 스크립트가 계산한다 — 손으로 고치지 말고, 올릴 일이 있으면 계약 문서의 interfaces[].revision 에 적으세요.', interfaces: next };
    fs.writeFileSync(revPath, JSON.stringify(out, null, 2) + '\n');
    report(`\n  ✅ ${REV_FILE} 기록 — 인터페이스 ${liveItf.length}건 (새로 ${fresh.length} · 개정 ${bumped.length} · 사람이 올림 ${raised.length})`);
  } else if (!snap) {
    report(`\n  ⚠ 항목 단위 개정 기록이 없습니다(${REV_FILE}) — 인터페이스 ${liveItf.length}건`);
    report('     소비자가 "내가 맞춘 판이 아직 유효한가"를 물을 자리가 없습니다.');
    report('     → `--sync-revisions` 를 한 번 돌리면 전부 **개정 1**로 시작합니다.');
    report('        (과거 이력은 지어내지 않습니다 — 몇 번 고쳐졌든 지금을 1세대로 봅니다.)');
    if (checkRev) problems.push('revision');
  } else if (drift) {
    report(`\n  ⚠ 개정 번호가 지금 계약과 어긋납니다 — 기록되지 않은 변경 ${drift}건`);
    for (const x of bumped.slice(0, CAP(bumped.length))) report(`     · ${x.id} — 계약이 바뀌었습니다 (개정 ${x.from} → ${x.to})`);
    for (const x of fresh.slice(0, CAP(fresh.length))) report(`     · ${x.id} — 기록에 없는 새 인터페이스 (개정 1)`);
    if (!verbose && drift > 5) report(`     · 외 ${drift - 5}건 (--verbose로 전부)`);
    report('     → `--sync-revisions` 로 기록을 갱신하세요. 소비자는 이 파일로 판이 유효한지 봅니다.');
    if (checkRev) problems.push('revision');
  } else {
    report(`\n  ✅ 항목 단위 개정 ${liveItf.length}건 — 기록과 일치` + (raised.length ? ` (사람이 올린 것 ${raised.length}건 포함)` : ''));
  }
}

report(`  참조 ${refChecked}건 확인, 죽은 링크 ${dead}건` + (refChecked === 0 ? ' (참조를 담은 문서 없음)' : ''));
if (dead) problems.push('deadlink');

// 같은 데이터를 여러 화면이 쓰는 것은 정상이다(변수는 참조일 뿐이고, 원본은 데이터 모델 하나다).
// 다만 **보내고 받는 것이 똑같은 요구가 여러 화면에 흩어져 있으면** 백엔드에서 인터페이스 하나로
// 묶을 후보다(`basis`가 배열인 이유). **자동으로 묶지 않는다** — 변수가 같아도 다른 일일 수 있고,
// 달라도 같은 일일 수 있다. 후보만 짚고 판단은 사람/LLM에 남긴다.
// 완전히 같지 않아도 **한쪽이 다른 쪽에 포함되면** 기존 인터페이스를 그대로 쓸 수 있다
// (받는 값 5개 중 4개만 쓰는 화면에 새 인터페이스를 만들 이유가 없다). 그 후보를 짚어 준다.
// 여기서도 **자동으로 합치지 않는다** — 권한·정책·의미 요건이 다르면 묶으면 안 되고, 그 판단은 백엔드 몫이다.
function subsetCandidates(list) {
  const key = (x) => ({ s: new Set(x.sends || []), r: new Set(x.receives || []) });
  const sub = (a, b) => [...a].every((v) => b.has(v));
  const out = [];
  for (const small of list) {
    const ks = key(small);
    if (ks.r.size === 0 && ks.s.size === 0) continue;          // 빈 요구는 아무 데나 포함돼 노이즈만 낸다
    if (authKey(small) === null) continue;                     // 인증 요건 미분류 → 재사용 판단 불가
    for (const big of list) {
      if (small === big || small.screen === big.screen) continue;
      // **권한이 다르면 재사용 후보가 아니다.** 넓은 쪽 인터페이스로 좁은 쪽을 덮으면 그 순간 열린다.
      if (authKey(big) === null || authKey(big) !== authKey(small)) continue;
      const kb = key(big);
      if (ks.r.size === kb.r.size && ks.s.size === kb.s.size) continue;   // 완전 일치는 sameShape가 본다
      if (!sub(ks.r, kb.r) || !sub(ks.s, kb.s)) continue;
      out.push({
        reuse: big.id || `${big.screen}#${big.action}`,
        forNeed: small.id || `${small.screen}#${small.action}`,
        extra: [...kb.r].filter((v) => !ks.r.has(v)),
      });
    }
  }
  return out;
}

// **권한이 다르면 묶으면 안 된다** — 백엔드 스킬이 묶기 금지 신호 1번으로 둔 것이다(묶으면 넓은 쪽으로
// 열려 정보가 샌다). 지금까지 그 재료가 요구에 없어 기계는 볼 수 없었고, 판단이 전부 사람에게 넘어갔다.
// `auth`가 생겼으니 **권한이 다른 것은 애초에 후보로 올리지 않는다.**
// 미분류(`auth` 없음)는 "같다"고 볼 수 없으므로 **자기들끼리도 안 묶는다** — 그래야 모르는 것을 아는 척하지 않는다.
function authKey(x) {
  if (!x.auth || typeof x.auth.required !== 'boolean') return null;      // 미분류 → 비교 불가
  return JSON.stringify([x.auth.required, [...(x.auth.roles || [])].sort(), x.auth.note ?? null]);
}
function sameShapeGroups(list) {
  const by = new Map();
  for (const x of list) {
    const ak = authKey(x);
    if (ak === null) continue;                                            // 미분류는 묶기 판단에서 뺀다
    const key = JSON.stringify([[...(x.sends || [])].sort(), [...(x.receives || [])].sort(), ak]);
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(x);
  }
  return [...by.values()]
    .filter((g) => g.length > 1 && new Set(g.map((x) => x.screen)).size > 1)
    .map((g) => ({
      sends: g[0].sends || [], receives: g[0].receives || [],
      refs: g.map((x) => x.id || `${x.screen}#${x.action}`),
      screens: [...new Set(g.map((x) => x.screen))],
    }));
}

// ── 서버 요구 목록 추출 (--emit-needs) ──
// 화면 동작(`data.io`)에는 요구가 이미 **구조화돼** 있다 — 방향(target)·보내고 받는 변수(데이터 모델
// 실재 변수로 검증됨)·트리거 UI·소속 화면. 그래서 "무엇이 서버에 필요한가"의 목록은 **LLM 판단 없이
// 기계로 전수 추출**된다. 백엔드 설계는 이걸 입력으로 받으면 빠뜨릴 수가 없다.
//
// **파일로 저장하지 않는다.** 이건 언제든 재생성 가능한 읽기 전용 파생물이라, 문서로 굳히면
// 화면과 이중 기입이 되어 조용히 어긋난다(세트가 `usedIn`을 뺀 것과 같은 이유).
//
// 정직한 한계: **의미 요건**(예: "자격 오류 시 어느 쪽이 틀렸는지 특정하지 않는다")과 **동작 단위 정책
// 링크**는 산문에만 있어 여기 안 담긴다 — 그건 사람/LLM이 화면 산문에서 읽어야 한다.
if (emitNeeds) {
  const covered = new Map();
  for (const b of beBasis) if (b.kind === 'screen-io') {
    if (!covered.has(b.ref)) covered.set(b.ref, []);
    covered.get(b.ref).push(b.itfId);
  }
  const needs = screenIo
    .filter((x) => (x.target ? String(x.target).split('.')[0] : null) === 'server')
    .map((x) => ({
      id: x.id, screen: x.screen, action: x.action, target: x.target,
      ui: x.ui ?? null, auth: x.auth ?? null, sends: x.sends ?? [], receives: x.receives ?? [],
      ...(x.transientSends && x.transientSends.length ? { transientSends: x.transientSends } : {}),
      ...(x.transientReceives && x.transientReceives.length ? { transientReceives: x.transientReceives } : {}),
      policies: x.policies ?? [], semantics: x.semantics ?? null,
      ...(x.frame ? { frame: x.frame, appliesTo: x.appliesTo ?? null } : {}),
      doc: x.doc, coveredBy: covered.get(x.id) ?? [],
    }));
  const untargeted = screenIo.filter((x) => !x.target).length;
  console.log(JSON.stringify({
    needs,
    note: '화면 동작에서 기계 추출한 서버 요구 목록(읽기 전용 파생물 — 파일로 저장하지 말 것).',
    limits: '`policies`·`semantics`가 비어 있으면 화면 산문에 있는 것을 블록이 안 담은 것일 수 있다(손실 미러) — 그 경우 백엔드가 오류 근거·멱등·정렬을 정할 근거가 없다.',
    untargeted,
    sameShape: sameShapeGroups(needs),
    subsetReuse: subsetCandidates(needs),
  }, null, 2));
  process.exit(0);
}

// ── 인터페이스 요청서 생성 (--emit-interface-request) ──
// **층 분리를 위한 산출물이다.** 백엔드가 프론트의 화면 설계서를 뒤지는 대신, 프론트가 "우리가 필요한 건
// 이것"을 파일로 넘긴다. 내용은 화면 동작에서 기계로 뽑으므로 사람이 옮겨 적지 않는다.
// 이 문서는 SSOT가 아니라 **재생성 가능한 파생물**이고, 출처 스냅샷(`from`)이 있어 낡으면 점검기가 잡는다.
if (emitReq) {
  const SLOTS = {
    rest: ['method', 'path', 'status'], grpc: ['service', 'rpc', 'requestMessage', 'responseMessage'],
    graphql: ['operationType', 'fieldName'], ws: ['channel', 'event'], queue: ['topic', 'key', 'deliveryGuarantee'],
  };
  // **범위(scope)는 필수다.** 빼면 사용자 앱과 백오피스 요구가 한 목록에 섞이고, 그러면 아래 묶기 후보가
  // **권한 경계를 넘는 묶기**를 제안한다(백엔드가 그걸 묶으면 넓은 쪽으로 열려 정보가 샌다).
  if (!reqScope) {
    console.error('❌ --scope 가 필요합니다 (예: --scope user). 범위를 섞으면 권한이 다른 요구가 한 파일에 담깁니다.');
    process.exit(2);
  }
  const inScope = screenIo.filter((x) => (x.target ? String(x.target).split('.')[0] : null) === 'server'
    && (x.doc.includes(`/${reqScope}/`) || x.doc.includes(`-${reqScope}-`)));
  // 요청서의 입자는 **출처 화면 문서의 입자**를 따른다 — 화면은 문서가 아니라 문서 안의 절이라
  // `revision`·`contentHash`가 없다. 문서 1개당 요청서 1개여야 "어느 요청서가 낡았나"가 정확해진다.
  // 프레임 동작은 **화면 도메인에 속하지 않는다** — 출처가 index 문서 하나이므로 도메인 `frame`으로 모은다.
  // (요청서의 입자 규칙 "출처 문서 1개당 요청서 1개"가 그대로 유지된다.)
  const domainOf = (p, x) => {
    if (x && x.frame) return 'frame';
    const base = p.split('/').pop().replace(/\.md$/, '');
    const m = new RegExp(`^screen-design-${reqScope}-(.+)$`).exec(base);
    return m ? m[1] : base;
  };
  const byDomain = new Map();
  for (const x of inScope) {
    const d = domainOf(x.doc, x);
    if (!byDomain.has(d)) byDomain.set(d, []);
    byDomain.get(d).push(x);
  }
  if (listDomains) {
    // 서버 요구가 **0건인 도메인은 나오지 않는다** — 요청서를 만들지 않는 게 맞다(빈 인계물은 노이즈다).
    for (const d of [...byDomain.keys()].sort()) console.log(d);
    process.exit(0);
  }
  if (!reqDomain) {
    console.error(`❌ --domain 이 필요합니다. 이 범위의 도메인: ${[...byDomain.keys()].sort().join(' · ') || '(서버 요구 없음)'}`);
    console.error('   (요청서는 출처 화면 문서 1개당 1개다. 목록은 --list-domains 로 얻어 돌면서 뽑으세요.)');
    process.exit(2);
  }
  const picked = byDomain.get(reqDomain) || [];
  if (!picked.length) {
    console.error(`❌ ${reqScope}/${reqDomain} 에 서버 요구가 없습니다 — 요청서를 만들지 않습니다.`);
    process.exit(2);
  }
  const fromDocs = [...new Set(picked.map((x) => x.doc))].sort().map((p) => {
    const c = cur.get(p) || {};
    return c.revision == null ? { path: p, contentHash: c.hash } : { path: p, revision: c.revision, contentHash: c.hash };
  });
  const block = {
    generatedAt: new Date().toISOString().slice(0, 10),
    generatedWith: TOOL_VERSION,
    scope: reqScope, domain: reqDomain,
    ...(reqTransport ? { preferredTransport: reqTransport, bindingSlots: SLOTS[reqTransport] || [] } : {}),
    from: fromDocs,
    requests: picked.map((x) => ({
      ref: x.id || `${x.screen}#${x.action}`, screen: x.screen, action: x.action,
      ...(x.target ? { target: x.target } : {}), ...(x.ui ? { ui: x.ui } : {}),
      ...(x.auth ? { auth: x.auth } : {}),
      sends: x.sends || [],
      ...(x.transientSends && x.transientSends.length ? { transientSends: x.transientSends } : {}),
      receives: x.receives || [],
      ...(x.transientReceives && x.transientReceives.length ? { transientReceives: x.transientReceives } : {}),
      ...(x.policies && x.policies.length ? { policies: x.policies } : {}),
      ...(x.semantics ? { semantics: x.semantics } : {}),
      // 프레임 동작은 **한 화면이 아니라 걸리는 모든 화면에서** 일어난다. 이 표시가 없으면 백엔드가
      // 개별 화면의 조회로 오해해 호출 빈도·캐시·세션 저장소를 잘못 잡는다.
      ...(x.frame ? { frame: x.frame, ...(x.appliesTo ? { appliesTo: x.appliesTo } : {}) } : {}),
    })),
  };
  // frontmatter 두 가지에 주의.
  // ① `schema`는 **자기 옆 `schemas/`를 가리키는 상대 경로**다. 세트 루트에서 몇 단계 아래에 두든
  //    그대로 맞으려면 사본이 문서 옆에 있어야 한다(화면 설계서가 `screens/{scope}/schemas/`를 두는 것과 같은 규칙).
  //    스킬이 요청서를 낼 때 `interface-requests/<범위>/schemas/`로 스키마를 복사한다.
  //    ※ 사본이 없으면 점검기가 `❌ 스키마 로드 실패`를 내는데, **그 블록은 이후 검사에서 통째로 빠진다**
  //      (죽은 링크·낡음·옛 배치 전부 침묵). 경고 뒤의 조용한 통과라 가장 위험하다.
  // ② `revision`은 생성물이라 **늘 1세대**다. 없으면 점검기가 "업그레이드 필요"로 잡는다.
  const out = [
    '---', 'doc_type: interface-request', 'version: 1', 'revision: 1', 'ssot: prose', 'machine:', '  lang: json',
    '  tag: interface.requests', '  item: request-list', '  schema: schemas/interface-request.v1.schema.json',
    '---', '',
    `# 인터페이스 요청서 — ${reqScope} / ${reqDomain}${reqDomain === 'frame' ? ' (공통 프레임)' : ''} (${block.generatedAt} 생성)`, '',
    '> **프론트가 백엔드에 넘기는 요구 목록입니다.** 화면 설계서의 동작에서 **기계로 생성**했으니 손으로 고치지 마세요 —',
    '> 화면을 고치고 다시 생성하면 됩니다. 이 문서는 SSOT가 아니라 파생물이고, 화면과 어긋나면 **화면이 이깁니다.**',
    reqTransport
      ? `> 전송은 \`${reqTransport}\`를 **희망**합니다(확정 아님 — 백엔드가 정하고, 다르면 사유를 남깁니다). 백엔드가 채울 자리: ${(SLOTS[reqTransport] || []).join(' · ')}`
      : '> 전송 방식은 백엔드가 정합니다.',
    '', `요구 ${block.requests.length}건 · 출처 문서 ${fromDocs.length}개`, '',
    ...(reqDomain === 'frame'
      ? ['> **이 요청서는 공통 프레임(화면들을 감싸는 껍데기)의 요구입니다.**', '',
         '> 아래 동작은 한 화면이 아니라 **그 껍데기가 걸리는 모든 화면에서** 일어납니다.',
         '> 화면 수만큼 불린다고 보고 호출 빈도·캐시·세션 저장소를 정하세요. `appliesTo`에 예외 화면이 있으면',
         '> 그 화면에서는 일어나지 않습니다(대개 로그인 화면 — 안 빼면 "로그인하려면 세션이 있어야 한다"가 됩니다).', '']
      : []),
    '| 동작 | 화면/프레임 | 인증 | 보냄 | 일회성 입력 | 받음 | 일회성 결과 | 정책 | 행동 규약 |', '|---|---|---|---|---|---|---|---|---|',
    ...block.requests.map((r) => {
      // 인증 요건은 **백엔드가 계약(auth.mode·checks)을 정하는 근거**다. 미분류를 빈칸으로 두면
      // "인증 불필요"로 읽히므로 **미분류라고 적는다**.
      const au = !r.auth ? '**미분류**'
        : (r.auth.required ? `필요${(r.auth.roles || []).length ? ` (${r.auth.roles.join('·')})` : ''}` : '불필요')
          + (r.auth.note ? ` — ${r.auth.note}` : '');
      return `| \`${r.ref}\` | ${r.screen} | ${au} | ${(r.sends || []).join(', ') || '—'} | ${(r.transientSends || []).map((t) => `${t.name}(${t.desc})`).join(', ') || '—'} | ${(r.receives || []).join(', ') || '—'} | ${(r.transientReceives || []).map((t) => `${t.name}(${t.desc})`).join(', ') || '—'} | ${(r.policies || []).join(', ') || '—'} | ${r.semantics || '—'} |`;
    }),
    '',
    ...(() => {
      // **묶기 후보는 범위 전체로 계산한다.** 이 계산의 존재 이유가 "화면(그리고 대개 도메인)을 가로지르는
      // 중복 찾기"라, 도메인 안만 보면 `IO.auth.*`와 `IO.mypage.*`의 중복이 **조용히** 사라진다.
      // 계산은 넓게, 싣는 것은 **이 도메인과 얽힌 것만** — 그래야 도메인 담당자가 남의 목록을 읽지 않는다.
      const mine = new Set(block.requests.map((r) => r.ref));
      const label = (x) => x.id || `${x.screen}#${x.action}`;
      const wide = inScope.map((x) => ({ ...x, ref: label(x) }));
      const g = sameShapeGroups(wide).filter((x) => x.refs.some((r) => mine.has(r)));
      const sub = subsetCandidates(wide).filter((x) => mine.has(x.forNeed) || mine.has(x.reuse)).slice(0, 20);
      // 상대가 어느 도메인 파일에 있는지 붙인다 — 이 목록은 파일 밖을 가리키므로, 어디를 열어야 하는지
      // 말해 주지 않으면 받는 쪽이 찾아 헤맨다.
      const domOfRef = new Map(wide.map((x) => [x.ref, domainOf(x.doc, x)]));
      const at = (r) => (mine.has(r) ? '' : ` (${domOfRef.get(r) || '?'})`);
      const mark = (r) => '`' + r + '`' + at(r);
      const lines = [];
      if (sub.length) {
        lines.push('## 기존 인터페이스로 덮을 수 있는 후보 (한쪽이 다른 쪽에 포함됨)', '',
          '> 받는 값이 더 많은 요구를 이미 처리한다면, **적게 쓰는 화면에 새 인터페이스를 만들 필요가 없습니다.**',
          '> 권한·정책·의미 요건이 다르면 묶으면 안 되니, **판단은 백엔드 몫**입니다.',
          '> 괄호는 **그 요구가 사는 다른 도메인 요청서**입니다(이 범위 전체를 보고 찾은 후보입니다).', '',
          ...sub.map((x) => `- ${mark(x.forNeed)} 는 ${mark(x.reuse)} 로 덮을 수 있음 (더 오는 값: ${x.extra.join(', ') || '없음'})`), '');
      }
      return g.length
        ? [...lines, '## 하나로 묶을 후보 (보내고 받는 것이 같은 요구)', '',
           '> 여러 화면이 같은 데이터를 주고받고 있습니다. 백엔드에서 **인터페이스 하나로 묶을 수 있습니다**',
           '> (`basis`에 여럿을 적으면 됩니다). **판단은 백엔드 몫**입니다 — 변수가 같아도 다른 일일 수 있습니다.',
           '> 괄호는 **그 요구가 사는 다른 도메인 요청서**입니다.', '',
           ...g.map((x) => `- ${x.refs.map(mark).join(' · ')} — 보냄 ${x.sends.join(', ') || '—'} / 받음 ${x.receives.join(', ') || '—'}`), '']
        : lines;
    })(),
    '```json interface.requests', JSON.stringify(block, null, 2), '```', '',
  ].join('\n');
  // **재생성은 손으로 적은 것을 지운다.** 요청서는 파생물이라 통째로 다시 만들어지는데, 계약 문서는
  // 손질하는 곳이라 성질이 반대다 — 같은 규약으로 덮으면 **요청서 쪽에서만 조용히 샌다**(실사용 제보:
  // 스키마에 없는 키를 손으로 넣었는데 다음 생성 때 사라졌다). 지우기 전에 **무엇이 지워지는지 알린다.**
  const outPath = path.join(root, 'interface-requests', reqScope, `interface-request-${reqScope}-${reqDomain}.md`);
  if (fs.existsSync(outPath)) {
    try {
      const oldTxt = fs.readFileSync(outPath, 'utf8');
      const m = /```json\s+interface\.requests\n([\s\S]*?)```/.exec(oldTxt);
      const oldBlock = m ? JSON.parse(m[1]) : null;
      if (oldBlock && Array.isArray(oldBlock.requests)) {
        // 생성기가 **낼 수 있는 키**의 집합. 여기 없는 키가 옛 파일에 있으면 사람이 손으로 넣은 것이다.
        const emitted = new Set();
        for (const r of block.requests) for (const k of Object.keys(r)) emitted.add(k);
        for (const k of ['ref', 'screen', 'action', 'target', 'ui', 'auth', 'sends', 'transientSends',
                         'receives', 'transientReceives', 'policies', 'semantics', 'frame', 'appliesTo']) emitted.add(k);
        const lost = [];
        const byRef = new Map(block.requests.map((r) => [r.ref, r]));
        for (const r of oldBlock.requests) {
          for (const k of Object.keys(r)) if (!emitted.has(k)) lost.push({ ref: r.ref, key: k });
          if (!byRef.has(r.ref)) lost.push({ ref: r.ref, key: '(요구 자체)' });
        }
        if (lost.length) {
          console.error(`⚠ 재생성이 지웁니다 — 지금 파일에만 있는 것 ${lost.length}건 (${outPath.replace(root + '/', '')})`);
          for (const x of lost.slice(0, CAP(lost.length))) console.error(`   · ${x.ref} 의 ${x.key}`);
          if (!verbose && lost.length > 5) console.error(`   · 외 ${lost.length - 5}건 (--verbose로 전부)`);
          console.error('   → 요청서는 **파생물**이라 손으로 적으면 다음 생성 때 사라집니다.');
          console.error('      남겨야 할 내용이면 **원본(화면 설계서)에 적고** 다시 뽑으세요.');
          console.error('      "(요구 자체)"는 화면에서 그 동작이 없어졌거나 `target`이 서버가 아니게 된 것입니다.');
        }
      }
    } catch { /* 옛 파일을 못 읽으면 알림만 못 낼 뿐, 생성은 막지 않는다 */ }
  }
  console.log(out);
  process.exit(0);
}

// ── 요구 → 계약 커버리지 (백엔드 문서가 있을 때만) ──
// io는 서버 통신 전용이 아니다. `target`의 첫 마디로 갈래를 판정하고, server인 것만 대조한다.
if (screenIo.length) {
  const kindOf = (t) => (t ? String(t).split('.')[0] : null);
  const covered = new Set(beBasis.filter((b) => b.kind === 'screen-io').map((b) => b.ref));
  const serverIo = screenIo.filter((x) => kindOf(x.target) === 'server');
  const untargeted = screenIo.filter((x) => !x.target);
  const withOp = screenIo.filter((x) => x.op);
  const quals = new Map();
  for (const x of screenIo) {
    if (!x.target || !x.target.includes('.')) continue;
    quals.set(x.target, (quals.get(x.target) || 0) + 1);
  }
  if (be.itf.size) {
    const missed = serverIo.filter((x) => !(x.id && covered.has(x.id)) && !covered.has(`FEAT.${x.screen}#${x.action}`));
    if (missed.length) {
      report(`\n  ⚠ 덮이지 않은 요구 ${missed.length}건 — 서버와 주고받는 동작인데 어느 인터페이스의 basis에도 없음`);
      for (const m of missed.slice(0, CAP(missed.length))) report(`     · ${m.id || `${m.screen}#${m.action}`} (${m.doc})`);
      if (!verbose && missed.length > 5) report(`     · 외 ${missed.length - 5}건 (--verbose로 전부)`);
    } else {
      report(`\n  ✅ 요구 커버리지: server 동작 ${serverIo.length}건 모두 basis에 담김`);
    }
  }
  // 보여준다고 했는데 아무도 가져오지 않는 값 — **빠진 조회 요구**의 신호.
  // 오탐이 있다(정적 문구·앞 화면에서 넘어온 값·화면에서 계산하는 값). 그래서 오류가 아니라 정보 층이고,
  // 판단은 사람·LLM이 한다 — 묶기 후보와 같은 취급이다. 다만 **조용히 두지는 않는다.**
  if (unfetchedDisplay.length) {
    const n = unfetchedDisplay.reduce((a, x) => a + x.vars.length, 0);
    report(`  ⚠ 보여준다고 했는데 아무 동작도 가져오지 않는 데이터 ${n}건 (화면 ${unfetchedDisplay.length}개) — 조회 요구가 빠졌을 수 있다`);
    for (const x of unfetchedDisplay.slice(0, CAP(unfetchedDisplay.length))) {
      report(`     · ${x.screen} — ${x.vars.slice(0, 4).join(', ')}${x.vars.length > 4 ? ` … (${x.vars.length}건)` : ''}`);
    }
    if (!verbose && unfetchedDisplay.length > 5) report(`     · 외 화면 ${unfetchedDisplay.length - 5}개 (--verbose로 전부)`);
    report('     → 화면 산문의 **"화면에 들어오면 일어나는 일"**을 `io`에 진입 로드로 담으세요(target: server).');
    report('        빠지면 그 화면은 인터페이스 요청서에 한 줄도 안 나가고, 백엔드는 그 조회가 없는 줄 압니다.');
    report('     → 정적 문구·앞 화면에서 받은 값·화면에서 계산하는 값이면 그대로 두고, 산문에 어디서 오는지 한 줄 밝히세요.');
  }
  // 위 검사와 **다른 것을 본다.** 위는 "이 값을 아무도 안 가져온다", 이건 "이 화면에 진입 조회가 아예 없다".
  // 변경 동작의 응답이 값을 덮으면 위는 0이 되지만 이건 그대로 잡힌다 — 실측에서 그 차이가 두 화면을 살렸다.
  if (noEntryLoad.length) {
    report(`  ⚠ 데이터를 보여주는데 **진입 로드가 하나도 없는 화면** ${noEntryLoad.length}개 — 조회 요구가 빠졌을 수 있다`);
    for (const x of noEntryLoad.slice(0, verbose ? noEntryLoad.length : 5)) {
      report(`     · ${x.screen} — 보여주는 값 ${x.shown}개, 진입 로드 0건 (${x.doc})`);
    }
    if (!verbose && noEntryLoad.length > 5) report(`     · 외 ${noEntryLoad.length - 5}개 (--verbose로 전부)`);
    report('     → 승인·저장 같은 **변경 동작의 응답**은 조회가 아니다. 화면을 열 때 서버에서 가져오는 것을 따로 적으세요.');
    report('        (`IO.<도메인>.<화면>.load` · `target: server` · `ui` 없음)');
    report('     → 앞 화면에서 받은 값만 보여주는 화면이면 그대로 두고, 산문에 그 사실을 한 줄 밝히세요.');
  }
  // **`auth`는 server 동작에 필수다.** 스키마에 `if/then`이 없어 조건부 required를 못 걸므로 여기서 강제한다
  // (화면 이동·정렬 토글까지 요구하면 소음이라 범위를 server로 한정한다).
  // 없다고 **"인증 불필요"로 간주하지 않는다** — 그러면 안 쓴 것과 "불필요라고 쓴 것"이 구분되지 않고,
  // 실측에서 운영자 전용 27건이 정확히 반대로 읽힐 뻔했다(청구 목록·상품 노출 토글 등).
  const noAuth = serverIo.filter((x) => !x.auth || typeof x.auth.required !== 'boolean');
  if (noAuth.length) {
    report(`  ❌ 인증 요건(\`auth\`)이 없는 서버 동작 ${noAuth.length}건 — 누가 쓸 수 있는지가 요청서에서 빠진다`);
    for (const x of noAuth.slice(0, CAP(noAuth.length))) {
      report(`     · ${x.id || `${x.screen}#${x.action}`} (${x.screen})`);
    }
    if (!verbose && noAuth.length > 5) report(`     · 외 ${noAuth.length - 5}건 (--verbose로 전부)`);
    report('     → `auth: { required: true|false }`를 적으세요. 특정 역할만 쓰면 `roles`도 함께.');
    report('        **방식(토큰·세션·모드)은 적지 않습니다** — 그건 백엔드가 정할 계약이고, 여기는 요구입니다.');
    report('     → 판단이 안 서면 지어내지 말고 산문에 `[확인 필요: 이 동작의 권한]`을 남기세요.');
    dead++;
  }
  if (untargeted.length) {
    report(`  ⚠ \`target\` 미분류 동작 ${untargeted.length}건 — **업그레이드 필요**(server/local/client 판정)`);
    report('     → 없으면 백엔드가 로컬 저장까지 서버 인터페이스로 잘못 도출한다. 화면 설계 스킬의 버전업(gap-fill)으로 채우세요.');
  }
  // 정책·의미 요건이 하나도 없는 서버 동작은 **화면 산문에 있는데 블록이 안 담았을** 수 있다(손실 미러).
  // 정말 없을 수도 있으므로 오류가 아니라 정보로 알린다 — 백엔드가 오류 근거·멱등을 정할 재료가 그만큼 없다.
  const bare = serverIo.filter((x) => !(x.policies || []).length && !x.semantics);
  if (bare.length) {
    report(`  · 정책·행동 규약이 비어 있는 서버 동작 ${bare.length}건 — 화면 산문에 있는데 안 담긴 것인지 확인하세요`);
    report('     (없으면 그대로 두면 된다. 있는데 안 담기면 백엔드가 오류 근거·멱등·정렬을 정할 재료가 없다)');
  }
  if (withOp.length) {
    report(`  ⚠ 폐기된 \`data.io[].op\` ${withOp.length}건 — **이관 필요**(백엔드 인터페이스 계약의 basis로 옮기고 비우세요)`);
  }
  if (quals.size) {
    report(`  · target 한정자: ${[...quals.entries()].map(([k, v]) => `${k} ${v}건`).join(' · ')}`);
    report('     (한정자 등기부는 아직 없다 — 표기가 갈렸으면 통일하세요)');
  }
}

// 프레임 블록이 없는 index — 껍데기 동작(세션 조회·로그아웃)을 담을 자리가 없다는 뜻이다.
// 옛 세트에는 이 블록 자체가 없으므로 **업그레이드 신호**이자 상설 신호다.
{
  const idxDocs = allDocs.filter((d) => d.docType === 'screen-design-index');
  const withFrame = new Set(loaded.filter((d) => d.blocks.some((o) => Array.isArray(o.frames))).map((d) => d.path));
  const bare = idxDocs.filter((d) => !withFrame.has(d.path));
  if (bare.length) {
    report(`  ⚠ 공통 프레임 블록이 없는 화면 설계 index ${bare.length}개 — 껍데기 동작이 빠졌을 수 있다`);
    for (const d of bare.slice(0, CAP(bare.length))) report(`     · ${d.path}`);
    if (!verbose && bare.length > 5) report(`     · 외 ${bare.length - 5}개 (--verbose로 전부)`);
    report('     → GNB·LNB·상단바에도 서버와 주고받는 일이 있습니다(세션 조회·로그아웃·워크스페이스 전환).');
    report('        어느 화면 것도 아니라 지금은 **요청서에 한 줄도 안 나갑니다.** index에 `screendesign.frame` 블록을 채우세요.');
    report('     → 껍데기에 서버 동작이 정말 없으면 `frames[].data.io: []`로 명시하세요(생각했음을 남깁니다).');
  }
}

if (frameIdDrift.length) {
  report(`  ⚠ 소유 프레임과 어긋난 동작 id ${frameIdDrift.length}건 — **이관 필요**(앞 두 마디가 소속을 드러내야 한다)`);
  for (const x of frameIdDrift.slice(0, CAP(frameIdDrift.length))) {
    report(`     · ${x.id} (${x.frame}) → ${x.want}`);
  }
  if (!verbose && frameIdDrift.length > 5) report(`     · 외 ${frameIdDrift.length - 5}건 (--verbose로 전부)`);
  report('     → 0.10.0의 `IO.frame.<이름>.*` 예시에는 **범위가 빠져 있었다.** 사용자 앱과 백오피스가 둘 다');
  report('        껍데기를 `shell`이라 부르면 양쪽이 같은 id가 되어 요청서·백엔드 basis가 엉뚱한 동작에 붙는다.');
  report('     → id를 바꾸면 백엔드 계약의 `basis`가 그 id를 가리키던 것이 죽은 링크로 잡힌다 — 함께 고치세요.');
}

// IA를 범위별로 나눴는데 **다른 범위의 기능이 섞여 있으면** 소유자를 1:1로 만들려던 뜻이 깨진다
// (그 파일을 두 팀이 다시 함께 고치게 된다). 판정 근거는 파일명이 아니라 블록의 `audience`다.
// 파일명에 범위 표시가 없으면(단일 IA) 아무 말도 하지 않는다 — 나누지 않은 세트는 대상이 아니다.
{
  const SCOPE_OF = [[/-user\b/, 'user'], [/-backoffice\b|-admin\b/, 'admin']];
  const mixed = [];
  for (const x of featAudience) {
    const base = x.doc.split('/').pop();
    const hit = SCOPE_OF.find(([re]) => re.test(base));
    if (!hit) continue;                                  // 범위를 안 밝힌 파일 → 판정 대상 아님
    if (x.audience !== hit[1]) mixed.push({ ...x, want: hit[1] });
  }
  if (mixed.length) {
    report(`  ⚠ 범위와 어긋난 기능 ${mixed.length}건 — 나눈 IA에 다른 범위가 섞였다`);
    for (const x of mixed.slice(0, CAP(mixed.length))) {
      report(`     · ${x.id} (audience: ${x.audience}) 가 ${x.doc} 에 있음 — 이 파일은 ${x.want}`);
    }
    if (!verbose && mixed.length > 5) report(`     · 외 ${mixed.length - 5}건 (--verbose로 전부)`);
    report('     → 범위별로 나눈 뜻은 **소유자를 1:1로 만드는 것**입니다. 섞이면 두 팀이 같은 파일을 다시 고칩니다.');
    report('     → `audience` 값이 정본입니다. 그 값에 맞는 파일로 옮기세요(`FEAT` id는 바꾸지 않습니다).');
  }
}

// 화면 문서가 없는 세트(요청서만 넘겨받은 리포 등)에서도 알려야 하므로 위 화면 검사 밖에 둔다.
if (oldLayoutReq.length) {
  report(`  ⚠ 옛 배치(범위 통짜) 인터페이스 요청서 ${oldLayoutReq.length}건 — **다시 뽑기 필요**`);
  for (const p of oldLayoutReq.slice(0, CAP(oldLayoutReq.length))) report(`     · ${p}`);
  if (!verbose && oldLayoutReq.length > 5) report(`     · 외 ${oldLayoutReq.length - 5}건 (--verbose로 전부)`);
  report('     → 요청서는 출처 화면 문서 1개당 1개다. 통짜면 화면 하나만 고쳐도 전체가 낡음이 되어 어디가 낡았는지 모른다.');
  report('     → interface-requests/<범위>/ 아래 도메인별로 다시 뽑고(--scope·--domain), 옛 파일을 지운 뒤 색인을 갱신하세요.');
}

// ── 3차: 파장·신선도 (상위 결정이 바뀌었는데 하류가 안 따라갔나) ──
// 죽은 링크가 "가리킨 것이 실재하나"라면, 이 검사는 **"바뀐 것을 따라갔나"**를 본다.
// 산문에만 있는 결정은 ID 참조가 없어 원리적으로 죽은 링크로 안 잡히므로, 파장 지도 + 리뷰 스냅샷으로 본다.
// 경고 층이다 — 오탐이 있을 수 있어 종료코드를 올리지 않고, 리뷰 산출물 갱신으로 해제된다.
report('\n[3] 파장 · 신선도');
{
  // 파장 지도(정본은 스킬 자산). 없으면 이 검사를 생략한다(무엇을 안 봤는지는 밝힌다).
  let mapDoc = null;
  try {
    mapDoc = JSON.parse(fs.readFileSync(path.join(SKILLS_ROOT, 'easyproduct-suite', 'assets', 'propagation-map.json'), 'utf8'));
  } catch { /* 스킬 자산을 못 읽는 환경 */ }

  if (!mapDoc) {
    report('  · 파장 지도를 찾을 수 없어 생략(스킬 자산 밖에서 실행 중)');
  } else {
    // docType → 실제 경로들. 매니페스트에 derivesFrom 예외가 있으면 그 문서만 덮어쓴다.
    const pathsOfType = new Map();
    for (const d of allDocs) {
      if (!pathsOfType.has(d.docType)) pathsOfType.set(d.docType, []);
      pathsOfType.get(d.docType).push(d.path);
    }
    const overrideOf = new Map(docs.filter(d => Array.isArray(d.derivesFrom)).map(d => [d.path, d.derivesFrom]));

    // 상류 경로 → 하류 경로 목록
    const downstream = new Map();
    const addEdge = (up, down) => {
      if (up === down) return;
      if (!downstream.has(up)) downstream.set(up, new Set());
      downstream.get(up).add(down);
    };
    for (const d of allDocs) {
      const ups = overrideOf.get(d.path) ?? (mapDoc.derivesFrom[d.docType] || []).flatMap(t => pathsOfType.get(t) || []);
      for (const up of ups) addEdge(up, d.path);
    }

    // 최신 리뷰 산출물의 스냅샷(sources)을 기준선으로 삼는다.
    const reviews = loaded
      .filter(d => d.docType === 'review')
      .flatMap(d => d.blocks.filter(o => !o.__parseError).map(o => ({ path: d.path, snap: o })))
      .sort((a, b) => String(a.snap.reviewedAt).localeCompare(String(b.snap.reviewedAt)));
    const latest = reviews[reviews.length - 1] || null;
    const baseline = new Map();
    if (latest) for (const s of (latest.snap.sources || [])) baseline.set(s.path, s);


    if (printSnapshot) {
      // 리뷰 산출물을 쓸 때 붙일 sources 스냅샷을 그대로 출력한다(사람이 해시를 손으로 만들지 않게).
      const snap = [...cur.entries()].map(([p, v]) => (v.revision == null ? { path: p, contentHash: v.hash } : { path: p, revision: v.revision, contentHash: v.hash }));
      report('  스냅샷(리뷰 산출물의 sources에 붙여 넣으세요):');
      report(JSON.stringify(snap, null, 2).split('\n').map(l => '    ' + l).join('\n'));
    }

    // 지도에 없는 문서 종류는 상류로도 하류로도 안 잡힌다 — **조용히 파장 대상 밖**이 된다.
    // 프로젝트가 세트 표준 밖의 문서를 갖는 건 정상이지만(요청서·오픈이슈 등), 그 사실이 안 보이면
    // "이 문서는 파장을 안 탄다"를 아무도 모른 채 상류가 바뀌어도 따라가지 않는다.
    {
      const known = new Set(Object.keys(mapDoc.derivesFrom));
      for (const ups of Object.values(mapDoc.derivesFrom)) for (const u of ups) known.add(u);
      const unknown = new Map();
      for (const d of allDocs) {
        if (known.has(d.docType) || overrideOf.has(d.path)) continue;
        unknown.set(d.docType, (unknown.get(d.docType) || 0) + 1);
      }
      if (unknown.size) {
        report(`  ⚠ 파장 지도에 없는 문서 종류 ${unknown.size}종 — 이 문서들은 **파장 대상 밖**이다`);
        report(`     ${[...unknown.entries()].map(([t, c]) => `${t} ${c}건`).join(' · ')}`);
        // **오타·비슷한 이름을 먼저 의심하게 한다.** 세트 표준 이름과 한 글자 차이인 경우가 실제로 있다
        // (도그푸드에서 파일명이 `design-spec.md`라 `doc_type`도 `design-spec`으로 적었는데 정본은 `design-doc`이었다).
        for (const t of unknown.keys()) {
          const near = [...known].filter((k) => k !== t && (k.startsWith(t.split('-')[0] + '-') || t.startsWith(k.split('-')[0] + '-')));
          if (near.length) report(`     · \`${t}\` — 혹시 \`${near.join('` 또는 `')}\` 인가요? (이름이 비슷합니다)`);
        }
        report('     → 프로젝트 고유 문서면 매니페스트 항목에 `derivesFrom`(선택)으로 상류를 적어 주면 편입된다.');
        report('       세트 표준 문서인데 빠진 것이면 파장 지도(스킬 자산)를 고쳐야 한다.');
      }
    }

    // 옛 버전으로 만든 세트를 알아보고 **무엇을 해야 하는지** 알려 준다.
    // 이걸 집계해 보고하지 않으면 기존 세트는 "조용히 통과"하고, 새 기능(파장·신선도)을
    // 영원히 못 얻는다 — 새로 만드는 세트만 혜택을 보는 반쪽 릴리즈가 된다.
    {
      const noRev = allDocs.filter((d) => d.revision == null && !['doc-bundle-index', 'review'].includes(d.docType));
      if (noRev.length) {
        report(`  ⚠ \`revision\`(결정 개정 번호)이 없는 문서 ${noRev.length}개 — **업그레이드 필요**`);
        report(`     ${noRev.slice(0, CAP(noRev.length)).map((d) => d.path).join(', ')}${!verbose && noRev.length > 5 ? ` 외 ${noRev.length - 5}개 (--verbose로 전부)` : ''}`);
        report('     → 각 문서의 스킬 버전업(gap-fill)으로 `revision: 1`을 채우세요. 없으면 신선도 판정이 해시 단독이라 사소한 편집에도 경고가 뜹니다.');
      }
    }

    if (!latest) {
      report('  ⚠ 리뷰 산출물이 없습니다 — LLM 층(산문·미러 충실도, 파장 확인) **미실행**으로 봅니다.');
      report(`     기계 점검 통과는 "구조는 맞음"이지 "검증 완료"가 아닙니다. 템플릿: easyproduct-suite/assets/review-template.md`);
    } else {
      report(`  기준선: ${latest.path} (reviewedAt ${latest.snap.reviewedAt}, sources ${(latest.snap.sources || []).length}개)`);
      let stale = 0, unpinned = 0, silent = 0;
      for (const [up, downs] of [...downstream.entries()].sort()) {
        const c = cur.get(up); if (!c) continue;
        const b = baseline.get(up);
        if (!b) { unpinned++; continue; }
        const hashChanged = b.contentHash && b.contentHash !== c.hash;
        // 세 경우를 구분한다. 뭉뚱그리면 **엉뚱한 조치를 지시**하게 된다 —
        // 실제로 도그푸드에서 revision을 올렸는데도 "개정 번호 없이 수정됨"이라고 잘못 보고했다
        // (기준선 스냅샷에 revision이 없어서 비교가 불가능했던 것뿐인데).
        if (b.revision != null && c.revision != null && b.revision !== c.revision) {
          stale++;
          report(`  ⚠ ${up} 개정됨(r${b.revision}→r${c.revision}) — 하류 재검토 필요: ${[...downs].join(', ')}`);
        } else if (b.revision == null && hashChanged) {
          stale++;
          const now = c.revision == null ? '현재도 개정 번호 없음' : `현재 r${c.revision}`;
          report(`  ⚠ ${up} 이 리뷰 이후 바뀜(기준선에 개정 번호 없음 · ${now}) — 하류 재검토 필요: ${[...downs].join(', ')}`);
          if (c.revision == null) report('     (문서에 revision을 넣으면 "결정 변경"과 "문구 수정"을 구분할 수 있다)');
        } else if (hashChanged) {
          silent++;
          // **파생물에는 "개정을 올려라"라고 하지 않는다 — 할 수 없는 일이다.** 요청서는 통째로 다시
          // 뽑히므로 사람이 개정을 매길 자리가 없고, 그래도 내용이 바뀐 건 사실이라 **하류 재검토는 필요하다**.
          // 신호는 살리고 지시만 가른다(뭉뚱그리면 매 재생성마다 못 할 일을 시켜 경고가 무시된다).
          if (DERIVED_TYPES.has(docTypeOf.get(up))) {
            report(`  ⚠ ${up} 이 다시 뽑혀 바뀜 — 하류 재검토 필요: ${[...downs].join(', ')}`);
            report('     (파생물이라 개정 번호를 사람이 올리지 않습니다 — 바뀐 요구가 계약에 반영됐는지만 보세요)');
          } else {
            report(`  ⚠ ${up} 이 개정 번호 없이 수정됨(r${c.revision} 그대로) — 결정이 바뀐 것이면 revision을 올리고 하류를 재검토하세요`);
          }
        }
      }
      if (unpinned) report(`  · 리뷰 기준선에 없는 상류 ${unpinned}개(그 문서들은 신선도 판정 불가 — 다음 리뷰에서 sources에 넣으세요)`);
      if (!stale && !silent) report('  ✅ 리뷰 이후 상류 변경 없음');
    }
    report(`  파장 지도: 상류 ${downstream.size}개 → 하류 관계 ${[...downstream.values()].reduce((n, s) => n + s.size, 0)}건`);
  }
}

// 결과
report(`\n등기부: FEAT ${reg.feat.size} · 화면 ${reg.screen.size} · 프레임 ${reg.frame.size} · 데이터그룹 ${reg.group.size} · POL ${reg.pol.size} · UI ${reg.ui.size} · SCN ${reg.scn.size} · 토큰 ${reg.token.size}`);
report(problems.length ? `⚠ 문제 ${problems.length}종 발견: ${[...new Set(problems)].join(', ')}` : '✅ 세트 점검 통과');
process.exit(problems.length ? 1 : 0);
