# Tool Setup 與 Instance

<!-- help-source -->

## 5. Setup 與 Tool Instances

Tool Instance 是保存於 Template 中的 logical、具名稱的 instance。一個
Template 可以有多個相同 Tool Type 的 instances，每個 instance 有自己的
setup values。Tool setup 屬於 Template；machine-specific executable paths 與
Live Resources 不屬於 Template。

每個 instance 使用獨立邊框卡片，預設展開，可用 **+ / −** 收合或展開。
Add Tool Instance 上方的 **Tool Instance Summary** 依 Tool Type 統計 instance
數量，包含未在本機配置的類型。未使用的類型不顯示，沒有 instance 時隱藏整個摘要。

每個 instance 內依序排列 Tool 原有設定、**Background Streaming**、**Live Device**，
Background Streaming 前後各有分隔線。兩區皆可用 **− / +** 獨立收合；Background
Streaming 預設收合，Live Device 預設展開。展開 Background Streaming 並勾選
**Enable Background Streaming** 後顯示支援的 Background 選項。不支援的 Tool Type
維持停用核取方塊並顯示原因。
使用 Worker 與 Capture 動作控制串流及資料記錄。

編輯、切換頁籤或收合外層 instance 時，群組與卡片的展開／收合狀態會保留。
成功執行 **新增範本（New Template）** 或 **開啟範本（Open Template）** 後恢復預設狀態，包含 External
Tools cards。這些 UI 狀態不會寫入 Template 或本機設定。

**新增工具實例（Add Tool Instance）** 透過 **工具類型（可下拉選擇）** 提供在 Tools 已配置的 Tool Type，包括 Missing 或 Error
狀態。沒有已配置的 Tool Type 時，新增 instance 會停用。既有 instances 即使
對應 Tool Type 未在本機配置，仍會顯示並附上警告；重新配置後警告會消失。

展開任一 Powers、Meters、Scopes 或 Wavegen instance，即可編輯 **Display Name
(optional)**。留空會使用預設 instance ID。名稱可包含中文、英文、數字與空格，
不同 instances 也可使用相同名稱。Setup 標題與 Workflow Target 選項會立即更新；
原始 **Instance ID** 仍會顯示，收合時也能辨識。Target 選項會保留可用的型號與
序號資訊。Sequence 原本顯示 target 的摘要會顯示名稱與 ID；action 與參數摘要
維持原有格式。名稱隨 Template 保存並於載入時還原；離開欄位或保存時會去除
前後空白。清空或只輸入空白會恢復顯示 ID。忙碌時無法編輯名稱。修改名稱不會
改變 Workflow 引用、Simulation／Live 模式或已保存的 Live Resources。
Wavegen 即使尚未支援 runtime actions，仍可保存名稱。

數值欄位使用直接輸入及原生 ArrowUp / ArrowDown stepping；spinner 按鈕隱藏。

### 5.1 Meters Setup

Meters 的 **Measurement Setup** 預設展開，可用 **− / +** 隱藏或顯示量測與觸發
設定，不影響 Background Streaming 或 Live Device。這些設定依所選模式供 Foreground
或 Background 使用。目前提供：

- Measurement：**DC Voltage** 或 **DC Current**。
- Range Mode：**Auto** 或 **Manual**。
- Manual Range：由已設定的 meters tool capability 提供的固定選項，不是任意
  文字值。
- NPLC：目前 UI 暴露的標準選項為 `0.02`、`0.2`、`1`、`10` 與 `100`。
- Auto Zero：**On**、**Off** 或 **Once**。
- 先選擇是否 **Enable Background Streaming**。前景只使用 **Single**，
  每次 Measure 觸發一次量測並取得一筆讀值。
- 背景可選 **Software**、**Immediate**、**External**、**Software Custom**、
  **Immediate Custom** 與 **External Custom**。取得型號能力後，不支援的模式無法選取。
- 背景 Custom 模式提供 **Sample Count**、可選的 **Buffer Drain Size** 與
  **Allow Buffer Overflow Risk**。在 Background 設定 **Trigger Count**；
  Simple 模式則設定 **Max Samples**。已知的讀值記憶體容量會顯示於畫面。
  預期筆數超過容量時會顯示 **Reading memory exceeded**，須明確接受溢位風險。
- External 模式另提供可選的 **Hardware Trigger Slope** 與 **Hardware Trigger
  Delay (s)**；未指定時沿用工具預設值。
- DC Voltage 的 DCV Input Impedance：**Not specified**、**Default**、
  **10 MΩ** 或 **Auto**。
- DC Current 的 Current Terminal：**Not specified**、**3 A terminal** 或
  **10 A terminal**。
- DC Voltage 與 DC Current 的 VM Comp Slope：**Not specified**、**Positive**
  或 **Negative**。Not specified 會保留 instrument 現有的 VM Comp 設定。

Measurement 欄位會固定顯示；不適用的欄位會 disabled。實際 model capability 與 numeric
limits 仍由 external meters-tool 最終驗證；Desktop 不會重新建立它的
capability database。Simulation 會使用 meter simulator profile 的 capability，
不會受已保存的 Live meter identity 影響；Live 才使用已保存的 identity。

在 Custom 模式勾選 **Allow Buffer Overflow Risk**，表示明確接受可能無法恢復的
資料遺失。勾選後即會顯示 **High Buffer Overflow Risk Accepted**，即使預期筆數
未超限或尚未取得能力資料也一樣。只要擷取速度超過 Worker 排空讀值記憶體的速度，
就可能遺失 Samples；較低 NPLC 可能提高此風險。反之，即使預期筆數超過容量，
只要及時排空，仍可能完整取得資料。預期超限本身不代表已發生 Overflow。

有限 Custom 擷取若遺失 Samples，即使所有預定 Trigger 已完成，Worker 仍可能
持續等待不足的 Samples，無法自然結束。這不一定代表程式已無法回應：Worker
仍可能接受既有 Workflow 或 Worker Stop 控制。請依需要使用這些控制結束作業；
Stop 無法恢復已遺失的資料。這些警告適用於 Simulation 與 Live。持續等待的現象
已在 Simulation 重現，尚未確認實體儀器是否有相同行為。

`summary.ok=true` 或 Process Exit Code 0 都不保證取得全部預期讀值。請一起核對
**Captured**、**Expected Readings**、**Stop Reason** 與 **Data Integrity**。
Allow Risk 不保證已啟用 Overflow Monitoring，Meters Setup 也沒有獨立的監測
控制項。沒有監測結果時，未偵測到 Overflow 不能作為沒有資料遺失的證據。

### 5.2 Live Resources

Live Resource 綁定到 Tool Instance，並保存於 machine-local Desktop
configuration，不會隨 Template 攜帶。可選的 last-known identity information
也保存在 local state 中供 UI 顯示；這些 cached identity 資訊不代表目前的
connection state 已被即時確認。

目前 Desktop 支援 **Meters**、**Powers** 與 **Scopes** 的 resource discovery。不要把
unsupported Tool Type 當成支援 discovery。請在 Setup 使用 resource controls
列出可用 resources、選擇 resource、**儲存資源（Save Resource）** 或 **清除資源（Clear Resource）**。

每個支援的 instance 都有獨立的 **VISA Backend**：**System VISA**（預設值，
包含舊版設定）或 **PyVISA-py (@py)**。先選擇 backend，再按 **List Resources**。
切換時會立即清空該 instance 的 resource 與 identity 草稿、discovery 結果與錯誤，
以及舊的 Powers Device Status，不影響其他 instances。按下 **儲存資源（Save Resource）** 前，
已保存的本機設定維持不變；按下後才一起保存 backend、resource 與 identity。
切換後請重新列出或手動輸入 resource，再保存；不同 backend 的地址不會自動轉換或
比對。未保存的變更會阻擋 Live run，並使先前的 Live Preflight 結果失效。

Backend 屬於本機設定，不會寫入 Template，也不影響 Simulation。若選定的 backend
無法使用，discovery 或連線會明確報錯，不會自動改用其他 backend。

Live Resource 永遠代表 machine-local real hardware。Simulation 不要求也不使用
Live Resource，但仍可為未來的 Live run 執行 List、編輯與 Save Resource，且不會
因此切換 Execution Mode。Desktop 不會在 local configuration 建立假的 simulator
resource。

Powers discovery 可能提供 canonical model ID。Desktop 將它保存在本機的
last-known resource identity，並以離線的 `powers-tool capabilities --model`
查詢可用的保護功能與通道。Setup 畫面不會為此連線儀器。若沒有 model ID 或
capability，Live 模式下請選擇並保存受支援的 Live Resource，才能新增保護設定。
Simulation 會針對既有 Powers simulator model 向 powers-tool 查詢 capability，
因此不需 discovery 或 saved resource 即可設定 Protection Setup。當目前 model
不支援時，Template 中既有設定仍會顯示。

#### 讀取並排空錯誤佇列（Read & Drain Errors）

展開 Powers、Meters 或 Scopes 實例的 **即時裝置（Live Device）**，在
**錯誤佇列** 按下 **讀取並排空錯誤佇列**。Meters 需要支援 `read-errors` 命令的 CLI。
Desktop 會離線檢查 CLI 及已知的 Meters 保存型號。Live 模式下，請選取並儲存搜尋到的
Scopes 資源，以便 Desktop 確認型號支援。

- **Simulation** 使用對應 Tool 的模擬器，結果顯示 **NO HARDWARE I/O**。
- **Live** 使用已儲存的 Live Resource 及 VISA Backend，即使 Resource 欄位目前
  顯示草稿。確認視窗會顯示已儲存的位址。讀取會從儀器佇列移除已回傳的項目，
  過程中不會執行 `*CLS` 或清除其他儀器狀態。

從 Workflow 啟動到停止與收尾完成，所有實例的按鈕都會停用。此診斷須手動操作，
結果僅顯示於 Setup。

結果依讀取順序顯示原始錯誤代碼和訊息。**佇列原已為空** 表示第一次讀取即確認
佇列為空。**已確認排空** 表示已讀取錯誤項目並確認佇列為空。**尚未確認排空**
表示已達 20 次讀取上限，仍未確認佇列為空。**失敗** 會顯示失敗原因並保留 Tool
已回傳的項目。如果讀取途中連線失敗，儀器有可能在回傳項目之前就已移除該項目。

### 5.3 Powers Protection Setup

Protection Setup 為選用設定。在 Powers Tool Instance 內，按 **Protection Setup**
旁的 **+** 展開預設收合的群組。Protection 欄位與 Device 區域一起展開／收合，
包含 Device Status、Refresh Status、Protection Summary、各通道保護狀態與
清除操作，以及相關提示與操作結果。Live Device、VISA Backend、Live Resource、
Resource Discovery 控制項與提示，以及 Remove Tool Instance 與其 Workflow 引用
限制提示都保持可見。收合會保留保護設定、runtime 狀態與操作結果，
不會讀取或操作儀器。勾選
**Use Protection Setup** 後即可編輯支援的欄位。整個 instance 共用一個核取方塊；
新的 instance 預設未勾選，所有欄位停用。單純勾選不會將任何 protection data
或核取方塊狀態寫入 Template。powers-tool 回報的所有通道，以及 Template 已設定
的通道，都會以對齊的固定列顯示。
每列提供 OVP Voltage、OCP、OCP Delay 與 OCP Delay Trigger。不支援的控制項
仍會顯示，但會停用。既有的不支援值會顯示提示並保留，保存時不會移除；
實際型號的支援能力與限制仍由 external tool 驗證。

數值欄位留白或選擇 **Unchanged** 表示保留儀器原有設定，不會寫入 Template。
只保存有設定的通道與欄位。開啟既有 Protection Setup 時，核取方塊會自動勾選。
清空某通道最後一項設定時，會移除該通道 record；全部清空後會回到空 setup，
取消勾選 **Use Protection Setup** 並停用欄位。取消勾選也會清除整個 Protection
Setup，所有欄位回到 Unchanged。通道列仍依 capability 顯示，不提供新增或移除
channel 的控制項。Protection Setup 與 Device Status 表格的 **Channel** 欄只顯示
通道數字；確認訊息與 clear plan 使用 **Channel 1**。Workflow Sequence 的 compact
summary 保留 **CH1**。

兩種 mode 下，有 Protection Setup 且被 Workflow 引用的 Powers instance 都會
先執行 Safe-Off、讀取 Protection Status，在 status clear 時逐通道套用設定，
之後才開始 Workflow。回報的 trip 會阻止執行；Orchestrator 絕不自動清除。
Final Safe-Off 仍會執行。Simulation 透過 powers-tool simulate/planning contract
執行這些操作，用來驗證 sequencing，不會進行真實 hardware I/O。若執行期間
偵測 trip 時也應讓 Workflow 失敗，請加入 **Power Protection Status** 與
**Assert**。

執行 Live 前，每個被 referenced 的 supported Tool Instance 都必須有已保存且
非空的 resource。同一次 run 中，不同 referenced instances 不可使用相同
resource。Live confirmation 會顯示每個 referenced instance 與 Tool Type、
已保存的 backend 與 resource，以及可用的 last-known identity。若 confirmation 後
backend 或 resource 改變，run 會被拒絕，必須重新確認。

若 DC Current 使用 **10 A terminal**，Live confirmation 也會要求確認實體
導線確實接在 10 A terminal。

### 5.4 Device Status

展開 Protection Setup 後即可看到 **Device** 區域與 **Device Status**。
**Live Device** / Live Resource 控制項位於下方，在 Simulation 與 Live 模式中
都保持可見，不受 Protection Setup 收合影響。執行模式 Badge 顯示於 Tool Instance 標題。
Device Status 只屬於 runtime，不會保存到 Template。
開啟 Setup 不會連線 Worker，也沒有 background polling。單一 **Protection Summary**
panel 集中顯示 aggregate Protection、OVP 與 OCP；讀取 status 前，這些值與各通道
的值都顯示 **—**，讀取後依回報顯示 CLEAR / OK 或 TRIPPED。通道列包含離線
model capability、Template 既有設定，以及成功 **Refresh Status** 實際回傳的通道；
Refresh 也會更新各列的值。Simulation 使用
simulator 通道，不需要 saved Live Resource。Live 使用已保存的 model identity
建立通道列，不會為此連線 hardware；capability 不可用時，仍保留已設定通道，
Refresh 前不會猜測其他通道。即使沒有已保存的 model identity，成功 Refresh 後
仍會顯示實際回傳的通道，回報 trip 的通道依原本規則可使用 Clear Protection。
切換 Execution Mode 會將舊值清除為 **—**，並顯示所選
mode 已知的通道。

Simulation 的 Refresh Status 會啟動 configured powers-tool simulate Worker，
不需要 saved Live Resource。每個 simulator 支援的 channel 都提供
**Generate Clear Plan...**，不要求 channel 已 trip。確認後，Orchestrator 會送出
simulated Safe-Off All 與選定 channel 的 `clear-protection`，接著直接 shutdown，
不會 reread status。結果會顯示 **PLAN GENERATED · SIMULATION**、
**NO HARDWARE I/O**。**Show Plan** 以簡短的操作預覽呈現目標通道、先執行
Safe-Off、清除 protection、output 保持 OFF 與沒有 hardware I/O。不會顯示 raw JSON
或儀器指令；沒有真實 protection latch 被改變。

Live 的 Refresh Status 會使用已保存的 backend 與 Live Resource 建立 temporary
Powers connection。Live Resource 或 backend draft 尚未保存時，必須先 Save Resource，才能使用
Refresh Status 或 Clear Protection。尚未保存 resource 或有未保存的 draft changes 時，
Device Status 會提示使用者在下方的 Live Resource 區域保存。

每個通道列都有固定的 Action 欄。沒有操作執行中時，simulator 支援的通道可使用
**Generate Clear Plan...**。Live 的 **Clear Protection...** 一直顯示，但在 Refresh
Status 前或通道未回報 OVP／OCP trip 時停用。回報 trip 且沒有 Workflow 或 manual
operation 執行中時才啟用，而且一定需要明確確認。Orchestrator 會先 Safe-Off All，
只清除選取 channel 的
protection latch，之後重新讀取完整 status。Clear Protection 不會修正造成 trip
的原因，也絕不會重新開啟 output。若 latch 仍為 tripped，UI 會顯示尚未解除；
若 reread 回報 output 仍為 ON，Desktop 會照實顯示並警告，不會隱藏或自動改變。

Workflow 或另一個 manual external operation 執行期間，Refresh Status 與 Clear
Protection 都不可使用。若該型號不支援 remote clear，請從儀器 front panel
清除 protection latch，再使用 **Refresh Status**。

### 5.5 Scopes Setup

Scopes Setup 為選用設定。新的 instance 所有欄位都是 **Unchanged**。
**Acquisition Setup** 與 **Channel Configuration** 預設收合，可分別使用標題旁的
**+ / −** 獨立操作。收合會保留設定，Live Resource 維持在兩個群組之外。
**擷取類型（Acquisition Type）** 可選 **一般（Normal）**、**平均（Average）**、
**高解析度（High Resolution）** 或 **峰值偵測（Peak）**；只有選擇 **平均（Average）**
時才能編輯 Average Count。各通道列提供 Input Coupling、Probe Ratio、Bandwidth
Limit、Waveform Invert 與 Channel Units。只保存、套用及回讀明確指定的值；留白或選擇
Unchanged 不會送出命令。

控制項使用 Scopes 提供的離線 capabilities。Simulation 使用 Scopes 預設的
Keysight DSOX4024A profile；Live 使用所選 Resource 一起保存的 canonical model ID。
資訊未知或不可取得時，會停用新的設定並顯示原因。不支援的欄位仍顯示但反灰；
切換型號會保留既有值。實際型號支援與儀器限制由 Scopes 在套用 Setup 時驗證。
回讀失敗、缺少資料或與要求的值不符時，執行結果會顯示 Setup FAIL。錯誤會指出 instance，
若為通道設定也會指出 channel。Setup 成功後才會開始執行 Workflow Step。
例如將通道 2 的 Waveform Invert 設為 On，其餘維持 Unchanged，Setup 會先回讀確認通道 2
已反相，再開始 Workflow。

