/**
 * 寫出 `data/status.json`（規格 D28）。
 *
 * **為什麼不放進 `appearance.json`**：那份的 `meta` 刻意不含執行時間，
 * 來源未變時位元組要完全相同才不會每週產生假 diff（見 `fetch-appearance.mjs` §[9/9] 註解）。
 * 「最後檢查時間」本質上**每次執行都會變**，硬塞進去會直接破壞冪等。
 *
 * **這支必須在 `--publish` 之後跑**：它讀的是**已發布**的 `appearance.json`，
 * 而不是 staging。在 rename 之前跑會把「本次還沒發布的版本」寫進對外的狀態檔。
 *
 * 失敗的 run 絕不能推進 `last_checked` —— 顯示一個過期或造假的檢查日期，
 * 比整行不顯示更糟：它會讓人相信資料是新的。因此 workflow 把這步排在
 * 守門、鏡像、verify、npm test、publish **全部通過之後**。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// taipeiDate 與前端共用同一份（search.js）。這裡自己算一次台北日期，
// 就會與 app.js 判讀「距今幾天」的定義漂移。
import { taipeiDate } from '../search.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_PATH = path.join(ROOT, 'data/appearance.json');
const OUT_PATH = path.join(ROOT, 'data/status.json');

class StatusError extends Error {}
const die = (msg) => { throw new StatusError(msg); };

/**
 * 由已發布的 `meta` 產生狀態物件。
 *
 * `source_version` 是**來源端**的資料產生日（ZIP 中央目錄 mtime），
 * `last_checked` 是**我方**成功跑完管線的日期。兩者不同義，前端要分開顯示：
 * 只給前者的話，TFDA 三個月沒更新就會讓站看起來像廢站。
 */
export function buildStatus(meta, now = new Date()) {
  if (!meta || typeof meta !== 'object') die('appearance.json 缺 meta');
  if (meta.schema !== 1) die(`appearance.json 的 meta.schema 不是 1（${JSON.stringify(meta.schema)}）`);
  if (!Number.isInteger(meta.count) || meta.count <= 0) die(`meta.count 不是正整數（${JSON.stringify(meta.count)}）`);
  return {
    schema: 1,
    last_checked: taipeiDate(now),
    // 來源沒給 mtime 時寧可缺欄位，也不要拿 last_checked 頂替
    ...(meta.source_version ? { source_version: meta.source_version } : {}),
    count: meta.count,
  };
}

export function main() {
  if (!fs.existsSync(DATA_PATH)) die('找不到已發布的 data/appearance.json（這支必須在 --publish 之後跑）');
  const payload = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const status = buildStatus(payload.meta);
  const tmp = `${OUT_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(status, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, OUT_PATH);
  console.log(`data/status.json ✓  最後檢查 ${status.last_checked}`
    + `　來源版本 ${status.source_version ?? '（來源未提供）'}　${status.count.toLocaleString()} 筆`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    main();
  } catch (e) {
    console.error(`\n✖ ${e instanceof StatusError ? e.message : e.stack}`);
    process.exit(1);
  }
}
