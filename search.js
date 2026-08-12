/**
 * 藥丸偵探 Pill Detective TW — 搜尋核心（純函式）
 *
 * 規格：`.ai-review/plan.md` v1.2。**動這個檔前先讀 D1.1、D3、D4。**
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
};

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
export function evaluate(item, criteria, tokens) {
  const { color = [], shape = [], score = null, imprint = '', name = '' } = criteria;
  const conds = [];
  let tier = Tier.EXACT;

  if (color.length) conds.push(setCondition(item.color, color));
  if (shape.length) conds.push(setCondition(item.shape, shape));
  if (scoreEnabled(score)) conds.push(setCondition(item.score_mark, [score]));

  const qs = imprintQueryState(imprint);
  if (qs === QueryState.VALID) {
    const r = imprintCondition(tokens ?? recordTokens(item), tokenizeQuery(imprint));
    conds.push(r.state);
    if (r.tier !== null) tier = r.tier;
  }
  // QueryState.OFF 與 NO_TOKEN 皆不套用 imprint 篩選（D3）。
  // 兩者的差別只在 UI 是否顯示提示，不在篩選結果。

  if (String(name ?? '').trim() !== '') conds.push(nameCondition(item, name));

  // 分區優先序（D1.1 ＋ D17）：mismatch > unknown > partial > main。
  //
  // unknown 排在 partial 前面的理由：兩者都是「無法排除」，但 unknown 是
  // 「TFDA 這個欄位根本沒填」，partial 是「填了、只是不完整」。
  // 前者的不確定性更大，歸在更保守的那一區。
  if (conds.includes(Cond.MISMATCH)) return { bucket: 'excluded', tier: null };
  if (conds.includes(Cond.UNKNOWN)) return { bucket: 'unknown', tier: null };
  if (conds.includes(Cond.PARTIAL)) return { bucket: 'partial', tier: null };
  return { bucket: 'main', tier };
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
 * @returns {{ tiers: item[][], unknown: item[], excludedCount: number,
 *             mainCount: number, imprintQueryState: string }}
 *
 * `tiers` 是**三個互斥分區**（完全／字首／包含），不是累計集合。
 * 未輸入 imprint 時全部落在 tiers[0]（等級一律視為 EXACT）。
 *
 * **不回傳分數、不回傳相似度、不回傳排名百分比**（規格 F8）。
 * 唯一的分層是上面三個規則型等級。
 */
export function search(items, criteria = {}) {
  const tiers = [[], [], []];
  const partial = [];
  const unknown = [];
  let excludedCount = 0;

  for (const it of items) {
    const r = evaluate(it, criteria, it._tok);
    if (r.bucket === 'excluded') { excludedCount++; continue; }
    if (r.bucket === 'unknown') { unknown.push(it); continue; }
    if (r.bucket === 'partial') { partial.push(it); continue; }
    tiers[r.tier].push(it);
  }

  for (const t of tiers) t.sort(compareItems);
  partial.sort(compareItems);
  unknown.sort(compareItems);

  return {
    tiers,
    partial,
    unknown,
    excludedCount,
    mainCount: tiers[0].length + tiers[1].length + tiers[2].length,
    imprintQueryState: imprintQueryState(criteria.imprint ?? ''),
  };
}

/**
 * 預先算好每筆的 token 集合，掛在 `_tok` 上。
 *
 * 載入時做一次（6,295 筆是毫秒級），而不是持久化在 JSON 裡（D15）——
 * 衍生欄與 raw 必然漂移，現算保證只有一份。
 */
export function indexItems(items) {
  for (const it of items) it._tok = recordTokens(it);
  return items;
}

// ── UI 狀態（§8.4）──────────────────────────────────────────────────

export const ResultState = {
  NO_TOKEN_NOTICE: 'no_token_notice',   // imprint 有輸入但無有效 token
  EMPTY: 'empty',                       // 主區 0、部分符合 0、未提供區 0
  ONLY_UNCERTAIN: 'only_uncertain',     // 主區 0，但部分符合或未提供區有值 —— **不得說「找不到」**
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
    const uncertain = result.partial.length + result.unknown.length;
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
