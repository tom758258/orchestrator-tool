# Orchestrator Tool Desktop 使用者指南

本指南描述目前 Orchestrator Tool Desktop 已實作且可使用的行為，讀者是
需要設定 external tools、建立 reusable Template、執行 Workflow，以及檢視或
匯出結果的 operator 與 engineer。

## 1. Overview

Orchestrator Tool Desktop 透過 reusable Template 協調獨立的 external tools。
你可以設定 Tool Type、建立 logical Tool Instance、編排有順序的 Workflow，
並以 Simulation 或 Live mode 執行。Run 完成後，Desktop 會顯示 committed
Results、Output Pages、Charts 與 Data，並可匯出目前可用的結果。

Desktop 是主要的 Workflow 操作介面。External tools 仍是獨立的程式與
distribution，不包含在 orchestrator-tool 內。

## 2. Requirements

- Application 以 Windows 為優先平台。
- Application 使用系統的 Microsoft Edge WebView2 Runtime。若未偵測到可用的
  WebView2 Runtime，Desktop 會在建立 Tauri WebView 前顯示 native warning，並可
  開啟 Microsoft 官方下載頁；application window 不會建立。若 availability check
  已通過但 main Tauri/WebView window 仍無法初始化，Desktop 會顯示包含實際 Tauri
  error detail 的 native startup error 並結束。Application 不會自動下載或安裝
  WebView2。
- Meters、Powers、Scopes 與 Wavegen 是獨立的 external tool distributions。
  請分別安裝與維護，再於 Desktop 設定實際 executable path。

本指南不假設目前存在 external tool 的 installer 或 package deployment 流程。

## 3. Main Desktop areas

Desktop 目前的 tabs 是：

- **Tools** — 設定各 Tool Type 的 executable path，檢查 availability 與
  compatibility。
- **Setup** — 建立 Tool Instance、編輯各 instance 的 setup，並在支援時
  保存或清除 local Live Resource。
- **Workflow** — 編輯有順序的 steps、驗證 Template、執行 Simulation 或
  Live、要求 graceful Stop，以及設定 CSV streaming。
- **Output** — 檢視 Last Run、execution results、Output Pages、Charts、
  Summary、Output Data，並進行 manual export。

Application 另有 **Appearance** 控制項可切換 Desktop theme，toolbar 提供
**New Template**、**Open Template**、**Save Template** 與 **Help**。Help 會在獨立的 application
window 開啟 bundled offline Desktop User Guide。

全域 **Execution Mode** selector 控制整次 Desktop execution，不是各 Tool Instance
各自選擇。Desktop 啟動時預設為 **Simulation**，New Template 或 Open Template
後也會回到 Simulation。醒目的 **SIMULATION · NO HARDWARE I/O** 或
**LIVE · REAL HARDWARE** 標示，以及每個 Tool Instance 上相同的 badge，會顯示
目前 target。Workflow 或 manual external operation 執行期間 selector 會鎖定。
Execution Mode 只屬於 session state，不會保存到 Template 或 local configuration。

Meters、Powers、Scopes 與 Wavegen instances 都會顯示此 badge。Badge 不代表新增
runtime 支援；即使 external project 本身提供 simulator，Orchestrator 目前仍不支援
Scopes 與 Wavegen Workflow actions。

## 4. 設定 external Tools

Executable path 屬於 Tool Type，由同一 Tool Type 的所有 Tool Instances 共用；
個別 Tool Instance 不會各自保存一份 executable path。

在 **Tools** 的 **Tool to add** 選擇尚未配置的 Tool Type，按 **Add...**，
再選擇 external tool distribution 提供的真正 executable。Desktop 會在保存 path 前驗證 executable manifest，以及它
是否符合預期 Tool Type 的 Worker compatibility。Tool ID 錯誤或 Worker 不相容
的 path 會被拒絕，且不會取代原本有效的 path。取消 picker 不會變更設定。
在 Tool card 使用 **Change Path...** 替換 path，或使用 **Remove Tool** 只移除
本機 executable configuration。移除 Tool 不會變更 Template instances 或
Workflow steps；該 Tool Type 會回到 Add 候選。

Cards 只顯示已配置 executable path 的 Tool Type，即使 path 為 **Missing**、
**Not a file** 或有 compatibility / manifest error，仍會顯示。未配置的 Tool
Type 會出現在 Add 候選。全部未配置時顯示 **No external tools configured.**；
全部已配置時停用 Add。Cards 顯示 availability、compatibility，並在可用時顯示原因。Desktop 不會搜尋
`PATH`、Windows registry 或任意資料夾，也不會靜默 fallback 到其他 executable。

若 external tool 以 PyInstaller `onedir` 形式發行，operator 應選擇該
distribution 裡真正的 executable。Orchestrator Tool 不會搬移或複製 executable
或其 `_internal` 目錄。

## 5. Setup 與 Tool Instances

Tool Instance 是保存於 Template 中的 logical、具名稱的 instance。一個
Template 可以有多個相同 Tool Type 的 instances，每個 instance 有自己的
setup values。Tool setup 屬於 Template；machine-specific executable paths 與
Live Resources 不屬於 Template。

**Add Tool Instance** 只提供在 Tools 已配置的 Tool Type，包括 Missing 或 Error
狀態。沒有已配置的 Tool Type 時，新增 instance 會停用。既有 instances 即使
對應 Tool Type 未在本機配置，仍會顯示並附上警告；重新配置後警告會消失。

數值欄位使用直接輸入及原生 ArrowUp / ArrowDown stepping；spinner 按鈕隱藏。

### 5.1 Meters Setup

目前 Meters Tool Instance 的 Setup 提供：

- Measurement：**DC Voltage** 或 **DC Current**。
- Range Mode：**Auto** 或 **Manual**。
- Manual Range：由已設定的 meters tool capability 提供的固定選項，不是任意
  文字值。
- NPLC：目前 UI 暴露的標準選項為 `0.02`、`0.2`、`1`、`10` 與 `100`。
- Auto Zero：**On**、**Off** 或 **Once**。
- Trigger Mode：**Single**（Template 仍存為 `software`）、**Software Custom**、
  **Immediate Custom** 或 **External Custom**。取得選定型號的 capability 後，不支援
  的模式會 disabled。
- Single 的每次 Measure 會送出一次 software trigger 並回傳一筆讀值；Software
  Custom 會送出 software trigger 並回傳一批資料；Immediate Custom 與 External
  Custom 的 Measure 不會送 software trigger，而是取回 Meter Worker 已產生或接下來
  到達的下一批 ordered samples。
- 所有 Custom 模式都會顯示 **Sample Count**、可選的 **Buffer Drain Size**，以及
  **Allow Buffer Overflow Risk**。Trigger Count 由 Workflow 計算，不能編輯。UI 會
  顯示目前型號的 reading memory，當 planned acquisition 超過記憶體時提出警告；
  NPLC 越低 acquisition rate 越高，buffer drain 跟不上的風險也越高。
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

### 5.2 Live Resources

Live Resource 綁定到 Tool Instance，並保存於 machine-local Desktop
configuration，不會隨 Template 攜帶。可選的 last-known identity information
也保存在 local state 中供 UI 顯示；這些 cached identity 資訊不代表目前的
connection state 已被即時確認。

目前 Desktop 支援 **Meters** 與 **Powers** 的 resource discovery。不要把
unsupported Tool Type 當成支援 discovery。請在 Setup 使用 resource controls
列出可用 resources、選擇 resource、**Save Resource** 或 **Clear Resource**。

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

### 5.3 Powers Protection Setup

Protection Setup 為選用設定。展開 Setup 中的 Powers Tool Instance，勾選
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
resource。Live confirmation 會顯示 referenced instances 與 resources；若
confirmation 後 resource 改變，run 會被拒絕，必須重新確認。

若 DC Current 使用 **10 A terminal**，Live confirmation 也會要求確認實體
導線確實接在 10 A terminal。

### 5.4 Device Status

Protection Setup 下方的 **Device** 區域先顯示 **Device Status**，再顯示
**Live Device** / Live Resource 控制項；Simulation 與 Live 模式的順序相同。
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

Live 的 Refresh Status 會使用 saved Live Resource 建立 temporary Powers
connection。Live Resource draft 尚未保存時，必須先 Save Resource，才能使用
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

## 6. Workflow Editor

Workflow editor 用來建立有順序的 steps。目前的 step types 是：

- **Assert** — 檢查 condition，不成立時使 Workflow failure。
- **Set Variable** — 建立或更新 Workflow variable。
- **Output** — 將值發布為 final workflow result column，不控制 Powers output。
- **Wait** — 等待指定時間。
- **Tool Action** — 對設定好的 Tool Instance 執行 action，例如 Powers set、
  output action 或 Meters measurement。
- **For** — 依 exact decimal range 重複執行 body。
- **While** — 在 condition 為 true 時重複執行 body。

在 **Steps** panel 點擊 **Workflow**、**Powers** 或 **Meters** 標題，可獨立展開
或收合該分類。展開時顯示 **−**；收合時顯示 **+** 並隱藏該分類的 step buttons。
App 開啟時三區預設全部展開；此狀態不會保存於 Template。

Steps 可以放在 root workflow 或 loop body 中。使用 step properties 編輯選取的
step；需要先檢查目前 Template 時可使用 Validate，Simulation 與 Live 在 run
啟動時也會驗證 Template，因此先按 Validate 有用，但不是獨立的 run 必要條件。

在 **Sequence** 點擊 step 可單選；**Ctrl+Click** 加入或移除個別 step，
**Shift+Click** 從選取起點選取連續範圍。多選只限同一 sibling list：root
steps，或同一個 For／While 的 body。在另一個 list 使用 Ctrl／Shift 點擊時，
會改為該處的新選取。**Properties** 只可編輯單一 step；多選時顯示選取數量。

拖曳 step 旁的 handle 可在同一 list 內排序；目標上方或下方的線表示插入位置。
拖曳已選取的 step 會一起搬動整個 selection，包括不相鄰的 steps，並保持彼此
原本的相對順序。拖曳接近 Sequence 上下邊界時會自動捲動。不能在 root 與 loop
body 間，或不同 body 間拖曳。**Up**／**Down** 也會將 selection 移動一個位置；
任何選取 step 已碰到該方向邊界時會停用。對已選取 step 按 **Delete** 會刪除整個
selection；對未選取 step 按 Delete 只刪除該 step。刪除 loop 也會刪除其 body。

焦點位於 Workflow editor 時，**Ctrl+C** 複製選取的 steps，**Ctrl+V** 貼到
最後一個選取 step 後；沒有 selection 時貼到 root 最後。貼上的 steps 會成為
新 selection。複本在這次 application session 內可重複使用；文字與表單控制項
保留原生 clipboard 行為。Workflow busy 時仍可選取與 Copy，但 Drag、Up／Down、
Delete 與 Paste 會停用。若後續 steps 引用先前結果，排序後可使用 **Validate**
檢查。

### 6.1 Input values 與 data flow

Editor 目前的 InputValue 選項是：

- **Fixed value** — literal value。
- **Variable** — Workflow variable 的目前值。
- **Previous step result** — 較早且可見的 step result。目前 UI 會提供先前
  Tool Actions 的 results。
- **Calculation** — 一個左 operand、一個 operator 與一個右 operand。
- **Elapsed time** — runtime elapsed-time value。
- **Timestamp** — runtime timestamp value。

Set Variable 會建立或更新 variables。Previous step result 只能引用目前 lexical
scope 中較早且可見的 step。Calculation 使用 arithmetic 與 comparison
operators。Assert 與 While 提供 `==`、`!=`、`>`、`>=`、`<`、`<=`；其 Fixed value
operand 可選 Number 或 Boolean。Equality 可比較 boolean（例如 `true == false`）
及其他 JSON 值，且不進行型別轉換；arithmetic 與大小比較僅接受數值。
Calculation 不是任意 nested expression tree。

只有 Output step 會建立 ResultRow column；Input value 被引用本身不會使它成為
result column。

#### Power Set Output

加入 **Power Set Output** 可設定通道的 Voltage、Current Limit，或同時設定兩者。
Channel 為必填；兩個設定值至少須選取一項。使用核取方塊加入或移除設定值。
已選取的設定值可使用固定值、變數、先前步驟結果、計算、經過時間或時間戳記。
Voltage 與 Current Limit 解析後必須是數值，否則 Powers action validation 會失敗。
**Current Limit** 是電源供應器的輸出電流限制設定值，單位為 A。
Set Output 不會啟用通道輸出；需要啟用時，另加 **Power Output ON**。

含有 **Power Set Voltage** 的既有 Template 仍可編輯，儲存後也會保留原 action。
新建步驟使用 **Power Set Output**。

#### Power Protection Status

加入 **Power Protection Status** 可讀取 protection trip 狀態，不會改變儀器設定。
Channel 可選 **All** 或指定正整數通道。結果提供 **Protection Tripped**、
**Over Voltage Tripped** 與 **Over Current Tripped**。只要過電壓或過電流
protection 任一觸發，Protection Tripped 即為 true。實際型號支援由 Powers Tool
驗證。

若 trip 時需要讓 Workflow 失敗，請在 Power Protection Status 後加入 **Assert**：
左側選 **Previous step result → Protection Tripped**，運算子選 `==`，右側選
**Boolean → False**。Status 本身不會停止 Workflow、清除 protection 或修改電源
供應器。

### 6.2 For

For step 具有 **Start**、**Stop**、**Step**、loop variable 與 body。

- 當 step grid 能到達 Stop 時，Stop 會包含在執行範圍內。
- Positive 或 negative direction 必須與 Start、Stop 的方向一致。
- Zero Step 無效。
- Start 與 Stop 相等時執行一次。
- Loop nesting 最多 5 層。

For ranges 使用 exact decimal range semantics，而不是 floating-point tolerance。
Range 依設定的 step 評估；若 Stop 無法由 step 到達，不會為了湊整而額外執行一次。

### 6.3 While

While condition 會在每次 iteration 前判斷。Iteration limit 可以是：

- 正的 finite `max_iterations`；或
- **Unlimited**，表示不設定 finite iteration limit。

若 condition 一開始就是 false，body 執行 0 次。Unlimited While 目前只允許
在 top-level，body 不可為空，可以包含 finite nested loops，但不可再包含另一個
Unlimited While。

Simulation 目前不允許 Software Meters **Measure** 位於 Unlimited While 內，
因為無法建立 finite sample bound。對該 Simulation workflow 設定 finite
`max_iterations`，或在適合的情況下使用 Live。Live 的 Software Meters Measure
可以位於 Unlimited While 內，且不會設定 finite `max-samples` limit。

所有 Custom trigger mode 在 Simulation 與 Live 都需要 finite maximum trigger
count。計算時會加總同一 Tool Instance 的每個 Measure occurrence，並將各 occurrence
乘上外層 For iteration counts 與 finite While `max_iterations`。Custom Measure 位於
Unlimited While 內時會被拒絕。Trigger Count 與 Sample Count 各自沿用 meters-tool
目前的 1 到 1,000,000 限制；Orchestrator 不另外加入「總讀值最多 100 萬」的限制。
Software Custom 與 External Custom 在 While 提早結束時可能留下未使用的 planned
triggers。Immediate Custom 不同：Worker session 啟動時就會開始完整的 planned
acquisition，因此 Workflow 即使提早結束，後續 planned Measure 所對應的 readings
也可能已經取得；尚未被 Measure 消費的 readings 會在 Worker cleanup 時捨棄。

### 6.4 Graceful Stop

Run 進行中，operator 可選擇要停止的 loop，再按 Stop。這是 graceful loop stop，
不是立即終止目前 step：

1. Active innermost iteration 會執行到 successful commit point。
2. 之後 unwind 指定的 loop。
3. Parent loop 或 root workflow 可以在 unwind 後繼續執行。

若目前 iteration failure，failure 優先於 Stop request。Stop 不是 Pause、Resume
或 Hard Cancel，也不會單獨把整個 run 自動標成 cancelled。最終 run status 仍依
一般 Workflow success rules 決定。

### 6.5 Output Pages

Output step 有 name 與 Page。同一 Page 的 Outputs 形成一個 dataset 的 columns；
不同 Pages 是獨立 datasets，nested loop 也可以擁有自己的 Page。

每個 Page 綁定一個固定的 owning lexical loop path。不同 lexical loop paths 不可
共用同名 Page。Page name 同時要符合 CSV filename stem 與 Excel worksheet name
限制，因此兩種 export format 會套用相同的命名限制。

Custom Meters Measure 的每個 Measure step 會產生一個 batch。Output 直接
引用該 step，或 Calculation 引用該 step 時，會逐一解析每個 sample。該 Page 的
logical row 會依 batch size 展開，同 Page 的 scalar Outputs 會複製到每個 expanded
row。多個 Outputs 可以使用同一個 Measure batch，但同一 Page 不可組合兩個獨立的
Measure batches。Assert、Set Variable、While condition 與 Tool Action binding 不
支援 batch-dependent values。

Expansion 只影響所屬 Page，且會維持 staged 狀態直到 owning scope 或 iteration
成功。CSV streaming、manual CSV/XLSX export 與 Charts 直接使用展開後的 committed
rows，不會再做第二次 expansion。

### 6.6 Show Message

**Show Message** step 會在 Workflow 執行時將文字寫入 Messages Panel。它唯一的用途
就是輸出訊息：不是 Popup、不是 Assert，也不是 Output Page，因此不會為你的資料、CSV
或 Charts 增加欄位。

- **Target Message** 可選擇 **Message 1**、**Message 2** 或 **Message 3**，預設為
  Message 1。
- **Content Fields** 構成訊息內容。每個 step 最少 1 個、最多 10 個 field，預設建立
  1 個空白 String。可使用 **Add Field** 與 **Delete Field** 調整數量，Fields 依畫面
  順序串接。
- **String** field 為自行輸入的文字，最多 256 個字元。
- **Output** field 顯示某個 Output step 的值。下拉選單顯示 Output 名稱，且只提供位於
  目前 step 之前、在當前 loop scope 內可見的 Outputs。Show Message 的 Output 必須是
  單一數值，不支援 Custom Meters batch。若參考的值不是單一數字、文字或 Boolean，該
  step 會明確報錯，不會寫出部分訊息。
- **Newline** 會在該 field 之後換行。每則訊息結尾一定會自行換行，因此兩個 Show
  Message step 不會黏成同一行，最後一個 field 也因此不需要 Newline checkbox。

**Message Preview** 會在編輯時顯示組合結果。Output field 以名稱作為佔位符號，因此不必
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

## 7. Run Simulation

執行 Simulation 前，先為每個 referenced external executable 完成設定，並確認
manifest 與 Worker compatibility checks 通過。需要明確檢查 Template 時可先
使用 Validate；run 啟動時也會驗證 Template。

在 Execution Mode 選擇 **Simulation**，並使用唯一的 **Run Simulation** button。
Simulation 不需要 Live Resources，會使用 external Workers 的 simulate contract，
不應操作實體 hardware。Powers Protection Setup 與 final Safe-Off 仍會送到
powers-tool 進行 simulation 或 planning；這是 orchestration validation，不是
Live hardware validation。前述 Unlimited While 加上 Meters Measure 的限制仍然適用。

## 8. Run Live

在 Execution Mode 選擇 **Live** 後，同一個 Run control 會變成 **Run Live**。
開始 Live 前，Desktop 會：

- 確認 referenced Tool Instances；
- 取得已保存的 Live Resources；
- 拒絕尚未保存的 Live Resource draft changes；
- 顯示列出每個 referenced instance 與 resource 的 Live confirmation；
- 提醒 Live mode 可能改變 Powers outputs；以及
- 對適用的 Meters setup 額外顯示 10 A terminal warning。

請在確認前檢查畫面中的 resources 與連接中的 hardware。Run 會再次驗證 resource
仍與確認時完全相同。Resource 改變或重複使用會使 Live execution 被拒絕，並要求
重新確認。

目前支援 Live 的 external tools 是 Powers 與 Meters。Unsupported Tool Type 會
直接回報 error；目前 Desktop 不保證 Scopes 或 Wavegen 的 runtime execution。

### 8.1 Powers actions 與 cleanup

Powers Live actions 包括設定值，以及 `output-on` 與 `output-off` actions。Live
Powers write authorization 只存在於該次 Live run 的 runtime。

Run 結束時，以及 Workflow failure 或後續 Worker startup failure path，orchestrator
會在 Worker shutdown 前對每個已啟動的 Powers instance 要求 `safe-off`。Cleanup
failure 會使 run failure；若原本已有 Workflow failure，仍保留原始 failure。Temporary
runtime authorization file 只用於該次 run，並會 best-effort remove。

明確的 Powers `output-off` Tool Action 不會取代 run-level cleanup。Simulation
會在相同 cleanup 位置透過 powers-tool 送出 simulated Safe-Off，但不宣稱真實
outputs 已被改變。

## 9. Streaming CSV

Streaming CSV 在 Workflow 區域的 **Streaming** panel 設定，和 run 完成後再做的
manual export 不同。

Streaming 至少需要一個 Output。可選擇：

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
  會繼續。
- Workflow failure 或 Graceful Stop 後，已寫入的 committed CSV data 不會被刪除。
- Streaming 不產生 XLSX。
- Run 進行中會鎖定 streaming settings。

## 10. Run Results

Run 後，Output 區域目前可顯示以下 visible sections：

- **Last Run Execution Results** — execution statuses 與 progress results；大量
  execution results 以 latest first 顯示並可分頁瀏覽。
- **Messages** — Show Message step 在執行時寫入的文字。
- **Last Run** — 目前 run 的 Output Pages 與 result workspace。
- **Charts** — 所選 Page 的 chart panels。
- **Summary** — 適用時顯示 numeric Count、Min、Max 與 Avg。
- **Output Data** — 所選 Page 的 committed rows，以 latest first 顯示。

### 10.1 Last Run

Desktop 只在 memory 中保留一個 **Last Run**，沒有 Run History、database 或 SQL
storage。

Run 開始時 Desktop 會保存該次 run 的 Workflow snapshot。之後修改目前 Workflow
不會重新解讀 Last Run。Open Template 會清除 Last Run；**Clear Last Run**
會移除目前 memory 中的 result 與 snapshot。

Last Run 也會保存該次 run 開始時的 Execution Mode。之後切換目前 selector，
Last Run 的 Simulation 或 Live badge 不會跟著改變，因此 simulated success 不會
被呈現為 real-hardware success。

若 run 沒有完整成功，committed rows 仍會作為 partial results 保留；execution
停止後可以 manual export。

### 10.2 收合結果面板

**Last Run Execution Results** 與 **Messages** 的標題右側各有 `+ / −` 控制。兩者
預設皆為展開，且可各自獨立收合，互不影響。收合只改變顯示內容：不會移除 execution
資料、不會停止 run，也不會清除結果。重新展開後會回到原本的結果清單位置。

**Last Run Execution Results** 收合後仍保留標題、Execution Mode badge 與 execution
數量摘要；execution 清單與 Newer / Older 分頁會隱藏，直到再次展開。

### 10.3 Messages

**Messages** 收集 Show Message step 寫入的文字。它有三個互相獨立的 tab：**Message
1**、**Message 2** 與 **Message 3**，由 step 選擇要寫入哪一個。每個 tab 以 latest
first 依序保留自己的訊息，訊息內的換行也會保留。切換 tab 或收合面板都不會遺失訊息。

由於 loop 可能執行大量次數，每個 tab 僅保留最近 1,000 筆訊息。摘要列仍會顯示該次 run
產生的訊息總數，因此可以知道是否還有更早的訊息。

訊息屬於產生它的那一次 run。開始新一輪 run 會清空訊息；run 失敗或 graceful stop 則會
保留當輪已產生的訊息。**Clear Last Run**、New Template 與 Open Template 都會一併清除
訊息。訊息不會存檔，也無法 export。

### 10.4 Charts

Charts 使用 Apache ECharts 的 Canvas renderer。每個 chart 屬於一個 Output Page，
可繪製該 Page 的 numeric Outputs。一次 run 的所有 Pages 合計最多 8 個 chart
panels。

Execution 執行中只有 **Line** 支援即時更新。Execution 停止後，只要有 committed
numeric rows，即使 run 失敗，也可在 **Settings → General → Chart type** 選擇
**Line**、**XY Scatter**、**Column**、**Area**、**Bar**、**Combo**、**Histogram**
或 **Box & Whisker**。Line 顯示 Iteration 趨勢；Area 在折線下填色；Column
使用垂直分組長條；Bar 使用水平分組長條；XY Scatter 用來比較數值 X 與 Y
的關係。

Chart Settings 有五個 tabs：**General**、**Series**、**Axes**、**Analysis**
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
**X source** 可選 Iteration 或任一 numeric Output；只作為 Scatter X 的 Output
不必同時勾選為 Y series。**Display** 可選 Markers、Lines 或 Lines + markers；
Scatter 的 **Marker size** 與 **Line width** 接受有限且大於 0 的數值，並用於
顯示對應元素的模式。Scatter 保留原始 X/Y pairs 與 row order，包括非單調的 X；
Lines 依該順序連線。Scatter hover 依畫面距離判定；line 顯示可透過可見線段命中，
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

**Settings** 可設定圖表標題、**Show legend**、**Legend position**（Top、Bottom、
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
顯示 **Waiting for run to finish** 並隱藏 plot；Output selection、Settings、
Export PNG 與 Remove 會停用。它們不會載入即時 chart data，execution 停止後
自動使用新 run 的 committed rows 更新，不需手動 refresh。Run 開始時 panels
就保持可見，非 Line 立即進入 Waiting，即使第一個 progress update 尚未抵達。
新 run 的資料尚未可用時，Line 顯示 **Waiting for run data**，不顯示上一 run
的 plot，也不載入 chart data；資料可用後才開始即時更新。
**+ Add Chart** 仍建立 Line chart。**Open Template**、替換 workflow 與
**Clear Last Run** 會清除 chart session state。Chart settings 不屬於 Template data。

### 10.5 Data 與 Summary

**Output Data** 使用 committed ResultRows。大型 table 會使用 virtualization 顯示，
但 rows 仍保留，可供 charts 與 export 使用。

**Summary** 預設顯示 Count、Min、Max 與 Avg。**Columns ▾** 可分別控制這些欄位，
以及 Range（Max − Min）、Std Dev（σ）、2σ 與 3σ。Std Dev 為樣本標準差，
計算式為 `sqrt(M2 / (n - 1))`；2σ 與 3σ 為其倍數。只有一筆 sample 時，
三個 σ 欄位均顯示 `—`，Range 仍可顯示；至少兩筆且全部相同的資料其 Std Dev = 0。
欄位選擇僅為暫時的 presentation 設定。若 Page 沒有 numeric Outputs，則不會
顯示 numeric summary。

## 11. Manual export

Manual export 會在 run 不再 active，且目前 export scope 存在 committed Output
rows 時提供。Failed 或 incomplete run 仍維持原本的 failure/incomplete 狀態，
但可把已 committed rows 作為 partial results 匯出。

選擇 **Run Page** 或 **All Run Pages**，再選 **CSV** 或 **XLSX**：

- **Run Page / CSV** — 將選取的 Page 匯出為一份 CSV。
- **Run Page / XLSX** — 將選取的 Page 匯出為一個 worksheet。
- **All Run Pages / CSV** — 在指定 destination folder 中為每個 Page 建立一份 CSV。
- **All Run Pages / XLSX** — 建立一個 workbook，每個 Page 一個 worksheet。

Export 使用 committed ResultRows。XLSX cells 目前以 plain text 寫出，不會加入
formulas、embedded charts 或 native numeric cell types。All-Pages CSV export 不會
覆寫既有 Page CSV files。

Graceful Stop 本身不是 failure 或 cancellation。Execution 停止後，failure 或
incomplete termination 之前已 committed 的 rows 仍可 manual export；仍處於 staged
狀態、尚未通過 owning scope commit point 的 rows 不會被匯出。

## 12. Templates 與 local machine settings

Application 啟動時會建立 blank `Untitled` draft。目前 UI 沒有獨立的 `New` button。

- **Open Template** 載入既有 Template。
- **Save Template** 保存目前 Template。

Template 會保存：

- Template name
- Tool Instances
- Tool setup
- Workflow

Template 不會保存：

- executable paths；
- Live Resources 或 last-known resource identity；
- Simulation/Live mode；
- Last Run 或 committed results；
- chart session state；或
- runtime Powers authorization。

這個分離讓 Template 保持 portable，同時將 executable paths、resources 及其他
machine/runtime state 保留在 Desktop local configuration。

## 13. Theme

**Appearance** 支援 **System**、**Light** 與 **Dark**。Theme choice 是 Desktop
preference，不屬於 Template contract。

## 14. Common problems

### Tool shows Not configured

在 **Tools** 的 **Tool to add** 選擇 Tool Type，再使用 **Add...** 配置正確的
external executable。

### Selected executable is rejected

Executable 可能有錯誤的 manifest Tool ID，或 Worker 不相容。請選擇符合預期
Tool Type 的 executable。

### Executable shows Missing or Not a file

已保存的 path 不存在，或不是一個 file。請使用 **Change Path...** 選擇目前的
executable；Desktop 不會靜默搜尋替代檔案。

### Live Resource is missing

在 **Setup** 為 referenced Tool Instance 選擇或輸入 resource，並在執行 Live 前
保存。

### Live Resource changes are unsaved

使用 **Save Resource**，再重新開始 Live，讓 confirmation 使用已保存的 value。

### Duplicate Live Resource

同一次 Live run 中，不同 referenced Tool Instances 不可指向相同 resource。請
指定不同 resources。

### Simulation rejects Unlimited While with Meters Measure

設定 finite `max_iterations`，或在適合的情況下改用 Live mode。

### Manual export is unavailable

Manual export 需要 run 已經結束，且目前 export scope 存在 committed rows。Run
仍 active 時 export 會維持 disabled。Failed 或 incomplete run 可以把已 committed
rows 作為 partial results 匯出；若選取範圍為 zero-row，仍不提供 export。

### Streaming CSV failed

Stream write 或 flush error 會停止 CSV streaming，但不一定停止 Workflow execution。
已由 committed rows 寫出的 CSV data 會保留。

### WebView2 is missing

使用 native warning 的 Yes 開啟 Microsoft 官方 WebView2 下載頁，安裝或修復系統
Runtime 後重新啟動 application。若 availability check 通過後仍出現 Startup failed
對話框，請保留 Details 內容供診斷，並確認 Windows 受支援且 WebView2 已安裝並更新。

## 15. Safety notes

- Live mode 可能影響連接中的 hardware。
- 在 confirmation 前確認每個 Live Resource。
- Powers output writes 需要 Live confirmation 與 runtime authorization。
- Run-level Powers `safe-off` 是 cleanup behavior，不取代 external tool 或 instrument
  的 safety requirements。
- Meters DC Current 使用 10 A terminal 時，確認 physical lead connection 後再
  確認 Live。
- External tools 仍負責 instrument-specific limits 與 safety behavior。
