#!/usr/bin/env node
// skill-lint.mjs — easyproduct 스킬 부합(베타 머지 게이트)의 '기계 가능' 항목 자동 점검.
//
// 무의존 Node(ESM). 근거: `skills/easyproduct-suite/references/checker-guide.md`의
// "스킬 부합 점검 (베타 머지 게이트)" 체크리스트. 이 스크립트는 그중 **기계 가능** 항목만 본다
// (의미 판단 항목 — "레지스트리도 정의를 담나", "충실 미러 지침" — 은 에이전트 몫이라 여기서 다루지 않는다).
//
// 점검(문제가 하나라도 있으면 종료코드 1):
//   A. 빈 껍데기 금지 — 모든 기계 블록 스키마가 내용 필드를 required(내용 배열이면 minItems:1)로 강제하고,
//      식별자(id/scope/group)만 required인 엔트리가 스키마를 통과하지 않나.
//   B. 뜻 필수 — params/variants 항목이 desc를 required로 두나(뜻 없는 이름 금지).
//   C. 정합성 점검 절 — 각 SKILL.md가 3층 계약을 참조하고("점검 3층"), 산출 스킬은 "정합성 점검" 절을 두나.
//   D. 점검기 SW 자산 — 세트 점검기 check-docs.mjs가 있나(SW 3종의 구현 자산).
//
// 실행: node skills/easyproduct-suite/scripts/skill-lint.mjs

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));            // .../skills/easyproduct-suite/scripts
const SUITE_DIR = join(HERE, '..');                             // .../skills/easyproduct-suite
const SKILLS_DIR = join(HERE, '..', '..');                      // .../skills
const REPO_ROOT = join(SKILLS_DIR, '..');

const PURE_ID = new Set(['id', 'scope', 'group']);  // 식별자/유도값 — 이것만 required면 '빈 껍데기'
// suite는 오케스트레이터라 자체 산출 문서가 없다 — "정합성 점검" 절 대신 Stage 4가 그 역할(하지만 "점검 3층"은 참조해야 한다).
const NO_CONSISTENCY_SECTION = new Set(['easyproduct-suite']);

const errors = [];
const notes = [];
const rel = (p) => relative(REPO_ROOT, p);

// 우리 스키마(통제된 부분집합)의 모든 하위 스키마 노드를 순회한다.
function* subschemas(node) {
  if (node == null || typeof node !== 'object') return;
  yield node;
  if (node.properties) for (const v of Object.values(node.properties)) yield* subschemas(v);
  if (node.items) {
    if (Array.isArray(node.items)) for (const v of node.items) yield* subschemas(v);
    else yield* subschemas(node.items);
  }
  if (node.$defs) for (const v of Object.values(node.$defs)) yield* subschemas(v);
  if (node.additionalProperties && typeof node.additionalProperties === 'object') {
    yield* subschemas(node.additionalProperties);
  }
}

function lintSchema(file) {
  let schema;
  try {
    schema = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    errors.push(`${rel(file)}: JSON 파싱 실패 — ${e.message}`);
    return;
  }
  const where = rel(file);

  // A(블록이 비었나): 최상위 payload 리스트(root.required의 배열 속성)는 비면 무의미 → minItems:1.
  //   내용 리스트는 이것 하나뿐이다. 엔트리 안의 대칭·선택 배열(예: 화면의 data — 정적 화면이면 [])은
  //   required여도 비어도 되므로 여기서 강제하지 않는다(그건 아래 빈 껍데기 검사 + 의미 게이트가 본다).
  const rootReq = Array.isArray(schema.required) ? schema.required : [];
  const rootProps = schema.properties || {};
  for (const f of rootReq) {
    const p = rootProps[f];
    if (p && p.type === 'array' && !(typeof p.minItems === 'number' && p.minItems >= 1)) {
      errors.push(`${where}: 최상위 리스트 '${f}'에 minItems:1 없음(블록이 비면 점검할 게 없어 무의미).`);
    }
  }

  for (const node of subschemas(schema)) {
    if (typeof node !== 'object' || node === null) continue;
    const req = Array.isArray(node.required) ? node.required : [];
    const props = node.properties || {};

    // A(빈 껍데기): id를 가진 엔트리인데 required가 식별자(id/scope/group)뿐이면 껍데기다.
    if (props.id && req.length > 0 && req.every((f) => PURE_ID.has(f))) {
      errors.push(
        `${where}: 빈 껍데기 — 엔트리의 required가 식별자만(${req.join(', ')}). ` +
          `id를 빼도 내용이 남게 내용 필드를 required에 넣어라.`,
      );
    }

    // B(뜻 필수): params/variants 항목은 desc를 required로 둔다.
    for (const key of ['params', 'variants']) {
      const p = props[key];
      if (p && p.type === 'array' && p.items && !Array.isArray(p.items)) {
        const ir = Array.isArray(p.items.required) ? p.items.required : [];
        if (!ir.includes('desc')) {
          errors.push(`${where}: '${key}' 항목에 desc가 required 아님(이름만 담는 뜻 없는 항목 금지).`);
        }
      }
    }
  }
}

function lintSkillDoc(skillName, skillDir) {
  const md = join(skillDir, 'SKILL.md');
  if (!existsSync(md)) {
    errors.push(`${rel(skillDir)}: SKILL.md 없음.`);
    return;
  }
  const text = readFileSync(md, 'utf8');
  // C1: 3층 계약을 참조하는가.
  if (!text.includes('점검 3층')) {
    errors.push(`${rel(md)}: "점검 3층" 참조 없음 — 정합성 점검이 3층 계약(checker-guide)에 연결돼야 한다.`);
  }
  // C2: 산출 스킬은 "정합성 점검" 절을 둔다(suite는 오케스트레이터라 면제).
  if (!NO_CONSISTENCY_SECTION.has(skillName) && !text.includes('정합성 점검')) {
    errors.push(`${rel(md)}: "정합성 점검" 절 없음.`);
  }
}

// --- 실행 ---
const skillDirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name.startsWith('easyproduct-'))
  .map((d) => d.name)
  .sort();

let schemaCount = 0;
for (const name of skillDirs) {
  const dir = join(SKILLS_DIR, name);
  lintSkillDoc(name, dir);
  const schemasDir = join(dir, 'schemas');
  if (existsSync(schemasDir)) {
    for (const f of readdirSync(schemasDir)) {
      if (f.endsWith('.schema.json')) {
        schemaCount++;
        lintSchema(join(schemasDir, f));
      }
    }
  }
}

// D: 세트 점검기(SW 3종 자산)가 있나.
if (!existsSync(join(SUITE_DIR, 'scripts', 'check-docs.mjs'))) {
  errors.push(`${rel(join(SUITE_DIR, 'scripts', 'check-docs.mjs'))}: 세트 점검기 없음(SW 3종 구현 자산).`);
} else {
  notes.push('check-docs.mjs 있음(SW 3종 자산).');
}

// --- 보고 ---
console.log(`skill-lint: 스킬 ${skillDirs.length}개, 스키마 ${schemaCount}개 점검.`);
for (const n of notes) console.log(`  · ${n}`);
if (errors.length === 0) {
  console.log('✓ 부합(기계 가능 항목) 통과 — 빈 껍데기 없음, 뜻 필수 충족, 정합성 점검 절 존재.');
  process.exit(0);
} else {
  console.error(`✗ 부합 실패 — ${errors.length}건:`);
  for (const e of errors) console.error(`  - ${e}`);
  console.error('\n베타 머지/버전업을 막고 먼저 스킬을 고쳐라(checker-guide "스킬 부합 점검").');
  process.exit(1);
}
