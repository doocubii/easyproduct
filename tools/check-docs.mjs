#!/usr/bin/env node
// easyproduct 문서 세트 점검기 (무의존 참조 구현)
// 규약: skills/easyproduct-suite/references/checker-guide.md
//
// 사용법:  node tools/check-docs.mjs <문서세트-루트>
//   - <루트>/00-index.md 의 docbundle.docs 매니페스트가 있으면 그걸로 문서를 발견
//   - 없으면 <루트> 아래 *.md 를 훑는다
// 하는 일: frontmatter 확인 → 기계 블록을 machine.schema 로 검증 →
//          접두사 라우팅으로 크로스도큐먼트 참조 무결성(죽은 링크) 점검
// 종료코드: 문제(경로누락·frontmatter불일치·스키마위반·죽은링크) 있으면 1, 없으면 0

import fs from 'node:fs';
import path from 'node:path';

// ── frontmatter 파서 (이 세트의 통제된 형식 전용: 최상위 key:value + 1단계 machine 중첩) ──
function parseFrontmatter(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return null;
  const top = {}; let parent = null;
  for (const rawLine of m[1].split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '');
    if (!line.trim()) continue;
    let mm;
    if ((mm = line.match(/^([a-zA-Z_][\w-]*):\s*(.*)$/))) {           // 최상위
      const [, k, v] = mm;
      if (v === '') { top[k] = {}; parent = k; } else { top[k] = unquote(v); parent = null; }
    } else if (parent && (mm = line.match(/^\s+([a-zA-Z_][\w-]*):\s*(.*)$/))) { // 중첩
      top[parent][mm[1]] = unquote(mm[2]);
    }
  }
  return top;
}
const unquote = (s) => s.trim().replace(/^["']|["']$/g, '');

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
const root = process.argv[2];
if (!root) { console.error('사용법: node tools/check-docs.mjs <문서세트-루트>'); process.exit(2); }

const problems = [];
const report = (m) => console.log(m);
const { via, docs } = discover(root);
report(`문서 발견: ${docs.length}개 (${via === 'manifest' ? '매니페스트' : '폴더 스캔'})`);

// 레지스트리(anchor 등기부)
const reg = { feat: new Set(), screen: new Set(), group: new Map(), pol: new Set(), ui: new Set(), scn: new Set(), token: new Set() };
const loaded = []; // {docType, path, md, fm, blocks:[{tag,obj}]}

// 1차: frontmatter·스키마 검증 + 레지스트리 적재
report('\n[1] frontmatter · 스키마 검증');
for (const d of docs) {
  const fp = path.join(root, d.path);
  if (!fs.existsSync(fp)) { report(`  ❌ 경로 없음: ${d.path}`); problems.push('path'); continue; }
  const md = fs.readFileSync(fp, 'utf8');
  const fm = parseFrontmatter(md);
  if (!fm) { report(`  · ${d.path} (frontmatter 없음 — 스킵)`); continue; }
  if (d.docType && fm.doc_type !== d.docType) { report(`  ❌ frontmatter 불일치: ${d.path} 매니페스트=${d.docType} 실제=${fm.doc_type}`); problems.push('doctype'); }
  const machine = fm.machine || {};
  if (!machine.tag || !machine.schema) { report(`  · ${d.path.padEnd(30)} (${fm.doc_type}) 기계블록 없음`); continue; }
  let schema; try { schema = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fp), machine.schema), 'utf8')); }
  catch (e) { report(`  ❌ 스키마 로드 실패: ${d.path} → ${machine.schema}`); problems.push('schema'); continue; }
  const blocks = extractBlocks(md, machine.tag);
  const errs = [];
  for (const obj of blocks) { if (obj.__parseError) { errs.push('JSON 파싱: ' + obj.__parseError); continue; } validate(obj, schema, fm.doc_type, errs); }
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
    if (o.group && Array.isArray(o.fields)) reg.group.set(o.group, new Set(o.fields.map(f => f.name)));
    if (o.tokens) for (const [cat, kv] of Object.entries(o.tokens)) if (kv && typeof kv === 'object') for (const name of Object.keys(kv)) reg.token.add(`${cat}.${name}`);
  }
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
    // 화면 설계: feat → ia, components → ui(중앙; 로컬 UI.FEAT.* 는 스킵), data → 데이터모델
    for (const s of (o.screens || [])) {
      refChecked++; if (s.feat && !reg.feat.has(s.feat)) { report(`  ❌ ${doc.path}: 화면 ${s.id} 의 feat ${s.feat} → ia.features에 없음`); dead++; }
      for (const c of (s.components || [])) { if (/^UI\.FEAT\./.test(c)) continue; refChecked++; if (!reg.ui.has(c)) { report(`  ❌ ${doc.path}: 화면 ${s.id} 의 컴포넌트 ${c} → uicomponents.list에 없음`); dead++; } }
      for (const dv of (s.data || [])) { refChecked++; if (!dataRefOk(dv)) { report(`  ❌ ${doc.path}: 화면 ${s.id} 의 데이터 ${dv} → 데이터 모델에 없음`); dead++; } }
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
report(`  참조 ${refChecked}건 확인, 죽은 링크 ${dead}건` + (refChecked === 0 ? ' (참조를 담은 문서 없음)' : ''));
if (dead) problems.push('deadlink');

// 결과
report(`\n등기부: FEAT ${reg.feat.size} · 화면 ${reg.screen.size} · 데이터그룹 ${reg.group.size} · POL ${reg.pol.size} · UI ${reg.ui.size} · SCN ${reg.scn.size} · 토큰 ${reg.token.size}`);
report(problems.length ? `⚠ 문제 ${problems.length}종 발견: ${[...new Set(problems)].join(', ')}` : '✅ 세트 점검 통과');
process.exit(problems.length ? 1 : 0);
