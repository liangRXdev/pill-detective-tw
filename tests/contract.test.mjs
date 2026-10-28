/**
 * B24 — 前端資料契約（D16）的純函式驗收。
 *
 * `contractErrors()` 原本是 `app.js` 的私有函式。本專案沒有 jsdom，
 * 留在 app.js 裡就**只剩原始碼掃描**，擋不住邏輯錯誤——理由與 `freshnessView` 抽出相同。
 * D16 是 fail-closed：這支函式放行壞資料＝畫面顯示**部分結果**而看起來正常。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { contractErrors } from '../search.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const rec = (id, over = {}) => ({
  id, zh: '測試錠', en: 'TEST', color: ['白'], shape: ['圓形'], score_mark: ['無'], size: ['8'],
  mark1: 'T 1', mark2: null, imgs: [{ file: `img/${id}-0.webp`, src: 'https://mcp.fda.gov.tw/x', sha256: null }],
  ...over,
});
const payload = (items, meta = {}) => ({ meta: { schema: 1, count: items.length, ...meta }, items });

test('B24 contractErrors：合法 payload 回 null（對照組——沒有它，「一律報錯」也會通過）', () => {
  assert.equal(contractErrors(payload([rec('A'), rec('B')])), null);
  assert.equal(contractErrors(payload([rec('A')], { images_complete: false })), null);
});

test('B24b contractErrors：id 重複必須報錯並指出該 id', () => {
  const bad = contractErrors(payload([rec('A'), rec('B'), rec('A')]));
  assert.ok(bad, 'B24b: id 重複被放行');
  assert.match(bad, /id 重複/);
  assert.match(bad, /\bA\b/);
});

test('B24c contractErrors：items 為空必須報錯（空陣列會被讀成「查無此藥」）', () => {
  assert.match(contractErrors(payload([])) ?? '', /items 為空/);
});

test('B24d contractErrors：結構損壞的每一種都必須報錯', () => {
  const cases = [
    [null, /不是物件/],
    ['x', /不是物件/],
    [{ meta: { schema: 2 }, items: [rec('A')] }, /schema/],
    [{ items: [rec('A')] }, /schema/],
    [payload([rec('A')], { images_complete: 'yes' }), /images_complete/],
    [{ meta: { schema: 1 }, items: {} }, /items 不是陣列/],
    [payload([rec('')]), /缺 id/],
    [payload([{ ...rec('A'), id: 7 }]), /缺 id/],
    [payload([null]), /缺 id/],
    [payload([rec('A', { color: '白' })]), /color 不是陣列/],
    [payload([rec('A', { size: null })]), /size 不是陣列/],
    [payload([rec('A', { imgs: null })]), /imgs 不是陣列/],
    [payload([rec('A', { imgs: [{ file: 1, src: 'x' }] })]), /imgs 結構損壞/],
    [payload([rec('A', { imgs: [null] })]), /imgs 結構損壞/],
  ];
  for (const [input, re] of cases) {
    const got = contractErrors(input);
    assert.ok(got, `B24d: ${JSON.stringify(input)?.slice(0, 80)} 被放行`);
    assert.match(got, re);
  }
});

test('B24e app.js 不得自帶契約檢查，必須 import search.js 的那一份', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  assert.doesNotMatch(src, /function\s+contractErrors\s*\(/, 'B24e: app.js 仍自己定義 contractErrors');
  const imp = src.match(/import\s*\{([^}]*)\}\s*from\s*'\.\/search\.js'/);
  assert.ok(imp && /\bcontractErrors\b/.test(imp[1]), 'B24e: app.js 沒有從 search.js import contractErrors');
  assert.match(src, /contractErrors\(payload\)/, 'B24e: load() 沒有呼叫契約檢查');
});
