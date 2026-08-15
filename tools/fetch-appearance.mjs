#!/usr/bin/env node
/**
 * canonical 資料建置管線 — 規格 `.ai-review/plan.md` §6
 *
 *   node tools/fetch-appearance.mjs [--source <本機zip>] [--out data/appearance.json]
 *                                   [--allow-any-delta]
 *                                   [--publish | --publish-metadata-only]
 *
 * **預設寫到 `<out>.staging`，不發布**（D12）。
 * 圖片抓完、verify 通過之後才由 `--publish` 做那一次 rename——
 * 那是「資料就緒切換點」；真正的對外發布快照是 commit。
 *
 * 刻意用 Node 而非 Python：正規化必須與前端共用**同一份** `search.js`（D15）。
 * 兩份實作必然漂移，而漂移的後果是「管線與前端對同一筆藥的 token 不同」。
 *
 * 任一驗證失敗即中止，**已發布的產物完全不動**（全有全無）。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { toItem, splitMulti, COLORS, SHAPES, SCORE_MARKS } from '../search.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_URL = 'https://data.fda.gov.tw/data/opendata/export/42/json';

/** 用於辨識資料檔的必備欄位（依 schema，不依檔名——ZIP 內檔名帶版本號會變） */
const REQUIRED_FIELDS = ['許可證字號', '中文品名', '英文品名', '形狀', '顏色', '刻痕', '標註一', '外觀圖檔連結'];

/** D8：這兩欄實測 100% 空。由全空轉為有值時警告（不中止）。 */
const WATCHED_EMPTY_FIELDS = ['特殊劑型', '特殊氣味'];

const MIN_SOURCE_ROWS = 5000;     // D9 下限守門，與變動幅度守門**彼此獨立**
const MAX_DELTA_RATIO = 0.03;     // D9
const MAX_DELTA_REMOVED = 50;     // D9
const FETCH_TIMEOUT_MS = 120_000; // D9 下載限制
const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

class PipelineError extends Error {}
const die = (msg) => { throw new PipelineError(msg); };

// ── 最小 ZIP 讀取器（不引入 npm 依賴）─────────────────────────────

/**
 * ZIP 中央目錄的 DOS 日期 → `YYYY-MM-DD`，不合法回 `null`。
 *
 * **這是來源端的資料產生日，不是執行時間**——來源實測無 `Last-Modified`、無 `ETag`，
 * 這是唯一穩定的版本欄位，放進 `meta.source_version` 不破壞冪等。
 *
 * range check 擋得掉 m>12／d>31，卻放行曆法上不存在的日（2026-02-31）。
 * **寫假值比缺欄位更糟**，所以用 round-trip 驗：Date.UTC 會把不存在的日進位。
 */
export function dosDateToISO(dateWord) {
  const y = ((dateWord >> 9) & 0x7f) + 1980;
  const m = (dateWord >> 5) & 0x0f;
  const d = dateWord & 0x1f;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

export function readZipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) die('回應不是合法 ZIP：找不到 End of Central Directory（可能是 WAF 錯誤頁或截斷）');

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) die(`ZIP 中央目錄第 ${n} 筆簽章錯誤`);
    const method = buf.readUInt16LE(off + 10);
    const mtime = dosDateToISO(buf.readUInt16LE(off + 14));
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);

    // 本地檔頭的 extra 長度可能與中央目錄不同，必須重讀
    if (buf.readUInt32LE(localOff) !== 0x04034b50) die(`ZIP 本地檔頭簽章錯誤：${name}`);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);

    let content;
    if (method === 0) content = raw;
    else if (method === 8) content = zlib.inflateRawSync(raw);
    else die(`ZIP 使用不支援的壓縮方式 ${method}：${name}`);

    entries.push({ name, content, mtime });
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return entries;
}

/**
 * 依 schema 辨識資料檔。**0 個或 >1 個都中止**。
 *
 * 不可 glob 取第一個：ZIP 內檔名帶版本號（`42_5.json`）會變，
 * 而多個候選時「取第一個」是把選擇權交給壓縮順序。
 */
export function pickDataFile(entries) {
  const candidates = [];
  for (const e of entries) {
    if (!/\.json$/i.test(e.name)) continue;
    let parsed;
    try { parsed = JSON.parse(e.content.toString('utf8')); } catch { continue; }
    if (!Array.isArray(parsed) || parsed.length === 0) continue;
    const keys = Object.keys(parsed[0]);
    if (REQUIRED_FIELDS.every((f) => keys.includes(f))) {
      candidates.push({ name: e.name, rows: parsed, mtime: e.mtime });
    }
  }
  if (candidates.length === 0) die('ZIP 內找不到符合 schema 的資料檔（0 個候選）');
  if (candidates.length > 1) {
    die(`ZIP 內有 ${candidates.length} 個符合 schema 的資料檔（${candidates.map((c) => c.name).join(', ')}），`
      + '無法判定該用哪個，中止');
  }
  return candidates[0];
}

// ── 取得來源 ────────────────────────────────────────────────────────

async function fetchSource(localPath) {
  if (localPath) {
    console.log(`[1/9] 使用本機來源 ${localPath}`);
    return fs.readFileSync(localPath);
  }
  console.log(`[1/9] 下載 ${SOURCE_URL}`);
  // 注意：**不可帶 Origin header**，實測會被回 403（L3）
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(SOURCE_URL, {
      headers: { 'User-Agent': 'pill-detective-tw/1.0 (+https://github.com/liangRXdev)' },
      redirect: 'follow',
      signal: ac.signal,
    });
    if (!res.ok) die(`來源回應 HTTP ${res.status}，中止（已發布資料不變更）`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_RESPONSE_BYTES) {
      die(`來源回應 ${buf.length} bytes 超出上限 ${MAX_RESPONSE_BYTES}，中止`);
    }
    return buf;
  } catch (e) {
    if (e instanceof PipelineError) throw e;
    die(`來源下載失敗（timeout ${FETCH_TIMEOUT_MS}ms／redirect 上限 ${MAX_REDIRECTS}）：${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// ── 守門 ────────────────────────────────────────────────────────────

/** D8：兩個永久空欄位由全空轉為有值時**警告但不中止** */
export function watchEmptyFields(rows) {
  const warnings = [];
  for (const f of WATCHED_EMPTY_FIELDS) {
    if (!(f in rows[0])) continue;
    const nonEmpty = rows.filter((r) => String(r[f] ?? '').trim() !== '');
    if (nonEmpty.length === 0) continue;
    const sample = nonEmpty[0];
    warnings.push(`欄位「${f}」由全空轉為有值：${nonEmpty.length} 筆，`
      + `代表 id ${sample['許可證字號']}，代表值 ${JSON.stringify(String(sample[f]).slice(0, 40))}`);
  }
  return warnings;
}

/** D6：詞彙快照鎖。出現快照外的新值即中止。 */
export function checkVocab(rows, lock) {
  const seen = { color: new Set(), shape: new Set(), score_mark: new Set() };
  for (const r of rows) {
    for (const v of splitMulti(r['顏色'])) seen.color.add(v);
    for (const v of splitMulti(r['形狀'])) seen.shape.add(v);
    for (const v of splitMulti(r['刻痕'])) seen.score_mark.add(v);
  }
  const errs = [];
  for (const key of ['color', 'shape', 'score_mark']) {
    const allowed = new Set(lock[key]);
    const added = [...seen[key]].filter((v) => !allowed.has(v));
    const removed = [...allowed].filter((v) => !seen[key].has(v));
    if (added.length) errs.push(`${key} 出現快照外的新值：${added.map((v) => JSON.stringify(v)).join('、')}`);
    if (removed.length) errs.push(`${key} 快照中的值已從來源消失：${removed.map((v) => JSON.stringify(v)).join('、')}`);
  }
  return { errs, seen: Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, [...v].sort()])) };
}

/** D12.1：資產鍵 = sha1(許可證字號)[:16]。不可由字號去中文或只留數字產生（實測會碰撞）。 */
export const assetKey = (id) => crypto.createHash('sha1').update(id, 'utf8').digest('hex').slice(0, 16);

/**
 * 資產鍵碰撞偵測。抽成純函式並讓 `keyFn` 可注入，是為了能**真的測到碰撞路徑**。
 *
 * 真實的 `assetKey` 是 sha1 的前 64 bits，測試無法在合理時間內構造出碰撞；
 * 若只用真 keyFn，這條守門的失敗路徑永遠跑不到，寫了等於沒寫。
 * 因此測試注入一個刻意會碰撞的 `keyFn`，另外用一條斷言釘死
 * 「main() 傳進來的就是真的 assetKey」。
 */
export function findAssetKeyCollisions(ids, keyFn = assetKey) {
  const owner = new Map();
  const hits = [];
  for (const id of ids) {
    const k = keyFn(id);
    if (owner.has(k)) hits.push([owner.get(k), id, k]);
    else owner.set(k, id);
  }
  return hits;
}

/**
 * D10 的增量判定：沿用前版的 `sha256` 與 `file`。
 *
 * **URL 變了就不沿用**——URL 是 TFDA 換圖時唯一看得見的訊號；
 * 沿用舊雜湊會讓圖片下載器直接跳過，新圖永遠抓不進來。
 */
export function carryHashes(items, prevItems) {
  const prev = new Map((prevItems ?? []).map((p) => [p.id, p]));
  let carried = 0;
  for (const it of items) {
    const p = prev.get(it.id);
    if (!p) continue;
    for (let n = 0; n < it.imgs.length; n++) {
      const old = (p.imgs ?? [])[n];
      if (old && old.src === it.imgs[n].src && isSha256(old.sha256)) {
        it.imgs[n].sha256 = old.sha256;
        it.imgs[n].file = old.file;
        // src_bytes 與 sha256 是同一次下載的產物，必須一起沿用；
        // 只沿用其中一個會讓 D14 的 HEAD 掃描拿 null 去比對而全部誤判為「已變更」
        it.imgs[n].src_bytes = old.src_bytes ?? null;
        carried++;
      }
    }
  }
  return carried;
}

/**
 * `sha256` 的格式判定。**三處共用同一條規則**
 *（這裡、`fetch-images.py`、`verify-data.mjs`）。
 *
 * 只判斷 truthy 的話，損毀或格式漂移的值（截斷、大寫、字串 "undefined"）
 * 一律被當成「已完成」，那一筆可以永久避開一般排程。
 * 沒驗格式的欄位只證明「有東西」，不證明「是雜湊」。
 */
export const isSha256 = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);

/**
 * 建立可先行上線的 metadata-only 快照。
 *
 * 這不是放寬完整圖片發布的守門：所有圖片雜湊都刻意清為 null，並以
 * `meta.images_complete=false` 明確標示狀態。前端因此只顯示 placeholder，
 * 但搜尋欄位與 TFDA 官方原圖連結可先使用。
 */
export function metadataOnlyPayload(staged) {
  if (!staged || typeof staged !== 'object') die('候選版本不是物件');
  if (staged.meta?.schema !== 1) die('候選版本 meta.schema 不是 1');
  if (!Array.isArray(staged.items) || staged.items.length === 0) die('候選版本 items 為空或不是陣列');
  if (staged.meta.count !== staged.items.length) die('候選版本 meta.count 與 items 筆數不符');

  const seen = new Set();
  const items = staged.items.map((it) => {
    if (!it || typeof it.id !== 'string' || !it.id) die('候選版本有記錄缺 id');
    if (seen.has(it.id)) die(`候選版本 id 重複：${it.id}`);
    seen.add(it.id);
    if (!Array.isArray(it.imgs)) die(`${it.id} 的 imgs 不是陣列`);
    const imgs = it.imgs.map((g) => {
      if (!g || typeof g.file !== 'string' || typeof g.src !== 'string') {
        die(`${it.id} 的 imgs 結構損壞`);
      }
      return { file: g.file, src: g.src, sha256: null };
    });
    return { ...it, imgs };
  });

  return {
    ...staged,
    // `images_bytes` 是 **null 而不是 0**：0 曾經同時代表「圖片還沒上」與
    // 「圖片全部就緒但沒重算」兩個相反狀態，C10c 因此在對一個雙義值做斷言。
    // null＝未計，正整數＝實算總量，0 不再是任何合法狀態（由 --publish 的守門擋著）。
    meta: { ...staged.meta, images_bytes: null, images_complete: false },
    items,
  };
}

// ── 主流程 ──────────────────────────────────────────────────────────

/**
 * @param exceptions D14 的永久壞圖例外，鍵為 `id + src`（**逐圖，不逐記錄**）。
 *
 * 例外在**建置時**就把該張圖排除在 `imgs` 之外，因此圖片下載器完全不會看到它們。
 * 多圖記錄的單一壞 URL **不得**連帶遮掉同筆其餘有效圖，
 * 且排除後序號從 0 重編——`imgs[n].file` 的 `n` 是陣列索引，不是來源的原始位置。
 */
export function buildItems(rows, exceptions = []) {
  const exKeys = new Set(exceptions.map((x) => `${x.id} ${x.src}`));
  const items = rows.map(toItem);
  let dropped = 0;
  for (const it of items) {
    const kept = it.imgs.filter((g) => {
      const hit = exKeys.has(`${it.id} ${g.src}`);
      if (hit) dropped++;
      return !hit;
    });
    it.imgs = kept.map((g, n) => ({
      file: `img/${assetKey(it.id)}-${n}.webp`,
      src: g.src,
      sha256: null,       // **轉檔後 WebP** 的雜湊：D12.1 第三條與前端 ?v= cache key 用
      src_bytes: null,    // **原圖** 的 Content-Length：D14 的 HEAD 新鮮度掃描用
    }));
  }
  return { items, dropped };
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const outPath = path.resolve(ROOT, arg('--out') || 'data/appearance.json');
  const stagingPath = `${outPath}.staging`;
  const allowAnyDelta = argv.includes('--allow-any-delta');

  // ── metadata-only hotfix：搜尋資料先就緒，圖片仍維持未完成 ─────────
  if (argv.includes('--publish-metadata-only')) {
    if (!fs.existsSync(stagingPath)) die(`找不到 ${path.relative(ROOT, stagingPath)}，沒有可發布的候選版本`);
    const staged = JSON.parse(fs.readFileSync(stagingPath, 'utf8'));
    const payload = metadataOnlyPayload(staged);
    const tempPath = `${outPath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(payload, null, 1) + '\n', 'utf8');
    fs.renameSync(tempPath, outPath);
    console.log(`✓ 已發布 metadata-only：${path.relative(ROOT, outPath)}（${payload.items.length.toLocaleString()} 筆）`);
    console.log('  圖片尚未完成；前端將顯示 placeholder 與 TFDA 官方原圖連結。');
    return;
  }

  // ── --publish：D12 的資料就緒切換點 ────────────────────────────
  if (argv.includes('--publish')) {
    if (!fs.existsSync(stagingPath)) die(`找不到 ${path.relative(ROOT, stagingPath)}，沒有可發布的候選版本`);
    const staged = JSON.parse(fs.readFileSync(stagingPath, 'utf8'));
    const missing = staged.items.flatMap((it) => it.imgs).filter((g) => !isSha256(g.sha256));
    if (missing.length) die(`還有 ${missing.length} 張圖片未完成，不可切換（先跑 fetch-images）`);
    // `images_complete=true` 配 `images_bytes` 未計，是 2026-08-15 那次週更真的發布出去的組合
    // （fetch-images 在待處理 0 張時早退，跳過重算）。雜湊齊全證明的是每一張都處理過，
    // 證明不了收尾跑完——所以這裡要獨立擋一次，否則修完早退還是只剩約定在守。
    if (!Number.isInteger(staged.meta.images_bytes) || staged.meta.images_bytes <= 0) {
      die(`meta.images_bytes 是 ${JSON.stringify(staged.meta.images_bytes)}，不是正整數；`
        + 'fetch-images 的收尾未跑完，不可切換');
    }
    staged.meta.images_complete = true;
    fs.writeFileSync(stagingPath, JSON.stringify(staged, null, 1) + '\n', 'utf8');
    fs.renameSync(stagingPath, outPath);
    console.log(`✓ 已切換：${path.relative(ROOT, outPath)}（${staged.items.length.toLocaleString()} 筆）`);
    console.log('  注意：這只是資料就緒切換點。對外發布快照是 commit。');
    return;
  }

  const buf = await fetchSource(arg('--source'));
  // 留一份原始 ZIP 供 verify-data 的 provenance 對帳。
  // 沒有它，verify 只能驗檔名格式——而只驗檔名等於沒驗 provenance（D12.1）。
  // 這份是中間產物，不進版控（見 .gitignore）。
  const keep = path.resolve(ROOT, arg('--keep-source') || 'data/source.zip');
  fs.mkdirSync(path.dirname(keep), { recursive: true });
  fs.writeFileSync(keep, buf);

  console.log(`[2/9] 取得 ${buf.length.toLocaleString()} bytes，驗證 ZIP 結構`);
  const entries = readZipEntries(buf);

  console.log(`[3/9] ZIP 內 ${entries.length} 個檔案，依 schema 辨識資料檔`);
  const { name, rows, mtime } = pickDataFile(entries);
  console.log(`      → ${name}（${rows.length.toLocaleString()} 筆）　資料版本 ${mtime ?? '(ZIP 無合法日期)'}`);

  console.log('[4/9] 守門：筆數下限、必要欄位');
  if (rows.length < MIN_SOURCE_ROWS) die(`來源僅 ${rows.length} 筆，低於下限 ${MIN_SOURCE_ROWS}，中止`);
  const missingFields = REQUIRED_FIELDS.filter((f) => !(f in rows[0]));
  if (missingFields.length) die(`來源缺欄位：${missingFields.join(', ')}`);

  console.log('[5/9] 守門：詞彙快照鎖（D6）');
  // `--vocab-lock` 讓測試能注入自己的詞彙快照。沒有它的話，
  // 任何用精簡 fixture 的測試都會被「快照中的值已從來源消失」擋下，
  // C 組就只能測到這一道守門。
  const lockPath = path.resolve(ROOT, arg('--vocab-lock') || 'data/vocab.lock.json');
  const lock = fs.existsSync(lockPath)
    ? JSON.parse(fs.readFileSync(lockPath, 'utf8'))
    : { color: COLORS, shape: SHAPES, score_mark: SCORE_MARKS };
  const { errs: vocabErrs, seen } = checkVocab(rows, lock);
  if (vocabErrs.length) {
    die(`詞彙快照不符（${vocabErrs.length} 項）：\n  - ${vocabErrs.join('\n  - ')}\n`
      + '  新值代表 UI chips 需要同步新增，否則那些藥在條件搜尋中永遠不可見。\n'
      + '  人工確認後更新 data/vocab.lock.json 與 search.js 的常數再重跑。');
  }
  console.log(`      顏色 ${seen.color.length}／形狀 ${seen.shape.length}／刻痕 ${seen.score_mark.length} 種，皆在快照內 ✓`);

  console.log('[6/9] 守門：許可證字號唯一、資產鍵唯一');
  const idCount = new Map();
  for (const r of rows) {
    const id = String(r['許可證字號'] ?? '').trim();
    if (!id) die('來源含空的許可證字號，中止');
    idCount.set(id, (idCount.get(id) ?? 0) + 1);
  }
  const dups = [...idCount.entries()].filter(([, n]) => n > 1);
  if (dups.length) {
    die(`許可證字號重複 ${dups.length} 組：${dups.slice(0, 5).map(([id, n]) => `${id} × ${n}`).join('；')}`);
  }
  const collisions = findAssetKeyCollisions([...idCount.keys()], assetKey);
  if (collisions.length) {
    die(`資產鍵碰撞 ${collisions.length} 組：`
      + collisions.slice(0, 5).map(([a, b, k]) => `${a} 與 ${b} 皆映射到 ${k}`).join('；'));
  }
  console.log(`      ${idCount.size.toLocaleString()} 個唯一 id、資產鍵零碰撞 ✓`);

  console.log('[7/9] 轉為 canonical items');
  const exPath = path.resolve(ROOT, arg('--exceptions') || 'data/image-exceptions.json');
  const exceptions = fs.existsSync(exPath)
    ? (JSON.parse(fs.readFileSync(exPath, 'utf8')).items ?? [])
    : [];
  const { items, dropped } = buildItems(rows, exceptions);
  const imgCount = items.reduce((a, it) => a + it.imgs.length, 0);
  const noImg = items.filter((it) => it.imgs.length === 0).length;
  console.log(`      ${items.length.toLocaleString()} 筆／${imgCount.toLocaleString()} 張圖（${noImg} 筆無官方圖`
    + `${dropped ? `，例外排除 ${dropped} 張` : ''}）`);

  const warnings = watchEmptyFields(rows);
  for (const w of warnings) console.log(`      ⚠ D8 警告：${w}`);

  console.log('[8/9] 比對變動幅度，沿用未變動項目的雜湊');
  /**
   * 前版來源預設是**已發布**的 `appearance.json`（D12）。
   *
   * `--resume <path>` 只給首建用：Actions runner 是短暫的（L10），
   * 首建 6,798 張圖跨多個 batch，中途沒有已發布版本可讀。
   * 沒有這個開關的話，每個 batch 都會因為讀不到前版而把 sha256 全留 null，
   * 於是每一批都重抓全部 —— 首建永遠跑不完。
   */
  const prevPath = path.resolve(ROOT, arg('--resume') || outPath);
  let prev = null;
  if (fs.existsSync(prevPath)) {
    try { prev = JSON.parse(fs.readFileSync(prevPath, 'utf8')); } catch { /* 損毀視同無前版 */ }
    if (prevPath !== outPath) console.log(`      前版取自 ${path.relative(ROOT, prevPath)}（首建續傳）`);
  }
  const carried = carryHashes(items, prev?.items);
  console.log(`      沿用雜湊 ${carried.toLocaleString()} / ${imgCount.toLocaleString()}`
    + `　→ 待抓 ${(imgCount - carried).toLocaleString()}`);
  if (prev?.items) {
    const before = new Set(prev.items.map((i) => i.id));
    const after = new Set(items.map((i) => i.id));
    const removed = [...before].filter((i) => !after.has(i)).length;
    const added = [...after].filter((i) => !before.has(i)).length;
    const ratio = Math.abs(items.length - prev.items.length) / prev.items.length;
    console.log(`      前版 ${prev.items.length} → 本版 ${items.length}`
      + `（新增 ${added}／移除 ${removed}，幅度 ${(ratio * 100).toFixed(2)}%）`);
    if (!allowAnyDelta && (ratio > MAX_DELTA_RATIO || removed > MAX_DELTA_REMOVED)) {
      die(`變動幅度超出門檻（±${MAX_DELTA_RATIO * 100}% 或移除 >${MAX_DELTA_REMOVED} 筆），不發布。`
        + '確認無誤請加 --allow-any-delta');
    }
  } else {
    console.log('      無前版，視為首次建置');
  }

  console.log('[9/9] 寫出 staging（尚未發布）');
  // meta 不含執行時間：否則來源未變仍會產生 diff，破壞冪等
  const payload = {
    meta: {
      schema: 1,
      source: 'TFDA 藥品外觀資料集 (opendata 42)',
      source_file: name,
      ...(mtime ? { source_version: mtime } : {}),
      source_rows: rows.length,
      // **下載回來的 ZIP 原始位元組的 sha256**，與產物格式無關
      content_hash: 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex'),
      count: items.length,
      vocab: seen,
      // 未計。fetch-images 收尾時實算回寫；發布守門要求它到那時必須是正整數。
      images_bytes: null,
      ...(warnings.length ? { warnings } : {}),
    },
    items,
  };
  fs.mkdirSync(path.dirname(stagingPath), { recursive: true });
  const tmp = `${stagingPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 1) + '\n', 'utf8');
  fs.renameSync(tmp, stagingPath);

  if (!fs.existsSync(lockPath)) {
    fs.writeFileSync(lockPath, JSON.stringify(seen, null, 1) + '\n', 'utf8');
    console.log(`      首次建立 ${path.relative(ROOT, lockPath)}（需人工 review）`);
  }

  const kb = (fs.statSync(stagingPath).size / 1024).toFixed(0);
  console.log(`      ${path.relative(ROOT, stagingPath)}  ${items.length.toLocaleString()} 筆  ${kb} KB ✓`);
  console.log('      下一步：fetch-images → verify → npm test → --publish');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((e) => {
    console.error(`\n✖ ${e instanceof PipelineError ? e.message : e.stack}`);
    console.error('  已發布的資料未變更。');
    process.exit(1);
  });
}
