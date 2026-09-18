# orchestrator-tool

`orchestrator-tool` 是以 Rust 開發的 external tools 調度器，透過共用 Core 協調外部程式。

## 架構

- Core library（`src/lib.rs`）：共用調度與領域邏輯，不依賴 CLI 或 Desktop 顯示層。
- CLI binary（`src/main.rs`）：輕量工程 CLI，定位於設定、偵測、診斷與維護，並使用同一個 `orchestrator-tool` Cargo package 內的 Core。
- Desktop 應用程式：採用 Tauri 2，已提供 external tool 狀態、僅限目前 session 的有序 Sequence editor、點擊新增的 Step Palette、步驟順序調整、執行結果狀態、參數編輯、Template 載入／儲存、Simulation 與 Live Workflow 執行及完整 StepResult 顯示。

專案部署以 Windows-first 為原則，同時在合理範圍內維持 Core 的平台中立。Core 已定義支援最多五層巢狀 For／While 的 ordered workflow domain、版本化 JSON template、可區分 occurrence 的結果與循序執行。Desktop 為 Powers 與 Meters 提供 Run Simulation 和獨立的 Run Live 操作，兩者共用 WorkflowRunResult 契約。Template schema version 1 與 Workflow 不保存 execution mode、resource、output authorization 或 safety cleanup state。CLI 不提供 workflow run command。

## Tool Setup 與 Workflow Template

Template schema 使用 `schema_version = 1`，測試定義分成兩部分：

```text
Template
├─ Tool Setup
└─ Workflow Sequence
```

Tool Setup 定義 run 前建立各 tool instance session 的設定，不是 Workflow Step。Workflow 則是在所需 Worker Ready 後依序執行的測試程序。Desktop 的 Tool Setup editor 位於獨立的 Setup tab，與 Workflow tab 分開。app-level 的 Open Template 與 Save Template 會一起保留這兩部分。

Meters Setup 支援 DC Voltage 與 DC Current，兩者皆提供 Auto / Manual Range Mode、Manual Range、NPLC 與 Auto Zero。DC Voltage 另提供 Input Impedance；DC Current 另提供 Current Terminal。DCV 不可攜帶 Current Terminal，DCI 不可攜帶 DCV Input Impedance。Manual mode 必須提供 Manual Range；Auto mode 忽略已儲存的 Manual Range，不產生 `--range` startup argument。Trigger 固定為 Software。

Run preparation 會驗證 setup，透過 Core Meters adapter 將其轉成 `meters-tool` startup arguments，再啟動 Worker。Simulation 與 Live 共用相同 setup semantics。Run 等待 Worker Ready 後才呼叫 Executor。`Meter Measure` 維持 runtime measurement action，不負責 session 設定。Core 檢查 setup 一致性；實際支援的 model 與數值設定仍由 `meters-tool` 驗證，Orchestrator 不建立 capability database。

頂層 `tool_instances` array 為必填，每個 entry 以 `id` 表示 logical instance、`tool` 表示 external tool type，並各自保存 `setup`。Meters 必須提供現有 setup 欄位，其他 tool type 目前使用 `{}`。同一份 Template 內的 instance ID 必須唯一，Workflow action 以 `target` 引用存在的 instance。開發階段直接調整 schema v1 的 wire structure。使用舊 setup 或 action 欄位的 Template 直接拒絕，不提供 migration 或 compatibility layer。

ExecutionMode、Live VISA Resource、runtime results、output authorization 與 safety cleanup state 均不屬於 Template。Live resource 存在 Desktop configuration，execution mode 則在每次 run 時選擇。DCI 的 Current Terminal 設為 10 時，Live confirmation 也會要求操作者確認量測線實際接在 10 A terminal。目前 Tool Setup 的驗證仍以 Simulation 為主；特定硬體型號與設定組合是否支援，仍以對應 external instrument tool 的驗證結果為準。

## Template Expression

Workflow run 現在回傳 Core `WorkflowRunResult`，包含依執行順序排列的 `StepExecution` 與 `ResultRow`。每筆 execution 保留原有 `StepResult`；Step ID 仍是穩定的 definition identity。可選的 `ForIteration` 或 `WhileIteration` metadata 保存所屬 step ID 與 zero-based iteration index，與 Step ID 及 Output columns 分離。既有 `for_iteration` 欄位維持不變，平行的 `while_iteration` 欄位用來識別 While occurrence；同一筆 execution 或 row 不會同時帶有兩種 metadata。

每個 Output 屬於一個具名 Page。Schema v1 要求每個 Output 明確包含 `id`、`name`、`page` 與 `value`。Desktop 新增 Output 時會將 Page 初始化為 `Results`，但 Page 是明確的 Template data，不是反序列化 fallback。Page 是獨立的 tabular dataset，各自擁有 flat ResultRows 與 Output columns，並綁定完整 lexical loop Step ID path，而不是只比較 nesting depth。不同 loop path 不可共用 Page，同一個 loop scope 可以建立多個 Page；Step ID 與 Output name 仍維持 workflow-global unique。

每個 root Output Page 在 root workflow 成功完成後 commit 一列 ResultRow，也適用於包含 For 或 While 的 workflow。Cells 沿用 `WorkflowOutput`，依該 Page 的 root Output Step 順序使用 Output names 作為 columns。完全沒有 Output 的成功 workflow 仍產生一列 empty root row。失敗或未完整完成的 workflow 不 commit root row。Root execution 與 row 都沒有 For 或 While iteration metadata。

Core 現在依 `NumericRange::iteration_count()` 的各個 index，循序執行 For body，每個 exact range value 都只取自 `NumericRange::value_at(index)`。Executor 在 bind loop variable 前，將 Decimal 轉換一次成 JSON number；runtime expressions 與 tool arguments 維持既有 JSON numeric 行為。Loop binding 只在 For scope 內有效：成功或失敗離開時，還原進入前的原值；原本不存在則移除。普通變數可跨 iteration 與 For 結束後持續修改。每次 iteration 開始前及離開 For 時都清除 body step outputs；body 可讀取先前 root outputs 與當次 iteration 已執行的 sibling outputs。

Body StepExecution 保留原本 Step ID，並附上 `ForIteration` metadata。Completion order 是先前 root steps、依 iteration 排列的 body occurrences、For aggregate root execution，最後才是後續 root steps。For 成功時保存 JSON null 作為 aggregate output。Body 失敗時，先記錄 failed occurrence，再記錄包含 body Step ID 與原始診斷的 For aggregate failure；剩餘 body steps、iterations 與後續 root steps 都不執行。既有 lifecycle 仍執行 Live Powers safe-off 與 Worker shutdown。

For 或 While 的 Page 會在其所屬 iteration 完整成功後 commit 一列 ResultRow，並附上該 row scope 最內層 loop 的 iteration metadata。Ancestor 與 descendant Page 各自獨立 commit：ancestor row 會等整個 ancestor iteration 成功，已 commit 的 descendant rows 則在後續 failure 或 Stop 後保留。Incomplete ancestor row 不 commit。Iteration metadata 不會增加 Output columns。

While 每次 iteration 前都使用目前 runtime variables 與 While 前可用的 root StepOutputs，評估 Assert-style comparison。While 不引入 loop variable；普通變數在各次 iteration 及 While 結束後持續保留。Body StepOutputs 沿用 For 的 lexical scope 與清除規則。若初始條件為 false，While 成功且不執行 body；condition resolution error 或 body failure 會使 aggregate 失敗。成功的 aggregate output 為 JSON null。While rows 沿用 For 的 staged row、progress event 與 successful-run CSV gate；若初始條件為 false，即使 body 有 Output 也不建立 synthetic row。

`max_iterations` 可以是正整數或 `null`。`null` 表示 unlimited iterations：While 會持續執行，直到 condition 變成 false、body 失敗，或使用者要求 graceful Stop。Unlimited While 至少必須包含一個 body step。有限上限在完成剛好該數量的成功 body execution 後，While 會再評估一次 condition：若為 false 則成功，若仍為 true 則以 `While reached max_iterations while condition is still true` 失敗。它不是預期 iteration 數量，也不是 progress percentage。Desktop 新增 While 時預設為 1000，並提供明確的 Unlimited 選項；畫面顯示 While identity、從 1 開始的 iteration 資訊與 Running 狀態，不顯示百分比；For 的呈現維持不變。實際 external tool 的限制仍適用。

Meters capacity 會依每個 instance 個別計算。有限的 measurement bound 會保留原本直到 shutdown 的額外 sample。Live 支援 Unlimited While 內的 Meter Measure，不傳 `--max-samples`。Run Simulation 不支援 Unlimited While 內的 Meter Measure；Simulation 請使用有限的 Max iterations。

While 重用既有 comparison operand 與 operator，不新增 equality、boolean tree、break、continue 或 timeout semantics。Template schema v1 的 `max_iterations` 欄位必須存在：正整數表示有限上限，明確的 `null` 表示 Unlimited；Unlimited While 只允許在 top level，省略 `max_iterations` 為無效 Template。有限上限表示如下：

```json
{
  "type": "while", "id": "warm-up",
  "left": { "source": "variable", "variable": "temperature" },
  "operator": "less-than",
  "right": { "source": "literal", "value": 80 },
  "max_iterations": 1000,
  "steps": []
}
```

Core For Step 使用 static decimal numeric range，由 `start`、`stop` 與非零 `step` 定義。遞增 range 必須使用正 step，遞減 range 必須使用負 step。Stop 正好落在 step grid 時包含該值：`0 -> 0.3 step 0.1` 共四次 iteration。非 grid 的 stop 不會被越過：`0 -> 0.35 step 0.1` 同樣止於 `0.3`。Start 等於 stop 時，任何非零 step 都只有一次 iteration。

`NumericRange` 統一負責 exact count 與 `value_at(index)`；超出範圍回傳 `None`，不配置完整 value list。只有 For range 使用 `rust_decimal::Decimal`（96-bit mantissa、scale 0–28）。除相同 endpoint 外，正規化後的輸入必須能以共同 decimal scale 表示，否則 construction 回報 representable-domain error。Count 使用 exact scaled-integer division 並檢查是否可放入 `usize`，不使用 floating-point tolerance 或經 rounding 的 decimal division。Expression arithmetic 與 measurement value 維持原有型別。

Template schema v1 的 range 值只接受 exact decimal string；JSON number 會被拒絕，無效或無法精確表示的 decimal string 會回報解析錯誤。不保證保留尾端零等文字格式。例如：

```json
{
  "type": "for", "id": "sweep", "variable": "voltage",
  "range": { "start": "0", "stop": "0.3", "step": "0.1" },
  "steps": []
}
```

Desktop 現在可使用 Template schema v1 建立、載入、編輯、驗證、儲存最多五層的巢狀 For／While，並以 Simulation 或 Live 執行。Range 欄位全程保留 decimal string。巢狀 Sequence editor 的 root／body Step 只能在各自清單內移動；palette 會顯示插入位置，只有在深度五時才停用繼續加入 For 與 While。Tool Setup 使用偵測與 Live resource confirmation 皆包含 body ToolAction。

Input suggestions 遵循 Core lexical scope：ancestor 中在 descendant loop 前已存在的 StepOutputs 與 variables 對 descendant 可見，同一次 iteration 的先前 sibling outputs 也可見。每層 For 另提供自己的 loop variable；While 沒有 loop variable。Child locals 與 StepOutputs 不會洩漏到 ancestor 或 sibling scope，新引入的 For loop variable 也不會洩漏（原先同名 variable 會恢復）；對 inherited ordinary variable 的更新則可保留。會產生 row 的 While 可能執行 0 次。

Core `execute_workflow_with_events` 與 `run_workflow_with_events` 可在執行期間通知 caller 已完成的 `StepExecution` 與已 commit 的 `ResultRow`。Desktop Simulation 與 Live 使用 Tauri Channel，逐步更新 Execution Results 與 Output table；每個相關 scope 的成功 iteration 都在真正 commit 後才通知。Command 失敗時保留 partial progress 供檢視；最終 command result 仍是 authoritative `WorkflowRunResult`。Manual export 必須等 workflow 成功完成後才能使用。Pause 與 hard cancel 尚未支援。

Desktop 可選擇在 Simulation 或 Live run 期間串流 CSV，預設為關閉。執行前可選擇 **Selected Page** 並指定一個新的 CSV，或選擇 **All Pages** 並指定 folder；執行與 Live confirmation 期間這些設定會鎖定。All Pages 會建立一個 unique timestamped run folder，每個 Page 各一個 CSV。Headers 在 execution 前寫入並 flush；每筆 committed row 只 append 並 flush 到所屬 Page 的檔案。Selected Page 模式仍會在記憶體保留其他 Pages 的 rows。Pre-run 建立失敗會阻止 execution，All Pages 的半成品 run folder 會 best-effort 清除；execution 開始後的 write／flush failure 則停止 streaming，但 workflow 繼續，且已 streamed／committed 的檔案會保留。Graceful Stop 同樣保留已 commit 的資料。Streaming XLSX 不支援。Streaming destination 與 status 屬於 Desktop session state，不在 Template 內；flush 不保證斷電時的資料耐久性。

執行中的 For／While 在觀察到 body 進度後，可從 Workflow 控制區或 Output 檢視對目前 loop 或 ancestor loop 發出 targeted **Stop**。Stop 會等待目前 innermost iteration 到成功 commit point，再 unwind 到指定 loop；停止 inner loop 後 parent 可繼續，停止 ancestor 則略過剩餘 descendants，且 incomplete ancestor Page row 不 commit。Iteration failure 優先於 Stop。Powers 清理與 Worker shutdown 照常執行。Stop 並非 hard cancel。

兩個 Desktop run command 都回傳保留 iteration metadata 與 committed ResultRows 的 `WorkflowRunResult` DTO。Execution Results 可區分重複的 For／While body occurrence，iteration 顯示從 1 開始；root execution metadata 維持 null。Output 頁直接使用 ResultRows，呈現 root 單列或 For／While iteration 多列。Iteration 欄只屬於 UI metadata，不是 Workflow Output。

Desktop 只在記憶體中保留一個 Last Run。Last Run 會綁定該次 execution 使用的 Workflow definition，因此編輯目前 Workflow 不會重新解讀或移除 Last Run results；開啟另一份 Template 或建立 new draft 則會清除 Last Run。

Desktop Charts 使用 Apache ECharts Canvas 折線圖與 Page-local workspace。Last Run Page tabs 依據 run snapshot，同步切換 Charts、Summary 與 Data，不受目前 Workflow 編輯重新解讀。每個 panel 綁定一個 Page，只能選擇該 Page 的 numeric Outputs；所有 Pages 合計最多 8 個 panels，切換 Page／tab 後保留 session 設定。新 Last Run 保留相容 panels；若沒有剩餘圖表，只有第一個 Page 有 numeric Outputs 時才建立一張預設圖表。保留軸標題與單張 PNG 匯出，圖表設定不儲存於 Template。

大型資料使用依像素寬度調整的 display decimation，完整 committed ResultRows 仍保留在記憶體。Hover 顯示 exact raw iteration／value，包含未繪出的資料點。X 軸是 Page 從 1 開始的 ResultRow sequence；Chart 與 CSV 維持 chronological，Data 顯示 newest-first。Run Page 匯出跟隨目前 Last Run Page tab，All Run Pages 匯出不變。

Output table 對大型 Last Run Pages 使用虛擬化 UI rendering；完整 committed ResultRows 仍保留在記憶體，供 Chart、CSV 與 XLSX 匯出使用。
每個 Run Page 也能從自己的 committed ResultRows 顯示 numeric Count / Min / Max / Avg summary。

Manual export 支援 Run Page 匯出為 CSV 或單一 worksheet XLSX，也支援 All Run Pages 匯出為多個 CSV 或單一 XLSX workbook（每個 Page 一個 worksheet）。CSV 與 XLSX 共用文字 cell conversion：string 不變、null 為空字串、其他 JSON 使用 compact 文字；目前不提供 formula、styling、chart 或 native numeric cell typing。Iteration metadata 不寫入檔案。匯出仍要求 authoritative final success 與至少一筆 committed row；Run Page 必須由該 Page 自己擁有 row，All Run Pages 則可由任一 Page 提供 row。Failed、cancelled 或 incomplete run 僅供檢視，backend 仍拒絕匯出。Break 與 continue 尚未支援。

Schema v1 的 Output Step 必須明確包含 `id`、`name`、`page` 與 `value`。`name` 不可為空白，且在同一 Workflow 中必須唯一；大小寫有區別，不進行 normalization。缺少 `name` 或 `page` 的 Template JSON 會在載入時被拒絕。

Core 的 `Workflow::project_outputs(&[StepResult])` 只收集 Output Steps，依 Workflow 中的 Step 順序回傳有序的 `WorkflowOutput`，並由 `WorkflowOutput` 提供 `name()` 與 `value()` 存取方法。若任何 Output Step 的結果缺少（missing）、失敗（failed）或取消（cancelled），則整個 projection 失敗。Projection 本身不負責保存結果，也不負責 CSV serialization。

Standard Dataflow 的 InputValue source 包含 `literal`、`variable`、`step-output`、`expression`，以及 schema version 1 中的兩種 runtime time source：

- `{"source":"elapsed-time"}`：從 Workflow execution 開始後計算的 monotonic 秒數，截斷至毫秒精度。計時從 Executor 的 runtime context 開始，也就是 worker preparation 與 CSV 建立完成之後。
- `{"source":"timestamp"}`：固定使用 UTC+08:00 的 ISO-8601 wall-clock timestamp，例如 `2026-09-15T12:34:56.007+08:00`，固定包含三位毫秒數字。

兩者都是在 resolve 時取值的普通 InputValue，可用於 Set Variable、Output 與 ToolAction binding。只有明確建立的 Output 才會成為 ResultRow／CSV column。Elapsed time 是 numeric value，可使用既有 numeric chart；Timestamp 是 string，不提供 datetime chart axis。ExpressionOperand 尚未支援這兩種 time source。

Template schema version 1 使用既有 Core domain，保存 Set Variable、Output 與 ToolAction binding 中的結構化 Expression 輸入。例如，`x * 2` 儲存為：

```json
{
  "source": "expression",
  "left": { "source": "variable", "variable": "x" },
  "operator": "multiply",
  "right": { "source": "literal", "value": 2 }
}
```

Operand 支援 `literal`、`variable` 與 `step-output`（例如 `{ "source": "step-output", "step_id": "meter-read-1", "pointer": "/value" }`）。Operator 支援 `add`、`subtract`、`multiply`、`divide`、`greater-than`、`greater-than-or-equal`、`less-than` 與 `less-than-or-equal`；不支援巢狀 Expression。儲存與載入會保留 operator、operand、識別字、JSON Pointer 與 Workflow Step 順序，不保存 runtime value。

Assert 是與裝置無關的 Workflow Step，schema v1 使用 `type: "assert"`、`id`、`left`、`operator`、`right` 與 `message` 欄位。它重用上述 Expression operand，但只接受四種 comparison operator；Core validation 會拒絕 arithmetic operator，以及引用非前置 Step 的 reference。比較結果為 true 時，Step 成功並以 boolean `true` 作為 output；結果為 false 時，Step 使用設定的訊息失敗，空白訊息則使用 `Assertion failed.`。Expression resolve error 會保留既有明確錯誤訊息。兩種 failure 都沿用既有 executor fail-fast，Live run 仍會使用既有 Power safety cleanup。Desktop 的 Assert Properties 共用 Calculation operand 與 Meter result field selector。Assert 不會建立 Workflow Output，也不會新增 CSV 欄位。


Instance 表示方式：Powers only 使用 powers-1；Powers + Scopes 使用 powers-1 與 scopes-1；單台 Meters 使用 meters-1；兩台 Meters 使用 meters-1 與 meters-2，兩者皆為 tool = meters，但各自保存 setup、綁定 Live resource 並啟動獨立 Worker session。Executable path 仍依 tool type 共用；physical resource 不保存在 Template。不同 Template 若使用相同 instance ID，會讀取相同 Desktop resource binding，Live run 前仍須確認。

Desktop Tool Setup 可新增 built-in tool instance，自動產生唯一 ID，並阻止刪除已被 Step 引用的 instance。Action editor 可選擇相容 instance；若不存在，先提示建立。Steps palette 分為 Workflow、Powers、Meters。Scopes／Wavegen 可宣告為 instance，但 runtime action 會回報 unsupported；本次沒有新增 Serial-tool、其他 runtime adapter、manifest-driven UI、plugin system 或 setup registry。

## Executable 設定

Core 可以載入由呼叫端指定的 TOML 設定檔，並用它覆寫 built-in portable executable path：

```toml
[tools]
meters = "D:/tools/meters-tool.exe"
powers = "D:/tools/powers-tool.exe"

[live_resources]
meters-1 = "USB0::VENDOR::METER_SERIAL::INSTR"
powers-1 = "USB0::VENDOR::POWER_SERIAL::INSTR"
```

Configured path 的優先順序高於 portable path。Configured path 不存在時會回報 missing，不會 fallback 到 portable path。Relative configured path 以設定檔所在目錄為基準解析。`tools list` 支援 optional 的呼叫端指定設定檔路徑，不會自動搜尋設定檔。

Desktop 應用程式透過 Tools tab 提供相同的設定能力：每個 built-in tool 都提供 Browse... 來保存 configured executable path，以及 Use Portable Default 來移除該 override。獨立的 Setup tab 提供 Add Tool Instance、Meters setup，以及每個 Powers／Meters instance 的 Live Resource、Save Resource／Clear Resource 與手動 discovery。選定的 resource 會在同一份 local configuration 保存 last-known manufacturer、model、serial 與 raw identity metadata。Desktop 將這些設定保存到 OS / Tauri application config directory（application bundle identifier 之下）的單一 `orchestrator.toml`。Tool Status、Run Simulation 與 Run Live 讀取同一份設定。設定檔不存在時使用 portable executable path。

可選的 `live_resources` table 會原樣保存非空白 resource 字串，不做 path 解析、掃描或 fallback。可選的 `live_resource_identities` table 只保存以 ToolInstanceId 為 key 的 last-known presentation metadata。這兩個 table 都不屬於 Template。Live preparation 會拒絕缺少或僅含空白的 resource，並在啟動任何 Worker 前驗證 executable、manifest 與 Worker compatibility。Simulation 仍可使用，且不需要 live resource。

Run Live 必須先經過操作人員確認，對話框會列出 Workflow 引用的 instance ID、tool type 與 resource，並警告即將以 Live mode 執行 external tools、可能改變電源輸出。Powers live writes 同時使用兩道授權：短生命週期的 Desktop runtime config 設定 Worker `settings.allow_output_writes=true`，runtime adapter 則為 Live output-affecting request 注入 `arguments.confirm_output=true`。執行結束後會 best-effort 刪除此支援檔案。

Live run 會對每個已啟動的 Powers instance，在 Worker shutdown 前嘗試 bounded `safe-off`，關閉所有通道，包括 Workflow 失敗或後續其他 Worker 啟動失敗的情況。Workflow 中明確的 Output OFF step 不會取代這道安全清理。Cleanup 失敗會讓 run 回報失敗，錯誤中同時保留原有 Workflow failure；Worker shutdown 仍會嘗試執行。Simulation 不會額外執行這項 Live cleanup。

實體硬體支援仍受各 external instrument tool 的 manifest 與 product support policy 約束。Live Powers／Meters Workflow 已進行部分真實硬體端到端驗證，包含電源安全清理行為。目前 Tool Setup 的驗證仍以 Simulation 為主，不代表所有硬體型號與設定組合都已完成實機驗證。Scopes 與 Wavegen 尚不支援 Live Workflow。

## External process 管理

Core 可以使用 arguments 啟動 generic external process，並提供 process ID、非阻塞狀態檢查、等待與強制終止能力。Standard input、output 與 error 維持 inherited。Managed process 被 Drop 時會 best-effort 終止並清理 child process。

Core 已提供 Common Worker process/session 與 local HTTP IPC 支援，CLI 已透過 `tools worker-check` 暴露針對 Powers 與 Meters 的 Worker diagnostic，Core 仍持有 process lifecycle 與 cleanup 責任。

## CLI

CLI 提供 command discovery、external tool listing 與 environment diagnostics：

```text
orchestrator-tool --help
orchestrator-tool --version
orchestrator-tool doctor
orchestrator-tool tools list
orchestrator-tool tools inspect <TOOL_ID>
orchestrator-tool tools worker-check powers
orchestrator-tool tools worker-check meters
orchestrator-tool --config <PATH> doctor
orchestrator-tool --config <PATH> tools list
```

`tools list` 會列出四個 built-in external tools，並顯示 executable path 的 `configured` 或 `portable` source，以及 `available`、`missing` 或 `not-file` status。Missing tools 是正常的 discovery 結果，不會使 command 失敗。設定檔錯誤與其他 discovery I/O error 會輸出到 stderr，並回傳非 0 exit code。

`doctor` 會顯示 application directory、configuration 狀態、四個 built-in external tools 的 status，以及 summary counts。Missing 與 not-file tools 是正常的診斷結果，不會使 command 失敗。設定檔錯誤與其他 discovery I/O error 會輸出到 stderr，並回傳非 0 exit code。`doctor` 不會執行 instrument-level diagnostics。

`tools worker-check powers` 會驗證解析出的 Powers executable 與 manifest，並執行 bounded simulate-mode `read-status` Worker diagnostic，不需要真實硬體。`tools worker-check meters` 會驗證解析出的 Meters executable 與 manifest，並執行 bounded simulate-mode software-trigger diagnostic，同樣不需要真實硬體。

## 開發

### Rust checks

使用 stable Rust，並在 repository 根目錄執行：

```text
cargo build --locked
cargo test --locked
cargo fmt --all --check
cargo clippy --locked --all-targets --all-features -- -D warnings
```

### Desktop 開發

Desktop 支援 System、Light 與 Dark 外觀偏好設定，預設的 System 會跟隨作業系統主題。

Desktop 應用程式位於 `apps/desktop`。

第一次設定 Desktop 應用程式，或 dependencies 變更後，請從 repository root 執行以下指令安裝 frontend dependencies：

```powershell
cd apps\desktop
npm.cmd install
```

每次啟動 Desktop 應用程式前不需要重新執行 `npm.cmd install`。

若只需啟動 frontend-only 開發伺服器，請在 `apps/desktop` 執行：

```powershell
npm.cmd run dev
```

`npm.cmd run dev` 只會啟動 Vite frontend development server。若要從 repository root 啟動完整的 Tauri Desktop 應用程式，請執行：

```powershell
cd apps\desktop
npm.cmd run tauri dev
```

Tauri commands、dialogs、configuration 與 workflow execution 等完整 Desktop 功能，請使用 `npm.cmd run tauri dev` 驗證。

在 `apps/desktop` 執行以下 frontend static checks：

```powershell
npx.cmd tsc --noEmit
npm.cmd run build
```

目前 CLI 已提供 tool listing、manifest inspection、environment diagnostics，以及針對 Powers 與 Meters 的 Worker diagnostic。
