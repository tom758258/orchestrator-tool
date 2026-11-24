# Workflow 步驟

<!-- help-source -->

### 6.2 For

For step 具有 **Start**、**Stop**、**Step**、loop variable 與 body。

- 當 step grid 能到達 Stop 時，Stop 會包含在執行範圍內。
- Positive 或 negative direction 必須與 Start、Stop 的方向一致。
- Zero Step 無效。
- Start 與 Stop 相等時執行一次。
- If、For 與 While 共用最多 8 層巢狀深度。

For ranges 使用 exact decimal range semantics，而不是 floating-point tolerance。
Range 依設定的 step 評估；若 Stop 無法由 step 到達，不會為了湊整而額外執行一次。

### 6.3 While

While condition 會在每次 iteration 前判斷。Iteration limit 可以是：

- 正的 finite `max_iterations`；或
- **Unlimited**，表示不設定 finite iteration limit。

若 condition 一開始就是 false，body 執行 0 次。Unlimited While 可位於
root 或沒有 For／While 祖先的 If 分支內。Body 不可為空，可包含 finite nested
loops，但不可再包含另一個 Unlimited While。

Software Meters **Measure** 位於 Unlimited While，且 Simulation 無法預先推導
來源大小時，**執行模擬（Run Simulation）** 會顯示 Sample 警告。每個受影響 Instance 的
**SIM Max Samples** 預設 1,000，可輸入 1 到 1,000,000 的整數或按 Cancel。
這是本次來源的啟動參數，不是 While 次數限制；不保存至 Template、Setup 或
Step，也不影響 Live。每次新 Run 重新預設 1,000。來源耗盡後若流程仍要求
Measure，該 Step 會失敗並執行 Cleanup，不會重啟 Worker。Live Software
Measure 不會套用這個 Simulation 上限。

前景 Meters 在 Simulation 與 Live 都只使用 Single。若要每次取得一批讀值，
或使用 Immediate、External 觸發，請將該 Instance 設為 Background。

If step 每次只判斷一次 condition，只執行 THEN 或 ELSE。選取 If 後可
指定新增 Steps 的分支，也可獨立拖曳及貼上。分支新建的 Variables 與
Step Outputs 不會外露；更新既有 Variable 的值則會保留。分支 Output
沿用外層 Page Row Scope，未執行的分支欄位保持空白，If 不額外新增 Row。

### 6.4 Stop Workflow 與迴圈 Stop

Simulation 或 Live 顯示 Running 時，即可按 **停止工作流程（Stop Workflow）**，包含啟動期間
及沒有迴圈的 Workflow。此操作會停止整個 Workflow：

1. 正在執行的 Wait 會提早結束。其他動作、Worker 啟動與 Tool Setup 會完成
   目前操作，或等到既有 Timeout。
2. 不再開始後續一般 Step 或迴圈迭代。已提交的資料列、訊息及已接收的
   Background Samples 會保留；未完成區塊中尚未提交的資料列會捨棄。
3. Background Worker 先在既有時限內收尾並接收最後的 Samples，再執行
   Powers Safe-Off 與 Foreground Worker 關閉。清理完成前持續顯示
   **正在停止工作流程…（Stopping Workflow…）**。停止請求若失敗，畫面會顯示錯誤並允許重試。

實際提早停止且清理成功時，結果為 **執行已停止（Run stopped）**，與成功、失敗分開呈現。
真正的動作、資料完整性、CSV 或清理錯誤仍會使 Run 失敗。若 Workflow 已自然
完成，晚到的停止請求不會改變成功結果。Stop 不提供暫停或繼續執行功能。

Background Dataset 的完整性與品質，分別依實際資料及 Worker 證據判定。
停止時仍在進行的有限筆數 Capture 若未達目標，會標為 **incomplete**；
無限筆數 Capture 停止時也會標為 incomplete。真實 Samples 與部分 CSV 均會保留。
先前已完成的 Capture 不會因後續刻意提早停止而被改為 incomplete。
沒有啟用 Capture 的 Worker 停止時不會建立 Dataset。缺少終止證據、Sample
缺漏、Overflow 與 CSV 錯誤仍屬失敗。

獨立的 **Stop** / **Stop <Loop ID>** 控制項維持原有的迴圈停止行為：

1. 目前最內層迭代會繼續執行到成功提交資料的時點。
2. 接著退出指定的迴圈。
3. 父層迴圈或根層 Workflow 可繼續執行。

迭代失敗優先於迴圈 Stop。迴圈 Stop 本身不會將整個 Run 標為 Stopped；
最終狀態仍依一般 Workflow 成功規則判定。

### 6.5 Output Pages

Output step 有 name 與 Page。同一 Page 的 Outputs 形成一個 dataset 的 columns；
不同 Pages 是獨立 datasets，nested loop 也可以擁有自己的 Page。

每個 Page 綁定一個固定的 owning lexical loop path。不同 lexical loop paths 不可
共用同名 Page。Page name 同時要符合 CSV filename stem 與 Excel worksheet name
限制，因此兩種 export format 會套用相同的命名限制。

前景每次 Meters Measure 提供一筆讀值，可供 Output、Calculation、Set Variable
與 Assert 正常引用。只有所屬流程區段或迴圈次數成功結束，才會保存該次 Output 列；
後續步驟失敗時，尚未保存的列會捨棄。背景讀值獨立記錄於 Capture Dataset。

### 6.6 Show Message

**Show Message** step 會在 Workflow 執行時將文字寫入 Messages Panel。它唯一的用途
就是輸出訊息：不是 Popup、不是 Assert，也不是 Output Page，因此不會為你的資料、CSV
或 Charts 增加欄位。

- **目標訊息（Target Message）** 可選擇 **Message 1**、**Message 2** 或 **Message 3**，預設為
  Message 1。
- **Content Fields** 構成訊息內容。每個 step 最少 1 個、最多 10 個 field，預設建立
  1 個空白 String。可使用 **新增欄位（Add Field）** 與 **刪除欄位（Delete Field）** 調整數量，Fields 依畫面
  順序串接。
- **String** field 為自行輸入的文字，最多 256 個 Unicode 字元；以 code point 計算，
  因此 Emoji 等字元不會被提前截斷。
- **輸出（Output）** field 顯示某個 Output step 的值。下拉選單顯示 Output 名稱，且只提供位於
  目前 step 之前、在當前 loop scope 內可見的 Outputs。驗證時也會確認該 step 確實是
  Output，因此引用較早的 Wait、Set Variable 或 Show Message 會被拒絕，且不會自動改選
  其他 step。Show Message 的 Output 必須是單一數值。若參考
  的值不是單一數字、文字、Boolean 或 null，該 step 會明確報錯，不會寫出部分訊息。
- **Newline** 會在該 field 之後換行。每則訊息結尾一定會自行換行，因此兩個 Show
  Message step 不會黏成同一行，最後一個 field 也因此不需要 Newline checkbox。

**訊息預覽（Message Preview）** 會在編輯時顯示組合結果。Output field 以名稱作為佔位符號，因此不必
先執行 Workflow 就能確認版面。以下設定：

| Field | Type | Value | Newline |
|---|---|---|---|
| 1 | String | `Iteration: ` | Off |
| 2 | Output | `Iteration` | On |
| 3 | String | `Double: ` | Off |
| 4 | Output | `Double` | — |

會產生：

```text
Iteration: 3000
Double: 6000
```

因為 Fields 會在 step 執行當下解析，位於 For 或 While loop 內的 Show Message 一律顯示
目前的 iteration，不會取用上一輪的值。

### 6.7 String Process 與 Byte Process

這兩個 Workflow Step 不需要 Tool Instance。每個資料參數均可使用 Fixed value、
Variable 或 Previous step result，不提供內嵌 Calculation、Elapsed time 或 Timestamp。
結果可由後續 Step 選擇 Value（JSON Pointer `/value`）取得。不修改來源 Variable，
也不自動建立 Output 欄位。

Process 的 Fixed value 字串欄位中，Enter 輸入 LF；畫面上的 `\r` 表示 CR、
`\n` 表示 LF、`\\` 表示原本的反斜線，其他反斜線組合保持文字原樣。
載入的 CRLF 顯示為 `\r` 加上一個換行，避免 CR 與 LF 被無聲合併或遺失。
編輯或複製這類字元時，請選取完整的跳脫表示。複製與剪下傳出原始文字，
貼上與外部拖入按接收到的原始文字處理。Process 字串欄位內或欄位之間拖曳
使用畫面上的表示方式，拖出至其他程式亦為畫面表示。Template 與 Process
仍使用原本的 JSON 字串；1 MiB 限制適用於解碼後的 UTF-8 字串，而非編輯器顯示長度。

每個輸入與輸出字串最多為 1 MiB（1,048,576 個 UTF-8 Bytes）。超出限制時 Step
執行失敗，不會自動截斷資料。此限制不改變既有 Variable、Serial RX 或 Capture Dataset
的容量限制。

**String Process** 以 Unicode code point 而非 UTF-8 Bytes 計算文字。索引從 0 開始，
搜尋區分大小寫。

| Operation | Input String 以外的參數 | 結果 |
|---|---|---|
| Length | — | Number，code point 數量 |
| Substring | Start Index、Length | String；長度 0 回傳空字串 |
| Concat | Append | String；可附加空字串 |
| Contains | Search | Boolean |
| Index Of | Search | 第一個符合的索引，找不到為 -1 |
| Replace | Search、Replacement | String；取代所有不重疊的符合項目 |
| Trim | — | String，移除前後空白 |
| To Upper Case | — | String |
| To Lower Case | — | String |
| To Number | — | Number；接受整數、小數、正負號、科學記號及前後空白 |

空 Search String、索引超出範圍、型態錯誤、無效或非有限數值轉換，以及非零數值下溢為零，均使 Step 失敗。
例如 `STATUS:PASS` 使用 Substring，Start Index 7、Length 4，回傳 `PASS`。

**Byte Process** 處理 Hex String 所代表的原始 Bytes。Hex 輸入接受大小寫與完整 Byte
之間的空白；Hex 輸出統一大寫且不含空白。無空白的 Hex String 在字串上限內最多
可表示 524,288 個原始 Bytes。Byte 索引從 0 開始。

| Operation | Input 以外的資料參數 | 結果 |
|---|---|---|
| Byte Length | — | Number，Bytes 數量 |
| Get Byte | Byte Index | Number，0～255 |
| Get Bytes | Start Index、Byte Count | Hex String |
| Concat | Append | Hex String |
| Contains | Search | Boolean，只比對完整 Byte |
| Hex to Number | Start Index、Byte Count | Number |
| Number to Hex | Byte Count（Input 為 Number） | Hex String |
| Hex to Text | — | UTF-8 String；無效 UTF-8 回傳 Null |
| Text to Hex | —（Input 為 String） | UTF-8 Bytes 的 Hex String |

Hex to Number／Number to Hex 另需設定 Byte Order：MSB First (Big Endian) 或
LSB First (Little Endian)，及 Number Format：Signed 或 Unsigned。只有這兩項數值
轉換限制為 1～4 Bytes；Signed 使用二補數。數值必須是選定範圍內的整數。
Byte Order 不反轉單一 Byte 內的 Bit。無效 Hex、空搜尋、型態錯誤、非整數索引、
超出範圍與數值溢位均使 Step 失敗，不截斷資料。Hex to Text 遇到合法 Hex
但無效 UTF-8 時例外地成功回傳 Null。

例如 Serial RX Hex String `AA010CE400FF` 可交給 Hex to Number，Start Index 2、
Byte Count 2、MSB First、Unsigned；`/value` 為 3300，後續 Calculation 除以
1000 可得到 3.3。對 `1234`，MSB First 回傳 4660，LSB First 回傳 13330。

這些 Step 只處理已取得的資料，不組裝 Serial RX 封包、不配對 TX／RX，
也不改變 Serial Send 能力。
