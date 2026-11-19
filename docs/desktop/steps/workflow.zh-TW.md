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

