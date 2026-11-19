# Scopes 動作

<!-- help-source -->

### 6.7 Scopes actions 與 File Output

Scopes 群組提供 Channel Display、Channel Scale、Channel Offset、Horizontal Scale（示波器水平軸刻度）、
Horizontal Position（示波器水平軸位置）、Edge Trigger、Measure、Capture、Screenshot 與 AutoScale。
Channel Scale、Channel Offset、Horizontal Scale（示波器水平軸刻度）、Horizontal Position（示波器水平軸位置）與 Edge Trigger Level
只允許數值 **Fixed value**、**Variable** 或 **Calculation** 設定值。
Calculation 的運算元只允許固定數值或變數，運算子只允許 Add、Subtract、Multiply
或 Divide。Template 也會驗證這些限制；一般 Output、Set Variable、Assert 與 While
仍保有原有來源能力。Measure 的 Value、Unit、Channel 與 Item 可供 Output 或 Assert 使用。
這五個 Scopes 設定值皆為必填，須提供固定數值或 binding。

Channel Display、Channel Scale、Channel Offset、Horizontal Scale、Horizontal Position
與 Edge Trigger 會在套用設定後回讀。回讀失敗、缺少資料或超出容差時，Step 會回報 FAIL。
若值不符，錯誤會顯示要求值、回讀值及適用的數值容差。驗證成功時，Result 取自原始 Set 命令。
Set 與 Query 各自使用既有 Timeout。

TDS2024B 與 TBS1052B 的 Edge Trigger Level 採用 ±0.05 V 絕對容差，設定值接近零時也適用。
例如設定 1.00 V 時，回讀 1.04 V 會通過，回讀 1.06 V 會失敗。Source Channel 與 Slope
仍須完全一致。

Foreground Measure 另提供 Valid（`/valid`）供 IF／ELSE 判斷。取得有效數值時為
`true`；僅在確認是無效量測 sentinel、且儀器狀態正常時，Step 仍會成功完成並回傳
`/valid` = `false`、`/value` = `null`。在 IF／ELSE 選 Previous step result →
Valid，與 Boolean false 比較。其他無效回應、儀器或 Worker 錯誤以及取消仍會使
Step 失敗。無效量測不代表儀器完全沒有波形，Orchestrator 也不會自動重試。

**Measurement Item**、Trigger **Slope** 與 Capture **Points** 都是依目前 Scopes
Capabilities 提供的固定下拉選單。量測項目與斜率儲存 canonical 字串；Measurement Item
顯示時將第一個英文字母大寫，`vpp` 顯示為 **Vp-p**，儲存值仍為 `vpp`。Points 儲存
數字，不能使用 binding。Simulation 使用預設型號；Live 使用目標的 canonical model ID。
切換模式、型號、目標 instance 或執行檔會重新載入選項。載入中、Capabilities 無法取得
或清單為空時會停用選擇。設定不合法或無法確認時，必須明確重新選擇；選項不會自動改寫
已儲存值。最終型號支援仍由 Scopes 驗證。
Job 排入佇列後，要等 Scopes 回報 terminal result 才算完成。

**Scope Single Wait（單次觸發等待）** 啟動單次擷取，並在有限時間內等待觸發完成。
**Trigger Timeout (ms)** 預設為 **5000**，**Poll Interval (ms)** 預設為 **100**；
兩者只能是固定正整數，且 Poll Interval 不可大於 Trigger Timeout。
此 Action 不提供 Force Trigger 選項。已確認的正常觸發逾時會作為成功 Step，
可利用 `/outcome` = `timeout` 或 `/timed_out` = `true` 進行既有的 IF／ELSE 判斷。
儀器、Worker 或取消等真正錯誤仍使 Step 失敗。觸發逾時不代表擷取成功，
Orchestrator 也不會自動強制觸發、停止擷取或重設儀器。

選取 Single Wait 的 Result 欄位後，會顯示資料型別與比較值：Outcome 是 String（natural＝正常完成觸發，timeout＝等待逾時）；Timed Out 與 Capture Allowed 是 Boolean（true 或 false）。IF／ELSE 的另一側請選相同型別；選取欄位不會自動修改比較值。

Channel Display、Channel Scale、Channel Offset 與 Measure 使用固定的 **Channel**
下拉選單；Edge Trigger 使用 **Source Channel**。選項依 Scopes 離線 Capabilities
顯示為 **CH1**、**CH2** 等。Simulation 使用模擬器通道；Live 使用目標 instance
已識別的型號。切換模式、目標 instance、Live 型號或 Scopes 執行檔時，會重新載入選項。
載入中、缺少 Live 型號、查詢失敗或沒有支援通道時，會停用新的固定選擇並顯示提示。
已儲存但不支援的值仍會顯示，儲存與重新載入時也會保留。既有 Channel binding
會保留並顯示提示；只有明確選擇支援的固定通道，才會取代原值並移除該 binding。
其他 bindings 保持不變。

Capture 的 **Channels** 使用依 Capabilities 提供的 **CH1**、**CH2** 等核取方塊。
可選擇一個或多個通道，最後一個已選通道無法取消勾選。已儲存但不支援的通道或
無效舊值會保留並顯示提示，所有核取方塊顯示為未勾選；勾選支援通道後，才以有效
選擇取代原資料。既有 Channel binding 同樣保留，直到明確選擇固定通道才會取代。
載入 Capabilities 或切換型號不會自動改寫已儲存通道。

**Scope AutoScale** 僅支援 Keysight 的 Foreground Step（DSOX2004A、DSOX3024A、DSOX4024A、DSOX4034A）。
Source Channels、Acquire Mode（Normal／Current）及 Channels Mode（All／Displayed）均為選填；
未指定的項目不會傳給 Scopes Tool，取消全部 Source Channels 勾選即省略此參數。
AutoScale 可能改變通道顯示與刻度、Timebase、Trigger 等儀器狀態；Orchestrator 不會自動還原。
使用 Background Measure Streaming 時，應在 Worker ON 前完成必要的 Scopes Setup；
Streaming 啟動後不能在同一 Worker 執行 AutoScale。Step 必須等 Async Job 完成才算成功；
若指定來源命令遭拒，Scopes Tool 可能回報改用不指定來源的 AutoScale Fallback。
Simulation 僅驗證命令流程，不代表已完成真實波形縮放。

Screenshot 的 **Image Format** 依 Scopes 離線 Capabilities 控制：Simulation 使用
預設型號，Live 使用已保存的裝置型號。不支援的格式仍顯示，但無法選取。切換型號時，
已保存但不支援的格式會保留並顯示警告。若無法取得 Capabilities，編輯器會顯示原因，
並停用新的格式選擇。

左側 Workflow 的 **Scopes File Output** 需要目前 Template 中至少有一個 Scopes
Tool Instance。沒有時，標題會灰化並顯示鎖頭與 **No Scopes Tool Instance. Add one in Setup.**，
無法展開，內部設定也會隱藏。新增第一個 Scopes instance 後解鎖；移除最後一個後
再次鎖定。載入 Template 時會依其中的 instances 更新鎖定狀態。Simulation 與 Live
採用相同條件，不需要已保存的 Live Resource。鎖定或解鎖會保留已選資料夾及
展開／收合狀態，並與 Scopes step 分類各自獨立。

解鎖後可展開 **Scopes File Output**。**選取資料夾（Select Folder）** 選擇 Capture 與
Screenshot 共用的資料夾；**使用預設值（Use Default）** 回到 **Orchestrator application folder / data**。
此選擇只屬於本機 runtime state，不保存至 Template。Capture 產生 CSV 與 metadata
JSON；Screenshot 產生所選格式的圖片。每次執行，包括 loop iteration 與後續 run，
都會取得新的絕對檔案路徑，不覆蓋既有檔案。Job 失敗或缺少必要檔案會使 step 失敗。
此區塊與匯出 Workflow Output rows 的 CSV Export 分開。

