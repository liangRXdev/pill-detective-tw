# Codex 規格覆審報告（**第二輪**）— imprint 倒讀／字形變體查詢擴展

| 項目 | 值 |
|---|---|
| 審查日期 | 2026-08-14 |
| 審查模式 | `mcp__codex__codex`，`sandbox: read-only`、`approval-policy: never` |
| thread id | `019ffe17-2a2b-7ae2-8ad6-6531f0780dc0` |
| 受審文件 | `.ai-review/plan-imprint-variant.md` **v0.2** |
| 第一輪報告 | `plan-review-imprint-variant.md`（thread `019ffdf8-…`）|
| repo 基準 | `main` @ `3ef2246`，工作樹乾淨 |
| 本檔性質 | **Codex 原始輸出，原封不動**。判定見 `plan-verdict-imprint-variant-2.md` |

> 本輪特別要求 Codex 做三件事：驗證第一輪修訂是否真的堵住原問題、審 v0.2 新增部分、指出修訂不足或修訂過頭。
> 並明確告知第一輪的判定結果（含 2 項判為範圍蔓延而拒絕者），要求不再重提。

---

# 1. 第一輪修訂的驗證

## 1.1 多 token predicate 獨立性

- **嚴重度：無 finding**
- **問題：** §5.2 已明確規定 `flip`、`canon` 是兩條獨立 predicate，各自須覆蓋全部查詢 token；B22 也包含跨規則拼接的負例與正對照。
- **為什麼現在不修之後會更貴：** 不適用；原問題已堵住。
- **建議修法：** 無。保留目前「不得逐 token OR」與雙理由必須各自全中的定義。

**判定：修訂充分，沒有把洞轉移到另一個語意位置。**

## 1.2 `SH/HS` 方向與數字

- **嚴重度：無 finding**
- **問題：** D32 明定只轉換查詢 token；§3.1、A15(a) 與 oracle 都凍結查 `SH` → `HS` 的實跑身份及 37／42 數字。
- **為什麼現在不修之後會更貴：** 不適用。
- **建議修法：** 無。

**判定：修訂充分。**

## 1.3 canon 對稱性

- **嚴重度：Medium（驗證殘留，不是語意殘留）**
- **問題：** D33 的雙邊 canonical 等價關係已堵住原規格衝突；但 A15(e) 沒有完整驗到其宣稱的雙向性。`12` 只涵蓋 `1/I/L`、`2/Z` 的部分方向；單字元 `0`、`5` 因 canon 被停用，不能證明 `0↔O`、`5↔S` 的 admission 是雙向的。B21 只證明 `canon()` helper，無法排除 production 在 admission 時只 canonicalize 查詢側。
- **為什麼現在不修之後會更貴：** helper 測試全綠時，搜尋整合層仍可能只支援「代表字查變體字」而不支援反方向；屆時需重做 expected、理由集合及 UI fixture。
- **建議修法：** 增加長度至少 2 的雙向 admission witness，讓五個等價類都同時驗到「代表字查變體」及「變體字查代表字」。單字元案例只保留驗證停用規則。

**判定：語意修訂已堵住；驗收尚未完整證明它。**

## S1：撤回字首、單字元禁用 canon、A17

- **嚴重度：Blocker**
- **問題：修訂不足。** D34 確實堵住「真實 token 當查詢」時的 801 筆膨脹，但 A17 的查詢母體不是完整使用者輸入空間。

  我以現行 6,295 筆資料，對 canon key 的所有相關字形拼法共 14,602 個查詢做唯讀重算，得到：

  - `Y5P` 不是資料中的真實 token。
  - `YSP` 是真實 token。
  - 查詢 `Y5P` 時可產生 **111 筆 variant**。
  - 因 `Y5P` 不在 2,357 個真實 token 中，A17 不會測到。
  - 111 已直接違反目前採用的「不得 &gt;100」規模邊界。

  換言之，A17 證明的是「現存 token 作為查詢時最大 84」，不是「任意合法查詢最大 84」。§3.4、D34 將前者外推成後者，洞確實被換了位置。
- **為什麼現在不修之後會更貴：** 若先完成 production、oracle、manifest、UI 與四處同步，之後才發現 admission 規則本身不符合目標 4，就必須重新裁決規則、重產全部 expected 並重審理由集合。
- **建議修法：** A17 的查詢域須改成由資料 token 經 `flip/canon` 關係導出的完整可達查詢閉包，而不只是「已存在 token」。在該閉包重新量測後，再裁決 D34 是否仍符合 100 筆邊界；不得把 111 隱藏成資料更新或調高常數。

---

## 新 admission truth table

- **嚴重度：Medium**
- **問題：** §5.1／§5.2 大致正確，但 A14 要求八種 fixture「每個都讓 variant predicate 為 true」在邏輯上不可實現：

  - `OFF`、`NO_TOKEN` 沒有可供 predicate 評估的查詢 token。
  - `UNKNOWN` 定義為記錄沒有任何 token，不可能與轉換後 token 完全相等。

  因此 A14 與 F13-1 宣稱「前七格全部會因移除 MISMATCH guard 而變紅」不成立。
- **為什麼現在不修之後會更貴：** 實作階段會被迫加入不屬於產品語意的測試鉤子，或悄悄弱化 fixture，最後讓規格與測試各說各話。
- **建議修法：** 將八狀態分成：

  - predicate 在資料上可成立的狀態：要求 counterfactual predicate=true。
  - `OFF`／`NO_TOKEN`／`UNKNOWN`：只驗證其不可進 variant 的結果，不再宣稱移除 guard 必然讓該格變紅。

另有一個 **Low** 級文字缺口：§5.2 應明說 predicate=true 時，是把「imprint 的 MISMATCH 狀態替換成 VARIANT」，不是同時保留兩者；否則按 `mismatch &gt; variant`，記錄仍會被排除。

## D37 query-scoped 理由契約

- **嚴重度：Medium**
- **問題：** 契約方向正確，但驗證沒有真正證明可重入。F13-11 提到「連續兩次不同查詢」，E12 本文卻沒有具名的兩查詢序列，也沒有要求第二次搜尋後第一份結果仍保持原理由，更沒有驗證 indexed item 不含理由狀態。
- **為什麼現在不修之後會更貴：** 理由若以可變參照掛在 item 上，單次搜尋及逐卡 UI 都可能正確；直到連續查詢或保存第一份結果後才出現污染，屆時會牽動搜尋結果模型與 UI。
- **建議修法：** 驗收應具名一個同 ID 在兩次查詢中理由不同的 witness，並同時斷言：

  1. 第二次搜尋不改變第一份結果的理由。
  2. 兩份結果各自符合 oracle。
  3. indexed item 搜尋前後沒有 query-scoped reason。

---

# 2. v0.2 新增部分的需求與邊界缺漏

## A17 與 TFDA 週更的生命週期未定義

- **嚴重度：High**
- **問題：** `2,357／12／84／100` 混合了三種不同性質：

  - 2,357：凍結 baseline 的 token 數。
  - 12、84：凍結 baseline 的觀察統計。
  - 100：產品可用性的政策邊界。

  資料週更後，合法新資料可能使 token 數、p99 或最大值改變，但仍完全符合 admission 規則及 ≤100 政策。此時 A17 會因 12／84 失敗；若 A17 固定跑 baseline，又不會保護新資料。

  現行測試實際讀取凍結的 [baseline-2026-08-12.json](C:/Users/liang/projects/pill-detective-tw/tests/baseline-2026-08-12.json)，而週更流程是先 `npm test`、之後才 publish staging，見 [update-data.yml](C:/Users/liang/projects/pill-detective-tw/.github/workflows/update-data.yml:50)。所以目前架構下，A17 預設不會驗證待發布的新資料。
- **為什麼現在不修之後會更貴：** 第一次 TFDA 新增高頻刻字時，CI 不是無理由阻擋合法更新，就是讓超過 100 的資料直接發布；再補生命週期規則會牽動 workflow、baseline 更新與人工裁決流程。
- **建議修法：**

  - baseline regression：2,357／12／84 綁 baseline hash，只用來偵測規則漂移。
  - release safety：對待發布資料動態取得 distinct token/query closure，只守政策上界 100。
  - 明定 p99 算法；否則樣本數變化時不同統計實作可能得到不同結果。

這與 §7「無管線變更」存在表面衝突。相容作法是將其限定為「無產品 canonical data pipeline 變更」，允許 CI 對既有 staging 做唯讀驗證。若連驗證 workflow 都不得調整，就必須明說 A17 只保護凍結 baseline，不能宣稱保護週更後的規模。

## `variantReasons` 結果形狀不足

- **嚴重度：Medium**
- **問題：** §7 列出 `variant` 與 `variantReasons`，但未定義後者是以 ID 鍵控、與陣列位置對齊，或其他結構；也未規定不得有 variant 以外的額外 reason entry。
- **為什麼現在不修之後會更貴：** oracle、production、UI 可能各自選擇不同對齊規則，最後才發現排序後理由貼錯卡片。
- **建議修法：** 在結果契約中固定 identity-to-reason 的唯一關係，並要求理由 domain 與 variant ID set 完全相等，而不只是「每個 variant 都找得到理由」。

---

# 3. 驗證策略缺口

| 驗收 | 嚴重度 | 弱化實作／判定 | 晚修成本與建議 |
|---|---|---|---|
| A13 | 無 finding | ordered IDs、理由及守恆已堵住「任挑 N 筆」漏洞。 | 保留；其 `[堵死]` 成立。 |
| A14 | Medium | `OFF/NO_TOKEN/UNKNOWN` 無法構造成 predicate=true；宣稱七格都能殺死 guard mutation 不成立。 | 修正為可實現矩陣，避免不可滿足測試。 |
| A15 | Medium | (e) 未完整證明 canon admission 雙向；(g) 不能保證抓到逐 token OR。實跑現行資料，`M 40` 沒有同時具備 `M→W` 與 `40` canon witness 的記錄。 | 雙向 canon 補多字元 witness；N15 主要由 B22 守門，不要宣稱 A15(g) 也保證。 |
| A16 | 無 finding | 真實 `search()` 正例、真正 EMPTY 反例及 UI 分支均有。 | `[堵死]` 成立。 |
| A17 | **Blocker** | `Y5P` 這類不存在於資料的合法查詢可達 111 筆，但不在 2,357 個查詢中。週更資料也未定義。 | 改查詢閉包與 baseline/release 雙層契約。 |
| B20 | Low | 「對 2,357 token 全量斷言對合」未說 `flip(t)=null` 時如何處理；照字面無法對合。 | 明定只對可 flip token 驗 `flip(flip(t))=t`，表外另由 null 契約驗。 |
| B21 | 無 finding | 完整映射、identity、冪等、值域已堵住 helper 層錯映射。 | `[堵死]` 成立；整合層雙向缺口由 A15 修。 |
| B22 | 無 finding | 單／多 token、完全相等、跨規則拼接及雙理由均有正反對照。 | `[堵死]` 成立。 |
| C20 | Medium | 只禁止依賴 `search.js`；弱化實作可把共用語意移到另一個本地模組，production 與 oracle 一起引用，靜態斷言仍通過。 | 禁止 oracle 依賴 production 搜尋語意的整個本地 dependency closure，不只檔名 `search.js`。 |
| E12 | Medium | 單次逐卡檢查堵住「理由放標題」，但未堵住 mutable reason 在第二次查詢污染第一份結果。另掃 `%` 可能被藥名或資料內容誤觸。 | 納入 D37 的具名雙查詢重入案例；禁語只檢查 UI 自產生的理由／標題文字。 |

### F13-1～12

| 變異 | 判定 |
|---|---|
| F13-1 | **部分成立。** MATCH／PARTIAL 等可建 predicate=true 的格可抓；OFF／NO_TOKEN／UNKNOWN 的「七格全紅」保證不成立。 |
| F13-2 | **成立。** A14 的 VARIANT＋UNKNOWN 交叉格可抓錯誤優先序。 |
| F13-3 | **成立。** B20 的逐字映射必紅；`MS` 提供整合層 witness。 |
| F13-4 | **修訂不足。** `10` 不含 `5/S` canonical class，移除 `5/S` 不會使其 15 筆 canon 命中改變。B21 只會抓 helper 映射，沒有保證搜尋整合層真的使用 `5/S`。需改用實際依賴 `5↔S` 且 variant 非零的查詢。 |
| F13-5 | **大致成立，但 mutation 名稱不精確。** A14 可抓「PARTIAL 狀態也啟動變體」；A15(g) 可抓「predicate 只需部分 token」。應區分這兩種不同弱化。 |
| F13-6 | **成立。** A16 經真實搜尋，E12 驗 UI。 |
| F13-7 | **成立於 baseline。** `SH` 與全量 token 會抓到字首放寬；但不修正 A17 的輸入域問題。 |
| F13-8 | **成立。** B22 多 token 否定組可抓。 |
| F13-9 | **成立。** 22 字元 × 三位置足以系統性抓到回原字串。 |
| F13-10 | **部分成立。** B22 可抓；A15(g) 的現行真實資料不是逐 token OR witness，表中不應把它列為具名保證。 |
| F13-11 | **未成立。** D37 有文字契約，但 E12 沒有具名雙查詢、不變快照及 indexed item 無污染斷言。 |
| F13-12 | **成立。** 真實 token `I` 在 A17 母體內，會突破 100。 |

---

# 4. 更簡單的替代方案

## Admission truth table

- **嚴重度：Low；判定：沒有 over-engineering。**
- **問題：** OFF／NO_TOKEN／UNKNOWN／PARTIAL 的既有語意確實需要顯式表格；拿掉會重開真空成立與錯誤分區問題。較多餘的是 `MISMATCH` 與 `VARIANT` 是否並存的表述。
- **為什麼晚修更貴：** production 與 oracle 可能採不同 composition。
- **建議修法：** 保留 §5.1，但用一句唯一規則明定：「variant predicate 成立時，僅將 imprint condition 由 MISMATCH 置換為 VARIANT；其他條件照既有優先序合成。」不需要再增加狀態或分區。

## D37

- **嚴重度：Low；判定：需求必要，但雙集合表示可簡化。**
- **問題：** `variant[]` 與獨立 `variantReasons` 形成兩個需要同步的 query-scoped 結構。
- **為什麼晚修更貴：** 排序、卡片定位及 oracle 對帳都可能發生 identity/reason 漂移。
- **建議修法：** 新第五區直接採用「variant identity 與 reason set 不可分割」的單一結果契約。仍是 query-scoped、不寫回 item、不碰 JSON，與現有架構限制相容。

## A17

- **嚴重度：High；判定：目前同時不足且過頭。**
- **問題：**

  - 不足：查詢域漏掉 `Y5P` 等可達但不存在的輸入。
  - 過頭：把描述性統計 p99=12、max=84 也升格為永久 release gate；真正政策邊界只有 100。
- **為什麼晚修更貴：** 會同時造成漏攔截與週更誤攔截。
- **建議修法：** 最簡單的分工是：

  1. 凍結 baseline 測試保留 12／84，作為規則 regression fingerprint。
  2. 規模安全驗收只保留「完整可達查詢域無任何 &gt;100」。
  3. 對每次待發布資料動態重算，不凍結 2,357。
  4. p99 僅作報告指標；除非另有明確政策門檻，不列為 release gate。

總結：前三個原 Blocker 的語意修訂基本閉合；S1 則是明確的「修訂不足」。v0.2 最主要的動工前阻擋點，是 A17 把「真實 token 樣本」錯當成完整合法查詢域，且現行 baseline 上已存在 `Y5P → 111 筆` 的可觀察反例。
