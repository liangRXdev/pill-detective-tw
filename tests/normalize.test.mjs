/**
 * B 組驗收 — 正規化純函式（規格 `.ai-review/plan.md` §10 B1–B7）
 *
 * 每一條都斷言 **exact token array**，不是 `includes` 也不是「結果碰巧相同」。
 * 寬鬆斷言在這裡特別危險：token 化錯誤會同時污染建置與查詢兩側，
 * 而兩側同樣錯的話，搜尋結果看起來還是「對的」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeImprintField, tokenizeQuery, recordTokens, splitMulti,
  normalizeName, imprintQueryState, QueryState, toItem,
} from '../search.js';

/** B1 的非空對照組——沒有它，「一律回空陣列」也會通過整組 B1 */
const GOLDEN = [
  ['FY T061', ['FY', 'T061']],
  ['YSP BTCp', ['YSP', 'BTCP']],
  ['HWANG S 26', ['HWANG', 'S', '26']],
  ['100', ['100']],
];

test('B1 空值一律回空陣列，且不影響非空案例', () => {
  for (const v of [null, undefined, '', '   ', '\t\n ']) {
    assert.deepEqual(normalizeImprintField(v), [], `B1: ${JSON.stringify(v)} 未回空陣列`);
  }
  // 回的是空陣列而不是 ['']
  assert.equal(normalizeImprintField('').length, 0);
  // 非空對照組：證明不是「一律回空陣列」
  for (const [input, want] of GOLDEN) {
    assert.deepEqual(normalizeImprintField(input), want, `B1: golden case「${input}」`);
  }
  // 回傳新陣列，兩次呼叫互不共用
  const a = normalizeImprintField('AB CD');
  const b = normalizeImprintField('AB CD');
  assert.notEqual(a, b);
  a.push('X');
  assert.deepEqual(b, ['AB', 'CD']);
});

test('B2 大小寫不敏感（純字母／字母+數字／多 token）', () => {
  const pairs = [
    ['apo', 'APO'],
    ['t061', 'T061'],
    ['ysp btcp', 'YSP BTCp'],
  ];
  for (const [lower, upper] of pairs) {
    assert.deepEqual(normalizeImprintField(lower), normalizeImprintField(upper),
      `B2:「${lower}」與「${upper}」不等價`);
  }
  assert.deepEqual(normalizeImprintField('apo'), ['APO']);
  assert.deepEqual(normalizeImprintField('ysp btcp'), ['YSP', 'BTCP']);
});

test('B3 空白：前置、後置、連續空白', () => {
  assert.deepEqual(normalizeImprintField('  AB'), ['AB']);
  assert.deepEqual(normalizeImprintField('AB  '), ['AB']);
  assert.deepEqual(normalizeImprintField('AB   CD'), ['AB', 'CD']);
  assert.deepEqual(normalizeImprintField('  AB \t CD  '), ['AB', 'CD']);
});

test('B4 符號 . - / \' 各自、混用、首尾', () => {
  assert.deepEqual(normalizeImprintField('A.B'), ['A', 'B']);
  assert.deepEqual(normalizeImprintField('A-B'), ['A', 'B']);
  assert.deepEqual(normalizeImprintField('A/B'), ['A', 'B']);
  assert.deepEqual(normalizeImprintField("A'B"), ['A', 'B']);
  assert.deepEqual(normalizeImprintField('A.-/B'), ['A', 'B']);
  assert.deepEqual(normalizeImprintField('.AB.'), ['AB']);
  assert.deepEqual(normalizeImprintField('-A-B-'), ['A', 'B']);
});

test('B5 ;;; 展開，且無任何 token 含分隔符', () => {
  const t = normalizeImprintField('頭CL;;;CL');
  assert.deepEqual(t, ['CL', 'CL']);        // 逐欄不去重，去重在 recordTokens
  assert.equal(t.length, 2);
  for (const x of t) assert.ok(!x.includes(';'), 'B5: token 含分隔符');

  // 只刪掉 ';;;' 會產生黏合 token —— 這條專門堵它
  assert.deepEqual(normalizeImprintField('AB;;;CD'), ['AB', 'CD']);
  assert.notDeepEqual(normalizeImprintField('AB;;;CD'), ['ABCD']);
  assert.deepEqual(normalizeImprintField('尾016;;;016'), ['016', '016']);
});

test('B6 中文：逐欄規則（不是逐筆）', () => {
  // 逐欄：這一欄只產生 K
  assert.deepEqual(normalizeImprintField('六邊形裡面有K'), ['K']);
  // 但同一筆記錄的 token 集合是兩欄聯集，實測為 ["K","KJ","195"]
  const item = { mark1: '六邊形裡面有K', mark2: 'KJ 195' };
  assert.deepEqual(recordTokens(item), ['K', 'KJ', '195']);

  assert.deepEqual(normalizeImprintField('無'), []);
  assert.deepEqual(normalizeImprintField('六邊形'), []);
  assert.deepEqual(normalizeImprintField('前AB後CD'), ['AB', 'CD']);
  // 全形英數不是 [A-Z0-9]，一律視為分隔（刻意：全形不會出現在藥錠刻字上）
  assert.deepEqual(normalizeImprintField('ＡＢ'), []);
});

test('B7 決定性：重複呼叫結果相同，且輸入與前次輸出不被 mutate', () => {
  for (const [input, want] of GOLDEN) {
    const first = normalizeImprintField(input);
    const second = normalizeImprintField(input);
    assert.deepEqual(first, want);
    assert.deepEqual(second, want);
    assert.deepEqual(first, second);
  }
  const obj = { mark1: 'AB CD', mark2: 'EF' };
  const snapshot = JSON.stringify(obj);
  const t1 = recordTokens(obj);
  const t2 = recordTokens(obj);
  assert.deepEqual(t1, t2);
  assert.equal(JSON.stringify(obj), snapshot, 'B7: 輸入被 mutate');
  t1.push('ZZ');
  assert.deepEqual(recordTokens(obj), t2, 'B7: 前次輸出被後次呼叫影響');
});

test('B8 recordTokens 去重（聯集），splitMulti 不去重（保留膠囊兩截）', () => {
  assert.deepEqual(recordTokens({ mark1: 'STD 511', mark2: 'STD 511' }), ['STD', '511']);
  // splitMulti 刻意保留重複與順序：白;;;白 代表兩截同色，去重會丟資訊
  assert.deepEqual(splitMulti('白;;;白'), ['白', '白']);
  assert.deepEqual(splitMulti('白;;;紅'), ['白', '紅']);
  assert.deepEqual(splitMulti(''), []);
  assert.deepEqual(splitMulti(null), []);
  assert.deepEqual(splitMulti(' A ;;; ;;; B '), ['A', 'B']);
});

test('B9 查詢 token 化與欄位 token 化必須是同一套規則', () => {
  for (const s of ['FY T061', 'a.b-c', '  X   Y  ', '頭CL;;;CL', '無']) {
    assert.deepEqual(tokenizeQuery(s), normalizeImprintField(s), `B9:「${s}」兩側規則不一致`);
  }
});

test('B10 imprintQueryState 三態', () => {
  assert.equal(imprintQueryState(''), QueryState.OFF);
  assert.equal(imprintQueryState('   '), QueryState.OFF);
  assert.equal(imprintQueryState(null), QueryState.OFF);
  assert.equal(imprintQueryState('10'), QueryState.VALID);
  assert.equal(imprintQueryState('a'), QueryState.VALID);
  assert.equal(imprintQueryState('無'), QueryState.NO_TOKEN);
  assert.equal(imprintQueryState('。。。'), QueryState.NO_TOKEN);
  assert.equal(imprintQueryState('  -  '), QueryState.NO_TOKEN);
});

test('B11 normalizeName 大小寫規則', () => {
  assert.equal(normalizeName('sodium'), 'SODIUM');
  assert.equal(normalizeName('蘇打'), '蘇打');
  assert.equal(normalizeName(null), '');
});

test('B12 toItem：缺值為 null 或空陣列，不填佔位字串；字面「無」原樣保留', () => {
  const row = {
    許可證字號: '衛署藥製字第000001號',
    中文品名: '測試錠',
    英文品名: 'TEST TABLET',
    形狀: '圓形',
    特殊劑型: '',
    顏色: '白;;;白',
    特殊氣味: '',
    刻痕: '無',
    外觀尺寸: '8',
    標註一: '無',
    標註二: null,
    外觀圖檔連結: 'https://example/a;;;https://example/b',
  };
  const it = toItem(row);
  assert.equal(it.mark1, '無', 'B12: TFDA 原值「無」必須原樣保留（顯示它是誠實的）');
  assert.equal(it.mark2, null);
  assert.deepEqual(recordTokens(it), [], 'B12: 字面「無」不得產生 token');
  assert.deepEqual(it.color, ['白', '白']);
  assert.deepEqual(it.size, ['8']);
  assert.equal(it.imgs.length, 2);
  assert.deepEqual(it.imgs.map((g) => g.src), ['https://example/a', 'https://example/b']);
  // 特殊劑型／特殊氣味不進 canonical（D8）
  assert.equal('特殊劑型' in it, false);
  assert.equal('特殊氣味' in it, false);

  const empty = toItem({ 許可證字號: 'X', 中文品名: '  ', 英文品名: 'E', 顏色: '', 形狀: '', 刻痕: '', 外觀尺寸: '', 標註一: '', 標註二: '', 外觀圖檔連結: '' });
  assert.equal(empty.zh, null);
  assert.deepEqual(empty.color, []);
  assert.deepEqual(empty.imgs, []);
});
