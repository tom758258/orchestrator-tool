# Background Streaming 與 CSV

<!-- help-source -->

## Background Streaming

在 **Tool Setup** 中，Meters 或 Scopes Instance 都可勾選
**Enable Background Streaming**。Meters 提供六種背景量測模式；
Scopes Background 支援唯讀的數值 Measure Cycle，不包含 Screenshot 或
Waveform Capture。Powers 和 Wavegen 仍不支援 Background。
背景 Instance 不可同時供前景 Tool Action 使用。切換用途時會保留既有步驟，
請在執行前處理畫面提示的衝突；取消 Background 後，須選擇 Single 才能用於
前景 Measure。同一次執行中的兩個 Instance 不可共用同一個 Live Resource。

來源可選 **Finite** 或 **Infinite**。Scopes 的 Finite **Cycles** 是完整量測
Cycle 數量，每個 Cycle 可包含多個 Channel／Item 組合；Infinite 持續執行，
直到 Worker OFF 或 Stop Workflow。**Measure interval (seconds)** 預設 1 秒，
代表每個完整 Cycle 結束後的等待時間，不保證固定採樣率。在
**Measurements** 新增或移除量測項目，依 Scopes capabilities 為每個項目
選擇 **Channel** 與 **Item**；每項有內部穩定 ID。Cycle 內的項目依序讀取，
不是同時量測。最終機型／項目／參數支援由 Scopes Tool 驗證。

Meters 的有限 Simple 模式設定 **Max Samples**；
有限 Custom 模式設定 **Trigger Count**，每次觸發取得 **Sample Count** 筆。
無限 Custom 必須明確勾選 **Allow Buffer Overflow Risk**。背景無限擷取
不會套用隱藏的 Simulation 筆數上限。

**Software** 與 **Software Custom** 預設使用 **Timer Interval (ms)**，初始值為
**1000**。來源就緒後送出第一次觸發；收到一筆讀值或完整一批 Custom 讀值後，
等待指定間隔才送出下一次。這是完成量測後的等待時間，不保證固定取樣頻率。
Capture OFF 後仍持續觸發，也可繼續更新 Live Monitor。Worker OFF、Stop Workflow、
來源完成或失敗時停止觸發。觸發遭拒或量測逾時會使執行失敗，並保留已取得的資料。
Software Simple 可勾選 **Trigger with BG Command**，改由 Workflow 命令觸發；
使用前請先在 Workflow 啟用 FG/BG Interaction。

**External** 與 **External Custom** 在 Live 使用接入的實體觸發訊號；
Simulation 會對支援的型號自動產生虛擬觸發，例如 34461A。34460A 不支援 External。
Slope 與 Delay 設定會交給工具處理；Simulation 不驗證實體觸發時序。

**Live Monitor** 可選，預設不勾選。Scopes Monitor 可用 **Measurement**
選擇單一數值欄位繪圖，且獨立於 Capture；無效讀值不會當成 0 繪製。
**5.1 Meters Setup** 的 Allow Risk 警告
適用於背景 Custom 模式。Stop 無法恢復遺失的讀值；停止後請核對擷取筆數與資料品質。

加入以下 Workflow Actions，再於 Step Properties 選擇 Background：

- **Worker ON**：執行到該 Step 才啟動來源。Scopes 會先啟動等待狀態的
  Streaming Worker、完成現有 Scopes Setup，再開始 Measure Streaming。
  「同時 Capture ON」預設不勾選；勾選可保留來源啟動時的第一批 Samples。
- **Capture ON**：在持續執行的 Worker 上建立新的獨立 Dataset。
- **Capture OFF**：完成該 Dataset 與選配的 Streaming CSV；不停止 Worker，
  也不自動另做 Manual Export。
- **Worker OFF**：釋放來源。「同時 Capture OFF」預設勾選；若先前已明確
  Capture OFF，請取消勾選。有限來源尚未達到設定筆數就執行 Worker OFF，
  會使執行失敗；若要提早結束並保留部分資料，請使用 **停止工作流程（Stop Workflow）**。

重複 ON/OFF 會造成 Step Error。有限來源自然結束時會接收尾端資料並完成
Dataset。之後第一次 Capture OFF 是確認自動收尾，第一次 Worker OFF 是釋放
來源；第二次明確 OFF 才會失敗。已結束的來源不能再 Capture ON，必須先
Worker OFF 再重新 Worker ON。所有 Run 結束路徑（包含失敗）都會清理尚在
執行的 Worker，同時保留原有 Powers Safe-Off 行為。

**輸出（Output）** 同頁包含 **圖表（Charts）**、有啟用 Monitor 才顯示的 **即時監視器（Live Monitors）**、**前景輸出（Foreground Output）**、**背景輸出（Background Output）**，各自可收合。
只有 Background 的 Run 也能使用 Charts 與 Background Output。該次 Last Run 有
Background Binding 才顯示 Background Output；之後修改 Draft 不會隱藏既有結果。
Background Output 的 Background／Capture Dataset 選擇控制其 Summary、Output Data 與匯出，
與每張圖的選擇互相獨立。

在 **圖表（Charts）** 的 **Chart settings** 中，先選擇 **Ground**（Foreground 或 Background），
再透過 **頁面（Page）** 選擇前景 Output Page 或背景資料來源，最後按 **新增圖表（+ Add Chart）**。
每張圖表以不同顏色的 Foreground／Background 標籤與 Page／Background ID 顯示來源。
**將圖表儲存於範本（Save charts with template）** 與圖表數量顯示在 Charts 區域右上角。所有 Foreground Page 與
Background 圖表集中顯示。每張 Background Chart 有 **Export PNG**、**設定（Settings）**、
**Source settings**、**Remove**。**Source settings** 以唯讀方式顯示已選擇的 Background，
主要提供 **Capture Dataset** 與 **X-axis data**（Elapsed Time／Timestamp／Sample Index）；
Scopes 另外保留 **Measurement**。Background 來源在建立 Chart 時指定，
若不再存在於目前 Draft 或 Last Run，可透過 **Reassign source** 選擇兩者皆有效的來源。
選擇後立即套用，Chart 卡片仍顯示來源標籤與 **Data summary**。每張 Scopes Chart 只繪製單一欄位。若要比較不同項目，請使用多張 Chart，
不要把不同單位混用同一條 Y 軸。Background 圖表可全部移除至零張。
Settings 支援 Line、XY Scatter、Column、Area、Bar；執行中只有 Line 即時更新。
Foreground 保留原有所有圖型。每張圖首次有資料時預選該 Background 最新的 Dataset，
之後保持選擇，不因新增 Dataset 自動跳換；新 Run 會重新選取。沒有 Dataset 時顯示等待資料，
不以 Monitor Samples 替代。

Background X 軸使用實際的 Elapsed Time（秒）、Timestamp 或 Sample Index；Hover 顯示
實際繪製 Sample。抽樣時 Line／Area 保留峰值、谷值與端點；Scatter／Column／Bar 顯示代表性觀測值。
**Data summary** 以 Total samples、In range、Plotted 顯示資料筆數及既有抽樣狀態。Line／Area／Column 的 Zoom
會重新查詢可視範圍；Scatter／Bar 沒有 Zoom。Line 的 **Settings → General → Show All Raw Data**
可完整顯示可視範圍內最多 **25,000** 筆 Samples；超限時不繪製資料，並提示縮小 Zoom 或關閉此選項。
完整 Dataset 保存與 CSV／XLSX 匯出不受繪圖上限影響。

Last Run 圖表在目前 Workflow 移除 Binding 後仍可查看與修改顯示設定，不會重建或改寫 Draft Binding。
若啟用 **將圖表儲存於範本（Save charts with template）**，而圖表引用的 Background 已不在 Draft，Template Save
會被阻止並指出需修正的圖表。可移除該圖、選擇有效來源，或關閉保存圖表設定。

Setup 啟用 **Live Monitor** 後，**即時監視器（Live Monitors）** 會在 Charts 下方獨立顯示，
使用與 Charts 相同的外框與內部卡片樣式，兩區可各自收合；沒有啟用 Monitor 時整區隱藏。
每張 Monitor 使用精簡的 **Monitor info** 說明：數值 Monitor 為最新 1,000 筆 Worker Samples
的緩衝上限，Serial RX 則為最近的有限長度 Bytes；兩者皆獨立於 Capture。
數值 Monitor 保留原本 Line 外觀、Hover 與 Zoom，Capture OFF 時仍可更新；Worker OFF 後停止更新，
新 Worker Runtime 會清空 Buffer。它沒有 Chart Settings、Add／Remove、Saved Chart、PNG、
Dataset、Summary、CSV 或 XLSX，也不占圖表額度。Background Output 的 Summary 對 Meters
顯示 Dataset 筆數、最小／最大／平均值、狀態與品質；Scopes 則依 **Measurement**
分別顯示有效／無效數量與有效值的最小／最大／平均值。Scopes 的 Output Data 會顯示
選定的多個量測欄位，無效值留空，並可將滑鼠移到欄位上查看無效原因。
**Output Data** 每頁 100 筆。
`no_loss_detected` 代表 Tool 的證據範圍，並非零遺失保證。

Capture 邊界依接收事件的處理順序，不代表硬體採樣時刻。完整 Samples 保留於
本次 Run 的記憶體；新 Run 或 **清除上次執行（Clear Last Run）** 會釋放，沒有 History 或 Recovery
Store。Background Samples 不提供給 Workflow Variables、Calculation、Assert
或 ResultRows。

**CSV Export → Stream Background CSV during Capture** 與前景 CSV 獨立。
可選 All Backgrounds 或單一 Background，並各自選擇輸出資料夾；預設
`<application folder>/data`。Scopes 的 **Scopes CSV columns** 可在 Run 前選擇
**Values + units**（精簡）或 **Values + units + validity + reason**（含品質），
後者會額外輸出每個 Measurement 的有效性及無效原因。兩種模式都不會把無效值
寫成 0；Meters 原本的五欄 CSV 不變。每次 Capture 建立新 CSV；
只使用 Monitor 不產生 CSV。所有啟用的 CSV 目的地適用下方失敗政策，並保留部分檔案。

Run 結束後，**Export Background** 可將選定或全部 Dataset 匯出為 CSV 或
XLSX，包含失敗 Run 已收到的部分資料。若選取 Scopes Dataset，可用
**Scopes export columns** 在每次手動匯出時獨立選擇精簡或含品質格式，
不必與 Streaming CSV 使用同一種格式；記憶體中的 Dataset 始終保留
`value`、`unit`、`valid` 與 `reason`。超過 300,000 筆會顯示警告；XLSX
每檔預設 300,000 筆，**Samples per XLSX file** 可調整為 1 到 1,048,575。
較大的 Dataset 會分檔而不截斷。檔名避免覆寫 Streaming 或先前 Manual 檔案。
Capture OFF 與 Run 結束都不會自動執行 Manual Export。

## 9. Streaming CSV

Streaming CSV 在 Workflow 區域的 **CSV Export** panel 設定，和 run 完成後再做的
manual export 不同。此區塊在程式啟動時預設收合，點擊標題可展開或收合；收合只會
隱藏控制項，不會改變其設定值。

前景 Streaming 至少需要一個 Output；Background Streaming 不受此限制。
前景可選擇：

- **Selected Page** — 選一個 Output Page，可選擇是否指定輸出資料夾。
  Desktop 會自動產生 timestamped CSV 檔名。Run 開始後 Selected Page 會固定。
- **All Pages** — 可選擇是否指定輸出資料夾。Desktop 會建立 timestamped
  destination directory，並為每個 Page 建立一份 CSV。

若未指定輸出資料夾，Streaming 資料會儲存在應用程式所在目錄的 data 資料夾。

預設輸出資料夾：`<application folder>/data`

Streaming behavior：

- Workflow execution 前建立並 flush header。
- 只有 committed ResultRows 會寫入。
- 每筆寫入的 row 都會 flush。
- CSV write 或 flush failure 會停止後續 streaming attempts，但 Workflow execution
  會 Failed，停止後續普通 Steps，並執行 Background 與 Powers 安全 Cleanup。
  建立或最後 flush 失敗也適用；這與 Graceful Loop Stop 獨立，保留 committed
  rows、已收到的 Background Samples 與部分 CSV。
- Workflow failure、Stop Workflow 或迴圈 Stop 後，已寫入的 committed CSV data 不會被刪除。
- Streaming 不產生 XLSX。
- Run 進行中會鎖定 streaming settings。

選用的 FG/BG Data Buffer 與 Capture、Live Monitor 獨立。
