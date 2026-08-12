/**
 * E4／E5 靜態原始碼契約（規格 `.ai-review/plan.md` §10）
 *
 * **這裡只放靜態契約，不放任何依賴 cascade、media query 或幾何的斷言。**
 * 本專案刻意不引入 jsdom（零依賴），沒有 `getComputedStyle`／
 * `getBoundingClientRect`／`matchMedia`——在那種樁上寫幾何斷言**必然永遠是綠的**，
 * 比沒有測試更糟，因為後人會以為那條守住了。
 * 版面、touch target、圖片可辨識度走 E1–E3 的人工瀏覽器留檔。
 *
 * E5 的靜態掃描**不宣稱完備**：別名與 computed property 繞得過去。
 * 隱私契約的主要依據是 E5 的人工 network／storage 留檔，這裡是第二道。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { COLORS, SHAPES, SCORE_MARKS } from '../search.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 會被發布到 GitHub Pages 的程式碼與樣板檔案 */
const PUBLISHABLE = ['index.html', 'app.js', 'search.js'];
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/**
 * 掃「程式碼實際做了什麼」之前**必須先剝掉註解**。
 *
 * 姊妹專案記過同一個坑：寫著「不做 X」的註解本身會讓「不得出現 X」恆紅。
 * 本檔的 E4d 一開始就是這樣——`app.js` 裡寫著「**不得說「找不到」**」的註解，
 * 讓「該分支不得含『找不到』」永遠失敗。
 *
 * `//` 前面若是 `:` 則不視為註解（保護 `https://`）。
 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/**
 * 身份宣稱**片語**，不是單詞。
 *
 * 用單詞會誤擋正常語境（安全提示裡就有「確認」），
 * 而真正危險的是「系統斷定這顆藥是什麼」這件事被寫成句子。
 */
const CLAIM_PHRASES = ['辨識成功', '就是這顆', '確認為', '本品為', '判定為此藥', '即為此藥'];

const SAFETY = '外觀相似不代表為同一藥品';

test('E4 所有可發布檔案不得出現身份宣稱片語', () => {
  for (const f of PUBLISHABLE) {
    const src = read(f);
    for (const p of CLAIM_PHRASES) {
      assert.ok(!src.includes(p), `E4: ${f} 含身份宣稱片語「${p}」`);
    }
  }
});

test('E4b 掃描範圍涵蓋 search.js 與資料文案，不是只有兩個檔', () => {
  // v1.1 曾把掃描範圍寫成「index.html + app.js」。禁語可以從 search.js
  // 或輸出到前端的 JSON 文案漏出去——「斷言正確但沒掃到違規發生的位置」。
  assert.ok(PUBLISHABLE.includes('search.js'));
  const dataFiles = ['data/vocab.lock.json', 'data/image-exceptions.json']
    .filter((f) => fs.existsSync(path.join(ROOT, f)));
  for (const f of dataFiles) {
    const src = read(f);
    for (const p of CLAIM_PHRASES) assert.ok(!src.includes(p), `E4b: ${f} 含「${p}」`);
  }
});

test('E4c 臨床安全提示必須存在且不可摺疊', () => {
  const html = read('index.html');
  assert.ok(html.includes(SAFETY), 'E4c: 安全提示字串不存在');
  assert.ok(html.includes('實際藥品仍應依原包裝'), 'E4c: 安全提示不完整');
  // 不得放進 <details>／hidden 之類會收起來的容器
  const m = html.match(/<p class="safety">[\s\S]*?<\/p>/);
  assert.ok(m, 'E4c: 找不到 .safety 區塊');
  assert.ok(!/hidden|<details/i.test(m[0]), 'E4c: 安全提示被放進可摺疊或隱藏的容器');
});

test('E4d 使用候選語彙，不得把結果說成確定的身份', () => {
  const src = stripComments(read('app.js'));
  assert.ok(read('app.js').includes('候選'), 'E4d: 未使用「候選」語彙');
  // 「找不到」只能出現在真正 EMPTY 的分支；ONLY_UNCERTAIN 分支不得使用。
  // 掃剝掉註解後的程式碼——說明「不得說找不到」的註解本身會讓這條恆紅。
  const from = src.indexOf('ResultState.ONLY_UNCERTAIN)');
  const to = src.indexOf('ResultState.TOO_MANY_EXHAUSTED)');
  assert.ok(from > 0 && to > from, 'E4d: 找不到 ONLY_UNCERTAIN 分支');
  assert.ok(!src.slice(from, to).includes('找不到'),
    'E4d: 主區 0 但仍有無法排除的候選時，畫面說了「找不到」');
  // 對照組：真正 EMPTY 的分支**必須**說找不到，否則上一條可以靠「整份都不寫」通過
  const emptyFrom = src.indexOf('ResultState.EMPTY)');
  assert.ok(src.slice(emptyFrom, from).includes('找不到符合的藥品'),
    'E4d: EMPTY 分支未給出明確結論');
});

test('E5 不得出現任何 storage 或 cookie 存取', () => {
  for (const f of PUBLISHABLE) {
    const src = read(f);
    for (const bad of ['localStorage', 'sessionStorage', 'document.cookie', 'indexedDB', 'navigator.sendBeacon']) {
      assert.ok(!src.includes(bad), `E5: ${f} 含 ${bad}`);
    }
  }
});

test('E5b 外部 origin 允許清單：只有 TFDA 資料集頁與官方原圖 origin', () => {
  // 兩者都**只以超連結形式存在**，沒有任何一個會在載入時被請求（§9）。
  // `mcp.fda.gov.tw` 是 v0.1 新增的：詳細頁的「查看 TFDA 官方原圖」。
  const ALLOW = [
    'https://data.fda.gov.tw/opendata/exportDataList.do',
    'https://mcp.fda.gov.tw',
  ];
  for (const f of PUBLISHABLE) {
    const src = read(f);
    const urls = [...src.matchAll(/https?:\/\/[^\s"'`)<>]+/g)].map((m) => m[0]);
    for (const u of urls) {
      assert.ok(ALLOW.some((a) => u.startsWith(a)),
        `E5b: ${f} 含允許清單外的外部 URL：${u}`);
    }
  }
  // 字型 CDN 是最容易被加回來的一個——house style 用它，本專案刻意不用（§8.1、§9）
  for (const f of PUBLISHABLE) {
    const src = read(f);
    assert.ok(!/fonts\.(googleapis|gstatic)\.com/.test(src), `E5c: ${f} 載入了第三方字型 CDN`);
    assert.ok(!/@import\s+url\(\s*['"]?https?:/.test(src), `E5c: ${f} 有外部 CSS @import`);
  }
});

test('E5d 沒有分析工具、沒有對外送出搜尋輸入', () => {
  const src = read('app.js');
  assert.ok(!/gtag|dataLayer|analytics|plausible|umami/i.test(src), 'E5d: 疑似分析工具');
  // 只允許一次 fetch，且對象是自己的相對路徑資料檔
  const fetches = [...src.matchAll(/fetch\(([^)]*)\)/g)].map((m) => m[1]);
  assert.equal(fetches.length, 1, `E5d: fetch 呼叫數應為 1，實際 ${fetches.length}`);
  assert.match(fetches[0], /DATA_URL/);
  assert.match(src, /const DATA_URL = 'data\/appearance\.json'/);
  assert.ok(!/XMLHttpRequest|WebSocket|EventSource|\.submit\(/.test(src), 'E5d: 有其他對外傳輸管道');
});

test('E6-static UI chips 的可選值集合 === search.js 常數 === vocab.lock（集合相等，非數量相等）', () => {
  const lockPath = path.join(ROOT, 'data/vocab.lock.json');
  assert.ok(fs.existsSync(lockPath), 'vocab.lock.json 不存在，D6 的鎖不成立');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const same = (a, b) => {
    const A = new Set(a), B = new Set(b);
    return A.size === B.size && [...A].every((x) => B.has(x));
  };
  assert.ok(same(COLORS, lock.color), `E6: 顏色 chips 與 lock 不符\n  chips=${JSON.stringify(COLORS)}\n  lock =${JSON.stringify(lock.color)}`);
  assert.ok(same(SHAPES, lock.shape), 'E6: 形狀 chips 與 lock 不符');
  assert.ok(same(SCORE_MARKS, lock.score_mark), 'E6: 刻痕 chips 與 lock 不符');

  // app.js 的 chips 必須直接來自那組常數，不得自己抄一份
  const src = read('app.js');
  assert.match(src, /multi\(\$\('colorChips'\), COLORS, 'color'\)/);
  assert.match(src, /multi\(\$\('shapeChips'\), SHAPES, 'shape'\)/);
  assert.ok(!/['"]白['"]/.test(src), 'E6: app.js 內出現硬編的顏色值');
});

test('E5e 官方原圖連結必須走 origin 白名單，且不得自己抄一份', () => {
  const src = stripComments(read('app.js'));
  // 弱化版本：`a.href = g.src` 直接指派。B13 驗的是白名單函式本身正確，
  // 這條驗的是 UI **真的有經過它**——只驗函式的話，繞過它一樣全綠。
  assert.ok(!/\.href = g\.src/.test(src), 'E5e: 未經白名單就把來源 URL 當成 href');
  assert.match(src, /officialUrl\(g\.src\)/);
  assert.match(src, /isOfficialImgUrl\(src\)/);
  assert.match(src, /a\.rel = 'noopener noreferrer'/);
  // 白名單常數只能有一份（search.js）。app.js 自己寫死 origin 就是漂移的起點。
  assert.ok(!/mcp\.fda\.gov\.tw/.test(src), 'E5e: app.js 內出現硬編的圖檔 origin');
});

test('E-arch app.js 不得自己實作搜尋語意（正規化只有一份）', () => {
  const src = stripComments(read('app.js'));
  // 只列**比對動作**。`unknown`／`partial` 是 search.js 回傳的分區名稱，
  // 在 UI 裡讀它們是正常的，列進來會變成擋住正確用法的假規則。
  for (const leak of ['toUpperCase(', 'startsWith(', "';;;'", 'localeCompare', 'Cond.', 'Tier.']) {
    assert.ok(!src.includes(leak), `E-arch: app.js 疑似自行實作比對邏輯（${leak}）`);
  }
  assert.match(src, /from '\.\/search\.js'/);
  // 分區與狀態一律取用 search.js 的輸出，不得自行推導
  assert.match(src, /resultStates\(res, criteria\)/);
  assert.match(src, /search\(items, criteria\)/);
});

test('E-img 圖片一律 lazy＋帶內容版本，且失敗時換 placeholder 不留破圖', () => {
  const src = read('app.js');
  assert.match(src, /img\.loading = 'lazy'/);
  assert.match(src, /img\.decoding = 'async'/);
  assert.match(src, /\?v=\$\{g\.sha256\.slice\(0, 8\)\}/, 'E-img: 圖片 URL 未帶內容版本（D10.1）');
  const errHandlers = [...src.matchAll(/addEventListener\('error'/g)];
  assert.equal(errHandlers.length, 2, 'E-img: 卡片與詳細頁都必須有 onerror fallback');
  assert.ok(src.includes('官方暫無可用圖片'));
  assert.ok(src.includes('鏡像圖片建置中'));
  assert.ok(src.includes("payload.meta.images_complete !== false"));
  assert.ok(src.includes("collapsed ? 'details' : 'section'"), '低確定性結果須使用原生 details');
  assert.match(src, /res\.partial, true, true/, '部分符合區須預設收合');
  assert.match(src, /res\.unknown, true, true/, '資料未提供區須預設收合');
  assert.ok(src.includes("s.addEventListener('toggle'"), '收合區應在首次展開時才建立卡片');
});
