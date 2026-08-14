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
 * **刻字變體（D30–D37）的獨立性錨點（2026-08-14 追加）**
 *   - 變體規則在本檔**第三次**被寫出來，且刻意換一套資料結構：
 *     倒讀用「兩條平行字串 ＋ indexOf」而非物件字面值，字形用「成員→代表字的扁平對」
 *     而非類別陣列 ＋ find。抄寫錯誤在兩種表示法下不會長成同一個樣子。
 *   - 外部錨點是 `scratchpad/measure8.mjs`：它在 `search.js` 出現任何變體程式碼**之前**
 *     就算出了 21 個具名查詢的變體筆數與理由分佈（見 `plan-verdict-imprint-variant-2.md`
 *     的事實查核段）。`VARIANT_EXPECTED` 就是那份數字，**不得改它來讓自檢通過**。
 *   - 三方一致才算數：本檔（獨立 tokenize ＋ 獨立變體）↔ `search.js` ↔ `measure8.mjs`。
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

/**
 * 刻字變體的凍結數字（D30–D37）。格式：`[變體區筆數, 倒讀, 字形, 雙理由]`。
 *
 * **來源是 `scratchpad/measure8.mjs`，寫於 search.js 有任何變體程式碼之前。**
 * 改這裡的任何一個數字＝宣稱規則有意變更，必須同步 plan-imprint-variant.md 與測試。
 *
 * 三個「必須為 0」的類別各自守著一條規則，**不是湊數的**：
 *   - `MW`／`69`：倒讀後等於自己（fixed point 不算變體）
 *   - `TA`／`T`／`I JCP`：含表外字元 → 倒讀整條 false
 *   - `S`／`5`／`0`／`M 40`：查詢含單字元 token → 字形整條 false
 *   - `W L30`：兩條規則各中一個 token，**單一規則都不全中** → 必須排除（N15 守門）
 */
const VARIANT_EXPECTED = {
  'imprint:10': [22, 7, 15, 0],
  'imprint:T': [0, 0, 0, 0],
  'imprint:S': [0, 0, 0, 0],
  'imprint:M 40': [0, 0, 0, 0],
  'imprint:40 M': [0, 0, 0, 0],
  'imprint:I JCP': [0, 0, 0, 0],
  'imprint:ZZZZ9': [0, 0, 0, 0],
  'white-round-noscore+S': [0, 0, 0, 0],
  'imprint:SH': [42, 42, 0, 0],
  'imprint:HS': [4, 3, 1, 0],
  'imprint:01': [73, 71, 1, 1],      // 唯一自然出現的雙理由案例（A15f）
  'imprint:12': [4, 0, 4, 0],
  'imprint:B2': [4, 0, 4, 0],
  'imprint:S15': [1, 0, 1, 0],       // 主區 0、變體 1 → ONLY_UNCERTAIN（A16）
  'imprint:MS': [44, 43, 1, 0],      // F13-3 的 M/W witness
  // A15(e)：五個等價類各自的**雙向** witness，長度皆 ≥2（單字元證明不了雙向性，
  // 因為 canon 在那個情境根本沒啟用）。每組兩個拼法 canon 到同一個 key，
  // 但變體筆數不同——因為各自的「原樣已命中」不同，那些記錄不會重複進變體區。
  'imprint:O0': [2, 0, 2, 0],        // 0/O
  'imprint:0O': [2, 0, 2, 0],
  'imprint:15': [6, 0, 6, 0],        // 1/I/L
  'imprint:L5': [27, 0, 27, 0],
  'imprint:IS': [27, 0, 27, 0],
  'imprint:AS': [2, 0, 2, 0],        // 5/S ← F13-4 的 witness
  'imprint:A5': [18, 0, 18, 0],
  'imprint:M5': [2, 0, 2, 0],
  'imprint:Z2': [7, 0, 7, 0],        // 2/Z
  'imprint:2Z': [7, 0, 7, 0],
  'imprint:1Z': [16, 0, 16, 0],
  'imprint:8B': [1, 0, 1, 0],        // 8/B
  'imprint:B8': [1, 0, 1, 0],
  'imprint:82': [2, 0, 2, 0],
  'imprint:MW': [0, 0, 0, 0],
  'imprint:69': [0, 0, 0, 0],
  'imprint:OSO': [1, 0, 1, 0],
  'imprint:TA': [0, 0, 0, 0],
  'imprint:6': [10, 10, 0, 0],
  'imprint:9': [15, 15, 0, 0],
  'imprint:0': [0, 0, 0, 0],
  'imprint:5': [0, 0, 0, 0],
  'imprint:W L30': [0, 0, 0, 0],     // N15 守門（F13-10）
  'imprint:Y5P': [111, 0, 111, 0],   // 可達查詢閉包的最壞值（A17）
};

/**
 * A17：可達查詢閉包的**規則指紋**（不是政策上界）。
 *
 * 查詢域＝真實 token ∪ `flip(t)` ∪ 各 canon 類代表字。
 * v0.2 曾以「2,357 個真實 token」為母體，那是取樣偏誤——`Y5P` 是合法輸入、
 * 可達 111 筆，卻不在該母體內（見 plan-imprint-variant.md §3.4.1）。
 *
 * **任一數字變動即中止。** 放行字首級會讓 worst 上升、單字元啟用字形會讓它衝到 801。
 */
const CLOSURE_FINGERPRINT = { worst: 111, worstFlip: 84, worstCanon: 111 };

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

const MATCH = 1, MISMATCH = 2, UNKNOWN = 3, PARTIAL = 4, VARIANT = 5;

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

// ── 直白版的刻字變體（D32／D33／D34）───────────────────────────────
//
// **刻意換一套表示法**：`search.js` 用物件字面值 ＋ 類別陣列 ＋ `find`，
// 這裡用「兩條平行字串 ＋ indexOf」與「成員→代表字的扁平對」。
// 抄寫錯誤在兩種表示法下不會長成同一個樣子——那才是雙實作的意義。

/** 倒讀表：FROM[i] 旋轉 180° 之後變成 TO[i]。兩條長度必須相等（下方立即自檢）。 */
const FLIP_FROM = '01869HINOSXZMW';
const FLIP_TO   = '01896HINOSXZWM';
if (FLIP_FROM.length !== FLIP_TO.length || new Set(FLIP_FROM).size !== FLIP_FROM.length) {
  console.error('✖ 倒讀表自身不一致（長度不等或有重複字元）');
  process.exit(1);
}

/** 字形類：每一對是「成員, 代表字」。代表字自己不列（映射到自己是預設行為）。 */
const CANON_PAIRS = [['O', '0'], ['I', '1'], ['L', '1'], ['S', '5'], ['Z', '2'], ['B', '8']];

/** token 倒讀。**表外字元回 null**，不是回原字串（D32）。 */
function flipToken(token) {
  let out = '';
  for (let i = 0; i < token.length; i++) {
    const at = FLIP_FROM.indexOf(token[i]);
    if (at < 0) return null;
    out = FLIP_TO[at] + out;     // 前置 ＝ 一邊映射一邊反轉（search.js 是先反轉再映射）
  }
  return out;
}

/** token 字形壓平。類外字元原樣保留（D33）。 */
function canonToken(token) {
  let out = '';
  for (let i = 0; i < token.length; i++) {
    let ch = token[i];
    for (const [member, rep] of CANON_PAIRS) if (ch === member) { ch = rep; break; }
    out += ch;
  }
  return out;
}

/**
 * 變體判定（§5.2）。**只在 imprint 原樣比對為 MISMATCH 時呼叫。**
 *
 * 兩條 predicate 各自獨立，**每一條都必須單獨覆蓋全部查詢 token**。
 * 逐 token 混用兩條規則就是 N15 禁止的組合變體。
 *
 * @returns 理由陣列（序固定 flip→canon），兩條皆不成立時回 null。
 */
function variantOf(tokens, queryTokens) {
  const reasons = [];

  // 倒讀：任一 token 無合法倒讀 → 整條 false；全部是 fixed point → 整條 false
  let flipOk = true;
  let allFixed = true;
  for (const q of queryTokens) {
    const f = flipToken(q);
    if (f === null) { flipOk = false; break; }
    if (f !== q) allFixed = false;
    let found = false;
    for (const t of tokens) if (t === f) { found = true; break; }   // 只接受完全相等（D34）
    if (!found) { flipOk = false; break; }
  }
  if (flipOk && !allFixed) reasons.push('flip');

  // 字形：任一查詢 token 長度為 1 → 整條 false
  let canonOk = true;
  for (const q of queryTokens) if (q.length === 1) { canonOk = false; break; }
  if (canonOk) {
    for (const q of queryTokens) {
      const c = canonToken(q);
      let found = false;
      for (const t of tokens) if (canonToken(t) === c) { found = true; break; }
      if (!found) { canonOk = false; break; }
    }
  }
  if (canonOk) reasons.push('canon');

  return reasons.length > 0 ? reasons : null;
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
  const variant = [];

  for (const row of rows) {
    const states = [];
    let tier = 0;
    let reasons = null;

    if (color.length > 0) states.push(setCond(splitOn(row['顏色']), color));
    if (shape.length > 0) states.push(setCond(splitOn(row['形狀']), shape));
    if (score !== null) states.push(setCond(splitOn(row['刻痕']), [score]));
    if (imprintOn) {
      const tokens = rowTokens(row);
      const [st, tr] = imprintCond(tokens, queryTokens);
      // D31：只有 MISMATCH 才計算變體。其餘四種狀態照舊，
      // 因此 main／partial／unknown 三區逐筆不變、excluded 只會變少。
      if (st === MISMATCH) reasons = variantOf(tokens, queryTokens);
      // **置換**，不是並存——並存時底下的 hasMismatch 會先命中，記錄照樣被排除。
      states.push(reasons ? VARIANT : st);
      if (tr !== null) tier = tr;
    }

    let hasMismatch = false, hasUnknown = false, hasPartial = false, hasVariant = false;
    for (const s of states) {
      if (s === MISMATCH) hasMismatch = true;
      if (s === UNKNOWN) hasUnknown = true;
      if (s === PARTIAL) hasPartial = true;
      if (s === VARIANT) hasVariant = true;
    }
    const id = String(row['許可證字號']).trim();
    // 優先序 mismatch > variant > unknown > partial > main（D30）。
    // 其他條件的 mismatch 仍然壓過 variant——變體不得繞過條件間的 AND。
    if (hasMismatch) continue;
    if (hasVariant) variant.push({ id, reasons });
    else if (hasUnknown) unknown.push(id);
    else if (hasPartial) partial.push(id);
    else tiers[tier].push(id);
  }
  return { tiers, partial, unknown, variant };
}

/**
 * A17：掃完整可達查詢閉包，算出三個規則指紋。
 *
 * 查詢域＝真實 token ∪ `flip(t)` ∪ `canon(t)`。**不是只有真實 token**——
 * `Y5P` 是合法輸入、可達 111 筆，卻不是任何記錄的 token（規格 §3.4.1）。
 *
 * 為了跑得完，記錄側的 token 只算一次（每列一次），而不是每個查詢重算。
 */
function closureFingerprint(rows) {
  const perRow = rows.map((r) => {
    const toks = rowTokens(r);
    return { toks, canon: toks.map(canonToken) };
  });

  const real = new Set();
  for (const r of perRow) for (const t of r.toks) real.add(t);
  const closure = new Set(real);
  for (const t of real) {
    const f = flipToken(t);
    if (f !== null) closure.add(f);
    closure.add(canonToken(t));
  }

  let worst = 0, worstQ = '', worstFlip = 0, worstFlipQ = '', worstCanon = 0, worstCanonQ = '';
  for (const q of closure) {
    const queryTokens = fieldTokens(q);
    if (queryTokens.length === 0) continue;
    let n = 0, nf = 0, nc = 0;
    for (const r of perRow) {
      const [st] = imprintCond(r.toks, queryTokens);
      if (st !== MISMATCH) continue;
      const reasons = variantOf(r.toks, queryTokens);
      if (!reasons) continue;
      n++;
      if (reasons.includes('flip')) nf++;
      if (reasons.includes('canon')) nc++;
    }
    if (n > worst) { worst = n; worstQ = q; }
    if (nf > worstFlip) { worstFlip = nf; worstFlipQ = q; }
    if (nc > worstCanon) { worstCanon = nc; worstCanonQ = q; }
  }
  return {
    closureSize: closure.size, realTokens: real.size,
    worst, worstQ, worstFlip, worstFlipQ, worstCanon, worstCanonQ,
  };
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

  // ── 刻字變體（D30–D37）的具名查詢。每一個都守著規格裡一條具體的規則。
  'imprint:SH': { imprint: 'SH' },        // 變體區(42) > 主區(37)：不得混區（A15a）
  'imprint:HS': { imprint: 'HS' },        // 反向不對稱
  'imprint:01': { imprint: '01' },        // 唯一自然出現的雙理由記錄（A15f）
  'imprint:12': { imprint: '12' },
  'imprint:B2': { imprint: 'B2' },
  'imprint:S15': { imprint: 'S15' },      // 主區 0、變體 1 → ONLY_UNCERTAIN（A16）
  'imprint:MS': { imprint: 'MS' },        // M/W 具名查詢（F13-3）
  'imprint:MW': { imprint: 'MW' },        // fixed point（A15c）
  'imprint:69': { imprint: '69' },        // fixed point，跨字元對
  'imprint:OSO': { imprint: 'OSO' },      // 倒讀為自身，但字形仍可命中 → 理由不得含 flip
  'imprint:TA': { imprint: 'TA' },        // 表外字元（A15d）
  'imprint:6': { imprint: '6' },          // 單字元倒讀保留
  'imprint:9': { imprint: '9' },
  'imprint:0': { imprint: '0' },          // 單字元不做字形
  'imprint:5': { imprint: '5' },
  'imprint:W L30': { imprint: 'W L30' },  // N15 守門：兩規則各中一個 token 仍須排除（F13-10）
  'imprint:Y5P': { imprint: 'Y5P' },      // 可達查詢閉包最壞值 111（A17）
  // A15(e)：五個等價類的雙向 witness，長度皆 ≥2
  'imprint:O0': { imprint: 'O0' }, 'imprint:0O': { imprint: '0O' },
  'imprint:15': { imprint: '15' }, 'imprint:L5': { imprint: 'L5' }, 'imprint:IS': { imprint: 'IS' },
  'imprint:AS': { imprint: 'AS' }, 'imprint:A5': { imprint: 'A5' }, 'imprint:M5': { imprint: 'M5' },
  'imprint:Z2': { imprint: 'Z2' }, 'imprint:2Z': { imprint: '2Z' }, 'imprint:1Z': { imprint: '1Z' },
  'imprint:8B': { imprint: '8B' }, 'imprint:B8': { imprint: 'B8' }, 'imprint:82': { imprint: '82' },
};

const out = { cases: {} };
const problems = [];

for (const [name, criteria] of Object.entries(cases)) {
  const { tiers, partial, unknown, variant } = run(rows, criteria);
  // 變體區的元素是 { id, reasons }——**身份與理由不可分離**（D37）。
  // 拆成兩個平行陣列的話，排序之後理由就會貼到別筆記錄上。
  out.cases[name] = { criteria, tiers, partial, unknown, variant };

  const want = EXPECTED_COUNTS[name];
  const got = tiers.map((t) => t.length);
  if (want && String(want) !== String(got)) {
    problems.push(`${name} 主區三級 期望 ${want} 實際 ${got}`);
  }

  const byReason = [variant.length, 0, 0, 0];
  for (const v of variant) {
    if (v.reasons.length === 2) byReason[3]++;
    else if (v.reasons[0] === 'flip') byReason[1]++;
    else byReason[2]++;
  }
  const wantVar = VARIANT_EXPECTED[name];
  if (wantVar && String(wantVar) !== String(byReason)) {
    problems.push(`${name} 變體區 [總,倒讀,字形,雙] 期望 ${wantVar} 實際 ${byReason}`);
  }

  console.log(`  ${name.padEnd(24)} 主區 ${got.join('/')}　部分 ${String(partial.length).padStart(4)}`
    + `　未提供 ${unknown.length}　變體 ${String(variant.length).padStart(3)}`
    + ` (${byReason[1]}/${byReason[2]}/${byReason[3]})`);
}

// D17 的迴歸護欄：**第四區不得改變既有三級與未提供區的任何成員**。
// 單 token 查詢在定義上不可能「部分」（全中或全不中），必須恆為 0。
for (const [name, c] of Object.entries(out.cases)) {
  const qTokens = fieldTokens(c.criteria.imprint ?? '');
  if (qTokens.length <= 1 && c.partial.length !== 0) {
    problems.push(`${name} 的查詢只有 ${qTokens.length} 個 token，部分符合區必須為 0，實際 ${c.partial.length}`);
  }

  // ── 變體區的結構不變量（D37）。這些不靠凍結數字，任何 baseline 都必須成立。
  const seen = new Set();
  for (const v of c.variant) {
    if (seen.has(v.id)) problems.push(`${name} 的變體區有重複 id ${v.id}`);
    seen.add(v.id);
    if (!Array.isArray(v.reasons) || v.reasons.length === 0) {
      problems.push(`${name} 的變體 ${v.id} 理由為空——空集合會被讀成「有變體但不知為何」`);
    }
    for (const r of v.reasons) {
      if (r !== 'flip' && r !== 'canon') problems.push(`${name} 的變體 ${v.id} 出現未知理由 ${r}`);
    }
  }
  // 變體區與其他四區不得重疊（原樣命中的記錄不進變體，是 D31 的推論而非另一條規則）
  const others = new Set([...c.tiers.flat(), ...c.partial, ...c.unknown]);
  for (const v of c.variant) {
    if (others.has(v.id)) problems.push(`${name} 的 ${v.id} 同時出現在變體區與其他分區`);
  }
  // imprint 未啟用或無有效 token 時，變體區必須為空（§5.1 前兩列）
  if (qTokens.length === 0 && c.variant.length !== 0) {
    problems.push(`${name} 沒有有效 imprint token，變體區必須為 0，實際 ${c.variant.length}`);
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

// ── A17：可達查詢閉包的規則指紋 ────────────────────────────────────
const fp = closureFingerprint(rows);
console.log(`\n可達查詢閉包 ${fp.closureSize}（真實 token ${fp.realTokens}）`);
console.log(`  最壞變體區       ${String(fp.worst).padStart(4)}  ("${fp.worstQ}")`);
console.log(`  flip  上界       ${String(fp.worstFlip).padStart(4)}  ("${fp.worstFlipQ}")`);
console.log(`  canon 上界       ${String(fp.worstCanon).padStart(4)}  ("${fp.worstCanonQ}")`);
out.closureFingerprint = {
  closure_size: fp.closureSize, real_tokens: fp.realTokens,
  worst: fp.worst, worst_query: fp.worstQ,
  worst_flip: fp.worstFlip, worst_flip_query: fp.worstFlipQ,
  worst_canon: fp.worstCanon, worst_canon_query: fp.worstCanonQ,
  note: '規則指紋，非政策上界。任一數字變動＝規則漂移，見 plan-imprint-variant.md A17。',
};
for (const [k, want] of Object.entries(CLOSURE_FINGERPRINT)) {
  if (fp[k] !== want) problems.push(`A17 閉包指紋 ${k} 期望 ${want} 實際 ${fp[k]}`);
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
