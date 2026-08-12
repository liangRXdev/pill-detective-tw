#!/usr/bin/env node
/**
 * 產生 A 組驗收的 expected ID sets（規格 D13）。
 *
 *   node tools/make-expected.mjs
 *
 * ─────────────────────────────────────────────────────────────────────
 * 這個檔案是**獨立 oracle**，規格 D13 要求 expected 不得由受測程式產生。
 *
 * 因此本檔**刻意不 import `search.js`**，也不共用它的任何 helper。
 * 邏輯用最直白的巢狀迴圈重寫一次——寫得笨是刻意的，笨的程式碼比較容易看出對錯。
 *
 * **獨立性的實際範圍（誠實聲明，不要高估）**
 *   - 「不共用程式碼」：成立，本檔零 import。
 *   - 「不同作者」：**不成立**。本檔與 `search.js` 由同一次工作階段寫成。
 *   - 真正的外部錨點是：本檔算出的計數，必須與 `.ai-review/plan.md` §10 記載的數字
 *     完全相同，而那些數字是在 `search.js` 存在**之前**、由規格階段的第三支
 *     分析腳本算出來的（見 `.ai-review/plan-verdict.md` 的事實查核段）。
 *     `verify-expected` 這道自檢就是在驗這件事——不符即中止，不得手動改常數。
 *
 * **產物是要人工核准後凍結的**。重跑本檔只在 baseline 或規則有意變更時才做，
 * 且變更必須同時更新 `.ai-review/plan.md` §10 的數字與本檔的 EXPECTED_COUNTS。
 * 測試碼中**不得**有任何回寫 expected 的路徑。
 * ─────────────────────────────────────────────────────────────────────
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = path.join(ROOT, 'tests', 'baseline-2026-08-12.json');
const OUT = path.join(ROOT, 'tests', 'expected', 'expected-2026-08-12.json');

/** 規格開頭記載的外部錨點。對不上就不是那份 baseline。 */
const BASELINE_SHA256 = '6f62c4ad5d0bf9af388adbc3bf9f6c005cde9625861a4522cbc96fd67ac125d1';

/**
 * 規格 §10 記載的計數。**這是本檔的自檢，不是本檔的輸出。**
 * 這些數字產生於 search.js 之前，見上方獨立性說明。
 */
const EXPECTED_COUNTS = {
  // D18 起，單字元查詢 token 不啟用「包含」級。受影響者已標註原值。
  'imprint:10': [72, 129, 67],
  'imprint:T': [95, 333, 0],          // D18 前為 95/333/522
  'imprint:S': [174, 657, 0],         // D18 前為 174/657/423
  'imprint:M 40': [2, 4, 5],          // D18 前為 2/4/13（M 是單字元）
  'imprint:40 M': [2, 4, 5],
  'imprint:I JCP': [3, 0, 0],
  'imprint:ZZZZ9': [0, 0, 0],
  'color:白': [2680, 0, 0],
  'color:白+黃': [3868, 0, 0],
  'white-round-noscore': [754, 0, 0],
  'white-round-noscore+S': [16, 78, 0],   // D18 前為 16/78/35
  noImprint: 2085,
  unknownColor: 217,
  unknownWhiteRoundNoScore: 205,
  unknownWhiteRoundNoScoreS: 419,
  // 6 筆**記錄**、9 個**欄位出現**（3 筆兩欄皆為「無」）。
  // plan v1.2 的 A8 原本寫「9 筆」——那是把欄位出現次數當成記錄數，
  // 與先前「白 2,905」同一種錯（已於 v1.3 更正）。兩個數字都留著，防止再混淆。
  literalWu: 6,
  literalWuFieldOccurrences: 9,
  literalWuWithOtherTokens: 3,
};

// ── 直白版的正規化（刻意與 search.js 各寫一次）─────────────────────

function splitOn(value) {
  const out = [];
  for (const part of String(value === null || value === undefined ? '' : value).split(';;;')) {
    const trimmed = part.trim();
    if (trimmed.length > 0) out.push(trimmed);
  }
  return out;
}

function fieldTokens(value) {
  const upper = String(value === null || value === undefined ? '' : value).toUpperCase();
  const out = [];
  let buf = '';
  for (const ch of upper) {
    const isAlnum = (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9');
    if (isAlnum) buf += ch;
    else if (buf.length > 0) { out.push(buf); buf = ''; }
  }
  if (buf.length > 0) out.push(buf);
  return out;
}

function rowTokens(row) {
  const seen = [];
  for (const tok of fieldTokens(row['標註一'])) if (!seen.includes(tok)) seen.push(tok);
  for (const tok of fieldTokens(row['標註二'])) if (!seen.includes(tok)) seen.push(tok);
  return seen;
}

// ── 直白版的三值判定 ────────────────────────────────────────────────

const MATCH = 1, MISMATCH = 2, UNKNOWN = 3, PARTIAL = 4;

function setCond(values, selected) {
  if (values.length === 0) return UNKNOWN;
  for (const v of values) if (selected.includes(v)) return MATCH;
  return MISMATCH;
}

/** 回傳 [state, tier]；tier 0=完全 1=字首 2=包含。D17：部分命中為第四狀態。 */
function imprintCond(tokens, queryTokens) {
  if (tokens.length === 0) return [UNKNOWN, null];
  let worst = 0;
  let hit = 0;
  for (const q of queryTokens) {
    let best = null;
    for (const t of tokens) {
      if (t === q) { best = 0; }
      else if (t.slice(0, q.length) === q) { if (best === null || best > 1) best = 1; }
      // D18：單字元查詢 token 不啟用「包含」級
      else if (q.length > 1 && t.indexOf(q) >= 0) { if (best === null || best > 2) best = 2; }
      if (best === 0) break;
    }
    if (best === null) continue;
    hit = hit + 1;
    if (best > worst) worst = best;
  }
  if (hit === queryTokens.length) return [MATCH, worst];
  if (hit === 0) return [MISMATCH, null];
  return [PARTIAL, null];
}

/**
 * 對全量 baseline 跑一次搜尋，回傳三個互斥主區與未提供區的 id 清單。
 * 條件未啟用時**完全不看記錄的值**（規格 D1.1 階段 ①）。
 */
function run(rows, { color = [], shape = [], score = null, imprint = '' } = {}) {
  const queryTokens = fieldTokens(imprint);
  const imprintOn = String(imprint).trim() !== '' && queryTokens.length > 0;
  const tiers = [[], [], []];
  const partial = [];
  const unknown = [];

  for (const row of rows) {
    const states = [];
    let tier = 0;

    if (color.length > 0) states.push(setCond(splitOn(row['顏色']), color));
    if (shape.length > 0) states.push(setCond(splitOn(row['形狀']), shape));
    if (score !== null) states.push(setCond(splitOn(row['刻痕']), [score]));
    if (imprintOn) {
      const [st, tr] = imprintCond(rowTokens(row), queryTokens);
      states.push(st);
      if (tr !== null) tier = tr;
    }

    let hasMismatch = false, hasUnknown = false, hasPartial = false;
    for (const s of states) {
      if (s === MISMATCH) hasMismatch = true;
      if (s === UNKNOWN) hasUnknown = true;
      if (s === PARTIAL) hasPartial = true;
    }
    const id = String(row['許可證字號']).trim();
    if (hasMismatch) continue;
    if (hasUnknown) unknown.push(id);
    else if (hasPartial) partial.push(id);
    else tiers[tier].push(id);
  }
  return { tiers, partial, unknown };
}

// ── 主流程 ──────────────────────────────────────────────────────────

const raw = fs.readFileSync(BASELINE);
const actualSha = crypto.createHash('sha256').update(raw).digest('hex');
if (actualSha !== BASELINE_SHA256) {
  console.error(`✖ baseline sha256 不符\n  期望 ${BASELINE_SHA256}\n  實際 ${actualSha}`);
  process.exit(1);
}
const rows = JSON.parse(raw.toString('utf8'));
console.log(`baseline ${rows.length.toLocaleString()} 列，sha256 ✓`);

const cases = {
  'imprint:10': { imprint: '10' },
  'imprint:T': { imprint: 'T' },
  'imprint:S': { imprint: 'S' },
  'imprint:M 40': { imprint: 'M 40' },
  'imprint:40 M': { imprint: '40 M' },
  'imprint:I JCP': { imprint: 'I JCP' },
  'imprint:ZZZZ9': { imprint: 'ZZZZ9' },
  'color:白': { color: ['白'] },
  'color:白+黃': { color: ['白', '黃'] },
  'white-round-noscore': { color: ['白'], shape: ['圓形'], score: '無' },
  'white-round-noscore+S': { color: ['白'], shape: ['圓形'], score: '無', imprint: 'S' },
};

const out = { cases: {} };
const problems = [];

for (const [name, criteria] of Object.entries(cases)) {
  const { tiers, partial, unknown } = run(rows, criteria);
  out.cases[name] = { criteria, tiers, partial, unknown };
  const want = EXPECTED_COUNTS[name];
  const got = tiers.map((t) => t.length);
  if (want && String(want) !== String(got)) {
    problems.push(`${name} 主區三級 期望 ${want} 實際 ${got}`);
  }
  console.log(`  ${name.padEnd(24)} 主區 ${got.join('/')}　部分 ${String(partial.length).padStart(4)}　未提供 ${unknown.length}`);
}

// D17 的迴歸護欄：**第四區不得改變既有三級與未提供區的任何成員**。
// 單 token 查詢在定義上不可能「部分」（全中或全不中），必須恆為 0。
for (const [name, c] of Object.entries(out.cases)) {
  const qTokens = fieldTokens(c.criteria.imprint ?? '');
  if (qTokens.length <= 1 && c.partial.length !== 0) {
    problems.push(`${name} 的查詢只有 ${qTokens.length} 個 token，部分符合區必須為 0，實際 ${c.partial.length}`);
  }
}

// 無 imprint token 的母體（A8c／A10 共用）
const noImprint = rows.filter((r) => rowTokens(r).length === 0).map((r) => String(r['許可證字號']).trim());
out.noImprintIds = noImprint;

// 字面「無」的標註（A8a／A8b）
const literalWu = [];
const literalWuWithOtherTokens = [];
let literalWuFieldOccurrences = 0;
for (const row of rows) {
  const m1 = String(row['標註一'] ?? '').trim();
  const m2 = String(row['標註二'] ?? '').trim();
  if (m1 === '無') literalWuFieldOccurrences++;
  if (m2 === '無') literalWuFieldOccurrences++;
  if (m1 === '無' || m2 === '無') {
    const id = String(row['許可證字號']).trim();
    literalWu.push(id);
    if (rowTokens(row).length > 0) literalWuWithOtherTokens.push(id);
  }
}
out.literalWuIds = literalWu;
out.literalWuWithOtherTokenIds = literalWuWithOtherTokens;
out.literalWuFieldOccurrences = literalWuFieldOccurrences;

// 多值欄位（A7）
out.multiValueIds = {
  color: rows.filter((r) => splitOn(r['顏色']).length > 1).map((r) => String(r['許可證字號']).trim()),
  shape: rows.filter((r) => splitOn(r['形狀']).length > 1).map((r) => String(r['許可證字號']).trim()),
  score_mark: rows.filter((r) => splitOn(r['刻痕']).length > 1).map((r) => String(r['許可證字號']).trim()),
};

// ── 自檢：與規格 §10 的數字比對 ────────────────────────────────────
const checks = [
  ['noImprint', noImprint.length, EXPECTED_COUNTS.noImprint],
  ['unknownColor', out.cases['color:白'].unknown.length, EXPECTED_COUNTS.unknownColor],
  ['unknownWhiteRoundNoScore', out.cases['white-round-noscore'].unknown.length, EXPECTED_COUNTS.unknownWhiteRoundNoScore],
  ['unknownWhiteRoundNoScoreS', out.cases['white-round-noscore+S'].unknown.length, EXPECTED_COUNTS.unknownWhiteRoundNoScoreS],
  ['literalWu（記錄數）', literalWu.length, EXPECTED_COUNTS.literalWu],
  ['literalWu（欄位出現次數）', literalWuFieldOccurrences, EXPECTED_COUNTS.literalWuFieldOccurrences],
  ['literalWuWithOtherTokens', literalWuWithOtherTokens.length, EXPECTED_COUNTS.literalWuWithOtherTokens],
];
for (const [label, got, want] of checks) {
  if (got !== want) problems.push(`${label} 期望 ${want} 實際 ${got}`);
}

// A2：M 40 與 40 M 必須完全相等（順序不敏感）
if (JSON.stringify(out.cases['imprint:M 40']) !== JSON.stringify({
  ...out.cases['imprint:40 M'], criteria: out.cases['imprint:M 40'].criteria,
})) {
  problems.push('「M 40」與「40 M」的結果不相等');
}

if (problems.length) {
  console.error(`\n✖ 與規格 §10 記載的數字不符（${problems.length} 項），未寫出：`);
  for (const p of problems) console.error(`    ${p}`);
  console.error('  這代表規則變更或 baseline 變更。**不要改本檔的常數來讓它通過**，');
  console.error('  先確認變更是有意的，並同步更新 .ai-review/plan.md §10。');
  process.exit(1);
}

out.meta = {
  baseline_file: 'tests/baseline-2026-08-12.json',
  baseline_sha256: BASELINE_SHA256,
  source_rows: rows.length,
  generated_by: 'tools/make-expected.mjs（獨立 oracle，不 import search.js）',
  generated_at: '2026-08-12',
  approved_by: '人工核准：liang（臨床藥師）',
  independence_note:
    '本檔與 search.js 零共用程式碼，但為同一工作階段寫成；'
    + '真正的外部錨點是計數必須等於 .ai-review/plan.md §10，'
    + '而那些數字產生於 search.js 之前。',
  regeneration_policy:
    '只有在 baseline 或規則有意變更時才重跑，且必須同步更新 plan.md §10 與本檔的 EXPECTED_COUNTS。'
    + '測試碼不得含任何回寫此檔的路徑。',
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n', 'utf8');
console.log(`\n✓ 全部自檢通過，已寫出 ${path.relative(ROOT, OUT)}`
  + `（${(fs.statSync(OUT).size / 1024).toFixed(0)} KB）`);
