#!/usr/bin/env node
/**
 * 產生 D 組回歸 fixtures（規格 D1r／D2r）。
 *
 *   node tools/make-fixtures.mjs
 *
 * 與 `make-expected.mjs` 同樣是**獨立 oracle**：本檔不 import `search.js`，
 * expected canonical item 用直白的欄位對應自己寫一次。
 *
 * 產物 `tests/fixtures.json` 是要**人工核准後凍結**的。
 * `tests/fixtures.test.mjs` 中不得有任何回寫它的路徑（D2r）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = path.join(ROOT, 'tests', 'baseline-2026-08-12.json');
const OUT = path.join(ROOT, 'tests', 'fixtures.json');
const BASELINE_SHA256 = '6f62c4ad5d0bf9af388adbc3bf9f6c005cde9625861a4522cbc96fd67ac125d1';

const raw = fs.readFileSync(BASELINE);
if (crypto.createHash('sha256').update(raw).digest('hex') !== BASELINE_SHA256) {
  console.error('✖ baseline sha256 不符');
  process.exit(1);
}
const rows = JSON.parse(raw.toString('utf8'));

// ── 直白版的欄位對應（刻意與 search.js 的 toItem 各寫一次）────────
const split = (v) => {
  const out = [];
  for (const part of String(v === null || v === undefined ? '' : v).split(';;;')) {
    const t = part.trim();
    if (t.length > 0) out.push(t);
  }
  return out;
};
const text = (v) => {
  const t = String(v === null || v === undefined ? '' : v).trim();
  return t.length > 0 ? t : null;
};
const key = (id) => crypto.createHash('sha1').update(id, 'utf8').digest('hex').slice(0, 16);

function expectedItem(row) {
  const id = String(row['許可證字號']).trim();
  return {
    id,
    zh: text(row['中文品名']),
    en: text(row['英文品名']),
    color: split(row['顏色']),
    shape: split(row['形狀']),
    score_mark: split(row['刻痕']),
    size: split(row['外觀尺寸']),
    mark1: text(row['標註一']),
    mark2: text(row['標註二']),
    imgs: split(row['外觀圖檔連結']).map((src, n) => ({
      file: `img/${key(id)}-${n}.webp`, src, sha256: null, src_bytes: null,
    })),
  };
}

// ── 覆蓋類別 ────────────────────────────────────────────────────────
const tok = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
const rowTok = (r) => [...new Set([...tok(r['標註一']), ...tok(r['標註二'])])];

const CATEGORIES = [
  ['no-color', 3, (r) => split(r['顏色']).length === 0],
  ['no-shape', 2, (r) => split(r['形狀']).length === 0],
  ['no-score', 2, (r) => split(r['刻痕']).length === 0],
  ['multi-image', 2, (r) => split(r['外觀圖檔連結']).length > 1],
  ['no-image', 1, (r) => split(r['外觀圖檔連結']).length === 0],
  ['multi-color-capsule', 1, (r) => split(r['顏色']).length > 1 && split(r['形狀']).includes('膠囊')
    && new Set(split(r['顏色'])).size === split(r['顏色']).length],
  ['duplicate-color', 1, (r) => split(r['顏色']).length > 1
    && new Set(split(r['顏色'])).size < split(r['顏色']).length],
  ['literal-wu-with-other', 1, (r) => (String(r['標註一'] ?? '').trim() === '無'
    || String(r['標註二'] ?? '').trim() === '無') && rowTok(r).length > 0],
  ['chinese-mark', 1, (r) => /[一-鿿]/.test(String(r['標註一'] ?? '') + String(r['標註二'] ?? ''))
    && rowTok(r).length > 0 && String(r['標註一'] ?? '').trim() !== '無'],
  ['both-marks-same', 2, (r) => String(r['標註一'] ?? '').trim()
    && String(r['標註一']).trim() === String(r['標註二'] ?? '').trim()],
  ['mark2-only', 1, (r) => !String(r['標註一'] ?? '').trim() && String(r['標註二'] ?? '').trim()],
  // 一般案例的定義：三個外觀欄皆單值非空、≥1 張圖、≥1 個有效 imprint token
  ['ordinary', 3, (r) => split(r['顏色']).length === 1 && split(r['形狀']).length === 1
    && split(r['刻痕']).length === 1 && split(r['外觀圖檔連結']).length === 1
    && rowTok(r).length > 0],
];

const picked = new Map();
const problems = [];
for (const [name, n, pred] of CATEGORIES) {
  const hits = rows.filter((r) => pred(r) && !picked.has(String(r['許可證字號']).trim()));
  if (hits.length < n) { problems.push(`類別 ${name} 只找到 ${hits.length} 筆，需要 ${n} 筆`); continue; }
  // 取排序後的前 n 筆，結果才與來源列順序無關（冪等）
  hits.sort((a, b) => (a['許可證字號'] < b['許可證字號'] ? -1 : 1));
  for (const r of hits.slice(0, n)) picked.set(String(r['許可證字號']).trim(), name);
}

if (problems.length) {
  console.error('✖ 覆蓋類別無法滿足：');
  for (const p of problems) console.error(`    ${p}`);
  process.exit(1);
}
if (picked.size !== 20) {
  console.error(`✖ 應挑出 20 筆，實際 ${picked.size}`);
  process.exit(1);
}

const byId = new Map(rows.map((r) => [String(r['許可證字號']).trim(), r]));
const out = {
  _about: 'D 組回歸 fixtures（規格 D1r／D2r）。expected 由 tools/make-fixtures.mjs 這支獨立 oracle 產生，'
    + '不 import search.js。tests/fixtures.test.mjs 不得含任何回寫本檔的路徑。',
  meta: {
    baseline_file: 'tests/baseline-2026-08-12.json',
    baseline_sha256: BASELINE_SHA256,
    generated_by: 'tools/make-fixtures.mjs（獨立 oracle）',
    generated_at: '2026-08-12',
    approved_by: '人工核准：liang（臨床藥師）',
    coverage_note: '每筆的 covers 標籤由 tests/fixtures.test.mjs 對 source 實際重新驗證，'
      + '不是只寫在這裡的宣稱。',
  },
  items: [...picked.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([id, covers]) => ({
    covers,
    source: byId.get(id),          // TFDA 原始欄位全文（D2r 要求記錄）
    expected: expectedItem(byId.get(id)),
  })),
};

fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n', 'utf8');
const counts = {};
for (const v of picked.values()) counts[v] = (counts[v] ?? 0) + 1;
console.log(`✓ 寫出 ${path.relative(ROOT, OUT)}（${picked.size} 筆）`);
for (const [k, v] of Object.entries(counts)) console.log(`    ${k.padEnd(22)} ${v}`);
