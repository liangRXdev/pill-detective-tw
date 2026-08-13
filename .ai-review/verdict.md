# 覆核判定 — Codex 覆審 D28／D29

- 判定日期：2026-08-13
- 對應報告：`.ai-review/codex-review.md`
- 審查範圍：分支 `feat/pwa-and-data-freshness`（base `f63a1ca`，變更 staged 未 commit）
- 覆核方式：**每項都回讀該檔該行驗證**，不採信 Codex 的描述本身
- 使用者要求：不希望過度工程 → 判定門檻為「**真的會出事**」；
  理論潔癖與範圍蔓延一律降級或拒絕

## 先修正一項事實

Codex 回報「執行 `npm.cmd test` 時 90 條通過、16 條失敗」。
**那 16 條是唯讀 sandbox 不准建 `%TEMP%` 工作目錄與 uv cache 造成的 `EPERM`**，
Codex 自己也已指出不是斷言型失敗。本機實跑為 **106 條全綠**，另有 26 條變異全數轉紅。
不要因為那份報告以為測試是紅的。

---

## 判定表

| # | 項目 | Codex 嚴重度 | 判定 | 理由（含實測引用） |
|---|------|--------|------|------|
| C1 | `app.js`／`search.js` 走 stale-while-revalidate，部署後首次重訪仍執行舊模組 | High | **接受**（嚴重度調為 Medium） | 屬實：`sw.js:105` 的 catch-all 把兩支模組送進 `staleWhileRevalidate()`。且 `sw.js:101` 導覽已是 network-first → 會出現**新 index.html 配舊 app.js 的版本偏移**，那比「延遲一次生效」更糟。嚴重度調為 Medium：影響範圍是單次載入而非永久錯誤。修法**比現況更短**——兩支檔案共 35 KB，直接複用既有的 network-first helper，`staleWhileRevalidate()` 整支可刪 |
| C2 | `cache.put()` 失敗被誤判為網路失敗 | Medium | **接受** | 屬實：`sw.js:127-131` 把 `fetch` 與 `cache.put` 包在同一個 `try`。失效方向正是本專案第二怕的事——**網路明明成功，卻靜默端出舊資料並誤報離線**；無快取時更會誤觸 D16 fatal。同 origin 上有 12 個工具共用配額，`QuotaExceededError` 不是理論值。修法 3 行 |
| C3 | `status.json` 未與已載入的 `meta` 對帳；未來日期被當成新鮮 | Medium | **接受** | 兩個子項都屬實。①`app.js:170,172` 無條件優先用 `status` 的 `source_version`／`count`，兩檔各自快取時會把舊 status 貼到新資料上。②`app.js:192` `days > STALE_DAYS` 對負數為 false → **未來日期顯示成剛檢查過**，正是 D28 自己寫的「顯示一個過期或壞掉的檢查日期比不顯示更糟」。修法：版本與筆數一律以通過 D16 契約的 `meta` 為準；`last_checked` 僅在 `status.source_version === meta.source_version` 且 `days >= 0` 時顯示 |
| C4 | `trimImageCache()` 未受 SW event lifetime 保護 | Medium | **部分接受**（降為 Low） | 屬實：`sw.js:154` 未 await、未進 `waitUntil`，SW 被終止時淘汰可能沒跑完。但後果只是**快取超量**，不影響搜尋正確性、不誤導臨床判斷——不該給 Medium。修法是 1 行（`event.waitUntil(trimImageCache())`），既然要改 `cacheFirstImage` 的簽名就順手做 |
| C5 | workflow 缺 `issues: write`，「失敗時開 issue」必然 403 | Medium | **接受**（既有問題，非本次引入） | 屬實且已驗證：`.github/workflows/update-data.yml:16-17` 只列 `contents: write`，GitHub 的規則是**一旦指定 `permissions:`，未列出的一律為 `none`**。第 91 行的 `issues.create` 因此從未成功過——那個步驟的全部用意就是不讓失敗靜靜地紅在 Actions 頁裡，等於這條安全網一直是斷的。修法 1 行 |
| C6 | `OFFLINE_MODE` 未分辨 `path` | Low `[非必要]` | **部分接受**（提升為值得做） | 屬實：`sw.js:135` 有送 `path`，`app.js:134` 忽略它。只有 status 退快取時，橫幅會對臨床人員宣稱搜尋資料來自快取——**那是一句關於資料新鮮度的錯誤陳述**，方向與本專案第二怕的事一致，不該歸在「非必要」。修法 2 行 |
| T1 | E10 只是原始碼掃描，沒有執行任何 SW 策略 | High | **部分接受** | 前半屬實且我在 `tests/ui-smoke.test.mjs:4` 的檔頭就已聲明靜態掃描不宣稱完備。但**缺的是留檔不是驗證**：E11 六項我已實跑（SW active、cache key 僅 `pill-` 前綴、預抓不含 appearance.json、二次載入後 3,806,984 bytes 進 data cache、圖片保留 `?v=`、關伺服器後重載搜尋仍可用且橫幅可見、注入過期狀態檔驗 is-stale），Codex 看不到是因為我沒寫 evidence 檔。**接受**補 evidence；**拒絕**「用 Node `vm` ＋ 手寫 Cache／fetch event fake 自動化」——那是在零依賴專案裡自建一個 SW 模擬器，屬過度工程，且假樁跑綠不等於瀏覽器跑綠（與 jsdom 同一個坑） |
| T2 | `OFFLINE_MODE` 的 path 語意與時序未測 | Medium | **部分接受** | 隨 C6 的修法加一條靜態斷言（橫幅只在 appearance 的 fallback 時顯示）即可，並在 E11 留檔補「只有 status 失敗」那一格。**不另建情境測試框架** |
| T3 | 把頁尾判定抽成純函式並測 meta/status 組合 | Medium | **接受** | C3 的修法本來就要寫這段判定邏輯。抽成 `search.js` 的 `freshnessView(meta, status, now)` 符合本 repo 既有的 D15 模式（管線與前端共用唯一純函式模組），且是在**沒有 jsdom** 的前提下唯一能測到那組合的方式。淨程式碼量幾乎不變，不算範圍蔓延 |
| T4 | `buildStatus` 的 `main()` 失敗路徑、workflow commit message 分支未測 | Low `[非必要]` | **拒絕** | Codex 自己就寫「本次不建議為此重構固定路徑」。同意：那要為了可測性把硬編路徑改成可注入，是防回歸缺口而非現有錯誤。不做 |
| T5 | 不引入 jsdom 的理由成立 | Low `[非必要]` | **接受（無行動）** | 確認既有決策，無需變更 |
| A1 | `actions/github-script` 仍用可移動的 `@v7` tag | Low `[非必要]` | **部分接受** | 屬實且與 repo 慣例不一致（另三個 action 都 pin 到完整 SHA）。既有問題、非本次引入；既然為 C5 要動同一個 step，順手 pin。**但必須查到正確 SHA 才動**，查不到就維持原樣並記錄 |
| S1 | 規格宣稱圖片上限 500 張，實作無生命週期保證 | Medium | **併入 C4** | 同一件事。附帶確認：這是我自己寫進 `plan.md` D29 與 `CLAUDE.md` 的宣稱，屬「規格宣稱強於實作」 |
| S2 | 規格說危險方向是顯示壞日期，實作未對帳 | Medium | **併入 C3** | 同一件事，且這是本次最典型的一條「規格寫對了、實作弱了」 |
| S3 | E11 六項無留檔 | Medium | **接受** | 屬實：`.ai-review/evidence/` 目前只有 `e1-e3-2026-08-12.md`。E11 是我這次自己寫進 §10 的條款，沒留檔就是規格未達成 |
| S4 | E5 的人工 network／storage 證據無留檔 | Low `[非必要]` | **部分接受** | 屬實但是既有缺口（非本次引入）。與 E11 同一次瀏覽器驗收一起留，不另開工作 |
| S5 | E10 驗的性質比規格弱 | Low `[非必要]` | **部分接受** | 屬實。正確處置是在 §10 明講「上限的**執行期**行為由 E11 補足，E10 只擋原始碼層的移除」，而不是去自動化 Cache API 行為測試 |

**統計：接受 7／部分接受 7／拒絕 1**（S1、S2 併入他項不重複計數）

---

## 必修項（合併前）

按修法成本由低到高：

1. **C5** — workflow 加 `issues: write`（1 行）。既有安全網一直是斷的。
2. **C4** — `trimImageCache()` 進 `event.waitUntil()`（1 行）。
3. **C6** — `OFFLINE_MODE` 依 `path` 分辨，橫幅只在 appearance 退快取時顯示（2 行）。
4. **C2** — `cache.put()` 的錯誤與 `fetch()` 的錯誤分開處理（3 行）。
5. **C1** — `app.js`／`search.js` 改 network-first；`staleWhileRevalidate()` 可整支刪除（淨減行數）。
6. **C3 ＋ T3** — 頁尾判定抽成 `search.js` 的純函式：版本／筆數以 `meta` 為準、
   `last_checked` 需 `source_version` 相符且 `days >= 0`；補 meta/status 組合的單元測試。
7. **S3 ＋ T2 ＋ S4** — 寫 `.ai-review/evidence/e11-2026-08-13.md`，
   把已實跑的六項連同「只有 status 失敗」那一格與 E5 的 network／storage 檢查一起留檔。
8. **S5** — `plan.md` §10 的 E10 補一句：上限的執行期行為由 E11 負責。
9. **A1**（可選）— 查得到 SHA 才 pin `actions/github-script`。

## 不做

- **T4** — `buildStatus` main() 的失敗路徑整合測試（Codex 自己不建議）。
- **T1 的自動化部分** — 手寫 Cache／fetch event fake 模擬 SW。假樁跑綠不等於瀏覽器跑綠。
- 任何引入 Workbox／bundler／npm 依賴的作法（與前提 (a)1 直接衝突，Codex 也未提出）。
