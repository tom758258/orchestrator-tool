# 執行結果

<!-- help-source -->

## 10. Run Results

Run 後，Output 區域目前可顯示以下 visible sections：

- **Last Run Execution Results** — execution statuses 與 progress results；大量
  execution results 以 latest first 顯示並可分頁瀏覽。
- **Messages** — Show Message step 在執行時寫入的文字。
- **Last Run** — 目前 run 的 Output Pages 與 result workspace。
- **圖表（Charts）** — 集中顯示所有 Foreground／Background 圖表。
- **即時監視器（Live Monitors）** — 獨立顯示已啟用的監看卡片，位於 Charts 下方。
- **Summary** — 適用時顯示 numeric Count、Min、Max 與 Avg。
- **Output Data** — 所選 Page 的 committed rows，以 latest first 顯示。

### 10.1 Last Run

Desktop 只在 memory 中保留一個 **Last Run**，沒有 Run History、database 或 SQL
storage。

Run 開始時 Desktop 會保存該次 run 的 Workflow snapshot。之後修改目前 Workflow
不會重新解讀 Last Run。Open Template 會清除 Last Run；**清除上次執行（Clear Last Run）**
會移除目前 memory 中的 result 與 snapshot。

Last Run 也會保存該次 run 開始時的 Execution Mode。之後切換目前 selector，
Last Run 的 Simulation 或 Live badge 不會跟著改變，因此 simulated success 不會
被呈現為 real-hardware success。

若 run 沒有完整成功，committed rows 仍會作為 partial results 保留；execution
停止後可以 manual export。

### 10.2 收合結果面板

Foreground Output 的 Source 卡片提供 Output Page 下拉選單、目前頁數與操作說明；切換後會更新 Summary、Output Data 及所選 Page 的匯出範圍。Background Output 的 Source 卡片提供 Background、Capture Dataset 選擇及 Worker 狀態。兩區的匯出選項都集中在 Output Data 下方的 Export settings。

Background 數值 Summary 與 Output Data 使用和 Foreground 相同的表格樣式，並共用 Auto、Fixed、Raw 的 Number display 設定；這些設定不改變儲存資料或匯出精度。Background Summary 只顯示 Dataset 已有的統計，Scopes 保留 Valid／Invalid，Serial RX 則顯示事件與 Bytes 數量。Background 仍使用每頁 100 筆資料，不與 Foreground Output Page 混用。

Background Source 的 Background 與 Capture Dataset 下拉選單在寬視窗並排，窄視窗則自動換行。Dataset 超過 100 筆才顯示分頁按鈕，並沿用專案標準按鈕樣式。Foreground Export settings 會依目前選項說明將選擇檔案或資料夾；Background Export settings 固定選擇目的資料夾，匯出完整的所選或全部 Datasets，不只目前顯示的資料列。Background 匯出按鈕依所選格式顯示名稱。

Charts、Live Monitors（有啟用才顯示）、Foreground Output、Background Output、每張圖表與 Live Monitor，以及兩個 Output
區塊中的 Summary／Output Data 都有獨立 `− / +` 控制，預設全部展開。收合只隱藏內容，
不清除設定、不移除圖表、不停止 Capture 或 Monitor 接收；收合狀態不保存到 Template。

Charts、Live Monitors、Foreground Output 與 Background Output 使用相同圓角外框，
標題與收合按鈕嵌入框線，彼此獨立收合，且收合後仍保留外框與標題。
Charts 收合時仍顯示 **將圖表儲存於範本（Save charts with template）** 與圖表數量。

**Last Run Execution Results** 與 **Messages** 的標題右側各有 `+ / −` 控制。兩者
預設皆為展開，且可各自獨立收合，互不影響。收合只改變顯示內容：不會移除 execution
資料、不會停止 run，也不會清除結果。重新展開後會回到原本的結果清單位置。

**Last Run Execution Results** 收合後仍保留標題、Execution Mode badge 與 execution
數量摘要；execution 清單與 Newer / Older 分頁會隱藏，直到再次展開。

Failed run 與 failed execution record 會先顯示簡短、較容易理解的錯誤說明。原始錯誤仍保留在
**Technical details** 下方供除錯使用。這層說明只在 failure 出現；successful 與 cancelled
execution record 維持既有 compact display。Instrument-specific 的 SCPI/VISA 細節會原樣
保留，不由 Desktop 猜測或重新解讀。

### 10.3 Messages

**Messages** 收集 Show Message step 寫入的文字。它有三個互相獨立的 tab：**Message
1**、**Message 2** 與 **Message 3**，由 step 選擇要寫入哪一個。每個 tab 依 workflow
產生的順序顯示訊息，**舊訊息在上、最新訊息在下**，因此 loop 的輸出可以由上往下閱讀。
這與 **Last Run Execution Results** 及 **Output Data** 的 latest first 排列相反。
訊息內的換行也會保留；切換 tab 或收合面板都不會遺失訊息。

由於 loop 可能執行大量次數，每個 tab 僅保留最近 1,000 筆訊息。摘要列仍會顯示該次 run
產生的訊息總數，因此可以知道是否還有更早的訊息。**Messages** 收合時不會重新載入
訊息清單，但 run 仍會持續接收訊息並更新總數；重新展開後即可看到最新的訊息。

單則訊息最多 4,096 個字元，避免過長的 Output 值填滿面板。超過時會縮短並標示
`…[truncated]`，且結尾仍保有自己的換行。

訊息屬於產生它的那一次 run。run 正常結束、失敗或 graceful stop 都會保留當輪已產生的
訊息。開始新一輪 run 會清空上一輪的訊息。**清除上次執行（Clear Last Run）**、New Template 與 Open
Template 都會一併清除訊息。訊息不會存檔，也無法 export。

