# 執行結果

<!-- help-source -->

## 輸出頁籤導覽

| 區域 | 可以查看什麼 |
| --- | --- |
| Last Run Execution Results | 步驟執行狀態及錯誤 |
| Messages | Show Message 文字訊息 |
| Charts / Live Monitors | 圖表及即時監看 |
| Foreground Output | 前景的 Output Page、統計及資料 |
| Background Output | 背景 Capture Dataset、統計及資料 |

Last Run 是本次結果的工作區。執行記錄及資料列以最新在前排列；Messages 則依產生順序顯示。已啟用的即時監視器位於圖表下方。

## Last Run：最近一次執行

> **注意：** Orchestrator 只保留最近一次執行的資料，不是測試紀錄管理系統。要長期保存量測資料，請在開始新執行或離開程式前匯出。

Desktop 只在記憶體保留一筆 **Last Run**，沒有歷史紀錄或資料庫。

- 執行開始時保存當次工作流程快照。之後編輯目前流程不會重新解讀舊結果。
- 開啟範本或按 **清除上次執行（Clear Last Run）** 會移除記憶體中的結果及快照。
- Last Run 保留執行開始時的模式。切換目前模式不會改變舊結果的 Simulation／Live 標示。
- 執行未完整成功時，已提交的資料列保留為部分結果；停止後仍可手動匯出。

## 查看及收合結果面板

| 區域 | 選擇及匯出 |
| --- | --- |
| Foreground Output | Source 卡片選擇 Output Page，更新 Summary、Output Data 及匯出範圍。 |
| Background Output | Source 卡片選擇 Background、Capture Dataset，並顯示 Worker 狀態。每頁 100 筆，超過才顯示分頁。 |

兩區的匯出選項均在 Output Data 下方的 Export settings。前景依範圍選檔案或資料夾；背景固定選目的資料夾，匯出所選或全部資料集的完整內容，而非僅畫面當頁。背景匯出按鈕依所選格式顯示名稱。

前景與背景共用 Auto、Fixed、Raw 數字顯示設定，不改變資料及匯出精度。背景統計只顯示資料集已有的數值，Scopes 保留 Valid／Invalid，Serial RX 顯示事件與位元組數量。前景頁面與背景資料集分開選擇。

Charts、Live Monitors（有啟用才顯示）、Foreground Output、Background Output、每張圖表與 Live Monitor，以及兩個 Output
區塊中的 Summary／Output Data 都有獨立 `− / +` 控制，預設全部展開。收合只隱藏內容，
不清除設定、不移除圖表、不停止 Capture 或 Monitor 接收；收合狀態不保存到 Template。

圖表收合時仍顯示 **將圖表儲存於範本（Save charts with template）** 與圖表數量。

**Last Run Execution Results** 與 **Messages** 的標題右側各有 `+ / −` 控制。兩者
預設皆為展開，且可各自獨立收合，互不影響。收合只改變顯示內容：不會移除 execution
資料、不會停止 run，也不會清除結果。重新展開後會回到原本的結果清單位置。

**Last Run Execution Results** 收合後仍保留標題、Execution Mode badge 與 execution
數量摘要；execution 清單與 Newer / Older 分頁會隱藏，直到再次展開。

### 如何閱讀錯誤訊息

Failed run 與 failed execution record 會先顯示簡短、較容易理解的錯誤說明。原始錯誤仍保留在
**Technical details** 下方供除錯使用。這層說明只在 failure 出現；successful 與 cancelled
execution record 維持既有 compact display。Instrument-specific 的 SCPI/VISA 細節會原樣
保留，不由 Desktop 猜測或重新解讀。

## Messages：流程訊息

| 設定或限制 | 行為 |
| --- | --- |
| Message 1 / 2 / 3 | 三個獨立頁籤 |
| 排列順序 | 舊訊息在上，最新在下 |
| 保留數量 | 每頁籤最近 1,000 筆；摘要仍顯示總數 |
| 單則字數 | 最多 4,096 字元，超過會截短 |
| 匯出 | 不提供 |

**Messages** 收集 Show Message 步驟產生的文字，由步驟指定頁籤。每頁依產生順序排列，保留原換行；切換頁籤或收合不會遺失訊息。收合期間不重新載入清單，但仍持續接收並更新總數，展開後可查看最新訊息。超過單則上限會標示 `…[truncated]`，結尾仍有換行。

正常結束、失敗或合作式停止都保留該次已產生訊息。新一輪執行、清除上次執行、新增範本或開啟範本會清除上一輪訊息。訊息不寫入檔案，也不能匯出。
