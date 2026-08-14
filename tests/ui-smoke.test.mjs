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

/**
 * 會被發布到 GitHub Pages 的程式碼與樣板檔案。
 *
 * v0.2 加入 `sw.js` 與 `manifest.webmanifest`：它們同樣會被發布，
 * 同樣能夾帶外部 origin 或禁語，漏掃等於 E4b 記過的那個坑再犯一次。
 */
const PUBLISHABLE = ['index.html', 'app.js', 'search.js', 'sw.js', 'manifest.webmanifest'];
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

  // **這條刻意不是「fetch 呼叫數 === N」。**
  // v0.2 加 status.json 時那個版本只會逼人把 1 改成 2——常數推大、守門力歸零。
  // 改成列舉：每一個 fetch 的第一個引數都必須是這裡具名的白名單常數，
  // 新增任何請求目標都得先在測試裡登記。
  const ALLOWED_FETCH_TARGETS = ['DATA_URL', 'STATUS_URL'];
  const fetches = [...src.matchAll(/fetch\(\s*([^,)\s]*)/g)].map((m) => m[1]);
  assert.ok(fetches.length > 0, 'E5d: app.js 找不到任何 fetch —— 掃描已失效，不是「沒有請求」');
  for (const f of fetches) {
    assert.ok(ALLOWED_FETCH_TARGETS.includes(f), `E5d: fetch 目標不在白名單：${f}`);
  }
  // 常數名對了不代表值是安全的：白名單常數本身必須是硬編的**相對路徑**
  assert.match(src, /const DATA_URL = 'data\/appearance\.json'/);
  assert.match(src, /const STATUS_URL = 'data\/status\.json'/);
  assert.ok(!/XMLHttpRequest|WebSocket|EventSource|\.submit\(/.test(src), 'E5d: 有其他對外傳輸管道');
});

test('E7 資料新鮮度頁尾不得 fail-closed，且不得寫死任何日期', () => {
  const src = read('app.js');
  const body = stripComments(src);

  // status.json 是裝飾性資訊。它掛掉時若走 fatal()，等於讓一個週更狀態檔
  // 有權停掉整個搜尋——比不顯示更糟。
  const fn = body.slice(body.indexOf('async function renderFreshness'));
  assert.ok(fn.startsWith('async function renderFreshness'), 'E7: 找不到 renderFreshness，掃描失效');
  const fnBody = fn.slice(0, fn.indexOf('\n}\n') + 2);
  assert.ok(!/\bfatal\(/.test(fnBody), 'E7: renderFreshness 內出現 fatal()');
  assert.match(fnBody, /try\s*\{[\s\S]*fetch\(\s*STATUS_URL/, 'E7: status.json 的 fetch 不在 try 內');
  assert.match(fnBody, /catch/, 'E7: 沒有 catch，狀態檔失敗會變成 unhandled rejection');
  // 新鮮度判斷一律由共用純函式決定，app.js 不得自己判（同 D15 的理由）
  assert.match(fnBody, /freshnessView\(meta, status\)/, 'E7: 沒有走共用的 freshnessView');
  assert.ok(!/status\.(source_version|count|last_checked)/.test(fnBody),
    'E7: app.js 直接讀 status 的欄位 —— 版本對帳會被繞過');
  // 什麼都沒有就整段不顯示
  assert.match(fnBody, /hidden = true/, 'E7: 缺少「什麼都沒有就不顯示」的路徑');

  // 頁面不得預先寫死日期：一個靜態的假「最後檢查」比空白更危險
  const html = stripComments(read('index.html'));
  const holder = html.match(/<p class="freshness"[^>]*>([\s\S]*?)<\/p>/);
  assert.ok(holder, 'E7: index.html 找不到 #freshness');
  assert.match(holder[0], /\bhidden\b/, 'E7: #freshness 預設不是 hidden');
  assert.equal(holder[1].trim(), '', 'E7: #freshness 有寫死的內容');
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(html), 'E7: index.html 出現寫死的日期');
});

test('E8 過期警示與版本對帳都在共用純函式裡，前端不得另抄', () => {
  const app = stripComments(read('app.js'));
  const fv = stripComments(read('search.js'));

  // 前端只能拿 view 的結果，不得自己算天數或抄門檻
  assert.ok(!/>\s*14\b/.test(app), 'E8: app.js 自己抄了天數字面值');
  assert.ok(!/STALE_DAYS|daysSinceISODate/.test(app),
    'E8: app.js 自己做新鮮度判斷 —— 那會與 freshnessView 漂移');
  assert.match(app, /view\.stale/, 'E8: 沒有使用 view.stale');
  assert.match(app, /view\.lastChecked/, 'E8: 沒有使用 view.lastChecked');
  assert.match(read('index.html'), /\.freshness\.is-stale/, 'E8: 缺少 is-stale 樣式');

  // freshnessView 的三條防線，各自對應一種「顯示了看起來正常、其實是錯的東西」。
  // 行為由 B19 實跑覆蓋，這裡只擋「整段被拿掉」。
  const fn = fv.slice(fv.indexOf('export function freshnessView'));
  const fnBody = fn.slice(0, fn.indexOf('\n}\n') + 2);
  assert.ok(fnBody.startsWith('export function freshnessView'), 'E8: 找不到 freshnessView，掃描失效');
  assert.match(fnBody, /=== sourceVersion/, 'E8: 缺少 source_version 的跨版本對帳');
  assert.match(fnBody, /days >= 0/, 'E8: 未來日期沒有被擋掉，會顯示成剛檢查過');
  assert.match(fnBody, /days > STALE_DAYS/, 'E8: 過期判定沒有比對 STALE_DAYS');
  // 版本與筆數必須取自 meta（已通過 D16 契約），不得取 status
  assert.match(fnBody, /meta\?\.source_version/, 'E8: sourceVersion 不是取自 meta');
  assert.match(fnBody, /meta\?\.count/, 'E8: count 不是取自 meta');
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

test('E5f TFDA 仿單連結必須使用共用 URL builder', () => {
  const src = stripComments(read('app.js'));
  assert.match(src, /officialLeafletUrl\(item\.id\)/);
  assert.match(src, /leaflet\.rel = 'noopener noreferrer'/);
  assert.ok(!/im_detail_1|mcp\.fda\.gov\.tw/.test(src),
    'E5f: app.js 不得自行拼接 TFDA 仿單 URL 或 origin');
});

test('E-ux 零條件顯示資料庫入口，不建立全資料集結果卡', () => {
  const src = stripComments(read('app.js'));
  assert.match(src, /hasActiveCriteria\(criteria\)/);
  assert.ok(src.includes('目前收錄 '));
  assert.ok(src.includes('項 TFDA 藥品外觀資料'));
  assert.ok(src.includes('輸入刻字或選擇外觀特徵開始搜尋'));
  const start = src.indexOf('if (!hasActiveCriteria(criteria))');
  const run = src.indexOf('search(items, criteria)');
  assert.ok(start > 0 && run > start, '空搜尋判定必須發生在執行搜尋之前');
  assert.ok(src.slice(start, run).includes('return;'), '入口狀態必須提前返回');
});

test('E-detail 詳細視窗使用辨識卡，兩個刻字欄皆缺時只顯示一次提示', () => {
  const src = stripComments(read('app.js'));
  assert.ok(!src.includes("el('table', 'kv')"), '詳細視窗不應保留 table 版型');
  assert.match(src, /el\('dl', 'identity-card__features'\)/);
  assert.match(src, /mark1 == null && mark2 == null/);
  assert.equal((src.match(/刻字資料未提供/g) ?? []).length, 1);
  assert.ok(src.includes("[['標註一', mark1], ['標註二', mark2]]"),
    '只有單欄缺值時仍須保留 TFDA 原始欄位名稱');
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

// ── E9／E10 PWA 契約（D29）─────────────────────────────────────────

/** PNG IHDR：宣稱的 sizes 與檔案實際尺寸不符是靜默失效，安裝提示會直接不出現 */
function pngSize(rel) {
  const b = fs.readFileSync(path.join(ROOT, rel));
  assert.equal(b.readUInt32BE(0), 0x89504e47, `${rel} 不是 PNG`);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

test('E9 manifest 的圖示都存在，且宣稱尺寸等於實際像素', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.equal(m.scope, './', 'E9: scope 不是相對路徑（會越界到 origin 上的姊妹站）');
  assert.equal(m.start_url, './');
  assert.equal(m.display, 'standalone');
  assert.equal(m.theme_color, '#3D7A8A', 'E9: theme_color 與 index.html 的 meta 漂移');
  assert.match(read('index.html'), /<meta name="theme-color" content="#3D7A8A">/);

  assert.ok(m.icons.length >= 3, 'E9: 圖示不足');
  for (const icon of m.icons) {
    assert.ok(!/^https?:|^\//.test(icon.src), `E9: 圖示不是相對路徑：${icon.src}`);
    assert.ok(fs.existsSync(path.join(ROOT, icon.src)), `E9: 圖示不存在：${icon.src}`);
    const { w, h } = pngSize(icon.src);
    assert.equal(`${w}x${h}`, icon.sizes, `E9: ${icon.src} 宣稱 ${icon.sizes}、實際 ${w}x${h}`);
  }
  // Android 自適應圖示與 iOS 各自需要專屬檔案，缺了只會安靜地退成醜圖
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'), 'E9: 缺 maskable 圖示');
  assert.ok(m.icons.some((i) => i.purpose === 'any' && i.sizes === '192x192'), 'E9: 缺 192 any');
  assert.ok(m.icons.some((i) => i.purpose === 'any' && i.sizes === '512x512'), 'E9: 缺 512 any');

  const html = read('index.html');
  assert.match(html, /<link rel="manifest" href="manifest\.webmanifest">/, 'E9: index.html 未連 manifest');
  assert.match(html, /<link rel="apple-touch-icon" href="icons\/apple-touch-icon\.png">/,
    'E9: 缺 apple-touch-icon（iOS 不吃 manifest 的圖示）');
  assert.equal(pngSize('icons/apple-touch-icon.png').w, 180);
});

test('E10 SW：只清自己前綴的 cache，且資料檔 network-first', () => {
  const src = read('sw.js');
  const body = stripComments(src);

  // Cache Storage 是 origin-wide，liangrxdev.github.io 上還有十幾個姊妹工具。
  // 沒有前綴限制的 activate 會刪掉別人的離線資源（recall dashboard 的 CR-12）。
  assert.match(body, /const CACHE_PREFIX = 'pill-'/, 'E10: 沒有 pill- 前綴常數');
  const activate = body.slice(body.indexOf("addEventListener('activate'"));
  const activateBody = activate.slice(0, activate.indexOf('\n});') + 4);
  assert.ok(activateBody.includes('caches.delete'), 'E10: 找不到 activate 的清理路徑，掃描失效');
  assert.match(activateBody, /startsWith\(CACHE_PREFIX\)/,
    'E10: activate 未限定前綴，會刪掉同 origin 其他專案的 cache');

  // `?v=<sha8>` 是 D10.1 的內容版本。忽略 query 比對＝TFDA 換圖後永遠命中舊圖。
  assert.ok(!/ignoreSearch/.test(body), 'E10: 使用了 ignoreSearch，內容版本機制被廢掉');

  // 資料檔必須 network-first：fetch 要出現在退快取之前
  const nf = body.slice(body.indexOf('async function networkFirstData'));
  const nfBody = nf.slice(0, nf.indexOf('\n}\n') + 2);
  assert.ok(nfBody.includes('await fetch(req)'), 'E10: 找不到 networkFirstData 的網路路徑');
  assert.ok(nfBody.indexOf('await fetch(req)') < nfBody.indexOf('cache.match'),
    'E10: 先讀快取再打網路 —— 那是 cache-first，會靜默端出舊資料');
  // 沒有快取時必須讓例外往上拋，D16 的 fail-closed 才會生效。
  // 合成一個成功回應（空 items／200 空殼）會被讀成「查無此藥」。
  assert.match(nfBody, /throw err/, 'E10: 無快取時沒有把例外拋出');
  assert.ok(!/new Response\(/.test(nfBody), 'E10: networkFirstData 合成了回應');
  assert.match(nfBody, /notifyClients\(\{ type: 'OFFLINE_MODE'/, 'E10: 退快取時沒有通報前端');

  // A+B 範圍：3.7 MB 的資料檔不得進 install 的預抓清單
  const shell = body.slice(body.indexOf('const SHELL = ['), body.indexOf('];', body.indexOf('const SHELL = [')));
  assert.ok(!shell.includes('appearance.json'), 'E10: appearance.json 進了 install 預抓（3.7 MB）');
  assert.ok(shell.includes('index.html') && shell.includes('app.js') && shell.includes('search.js'),
    'E10: 預抓清單不完整，掃描失效');

  // 圖片全量 87 MB，必須有數量上限與淘汰路徑
  const limit = body.match(/const IMG_CACHE_LIMIT = (\d+);/);
  assert.ok(limit, 'E10: 圖片快取沒有上限常數');
  assert.ok(Number(limit[1]) > 0 && Number(limit[1]) < 6798,
    `E10: 圖片上限 ${limit[1]} 不在合理範圍（全量 6,798 張／87 MB）`);
  assert.match(body, /keys\.length - IMG_CACHE_LIMIT/, 'E10: 有上限常數但沒有淘汰路徑');
  // 淘汰必須掛在 event 上。沒人等的 Promise 只是「有機會跑完」——
  // SW 回應後隨時可能被終止，那樣上限就不是保證而是願望。
  // （**執行期行為由 E11 負責**；這一條只擋原始碼層的移除。）
  assert.match(body, /event\.waitUntil\(trimImageCache\(\)\)/,
    'E10: 圖片淘汰未受 fetch event lifetime 保護');

  // 跨源一律不攔截（§9／F11）
  assert.match(body, /url\.origin !== self\.location\.origin\) return;/, 'E10: 未排除跨源請求');

  // 模組不得 stale-while-revalidate：導覽已是 network-first，
  // SWR 會造成「新 index.html 配舊 app.js」的版本偏移，
  // 且部署修正漏檢規則後首次重訪仍會靜默套用舊規則。
  assert.ok(!/staleWhileRevalidate/.test(body),
    'E10: shell 走了 stale-while-revalidate，部署後首次重訪會執行舊模組');

  // 寫快取失敗不得被當成網路失敗（配額爆掉 ≠ 離線）。
  // 每一處 cache.put 都必須經由 putSafe，且 putSafe 自己要吞掉例外。
  const puts = [...body.matchAll(/(\w+)\.put\(/g)].map((m) => m[1]);
  assert.ok(puts.length > 0, 'E10: 找不到任何 cache.put —— 掃描已失效');
  for (const receiver of puts) {
    assert.equal(receiver, 'cache', `E10: 非預期的 put 接收者：${receiver}`);
  }
  const safe = body.slice(body.indexOf('async function putSafe'));
  const safeBody = safe.slice(0, safe.indexOf('\n}\n') + 2);
  assert.ok(safeBody.startsWith('async function putSafe'), 'E10: 找不到 putSafe，掃描失效');
  assert.match(safeBody, /try\s*\{[\s\S]*cache\.put[\s\S]*catch/,
    'E10: putSafe 沒有吞掉寫入例外');
  // putSafe 以外不得有裸 cache.put —— 有的話那一處仍會把配額錯誤當成離線
  const bareputs = body.split('\n')
    .filter((l) => l.includes('cache.put(') && !safeBody.includes(l));
  assert.deepEqual(bareputs, [], `E10: putSafe 之外還有裸 cache.put：${bareputs.join(' / ')}`);
});

test('E10b 離線橫幅：不得預先寫死，且監聽必須早於 load()', () => {
  const html = read('index.html');
  const holder = html.match(/<p class="offline"[^>]*>([\s\S]*?)<\/p>/);
  assert.ok(holder, 'E10b: index.html 找不到 #offline');
  assert.match(holder[0], /\bhidden\b/, 'E10b: #offline 預設不是 hidden');
  assert.equal(holder[1].trim(), '', 'E10b: #offline 有寫死的內容');

  const app = stripComments(read('app.js'));
  const listener = app.indexOf("e.data?.type !== 'OFFLINE_MODE'");
  assert.ok(listener > 0, 'E10b: app.js 沒有監聽 OFFLINE_MODE');
  // SW 在回應資料**之前**送訊息（networkFirstData 會先 await notifyClients）。
  // 監聽晚於 load() 就永遠收不到，而橫幅不出現＝離線舊資料完全沒有標示。
  assert.ok(listener < app.lastIndexOf('\nload();'),
    'E10b: OFFLINE_MODE 的監聽註冊晚於 load()，會漏掉 SW 送出的訊息');
  // 訊息可能早於資料載入完成，故必須存成狀態再補畫，不能只在收到時畫一次
  assert.match(app, /offlineData = true/, 'E10b: 沒有把離線狀態存下來');
  assert.match(app, /if \(offlineData\) renderOfflineBanner\(\)/,
    'E10b: 資料載入完成後沒有補畫橫幅（訊息早到就會漏）');
  // 註冊失敗不得影響任何功能
  assert.match(app, /navigator\.serviceWorker\.register\('sw\.js'\)\.catch\(/,
    'E10b: SW 註冊沒有吞掉失敗');

  // 橫幅只在**搜尋資料**退快取時掛。status.json 單獨退快取時，畫面上的結果
  // 其實是剛從網路取得的，說「顯示的是先前存下的資料」就是錯誤陳述。
  assert.match(app, /endsWith\('\/data\/appearance\.json'\)/,
    'E10b: OFFLINE_MODE 未分辨 path，status 單獨失敗也會宣稱資料來自快取');
  const guard = app.split('\n').findIndex((l) => l.includes("endsWith('/data/appearance.json')"));
  const setFlag = app.split('\n').findIndex((l) => l.includes('offlineData = true'));
  assert.ok(guard > 0 && guard < setFlag,
    'E10b: path 判斷沒有擋在設定 offlineData 之前');
  // SW 那端必須真的送出 path，否則前端的判斷永遠為 false（橫幅再也不會出現）
  assert.match(stripComments(read('sw.js')), /OFFLINE_MODE', path: url\.pathname/,
    'E10b: SW 沒有送出 path');
});

// ── E12 變體區（D30／D37）────────────────────────────────────────────
//
// **本條的自動化範圍是靜態契約，不是渲染結果。**
// 本專案刻意不引入 jsdom（檔頭已說明理由：在那種樁上寫的斷言必然永遠是綠的）。
// 「每張卡片的理由標籤貼在正確的卡片上」只能由人工瀏覽器留檔證明，
// 見 `.ai-review/evidence/e12-2026-08-14.md`。**這裡不宣稱它證明了那件事。**
// 底下的斷言負責的是另一半：理由確實逐筆流進 card()，而不是掛在分區標題上。

test('E12 變體區：逐筆理由流進 card()，不是掛在分區標題上', () => {
  const src = stripComments(read('app.js'));

  // (1) 變體區的元素是 { item, reasons }，且理由**逐筆**傳進 card()。
  // 若寫成 card(v.item) 而把理由畫在 section 標題，這條會紅。
  assert.match(src, /card\(\s*v\.item\s*,\s*v\.reasons\s*\)/,
    'E12: 理由沒有逐筆傳進 card() —— 那就無法保證它貼在對的卡片上');

  // (2) 理由標籤必須建在**卡片內文**（body）裡，不是 section。
  // 這是靜態掃描能做到的最接近「逐卡定位」的斷言。
  assert.match(src, /body\.appendChild\(\s*why\s*\)/,
    'E12: 理由標籤沒有掛進卡片內文');

  // (3) 兩個理由必須是**可分辨的兩個詞**。
  // 合併成「可能相似」這類統一文案，使用者就分不出該翻過來看還是換角度看。
  const map = src.match(/VARIANT_WHY\s*=\s*\{([^}]*)\}/);
  assert.ok(map, 'E12: 找不到 VARIANT_WHY 對應表');
  const labels = [...map[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.equal(labels.length, 2, 'E12: 理由標籤應恰有兩個');
  assert.notEqual(labels[0], labels[1], 'E12: 兩個理由的文案不得相同');
  for (const l of labels) assert.ok(l.length >= 2, `E12: 理由文案「${l}」過短`);

  // (4) 分區順序：變體區必須排在未提供區**之後**，且預設收合。
  const uAt = src.indexOf("section('資料未提供'");
  const vAt = src.indexOf("'刻字可能看反或字形相近'");
  assert.ok(uAt > 0, 'E12: 找不到未提供區');
  assert.ok(vAt > uAt, 'E12: 變體區必須排在未提供區之後');
  const variantCall = src.slice(vAt, vAt + 400);
  assert.match(variantCall, /res\.variant/, 'E12: 變體區沒有讀 res.variant');
  assert.match(variantCall, /true,\s*true,\s*variantCard/,
    'E12: 變體區必須是 soft＋預設收合，且用 variantCard 繪製');

  // (5) uncertain 計數必須納入變體，否則「符合條件 0 項」旁邊不會有任何提示
  assert.match(src, /res\.partial\.length \+ res\.unknown\.length \+ res\.variant\.length/,
    'E12: 標題列的 uncertain 沒有納入變體');
});

test('E12b 變體區文案不得出現分數／相似度／排名（F8）', () => {
  const html = read('index.html');
  const app = stripComments(read('app.js'));

  // 只掃 **UI 自產生**的理由與標題文字，不掃資料欄位——
  // 藥品品名本來就可能含 `%`（例如「5%葡萄糖」），掃全區會誤觸而讓這條變成雜訊。
  const uiStrings = [
    ...app.matchAll(/'([^']*(?:刻字|理由|倒讀|字形|變體)[^']*)'/g),
  ].map((m) => m[1]);
  assert.ok(uiStrings.length >= 3, `E12b: 只掃到 ${uiStrings.length} 段變體文案 —— 掃描已失效`);
  for (const s of uiStrings) {
    for (const banned of ['%', '分數', '相似度', '排名', '評分', '信心']) {
      assert.ok(!s.includes(banned), `E12b: 變體文案「${s}」含禁語「${banned}」`);
    }
  }

  // 變體區的樣式不得用顏色區分兩種理由——顏色會被讀成強弱，而變體沒有分數
  const vwhy = html.match(/\.pill \.vwhy span\{([^}]*)\}/);
  assert.ok(vwhy, 'E12b: 找不到理由標籤樣式');
  assert.ok(!/--danger|--success|--warning|--accent[^-]/.test(vwhy[1]),
    'E12b: 理由標籤用了語意色 —— 那會被讀成強弱');
});

test('E12c app.js 不得自己實作變體語意（正規化只有一份）', () => {
  const src = stripComments(read('app.js'));
  // E-arch 的同一條，擴到變體規則。app.js 只能消費 search() 的輸出。
  for (const leak of ['reverse(', 'FLIP', 'CANON', 'canon(', 'flip(']) {
    assert.ok(!src.includes(leak), `E12c: app.js 疑似自行實作變體規則（${leak}）`);
  }
});

test('E12d 人工留檔存在且對應本次規則版本', () => {
  // 逐卡定位、行動版版面這兩件事只有人工留檔證明得了（見本區塊開頭的說明）。
  // 沒有這條的話，留檔漏做也不會有任何東西變紅。
  const p = path.join(ROOT, '.ai-review/evidence/e12-2026-08-14.md');
  assert.ok(fs.existsSync(p), 'E12d: 缺少 E12 人工留檔');
  const doc = fs.readFileSync(p, 'utf8');
  for (const must of ['倒讀', '字形相近', '衛署藥輸字第025901號', '386']) {
    assert.ok(doc.includes(must), `E12d: 留檔未涵蓋「${must}」`);
  }
});
