# CLAUDE.md — 藥丸偵探 Pill Detective TW

規格在 `.ai-review/plan.md`（**v1.11，動任何東西前先讀 §5 的 D1.1／D3／D12／D14／D17／D18**）。
兩輪 Codex 覆審報告與判定在同目錄，數字爭議先查 `plan-verdict.md` 的事實查核段。

底下只記「從 code 看不出來、但改錯會出事」的部分。

## 這個工具最怕的事：漏檢

使用者以為「清單裡沒有 → 這顆不是那個藥」，但真正的藥被系統靜默排除了。
所有取捨都往這個方向倒：

- **缺值不排除**（D1）：TFDA 沒填顏色的 217 筆，在勾「白色」時進「未提供區」而非消失
- **部分符合不排除**（D17）：TFDA 只記部分刻字的 1,293 筆，在使用者輸入完整刻字時進第四區
- **例外**：D18 的單字元不啟用「包含」級**是刻意接受的漏檢**——包含級 423 筆在藥車前不可用

「主區 0 筆」**不等於**「找不到」。只有每一筆都至少有一個 mismatch 時才是 EMPTY，
而外觀條件永遠可能是 unknown，所以**光靠外觀條件湊不出 EMPTY**——
真正的 EMPTY 只可能由名稱條件產生（名稱恆可判定）。這條由 A10b／A10c 守著。

## 驗收數字綁定凍結 baseline，不得改常數讓測試變綠

`tests/baseline-2026-08-12.json` 的 sha256 寫在 `plan.md` 開頭，
竄改快照必須同時改規格文件。expected ID sets 由 `tools/make-expected.mjs` 產生，
**那支腳本零 import `search.js`**，且它的 `EXPECTED_COUNTS` 自檢會擋下不預期的變動。

規則有意變更時（例如 D17／D18），流程是：改規則 → 改 `EXPECTED_COUNTS` →
重跑 `npm run expected` → 同步 `plan.md` §10 → 改測試。**四個地方都要動，缺一就是漂移。**

**測試碼不得有任何回寫 expected 的路徑**（含 `--update-snapshot` 之類的旗標）。

## 加新的 D／C／E 編號前，先去查哪些已經被用掉

`plan.md` 的決策（D）與驗收（C／E）編號**不連續、也不集中**：
D 散在 §5 與 §14 的修訂紀錄，C／E 在 §10 的表格裡。

2026-08-13 那次連錯兩輪：先把新決策編成 D26／D27（已被 v1.9 的零條件入口狀態與外觀辨識卡佔用），
改成 D28／D29 之後，又把新驗收編成 C15／C16（已被季度新鮮度與部分符合區佔用），
最後才改成 C18／C19。**兩次都是憑印象假設號碼是空的。**

動手前先跑：

```bash
grep -o "D[0-9][0-9]*" .ai-review/plan.md | sort -u -V | tail -5
grep -o "C[0-9][0-9]*" .ai-review/plan.md | sort -u -V | tail -5
```

這是「**對既有檔案做斷言前，先去讀那份檔案**」的同一條，只是換了個對象。

## 這個 repo 已經犯過的錯：欄位出現次數 ≠ 記錄數

`plan.md` 三度把「某值出現幾次」當成「幾筆記錄」：

| 曾經寫成 | 實際 | 成因 |
|---|---|---|
| 顏色=白 2,905 | **2,680** | `白;;;白` 在出現次數表被計兩次 |
| 白+圓形+無 683 | **754** | 683 是「顏色**恰為**白」的分組，不是「顏色**含**白」 |
| 字面「無」9 筆 | **6 筆記錄／9 個欄位出現** | 3 筆兩欄皆為「無」 |

共同成因都是**從已聚合的產物回推語意**。
**對來源做任何斷言前，照搜尋語意實跑一次，不要讀分組表。**

## 資料源的坑（實測）

| 坑 | 實測結果 |
|---|---|
| `export/42/json` 回傳 **ZIP** 不是 JSON | 內含 `42_5.json`，**檔名帶版本號會變** → 必須依 schema 辨識，不可 glob 取第一個 |
| 帶 `Origin` header 即 **403** | 前端絕對不能直接 fetch 來源 |
| 圖檔主機**無 CORS**、**無 ETag／Last-Modified**、`Cache-Control: private` | 圖片不可進 canvas |
| **HEAD 可用且 `Content-Length` 準確**；Range 不支援（回 200 全檔） | 換圖偵測靠 HEAD 掃描比對 `src_bytes`，不必全量重抓（D14）|
| 圖檔**不存在時回 HTTP 200 + 0 bytes** | 不是 404。管線不能只看 status |
| 官方原圖中位 **1.5 MB**、最大 18 MB、`?c=` 無縮圖參數 | 單頁 20 張約 68 MB → 必須鏡像（D10） |
| `info.fda.gov.tw` TLS 握手失敗 | 逐藥深連結無法驗證 → 不做 |

## 兩個時間欄位分屬兩個檔案，合併就會廢掉冪等

`appearance.json` 的 `meta` **刻意不含執行時間**——來源未變時位元組要完全相同，
否則每週都會產生假 diff。「最後檢查時間」因此另放 `data/status.json`（D28）。

**不要把 `last_checked` 搬進 `meta`**，那是把冪等直接拆了。
反過來也不行：`source_version`（TFDA 端資料產生日）與 `last_checked`（我方成功跑完的日）
**不同義**，缺 `source_version` 時寧可欄位不存在，也不得拿 `last_checked` 頂替。

`tools/write-status.mjs` **必須排在 `--publish` 之後**（它讀已發布的 `appearance.json`），
且**只在守門／鏡像／verify／npm test／publish 全過之後**才跑。
失敗的 run 推進了 `last_checked`，等於在頁面上宣稱資料是新的。

頁尾這條與 D16 **方向相反：不 fail-closed**。狀態檔壞掉只能降級顯示，
不得阻斷搜尋。`daysSinceISODate()` 對壞輸入回 `null` 而**不是 0**——
0 會被讀成「今天剛檢查過」，把壞掉的狀態檔偽裝成最新鮮的。

`taipeiDate()` 放在 `search.js` 而不是各自實作：寫入端與判讀端的日期定義必須是同一份，
理由同 `IMG_ORIGIN`。排程是 UTC `17 20 * * 0`＝台北週一 04:17，用 UTC 會少一天。

## Service Worker 的六條不可改（D29）

前三條是設計時就想到的，後三條是 Codex 覆審抓出來的——**都只有執行期才顯形**。

1. **`activate` 只刪 `pill-` 前綴的 cache。** Cache Storage 是 origin-wide，
   `liangrxdev.github.io` 上還有十幾個姊妹工具，無前綴的清理會刪掉別人的離線資源。
2. **圖片比對不得 `ignoreSearch`。** `?v=<sha8>` 是 D10.1 的內容版本，
   忽略 query＝TFDA 換圖後永遠命中舊圖。孤兒條目由 `IMG_CACHE_LIMIT` 吸收，
   而那個淘汰是 **FIFO 不是 LRU**（Cache API 沒有存取時間），別在別處講成 LRU。
3. **資料檔 network-first，且無快取時要讓例外往上拋。**
   合成一個 200 空殼會讓 `items: []` 被讀成「查無此藥」——
   加 SW 之前那個情境會走 D16 明講「這不代表查無此藥」，別把它換成更糟的東西。
4. **shell 不得用 stale-while-revalidate。** 導覽已經是 network-first，
   模組若走 SWR 就會出現**新的 `index.html` 配舊的 `app.js`**；
   而且部署修正漏檢規則後，首次重訪仍會靜默套用舊規則。兩支模組合計 35 KB，網路優先划算。
5. **每一處 `cache.put` 都要經 `putSafe`。** 寫快取和抓網路共用一個 `try` 的話，
   配額爆掉（同 origin 十幾個工具共用）會被當成離線：
   **網路明明成功拿到最新資料，畫面卻端出舊快取還誤報離線。**
6. **`trimImageCache()` 必須掛在 `event.waitUntil()` 上。** 沒人等的 Promise 只是
   「有機會跑完」，SW 回應後隨時可能被終止，那樣上限就不是保證而是願望。
   實測：620 張請求後停在 500——這條靜態掃描驗不到，改了要重跑 E11。

`OFFLINE_MODE` 的橫幅**只在 `path` 是 `appearance.json` 時才掛**。
`status.json` 單獨退快取時，畫面上的結果其實是剛從網路拿的，
說「顯示的是先前存下的資料」是一句關於資料新鮮度的錯誤陳述。

## 頁尾要顯示什麼由 `freshnessView()` 決定，不在 app.js 裡判

`search.js` 的 `freshnessView(meta, status, now)` 有三條防線，拿掉任何一條都會
**顯示一個看起來正常、其實是錯的新鮮度**：

1. 版本與筆數**取自 `meta`**（已通過 D16 契約）而非 `status`
2. `source_version` 不符就不顯示 `last_checked`——兩個檔各自走 SW 快取，
   會出現「appearance 是新的、status 退了舊快取」的跨版本組合
3. 未來日期（`days < 0`）不顯示——`days > STALE_DAYS` 對負數為 false，
   不擋的話壞掉的狀態檔會偽裝成「剛檢查過」

抽成純函式**是為了測得到**：本專案沒有 jsdom，留在 `renderFreshness` 裡就只剩原始碼掃描。

## workflow 的 permissions 是「全有全無」

一旦寫了 `permissions:`，**未列出的權限一律變成 `none`**。
`update-data.yml` 曾經只有 `contents: write`，於是「失敗時開 issue」一直靜靜地 403——
週更失敗只紅在 Actions 頁裡沒人看到。C18 守著這條。

**C18 必須先剝掉 YAML 註解再掃**：解釋這條規則的註解本身含有 `issues: write`，
掃全檔的話把真正的權限拿掉也會通過（變異 F12 實跑存活過）。

`appearance.json`（3.7 MB）**不進 install 預抓**。代價是首次造訪後要再載入一次才有離線能力
（SW 那時才接管），這是刻意接受的：預抓會讓只點進來看一眼的人先付 3.7 MB。

`OFFLINE_MODE` 的監聽必須註冊在 `load()` 之前——SW 會 await 完 `notifyClients` 才回應資料，
晚註冊就收不到，而橫幅不出現＝離線舊資料完全沒有標示。

## 發布是兩個層次，別混用

`rename appearance.json.staging → appearance.json` 是**資料就緒切換點**（工作目錄內）；
`commit` 才是**對外發布快照**。rename 之後、commit 之前的任何失敗都不得 commit。

`carryHashes()` 從**已發布**的 `appearance.json` 讀前版雜湊——
**不可**改用 `$RUNNER_TEMP` staging，否則讀不到前版 → 全量重抓 6,798 張圖。

`data/img/` 直接寫正式路徑（刻意保留續傳）。這安全的前提是 **D12.1 的三條 provenance
不變量同時成立**：命名空間（key === sha1(id)）＋ 來源歸屬（src 出自同一 id 的來源列）
＋ 內容一致（實算 sha === manifest sha）。
**只驗第一條等於沒驗**——key 只證明命名空間，不證明內容來自哪一筆。

## 兩個雜湊欄位不是同一件事

`imgs[].sha256` 是**轉檔後 WebP** 的雜湊（給 D12.1 第三條與前端 `?v=` cache key）；
`imgs[].src_bytes` 是**原圖**的 Content-Length（給 D14 的 HEAD 掃描當基準）。
兩者是同一次下載的產物，`carryHashes()` **必須一起沿用**——
只沿用其中一個會讓 HEAD 掃描拿 `null` 去比對而全部誤判為「已變更」。

`meta.images_bytes` 則是第三個、語意不同的欄位：**`null`＝未計，正整數＝已鏡像總量，
`0` 不是合法值**（D38）。`fetch-images` 在待處理 0 張時**不得早退**——
那是週更穩定後的常態路徑，早退會跳過重算，把「未計」當成就緒發布出去。
`--publish` 對此獨立守門，因為**雜湊齊全證明不了收尾跑完**。

季度檢查是 `--freshness`（HEAD 掃全量 ＋ 抽樣 100 張深驗，約 366 MB），
**不是** `--verify-all`（22 GB，保留給人工全量稽核，不排程）。
`--freshness` 不寫入任何檔案，且**問不出 Content-Length 一律列為需人工確認**——
把問不出來當成沒變，等於讓壞掉的端點自動過關。

## 吸頂的東西永遠不得高於視窗

`#panel` 曾經整個 `position:sticky; top:0`，而它在 386px 下高 802px。
sticky 的包含塊是 `.wrap`（涵蓋整頁），於是面板一吸頂就整段捲動都不放開，
`z-index:20` 蓋在結果上 —— **手機上一張卡片都看不到**，捲到底也一樣。

規格 §8.1 寫的是「**搜尋列** sticky」；實作把它擴大成整個面板。
現在只有 `#bar` sticky，且帶 `max-height:45vh` 當結構性防呆。

**這個 bug 逃過了 87 個測試與一次人工留檔。** 原因是留檔用 DOM 幾何量
（卡片在文件 y=904，數字看起來正常），沒有看畫面。
**量得到座標不等於看得見** —— 版面結論要有截圖。

## 官方原圖連結：href 來自資料，原始碼掃描看不到它

詳細頁的「查看 TFDA 官方原圖」href 是 `imgs[].src`，**不是程式碼裡的常數**，
所以 E5b 那道「掃原始碼裡的 URL」擋不住它。白名單 `IMG_ORIGIN`／
`isOfficialImgUrl()` 放在 `search.js`，**管線與前端共用一份**：
`verify-data` 發布前擋、`app.js` 算 href 前再擋一次。
兩邊各抄一份必然漂移。驗收 B13（函式本身，含 `mcp.fda.gov.tw.evil.example`
這類騙得過 `startsWith` 的反例）＋ E5e（UI 真的有經過它）。

## 圖片鏡像複用姊妹專案（D20）

`TFDA-drug-id-quiz` 的資產鍵 `sha1(id)[:16]` 與本專案同一套推導，
且 `content_hash` 是同一份來源快照，實算 **3,744 張（55.1%）可直接複用**。

**兩個不可混用的欄位**：quiz 的 `src_sha256` 是**原圖**雜湊；
本專案 `imgs[].sha256` 是**轉檔後 WebP** 的雜湊。複用時必須**在本地實算**，
不得沿用對方的值。另外 quiz 沒有 `src_bytes`，複用的那批要補跑 HEAD-only 掃描。

## 圖片 URL 必須帶內容版本

檔名固定為 `sha1(id)-n.webp`，TFDA 原地換圖後我方檔案內容變、URL 不變，
已快取的瀏覽器會繼續顯示舊圖。前端請求一律附 `?v=<sha256 前 8 碼>`（D10.1）。

## Windows 本機工具坑

- **PowerShell 的 `Get-Content` 用 cp950 讀 UTF-8**，`Get-Content | Set-Content` 會把中文轉成亂碼。
  改檔用 Edit/Write 工具或 Python（且 `io.open(..., encoding='utf-8')`）
- Bash tool 不吃 PowerShell here-string；`uvx` 在 Bash 找不到、PowerShell 找得到

## 指令

```bash
npm test                      # A（搜尋語意）＋ B（正規化）＋ C（管線 fail-closed）
npm run expected              # 重產 expected ID sets（只在規則或 baseline 有意變更時）
npm run build -- --source <本機zip>            # 開發時避免重複打 TFDA
npm run verify -- --source <zip> --in data/appearance.json.staging
npm run publish:data          # 資料就緒切換點（圖片未全部完成時會拒絕）
uv run tools/fetch-images.py --in data/appearance.json --freshness   # 季度新鮮度檢查
```

`verify` 的 `--source` **是必要的**，沒有 `--source` 直接 exit 2。
`--skip-content` 只跳過「實算檔案 sha256」那一條，且會在輸出明白標示未驗證。

C 組測試會真的 spawn CLI 並注入 ZIP fixture（`tests/_zip.mjs` 是最小 ZIP 產生器）。
**測 helper 本身出錯會讓整組 C 的結論失效**——`writeZip` 與 `writeZipEntries`
刻意分成兩個函式，就是因為原本用 `Array.isArray()` 判斷，
而資料列與 entries 都是陣列，C1 因此測到的不是它宣稱的那件事。
