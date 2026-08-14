/**
 * A 組驗收 — 搜尋語意（規格 `.ai-review/plan.md` §10 A1–A12、D17）
 *
 * 全部對凍結 baseline 執行（D13）。expected ID sets 來自 `tests/expected/`，
 * 由**獨立 oracle** `tools/make-expected.mjs` 產生，**不得由 search.js 生成**。
 *
 * 本檔中所有逐筆 predicate 都用檔案下方的 naive* 系列**自己重寫一次**，
 * 刻意不從 search.js import——與受測程式共用 helper 的斷言證明不了任何事。
 *
 * **本檔不得出現任何寫入或更新 expected 的路徑**（D13）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  toItem, indexItems, search, resultStates, relaxSuggestions,
  ResultState, QueryState, SCORE_ANY, COLORS,
} from '../search.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rows = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/baseline-2026-08-12.json'), 'utf8'));
const EXP = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/expected/expected-2026-08-12.json'), 'utf8'));
const items = indexItems(rows.map(toItem));

const TOTAL = 6295;

// ── 獨立 oracle（本檔自有，不從 search.js import）─────────────────
const naiveSplit = (v) => String(v ?? '').split(';;;').map((s) => s.trim()).filter(Boolean);
const naiveTokens = (v) => {
  const out = [];
  let buf = '';
  for (const ch of String(v ?? '').toUpperCase()) {
    if ((ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9')) buf += ch;
    else if (buf) { out.push(buf); buf = ''; }
  }
  if (buf) out.push(buf);
  return out;
};
const naiveRowTokens = (row) => [...new Set([...naiveTokens(row['標註一']), ...naiveTokens(row['標註二'])])];
const rowOf = (id) => rows.find((r) => String(r['許可證字號']).trim() === id);
const naiveHits = (row, q) => {
  const toks = naiveRowTokens(row);
  return naiveTokens(q).filter((t) =>
    toks.some((x) => x === t || x.startsWith(t) || (t.length > 1 && x.includes(t))));
};
const naiveTier = (row, q) => {
  const toks = naiveRowTokens(row);
  let worst = 0;
  for (const t of naiveTokens(q)) {
    let best = null;
    for (const x of toks) {
      if (x === t) { best = 0; break; }
      if (x.slice(0, t.length) === t) best = best === null ? 1 : Math.min(best, 1);
      // D18：單字元查詢 token 不啟用「包含」級
      else if (t.length > 1 && x.indexOf(t) >= 0) best = best === null ? 2 : Math.min(best, 2);
    }
    if (best === null) return null;
    worst = Math.max(worst, best);
  }
  return worst;
};

// 變體規則的 naive 版（D32／D33／D34）。**同樣不從 search.js import**——
// 這是這條規則的第四次獨立書寫（production／oracle／規格期量測腳本／本檔）。
const NAIVE_FLIP = { 0: '0', 1: '1', 8: '8', 6: '9', 9: '6', H: 'H', I: 'I', N: 'N', O: 'O', S: 'S', X: 'X', Z: 'Z', M: 'W', W: 'M' };
const NAIVE_CANON = { O: '0', I: '1', L: '1', S: '5', Z: '2', B: '8' };
const naiveFlip = (t) => {
  let out = '';
  for (let i = t.length - 1; i >= 0; i--) {
    const m = NAIVE_FLIP[t[i]];
    if (m === undefined) return null;
    out += m;
  }
  return out;
};
const naiveCanon = (t) => [...t].map((c) => NAIVE_CANON[c] ?? c).join('');
/** 回傳理由陣列或 null。兩條 predicate 各自獨立、各自須覆蓋全部查詢 token。 */
const naiveVariant = (row, q) => {
  const toks = naiveRowTokens(row);
  const qs = naiveTokens(q);
  const reasons = [];
  const flipped = qs.map(naiveFlip);
  if (!flipped.some((f) => f === null)
    && !flipped.every((f, i) => f === qs[i])
    && flipped.every((f) => toks.includes(f))) reasons.push('flip');
  if (!qs.some((t) => t.length === 1)
    && qs.map(naiveCanon).every((c) => toks.some((t) => naiveCanon(t) === c))) reasons.push('canon');
  return reasons.length ? reasons : null;
};

// ── 測試工具 ────────────────────────────────────────────────────────
const ids = (list) => list.map((i) => i.id).sort();
const sorted = (a) => [...a].sort();
/** 變體區的元素是 `{ item, reasons }`，不是裸 item（D37：身份與理由不可分離）。 */
const variantIds = (res) => res.variant.map((v) => v.item.id).sort();
const buckets = (res) => [
  ...res.tiers.map(ids), ids(res.partial), ids(res.unknown), variantIds(res),
];

/** 六區 pairwise disjoint、無重複，且六區 ∪ 排除 === 全量（窮盡性） */
function assertPartition(res, label) {
  const bs = buckets(res);
  for (const b of bs) assert.equal(new Set(b).size, b.length, `${label}: 分區內有重複 id`);
  for (let i = 0; i < bs.length; i++) {
    for (let j = i + 1; j < bs.length; j++) {
      const overlap = bs[i].filter((x) => bs[j].includes(x));
      assert.deepEqual(overlap, [], `${label}: 分區 ${i} 與 ${j} 重疊`);
    }
  }
  const union = bs.flat();
  assert.equal(new Set(union).size, union.length, `${label}: 跨分區有重複`);
  assert.equal(union.length + res.excludedCount, TOTAL, `${label}: 六區 ＋ 排除 不等於 ${TOTAL}`);

  // D37：理由的 domain 必須與變體區的 ID set **完全相等**（雙向），
  // 且理由集合不得為空——空集合會被讀成「有變體但不知道為什麼」。
  for (const v of res.variant) {
    assert.ok(v.item && v.item.id, `${label}: 變體區元素缺少 item`);
    assert.ok(Array.isArray(v.reasons) && v.reasons.length > 0, `${label}: 變體區 ${v.item.id} 理由為空`);
    for (const r of v.reasons) {
      assert.ok(['flip', 'canon'].includes(r), `${label}: 變體區 ${v.item.id} 出現未知理由 ${r}`);
    }
  }
}

function assertCase(res, key, label) {
  const e = EXP.cases[key];
  assert.deepEqual(ids(res.tiers[0]), sorted(e.tiers[0]), `${label}: 完全符合區成員不符`);
  assert.deepEqual(ids(res.tiers[1]), sorted(e.tiers[1]), `${label}: 字首符合區成員不符`);
  assert.deepEqual(ids(res.tiers[2]), sorted(e.tiers[2]), `${label}: 包含區成員不符`);
  assert.deepEqual(ids(res.partial), sorted(e.partial), `${label}: 部分符合區成員不符`);
  assert.deepEqual(ids(res.unknown), sorted(e.unknown), `${label}: 未提供區成員不符`);
  assertPartition(res, label);
}

// ── A1 ──────────────────────────────────────────────────────────────
test('A1 imprint 10：三個互斥分區 72/129/67，未提供區 2085', () => {
  const res = search(items, { imprint: '10' });
  assert.deepEqual(res.tiers.map((t) => t.length), [72, 129, 67]);
  assert.equal(res.mainCount, 268);
  assert.equal(res.unknown.length, 2085);
  assertCase(res, 'imprint:10', 'A1');

  for (let tier = 0; tier < 3; tier++) {
    for (const it of res.tiers[tier]) {
      assert.equal(naiveTier(rowOf(it.id), '10'), tier, `A1: ${it.id} 等級錯置`);
    }
  }
  for (const it of res.unknown) {
    assert.deepEqual(naiveRowTokens(rowOf(it.id)), [], `A1: ${it.id} 有 token 卻進未提供區`);
  }
});

// ── A2 ──────────────────────────────────────────────────────────────
test('A2 M 40 與 40 M 結果完全相等且非空', () => {
  const a = search(items, { imprint: 'M 40' });
  const b = search(items, { imprint: '40 M' });
  assert.deepEqual(buckets(a), buckets(b), 'A2: 順序敏感');
  assert.deepEqual(a.tiers.map((t) => t.length), [2, 4, 5]);
  assert.equal(a.mainCount, 11, 'A2: 主區為空——相等但無意義');
  assert.equal(a.partial.length, 294, 'A2: 部分符合區筆數');
  assertCase(a, 'imprint:M 40', 'A2');
});

// ── D18 單字元查詢不啟用「包含」級 ─────────────────────────────────
test('D18a 單字元查詢的包含級恆為 0，且完全／字首兩級不受影響', () => {
  for (const [q, want] of [['T', [95, 333, 0]], ['S', [174, 657, 0]], ['1', null]]) {
    const res = search(items, { imprint: q });
    assert.equal(res.tiers[2].length, 0, `D18a: ${q} 的包含級應為 0`);
    if (want) assert.deepEqual(res.tiers.map((t) => t.length), want, `D18a: ${q}`);
  }
  // 多字元查詢的包含級照常運作——D18 只針對單字元
  assert.equal(search(items, { imprint: '10' }).tiers[2].length, 67);
});

test('D18b 單字元 token 在多 token 查詢中同樣不啟用包含級', () => {
  // 「M 40」的 M 是單字元：D18 前主區 2/4/13、部分 504；之後為 2/4/5、部分 294
  const res = search(items, { imprint: 'M 40' });
  assert.deepEqual(res.tiers.map((t) => t.length), [2, 4, 5]);
  for (const it of res.tiers.flat()) {
    const toks = naiveRowTokens(rowOf(it.id));
    // 每一筆的 M 必須是完全或字首命中，不得是「某個 token 內含 M」
    assert.ok(toks.some((t) => t === 'M' || t.startsWith('M')),
      `D18b: ${it.id} 的 M 只有包含級命中`);
  }
});

test('A2b 查詢 token 分散於標註一／標註二時仍須命中（跨欄聯集）', () => {
  // 內衛藥製字第000278號：標註一 = "I 15"、標註二 = "JCP"
  // 「I JCP」在同欄全中的語意下命中 0 筆；聯集語意下命中 3 筆。
  // 這條是唯一能區分兩種語意的斷言。
  const res = search(items, { imprint: 'I JCP' });
  assert.equal(res.mainCount, 3, 'A2b: 跨欄聯集失效（同欄語意會是 0）');
  assert.ok(ids(res.tiers.flat()).includes('內衛藥製字第000278號'));
  const r = rowOf('內衛藥製字第000278號');
  assert.deepEqual(naiveTokens(r['標註一']), ['I', '15']);
  assert.deepEqual(naiveTokens(r['標註二']), ['JCP']);
});

// ── D17 部分符合區 ──────────────────────────────────────────────────
test('D17a 單 token 查詢的部分符合區恆為 0（全中或全不中，沒有中間態）', () => {
  for (const q of ['10', 'T', 'S', 'APO', 'ZZZZ9']) {
    assert.equal(search(items, { imprint: q }).partial.length, 0, `D17a: ${q}`);
  }
});

test('D17b 部分符合區逐筆：至少一個查詢 token 命中、但非全部', () => {
  const res = search(items, { imprint: 'M 40' });
  for (const it of res.partial) {
    const hits = naiveHits(rowOf(it.id), 'M 40');
    assert.ok(hits.length > 0, `D17b: ${it.id} 一個 token 都沒中，應被排除`);
    assert.ok(hits.length < 2, `D17b: ${it.id} 全中，應在主區`);
  }
  // 一個都沒中的仍須被完全排除——「部分符合」不是「什麼都收」
  const shown = new Set([...res.tiers.flat(), ...res.partial, ...res.unknown].map((i) => i.id));
  const zeroHit = rows.filter((r) => naiveRowTokens(r).length > 0 && naiveHits(r, 'M 40').length === 0);
  assert.ok(zeroHit.length > 0);
  for (const r of zeroHit) {
    assert.ok(!shown.has(String(r['許可證字號']).trim()), 'D17b: 零命中者不得出現在任何區');
  }
});

test('D17c 第四區不得改變既有三級與未提供區（凍結數字的迴歸護欄）', () => {
  // 註：2/4/5 是 D18 之後的值（D17 剛引入時為 2/4/13）。
  // D17 本身不改動三級，改動三級的是 D18——兩次變更都在規格 §14 有紀錄。
  const a = search(items, { imprint: 'M 40' });
  assert.deepEqual(a.tiers.map((t) => t.length), [2, 4, 5]);
  assert.equal(a.unknown.length, 2085);
  const b = search(items, { imprint: '10' });
  assert.deepEqual(b.tiers.map((t) => t.length), [72, 129, 67]);
  assert.equal(b.unknown.length, 2085);
});

test('D17d 未提供區優先於部分符合區（TFDA 沒填 優先於 填了但不完整）', () => {
  const grid = indexItems([
    { id: 'A', zh: 'a', en: 'a', color: [], shape: [], score_mark: [], size: [], mark1: 'M', mark2: null, imgs: [] },
    { id: 'B', zh: 'b', en: 'b', color: ['白'], shape: [], score_mark: [], size: [], mark1: 'M', mark2: null, imgs: [] },
  ]);
  const res = search(grid, { color: ['白'], imprint: 'M 40' });
  assert.deepEqual(ids(res.unknown), ['A']);
  assert.deepEqual(ids(res.partial), ['B']);
});

// ── A3 ──────────────────────────────────────────────────────────────
test('A3 imprint T：互斥分區 95/333/0（D18 後包含級歸零；D18 前為 95/333/522）', () => {
  const res = search(items, { imprint: 'T' });
  assert.deepEqual(res.tiers.map((t) => t.length), [95, 333, 0]);
  assert.equal(res.mainCount, 428);
  assertCase(res, 'imprint:T', 'A3');
  for (let tier = 0; tier < 3; tier++) {
    for (const it of res.tiers[tier]) {
      assert.equal(naiveTier(rowOf(it.id), 'T'), tier, `A3: ${it.id} 等級錯置`);
    }
  }
});

// ── A4 ──────────────────────────────────────────────────────────────
test('A4 顏色=白：主區 2680、未提供區 217', () => {
  const res = search(items, { color: ['白'] });
  assert.equal(res.mainCount, 2680);
  assert.equal(res.unknown.length, 217);
  assertCase(res, 'color:白', 'A4');

  for (const it of res.tiers[0]) {
    assert.ok(naiveSplit(rowOf(it.id)['顏色']).includes('白'), `A4: ${it.id} 不含白卻在主區`);
  }
  for (const it of res.unknown) {
    assert.deepEqual(naiveSplit(rowOf(it.id)['顏色']), [], `A4: ${it.id} 有顏色卻進未提供區`);
  }
});

test('A4b 13 個顏色全值的集合性質（不是只有白特判正確）', () => {
  for (const c of COLORS) {
    const res = search(items, { color: [c] });
    const want = rows.filter((r) => naiveSplit(r['顏色']).includes(c)).map((r) => String(r['許可證字號']).trim());
    assert.deepEqual(ids(res.tiers[0]), sorted(want), `A4b: 顏色 ${c} 主區不符`);
    assert.equal(res.unknown.length, 217, `A4b: 顏色 ${c} 的未提供區應恆為 217`);
  }
});

// ── A5 ──────────────────────────────────────────────────────────────
test('A5 白+圓形+無刻痕：主區 754、未提供區 205（754 是含白，不是恰為白）', () => {
  const res = search(items, { color: ['白'], shape: ['圓形'], score: '無' });
  assert.equal(res.mainCount, 754);
  assert.equal(res.unknown.length, 205);
  assertCase(res, 'white-round-noscore', 'A5');

  for (const it of res.tiers[0]) {
    const r = rowOf(it.id);
    assert.ok(naiveSplit(r['顏色']).includes('白'));
    assert.ok(naiveSplit(r['形狀']).includes('圓形'));
    assert.ok(naiveSplit(r['刻痕']).includes('無'));
  }
  for (const it of res.unknown) {
    const r = rowOf(it.id);
    const cs = [
      [naiveSplit(r['顏色']), '白'], [naiveSplit(r['形狀']), '圓形'], [naiveSplit(r['刻痕']), '無'],
    ];
    assert.ok(cs.some(([v]) => v.length === 0), `A5: ${it.id} 無缺值卻進未提供區`);
    for (const [v, want] of cs) {
      if (v.length) assert.ok(v.includes(want), `A5: ${it.id} 有明確 mismatch 卻進未提供區`);
    }
  }
  // 「恰為白」的分組數是 683，若實作誤用集合相等會得到它
  assert.notEqual(res.mainCount, 683, 'A5: 誤用「顏色恰為白」的語意');
});

test('A5b 三值優先序：mismatch 必須優先於 unknown（合成 3x3 矩陣）', () => {
  // 全量數字只在單一資料分布上成立。這裡用合成資料把九種組合逐格走過。
  const mk = (color, shape) => ({
    id: `X${color.join('')}-${shape.join('')}`, zh: 'z', en: 'e',
    color, shape, score_mark: ['無'], size: [], mark1: null, mark2: null, imgs: [],
  });
  const grid = [];
  for (const c of [['白'], ['黑'], []]) for (const s of [['圓形'], ['膠囊'], []]) grid.push(mk(c, s));

  const res = search(indexItems(grid), { color: ['白'], shape: ['圓形'] });
  const got = Object.fromEntries([
    ...res.tiers[0].map((i) => [i.id, 'main']),
    ...res.partial.map((i) => [i.id, 'partial']),
    ...res.unknown.map((i) => [i.id, 'unknown']),
  ]);
  const bucketOf = (id) => got[id] ?? 'excluded';

  assert.equal(bucketOf('X白-圓形'), 'main');
  assert.equal(bucketOf('X白-膠囊'), 'excluded');
  assert.equal(bucketOf('X白-'), 'unknown');
  assert.equal(bucketOf('X黑-圓形'), 'excluded');
  assert.equal(bucketOf('X黑-膠囊'), 'excluded');
  assert.equal(bucketOf('X黑-'), 'excluded', 'mismatch 必須優先於 unknown');
  assert.equal(bucketOf('X-圓形'), 'unknown');
  assert.equal(bucketOf('X-膠囊'), 'excluded', 'mismatch 必須優先於 unknown');
  assert.equal(bucketOf('X-'), 'unknown');
});

// ── A6 ──────────────────────────────────────────────────────────────
test('A6a 未輸入 imprint 時，結果集合須與 A5 完全相同', () => {
  const base = search(items, { color: ['白'], shape: ['圓形'], score: '無' });
  const withEmpty = search(items, { color: ['白'], shape: ['圓形'], score: '無', imprint: '   ' });
  assert.deepEqual(buckets(withEmpty), buckets(base), 'A6a: 空 imprint 改變了結果');
  assert.equal(withEmpty.imprintQueryState, QueryState.OFF);

  // 「imprint 未啟用 ＋ 記錄 token 集合為空」這一格：必須是 match，不得移入未提供區
  const noTok = base.tiers[0].filter((i) => naiveRowTokens(rowOf(i.id)).length === 0);
  assert.equal(noTok.length, 214, 'A6a: 無標註的藥被排除或移進未提供區了');
});

test('A6b 白+圓形+無+imprint S：主區 94（16/78/0）、未提供區 419，UI 為已無更多條件可縮小', () => {
  const criteria = { color: ['白'], shape: ['圓形'], score: '無', imprint: 'S' };
  const res = search(items, criteria);
  assert.deepEqual(res.tiers.map((t) => t.length), [16, 78, 0]);
  assert.equal(res.mainCount, 94);
  assert.equal(res.unknown.length, 419);
  assertCase(res, 'white-round-noscore+S', 'A6b');

  // UI 狀態必須由這一次搜尋的實際輸出推出，不得硬編
  assert.deepEqual(resultStates(res, criteria), [ResultState.TOO_MANY_EXHAUSTED]);
  // 少填一個外觀條件就必須改回「還可以補」
  const partial = { ...criteria, score: SCORE_ANY };
  assert.deepEqual(resultStates(search(items, partial), partial), [ResultState.TOO_MANY_CAN_REFINE]);
});

// ── A7 ──────────────────────────────────────────────────────────────
test('A7 多值欄位：color／shape／score_mark 每個存在值皆命中，重複值不產生重複卡片', () => {
  const fields = [['color', '顏色'], ['shape', '形狀'], ['score_mark', '刻痕']];
  for (const [key, zhField] of fields) {
    const targets = EXP.multiValueIds[key];
    assert.ok(targets.length > 0, `A7: ${key} 沒有多值案例可測`);
    // 每個值只搜一次，再看多值記錄是否落在裡面（逐筆重搜是分鐘級）
    const values = [...new Set(targets.flatMap((id) => naiveSplit(rowOf(id)[zhField])))];
    for (const v of values) {
      const res = search(items, key === 'score_mark' ? { score: v } : { [key]: [v] });
      const hit = res.tiers.flat().map((i) => i.id);
      const hitSet = new Set(hit);
      assert.equal(hit.length, hitSet.size, `A7: 值 ${v} 的結果含重複卡片`);
      for (const id of targets) {
        if (!naiveSplit(rowOf(id)[zhField]).includes(v)) continue;
        assert.ok(hitSet.has(id), `A7: ${id} 的值 ${v} 未命中`);
      }
    }
  }
  // 不存在的值不得命中
  const dup = '內衛藥製字第000258號';   // 顏色 = 藍;;;白;;;藍;;;白
  assert.deepEqual(naiveSplit(rowOf(dup)['顏色']), ['藍', '白', '藍', '白']);
  const miss = search(items, { color: ['黑'] }).tiers.flat().map((i) => i.id);
  assert.ok(!miss.includes(dup), 'A7: 不存在的顏色卻命中');
});

// ── A8 ──────────────────────────────────────────────────────────────
test('A8a 字面「無」：6 筆記錄／9 個欄位出現，皆不產生 token', () => {
  assert.equal(EXP.literalWuIds.length, 6);
  assert.equal(EXP.literalWuFieldOccurrences, 9);
  for (const id of EXP.literalWuIds) {
    assert.ok(!naiveRowTokens(rowOf(id)).includes('無'), `A8a: ${id} 的 token 含「無」`);
  }
});

test('A8b 兩欄之一為「無」但另一欄有效者（3 筆），其有效 token 仍可搜尋到', () => {
  assert.equal(EXP.literalWuWithOtherTokenIds.length, 3);
  for (const id of EXP.literalWuWithOtherTokenIds) {
    const toks = naiveRowTokens(rowOf(id));
    assert.ok(toks.length > 0);
    const hit = search(items, { imprint: toks[0] }).tiers.flat().map((i) => i.id);
    assert.ok(hit.includes(id), `A8b: ${id} 的有效 token ${toks[0]} 搜不到——整筆被清空了`);
  }
});

test('A8c 只有兩欄皆無有效 token 的 2085 筆才算「無 imprint」', () => {
  assert.equal(EXP.noImprintIds.length, 2085);
  const res = search(items, { imprint: 'ZZZZ9' });
  assert.deepEqual(ids(res.unknown), sorted(EXP.noImprintIds));
});

test('A8d 零 token 查詢：不套用篩選並提示，且不限於「無」的個案特判', () => {
  for (const q of ['無', '。。。', '六邊形', '   -  ']) {
    const res = search(items, { imprint: q });
    assert.equal(res.imprintQueryState, QueryState.NO_TOKEN, `A8d: ${q} 狀態判定錯誤`);
    assert.equal(res.mainCount, TOTAL, `A8d: ${q} 不應縮減候選（規格 D3：忽略此條件）`);
    assert.equal(res.partial.length, 0);
    assert.equal(res.unknown.length, 0);
    assert.ok(resultStates(res, { imprint: q }).includes(ResultState.NO_TOKEN_NOTICE));
  }
  // 對照組：有效查詢不得落入 NO_TOKEN
  assert.equal(search(items, { imprint: '10' }).imprintQueryState, QueryState.VALID);
  assert.equal(search(items, { imprint: '' }).imprintQueryState, QueryState.OFF);
});

// ── A9 ──────────────────────────────────────────────────────────────
test('A9 名稱搜尋：三欄各自命中、大小寫不敏感、非前綴位置、負例', () => {
  const target = '內衛成製字第000075號';
  // 中文（非前綴：index 4）
  assert.deepEqual(ids(search(items, { name: '蘇打' }).tiers[0]), [target]);
  assert.equal(rowOf(target)['中文品名'].indexOf('蘇打'), 4);
  // 英文小寫，且不是單筆特判——全量 34 筆
  const lower = search(items, { name: 'sodium' });
  const upper = search(items, { name: 'SODIUM' });
  assert.deepEqual(ids(lower.tiers[0]), ids(upper.tiers[0]));
  assert.equal(lower.mainCount, 34);
  // 英文非前綴位置（BICARBONATE 在 index 7）
  assert.equal(search(items, { name: 'BICARBONATE' }).mainCount, 7);
  // 許可證字號子字串（非前綴：index 6）
  assert.deepEqual(ids(search(items, { name: '000075' }).tiers[0]), [target]);
  // 負例，且名稱不命中一律 mismatch，不得進未提供區
  const neg = search(items, { name: 'ZZZZZZ' });
  assert.equal(neg.mainCount, 0);
  assert.equal(neg.unknown.length, 0);
  assert.equal(neg.partial.length, 0);
});

test('A9b 名稱與外觀條件是 AND（正反 witness）', () => {
  const hit = search(items, { name: '蘇打', color: ['白'] });
  assert.equal(hit.mainCount, 1, 'A9b: 正 witness 應命中');
  const miss = search(items, { name: '蘇打', color: ['黑'] });
  assert.equal(miss.mainCount, 0, 'A9b: 反 witness 命中了——外觀條件被忽略');
  assert.equal(miss.unknown.length, 0);
});

// ── A10 ─────────────────────────────────────────────────────────────
test('A10 不存在的 imprint：確定三區皆 0、未提供區 2085、不得說找不到', () => {
  const criteria = Object.freeze({
    color: Object.freeze([]), shape: Object.freeze([]), score: null, imprint: 'ZZZZ9', name: '',
  });
  const before = JSON.stringify(criteria);
  const res = search(items, criteria);

  assert.deepEqual(res.tiers.map((t) => t.length), [0, 0, 0]);
  assert.equal(res.partial.length, 0);
  assert.equal(res.unknown.length, 2085);
  assertCase(res, 'imprint:ZZZZ9', 'A10');
  for (const it of res.unknown) {
    assert.deepEqual(naiveRowTokens(rowOf(it.id)), [], `A10: ${it.id} 有 token 卻進未提供區`);
  }

  // UI 狀態必須由 main===0 && 不確定區>0 推出，而不是「0 筆就說找不到」
  assert.deepEqual(resultStates(res, criteria), [ResultState.ONLY_UNCERTAIN]);
  assert.equal(JSON.stringify(criteria), before, 'A10: 搜尋條件被 mutate');
});

test('A10b EMPTY 只有在每一筆都至少有一個 mismatch 時才成立', () => {
  // 外觀條件永遠可能是 unknown，所以光靠外觀條件湊不出 EMPTY。
  // 名稱條件是唯一恆可判定的（en 與 id 恆非空 → 不命中即 mismatch），
  // 因此真正的「找不到符合的藥品」只可能由名稱條件產生。
  const criteria = { name: 'ZZZZZZ' };
  const res = search(items, criteria);
  assert.equal(res.mainCount, 0);
  assert.equal(res.partial.length, 0);
  assert.equal(res.unknown.length, 0);
  assert.equal(res.excludedCount, TOTAL);
  assert.deepEqual(resultStates(res, criteria), [ResultState.EMPTY]);
});

test('A10c 外觀條件全數 unknown 的記錄必須進未提供區，不得被當成 EMPTY', () => {
  // 若實作把「條件全 unknown」誤判為 0 筆，使用者會看到「找不到符合的藥品」——
  // 而那批正是 TFDA 什麼都沒填、最無從排除的一群，是漏檢風險最高的族群。
  const criteria = { color: ['黑'], shape: ['液劑(包含糖漿用粉劑)'], score: '十字', imprint: 'ZZZZ9' };
  const snapshot = JSON.stringify(criteria);
  const res = search(items, criteria);
  assert.equal(res.mainCount, 0);
  assert.equal(res.unknown.length, 190);
  assert.deepEqual(resultStates(res, criteria), [ResultState.ONLY_UNCERTAIN]);
  for (const it of res.unknown) {
    const r = rowOf(it.id);
    const cells = [
      [naiveSplit(r['顏色']), '黑'],
      [naiveSplit(r['形狀']), '液劑(包含糖漿用粉劑)'],
      [naiveSplit(r['刻痕']), '十字'],
      [naiveRowTokens(r), null],   // imprint：ZZZZ9 恆不命中，有 token 即 mismatch
    ];
    let unknownCount = 0;
    for (const [values, want] of cells) {
      if (values.length === 0) { unknownCount++; continue; }
      assert.ok(want !== null && values.includes(want), `A10c: ${it.id} 有明確 mismatch 卻進未提供區`);
    }
    assert.ok(unknownCount > 0, `A10c: ${it.id} 全部條件皆 match 卻不在主區`);
  }
  assert.deepEqual(relaxSuggestions(criteria), ['score', 'shape', 'color']);
  assert.equal(JSON.stringify(criteria), snapshot, 'A10c: relaxSuggestions 修改了條件');
});

// ── A11 ─────────────────────────────────────────────────────────────
test('A11 複選：白+黃 → 主區 3868、未提供區 217（組內 OR）', () => {
  const res = search(items, { color: ['白', '黃'] });
  assert.equal(res.mainCount, 3868);
  assert.equal(res.unknown.length, 217);
  assertCase(res, 'color:白+黃', 'A11');
});

test('A11b 組內 OR、組間 AND 的五個 witness', () => {
  const inMain = (res, id) => res.tiers.flat().some((i) => i.id === id);
  const or = search(items, { color: ['白', '黃'] });
  assert.ok(inMain(or, '內衛成製字第000075號'), 'A11b: 只含白者應命中');
  assert.ok(inMain(or, '內衛成製字第000726號'), 'A11b: 只含黃者應命中');
  assert.ok(!inMain(or, '內衛成製字第000386號'), 'A11b: 白黃皆無者不應命中');

  const and = search(items, { color: ['白', '黃'], shape: ['圓形'] });
  assert.ok(!inMain(and, '內衛藥製字第000162號'), 'A11b: 顏色中但形狀 mismatch 者不應命中（AND 被忽略）');
  assert.ok(inMain(search(items, { color: ['白'], shape: ['膠囊'] }), '內衛藥製字第000258號'),
    'A11b: 多值顏色其一命中且形狀命中者應命中');
});

// ── A12：髒值 golden decisions（人工裁決，見 tests/adjudications.json）──
test('A12 五類髒值的 golden decisions 與規則實際輸出一致', () => {
  const adj = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/adjudications.json'), 'utf8'));
  const classes = new Set(adj.decisions.map((d) => d.class));
  for (const c of ['chinese-mixed', 'head-tail', 'both-fields-same', 'mark2-only', 'single-char-noise']) {
    assert.ok(classes.has(c), `A12: 缺少 ${c} 類的 golden decision`);
  }
  for (const d of adj.decisions) {
    assert.ok(d.rationale && d.rationale.length > 10, `A12: ${d.id} 的裁決理由過短`);
    assert.equal(d.data_version, EXP.meta.baseline_sha256.slice(0, 8), `A12: ${d.id} 的資料版本不符`);
    if (d.expected_tokens) {
      assert.deepEqual(naiveRowTokens(rowOf(d.id)), d.expected_tokens, `A12: ${d.id} 的 token 與裁決紀錄不符`);
    }
    if (d.query !== undefined) {
      const hit = search(items, { imprint: d.query }).tiers.flat().some((i) => i.id === d.id);
      assert.equal(hit, d.expected_hit, `A12: 查詢 ${d.query} 對 ${d.id} 的命中與裁決紀錄不符`);
    }
  }
  // 雙向反例是「必須被回答的問題」，不是「必須被填滿的配額」
  for (const k of ['false_positive', 'false_negative']) {
    const a = adj.bidirectional[k];
    assert.ok(a && typeof a.found === 'boolean', `A12: ${k} 未回答`);
    assert.ok(a.search_scope && a.search_scope.length > 10, `A12: ${k} 未記錄查找範圍`);
    assert.ok(a.method && a.method.length > 10, `A12: ${k} 未記錄查找方法`);
    if (a.found) assert.ok(Array.isArray(a.cases) && a.cases.length > 0, `A12: ${k} 宣稱有發現卻沒有案例`);
  }
});

// ── A13–A18 刻字變體（D30–D37）──────────────────────────────────────

/** A13 的 12 組具名 criteria。**全部列名**，不用「≥12」留自由替換的空間。 */
const A13_CASES = [
  ['imprint:T', { imprint: 'T' }],
  ['imprint:S', { imprint: 'S' }],
  ['imprint:10', { imprint: '10' }],
  ['imprint:M 40', { imprint: 'M 40' }],
  ['white-round-noscore+S', { color: ['白'], shape: ['圓形'], score: '無', imprint: 'S' }],
  ['white-round-noscore', { color: ['白'], shape: ['圓形'], score: '無' }],
  ['imprint:SH', { imprint: 'SH' }],
  ['imprint:HS', { imprint: 'HS' }],
  ['imprint:01', { imprint: '01' }],
  ['imprint:12', { imprint: '12' }],
  ['imprint:S15', { imprint: 'S15' }],
  ['imprint:B2', { imprint: 'B2' }],
];

test('A13 既有五區逐筆不變 ＋ 變體身份與理由 ＋ 分區窮盡（12 組具名）', () => {
  assert.equal(A13_CASES.length, 12, 'A13: 案例數變了');
  for (const [name, criteria] of A13_CASES) {
    const e = EXP.cases[name];
    assert.ok(e, `A13: oracle 缺少案例 ${name}`);
    const res = search(items, criteria);

    // (1) 既有五區的 ordered ID 序列與凍結 baseline 逐筆相同
    assert.deepEqual(ids(res.tiers[0]), sorted(e.tiers[0]), `A13 ${name}: 完全符合區`);
    assert.deepEqual(ids(res.tiers[1]), sorted(e.tiers[1]), `A13 ${name}: 字首符合區`);
    assert.deepEqual(ids(res.tiers[2]), sorted(e.tiers[2]), `A13 ${name}: 包含區`);
    assert.deepEqual(ids(res.partial), sorted(e.partial), `A13 ${name}: 部分符合區`);
    assert.deepEqual(ids(res.unknown), sorted(e.unknown), `A13 ${name}: 未提供區`);

    // (2) 變體區的 ordered ID 序列
    assert.deepEqual(variantIds(res), sorted(e.variant.map((v) => v.id)), `A13 ${name}: 變體區成員`);

    // (3) 每個變體 ID 的理由集合。
    // 只驗 (1)(2) 不驗 (3) 的話，「理由全部標成倒讀」會通過——
    // 而使用者在藥車前會照著錯的理由去翻藥錠。
    const want = new Map(e.variant.map((v) => [v.id, [...v.reasons].sort().join('+')]));
    for (const v of res.variant) {
      assert.equal([...v.reasons].sort().join('+'), want.get(v.item.id),
        `A13 ${name}: ${v.item.id} 的理由集合不符`);
    }

    // (4) 六區 ∪ 排除 === 全量。變體只從 excluded 救回，故排除數只會變少。
    assertPartition(res, `A13 ${name}`);
  }
});

test('A13b 零 token 查詢不套用 imprint，變體區必為 0', () => {
  // `無` 產生 0 個 token → NO_TOKEN（D3）。此時整個 imprint 條件不啟用，
  // 因此也不可能計算變體（§5.1 第二列）。
  const res = search(items, { imprint: '無' });
  assert.equal(res.imprintQueryState, QueryState.NO_TOKEN);
  assert.equal(res.variant.length, 0, 'A13b: NO_TOKEN 時不得產生任何變體');
  assert.equal(res.mainCount, TOTAL, 'A13b: 條件未套用時全部落在主區');
});

/** A14 的合成 fixture。顏色形狀刻痕固定，只讓 imprint 狀態變化。 */
const mkRow = (id, m1, m2, color = '白') => ({
  '許可證字號': id, '中文品名': id, '英文品名': id,
  '標註一': m1, '標註二': m2, '顏色': color, '形狀': '圓形', '刻痕': '無',
});

test('A14 variant 只由 imprint MISMATCH 產生 —— 八狀態具名矩陣（分甲乙兩類）', () => {
  // 甲類：predicate 在資料上可成立的狀態。fixture 必須構造成**變體 predicate 亦為 true**，
  // 否則移除 MISMATCH guard 時測試不會紅（變異 F13-1）。
  const 甲 = [
    ['MATCH-EXACT', mkRow('X-exact', 'SH', 'HS'), 'SH', 0],
    ['MATCH-PREFIX', mkRow('X-prefix', 'SHX', 'HS'), 'SH', 1],
    ['MATCH-CONTAINS', mkRow('X-contains', 'QSHQ', 'HS'), 'SH', 2],
    // PARTIAL 的 fixture 要同時滿足兩件事，構造比其他三格難：
    //   查詢 `SH MM` 之下 `SH` 原樣命中、`MM` 完全不命中 → PARTIAL；
    //   而 flip('SH')='HS'、flip('MM')='WW' **都**在記錄 token 裡 → 變體 predicate 為 true。
    // 少了後者，移除 MISMATCH guard 時這一格不會變紅（變異 F13-1 會存活）。
    ['PARTIAL', mkRow('X-partial', 'SH;;;HS', 'WW'), 'SH MM', null],
  ];
  for (const [label, row, imprint, tier] of 甲) {
    // 前提：這個 fixture 的變體 predicate 確實為 true，否則本條抓不到 F13-1
    assert.ok(naiveVariant(row, imprint),
      `A14 ${label}: fixture 的變體 predicate 不為 true —— 這條抓不到 guard mutation`);
    const res = search(indexItems([toItem(row)]), { imprint });
    assert.equal(res.variant.length, 0, `A14 ${label}: 不得出現在變體區`);
    if (tier === null) assert.equal(res.partial.length, 1, `A14 ${label}: 應在部分符合區`);
    else assert.equal(res.tiers[tier].length, 1, `A14 ${label}: 應在第 ${tier} 級主區`);
  }

  // 乙類：OFF／NO_TOKEN／UNKNOWN 在邏輯上不可能讓 predicate 成立
  //（前兩者沒有查詢 token 可評估，UNKNOWN 定義為記錄無 token）。
  // **只驗結果，不宣稱**移除 guard 會讓它們變紅。
  const 乙 = [
    ['OFF', mkRow('X-off', 'SH', 'HS'), '', 'main'],
    ['NO_TOKEN', mkRow('X-notoken', 'SH', 'HS'), '無', 'main'],
    ['UNKNOWN', mkRow('X-unknown', '無', '無'), 'SH', 'unknown'],
  ];
  for (const [label, row, imprint, where] of 乙) {
    const res = search(indexItems([toItem(row)]), { imprint });
    assert.equal(res.variant.length, 0, `A14 ${label}: 不得出現在變體區`);
    if (where === 'unknown') assert.equal(res.unknown.length, 1, `A14 ${label}: 應在未提供區`);
    else assert.equal(res.mainCount, 1, `A14 ${label}: 應在主區`);
  }
});

test('A14b 交叉格：其他條件的 mismatch 壓過 variant，unknown 不壓過', () => {
  // imprint 變體全中，但顏色 mismatch → **必須排除**（變體不得繞過條件間的 AND）
  const r1 = search(indexItems([toItem(mkRow('X-cm', 'HS', '', '黃'))]),
    { imprint: 'SH', color: ['白'] });
  assert.equal(r1.variant.length, 0, 'A14b: 顏色 mismatch 時變體不得放行');
  assert.equal(r1.excludedCount, 1, 'A14b: 應被排除');

  // imprint 變體全中，顏色 unknown → 依 §5.3 進 variant，**不得**進 unknown（變異 F13-2）
  const r2 = search(indexItems([toItem(mkRow('X-cu', 'HS', '', ''))]),
    { imprint: 'SH', color: ['白'] });
  assert.equal(r2.unknown.length, 0, 'A14b: variant 必須優先於 unknown');
  assert.deepEqual(r2.variant.map((v) => [...v.reasons]), [['flip']],
    'A14b: 應在變體區且理由為倒讀');
});

test('A15 反例組：七類必須不放行或分區正確的案例', () => {
  const V = (q) => search(items, { imprint: q });
  const reasonsOf = (res) => res.variant.map((v) => v.reasons.join('+'));

  // (a) 變體區(42) 大於主區(37)：兩者不得混區
  const sh = V('SH');
  assert.equal(sh.mainCount, 37, 'A15a: 主區筆數');
  assert.equal(sh.variant.length, 42, 'A15a: 變體區筆數');
  assert.ok(reasonsOf(sh).every((r) => r === 'flip'), 'A15a: 42 筆理由皆須為倒讀');
  const mainIds = new Set(sh.tiers.flat().map((i) => i.id));
  for (const v of sh.variant) {
    assert.ok(!mainIds.has(v.item.id), `A15a: ${v.item.id} 同時出現在主區與變體區`);
  }

  // (b) 凍結**非零**集合——寫成「落在 variant 者須…」時空集合會真空通過（變異 F13-4）
  const ten = V('10');
  assert.equal(ten.variant.length, 22, 'A15b: 查詢 10 的變體區筆數');
  assert.equal(reasonsOf(ten).filter((r) => r === 'canon').length, 15, 'A15b: 其中字形 15 筆');
  assert.equal(reasonsOf(ten).filter((r) => r === 'flip').length, 7, 'A15b: 其中倒讀 7 筆');

  // (c) fixed point 不算變體。**斷言理由不含 flip，而不是「整區為空」**——
  // OSO 倒讀後等於自己，但字形仍可命中 1 筆。
  for (const q of ['MW', '69']) {
    assert.equal(V(q).variant.length, 0, `A15c: ${q} 不得產生變體`);
  }
  const oso = V('OSO');
  assert.equal(oso.variant.length, 1, 'A15c: OSO 的字形命中仍在');
  assert.ok(oso.variant.every((v) => !v.reasons.includes('flip')), 'A15c: OSO 的理由不得含倒讀');

  // 全量抽驗：flip(t)===t 的真實 token 當查詢時都不得有倒讀理由
  const fixed = [];
  for (const row of rows) {
    for (const t of naiveRowTokens(row)) if (naiveFlip(t) === t && !fixed.includes(t)) fixed.push(t);
  }
  assert.ok(fixed.length > 10, `A15c: 只找到 ${fixed.length} 個 fixed point —— 母體已失效`);
  for (const t of fixed.slice(0, 40)) {
    assert.ok(V(t).variant.every((v) => !v.reasons.includes('flip')),
      `A15c: fixed point ${t} 產生了倒讀理由`);
  }

  // (d) 表外字元：斷言理由不含 flip（而非整區為空）
  for (const q of ['TA', 'T']) {
    assert.ok(V(q).variant.every((v) => !v.reasons.includes('flip')), `A15d: ${q} 不得有倒讀理由`);
  }

  // (e) 五個等價類的**雙向** witness，長度皆 ≥2。單字元證明不了雙向性。
  const PAIRS = [
    ['0/O', 'O0', 2, '0O', 2],
    ['1/I/L', '15', 6, 'L5', 27],
    ['5/S', 'AS', 2, 'A5', 18],
    ['2/Z', 'Z2', 7, '2Z', 7],
    ['8/B', '8B', 1, 'B8', 1],
  ];
  for (const [cls, qa, na, qb, nb] of PAIRS) {
    const ra = V(qa);
    const rb = V(qb);
    assert.ok(na > 0 && nb > 0, `A15e ${cls}: 雙向都必須非零，否則是真空通過`);
    assert.equal(ra.variant.length, na, `A15e ${cls}: ${qa} 的變體筆數`);
    assert.equal(rb.variant.length, nb, `A15e ${cls}: ${qb} 的變體筆數`);
    assert.ok(ra.variant.every((v) => v.reasons.includes('canon')), `A15e ${cls}: ${qa} 理由應含字形`);
    assert.ok(rb.variant.every((v) => v.reasons.includes('canon')), `A15e ${cls}: ${qb} 理由應含字形`);
    // 原樣已命中的記錄不重複進變體區（D31 的推論，不是另一條規則）
    const inMain = new Set(ra.tiers.flat().map((i) => i.id));
    for (const v of ra.variant) assert.ok(!inMain.has(v.item.id), `A15e ${cls}: ${v.item.id} 重複`);
  }

  // (e2) 單字元只驗停用規則
  for (const q of ['0', '5', 'S']) {
    assert.equal(V(q).variant.length, 0, `A15e2: 單字元 ${q} 不得啟用字形變體`);
  }

  // (f) 雙理由，用真實資料。兩條 predicate 必須**各自獨立**全中，不是組合後才全中。
  const one = V('01');
  const dual = one.variant.filter((v) => v.reasons.length === 2);
  assert.equal(dual.length, 1, 'A15f: 查詢 01 應恰有 1 筆雙理由');
  assert.equal(dual[0].item.id, '衛署藥輸字第025901號', 'A15f: 雙理由記錄的身份');
  assert.deepEqual([...dual[0].reasons].sort(), ['canon', 'flip'], 'A15f: 理由集合');
  assert.deepEqual(naiveVariant(rowOf(dual[0].item.id), '01').sort(), ['canon', 'flip'],
    'A15f: 獨立 oracle 也必須判定兩條各自獨立全中');
  assert.equal(one.variant.filter((v) => v.item.id === dual[0].item.id).length, 1,
    'A15f: 同一 ID 在變體區只能出現一次');

  // (g) flip 表外否決 ＋ 單字元停用 canon 的合成。
  // **不宣稱它守著 N15**——實跑證實逐 token OR 變異下 M 40 仍為 0，那是 B22-2 的事。
  assert.equal(V('M 40').variant.length, 0, 'A15g: M 40 的變體區必為空');
});

test('A16 ONLY_UNCERTAIN 雙向 —— 必須由真實 search() 產生，不得手工組 result', () => {
  // 正向：主區 0、部分符合 0，只有變體區有值
  const c1 = { imprint: 'S15' };
  const r1 = search(items, c1);
  assert.equal(r1.mainCount, 0, 'A16: S15 主區應為 0');
  assert.equal(r1.partial.length, 0, 'A16: S15 部分符合區應為 0');
  assert.equal(r1.variant.length, 1, 'A16: S15 變體區應為 1');
  assert.ok(resultStates(r1, c1).includes(ResultState.ONLY_UNCERTAIN),
    'A16: 有變體時不得回 EMPTY —— 畫面上列著候選卻說「找不到」是最糟的漏檢形式');

  // 反向：真正的全空。外觀條件湊不出 EMPTY（未提供區恆有值），必須由名稱條件產生。
  const c2 = { name: '絕不存在的藥名ZZZQQQ' };
  const r2 = search(items, c2);
  assert.equal(r2.mainCount + r2.partial.length + r2.unknown.length + r2.variant.length, 0,
    'A16: 反例必須真的全空，否則第二條是真空通過');
  assert.ok(resultStates(r2, c2).includes(ResultState.EMPTY),
    'A16: 真正全空時必須回 EMPTY —— 只測正向的話「永遠不回 EMPTY」也會通過');
});

test('A16b ONLY_UNCERTAIN 必須真的依賴 variant —— 未提供區為 0 的隔離情境', () => {
  // **這條是變異測試 F13-6 逼出來的。**
  // A16 用查詢 S15，但那個查詢的未提供區有 2,085 筆（全資料集中兩欄皆無 token 的記錄），
  // 所以 `uncertain = partial + unknown` 本來就 > 0 ——
  // 把 variant 從 uncertain 拿掉，A16 依然全綠。它從頭到尾沒真的依賴 variant。
  //
  // 要隔離出「只有 variant 有值」，必須用全部記錄都有 token 的合成資料集。
  const set = indexItems([
    toItem(mkRow('Y-a', 'HS', '')),        // flip('SH') = 'HS' → 變體命中
    toItem(mkRow('Y-b', 'QQQQ', '')),      // 完全不相干 → 排除
  ]);
  const c = { imprint: 'SH' };
  const r = search(set, c);
  assert.equal(r.mainCount, 0, 'A16b: 主區應為 0');
  assert.equal(r.partial.length, 0, 'A16b: 部分符合區應為 0');
  assert.equal(r.unknown.length, 0, 'A16b: **未提供區必須為 0**，否則本條又會被它撐住');
  assert.equal(r.variant.length, 1, 'A16b: 只有變體區有值');
  assert.ok(resultStates(r, c).includes(ResultState.ONLY_UNCERTAIN),
    'A16b: uncertain 沒有納入 variant —— 畫面會顯示「找不到」，而下面列著一張卡');
  assert.ok(!resultStates(r, c).includes(ResultState.EMPTY), 'A16b: 不得同時回 EMPTY');
});

test('A17 可達查詢閉包的規則指紋 —— 查詢域不是「真實 token」', () => {
  // v0.2 曾以 2,357 個真實 token 為母體，那是取樣偏誤：
  // `Y5P` 是合法輸入、可達 111 筆，卻不是任何記錄的 token。
  const real = new Set();
  for (const row of rows) for (const t of naiveRowTokens(row)) real.add(t);
  const closure = new Set(real);
  for (const t of real) {
    const f = naiveFlip(t);
    if (f !== null) closure.add(f);
    closure.add(naiveCanon(t));
  }
  assert.ok(!real.has('Y5P'), 'A17 前提: Y5P 不是真實 token');
  assert.ok(closure.has('Y5P'), 'A17: 閉包必須涵蓋 Y5P 這類可達但非真實的查詢');
  assert.equal(closure.size, EXP.closureFingerprint.closure_size, 'A17: 閉包大小與 oracle 不符');

  let worst = 0;
  let worstFlip = 0;
  let worstCanon = 0;
  for (const q of closure) {
    const res = search(items, { imprint: q });
    worst = Math.max(worst, res.variant.length);
    let nf = 0;
    let nc = 0;
    for (const v of res.variant) {
      if (v.reasons.includes('flip')) nf++;
      if (v.reasons.includes('canon')) nc++;
    }
    worstFlip = Math.max(worstFlip, nf);
    worstCanon = Math.max(worstCanon, nc);
  }
  // **等值比對，不是上界。** 這是規則指紋：放行字首級或單字元啟用字形都會讓它跳動。
  assert.deepEqual({ worst, worstFlip, worstCanon },
    { worst: 111, worstFlip: 84, worstCanon: 111 },
    'A17: 規則指紋變動 —— 這代表 admission 規則被改了');
  assert.deepEqual({ worst, worstFlip, worstCanon }, {
    worst: EXP.closureFingerprint.worst,
    worstFlip: EXP.closureFingerprint.worst_flip,
    worstCanon: EXP.closureFingerprint.worst_canon,
  }, 'A17: 與 oracle 獨立算出的指紋不符');
});

test('A18 變體理由是 query-scoped，連續搜尋不得互相污染（D37）', () => {
  const r1 = search(items, { imprint: '01' });
  const snap = r1.variant.map((v) => `${v.item.id}:${v.reasons.join('+')}`);
  const r2 = search(items, { imprint: 'SH' });
  const after = r1.variant.map((v) => `${v.item.id}:${v.reasons.join('+')}`);
  assert.ok(r2.variant.length > 0, 'A18: 對照組——第二次搜尋確實有變體，否則本條是真空的');
  assert.deepEqual(after, snap, 'A18: 第二次搜尋改動了第一份結果的理由');
  // indexed item 上不得殘留任何理由狀態
  for (const it of items) {
    for (const k of ['reasons', '_reasons', '_variantReasons', 'variantReasons']) {
      assert.ok(!(k in it), `A18: indexed item ${it.id} 被寫入了 ${k}`);
    }
  }
});
