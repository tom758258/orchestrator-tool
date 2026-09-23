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
- Application 使用系統的 Microsoft Edge WebView2 Runtime。若 WebView2
  不存在，Desktop 會在建立 Tauri WebView 前顯示 native warning，且不會啟動
  application window。Application 不會自動下載或安裝 WebView2。
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
**Open Template**、**Save Template** 與 **Help**。Help 會在獨立的 application
window 開啟 bundled offline Desktop User Guide。

## 4. 設定 external Tools

Executable path 屬於 Tool Type，由同一 Tool Type 的所有 Tool Instances 共用；
個別 Tool Instance 不會各自保存一份 executable path。

在 **Tools** 中使用 **Browse...**，選擇 external tool distribution 提供的
真正 executable。Desktop 會在保存 path 前驗證 executable manifest，以及它
是否符合預期 Tool Type 的 Worker compatibility。Tool ID 錯誤或 Worker 不相容
的 path 會被拒絕，且不會取代原本有效的 path。需要移除已保存的 path 時使用
**Clear Path**。

狀態區會顯示 **Not configured**、**Available**、**Missing**、**Not a file**
或 **Error** 等狀態，並在可用時顯示 compatibility 與原因。Desktop 不會搜尋
`PATH`、Windows registry 或任意資料夾，也不會靜默 fallback 到其他 executable。

若 external tool 以 PyInstaller `onedir` 形式發行，operator 應選擇該
distribution 裡真正的 executable。Orchestrator Tool 不會搬移或複製 executable
或其 `_internal` 目錄。

## 5. Setup 與 Tool Instances

Tool Instance 是保存於 Template 中的 logical、具名稱的 instance。一個
Template 可以有多個相同 Tool Type 的 instances，每個 instance 有自己的
setup values。Tool setup 屬於 Template；machine-specific executable paths 與
Live Resources 不屬於 Template。

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

UI 只會顯示符合目前 measurement 的欄位。實際 model capability 與 numeric
limits 仍由 external meters-tool 最終驗證；Desktop 不會重新建立它的
capability database。

### 5.2 Live Resources

Live Resource 綁定到 Tool Instance，並保存於 machine-local Desktop
configuration，不會隨 Template 攜帶。可選的 last-known identity information
也保存在 local state 中供 UI 顯示；這些 cached identity 資訊不代表目前的
connection state 已被即時確認。

目前 Desktop 支援 **Meters** 與 **Powers** 的 resource discovery。不要把
unsupported Tool Type 當成支援 discovery。請在 Setup 使用 resource controls
列出可用 resources、選擇 resource、**Save Resource** 或 **Clear Resource**。

執行 Live 前，每個被 referenced 的 supported Tool Instance 都必須有已保存且
非空的 resource。同一次 run 中，不同 referenced instances 不可使用相同
resource。Live confirmation 會顯示 referenced instances 與 resources；若
confirmation 後 resource 改變，run 會被拒絕，必須重新確認。

若 DC Current 使用 **10 A terminal**，Live confirmation 也會要求確認實體
導線確實接在 10 A terminal。

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

Steps 可以放在 root workflow 或 loop body 中。使用 step properties 編輯選取的
step；需要先檢查目前 Template 時可使用 Validate，Simulation 與 Live 在 run
啟動時也會驗證 Template，因此先按 Validate 有用，但不是獨立的 run 必要條件。

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
scope 中較早且可見的 step。Calculation 使用目前支援的 arithmetic 與
comparison operators，包括加、減、乘、除，以及 UI 顯示的 greater-than / less-
than comparisons。Calculation 不是任意 nested expression tree。

只有 Output step 會建立 ResultRow column；Input value 被引用本身不會使它成為
result column。

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
While 提早結束時，未使用的 trigger capacity 不需要補送。

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

## 7. Run Simulation

執行 Simulation 前，先為每個 referenced external executable 完成設定，並確認
manifest 與 Worker compatibility checks 通過。需要明確檢查 Template 時可先
使用 Validate；run 啟動時也會驗證 Template。

Simulation 不需要 Live Resources，會使用 external Workers 的 simulate mode，
不應操作實體 hardware。前述 Unlimited While 加上 Meters Measure 的限制仍然
適用。

## 8. Run Live

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

明確的 Powers `output-off` Tool Action 不會取代 run-level cleanup。Simulation 不會
執行這個額外的 Live safe-off sequence。

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

若 run 沒有成功完成，committed rows 仍可供檢查，但不能 manual export。

### 10.2 Charts

Charts 使用 Apache ECharts 的 Canvas renderer。每個 chart 屬於一個 Output Page，
可繪製該 Page 的 numeric Outputs。一次 run 的所有 Pages 合計最多 8 個 chart
panels。

大型 dataset 可能為了 chart presentation 而 decimate。Decimation 不會丟棄 raw
ResultRows；hover 仍使用 exact raw iteration 與 value。Chart X coordinate 是
Page row sequence。Chart 與 CSV 按 chronological 順序，**Output Data** 則以
latest first 顯示。

每個 chart 都有個別的 **Save image** 操作，可匯出 PNG。Chart panel settings
屬於目前的 Desktop session，不屬於 Template。

### 10.3 Data 與 Summary

**Output Data** 使用 committed ResultRows。大型 table 會使用 virtualization 顯示，
但 rows 仍保留，可供 charts 與 export 使用。

**Summary** 對適用的 numeric Outputs 提供 Count、Min、Max 與 Avg。若 Page 沒有
numeric Outputs，則不會顯示 numeric summary。

## 11. Manual export

Manual export 只在有 authoritative、successfully completed run 且存在可匯出的
Output rows 時提供。

選擇 **Run Page** 或 **All Run Pages**，再選 **CSV** 或 **XLSX**：

- **Run Page / CSV** — 將選取的 Page 匯出為一份 CSV。
- **Run Page / XLSX** — 將選取的 Page 匯出為一個 worksheet。
- **All Run Pages / CSV** — 在指定 destination folder 中為每個 Page 建立一份 CSV。
- **All Run Pages / XLSX** — 建立一個 workbook，每個 Page 一個 worksheet。

Export 使用 committed ResultRows。XLSX cells 目前以 plain text 寫出，不會加入
formulas、embedded charts 或 native numeric cell types。All-Pages CSV export 不會
覆寫既有 Page CSV files。

Graceful Stop 本身不是 failure 或 cancellation。若 Workflow 之後依一般 success
gate 正常完成，其 authoritative committed results 仍可匯出；failed 或 incomplete
run 不能 manual export。

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

在 **Tools** 中瀏覽到正確的 external executable，並保存 path。

### Selected executable is rejected

Executable 可能有錯誤的 manifest Tool ID，或 Worker 不相容。請選擇符合預期
Tool Type 的 executable。

### Executable shows Missing or Not a file

已保存的 path 不存在，或不是一個 file。請瀏覽到目前的 executable；Desktop 不會
靜默搜尋替代檔案。

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

Manual export 需要 authoritative successfully completed run 與可匯出的 committed
rows。Failed 或 incomplete run 仍可檢查，但不能 export。

### Streaming CSV failed

Stream write 或 flush error 會停止 CSV streaming，但不一定停止 Workflow execution。
已由 committed rows 寫出的 CSV data 會保留。

### WebView2 is missing

安裝系統的 Microsoft Edge WebView2 Runtime，然後重新啟動 application。

## 15. Safety notes

- Live mode 可能影響連接中的 hardware。
- 在 confirmation 前確認每個 Live Resource。
- Powers output writes 需要 Live confirmation 與 runtime authorization。
- Run-level Powers `safe-off` 是 cleanup behavior，不取代 external tool 或 instrument
  的 safety requirements。
- Meters DC Current 使用 10 A terminal 時，確認 physical lead connection 後再
  確認 Live。
- External tools 仍負責 instrument-specific limits 與 safety behavior。
