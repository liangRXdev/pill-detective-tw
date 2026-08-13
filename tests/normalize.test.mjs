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
  isOfficialImgUrl, officialLeafletUrl, IMG_ORIGIN,
  normalizeName, imprintQueryState, QueryState, toItem,
  hasActiveCriteria, SCORE_ANY,
  taipeiDate, daysSinceISODate, STALE_DAYS, freshnessView,
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
