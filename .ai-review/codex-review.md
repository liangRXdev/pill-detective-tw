# Codex 獨立覆審報告 — D28 資料更新時間 ＋ D29 PWA（A＋B）

- 審查日期：2026-08-13
- 覆審員：Codex（`mcp__codex__codex`，`sandbox: read-only`、`approval-policy: never`）
- 審查範圍：分支 `feat/pwa-and-data-freshness`（變更已 staged 未 commit，以 `git diff --cached` 為準）
- Base commit：`f63a1ca77e82ad9ffca9032d1a6c260e6fce18fc`
- 規格版本：`.ai-review/plan.md` v1.10
- 使用者對本次覆審的要求：**不希望過度工程**，以「真的會出事」為嚴重度門檻

> 以下為 Codex 原始輸出，**未經修飾或刪改**。判定見 `.ai-review/verdict.md`。

---

## 區塊 1 — Code review

1. `sw.js:105 / High / app.js 與 search.js 使用 stale-while-revalidate，會在程式更新後先執行舊搜尋邏輯。`
   `SHELL` 預先快取兩檔，但一般資源一律走 `staleWhileRevalidate()`。只更新 `app.js`／`search.js` 而 `sw.js` 未變時，既有使用者首次重訪會直接取得舊模組，背景更新只能讓「下一次載入」變新。若部署內容是修正漏檢，該次臨床搜尋仍會靜默執行舊規則，沒有離線或舊版本警示。
   建議修法：把 `app.js`、`search.js` 改為 network-first、失敗才退快取；這是零依賴、零建置的相容作法。手動要求每次同步遞增 `VERSION` 也可行，但容易漏改，不如 network-first 穩定。

2. `sw.js:129 / Medium / Cache API 寫入失敗會被誤當成網路失敗。`
   `fetch(req)` 與 `cache.put()` 位於同一個 `try`。quota、Cache Storage 損壞或寫入拒絕時，即使網路已成功取得最新資料，程式仍進入 `catch`：有舊快取便回舊資料並誤報離線；沒有快取便觸發 D16 fatal。相同問題也存在於 `networkFirstPage()` 第 177 行及 `staleWhileRevalidate()` 第 194 行。
   建議修法：只讓 `fetch()` 的例外進入離線 fallback；`cache.put()` 另外以 best-effort `try/catch` 處理，寫快取失敗時仍回傳剛取得的網路 response。

3. `app.js:170 / Medium / status.json 未與實際載入的 appearance.json 驗證一致，可能顯示錯誤版本、筆數與檢查日。`
   前端無條件優先使用 status 的 `source_version`、`count`、`last_checked`。若 `appearance.json` 成功取得新版，但 `status.json` 因單次網路失敗退回舊快取，頁尾會把舊 status 當成新版資料的狀態；C14c 只能驗 repo 內靜態檔案，無法阻止瀏覽器中的跨版本快取組合。另 `daysSinceISODate()` 明確允許未來日期，呼叫端卻將負數視為正常、不過期，會把錯誤的未來檢查日顯示成新鮮。
   建議修法：版本與筆數永遠以已通過 D16 contract 的 `meta` 為準；只有當 status 的 `source_version`、`count` 與 meta 一致，且 `days &gt;= 0` 時才顯示 `last_checked`。不一致時退回 D28 的 meta-only 降級。

4. `sw.js:154 / Medium / 圖片「上限 500 張」實際上沒有生命週期保證。`
   `trimImageCache()` 未 await，也未交給 `event.waitUntil()`；response 回傳後 SW 可被瀏覽器終止，淘汰工作可能未完成。測試只確認程式碼中存在上限與刪除迴圈，無法證明上限真的成立。
   建議修法：將淘汰 Promise 納入 fetch event 的生命週期。若選擇直接 await，會增加少量圖片回應延遲；較合適的是在 fetch handler 建立受 `event.waitUntil()` 管理的維護工作。無須引入 Workbox 或任何依賴。

5. `.github/workflows/update-data.yml:16 / Medium / 失敗通知必然沒有建立 issue 的權限。`
   workflow 明確設定 `permissions: contents: write`，未列出的權限會變成 `none`；第 91 行的 `issues.create` 需要 `issues: write`。因此週更失敗時，最後的通知步驟會再得到 403，與第 84 行「失敗時開 issue」的承諾不符。
   建議修法：加入 `issues: write`。若不願擴權，則刪除開 issue 的宣稱，改用 GitHub Actions 原生失敗通知；前者較符合現有設計。

6. `app.js:134 / Low / [非必要] OFFLINE_MODE 未檢查 path，status.json 單獨退快取也會宣稱搜尋資料來自快取。`
   SW 已傳入 `path`，但前端忽略。若只有 status 請求失敗，橫幅仍顯示「顯示的是先前存下的資料」，並附上實際為線上取得的 appearance 版本，語意錯誤。
   建議修法：區分 appearance 與 status 的離線狀態；只有 appearance fallback 才顯示目前橫幅，status fallback 則由頁尾一致性檢查處理。

### Workflow 與日期函式結論

- `DATA_CHANGED` 的判定順序正確：先 stage `appearance.json`／`data/img`，再產生 status，因此週檢 commit 與資料更新 commit 的分類目前成立。
- `write-status.mjs` 確實位於 publish 及所有守門之後；失敗 run 不會推進 `last_checked`。
- `taipeiDate()` 的固定 UTC+8 適用台灣，跨日、跨月、跨年邏輯正確。
- `daysSinceISODate()` 對格式與不存在日期的 round-trip 驗證正確；主要缺口是呼叫端未處理負數日期。

## 區塊 2 — Test gap analysis

1. `tests/ui-smoke.test.mjs:325 / High / E10 只是原始碼正規表示式掃描，沒有執行任何 SW 快取策略。`
   因此「app/search 先回舊快取」「cache.put 失敗被當成網路失敗」「未受生命週期保護的淘汰」全部可在 106 條測試全綠時存在。
   建議修法：優先完成 E11 真實瀏覽器驗收，並加入「部署新版 app/search 後第一次重載即取得新版」案例。若要自動化，可用 Node 內建 `vm` 加手寫 Cache/fetch event fake；不需要 jsdom 或 npm 套件。

2. `tests/ui-smoke.test.mjs:370 / Medium / OFFLINE_MODE 測試只驗監聽文字位置，未涵蓋訊息時序與 path 語意。`
   未測 appearance 成功＋status fallback、appearance fallback＋status 成功、多分頁收到其他請求通知等情境。
   建議修法：這些不是幾何斷言，適合以 E11 人工 browser network failure 注入驗證；至少留下不同 path 的畫面與 Network/Cache Storage 證據。

3. `tests/pipeline.test.mjs:645 / Medium / C14c 只驗 repo 內兩個檔案一致，沒有覆蓋瀏覽器跨版本快取組合。`
   它無法驗出前端將新版 appearance 與舊 status 混合顯示的問題。
   建議修法：增加純資料模型測試，輸入 meta/status 組合，覆蓋一致、不一致、status 缺欄位、未來日期及過期日期。可將頁尾判定抽成 `search.js` 純函式，仍符合 D15 的唯一語意模組限制。

4. `tests/pipeline.test.mjs:608 / Low / [非必要] buildStatus 測了純函式，但未測 main 的讀檔失敗、JSON 損壞、rename 失敗及 workflow commit message 分支。`
   目前實作順序正確，這是防回歸缺口而非現有功能錯誤。
   建議修法：若未來再修改 workflow，再補零依賴的 temporary-workspace 整合測試；本次不建議為此重構固定路徑。

5. `tests/ui-smoke.test.mjs:4 / Low / [非必要] 不引入 jsdom 的理由成立。`
   現有假樁沒有 layout engine，新增 `getComputedStyle`／幾何斷言確實只會產生假綠。
   建議修法：不建議加入 jsdom；版面、touch target、離線橫幅可見性繼續以真實瀏覽器留檔。純日期、狀態一致性及 SW Cache API 行為則不依賴 DOM，可另外測試。

### 本次覆審的測試執行情況

執行 `npm.cmd test` 時，90 條通過；16 條因唯讀 sandbox 禁止建立 `%TEMP%` 測試目錄及 uv cache 而失敗，錯誤均為 `EPERM`／uv cache 初始化，未觀察到斷言型功能失敗。故我無法在此環境獨立重現「106 條全綠」，但失敗原因不是本次程式邏輯。

## 區塊 3 — Dependency audit

- `package.json` 仍無 `dependencies`／`devDependencies`，也沒有 npm lockfile。
- 新增 JS 僅使用 Node built-ins、既有 `search.js` 與瀏覽器原生 API。
- 未引入 bundler、transpiler、Workbox、CDN 或第三方 origin。
- `actions/checkout`、`actions/setup-node`、`astral-sh/setup-uv` 均以完整 commit SHA pin。

`.github/workflows/update-data.yml:87 / Low / [非必要] actions/github-script 仍使用可移動的 @v7 tag，未 pin SHA。`
建議修法：改為已核准的完整 commit SHA。這不需要新增工具鏈；但它是既有問題，沒有證據顯示目前 tag 已遭污染，因此不提高嚴重度。

## 區塊 4 — 規格符合度稽核

### 不符合或做弱

1. `.ai-review/plan.md:886（D29、E10）＋ sw.js:154 / Medium / 規格宣稱圖片 runtime 快取「上限 500 張」，實作只有可能被中止的背景 Promise。`
   建議修法：把 trim 納入 fetch event lifetime，並以真實 Cache Storage 驗證第 501 張會觸發淘汰。

2. `.ai-review/plan.md:867（D28）＋ app.js:170 / Medium / 規格宣稱危險方向是顯示過期或壞掉日期，但實作未驗 status 與 appearance 一致，且將未來日期當成正常新鮮資料。`
   建議修法：以 appearance meta 為版本／筆數真值；status 不一致或日期在未來時，不顯示 `last_checked`。

3. `.ai-review/plan.md:760（E11）＋ tests/ui-smoke.test.mjs:325 / Medium / 規格要求六項真實瀏覽器證據，repo 目前只有 `.ai-review/evidence/e1-e3-2026-08-12.md`，沒有 E11 留檔。`
   靜態 E10/E10b 不能替代 SW active、實際 Cache Storage、關閉伺服器重載及 stale UI 驗證。
   建議修法：合併前完成 E11 六項並留下截圖或可回鏈的實測輸出；不建議用假 DOM 代替。

4. `.ai-review/plan.md:753（E5）＋ .ai-review/evidence/e1-e3-2026-08-12.md:1 / Low / [非必要] E5 明列人工 network/storage 證據為主要依據，但目前沒有對應留檔。`
   建議修法：可與 E11 同一次瀏覽器驗收完成，不需新增自動化框架。

5. `.ai-review/plan.md:758（E10）＋ tests/ui-smoke.test.mjs:359 / Low / [非必要] 驗收只確認「有上限常數與淘汰字串」，驗證的是比規格更弱的性質。`
   實作存在刪除程式碼不等於瀏覽器會讓它跑完。
   建議修法：把 E10 自動條件改成可執行的 Cache API 行為測試，或明確將此項納入 E11。

### 已符合，未發現缺口

- N7：僅做 A＋B；沒有預抓 87 MB 完整圖片包。
- E7：status 失敗不進 fatal，降級至 meta，再至 hidden。
- E8：共用 `STALE_DAYS`，壞格式日期不輸出。
- E9：manifest scope/start URL 正確；PNG 實際為 192×192、512×512、512×512 maskable、180×180 apple-touch。
- E10：只刪 `pill-` 前綴、不使用 `ignoreSearch`、資料 network-first、無快取時會 throw、跨源不攔截。
- E10b：監聽位置早於 `load()`，且保存早到的離線狀態。
- §11：本次新增及修改檔案與清單一致。
- D28：status 與 appearance 分檔，沒有破壞 appearance 位元組冪等。
- Workflow 的 `DATA_CHANGED` 與兩種 commit message 目前對應正確。

## 總評

**目前不建議直接合併。**

最少必須先修：

1. `app.js`／`search.js` 不得以 stale-while-revalidate 靜默執行舊搜尋邏輯。
2. 隔離 `fetch()` 與 `cache.put()` 的錯誤處理。
3. 驗證 status 與 appearance 的版本／筆數一致性，拒絕未來檢查日。
4. 讓圖片淘汰工作受 SW event lifetime 保護。
5. 補上 workflow 的 `issues: write`，並完成 E11 真實瀏覽器驗收留檔。
