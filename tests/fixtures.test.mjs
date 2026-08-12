/**
 * D 組驗收 — 回歸 fixtures（規格 `.ai-review/plan.md` §10 D1r–D3r）
 *
 * **D3r 拆成兩件事，不要混為一談：**
 *
 *   (a) 轉換回歸（本檔，自動）—— 靜態 fixture 經 `toItem()` 後輸出不變。
 *   (b) 來源對帳（人工，每次 TFDA 更新後）—— 比對這 20 個 id 在**最新**來源的欄位值。
 *
 * 靜態 fixture 當然永遠是綠的，**「測試仍綠」不得當成來源未漂移的證據**。
 * (b) 的執行紀錄放在 `.ai-review/reconciliation/`，格式依 E6。
 *
 * **本檔不得含任何回寫 fixtures.json 的路徑**（D2r）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { toItem, recordTokens } from '../search.js';
import { buildItems } from '../tools/fetch-appearance.mjs';

/**
 * 轉換分兩段，fixtures 釘住的是**實際出貨的那一段**：
 *   `search.js` 的 `toItem()`  → 欄位對應，`imgs[].file` 留 null
 *   管線的 `buildItems()`      → 補上資產鍵（需要 sha1，屬管線職責）
 * 只比對 `toItem()` 會漏掉資產鍵這一整層，而那正是 D12.1 第一條不變量的來源。
 */
const canonical = (row) => buildItems([row]).items[0];

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FX = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures.json'), 'utf8'));

const split = (v) => String(v ?? '').split(';;;').map((s) => s.trim()).filter(Boolean);

/**
 * 每個覆蓋類別的判定式，**在這裡重寫一次**。
 *
 * 只讀 `covers` 標籤等於相信產生器的宣稱——
 * fixture 看起來覆蓋很廣，實際可能全部落在同幾條路徑上。
 */
const PREDICATES = {
  'no-color': (r) => split(r['顏色']).length === 0,
  'no-shape': (r) => split(r['形狀']).length === 0,
  'no-score': (r) => split(r['刻痕']).length === 0,
  'multi-image': (r) => split(r['外觀圖檔連結']).length > 1,
  'no-image': (r) => split(r['外觀圖檔連結']).length === 0,
  'multi-color-capsule': (r) => split(r['顏色']).length > 1 && split(r['形狀']).includes('膠囊'),
  'duplicate-color': (r) => new Set(split(r['顏色'])).size < split(r['顏色']).length,
  'literal-wu-with-other': (r) => (String(r['標註一'] ?? '').trim() === '無'
    || String(r['標註二'] ?? '').trim() === '無'),
  'chinese-mark': (r) => /[一-鿿]/.test(String(r['標註一'] ?? '') + String(r['標註二'] ?? '')),
  'both-marks-same': (r) => String(r['標註一'] ?? '').trim()
    && String(r['標註一']).trim() === String(r['標註二'] ?? '').trim(),
  'mark2-only': (r) => !String(r['標註一'] ?? '').trim() && !!String(r['標註二'] ?? '').trim(),
  'ordinary': (r) => split(r['顏色']).length === 1 && split(r['形狀']).length === 1
    && split(r['刻痕']).length === 1 && split(r['外觀圖檔連結']).length === 1,
};

const REQUIRED = {
  'no-color': 3, 'no-shape': 2, 'no-score': 2, 'multi-image': 2, 'no-image': 1,
  'multi-color-capsule': 1, 'duplicate-color': 1, 'literal-wu-with-other': 1,
  'chinese-mark': 1, 'both-marks-same': 2, 'mark2-only': 1, 'ordinary': 3,
};

test('D1r fixtures 有 20 筆，且每筆確實具備它宣稱的特徵', () => {
  assert.equal(FX.items.length, 20);
  const counts = {};
  for (const f of FX.items) {
    const pred = PREDICATES[f.covers];
    assert.ok(pred, `D1r: 未知的覆蓋類別 ${f.covers}`);
    assert.ok(pred(f.source), `D1r: ${f.expected.id} 宣稱是 ${f.covers} 但實際不是`);
    counts[f.covers] = (counts[f.covers] ?? 0) + 1;
  }
  assert.deepEqual(counts, REQUIRED, 'D1r: 覆蓋類別的筆數不符');
  const ids = FX.items.map((f) => f.expected.id);
  assert.equal(new Set(ids).size, 20, 'D1r: 有重複的 id');
});

test('D1r「一般案例」有明確定義，不是沒被分到其他類的剩菜', () => {
  for (const f of FX.items.filter((x) => x.covers === 'ordinary')) {
    assert.equal(split(f.source['顏色']).length, 1);
    assert.equal(split(f.source['形狀']).length, 1);
    assert.equal(split(f.source['刻痕']).length, 1);
    assert.equal(split(f.source['外觀圖檔連結']).length, 1);
    assert.ok(recordTokens(f.expected).length > 0, 'ordinary 必須有有效 imprint token');
  }
});

test('D2r 每筆都附 TFDA 原始欄位，且 provenance 欄位齊備', () => {
  for (const f of FX.items) {
    assert.ok(f.source && typeof f.source === 'object', 'D2r: 缺 source');
    for (const k of ['許可證字號', '中文品名', '英文品名', '形狀', '顏色', '刻痕', '標註一', '外觀圖檔連結']) {
      assert.ok(k in f.source, `D2r: source 缺欄位 ${k}`);
    }
    assert.equal(String(f.source['許可證字號']).trim(), f.expected.id);
  }
  for (const k of ['baseline_sha256', 'generated_by', 'generated_at', 'approved_by']) {
    assert.ok(String(FX.meta[k] ?? '').trim(), `D2r: meta 缺 ${k}`);
  }
});

test('D2r 測試碼中不得存在回寫 fixtures 的路徑', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tests/fixtures.test.mjs'), 'utf8');
  // 針名以拼接產生：直接寫字面值會讓這條掃到自己的斷言而恆紅
  //（與 ui-smoke 的註解問題同一類——掃描器把自己算進了掃描範圍）
  const needles = ['write' + 'FileSync', 'append' + 'FileSync', 'update' + '-snapshot', 'UPDATE' + '_SNAPSHOT'];
  for (const bad of needles) {
    assert.ok(!src.includes(bad), `D2r: 本檔含疑似回寫路徑（${bad}）`);
  }
});

test('D3r(a) 轉換回歸：canonical(source) 必須逐欄等於凍結的 expected', () => {
  for (const f of FX.items) {
    assert.deepEqual(canonical(f.source), f.expected,
      `D3r: ${f.expected.id}（${f.covers}）的轉換結果與凍結值不符`);
  }
});

test('D3r(a) 資產鍵由管線補上，search.js 的 toItem 不負責（職責分界不得漂移）', () => {
  const f = FX.items[0];
  assert.equal(toItem(f.source).imgs[0]?.file ?? null, null,
    'toItem 開始自己算資產鍵了——那需要 sha1，屬管線職責');
  assert.match(canonical(f.source).imgs[0]?.file ?? '', /^img\/[0-9a-f]{16}-0\.webp$/);
});

test('D3r(a) 髒值的轉換結果符合規格的具名規則', () => {
  const by = (c) => FX.items.filter((f) => f.covers === c);

  // 缺值為空陣列或 null，不得填佔位字串
  for (const f of by('no-color')) assert.deepEqual(f.expected.color, []);
  for (const f of by('no-image')) assert.deepEqual(f.expected.imgs, []);

  // 重複值必須保留（膠囊兩截同色），不得去重
  for (const f of by('duplicate-color')) {
    assert.ok(new Set(f.expected.color).size < f.expected.color.length,
      'D3r: 重複顏色被去重了——白;;;白 與 白;;;紅 會變得無法區分');
  }

  // 字面「無」原樣保留（TFDA 原值，顯示它是誠實的），但不產生 token
  for (const f of by('literal-wu-with-other')) {
    const raw = [f.expected.mark1, f.expected.mark2];
    assert.ok(raw.includes('無'), 'D3r: 字面「無」未原樣保留');
    assert.ok(!recordTokens(f.expected).includes('無'), 'D3r: 字面「無」產生了 token');
    assert.ok(recordTokens(f.expected).length > 0, 'D3r: 同筆另一欄的有效 token 被清掉了');
  }

  // 中文標註只抽出英數 token
  for (const f of by('chinese-mark')) {
    for (const t of recordTokens(f.expected)) assert.match(t, /^[A-Z0-9]+$/);
  }

  // 多圖：序號從 0 連續編，且每張的 file 前綴相同
  for (const f of by('multi-image')) {
    assert.ok(f.expected.imgs.length > 1);
    f.expected.imgs.forEach((g, n) => assert.match(g.file, new RegExp(`-${n}\\.webp$`)));
    const keys = new Set(f.expected.imgs.map((g) => g.file.split('-')[0]));
    assert.equal(keys.size, 1, 'D3r: 同一筆的多張圖用了不同資產鍵');
  }
});

test('D3r(b) 來源對帳是人工程序，不得由靜態測試代勞', () => {
  // 這條刻意不去讀最新的 TFDA 來源——那會讓「離線跑測試」變成打外部 API，
  // 而且靜態 fixture 永遠會綠，證明不了來源沒漂移。
  // 它只確保**規格有記錄這個人工程序**，避免 D3r 退化成一條空條文。
  const plan = fs.readFileSync(path.join(ROOT, '.ai-review/plan.md'), 'utf8');
  assert.ok(plan.includes('來源對帳'), 'D3r: 規格未記錄人工來源對帳程序');
  assert.ok(plan.includes('不得當成來源未漂移的證據'), 'D3r: 規格未寫明靜態測試的限制');
});
