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
// installer/wirer 스킬 — 문서를 **산출하지 않고** 대상 프로젝트에 게이트를 설치한다.
// 점검 3층은 "스킬이 만든 문서"를 점검하는 계약이라 대상이 아니다(억지 참조는 '빈 껍데기' 정신에 어긋난다).
// 대신 같은 정신의 대체 요구를 건다: 자기가 깐 게이트가 **무엇을 보장하지 않는지(한계)**를 SKILL.md에 명시할 것.
const INSTALLER_SKILLS = new Set(['easyproduct-sdd-harness']);

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
  // C0: installer 스킬은 문서 3층 대신 '한계 명시'를 요구한다(게이트를 약화시키지 않는 대체 요구).
  if (INSTALLER_SKILLS.has(skillName)) {
    if (!text.includes('한계')) {
      errors.push(
        `${rel(md)}: installer 스킬인데 "한계" 명시 없음 — 설치한 게이트가 무엇을 보장하지 않는지 적어야 한다.`,
      );
    }
    return;
  }
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

// E: 앵커 접두사 등기부가 두 곳에서 따로 자라지 않는가.
// 세트가 접두사를 늘렸는데 하네스의 easyproduct 어댑터 기본값이 안 따라오면, 그 접두사 참조는
// 하네스에서 **"참조인지도 모르는"** 상태가 된다 — 검사받던 참조가 조용히 검사 밖으로 나간다
// (0.8.0의 `IO`가 실제로 그랬다). 스킬 간 파일 참조는 최소화하는 원칙이라 하네스가 목록을 **품고**,
// 대신 여기서 **대조**한다.
{
  const canonPath = join(SUITE_DIR, 'assets', 'anchor-prefixes.json');
  const harnessSkill = join(SKILLS_DIR, 'easyproduct-sdd-harness', 'SKILL.md');
  if (existsSync(canonPath) && existsSync(harnessSkill)) {
    let canon = [];
    try { canon = (JSON.parse(readFileSync(canonPath, 'utf8')).prefixes || []).map((x) => x.prefix); } catch { /* 아래에서 잡힘 */ }
    if (!canon.length) {
      errors.push(`${rel(canonPath)}: 앵커 접두사 등기부가 비었거나 읽을 수 없음.`);
    } else {
      const text = readFileSync(harnessSkill, 'utf8');
      const m = /idPrefixes[^\n]*?\n?\s*`\[([^\]]*)\]`/.exec(text) || /`\[("(?:[A-Z]+)"(?:\s*,\s*"[A-Z]+")*)\]`/.exec(text);
      const listed = m ? [...m[1].matchAll(/"([A-Z][A-Z0-9]*)"/g)].map((x) => x[1]) : null;
      if (!listed) {
        errors.push(`${rel(harnessSkill)}: easyproduct 어댑터의 idPrefixes 기본값 목록을 못 찾음(등기부 대조 불가).`);
      } else {
        const missing = canon.filter((p2) => !listed.includes(p2));
        const extra = listed.filter((p2) => !canon.includes(p2));
        if (missing.length || extra.length) {
          errors.push(`앵커 접두사 등기부 불일치 — ${rel(canonPath)} vs 하네스 어댑터 기본값`
            + (missing.length ? ` · 하네스에 없음: ${missing.join(', ')}` : '')
            + (extra.length ? ` · 등기부에 없음: ${extra.join(', ')}` : ''));
        } else {
          notes.push(`앵커 접두사 등기부 일치(${canon.length}개) — 하네스 어댑터와 대조됨.`);
        }
      }
    }
  }
}

// F: 개정 축(`revision`) 정의가 두 스킬에서 갈리지 않는가.
// suite는 `version`=payload 계약 / `revision`=결정 개정으로 정의하는데, 하네스가 그걸 모르면
// "상위 문서의 version을 먼저 올려라"라고 **오지시**하고 스키마 계약 버전이 오염된다(실측).
// 하네스는 easyproduct 없이도 도는 것이 설계라 파일을 참조하지 않는다 — 대신 여기서 **대조**한다.
{
  const harnessDir = join(SKILLS_DIR, 'easyproduct-sdd-harness');
  if (existsSync(harnessDir)) {
    const files = ['scripts/sdd-check.mjs', 'scripts/sdd_check.py', 'references/checker-pseudocode.md',
                   'assets/project-readme.template.md', 'assets/upstream-check.template.md',
                   'assets/sources.template.json'];
    const missing = files.filter((f) => {
      const fp = join(harnessDir, f);
      return existsSync(fp) && !readFileSync(fp, 'utf8').includes('revision');
    });
    if (missing.length) {
      errors.push(`easyproduct-sdd-harness가 \`revision\`(결정 개정 축)을 모름 — ${missing.join(', ')}`
        + ' · suite는 `version`=payload 계약 / `revision`=결정 개정으로 정의한다. 하네스가 `version`을'
        + ' 문서 수정 카운터로 쓰면 스키마 계약 버전을 오염시키는 오지시가 된다.');
    } else {
      notes.push('개정 축 정의 일치 — 하네스가 `revision`을 안다.');
    }
  }
}

// --- (G) 점검기의 TOOL_VERSION 이 세트 버전과 같은가 -------------------------
// 그 값이 생성물(`interface-request`)에 찍혀 나가고, 나중에 "생성기가 그 뒤 자랐나"를 판정하는 근거가 된다.
// 어긋나면 **자란 뒤에도 조용히 통과**하거나 **안 자랐는데 다시 뽑으라고** 한다 — 둘 다 나쁘다.
// (앵커 등기부·revision 정의와 같은 방식: 각자 값을 품고 여기서 대조해 드리프트를 막는다.)
{
  const checkerPath = join(SUITE_DIR, 'scripts', 'check-docs.mjs');
  const suiteSkill = join(SUITE_DIR, 'SKILL.md');
  try {
    const declared = /const TOOL_VERSION = '([^']+)'/.exec(readFileSync(checkerPath, 'utf8'));
    const meta = /^- \*\*버전\*\*: `([^`]+)`$/m.exec(readFileSync(suiteSkill, 'utf8'));
    if (!declared) errors.push(`${rel(checkerPath)}: TOOL_VERSION 상수를 못 찾음(생성물 판 표시의 근거가 사라진다).`);
    else if (!meta) errors.push(`${rel(suiteSkill)}: 메타 정보의 버전을 못 찾음(TOOL_VERSION 대조 불가).`);
    else if (declared[1] !== meta[1]) {
      errors.push(`check-docs.mjs 의 TOOL_VERSION(${declared[1]})이 suite SKILL.md 버전(${meta[1]})과 다름 — `
        + `생성물에 찍히는 판 표시가 어긋나 "생성기가 자랐나" 판정이 틀린다. 버전업 때 함께 올려라.`);
    } else notes.push(`TOOL_VERSION ${declared[1]} — 세트 버전과 일치.`);
  } catch (e) {
    errors.push(`TOOL_VERSION 대조 실패: ${e.message}`);
  }
}

// --- (H) gap-fill 절차를 가진 스킬이 **그 문을 여는 말**을 description 에 갖고 있나 -------------
// 업그레이드 경로(감지·채움·가시화·검증)를 다 만들어 놓고도, **사용자가 "문서 현행화해줘"라고 했을 때
// 스킬이 발동하지 않으면 그 경로 전체에 닿지 못한다.** 실제로 그런 상태였다 — Step 1 재진입에 트리거를
// 12가지 넣어 뒀는데 오케스트레이터 description 에 "현행화·업그레이드"가 한 마디도 없었다.
{
  const NEED = ['easyproduct-suite', 'easyproduct-backend', 'easyproduct-screen-design',
                'easyproduct-ia-designer', 'easyproduct-policy-legal', 'easyproduct-data-model'];
  const WORDS = /현행화|업그레이드|최신 구조|형식 최신|낡은 형식|예전 형식/;
  for (const name of NEED) {
    const f = join(SKILLS_DIR, name, 'SKILL.md');
    let txt;
    try { txt = readFileSync(f, 'utf8'); } catch { continue; }   // 그 스킬이 없는 배포는 건너뛴다
    const fm = /^---\n([\s\S]*?)\n---/.exec(txt);
    if (!fm) { errors.push(`${rel(f)}: frontmatter 를 못 찾음(발동어 점검 불가).`); continue; }
    if (!WORDS.test(fm[1])) {
      errors.push(`${rel(f)}: description 에 **업그레이드 발동어**가 없음(현행화·업그레이드·최신 구조 등). `
        + `gap-fill 절차가 있어도 사용자가 "문서 현행화해줘"라고 할 때 스킬이 발동하지 않아 `
        + `업그레이드 경로 전체에 닿지 못한다.`);
    }
  }
  if (!errors.some((e) => e.includes('업그레이드 발동어'))) notes.push('업그레이드 발동어 — gap-fill 스킬 6개 전부 보유.');
}

// --- (I) 설치 스크립트가 읽는 버전이 **실제 버전과 같은가** ---------------------
// 설치기는 SKILL.md 에서 버전을 뽑아 보고한다. 그 규칙이 본문 인용까지 잡으면 **최신을 깔면서
// 옛 버전이라고 보고**한다 — 파일은 맞는데 표시만 틀리니, 사용자는 "설치가 안 됐다"고 읽고
// 원인을 엉뚱한 데서 찾는다(실제 사고: `0.12.8` 을 깔며 `0.11.0` 이라고 했다. 본문에 벤더 사본이
// `0.11.0` 에 멈췄다는 설명문이 있었고, 그게 먼저 잡혔다).
// **여기서 같은 규칙으로 읽어 메타 줄의 값과 대조한다.**
{
  const suiteSkill = join(SUITE_DIR, 'SKILL.md');
  try {
    const txt = readFileSync(suiteSkill, 'utf8');
    const meta = /^- \*\*버전\*\*: `([^`]+)`$/m.exec(txt);
    // 설치기 규칙: **줄 끝에 홀로 놓인** 백틱 버전의 첫 매치
    const asInstaller = /`([0-9]+\.[0-9]+\.[0-9]+)`[ \t]*$/m.exec(txt);
    if (!meta) errors.push(`${rel(suiteSkill)}: 메타 정보의 버전 줄을 못 찾음.`);
    else if (!asInstaller) errors.push(`${rel(suiteSkill)}: 설치 스크립트 규칙으로 버전을 못 읽음 — 설치기가 "알 수 없음"을 보고한다.`);
    else if (asInstaller[1] !== meta[1]) {
      errors.push(`설치 스크립트가 읽을 버전(${asInstaller[1]})이 메타 버전(${meta[1]})과 다름 — `
        + `본문의 버전 인용이 먼저 잡혔다. 최신을 깔면서 옛 버전이라고 보고하게 된다. `
        + `인용은 줄 끝에 홀로 두지 말고 뒤에 글자를 붙여라(예: \`0.11.0\`에).`);
    } else notes.push(`설치 스크립트가 읽을 버전 ${asInstaller[1]} — 메타와 일치.`);
  } catch (e) { errors.push(`설치 버전 대조 실패: ${e.message}`); }
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
