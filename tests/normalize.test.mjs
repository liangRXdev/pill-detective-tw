/**
 * B 組驗收 — 正規化純函式（規格 `.ai-review/plan.md` §10 B1–B7）
 *
 * 每一條都斷言 **exact token array**，不是 `includes` 也不是「結果碰巧相同」。
 * 寬鬆斷言在這裡特別危險：token 化錯誤會同時污染建置與查詢兩側，
 * 而兩側同樣錯的話，搜尋結果看起來還是「對的」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizeImprintField, tokenizeQuery, recordTokens, splitMulti,
  isOfficialImgUrl, officialLeafletUrl, IMG_ORIGIN,
  normalizeName, imprintQueryState, QueryState, toItem,
  hasActiveCriteria, SCORE_ANY,
  taipeiDate, daysSinceISODate, STALE_DAYS, freshnessView,
  flip, canon, flipPredicate, canonPredicate, variantReasons,
} from '../search.js';

const B_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** 凍結 baseline 的全部真實 token（B20-3／B21-3 的母體）。 */
const REAL_TOKENS = (() => {
  const rows = JSON.parse(fs.readFileSync(path.join(B_ROOT, 'tests/baseline-2026-08-12.json'), 'utf8'));
  const s = new Set();
  for (const r of rows) for (const t of recordTokens(toItem(r))) s.add(t);
  return [...s];
})();

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

test('B13 官方圖檔 origin 白名單：解析失敗與他站一律 false', () => {
  // 這條守的不是搜尋語意，是「發布頁面上會出現哪些可點的外部 origin」。
  // v0.1 把 imgs[].src 做成詳細頁的「查看 TFDA 官方原圖」連結之後才需要。
  assert.equal(IMG_ORIGIN, 'https://mcp.fda.gov.tw');
  assert.equal(isOfficialImgUrl('https://mcp.fda.gov.tw/insert/shapeImg/abc?c=o'), true);

  // 弱化版本一：用 includes/startsWith 比字串。以下每一條都能騙過那種寫法。
  assert.equal(isOfficialImgUrl('https://mcp.fda.gov.tw.evil.example/x'), false, 'B13: 子網域後綴');
  assert.equal(isOfficialImgUrl('https://evil.example/?u=https://mcp.fda.gov.tw'), false, 'B13: 出現在查詢字串');
  assert.equal(isOfficialImgUrl('http://mcp.fda.gov.tw/x'), false, 'B13: 明文 http 不是同一個 origin');
  assert.equal(isOfficialImgUrl('https://mcp.fda.gov.tw:8443/x'), false, 'B13: 不同 port');

  // 弱化版本二：解析失敗時回傳原字串／true
  for (const bad of ['', null, undefined, 'javascript:alert(1)', 'data:text/html,x', '//mcp.fda.gov.tw/x', 42]) {
    assert.equal(isOfficialImgUrl(bad), false, `B13: ${JSON.stringify(bad)} 應為 false`);
  }
});

test('B14 TFDA 仿單 URL：許可證字號須安全編碼為單一路徑片段', () => {
  const id = '衛署藥輸字第021571號';
  const href = officialLeafletUrl(id);
  const parsed = new URL(href);
  assert.equal(parsed.origin, IMG_ORIGIN);
  assert.equal(parsed.pathname.split('/').slice(0, -1).join('/'), '/im_detail_1');
  assert.equal(decodeURIComponent(parsed.pathname.split('/').at(-1)), id);

  assert.equal(officialLeafletUrl(''), null);
  assert.equal(officialLeafletUrl('   '), null);
  assert.equal(officialLeafletUrl(null), null);
  assert.equal(officialLeafletUrl('\ud800'), null, '無效 Unicode 必須 fail-closed');
  assert.match(officialLeafletUrl('../evil'), /\/im_detail_1\/\.\.%2Fevil$/,
    '斜線必須留在編碼後的單一路徑片段內');
  assert.match(officialLeafletUrl('A?x=#y'), /\/im_detail_1\/A%3Fx%3D%23y$/,
    'query／fragment 字元不得改變 URL 結構');
});

test('B15 零條件是資料庫入口狀態，不是全資料集完全符合', () => {
  assert.equal(hasActiveCriteria({
    color: [], shape: [], score: SCORE_ANY, imprint: '', name: '',
  }), false);
  assert.equal(hasActiveCriteria({ imprint: '   ', name: '\t', score: SCORE_ANY }), false);

  for (const criteria of [
    { color: ['白'] },
    { shape: ['圓形'] },
    { score: '直線' },
    { imprint: '10' },
    { name: '蘇打' },
  ]) assert.equal(hasActiveCriteria(criteria), true, JSON.stringify(criteria));
});

// ── D28 資料新鮮度的日期運算 ───────────────────────────────────────
//
// 期望值全部是手寫的字面常數，**不由受測函式產生**。
// 拿 taipeiDate() 的輸出去斷言 taipeiDate() 只會證明它自洽。

test('B16 taipeiDate 是台北日曆日，不是 UTC 日', () => {
  // 排程時刻：UTC 週日 20:17 ＝ 台北週一 04:17。用 UTC 會少一天。
  assert.equal(taipeiDate(new Date('2026-08-09T20:17:00Z')), '2026-08-10');
  // 台北午夜前一分鐘與後一分鐘落在不同日
  assert.equal(taipeiDate(new Date('2026-08-12T15:59:00Z')), '2026-08-12');
  assert.equal(taipeiDate(new Date('2026-08-12T16:00:00Z')), '2026-08-13');
  // 跨月與跨年邊界
  assert.equal(taipeiDate(new Date('2026-08-31T16:00:00Z')), '2026-09-01');
  assert.equal(taipeiDate(new Date('2026-12-31T16:00:00Z')), '2027-01-01');
});

test('B17 daysSinceISODate 壞輸入一律回 null —— 絕不可回 0', () => {
  // 0 會被頁尾判讀成「今天剛檢查過」，把壞掉的狀態檔偽裝成最新鮮的狀態。
  const now = new Date('2026-08-13T02:00:00Z');   // 台北 2026-08-13 10:00
  for (const bad of [
    null, undefined, 0, 20260813, '', '  ',
    '2026-8-13',            // 未補零
    '2026/08/13',           // 分隔符不符
    '2026-08-13T00:00:00Z', // 帶時間
    '2026-13-01',           // 月份不存在
    '2026-02-31',           // 曆法上不存在的日
    'yyyy-mm-dd',
  ]) {
    assert.equal(daysSinceISODate(bad, now), null, `B17: ${JSON.stringify(bad)} 未回 null`);
  }
  // 非空對照組：合法輸入必須真的算得出來，否則「一律回 null」也會通過上面整段
  assert.equal(daysSinceISODate('2026-08-13', now), 0);
});

test('B18 daysSinceISODate 的天數與過期門檻', () => {
  const now = new Date('2026-08-13T02:00:00Z');   // 台北 2026-08-13
  assert.equal(daysSinceISODate('2026-08-12', now), 1);
  assert.equal(daysSinceISODate('2026-07-30', now), 14);
  assert.equal(daysSinceISODate('2026-07-29', now), 15);
  // 未來日期回負數而非 null：那是「狀態檔有問題」，交給呼叫端處理，不假裝正常
  assert.equal(daysSinceISODate('2026-08-20', now), -7);

  // 門檻的語意：14 天（＝錯過兩次週更）仍算新鮮，第 15 天才過期
  assert.equal(STALE_DAYS, 14);
  assert.equal(daysSinceISODate('2026-07-30', now) > STALE_DAYS, false);
  assert.equal(daysSinceISODate('2026-07-29', now) > STALE_DAYS, true);
});

test('B19 freshnessView：版本與筆數取自 meta，狀態檔只能決定「最後檢查」', () => {
  const now = new Date('2026-08-13T02:00:00Z');           // 台北 2026-08-13
  const meta = { schema: 1, source_version: '2026-08-10', count: 6295 };
  const ok = { schema: 1, source_version: '2026-08-10', last_checked: '2026-08-12', count: 6295 };

  // 正常：三項齊全、不過期
  assert.deepEqual(freshnessView(meta, ok, now), {
    sourceVersion: '2026-08-10', count: 6295, lastChecked: '2026-08-12', days: 1, stale: false,
  });

  // 狀態檔缺席／壞掉 → 仍顯示版本與筆數，但不顯示最後檢查
  for (const bad of [null, undefined, 'nope', 42, {}, { schema: 2, source_version: '2026-08-10', last_checked: '2026-08-12' }]) {
    const v = freshnessView(meta, bad, now);
    assert.equal(v.lastChecked, null, `B19: ${JSON.stringify(bad)} 不該產生 lastChecked`);
    assert.equal(v.stale, false);
    assert.equal(v.sourceVersion, '2026-08-10', 'B19: 降級時仍應顯示 meta 的版本');
    assert.equal(v.count, 6295);
  }
});

test('B19b freshnessView：跨版本組合不得把舊狀態檔的檢查日貼到新資料上', () => {
  const now = new Date('2026-08-13T02:00:00Z');
  const meta = { schema: 1, source_version: '2026-08-10', count: 6295 };

  // SW 只有一邊退快取時會發生：appearance 是新的、status 是上一版的
  const stale = { schema: 1, source_version: '2026-07-01', last_checked: '2026-08-12', count: 6100 };
  const v = freshnessView(meta, stale, now);
  assert.equal(v.lastChecked, null, 'B19b: source_version 不符仍顯示了最後檢查');
  assert.equal(v.sourceVersion, '2026-08-10', 'B19b: 版本被舊狀態檔覆蓋');
  assert.equal(v.count, 6295, 'B19b: 筆數被舊狀態檔覆蓋');

  // 對照組：同一份資料就要顯示，否則上面那條靠「永遠不顯示」也會通過
  assert.equal(
    freshnessView(meta, { ...stale, source_version: '2026-08-10' }, now).lastChecked,
    '2026-08-12');

  // 兩邊都沒有 source_version 視為一致（來源未提供 mtime 的情境）
  assert.equal(
    freshnessView({ schema: 1, count: 10 }, { schema: 1, last_checked: '2026-08-12', count: 10 }, now)
      .lastChecked,
    '2026-08-12');
});

test('B19c freshnessView：未來日期不得顯示成「剛檢查過」', () => {
  const now = new Date('2026-08-13T02:00:00Z');
  const meta = { schema: 1, source_version: '2026-08-10', count: 6295 };
  const at = (d) => freshnessView(meta, { schema: 1, source_version: '2026-08-10', last_checked: d }, now);

  // days > STALE_DAYS 對負數為 false —— 不擋的話壞掉的狀態檔會偽裝成最新鮮
  for (const future of ['2026-08-14', '2026-09-01', '2027-01-01']) {
    const v = at(future);
    assert.equal(v.lastChecked, null, `B19c: 未來日期 ${future} 仍被顯示`);
    assert.equal(v.stale, false);
    assert.equal(v.days, null);
  }

  // 門檻邊界：14 天仍新鮮、15 天過期、今天為 0 天
  assert.deepEqual([at('2026-08-13').days, at('2026-08-13').stale], [0, false]);
  assert.deepEqual([at('2026-07-30').days, at('2026-07-30').stale], [14, false]);
  assert.deepEqual([at('2026-07-29').days, at('2026-07-29').stale], [15, true]);
});

// ── B20–B22 刻字變體（D32／D33／D34）────────────────────────────────

const ALNUM = [...'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
/** D32 的 14 字元表，逐字列出。**這份表是斷言，不是從 search.js 讀來的。** */
const FLIP_MAP = {
  0: '0', 1: '1', 8: '8', 6: '9', 9: '6',
  H: 'H', I: 'I', N: 'N', O: 'O', S: 'S', X: 'X', Z: 'Z',
  M: 'W', W: 'M',
};
const OUT_OF_TABLE = ALNUM.filter((c) => !(c in FLIP_MAP));

test('B20 flip：逐字驗完整 14 個映射 —— 對合證明不了映射正確', () => {
  // 把兩個自映射字互換（例如 H↔I）**仍然是對合**，所以 B20-3 抓不到它。
  // 唯一擋得住的是逐字斷言。
  assert.equal(Object.keys(FLIP_MAP).length, 14, 'B20: 表大小變了');
  assert.equal(OUT_OF_TABLE.length, 22, 'B20: 表外字元數變了，掃描母體已失效');
  for (const [from, to] of Object.entries(FLIP_MAP)) {
    assert.equal(flip(from), to, `B20: flip('${from}') 應為 '${to}'`);
  }
});

test('B20-2 flip：表外字元在首／中／尾任一位置都必須回 null', () => {
  // 只檢查首字元的實作會讓 'OST'（T 在尾）漏掉；
  // 回「原字串」而非 null 的實作則會讓 B20-3 的對合斷言仍然通過（變異 F13-9）。
  for (const ch of OUT_OF_TABLE) {
    for (const [label, s] of [['首', `${ch}OS`], ['中', `O${ch}S`], ['尾', `OS${ch}`]]) {
      assert.equal(flip(s), null, `B20-2: '${s}'（表外字元在${label}）應回 null`);
    }
  }
  assert.equal(flip('OST'), null, 'B20-2: OST 具名案例');
});

test('B20-3 flip：對合只對「可倒讀」的 token 成立，表外由 null 契約分開驗', () => {
  let flippable = 0;
  for (const t of REAL_TOKENS) {
    const f = flip(t);
    if (f === null) continue;             // 表外 → 由 B20-2 負責，這裡不宣稱對合
    flippable++;
    assert.equal(flip(f), t, `B20-3: flip 對 '${t}' 不是對合`);
  }
  assert.ok(flippable >= 100, `B20-3: 只有 ${flippable} 個可倒讀 token —— 母體已失效`);
});

test('B20-4 flip：具名向量（含長度 > 3）', () => {
  assert.equal(flip('6'), '9');
  assert.equal(flip('69'), '69');         // fixed point，且不是單字元
  assert.equal(flip('MW'), 'MW');         // fixed point，跨字元對
  assert.equal(flip('WM'), 'WM');
  assert.equal(flip('SH'), 'HS');
  assert.equal(flip('TA'), null);
  assert.equal(flip('OSSIXNI'), 'INXISSO', 'B20-4: 長度 > 3 的具名向量');
});

/** D33 的 5 類，逐字列出。 */
const CANON_MEMBERS = { O: '0', I: '1', L: '1', S: '5', Z: '2', B: '8' };
const COLLAPSED = Object.keys(CANON_MEMBERS);

test('B21 canon：逐字驗五個等價類的每個成員，其餘字元一律 identity', () => {
  // 冪等 ＋ 值域仍然放行「Z 被刪掉」或「Z 映成 8」——兩者都滿足那兩條。
  for (const [member, rep] of Object.entries(CANON_MEMBERS)) {
    assert.equal(canon(member), rep, `B21: canon('${member}') 應為 '${rep}'`);
    assert.equal(canon(rep), rep, `B21: 代表字 '${rep}' 必須映到自己`);
  }
  for (const ch of ALNUM) {
    if (ch in CANON_MEMBERS) continue;
    assert.equal(canon(ch), ch, `B21: '${ch}' 不屬任何等價類，必須原樣保留`);
  }
});

test('B21-2 canon：對全部真實 token 冪等，且值域不含被壓平的字元', () => {
  for (const t of REAL_TOKENS) {
    const c = canon(t);
    assert.equal(canon(c), c, `B21-2: canon 對 '${t}' 不冪等`);
    for (const bad of COLLAPSED) {
      assert.ok(!c.includes(bad), `B21-2: canon('${t}') = '${c}' 仍含被壓平的 '${bad}'`);
    }
  }
  assert.ok(REAL_TOKENS.length >= 2000, `B21-2: 母體只有 ${REAL_TOKENS.length} 個 token`);
});

test('B21-3 canon：具名向量 —— 值域斷言擋不住「把字母全刪掉」', () => {
  assert.equal(canon('SILO'), '5110');
  assert.equal(canon('B2'), '82');
  assert.equal(canon('012'), '012');
  assert.equal(canon('APO'), 'AP0');      // 類外字元保留
});

test('B22 變體只接受完全相等 —— 字首與包含都不算（含對照組）', () => {
  const q = ['SH'];                        // flip → 'HS'
  assert.equal(flipPredicate(['HSY'], q), false, 'B22: HS 是 HSY 的字首，仍不得放行');
  assert.equal(flipPredicate(['XHSY'], q), false, 'B22: HS 被 XHSY 包含，仍不得放行');
  // 對照組：沒有它，「變體功能整個沒接上」也會讓上面兩條全綠
  assert.equal(flipPredicate(['HS'], q), true, 'B22 對照組: 完全相等必須放行');

  const q2 = ['B2'];                       // canon → '82'
  assert.equal(canonPredicate(['82X'], q2), false, 'B22: canon 側字首不得放行');
  assert.equal(canonPredicate(['X82'], q2), false, 'B22: canon 側包含不得放行');
  assert.equal(canonPredicate(['82'], q2), true, 'B22 對照組: canon 完全相等必須放行');
});

test('B22-1b 每條 predicate 必須覆蓋**全部**查詢 token —— every 不是 some', () => {
  // **這條是變異測試 F13-5b 逼出來的。** 原本 B22 的三個 flip 案例全是單 token 查詢，
  // 而單 token 之下 `every` 與 `some` 完全等價：把 every 改成 some，整組 B22 照樣全綠。
  // 要分辨得出來，必須是「多 token、兩者都可倒讀、但只有一個命中」。
  const q = ['SH', 'MM'];                  // flip → ['HS', 'WW']，兩者都在表內
  assert.deepEqual(q.map(flip), ['HS', 'WW'], 'B22-1b 前提: 兩個 token 都可倒讀');
  assert.equal(flipPredicate(['HS'], q), false, 'B22-1b: 只中一個 token 不得放行（every 不是 some）');
  assert.equal(flipPredicate(['WW'], q), false, 'B22-1b: 只中另一個也不行');
  assert.equal(flipPredicate(['HS', 'WW'], q), true, 'B22-1b 對照組: 全中才放行');

  // canon 側同理
  const q2 = ['B2', 'SL'];                 // canon → ['82', '51']
  assert.deepEqual(q2.map(canon), ['82', '51'], 'B22-1b 前提: canon 值');
  assert.equal(canonPredicate(['82'], q2), false, 'B22-1b: canon 側只中一個不得放行');
  assert.equal(canonPredicate(['82', '51'], q2), true, 'B22-1b 對照組: canon 側全中才放行');
});

test('B22-2 兩條規則不得拼接 —— 這是 N15 的守門（變異 F13-10）', () => {
  // 真實 witness：記錄 衛署藥製字第034807號 的 token 是 [M, T, 130, HOPER]，
  // 查詢 'W L30' 之下 W 靠倒讀命中 M、L30 靠字形命中 130，
  // **但單一規則都不全中**：flip('L30') 因 L 表外回 null，W 是單字元使 canon 停用。
  const tokens = ['M', 'T', '130', 'HOPER'];
  const canonTokens = tokens.map(canon);
  const q = ['W', 'L30'];

  assert.equal(flip('L30'), null, 'B22-2 前提: L 在表外');
  assert.equal(flipPredicate(tokens, q), false, 'B22-2: 倒讀整條必須 false（不得略過表外 token）');
  assert.equal(canonPredicate(canonTokens, q), false, 'B22-2: 單字元使字形整條 false');
  assert.equal(variantReasons(tokens, canonTokens, q), null,
    'B22-2: 兩條規則各中一個 token 時**必須排除** —— 逐 token OR 就是 N15 禁止的組合變體');

  // 對照組一：同一規則覆蓋全部 token → 必須放行
  assert.deepEqual(variantReasons(['M', 'W'], ['M', 'W'].map(canon), ['W', 'M']), ['flip'],
    'B22-2 對照組: 同一規則全中必須放行');
  // 對照組二：兩條規則**各自獨立**全中 → 雙理由
  const both = variantReasons(['10', '01'], ['10', '01'].map(canon), ['01']);
  assert.deepEqual(both, ['flip', 'canon'], 'B22-2 對照組: 各自獨立全中才給雙理由');
});

test('B22-3 變體理由永不為空集合 —— 空集合會被讀成「有變體但不知為何」', () => {
  assert.equal(variantReasons(['ABC'], ['ABC'], ['ZZQ']), null, 'B22-3: 沒中就要回 null');
  const r = variantReasons(['HS'], ['H5'], ['SH']);
  assert.ok(Array.isArray(r) && r.length > 0, 'B22-3: 有中就必須是非空陣列');
  assert.ok(Object.isFrozen(r), 'B22-3: 理由陣列必須凍結 —— 呼叫端改到它就會污染別筆');
});
