/**
 * 藥丸偵探 Pill Detective TW — UI 接線。
 *
 * **這個檔案不含任何搜尋邏輯**：三值語意、分區、排序、UI 狀態全部在 `search.js`，
 * 那份同時被建置管線 import（規格 D15「正規化只有一份」）。
 * 在這裡自己判斷「算不算符合」必然與管線漂移。
 */
import {
  COLORS, SHAPES, SCORE_MARKS, SCORE_ANY,
  indexItems, search, resultStates, relaxSuggestions, ResultState, hasActiveCriteria,
  isOfficialImgUrl, officialLeafletUrl,
  freshnessView,
} from './search.js';

const DATA_URL = 'data/appearance.json';
const STATUS_URL = 'data/status.json';
const PAGE = 24;              // 首屏卡片數，其餘捲動載入（D11）
const DEBOUNCE_MS = 120;

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/** 缺值一律顯示這個字串，**不得推論補值**（規格 F5） */
const NA = '資料未提供';
const fmt = (v) => {
  if (Array.isArray(v)) return v.length ? v.join('；') : null;
  const s = String(v ?? '').trim();
  return s || null;
};

const criteria = { color: [], shape: [], score: SCORE_ANY, imprint: '', name: '' };
let items = null;
let imagesComplete = true;
/** SW 通報「這份資料來自快取」。訊息可能早於資料載入完成，故存成狀態而非直接畫 */
let offlineData = false;
let dataVersion = null;

const imagePlaceholder = () => imagesComplete ? '官方暫無可用圖片' : '鏡像圖片建置中';

// ── 資料載入：任何契約違反都 fail-closed（D16）────────────────────

/**
 * 逐筆資料契約檢查。
 *
 * 只檢查 schema 與「items 非空」是不夠的：若 items 非空但個別記錄損壞，
 * 資料仍會進入搜尋並產生**部分結果**——那是最危險的一種，畫面看起來正常。
 */
function contractErrors(payload) {
  if (!payload || typeof payload !== 'object') return '回應不是物件';
  if (payload.meta?.schema !== 1) return `meta.schema 不是 1（${JSON.stringify(payload.meta?.schema)}）`;
  if ('images_complete' in payload.meta && typeof payload.meta.images_complete !== 'boolean') {
    return 'meta.images_complete 不是 boolean';
  }
  if (!Array.isArray(payload.items)) return 'items 不是陣列';
  if (payload.items.length === 0) return 'items 為空';
  const seen = new Set();
  for (const it of payload.items) {
    if (!it || typeof it.id !== 'string' || !it.id) return '有記錄缺 id';
    if (seen.has(it.id)) return `id 重複：${it.id}`;
    seen.add(it.id);
    for (const f of ['color', 'shape', 'score_mark', 'size']) {
      if (!Array.isArray(it[f])) return `${it.id} 的 ${f} 不是陣列`;
    }
    if (!Array.isArray(it.imgs)) return `${it.id} 的 imgs 不是陣列`;
    for (const g of it.imgs) {
      if (!g || typeof g.file !== 'string' || typeof g.src !== 'string') return `${it.id} 的 imgs 結構損壞`;
    }
  }
  return null;
}

function fatal(why) {
  $('fatalWhy').textContent = why;
  $('fatal').hidden = false;
  $('bar').hidden = true;
  $('panel').hidden = true;
  $('results').replaceChildren();
}

async function load() {
  let payload;
  try {
    const res = await fetch(DATA_URL, { cache: 'no-cache' });
    if (!res.ok) return fatal(`資料檔回應 HTTP ${res.status}`);
    payload = await res.json();
  } catch (e) {
    return fatal(`無法讀取資料檔（${e.name}）`);
  }
  const bad = contractErrors(payload);
  if (bad) return fatal(`資料格式不符：${bad}`);

  imagesComplete = payload.meta.images_complete !== false;
  items = indexItems(payload.items);
  dataVersion = payload.meta.source_version ?? null;
  $('bar').hidden = false;
  $('panel').hidden = false;
  buildChips();
  render();
  if (offlineData) renderOfflineBanner();
  // 刻意不 await：頁尾是裝飾性資訊，不得讓它擋住搜尋可用的時間點
  renderFreshness(payload.meta);
}

// ── 離線模式（D29）────────────────────────────────────────────────

/**
 * SW 端出快取資料時**必須看得見**。
 *
 * 沒有 SW 的時候，資料載不到會走 D16 的 fail-closed，畫面明講「這不代表查無此藥」。
 * 有了 SW，同一個情境變成「安靜地端出上次抓到的資料」——搜尋看起來完全正常，
 * 但那份資料可能已經是幾週前的。**這個橫幅就是那個差額。**
 *
 * 監聽必須在 `load()` 之前註冊：SW 的訊息是在資料回應**之前**送出的
 * （`networkFirstData` 會 await 完 notifyClients 才回應），晚註冊就收不到。
 */
function renderOfflineBanner() {
  const host = $('offline');
  host.replaceChildren(document.createTextNode('目前無法連線，顯示的是先前存下的資料'));
  if (dataVersion) {
    host.append(document.createTextNode('（來源版本 '), el('b', null, dataVersion),
      document.createTextNode('）'));
  }
  host.append(document.createTextNode('。恢復連線後重新整理即可取得最新版本。'));
  host.hidden = false;
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type !== 'OFFLINE_MODE') return;
    // **只有搜尋資料退快取才掛橫幅。**
    // status.json 單獨退快取時，畫面上的搜尋結果其實是剛從網路取得的最新資料，
    // 這時說「顯示的是先前存下的資料」是一句關於資料新鮮度的錯誤陳述。
    // 那一格由 freshnessView 的版本對帳處理（不符就不顯示最後檢查日）。
    if (!String(e.data.path ?? '').endsWith('/data/appearance.json')) return;
    offlineData = true;
    // 資料可能還沒載完（訊息先到）。載完後 load() 會補叫一次。
    if (items) renderOfflineBanner();
  });
  // 註冊失敗不影響任何功能：SW 是加值，不是相依
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

// ── 資料新鮮度頁尾（D28）──────────────────────────────────────────

/**
 * 讀 `status.json` 並填頁尾。**與 D16 相反，這裡一律不 fail-closed。**
 *
 * 狀態檔是裝飾性資訊，抓不到不得阻斷搜尋、不得顯示 fatal。
 * **要顯示什麼由 `freshnessView()` 決定**（`search.js`，純函式，可測）——
 * 這裡只負責取檔與畫 DOM，不做任何新鮮度判斷。
 *
 * 危險的方向不是「少顯示」，是「顯示一個過期或壞掉的檢查日期」，
 * 那會讓人相信資料是新的。三條防線都在 `freshnessView` 裡。
 */
async function renderFreshness(meta) {
  let status = null;
  try {
    const res = await fetch(STATUS_URL, { cache: 'no-cache' });
    if (res.ok) status = await res.json();
  } catch {
    // 網路或 JSON 解析失敗都走降級，不上報、不阻斷
  }

  const host = $('freshness');
  const view = freshnessView(meta, status);

  const parts = [];
  if (view.sourceVersion) parts.push(['資料版本：', view.sourceVersion, '（TFDA 來源日期）']);
  if (view.lastChecked) parts.push(['最後檢查：', view.lastChecked, null]);
  if (view.count !== null) parts.push(['收錄：', `${view.count.toLocaleString()} 筆`, null]);

  if (!parts.length) {
    host.hidden = true;
    return;
  }

  host.replaceChildren();
  parts.forEach(([label, value, suffix], i) => {
    if (i) host.append(el('span', 'sep', '·'));
    host.append(document.createTextNode(label), el('b', null, value));
    if (suffix) host.append(document.createTextNode(suffix));
  });

  host.classList.toggle('is-stale', view.stale);
  host.append(el('span', 'cadence', view.stale
    ? `已超過 ${view.days} 天未成功更新，資料可能不是最新的`
    : '每週一自動檢查 TFDA 來源更新'));
  host.hidden = false;
}

// ── 條件面板 ──────────────────────────────────────────────────────

function chip(label, pressed, onClick) {
  const b = el('button', 'chip', label);
  b.type = 'button';
  b.setAttribute('aria-pressed', String(pressed));
  b.addEventListener('click', onClick);
  return b;
}

function buildChips() {
  const multi = (host, values, key) => {
    host.replaceChildren(...values.map((v) => chip(v, criteria[key].includes(v), () => {
      const i = criteria[key].indexOf(v);
      if (i >= 0) criteria[key].splice(i, 1); else criteria[key].push(v);
      buildChips();
      render();
    })));
  };
  // chips 的值直接來自 search.js 的常數，而那組常數由管線的 D6 詞彙鎖守著
  multi($('colorChips'), COLORS, 'color');
  multi($('shapeChips'), SHAPES, 'shape');
  $('scoreChips').replaceChildren(...[SCORE_ANY, ...SCORE_MARKS].map((v) =>
    chip(v, criteria.score === v, () => { criteria.score = v; buildChips(); render(); })));
}

let timer = null;
const onInput = (key) => (e) => {
  criteria[key] = e.target.value;
  clearTimeout(timer);
  timer = setTimeout(render, DEBOUNCE_MS);
};

// ── 卡片 ──────────────────────────────────────────────────────────

/**
 * 圖片 URL 帶內容版本（D10.1）。
 *
 * 檔名固定為 `sha1(id)-n.webp`，TFDA 原地換圖後我方檔案內容變、URL 不變，
 * 已快取的瀏覽器會繼續顯示舊圖——那正是威脅模型的「新資料配舊圖片」。
 */
const imgUrl = (g) => `data/${g.file}${g.sha256 ? `?v=${g.sha256.slice(0, 8)}` : ''}`;

/**
 * 官方原圖連結的 href。
 *
 * href 來自**資料**（`imgs[].src`），不是原始碼裡的常數——E5b 那道原始碼掃描
 * 看不到它。白名單用 `search.js` 的 `isOfficialImgUrl`，與管線發布前的守門同一條規則。
 */
const officialUrl = (src) => (isOfficialImgUrl(src) ? src : null);

function thumb(item, size) {
  const box = el('div', 'thumb');
  if (size) { box.style.width = size; box.style.height = size; }
  const g = item.imgs[0];
  if (!g || !g.sha256) {
    box.appendChild(el('span', 'ph', imagePlaceholder()));
    return box;
  }
  const img = el('img');
  img.loading = 'lazy';
  img.decoding = 'async';
  img.alt = '';                       // 純視覺比對用，品名已在旁邊，避免螢幕閱讀器重複
  // 失敗時換成 placeholder，**不得留下瀏覽器破圖 icon**（F4）
  img.addEventListener('error', () => box.replaceChildren(el('span', 'ph', imagePlaceholder())));
  img.src = imgUrl(g);
  box.appendChild(img);
  return box;
}

/**
 * 變體理由的顯示文字（D37）。**這張表是理由代碼與中文的唯一對應。**
 *
 * 兩個詞必須可分辨——把它們合併成「可能相似」之類的統一文案，
 * 使用者就無法判斷該顆藥是「被拿反了」還是「字看錯了」，
 * 而那兩件事在藥車前要做的下一個動作不同（一個是翻過來看，一個是換角度看）。
 */
const VARIANT_WHY = { flip: '倒讀', canon: '字形相近' };

/**
 * @param item     canonical item
 * @param reasons  變體理由陣列；非變體區傳 null。
 *                 **理由跟著這一次搜尋的結果進來，不是從 item 上讀的**——
 *                 掛在 item 上的話，上一個查詢的理由會顯示在這一個查詢的卡片上（D37）。
 */
function card(item, reasons = null) {
  const b = el('button', 'pill');
  b.type = 'button';
  b.appendChild(thumb(item));
  const body = el('div');
  body.appendChild(el('div', 'zh', item.zh ?? NA));
  if (item.en) body.appendChild(el('div', 'en', item.en));
  const marks = [item.mark1, item.mark2].filter(Boolean);
  body.appendChild(el('div', 'mk', marks.length ? marks.join('　|　') : NA));
  body.appendChild(el('div', 'ap', [fmt(item.color), fmt(item.shape), fmt(item.score_mark)]
    .map((v) => v ?? NA).join('｜')));
  body.appendChild(el('div', 'lic', item.id));
  if (reasons && reasons.length) {
    const why = el('div', 'vwhy');
    for (const r of reasons) why.appendChild(el('span', null, VARIANT_WHY[r] ?? r));
    body.appendChild(why);
  }
  b.appendChild(body);
  b.addEventListener('click', () => openDetail(item));
  return b;
}

/** 變體區的元素是 `{ item, reasons }`，不是裸 item——身份與理由不可分離（D37）。 */
const variantCard = (v) => card(v.item, v.reasons);

/**
 * 分區：標題 + 說明 + 卡片格 + 捲動載入；低確定性分區可延遲展開。
 *
 * `renderCard` 讓變體區共用同一套分頁／捲動載入邏輯而不必複製一份——
 * 複製出來的第二份遲早會跟這份漂移。
 */
function section(title, why, list, soft, collapsed = false, renderCard = card) {
  if (!list.length) return null;
  const s = el(collapsed ? 'details' : 'section',
    `sect${soft ? ' soft' : ''}${collapsed ? ' result-drawer' : ''}`);
  if (collapsed) {
    const summary = el('summary');
    summary.append(el('span', 'drawer-title', title), el('span', 'drawer-count', `${list.length} 項`));
    s.appendChild(summary);
  } else {
    s.appendChild(el('h3', null, `${title}（${list.length}）`));
  }
  if (why) s.appendChild(el('p', 'why', why));
  const grid = el('div', 'grid');
  s.appendChild(grid);

  let shown = 0;
  let initialized = false;
  const more = el('div', 'more');
  const draw = () => {
    const next = list.slice(shown, shown + PAGE);
    grid.append(...next.map((entry) => renderCard(entry)));
    shown += next.length;
    if (shown >= list.length) { more.replaceChildren(); return; }
    more.replaceChildren(el('span', null, `已顯示 ${shown} / ${list.length}`));
  };
  const initialize = () => {
    if (initialized) return;
    initialized = true;
    draw();
    if (shown >= list.length) return;
    s.appendChild(more);
    // 捲到底才續繪，避免一次 render 上千張卡片（D11）
    const io = new IntersectionObserver((es) => {
      if (es.some((x) => x.isIntersecting)) { draw(); if (shown >= list.length) io.disconnect(); }
    }, { rootMargin: '400px' });
    io.observe(more);
  };
  if (collapsed) s.addEventListener('toggle', () => { if (s.open) initialize(); });
  else initialize();
  return s;
}

// ── 主渲染 ────────────────────────────────────────────────────────

const TIER_TITLE = ['完全符合', '字首符合', '包含'];
const TIER_WHY = [
  '輸入的每一段文字都與該藥的刻字完全相同',
  '輸入的每一段文字都是該藥某段刻字的開頭',
  '輸入的每一段文字都出現在該藥的刻字之中',
];

function render() {
  if (!items) return;

  const c = $('count');
  const acts = $('actions');
  const out = $('results');
  c.replaceChildren();
  acts.replaceChildren();
  out.replaceChildren();

  if (!hasActiveCriteria(criteria)) {
    $('noToken').hidden = true;
    c.append('目前收錄 ', Object.assign(el('b'), {
      textContent: items.length.toLocaleString('zh-TW'),
    }), ' 項 TFDA 藥品外觀資料');
    const start = el('section', 'start-state');
    start.appendChild(el('p', 'start-state__eyebrow', '外觀辨識搜尋'));
    start.appendChild(el('p', 'start-state__prompt', '輸入刻字或選擇外觀特徵開始搜尋'));
    out.appendChild(start);
    return;
  }

  const res = search(items, criteria);
  const states = resultStates(res, criteria);

  $('noToken').hidden = !states.includes(ResultState.NO_TOKEN_NOTICE);

  // 與 `resultStates()` 的 uncertain 同一個定義（D35）——變體區必須計入。
  // 漏掉的話，「符合條件 0 項」旁邊不會有任何提示，而下面卻列著一整區候選。
  const uncertain = res.partial.length + res.unknown.length + res.variant.length;
  c.append('符合條件 ', Object.assign(el('b'), { textContent: String(res.mainCount) }), ' 項');
  if (uncertain) c.appendChild(el('span', 'aux', `（另有 ${uncertain} 項無法排除）`));

  if (states.includes(ResultState.EMPTY)) {
    const box = el('section', 'card empty');
    box.appendChild(Object.assign(el('p', 'lead'), { textContent: '找不到符合的藥品' }));
    const order = relaxSuggestions(criteria);
    if (order.length) {
      const zh = { score: '刻痕', shape: '形狀', color: '顏色' };
      box.appendChild(el('p', 'hint',
        `建議依序放寬：${order.map((k) => zh[k]).join(' → ')}。條件不會自動變更，請自行調整。`));
    }
    out.appendChild(box);
  } else if (states.includes(ResultState.ONLY_UNCERTAIN)) {
    // **不得說「找不到」**：這些藥沒有被排除，只是資料不足以確認
    const box = el('section', 'card empty');
    box.appendChild(Object.assign(el('p', 'lead'),
      { textContent: '沒有可以確定符合的藥品，但以下藥品無法排除' }));
    // 說明必須對應**實際存在的那幾區**。查詢 `S15` 是主區 0、只有變體區 1 筆——
    // 講「TFDA 未提供資料或只記錄部分刻字」在那個情境是**一句關於資料的錯誤陳述**。
    const causes = [];
    if (res.unknown.length) causes.push('TFDA 未提供該欄位資料');
    if (res.partial.length) causes.push('TFDA 只記錄了部分刻字');
    if (res.variant.length) causes.push('刻字可能被看反或字形相近');
    box.appendChild(el('p', 'hint', `${causes.join('，或')}。`));
    out.appendChild(box);
  } else if (states.includes(ResultState.TOO_MANY_EXHAUSTED)) {
    acts.appendChild(el('span', 'aux', '已無更多條件可縮小，請以圖片人工比對'));
  } else if (states.includes(ResultState.TOO_MANY_CAN_REFINE)) {
    acts.appendChild(el('span', 'aux', '候選藥品較多，建議加入藥錠文字、顏色或形狀'));
  }

  for (let t = 0; t < 3; t++) {
    const s = section(TIER_TITLE[t], TIER_WHY[t], res.tiers[t]);
    if (s) out.appendChild(s);
  }
  const p = section('部分符合', 'TFDA 只記錄了部分刻字，無法排除', res.partial, true, true);
  if (p) out.appendChild(p);
  const u = section('資料未提供', 'TFDA 未填該欄位，不代表不符合，無法排除', res.unknown, true, true);
  if (u) out.appendChild(u);

  // 變體區排在**最後**（規格 §8）：未提供區至少「這顆藥沒有和你的輸入牴觸」，
  // 變體區是「你的輸入和它牴觸，但如果你看反了就不牴觸」——多疊一層假設。
  const v = section(
    '刻字可能看反或字形相近',
    '這些藥的刻字與你的輸入不同，但在轉向或字形相近的情況下可能是同一顆',
    res.variant, true, true, variantCard,
  );
  if (v) out.appendChild(v);
}

// ── 詳細 ──────────────────────────────────────────────────────────

function openDetail(item) {
  const body = $('dlgBody');
  body.replaceChildren();

  const identity = el('header', 'identity-card__header');
  identity.appendChild(el('p', 'identity-card__eyebrow', '藥品外觀辨識卡'));
  identity.appendChild(el('h3', null, item.zh ?? NA));
  identity.appendChild(el('p', 'en', item.en ?? NA));
  const license = el('p', 'identity-card__license');
  license.append(el('span', null, '許可證字號'), el('strong', null, item.id));
  identity.appendChild(license);
  body.appendChild(identity);

  const shots = el('div', 'shots');
  if (item.imgs.length) {
    for (const g of item.imgs) {
      const shot = el('div', 'shot');
      const box = el('div', 'thumb');
      if (!g.sha256) {
        // 鏡像缺這一張時仍留下官方原圖連結——那是使用者唯一還看得到外觀的路
        box.appendChild(el('span', 'ph', imagePlaceholder()));
      } else {
        const img = el('img');
        img.loading = 'lazy'; img.decoding = 'async'; img.alt = '';
        img.addEventListener('error', () => box.replaceChildren(el('span', 'ph', imagePlaceholder())));
        img.src = imgUrl(g);
        box.appendChild(img);
      }
      shot.appendChild(box);
      const href = officialUrl(g.src);
      if (href) {
        const a = el('a', null, '查看 TFDA 官方原圖');
        a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer';
        shot.appendChild(a);
      }
      shots.appendChild(shot);
    }
  } else {
    const shot = el('div', 'shot');
    const box = el('div', 'thumb');
    box.appendChild(el('span', 'ph', imagePlaceholder()));
    shot.appendChild(box);
    shots.appendChild(shot);
  }
  body.appendChild(shots);

  const profile = el('section', 'identity-card');
  profile.appendChild(el('h4', 'identity-card__title', '外觀特徵'));
  const features = el('dl', 'identity-card__features');
  const rows = [
    ['形狀', fmt(item.shape)],
    ['顏色', fmt(item.color)],
    ['刻痕', fmt(item.score_mark)],
    ['外觀尺寸', fmt(item.size)],
  ];
  for (const [k, v] of rows) {
    const field = el('div', 'identity-card__feature');
    field.appendChild(el('dt', null, k));
    field.appendChild(el('dd', v == null ? 'is-missing' : null, v ?? NA));
    features.appendChild(field);
  }
  profile.appendChild(features);

  // 標註一／標註二**不得**標成正面／背面：TFDA 未定義兩欄的面向語意（D7）
  const marks = el('section', 'identity-card__marks');
  marks.appendChild(el('h4', 'identity-card__title', '刻字紀錄'));
  const mark1 = fmt(item.mark1);
  const mark2 = fmt(item.mark2);
  if (mark1 == null && mark2 == null) {
    marks.appendChild(el('p', 'identity-card__marks-empty', '刻字資料未提供'));
  } else {
    const markList = el('dl', 'identity-card__mark-list');
    for (const [label, value] of [['標註一', mark1], ['標註二', mark2]]) {
      const field = el('div', 'identity-card__mark');
      field.appendChild(el('dt', null, label));
      field.appendChild(el('dd', value == null ? 'is-missing' : null, value ?? NA));
      markList.appendChild(field);
    }
    marks.appendChild(markList);
  }
  profile.appendChild(marks);
  body.appendChild(profile);

  const leafletHref = officialLeafletUrl(item.id);
  if (leafletHref) {
    const official = el('div', 'official-doc');
    const leaflet = el('a', null, '查看 TFDA 仿單');
    leaflet.href = leafletHref;
    leaflet.target = '_blank';
    leaflet.rel = 'noopener noreferrer';
    official.appendChild(leaflet);
    body.appendChild(official);
  }

  const src = el('p', 'src');
  src.append('資料來源：衛生福利部食品藥物管理署 Open Data。');
  const a = el('a', null, '查看官方資料集');
  a.href = 'https://data.fda.gov.tw/opendata/exportDataList.do?method=openData&infoId=42';
  a.target = '_blank'; a.rel = 'noopener';
  src.append(' ', a);
  body.appendChild(src);

  const close = el('button', 'close', '關閉');
  close.type = 'button';
  close.addEventListener('click', () => $('detail').close());
  body.appendChild(close);

  $('detail').showModal();
}

// ── 啟動 ──────────────────────────────────────────────────────────

$('imprint').addEventListener('input', onInput('imprint'));
$('name').addEventListener('input', onInput('name'));
load();
