/**
 * 藥丸偵探 Pill Detective TW — 搜尋核心（純函式）
 *
 * 規格：`.ai-review/plan.md`（D1.1／D3／D4／D17／D18）
 *      ＋ `.ai-review/plan-imprint-variant.md` v0.3（刻字變體：D30–D37）。
 * **動這個檔前先讀 plan-imprint-variant.md 的 §5 admission contract——那是變體語意的唯一來源。**
 *
 * 這份檔案同時被**建置管線**（Node）與**前端**（瀏覽器）import。
 * 沿用姊妹專案 `TFDA-drug-id-quiz` 的紀律「正規化只有一份」：
 * 兩份實作必然漂移，而漂移的後果是「管線與前端對同一筆藥的 token 不同」。
 *
 * 因此欄位層正規化（splitMulti／normalizeImprintField／toItem）也放在這裡，
 * 而不是放進管線——管線只負責抓檔、守門、寫檔。
 *
 * 零依賴、無副作用、不碰 DOM。
 */

// ── 受控詞彙（D5）───────────────────────────────────────────────────
// 這三個常數是 UI chips 的唯一來源，且必須與 data/vocab.lock.json 集合相等（D6）。
// 順序只影響 chips 呈現，不影響任何搜尋語意。

export const COLORS = [
  '白', '黃', '橘', '紅', '粉', '綠', '藍', '紫', '棕', '灰', '黑', '透明', '藍綠',
];

export const SHAPES = [
  '圓形', '橢圓形', '膠囊', '四邊形', '三角形', '五邊形', '六邊形', '八邊形',
  '水滴形', '雙圓形', '液劑(包含糖漿用粉劑)', '顆粒劑、粉劑或散劑', '其他',
];

export const SCORE_MARKS = ['無', '直線', '十字'];

/** 刻痕的「不限」。UI 的預設值；等同未啟用該條件（D1.1 階段 ①）。 */
export const SCORE_ANY = '不限';

/** 刻痕條件是否啟用。`null`／`''`／`'不限'` 三種寫法都視為未啟用。 */
const scoreEnabled = (v) => v !== null && v !== undefined && v !== '' && v !== SCORE_ANY;

/**
 * 是否已有任何有效搜尋條件。
 *
 * 零條件是資料庫入口狀態，不是「全部藥品都完全符合」。這個判定放在搜尋層，
 * 避免 UI 與搜尋引擎對空白、刻痕「不限」的語意各自解讀。
 */
export function hasActiveCriteria(criteria = {}) {
  const { color = [], shape = [], score = null, imprint = '', name = '' } = criteria;
  return color.length > 0
    || shape.length > 0
    || scoreEnabled(score)
    || String(imprint ?? '').trim() !== ''
    || String(name ?? '').trim() !== '';
}

// ── 欄位層正規化 ────────────────────────────────────────────────────

/** TFDA 的多值分隔符。實測顏色/形狀/刻痕/尺寸/標註/圖檔連結都可能出現。 */
const MULTI_SEP = ';;;';

/**
 * 多值欄位 → 陣列。**刻意不去重、不排序**（規格 §7）。
 *
 * 膠囊的兩截顏色是 `白;;;紅`，而 `白;;;白` 代表兩截同色——
 * 去重會讓這兩者無法區分，排序會丟掉「哪一截是哪個顏色」。
 * 姊妹專案的 `splitMulti` 有去重＋排序，那是因為它只拿來做題目分組，
 * **不要照抄過來**。
 */
export function splitMulti(v) {
  return String(v ?? '')
    .split(MULTI_SEP)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 單一標註欄 → token 陣列（D3，**逐欄**）。
 *
 * 大寫化 → 非 `[A-Z0-9]` 一律視為分隔 → 切 token → 去空。
 *
 * 字面「無」因此自然產生零 token，**不需要特判**——這是刻意的：
 * 特判清單會隨資料變髒而不斷增長，而「中文不是可搜尋的刻字」是一條規則。
 * 實測來源有 9 筆標註欄字面為「無」，其中 3 筆同一記錄的另一欄仍有有效 token，
 * 那 3 筆的 token 必須留著（驗收 A8b）。
 *
 * `;;;` 在此一併被當成分隔符處理（`;` 不是 `[A-Z0-9]`），
 * 因此不會產生黏合 token（驗收 B5）。
 */
export function normalizeImprintField(v) {
  return String(v ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/**
 * 記錄層 token 集合 = 標註一 ∪ 標註二（D3）。
 *
 * 取聯集而非要求同欄全中：使用者看著一顆藥讀出所有看得到的字，
 * 不會知道哪一段屬於 TFDA 的「標註一」。要求同欄全中會製造漏檢。
 */
export function recordTokens(item) {
  return [...new Set([
    ...normalizeImprintField(item.mark1),
    ...normalizeImprintField(item.mark2),
  ])];
}

/** 查詢字串 → token 陣列。與 `normalizeImprintField` 同一套規則（必須同一套）。 */
export function tokenizeQuery(q) {
  return normalizeImprintField(q);
}

// ── 刻字變體：倒讀與字形相近（D32／D33）─────────────────────────────
//
// 這兩個函式是**規格凍結的有限字元表**，不是 fuzzy 比對（D36）。
// 改動任一格都必須走 D13 的四處同步：改規則 → 改 EXPECTED_COUNTS → 重跑 → 改測試。

/**
 * 180° 旋轉後仍是合法字元的映射表（D32，**A 核心表 14 字元**）。
 *
 * 自映射 10 個：`0 1 8 H I N O S X Z`；互映射 2 對：`6↔9`、`M↔W`。
 *
 * **不含 `3↔E`**：鏡像關係只在特定字體成立，而 `E` 是高頻字母，誤放行成本高於收益。
 * **不含 `L↔7`、`2`／`5` 自映射**：`2` 與 `5` 倒讀後更像彼此而非自己，
 * 該情境由 `canon()` 的 `2/Z`、`5/S` 覆蓋；放進倒讀表會讓兩條規則重複觸發同一筆。
 */
const FLIP_TABLE = Object.freeze({
  0: '0', 1: '1', 8: '8', 6: '9', 9: '6',
  H: 'H', I: 'I', N: 'N', O: 'O', S: 'S', X: 'X', Z: 'Z',
  M: 'W', W: 'M',
});

/**
 * token 倒讀（D32）。**只作用於查詢 token**，再與原始記錄 token 比對。
 *
 * 撤回字首級（D34）後「轉查詢」與「轉記錄」因對合而等價，
 * 但**語意不得靠「碰巧等價」成立**——方向寫在這裡，B22 只負責驗證。
 *
 * @returns 倒讀結果；**任一字元不在表中回 `null`**。
 *
 * 回 `null` 而非回原字串是刻意的：若回原字串，「這個 token 沒有倒讀變體」
 * 與「倒讀後恰好等於自己」（如 `69`、`MW`）就無法區分，
 * 而 B20 的對合斷言在那種錯誤實作下**仍然會通過**（驗收 B20 第 2 條）。
 */
export function flip(token) {
  let out = '';
  for (const ch of [...String(token)].reverse()) {
    const mapped = FLIP_TABLE[ch];
    if (mapped === undefined) return null;
    out += mapped;
  }
  return out;
}

/**
 * 字形相近的等價類（D33，**Q 中間 5 類**）。每類第一個字元為代表字。
 *
 * **不用 R 8 類**（再加 `D/Q`、`6/G`、`U/V`、`3/E`）：`D` 是高頻字母，
 * 放大倍率與誤放行同步上升而真實情境增量有限。
 * **不用 P 2 類**（只有 `0/O`、`1/I/L`）：會漏掉 `5/S`——那正是藥師實際最常看錯的一組。
 */
const CANON_CLASSES = Object.freeze([
  Object.freeze(['0', 'O']),
  Object.freeze(['1', 'I', 'L']),
  Object.freeze(['5', 'S']),
  Object.freeze(['2', 'Z']),
  Object.freeze(['8', 'B']),
]);

/**
 * 字形壓平（D33）。**查詢與記錄雙邊都壓平**——這是一個**對稱**的等價關係：
 * 查詢 `0` 能接住記錄 `O`，查詢 `O` 也能接住記錄 `0`。
 *
 * **壓平而不展開變體**：展開是笛卡兒積，`S15` 會生 12 個查詢；
 * 壓平把同一件事變成兩邊各算一次再比一次。
 */
export function canon(token) {
  let out = '';
  for (const ch of String(token)) {
    const cls = CANON_CLASSES.find((c) => c.includes(ch));
    out += cls ? cls[0] : ch;
  }
  return out;
}

/** 記錄層的壓平 token 集合。於 `indexItems()` 一次算好，**不持久化進 JSON**（D15／N19）。 */
export function recordCanonTokens(item) {
  return recordTokens(item).map(canon);
}

/** 名稱比較一律先大寫（D1.1）。中文與許可證字號無大小寫，不受影響。 */
export function normalizeName(s) {
  return String(s ?? '').toUpperCase();
}

/**
 * 官方圖檔 origin 白名單。
 *
 * v0.1 起 `imgs[].src` 會成為詳細頁上一個**使用者可點的外部連結**
 * （「查看 TFDA 官方原圖」），不再只是管線內部用來下載的字串。
 * 來源列若出現別的 origin，那個 origin 就會被我們發布出去。
 *
 * 放在這裡是因為**管線與前端必須用同一條規則**：verify-data 在發布前擋，
 * app.js 在算 href 前再擋一次。兩邊各抄一份必然漂移，而漂移的那一天
 * 會是「驗證放行、前端卻不給連結」或更糟的反過來。
 */
export const IMG_ORIGIN = 'https://mcp.fda.gov.tw';

/** URL 解析失敗或 origin 不符一律回 false（不得回傳原字串當作「大概沒問題」） */
export function isOfficialImgUrl(src) {
  try {
    return new URL(src).origin === IMG_ORIGIN;
  } catch {
    return false;
  }
}

// ── 資料新鮮度的日期運算（D28）──────────────────────────────────────
//
// 與 IMG_ORIGIN 同一條理由放在這裡：**寫入端與判讀端必須用同一套日期定義**。
// `write-status.mjs` 用 taipeiDate 產生 last_checked，app.js 用同一支算「距今幾天」。
// 兩邊各抄一份的話，漂移的那天會是「頁尾說剛檢查過、其實已經兩週沒跑」。

/** 超過這個天數未成功更新即視為過期（＝錯過兩次週更）。 */
export const STALE_DAYS = 14;

/**
 * `Date` → 台北日期字串 `YYYY-MM-DD`。
 *
 * 排程是 UTC `17 20 * * 0`（＝台北週一 04:17）。**直接用 `toISOString()` 會顯示成前一天**。
 * 台灣無日光節約時間，固定 +8 小時即可，不需要 Intl（前端也就不必扛時區資料庫）。
 */
export function taipeiDate(now = new Date()) {
  return new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * `YYYY-MM-DD` 距今幾天（台北日曆日相減）。
 *
 * 格式不符或不是真實存在的日期一律回 `null`——**不可回 0**：
 * 0 會被判讀成「今天剛檢查過」，把壞掉的狀態檔偽裝成最新鮮的狀態。
 * 未來日期回負數，由呼叫端決定怎麼處理（目前視同不過期，但不隱藏）。
 */
export function daysSinceISODate(iso, now = new Date()) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  // Date.parse 會把 2026-02-31 之類不存在的日期視為無效，但不同引擎行為不一致，
  // 因此再做一次 round-trip 檢查（同 dosDateToISO 的理由）
  if (new Date(t).toISOString().slice(0, 10) !== iso) return null;
  const today = Date.parse(`${taipeiDate(now)}T00:00:00Z`);
  return Math.round((today - t) / 86_400_000);
}

/**
 * 頁尾要顯示什麼（D28）。
 *
 * 抽成純函式是因為**這組判斷唯一測得到的方式就是把它抽出來**——
 * 本專案沒有 jsdom（理由見 `tests/ui-smoke.test.mjs` 檔頭），
 * 留在 `renderFreshness` 裡就只能靠原始碼掃描，那擋不住邏輯錯誤。
 *
 * 三條規則，每條都對應一個「顯示了看起來正常、其實是錯的東西」的失效：
 *
 * 1. **版本與筆數一律取自 `meta`，不取 `status`。**
 *    兩個檔各自走 SW 快取，可能出現「`appearance.json` 是新的、`status.json`
 *    退了舊快取」的跨版本組合。`meta` 已通過 D16 契約檢查，且確實就是
 *    畫面上這批結果的來源；`status` 只是旁證。
 * 2. **`source_version` 不符就不顯示 `last_checked`。** 那代表狀態檔在講另一份資料，
 *    把它的檢查日貼到這份上就是憑空捏造的新鮮度。
 * 3. **未來日期（`days < 0`）一律不顯示。** 那代表狀態檔壞了（時鐘或人為），
 *    而 `days > STALE_DAYS` 對負數為 false，會把它顯示成「剛檢查過」——
 *    正是 D28 要避免的「壞掉的狀態檔偽裝成最新鮮」。
 */
export function freshnessView(meta, status, now = new Date()) {
  const sourceVersion = meta?.source_version ?? null;
  const count = Number.isInteger(meta?.count) ? meta.count : null;

  const sameData = status != null && typeof status === 'object' && status.schema === 1
    && (status.source_version ?? null) === sourceVersion;
  const days = sameData ? daysSinceISODate(status.last_checked, now) : null;
  const show = days !== null && days >= 0;

  return {
    sourceVersion,
    count,
    lastChecked: show ? status.last_checked : null,
    days: show ? days : null,
    stale: show && days > STALE_DAYS,
  };
}

/**
 * 許可證字號 → TFDA 官方仿單資料頁。
 *
 * 字號是 URL path segment，不可直接串接：`encodeURIComponent` 避免 `/`、`?`、`#`
 * 等字元改變路徑語意；無效 Unicode 則 fail-closed 回 null。
 */
export function officialLeafletUrl(id) {
  const value = String(id ?? '').trim();
  if (!value) return null;
  try {
    return new URL(`/im_detail_1/${encodeURIComponent(value)}`, IMG_ORIGIN).href;
  } catch {
    return null;
  }
}

/**
 * TFDA 原始列 → canonical item（§7）。
 *
 * 缺值一律 `null` 或空陣列，**不填佔位字串**。
 * 唯一例外是 `mark1`／`mark2` 的字面「無」——那是 TFDA 的原值，
 * 顯示它是誠實的；它不會產生任何搜尋 token（見 normalizeImprintField）。
 *
 * `imgs` 由管線在下載完圖片後補齊（需要 sha256），這裡只放 `src`。
 */
export function toItem(row) {
  const t = (k) => {
    const s = String(row[k] ?? '').trim();
    return s || null;
  };
  return {
    id: String(row['許可證字號'] ?? '').trim(),
    zh: t('中文品名'),
    en: t('英文品名'),
    color: splitMulti(row['顏色']),
    shape: splitMulti(row['形狀']),
    score_mark: splitMulti(row['刻痕']),
    size: splitMulti(row['外觀尺寸']),
    mark1: t('標註一'),
    mark2: t('標註二'),
    imgs: splitMulti(row['外觀圖檔連結']).map((src) => ({ file: null, src, sha256: null })),
  };
}

// ── 三值語意（D1.1）─────────────────────────────────────────────────

export const Cond = {
  MATCH: 'match',
  MISMATCH: 'mismatch',
  UNKNOWN: 'unknown',
  /**
   * 只有 imprint 會產生（D17）。
   *
   * 「至少一個查詢 token 命中、但非全部命中」。
   *
   * 為什麼需要它：TFDA 的標註欄常只記錄部分刻字——實測 **1,293 筆**（有 token 記錄的
   * 30.7%）只有單一 token。純 AND 之下，使用者照著藥錠把字全部讀出來，
   * 反而把這批記錄不完整的藥全部濾掉：**輸入越完整、漏檢越嚴重**。
   * 那與 D1 確立的漏檢優先直接衝突，而缺值有未提供區接住、部分記錄沒有。
   *
   * 「一個都沒中」仍然是 mismatch——使用者讀到的字在那顆藥上完全不存在，
   * 排除它不是漏檢。
   */
  PARTIAL: 'partial',
  /**
   * 只有 imprint 會產生（D30／D31）。
   *
   * 「原樣比對是 MISMATCH，但在倒讀或字形相近的假設下全中」。
   *
   * **這個狀態是由 MISMATCH「置換」而來，不是與它並存**（§5.2）——
   * 若實作成並存，按 `evaluate()` 的優先序 `mismatch > variant`，
   * 記錄仍會被排除：**功能靜默地完全不存在，而所有正例測試看起來都合理**（變異 F13-13）。
   *
   * 為什麼需要它：使用者把藥錠倒著拿（`6` 讀成 `9`）、或把 `S` 讀成 `5`，
   * 目前一律落入 MISMATCH → 完全排除 → 看到「找不到」。
   * 現有四區都接不住：`unknown` 要求欄位沒填、`partial` 要求至少一個 token 原樣命中。
   *
   * 為什麼不混進主區：實測查詢 `SH` 主區 37 筆、倒讀成 `HS` 後另有 42 筆——
   * 混進去等於讓 42 筆猜測與 37 筆事實不可分辨。
   */
  VARIANT: 'variant',
};

/**
 * 變體的觸發理由（D37）。**與記錄身份不可分離**——見 `search()` 的回傳說明。
 *
 * 陣列而非 Set：oracle 要逐筆對帳，需要穩定的序。序固定為 flip 先於 canon。
 */
export const VariantReason = { FLIP: 'flip', CANON: 'canon' };

/**
 * imprint 查詢的三種狀態（D3）。**不得由空集合量詞自行推導。**
 *
 * v1.1 的規格只寫「每個查詢 token 皆命中」，零 token 時量詞在空集合上
 * 真空成立 → 所有有 token 的記錄都會 match，而規格另一處又要求
 * 搜尋「無」不命中任何記錄。兩者不可能同時實作，故明定第三狀態。
 */
export const QueryState = {
  OFF: 'off',            // 輸入框 trim 後為空 → 條件未啟用
  VALID: 'valid',        // 非空且產生 ≥1 token → 正常三值比對
  NO_TOKEN: 'no_token',  // 非空但產生 0 token → 忽略此條件並提示使用者
};

export function imprintQueryState(raw) {
  if (String(raw ?? '').trim() === '') return QueryState.OFF;
  return tokenizeQuery(raw).length > 0 ? QueryState.VALID : QueryState.NO_TOKEN;
}

/**
 * 集合型條件（顏色／形狀／刻痕）的三值判定 —— **只在條件已啟用時呼叫**。
 *
 * 「條件是否啟用」在 `evaluate()` 的階段 ① 就處理掉了，這裡不再判斷 `selected` 是否為空。
 * 把兩件事分開是規格 D1.1 的核心：v1.1 把它們寫在同一張表，
 * 「沒勾任何顏色 ＋ 該筆顏色也是空的」那一格同時符合 match 與 unknown。
 */
export function setCondition(values, selected) {
  if (values.length === 0) return Cond.UNKNOWN;
  return values.some((v) => selected.includes(v)) ? Cond.MATCH : Cond.MISMATCH;
}

/** imprint 的三值判定 ＋ 命中等級。**只在 QueryState.VALID 時呼叫。** */
export const Tier = { EXACT: 0, PREFIX: 1, CONTAINS: 2 };

/**
 * D18：**長度為 1 的查詢 token 不啟用「包含」級。**
 *
 * 實測 `S` 的包含級有 423 筆，內容是 YSP、EVEREST、ASTAR 這類完全不像 S 的刻字——
 * 單字元的「包含」實質上是「這顆藥的刻字裡有這個字母」，
 * 與使用者看到的「藥上只印了一個 S」是兩件事。
 *
 * **這是會漏檢的**：若藥錠真的只看得出一個字母、而 TFDA 記的是長字串，該筆會被排除，
 * 且單 token 查詢沒有 D17 的部分符合態可接住。這是刻意接受的取捨——
 * 包含級 423 筆在藥車前不可用，留著等於用不可用的清單換一個理論上的涵蓋率。
 */
const usesContainsTier = (token) => token.length > 1;

export function imprintCondition(tokens, queryTokens) {
  if (tokens.length === 0) return { state: Cond.UNKNOWN, tier: null };
  let worst = Tier.EXACT;
  let hit = 0;
  for (const q of queryTokens) {
    let best = null;
    for (const t of tokens) {
      if (t === q) { best = Tier.EXACT; break; }        // 不可能更好，直接跳出
      if (t.startsWith(q)) best = Math.min(best ?? Tier.PREFIX, Tier.PREFIX);
      else if (usesContainsTier(q) && t.includes(q)) best = Math.min(best ?? Tier.CONTAINS, Tier.CONTAINS);
    }
    if (best === null) continue;                        // 這個 token 沒中
    hit++;
    worst = Math.max(worst, best);   // 記錄的等級 = 所有查詢 token 中最差的那一級
  }
  if (hit === queryTokens.length) return { state: Cond.MATCH, tier: worst };
  if (hit === 0) return { state: Cond.MISMATCH, tier: null };
  return { state: Cond.PARTIAL, tier: null, hit, total: queryTokens.length };
}

// ── 變體判定（§5.2 admission contract）──────────────────────────────
//
// 兩條 predicate **各自獨立**，每一條都必須**單獨覆蓋全部查詢 token**。
// **不得把不同 token 的不同規則命中拼成一次全中**——那就是 N15 禁止的組合變體，
// 而 v0.1 的規格只寫「變體全中」而未定義全中的單位，等於從後門把它放進來（變異 F13-10）。
//
// 兩條都**只接受 token 完全相等**（D34）：不啟用字首級、不啟用包含級。
// 依據是實測——放行字首級時變體區最壞 801 筆（查詢 `I`），只接受完全相等時最大 111 筆。

/**
 * 倒讀 predicate。**每個**查詢 token 的 `flip()` 都要與某個記錄 token 完全相等。
 *
 * 兩個前置否決：
 * 1. **任一** token 的 `flip()` 為 `null` → 整條 false。不是「略過該 token」——
 *    略過等於讓其餘 token 單獨成立，那是逐 token OR 的變形。
 * 2. **全部** token 都是 fixed point（`flip(q) === q`）→ 整條 false。
 *    倒讀後等於自己不構成「看反了」的證據（如 `69`、`MW`、`OSO`）。
 */
export function flipPredicate(tokens, queryTokens) {
  const flipped = queryTokens.map(flip);
  if (flipped.some((f) => f === null)) return false;
  if (flipped.every((f, i) => f === queryTokens[i])) return false;
  return flipped.every((f) => tokens.includes(f));
}

/**
 * 字形 predicate。**每個**查詢 token 的 `canon()` 都要與某個記錄 token 的 `canon()` 完全相等。
 *
 * 前置否決：**任一**查詢 token 長度為 1 → 整條 false（D33）。
 *
 * 單字元壓平實質上是「這顆藥的刻字第一個字母看起來像 5」，
 * 與 D18 判定不可用的「包含」級同性質。實測若啟用：查 `I` 變體區 801 筆、`5` 768 筆、`L` 643 筆。
 * **單字元的倒讀則保留**——把藥翻過來 `6` 變 `9` 是真實的物理情境，實測只多 10 筆。
 */
export function canonPredicate(canonTokens, queryTokens) {
  if (queryTokens.some((q) => q.length === 1)) return false;
  return queryTokens.map(canon).every((c) => canonTokens.includes(c));
}

/**
 * 兩條 predicate 的合成。**只在 imprint 原樣比對為 MISMATCH 時呼叫**（D31）。
 *
 * @returns 理由陣列（序固定：flip 先於 canon）；兩條皆不成立時回 `null`。
 *          **不回空陣列**——空陣列會被 `if (reasons)` 讀成「有變體」（D37）。
 */
export function variantReasons(tokens, canonTokens, queryTokens) {
  const reasons = [];
  if (flipPredicate(tokens, queryTokens)) reasons.push(VariantReason.FLIP);
  if (canonPredicate(canonTokens, queryTokens)) reasons.push(VariantReason.CANON);
  return reasons.length ? Object.freeze(reasons) : null;
}

/**
 * 名稱條件。**沒有 unknown**：`en` 與 `id` 恆非空，永遠可判定（D1.1）。
 *
 * 因此名稱不命中一律是 mismatch，不會把記錄推進未提供區——
 * 這點與顏色/形狀/刻痕/imprint 不同，是資料性質決定的，不是取捨。
 */
export function nameCondition(item, query) {
  const raw = String(query ?? '').trim();
  const q = normalizeName(raw);
  const hit = normalizeName(item.zh).includes(q)
    || normalizeName(item.en).includes(q)
    || String(item.id ?? '').includes(raw);
  return hit ? Cond.MATCH : Cond.MISMATCH;
}

/**
 * 對單筆記錄求值全部條件，回傳分區歸屬（D1.1）。
 *
 * 階段 ①：條件未啟用 → match，**且不查看記錄的任何值**。
 * 階段 ②：已啟用的條件才判三值。
 *
 * 分區：任一 mismatch → 排除；否則任一 unknown → 未提供區；否則 → 主區。
 */
export function evaluate(item, criteria, tokens, canonTokens) {
  const { color = [], shape = [], score = null, imprint = '', name = '' } = criteria;
  const conds = [];
  let tier = Tier.EXACT;
  let reasons = null;

  if (color.length) conds.push(setCondition(item.color, color));
  if (shape.length) conds.push(setCondition(item.shape, shape));
  if (scoreEnabled(score)) conds.push(setCondition(item.score_mark, [score]));

  const qs = imprintQueryState(imprint);
  if (qs === QueryState.VALID) {
    const recTokens = tokens ?? recordTokens(item);
    const queryTokens = tokenizeQuery(imprint);
    const r = imprintCondition(recTokens, queryTokens);

    // D31：**只有 MISMATCH 才計算變體。** 其餘四種狀態一律照舊，
    // 因此 main／partial／unknown 三區的成員逐筆不變，excluded 只會變少（驗收 A13）。
    //
    // 把 guard 拿掉會讓 PARTIAL／MATCH 的記錄被搶進變體區（變異 F13-1）。
    if (r.state === Cond.MISMATCH) {
      reasons = variantReasons(recTokens, canonTokens ?? recordCanonTokens(item), queryTokens);
    }

    // **置換，不是並存**（§5.2）。若這裡寫成 `conds.push(r.state)` 之後再
    // `if (reasons) conds.push(Cond.VARIANT)`，MISMATCH 仍在陣列裡，
    // 底下的優先序會先命中它 → 記錄照樣被排除 → 功能靜默不存在（變異 F13-13）。
    conds.push(reasons ? Cond.VARIANT : r.state);
    if (r.tier !== null) tier = r.tier;
  }
  // QueryState.OFF 與 NO_TOKEN 皆不套用 imprint 篩選（D3），因此也不計算變體。
  // 兩者的差別只在 UI 是否顯示提示，不在篩選結果。

  if (String(name ?? '').trim() !== '') conds.push(nameCondition(item, name));

  // 分區優先序（D1.1 ＋ D17 ＋ D30）：mismatch > variant > unknown > partial > main。
  //
  // unknown 排在 partial 前面的理由：兩者都是「無法排除」，但 unknown 是
  // 「TFDA 這個欄位根本沒填」，partial 是「填了、只是不完整」。
  // 前者的不確定性更大，歸在更保守的那一區。
  //
  // variant 排在 unknown／partial 之前**不是因為它更確定**，而是因為它只可能由
  // 「原本會被排除」產生，所以擺在哪裡都不會從既有分區搬走任何一筆；擺前面則保證
  // 卡片顯示使用者最需要知道的理由（「你可能看反了」）而不是被「TFDA 沒填顏色」蓋掉。
  // 代價是變體區不完整揭露其他 unknown 原因，這是刻意接受的取捨（D31 第 2 點）。
  //
  // 其他條件的 mismatch 仍然壓過 variant——變體不得繞過條件間的 AND。
  if (conds.includes(Cond.MISMATCH)) return { bucket: 'excluded', tier: null, reasons: null };
  if (conds.includes(Cond.VARIANT)) return { bucket: 'variant', tier: null, reasons };
  if (conds.includes(Cond.UNKNOWN)) return { bucket: 'unknown', tier: null, reasons: null };
  if (conds.includes(Cond.PARTIAL)) return { bucket: 'partial', tier: null, reasons: null };
  return { bucket: 'main', tier, reasons: null };
}

// ── 排序（D4）───────────────────────────────────────────────────────

/**
 * 分區內的穩定次序：中文品名 → 許可證字號。
 *
 * 沒有 tie-breaker 的話，同一等級內的順序會隨來源列順序漂移，
 * 使用者每次重新搜尋看到的卡片位置都不一樣，人工比對會被打斷。
 * 中文品名可能為 null（實測 1 筆），排在後面。
 */
export function compareItems(a, b) {
  const az = a.zh ?? '', bz = b.zh ?? '';
  if (az !== bz) {
    if (az === '') return 1;
    if (bz === '') return -1;
    return az.localeCompare(bz, 'zh-Hant');
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ── 主搜尋 ──────────────────────────────────────────────────────────

/**
 * @param items    canonical items（已由 toItem 產生）
 * @param criteria { color: string[], shape: string[], score: string|null,
 *                   imprint: string, name: string }
 * @returns {{ tiers: item[][], partial: item[], unknown: item[],
 *             variant: {item, reasons: string[]}[], excludedCount: number,
 *             mainCount: number, imprintQueryState: string }}
 *
 * `tiers` 是**三個互斥分區**（完全／字首／包含），不是累計集合。
 * 未輸入 imprint 時全部落在 tiers[0]（等級一律視為 EXACT）。
 *
 * `variant` 的元素是 `{ item, reasons }` 而不是裸 item——**身份與理由不可分離**（D37）。
 * 若拆成 `variant[]` 與另一個 `variantReasons`，兩者的對齊方式（ID 鍵控？陣列位置？）
 * 會由 oracle、搜尋核心與 UI **各自選一種**，排序之後理由就會貼到別張卡片上。
 *
 * `reasons` 是**每次搜尋新產生**的凍結陣列，**絕不寫回 item**。
 * `app.js` 有 120 ms debounce，快速輸入時連續搜尋是常態——理由若掛回 item，
 * 上一個查詢的 stale reason 會顯示在這一個查詢的卡片上（變異 F13-11）。
 *
 * **不回傳分數、不回傳相似度、不回傳排名百分比**（規格 F8）。
 * 唯一的分層是上面三個規則型等級；變體區內沒有任何分層。
 */
export function search(items, criteria = {}) {
  const tiers = [[], [], []];
  const partial = [];
  const unknown = [];
  const variant = [];
  let excludedCount = 0;

  for (const it of items) {
    const r = evaluate(it, criteria, it._tok, it._tokCanon);
    if (r.bucket === 'excluded') { excludedCount++; continue; }
    if (r.bucket === 'variant') { variant.push({ item: it, reasons: r.reasons }); continue; }
    if (r.bucket === 'unknown') { unknown.push(it); continue; }
    if (r.bucket === 'partial') { partial.push(it); continue; }
    tiers[r.tier].push(it);
  }

  for (const t of tiers) t.sort(compareItems);
  partial.sort(compareItems);
  unknown.sort(compareItems);
  variant.sort((a, b) => compareItems(a.item, b.item));

  return {
    tiers,
    partial,
    unknown,
    variant,
    excludedCount,
    mainCount: tiers[0].length + tiers[1].length + tiers[2].length,
    imprintQueryState: imprintQueryState(criteria.imprint ?? ''),
  };
}

/**
 * 預先算好每筆的 token 集合（`_tok`）與壓平集合（`_tokCanon`），掛在 item 上。
 *
 * 載入時做一次（6,295 筆實測 12 ms），而不是持久化在 JSON 裡（D15／N19）——
 * 衍生欄與 raw 必然漂移，現算保證只有一份。
 *
 * **索引階段允許這一次性的記憶體衍生；搜尋階段則不得修改 item。**
 * 兩者的界線就是 D37：`_tok`／`_tokCanon` 只跟資料有關（跨查詢不變），
 * 變體理由只跟這一次查詢有關（跨查詢必須不同），所以理由絕不能掛到這裡來。
 */
export function indexItems(items) {
  for (const it of items) {
    it._tok = recordTokens(it);
    it._tokCanon = it._tok.map(canon);
  }
  return items;
}

// ── UI 狀態（§8.4）──────────────────────────────────────────────────

export const ResultState = {
  NO_TOKEN_NOTICE: 'no_token_notice',   // imprint 有輸入但無有效 token
  EMPTY: 'empty',                       // 主區 0、部分符合 0、未提供區 0、變體區 0
  ONLY_UNCERTAIN: 'only_uncertain',     // 主區 0，但部分符合／未提供／變體區有值 —— **不得說「找不到」**
  NORMAL: 'normal',                     // 1–20
  TOO_MANY_CAN_REFINE: 'too_many_can_refine',
  TOO_MANY_EXHAUSTED: 'too_many_exhausted',
};

/** §8.4 的「所有條件皆已填」**只指四個外觀條件**，不含名稱欄。 */
export function appearanceCriteriaFilled(criteria) {
  const { color = [], shape = [], score = null, imprint = '' } = criteria;
  return color.length > 0
    && shape.length > 0
    && scoreEnabled(score)
    && imprintQueryState(imprint) === QueryState.VALID;
}

/**
 * 由**同一次搜尋輸出**推導 UI 狀態（驗收 A6b 要求，不得硬編文案）。
 *
 * 回傳陣列：可能同時成立（例如零 token 提示 ＋ 候選過多）。
 */
export function resultStates(result, criteria) {
  const states = [];
  if (result.imprintQueryState === QueryState.NO_TOKEN) states.push(ResultState.NO_TOKEN_NOTICE);

  if (result.mainCount === 0) {
    // D35：**變體區必須計入 uncertain。** 漏掉它會讓「主區 0、只有變體區有值」
    // 回 EMPTY → UI 顯示「找不到」，而畫面上明明列著候選——
    // 那是本工具最怕的漏檢以最糟的形式出現（實測查詢 `S15` 正是此情境：主 0／變 1）。
    const uncertain = result.partial.length + result.unknown.length + result.variant.length;
    states.push(uncertain > 0 ? ResultState.ONLY_UNCERTAIN : ResultState.EMPTY);
  } else if (result.mainCount <= 20) {
    states.push(ResultState.NORMAL);
  } else {
    states.push(appearanceCriteriaFilled(criteria)
      ? ResultState.TOO_MANY_EXHAUSTED
      : ResultState.TOO_MANY_CAN_REFINE);
  }
  return states;
}

/**
 * 放寬建議的順序：刻痕 → 形狀 → 顏色（§8.4）。
 *
 * **只回傳建議，不修改 criteria**——規格明文「不得自動修改搜尋條件」。
 * 呼叫端拿到的是一個新物件，原 criteria 不被 mutate（驗收 A10）。
 */
export function relaxSuggestions(criteria) {
  const out = [];
  if (scoreEnabled(criteria.score)) out.push('score');
  if ((criteria.shape ?? []).length) out.push('shape');
  if ((criteria.color ?? []).length) out.push('color');
  return out;
}
