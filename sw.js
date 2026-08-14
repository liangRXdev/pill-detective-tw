/**
 * 藥丸偵探 Pill Detective TW — Service Worker（規格 D29）
 *
 * 範圍是 **A＋B**：app shell 與搜尋資料離線可用，圖片走 runtime 上限快取。
 * 87 MB 的完整離線包（C）刻意不做，見 plan.md §2 N7。
 *
 * ## 這裡最危險的事：離線靜默回舊資料
 *
 * 加 SW 之前，資料載不到會走 D16 的 fail-closed，畫面明講「這不代表查無此藥」。
 * 加 SW 之後，同一個失敗會變成**安靜地端出三個月前的快取**——那比原本更不安全。
 * 因此 `appearance.json`／`status.json` 一律 **network-first**，
 * 退快取時必須 `postMessage('OFFLINE_MODE')`，由前端掛出可見的橫幅。
 * **沒有快取時要讓例外往上拋**，讓 D16 生效；不得回一個看起來成功的空殼。
 *
 * ## Cache Storage 是 origin-wide
 *
 * `liangrxdev.github.io` 上還有十幾個姊妹工具。`activate` 清舊版時
 * **只能刪 `pill-` 前綴**，否則會刪掉別的專案的離線資源
 * （TFDA-drug-recall-dashboard 的 CR-12 已經踩過一次）。
 * SW scope 本身不必擔心：專案頁在 `/pill-detective-tw/` 路徑下，天然受限。
 *
 * ## 圖片的 `?v=` 不可忽略
 *
 * 檔名固定為 `sha1(id)-n.webp`，內容版本靠 query（D10.1）。
 * 用 `ignoreSearch` 比對會讓 TFDA 換圖後永遠命中舊圖 —— **等於廢掉整個機制**。
 * 代價是舊 `?v=` 會留成孤兒，由 `IMG_CACHE_LIMIT` 的淘汰吸收。
 */

// v2（2026-08-14）：新增第五結果分區「刻字可能看反或字形相近」（D30–D37）。
// **改版必須升版號**——shell 走 network-first，但圖片與資料快取要換掉舊 key，
// 否則使用者會拿到舊的離線資源。
const VERSION = 'v2';

/** 只管理本專案自己的 cache（見檔頭「Cache Storage 是 origin-wide」） */
const CACHE_PREFIX = 'pill-';
const SHELL_CACHE = `${CACHE_PREFIX}shell-${VERSION}`;
const DATA_CACHE = `${CACHE_PREFIX}data-${VERSION}`;
const IMG_CACHE = `${CACHE_PREFIX}img-${VERSION}`;
const ALL_CACHES = [SHELL_CACHE, DATA_CACHE, IMG_CACHE];

/**
 * install 時預抓的清單。**不含 `data/appearance.json`（3.7 MB）**：
 * 那會讓一個只是點進來看一眼的人先付 3.7 MB。
 * 它改由 app.js 自己那次載入順帶進 cache——反正一定會抓，等於零額外流量。
 */
const SHELL = [
  './',
  'index.html',
  'app.js',
  'search.js',
  'icon.svg',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];

/** 走 network-first 的資料檔（比對 pathname 結尾，不比對 query） */
const DATA_PATHS = ['/data/appearance.json', '/data/status.json'];

/**
 * 圖片快取張數上限。中位 11.2 KB、p95 28 KB，500 張約 6–8 MB。
 * 全量是 6,798 張／87 MB，**刻意不全存**。
 */
const IMG_CACHE_LIMIT = 500;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith(CACHE_PREFIX) && !ALL_CACHES.includes(k))
          .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // 跨源一律不攔截。本站執行期沒有任何跨源請求（§9／F11），
  // 詳細頁的 TFDA 連結是 <a href>，由瀏覽器直接開。
  if (url.origin !== self.location.origin) return;

  if (DATA_PATHS.some((p) => url.pathname.endsWith(p))) {
    event.respondWith(networkFirstData(req));
    return;
  }
  if (url.pathname.includes('/data/img/')) {
    event.respondWith(cacheFirstImage(req, event));
    return;
  }
  // 其餘同源資源（導覽、app.js／search.js、圖示、manifest）一律 network-first。
  //
  // **不可用 stale-while-revalidate。** SWR 會在部署後的首次重訪先端出舊模組，
  // 背景更新只讓「下一次」變新。而導覽本來就是 network-first，於是會出現
  // **新的 index.html 配舊的 app.js**——版本偏移比延遲生效更糟。
  // 若那次部署修的是漏檢規則，該次臨床搜尋仍會靜默套用舊規則且毫無提示。
  // 兩支模組合計 35 KB，網路優先的代價遠低於這個風險。
  event.respondWith(networkFirstShell(req));
});

function notifyClients(message) {
  return self.clients.matchAll({ includeUncontrolled: true })
    .then((clients) => clients.forEach((c) => c.postMessage(message)));
}

/**
 * 寫快取是 best-effort，**它的失敗不得被當成網路失敗**。
 *
 * `cache.put()` 會在配額用盡（同 origin 還有十幾個姊妹工具共用）或 Cache Storage
 * 損壞時拋例外。若它和 `fetch()` 共用一個 `try`，這個例外會走進離線分支——
 * **網路明明成功拿到最新資料，畫面卻靜默端出舊快取並誤報離線**；沒有快取時
 * 還會誤觸 D16 的 fatal。那正是加 SW 最該避免的失效方向。
 */
async function putSafe(cache, key, res) {
  try {
    await cache.put(key, res);
  } catch {
    // 存不進去就算了，呼叫端照樣回傳剛拿到的網路回應
  }
}

/**
 * 資料檔：network-first，離線才退快取並示警。
 *
 * cache key 去掉 query：app.js 目前用 `cache: 'no-cache'` 而非加時間戳，
 * 但日後任何人加了 `?t=` 都會讓快取永遠 miss，離線就整個失效。
 *
 * 非 2xx（例如部署壞掉回 404）**照原樣回傳、不退快取**：
 * 那代表站台有問題，靜靜端出舊資料只會讓問題更難被發現，
 * 交給 app.js 的 D16 顯示「資料暫時無法載入」。
 */
async function networkFirstData(req) {
  const url = new URL(req.url);
  const key = new Request(url.origin + url.pathname);
  const cache = await caches.open(DATA_CACHE);

  // `fetch` 單獨包一個 try：**只有網路失敗才可以走進退快取分支**。
  // 把 cache.put 也包進來的話，配額爆掉會偽裝成離線（見 putSafe）。
  let res;
  try {
    res = await fetch(req);
  } catch (err) {
    const cached = await cache.match(key);
    if (cached) {
      // await：確保橫幅的訊息在回應之前送達，否則畫面會先出現資料才出現警示
      await notifyClients({ type: 'OFFLINE_MODE', path: url.pathname });
      return cached;
    }
    // 沒有快取就讓它失敗，D16 的 fail-closed 才會生效。
    // **不得**回傳空 items 或 200 空殼——那會被讀成「查無此藥」。
    throw err;
  }

  if (res.ok) await putSafe(cache, key, res.clone());
  return res;
}

/** 圖片：cache-first（內容版本已在 `?v=` 裡，命中即等於內容正確） */
async function cacheFirstImage(req, event) {
  const cache = await caches.open(IMG_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;

  const res = await fetch(req);
  if (res.ok) {
    await putSafe(cache, req, res.clone());
    // **必須掛在 event 上。** SW 隨時可能在回應送出後被瀏覽器終止；
    // 一個沒人等的 Promise 只是「有機會跑完」，那樣 IMG_CACHE_LIMIT
    // 就不是上限而是願望。不 await 是為了不拖慢這張圖的顯示。
    event.waitUntil(trimImageCache());
  }
  return res;
}

/**
 * 把圖片快取修剪到上限以下。
 *
 * **這是 FIFO 不是 LRU**——Cache API 沒有存取時間，`keys()` 只給插入順序。
 * 上限的目的是「不無限長大」，那 FIFO 就夠；別在別處把它講成 LRU。
 */
async function trimImageCache() {
  const cache = await caches.open(IMG_CACHE);
  const keys = await cache.keys();
  const excess = keys.length - IMG_CACHE_LIMIT;
  for (let i = 0; i < excess; i++) await cache.delete(keys[i]);
}

/**
 * shell（導覽 ＋ 模組 ＋ 圖示 ＋ manifest）：network-first，離線才退快取。
 *
 * 導覽失敗時額外退到 `index.html`／`./`，讓深連結與重整在離線時仍開得起來。
 */
async function networkFirstShell(req) {
  const cache = await caches.open(SHELL_CACHE);

  let res;
  try {
    res = await fetch(req);
  } catch (err) {
    const cached = await cache.match(req)
      || (req.mode === 'navigate'
        ? (await cache.match('index.html')) || (await cache.match('./'))
        : null);
    if (cached) return cached;
    // 無快取就讓它失敗。回 undefined 會變成 respondWith(undefined) 的 TypeError，
    // 錯誤訊息還會指向 SW 而不是「沒網路」。
    throw err;
  }

  if (res.ok) await putSafe(cache, req, res.clone());
  return res;
}
