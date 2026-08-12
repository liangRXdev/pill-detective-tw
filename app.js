/**
 * 藥丸偵探 Pill Detective TW — UI 接線。
 *
 * **這個檔案不含任何搜尋邏輯**：三值語意、分區、排序、UI 狀態全部在 `search.js`，
 * 那份同時被建置管線 import（規格 D15「正規化只有一份」）。
 * 在這裡自己判斷「算不算符合」必然與管線漂移。
 */
import {
  COLORS, SHAPES, SCORE_MARKS, SCORE_ANY,
  indexItems, search, resultStates, relaxSuggestions, ResultState,
  isOfficialImgUrl,
} from './search.js';

const DATA_URL = 'data/appearance.json';
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
  $('bar').hidden = false;
  $('panel').hidden = false;
  buildChips();
  render();
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

function card(item) {
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
  b.appendChild(body);
  b.addEventListener('click', () => openDetail(item));
  return b;
}

/** 分區：標題 + 說明 + 卡片格 + 捲動載入 */
function section(title, why, list, soft) {
  if (!list.length) return null;
  const s = el('section', `sect${soft ? ' soft' : ''}`);
  s.appendChild(el('h3', null, `${title}（${list.length}）`));
  if (why) s.appendChild(el('p', 'why', why));
  const grid = el('div', 'grid');
  s.appendChild(grid);

  let shown = 0;
  const more = el('div', 'more');
  const draw = () => {
    const next = list.slice(shown, shown + PAGE);
    grid.append(...next.map(card));
    shown += next.length;
    if (shown >= list.length) { more.replaceChildren(); return; }
    more.replaceChildren(el('span', null, `已顯示 ${shown} / ${list.length}`));
  };
  draw();
  if (shown < list.length) {
    s.appendChild(more);
    // 捲到底才續繪，避免一次 render 上千張卡片（D11）
    const io = new IntersectionObserver((es) => {
      if (es.some((x) => x.isIntersecting)) { draw(); if (shown >= list.length) io.disconnect(); }
    }, { rootMargin: '400px' });
    io.observe(more);
  }
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
  const res = search(items, criteria);
  const states = resultStates(res, criteria);

  $('noToken').hidden = !states.includes(ResultState.NO_TOKEN_NOTICE);

  const uncertain = res.partial.length + res.unknown.length;
  const c = $('count');
  c.replaceChildren();
  c.append('符合條件 ', Object.assign(el('b'), { textContent: String(res.mainCount) }), ' 項');
  if (uncertain) c.appendChild(el('span', 'aux', `（另有 ${uncertain} 項無法排除）`));

  const acts = $('actions');
  acts.replaceChildren();
  const out = $('results');
  out.replaceChildren();

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
    box.appendChild(el('p', 'hint', 'TFDA 未提供該欄位資料，或只記錄了部分刻字。'));
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
  const p = section('部分符合', 'TFDA 只記錄了部分刻字，無法排除', res.partial, true);
  if (p) out.appendChild(p);
  const u = section('資料未提供', 'TFDA 未填該欄位，不代表不符合，無法排除', res.unknown, true);
  if (u) out.appendChild(u);
}

// ── 詳細 ──────────────────────────────────────────────────────────

function openDetail(item) {
  const body = $('dlgBody');
  body.replaceChildren();
  body.appendChild(el('h3', null, item.zh ?? NA));
  body.appendChild(el('p', 'en', item.en ?? NA));

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

  // 標註一／標註二**不得**標成正面／背面：TFDA 未定義兩欄的面向語意（D7）
  const rows = [
    ['許可證字號', item.id],
    ['形狀', fmt(item.shape)],
    ['顏色', fmt(item.color)],
    ['刻痕', fmt(item.score_mark)],
    ['外觀尺寸', fmt(item.size)],
    ['標註一', fmt(item.mark1)],
    ['標註二', fmt(item.mark2)],
  ];
  const tbl = el('table', 'kv');
  for (const [k, v] of rows) {
    const tr = el('tr');
    tr.appendChild(el('th', null, k));
    const td = el('td', v == null ? 'na' : null, v ?? NA);
    tr.appendChild(td);
    tbl.appendChild(tr);
  }
  body.appendChild(tbl);

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
