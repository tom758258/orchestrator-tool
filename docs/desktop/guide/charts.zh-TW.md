# 圖表

<!-- help-source -->

### 10.4 Charts

Charts 使用 Apache ECharts 的 Canvas renderer。每個 Foreground chart 屬於一個 Output Page，
可繪製該 Page 的 numeric Outputs。Session-only 與已保存的 Foreground／Background Charts 共用
最多 8 張額度。Foreground／Background Charts 依顯示的 Chart 編號排列，不會因來源不同而分組。Live Monitor 與沒有 Chart 設定的 Background Binding 不計入此限制。

Charts 預設只屬於目前 session。Charts 標題列新增 **將圖表儲存於範本（Save charts with template）**，
預設不勾選；當目前的 chart panels 與 Chart Settings 需要隨 Template 還原時再勾選。
開啟含有 saved Foreground 或 Background Chart 設定的 Template 時，checkbox
會自動勾選並還原設定，包含只有 Background 的 Template。沒有 saved Chart
設定的 Template 從零張圖開始。選擇來源並按 **+ Add Chart** 才建立圖表。
刪除所有圖表後，執行、Validate、切換 Page、儲存與載入都不會自動補回。
已保存的有效圖表設定照常載入；Live Monitor 獨立運作，不占用圖表額度。
取消勾選不會刪除目前畫面上的 Charts，只代表下一次 Save Template 不再保存它們。
勾選狀態下執行 **清除上次執行（Clear Last Run）** 會保留 Chart 設定；一般未勾選的 session Charts
則維持原本清除行為。

此選項只保存 Chart definitions 與設定，不會保存 run data、Run ID、目前互動操作產生的
zoom／pan 位置、loading/error UI state、dialog state 或 export destination/path。
下方 Workflow 的 **Chart Options** 即使勾選本選項，仍然只屬於
session，不會寫入 Template。

Chart Options 位於 Workflow 左側窄欄的 **CSV Export** 正下方。最外層
**Chart Options**、其中的 **Sampling** 與 **Y-axis** 都能彼此獨立展開或收合。
程式啟動時，**Chart Options** 預設收合，內部的 **Sampling** 與 **Y-axis** 各自
預設展開。收合只會隱藏控制項，不會改變其設定值。

**Sampling** 區塊可用於 Simulation 與 Live Line Chart。
**Preserve Significant Changes** 預設關閉，Change Threshold (%) 預設為 **5%**，
啟用時必須是有限且大於 0 的百分比。不論是否啟用，原本每個 pixel bucket 的
Min/Max 都會保留。啟用後會額外檢查可見範圍的 Raw Data，每個 bucket 最多再補
兩個符合門檻的局部變化代表點（上升 Max、下降 Min），並按真正 Iteration 排序，
不會刪除原本 Min/Max。正常值比較基準不會在安靜區段任意重設；單筆或雙筆異常
恢復後，也不會永久將異常值當成後續基準。即使長時間量測，繪圖點數仍約束在
每 bucket 最多四點，另保留整體首尾點。

Threshold 下方另有 **Show Significant Change Markers**，預設關閉；
Preserve Significant Changes 關閉時無法操作。啟用後僅標示符合門檻的上升／
下降異常代表點，每 bucket 最多兩個，不會把異常恢復正常的數值直接當成異常點，
也不會對 Line 的全部繪圖點加上 Marker。Marker 開關不會改變折線的選點結果。
普通 Line 即可在 **Chart Settings → Series → Marker appearance** 設定每個
Output 的既有 Marker 尺寸、形狀、填色與邊框，不必先選 Line + markers。
原本的 Line + markers 仍是獨立功能，會為全部繪圖點顯示符號；Marker 樣式也
沿用目前各 Output 的設定及 PNG 匯出方式。

門檻為空白、0、負數或非有限數字時，若 Preserve Significant Changes 已啟用，
Simulation 與 Live 都會停用 Run。0 變成非 0 視為 100%，0 變成 0 視為 0%。

**Y-axis** 區塊提供 **Fit Data**，預設關閉，並可用於 Simulation 與 Live Line
Chart。Fit Data 關閉時，Auto Y-axis 維持目前行為，範圍可能包含 0；開啟後，
Auto Y-axis 會依繪圖資料範圍縮放，不再強制把 0 納入顯示，因此較容易觀察帶有
offset 的小幅變化。Chart Settings 中手動指定的 Y-axis **Minimum**／**Maximum**
仍照常套用。Fit Data 不改變非 Line chart type。

Sampling 控制項與 Fit Data 都會在 RUN 開始時建立快照，Last Run 沿用該次設定。
它們都是 Desktop session 選項，不寫入 Template。RUN 後修改這些控制項不會立即
改變目前的 Last Run 圖形；需重新執行才會套用新的設定。

Line Chart 可在 **Chart Settings → General → Show All Raw Data**（預設關閉）
繞過繪圖降採樣，顯示 X 軸可見範圍內所有已載入 Raw Data（如有資料，另含兩端
各一筆裁切銜接點）；每張 Chart 獨立設定，立即生效，不需要重新 RUN。
若該 RUN 啟用專用 Marker，仍可顯示異常標示。顯示全部資料可能降低 Desktop
繪圖效能，尤其 LIVE 執行中可能導致畫面卡頓或暫時無回應。
上述顯示選項不修改原始結果、CSV/XLSX 匯出，也不影響非 Line Chart。

Execution 執行中只有 **Line** 支援即時更新。Execution 停止後，只要有 committed
numeric rows，即使 run 失敗，也可在 **Settings → General → Chart type** 選擇
**Line**、**XY Scatter**、**Column**、**Area**、**Bar**、**Combo**、**Histogram**
或 **Box & Whisker**。Line 顯示 Iteration 趨勢；Area 在折線下填色；Column
使用垂直分組長條；Bar 使用水平分組長條；XY Scatter 用來比較數值 X 與 Y
的關係。

Chart Settings 有五個 tabs：**一般（General）**、**資料系列（Series）**、**座標軸（Axes）**、**分析（Analysis）**
與 **Export**。Series 包含各 Output 的 **Auto**／**Custom color**、Line 樣式、
Scatter 設定，以及 Combo 的 Type／Axis。每個 Line Output 可選 **Line** 或
**Line + markers**；Combo Output 可選 **Column**、**Line** 或
**Line + markers**。啟用 marker 的 Line 與 Combo Output 可分別設定 marker
size、shape（Circle、Square、Diamond、Triangle）、fill 與 border。Scatter
維持整張圖共用的 marker size 與 line width，但 marker shape、fill、border
可依 Output 設定。Marker fill 與 border 使用 **Auto** 時會跟隨該 Output 的
series color，也可改為獨立的 custom color。Legend 會反映實際的 line／marker
樣式；Area 仍不顯示 markers。Box & Whisker 維持自動配色。

**General → Chart type** 也會在選擇 Combo 或 Histogram 時顯示 Output 數量提示。
若原本選取多個 Outputs 後切換成 Histogram，**Apply** 會保留第一個已選取的 Output。

在 chart panel 勾選多個 **Outputs**，即可比較多個 numeric series。Scatter 的
**X source** 可選 Iteration、任一 numeric Output 或 Timestamp Output；只作為 Scatter X 的 Output
不必同時勾選為 Y series。**Display** 可選 Markers、Lines 或 Lines + markers；
Scatter 的 **Marker size** 與 **Line width** 接受有限且大於 0 的數值，並用於
顯示對應元素的模式。Scatter 保留原始 X/Y pairs 與 row order，包括非單調的 X；
Lines 依該順序連線。Timestamp X 使用完整日期時間轉成的絕對毫秒座標，跨午夜時
持續增加；X 標籤與 hover 依該 Output 的 Include Date／Include UTC Offset 選項
顯示固定 UTC+08:00 時間，不受電腦時區影響。Timestamp 不提供作為 Y series、
Summary、Histogram 或其他量測統計。Elapsed X 一律使用原始秒數，X 軸標籤與
Tooltip 的 X 值則依該 Output 的 Time Format 顯示。Chart Settings 的 X-axis
**Minimum**、**Maximum** 與 **Major unit** 一律輸入原始秒數，即使標籤顯示
分鐘、小時或十進位天數也相同。
Scatter hover 依畫面距離判定；line 顯示可透過可見線段命中，
但只會回報實際 raw row，不會為 hover 內插不存在的量測值。Combo 至少需要兩個
Outputs；每個 Output 可選 Column、Line 或 Line + markers，並指定 Left Y 或
Right Y。左右 Y 軸可分別設定，Combo 支援 Iteration X 軸縮放。

Histogram 一次只使用一個 numeric Output。**Bins** 可選 Auto、Count（1–200）
或 Width（正數）；Auto 使用 Sturges rule。Width 若會產生超過 200 個 bins，
會顯示錯誤。Box & Whisker 會對每個選取的 Output 顯示一個 box，並可顯示或隱藏 outlier points。這兩種
統計圖會從 committed StoredRun rows 計算，不會把完整 raw samples 載入前端
chart cache。**Analysis → Show normal curve** 可在 Histogram 上疊加折線。
**Mean** 與 **Std Dev** 留白時使用與 Summary 相同的平均值及樣本標準差；
自訂 Mean 必須為有限數值，自訂 Std Dev 必須為有限且大於 0 的數值。
每個 bin 中心的 normal PDF 會乘上 sample count 與該 bin 的實際 width，
以對齊 Count 軸。使用自動 Std Dev 時，少於兩筆 samples 或零變異資料
會省略曲線，Histogram 仍可使用。

大型資料集下，Line 與 Area 只會對目前可見的 Iteration 範圍做繪圖
decimation，Combo 的兩種 Line 樣式也使用相同的 viewport decimation。Column 與
Combo 的 Column series 會保留可見範圍內的每筆 raw row；Scatter 與 Bar 保留
raw pairs。Scatter 不對 raw pairs 做 sampling 或 decimation。Scatter Markers
在 marker size 大於或等於 4 時使用 ECharts large rendering；較小的 marker
改用一般 scatter rendering，以保留要求的 shape。Scatter Lines 與
Lines + markers 使用 line rendering。這些顯示最佳化不會刪除 committed
ResultRows。Line、Area、Column 與 Combo
的 hover 會解析 exact raw iteration 與 value；Scatter hover 回報最近的實際 raw
XY row。Bar、Histogram 與 Box & Whisker 不提供 hover inspection。Iteration 是
Page 的 row sequence；Chart 與 CSV 按 chronological 順序，**Output Data** 則以 latest
first 顯示。

**設定（Settings）** 可設定圖表標題、**Show legend**、**Legend position**（Top、Bottom、
Left、Right），以及 X/Y axis 的標題、最小值、最大值、
主要刻度間距、labels、tick marks 和 major gridlines。數值欄位留白代表 Auto；
若同時指定最小值與最大值，最小值必須較小；主要刻度間距必須大於 0。Combo
另有可獨立設定的 Right Y Axis。可辨識的自動 axis title 會隨所選 chart type 與
Scatter X source 更新，自訂 title 則會保留。因目前 chart type 未使用而隱藏的
numeric 設定不會阻擋 Apply；合法的 inactive 值會保留，非法值會回到 Auto 或
該控制項的預設值。

**Apply** 會套用有效設定並關閉視窗；**Cancel** 會捨棄草稿並關閉視窗。點擊
背景或按 Esc 不會關閉 Settings，因此草稿會保留。**Show legend** 開啟時即使只有
一個 series 也會顯示 legend；關閉後無論位置為何都不顯示。

Line、Area、Column 與 Combo 可在 **Settings → Axes → Zoom → Enable zoom** 開啟縮放。
使用滑鼠滾輪可縮放 X 軸，並可在圖內拖曳平移。**Show zoom slider** 可控制底部
縮放列是否顯示；隱藏後不會清除目前範圍，滾輪與拖曳仍可使用。按
**Reset Zoom** 可回到完整 X 範圍。執行中的 Line chart 在尚未手動縮放或平移
時會跟進新資料；手動操作後，新資料不會移動目前 viewport，直到按 Reset Zoom。
修改 X Axis 的 Minimum 或 Maximum 並套用、關閉 zoom，或切換到不支援 zoom
的圖型時，都會重設 manual viewport。Scatter、Bar、Histogram 與
Box & Whisker 不提供 Zoom 控制。

每個 chart 都有個別的 **Export PNG** 操作。低調的圖表邊界標示匯出的 chart
surface：包含圖表標題、legend、axes、plot 與目前 zoom range；不包含 Output
選取控制項、chart action buttons、zoom slider 與 Reset Zoom。
**Settings → Export → Background** 可選 Light 或 Dark，並與 Application theme
分開設定。兩種背景都會保留自訂 series 顏色與 Normal curve。

Chart configuration 在切換 Page/tab 與後續 Simulation 或 Live run 時仍會保留，
並沿用 Page/Output 相容性規則。執行中非 Line panels 保持原本 Page 與排序，
顯示 **Waiting for run to finish** 並隱藏 plot；Output selection 與 Export PNG
仍停用，Settings 與 Remove 可操作，每張圖都可移除，包含最後一張 Foreground 或 Background Chart。
執行中 Chart type 只允許維持原類型，或將非 Line 改為 Line，即使尚未收到
第一筆資料也可以切換。Line 必須等 execution 停止後才能改為非 Line。
Apply 後，Line 使用目前 run 的資料並即時更新。仍為非 Line 的 panels
不會載入即時 chart data，execution 停止後
自動使用新 run 的 committed rows 更新，不需手動 refresh。Run 開始時 panels
就保持可見，非 Line 立即進入 Waiting，即使第一個 progress update 尚未抵達。
新 run 的資料尚未可用時，Line 顯示 **Waiting for run data**，不顯示上一 run
的 plot，也不載入 chart data；資料可用後才開始即時更新。
**+ Add Chart** 仍建立 Line chart。**開啟範本（Open Template）** 會以該 Template 的 saved
Charts 取代目前的 Chart configuration；若沒有 saved Charts，則不會還原 persisted
Chart configuration，且 **將圖表儲存於範本（Save charts with template）** 為未勾選。開啟含 saved Charts
的 Template 後，可直接 Run Simulation，以還原的 definitions 與設定顯示新結果，
不需重新設定 Chart。建立新的 blank Template 會清除 Chart configuration。
**清除上次執行（Clear Last Run）** 會清除 Last Run data；**將圖表儲存於範本（Save charts with template）** 未勾選時，
也會清除 session Charts，勾選時則保留 Chart configuration。只有啟用
**將圖表儲存於範本（Save charts with template）** 時，Chart settings 才會成為 Template data。

