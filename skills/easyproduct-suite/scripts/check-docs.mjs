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
function validate(obj, schema, p, errs) {
  if (schema.const !== undefined && obj !== schema.const) errs.push(`${p} = ${JSON.stringify(obj)} (const ${JSON.stringify(schema.const)} 아님)`);
  if (schema.enum && !schema.enum.includes(obj)) errs.push(`${p} = ${JSON.stringify(obj)} (허용값 ${schema.enum.join('|')} 아님)`);
  if (schema.type && !typeOk(obj, schema.type)) { errs.push(`${p} 타입 ${schema.type} 아님`); return; }
  if (schema.pattern && typeof obj === 'string' && !new RegExp(schema.pattern).test(obj)) errs.push(`${p} = "${obj}" (패턴 위반)`);
  if (schema.type === 'array' && Array.isArray(obj)) {
    if (schema.minItems != null && obj.length < schema.minItems) errs.push(`${p} 항목 ${obj.length} < 최소 ${schema.minItems}`);
    if (schema.items) obj.forEach((it, i) => validate(it, schema.items, `${p}[${i}]`, errs));
  }
  if (schema.type === 'object' || schema.properties || schema.required) {
    const o = obj && typeof obj === 'object' ? obj : {};
    if (schema.required) for (const r of schema.required) if (!(r in o)) errs.push(`${p}.${r} 누락`);
    if (schema.minProperties != null && Object.keys(o).length < schema.minProperties) errs.push(`${p} 속성 ${Object.keys(o).length} < 최소 ${schema.minProperties}`);
    for (const [k, s] of Object.entries(schema.properties || {})) if (k in o) validate(o[k], s, `${p}.${k}`, errs);
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      const known = new Set(Object.keys(schema.properties || {}));
      for (const [k, v] of Object.entries(o)) if (!known.has(k)) validate(v, schema.additionalProperties, `${p}.${k}`, errs);
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

// ── 메인 ──
const args = process.argv.slice(2);
const printSnapshot = args.includes('--print-snapshot');
const emitNeeds = args.includes('--emit-needs');
const emitReq = args.includes('--emit-interface-request');
const argVal = (name, dflt = null) => { const i = args.indexOf(name); return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt; };
const reqTransport = argVal('--transport');
const reqScope = argVal('--scope');
const root = args.find(a => !a.startsWith('--'));
if (!root) {
  console.error('사용법: node check-docs.mjs <문서세트-루트> [--print-snapshot]');
  console.error('  --print-snapshot : 리뷰 산출물의 sources에 붙일 (revision·contentHash) 스냅샷을 출력');
  console.error('  --emit-needs     : 화면 동작에서 **서버 요구 목록**을 기계 판독 JSON으로 추출(백엔드 설계의 입력)');
  console.error('  --emit-interface-request [--transport rest|grpc|graphql|ws|queue] [--scope user]');
  console.error('                     : 프론트가 백엔드에 넘길 **인터페이스 요청서(md)**를 생성해 stdout으로 출력');
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
    report(`     ${unlisted.slice(0, 5).join(', ')}${unlisted.length > 5 ? ` 외 ${unlisted.length - 5}건` : ''}`);
    report('     → 색인(00-index.md)을 다시 만들면 편입된다. `machine.includes`로 딸린 부분 파일은 자동 추적되므로 여기 안 나온다.');
  }
}

// 레지스트리(anchor 등기부)
const reg = { feat: new Set(), screen: new Set(), group: new Map(), pol: new Set(), ui: new Set(), scn: new Set(), token: new Set() };
const groupOrigin = new Map(); // group -> 그 그룹을 정의한 문서 경로(중복 정의 적발용)
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
  if (!machine.tag || !machine.schema) { report(`  · ${d.path.padEnd(30)} (${fm.doc_type}) 기계블록 없음`); continue; }
  const schemaPath = path.resolve(path.dirname(fp), machine.schema);
  let schema; try { schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8')); }
  catch (e) { report(`  ❌ 스키마 로드 실패: ${d.path} → ${machine.schema}`); problems.push('schema'); continue; }
  // 사본이 스킬 자산과 다르면 둘 중 하나가 뒤처진 것 → 어느 쪽인지는 사람이 판단한다.
  const canon = canonicalSchemaPath(path.basename(schemaPath));
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
  errs.slice(0, 5).forEach(e => report('       - ' + e));
  loaded.push({ docType: fm.doc_type, path: d.path, blocks });

  // 레지스트리 적재
  for (const o of blocks) {
    if (o.__parseError) continue;
    if (Array.isArray(o.features)) o.features.forEach(f => reg.feat.add(f.id));
    if (Array.isArray(o.screens)) o.screens.forEach(s => reg.screen.add(s.id));
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
    // 화면 동작(io) — 백엔드 요구의 출처
    for (const s of (o.screens || [])) {
      const dat = Array.isArray(s.data) ? {} : (s.data || {});
      for (const a of (dat.io || [])) {
        screenIo.push({ id: a.id || null, screen: s.id, action: a.action, target: a.target || null,
                        ui: a.ui || null, sends: a.sends || [], receives: a.receives || [],
                        policies: a.policies || [], semantics: a.semantics || null, op: a.op || null, doc: doc.path });
      }
    }
  }
}

// 문서별 현재 상태(개정 번호·내용 해시) — 신선도 판정과 요청서의 출처 스냅샷이 함께 쓴다.
const cur = new Map();   // path → {revision, hash}
for (const d of allDocs) {
  try {
    const text = fs.readFileSync(path.resolve(root, d.path), 'utf8');
    const fm = parseFrontmatter(text) || {};
    const rev = fm.revision == null ? null : Number(fm.revision);
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
report('\n[2] 크로스도큐먼트 참조 (죽은 링크)');
let refChecked = 0, dead = 0;
for (const doc of loaded) {
  for (const o of doc.blocks) {
    if (o.__parseError) continue;
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
  }
}

// 백엔드 참조: 인터페이스가 가리키는 것들이 실재하나 + 근거(basis) 규칙
for (const doc of loaded) {
  for (const o of doc.blocks) {
    if (o.__parseError) continue;
    for (const i of (o.interfaces || [])) {
      for (const st of [...(i.reads || []), ...(i.writes || [])]) {
        refChecked++; if (!be.store.has(st)) { report(`  ❌ ${doc.path}: ${i.id} 의 저장소 ${st} → backend.stores에 없음`); dead++; }
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
    refChecked++; if (!ioById.has(b.ref)) { report(`  ❌ ${b.doc}: ${b.itfId} 의 근거 ${b.ref} → 화면 동작(data.io[].id)에 없음`); dead++; }
  } else if (b.kind === 'policy') {
    refChecked++; if (!reg.pol.has(b.ref)) { report(`  ❌ ${b.doc}: ${b.itfId} 의 근거 ${b.ref} → policy.rules에 없음`); dead++; }
  } else if (b.kind === 'ops' || b.kind === 'legacy') {
    // 등기부가 없는 갈래다 — 사유가 없으면 "개발자 요구"가 아무 인터페이스나 정당화하는 뒷문이 된다.
    if (!b.why || !String(b.why).trim()) { report(`  ❌ ${b.doc}: ${b.itfId} 의 근거 "${b.ref}"(${b.kind})에 why 없음 — 등기부 없는 갈래는 사유 필수`); dead++; }
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
    for (const big of list) {
      if (small === big || small.screen === big.screen) continue;
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

function sameShapeGroups(list) {
  const by = new Map();
  for (const x of list) {
    const key = JSON.stringify([[...(x.sends || [])].sort(), [...(x.receives || [])].sort()]);
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
      ui: x.ui ?? null, sends: x.sends ?? [], receives: x.receives ?? [],
      policies: x.policies ?? [], semantics: x.semantics ?? null,
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
  const picked = screenIo.filter((x) => (x.target ? String(x.target).split('.')[0] : null) === 'server'
    && (!reqScope || x.doc.includes(`/${reqScope}/`) || x.doc.includes(`-${reqScope}-`)));
  const fromDocs = [...new Set(picked.map((x) => x.doc))].sort().map((p) => {
    const c = cur.get(p) || {};
    return c.revision == null ? { path: p, contentHash: c.hash } : { path: p, revision: c.revision, contentHash: c.hash };
  });
  const block = {
    generatedAt: new Date().toISOString().slice(0, 10),
    ...(reqScope ? { scope: reqScope } : {}),
    ...(reqTransport ? { preferredTransport: reqTransport, bindingSlots: SLOTS[reqTransport] || [] } : {}),
    from: fromDocs,
    requests: picked.map((x) => ({
      ref: x.id || `${x.screen}#${x.action}`, screen: x.screen, action: x.action,
      ...(x.target ? { target: x.target } : {}), ...(x.ui ? { ui: x.ui } : {}),
      sends: x.sends || [], receives: x.receives || [],
      ...(x.policies && x.policies.length ? { policies: x.policies } : {}),
      ...(x.semantics ? { semantics: x.semantics } : {}),
    })),
  };
  const rel = (p) => p.split('/').map(() => '..').slice(1).join('/') || '.';
  const out = [
    '---', 'doc_type: interface-request', 'version: 1', 'ssot: prose', 'machine:', '  lang: json',
    '  tag: interface.requests', '  item: request-list', '  schema: schemas/interface-request.v1.schema.json',
    '---', '',
    `# 인터페이스 요청서${reqScope ? ` — ${reqScope}` : ''} (${block.generatedAt} 생성)`, '',
    '> **프론트가 백엔드에 넘기는 요구 목록입니다.** 화면 설계서의 동작에서 **기계로 생성**했으니 손으로 고치지 마세요 —',
    '> 화면을 고치고 다시 생성하면 됩니다. 이 문서는 SSOT가 아니라 파생물이고, 화면과 어긋나면 **화면이 이깁니다.**',
    reqTransport
      ? `> 전송은 \`${reqTransport}\`를 **희망**합니다(확정 아님 — 백엔드가 정하고, 다르면 사유를 남깁니다). 백엔드가 채울 자리: ${(SLOTS[reqTransport] || []).join(' · ')}`
      : '> 전송 방식은 백엔드가 정합니다.',
    '', `요구 ${block.requests.length}건 · 출처 화면 문서 ${fromDocs.length}개`, '',
    '| 동작 | 화면 | 보냄 | 받음 | 정책 | 행동 규약 |', '|---|---|---|---|---|---|',
    ...block.requests.map((r) => `| \`${r.ref}\` | ${r.screen} | ${(r.sends || []).join(', ') || '—'} | ${(r.receives || []).join(', ') || '—'} | ${(r.policies || []).join(', ') || '—'} | ${r.semantics || '—'} |`),
    '',
    ...(() => {
      const g = sameShapeGroups(block.requests);
      const sub = subsetCandidates(block.requests).slice(0, 20);
      const lines = [];
      if (sub.length) {
        lines.push('## 기존 인터페이스로 덮을 수 있는 후보 (한쪽이 다른 쪽에 포함됨)', '',
          '> 받는 값이 더 많은 요구를 이미 처리한다면, **적게 쓰는 화면에 새 인터페이스를 만들 필요가 없습니다.**',
          '> 권한·정책·의미 요건이 다르면 묶으면 안 되니, **판단은 백엔드 몫**입니다.', '',
          ...sub.map((x) => `- \`${x.forNeed}\` 는 \`${x.reuse}\` 로 덮을 수 있음 (더 오는 값: ${x.extra.join(', ') || '없음'})`), '');
      }
      return g.length
        ? [...lines, '## 하나로 묶을 후보 (보내고 받는 것이 같은 요구)', '',
           '> 여러 화면이 같은 데이터를 주고받고 있습니다. 백엔드에서 **인터페이스 하나로 묶을 수 있습니다**',
           '> (`basis`에 여럿을 적으면 됩니다). **판단은 백엔드 몫**입니다 — 변수가 같아도 다른 일일 수 있습니다.', '',
           ...g.map((x) => `- ${x.refs.map((r) => '`' + r + '`').join(' · ')} — 보냄 ${x.sends.join(', ') || '—'} / 받음 ${x.receives.join(', ') || '—'}`), '']
        : lines;
    })(),
    '```json interface.requests', JSON.stringify(block, null, 2), '```', '',
  ].join('\n');
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
      for (const m of missed.slice(0, 5)) report(`     · ${m.id || `${m.screen}#${m.action}`} (${m.doc})`);
      if (missed.length > 5) report(`     · 외 ${missed.length - 5}건`);
    } else {
      report(`\n  ✅ 요구 커버리지: server 동작 ${serverIo.length}건 모두 basis에 담김`);
    }
  }
  if (untargeted.length) {
    report(`  ⚠ \`target\` 미분류 동작 ${untargeted.length}건 — **업그레이드 필요**(server/local/client 판정)`);
    report('     → 없으면 백엔드가 로컬 저장까지 서버 인터페이스로 잘못 도출한다. 화면 설계 스킬의 버전업(gap-fill)으로 채우세요.');
  }
  if (withOp.length) {
    report(`  ⚠ 폐기된 \`data.io[].op\` ${withOp.length}건 — **이관 필요**(백엔드 인터페이스 계약의 basis로 옮기고 비우세요)`);
  }
  if (quals.size) {
    report(`  · target 한정자: ${[...quals.entries()].map(([k, v]) => `${k} ${v}건`).join(' · ')}`);
    report('     (한정자 등기부는 아직 없다 — 표기가 갈렸으면 통일하세요)');
  }
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
        report(`     ${noRev.slice(0, 5).map((d) => d.path).join(', ')}${noRev.length > 5 ? ` 외 ${noRev.length - 5}개` : ''}`);
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
          report(`  ⚠ ${up} 이 개정 번호 없이 수정됨(r${c.revision} 그대로) — 결정이 바뀐 것이면 revision을 올리고 하류를 재검토하세요`);
        }
      }
      if (unpinned) report(`  · 리뷰 기준선에 없는 상류 ${unpinned}개(그 문서들은 신선도 판정 불가 — 다음 리뷰에서 sources에 넣으세요)`);
      if (!stale && !silent) report('  ✅ 리뷰 이후 상류 변경 없음');
    }
    report(`  파장 지도: 상류 ${downstream.size}개 → 하류 관계 ${[...downstream.values()].reduce((n, s) => n + s.size, 0)}건`);
  }
}

// 결과
report(`\n등기부: FEAT ${reg.feat.size} · 화면 ${reg.screen.size} · 데이터그룹 ${reg.group.size} · POL ${reg.pol.size} · UI ${reg.ui.size} · SCN ${reg.scn.size} · 토큰 ${reg.token.size}`);
report(problems.length ? `⚠ 문제 ${problems.length}종 발견: ${[...new Set(problems)].join(', ')}` : '✅ 세트 점검 통과');
process.exit(problems.length ? 1 : 0);
