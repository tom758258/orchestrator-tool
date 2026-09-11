# orchestrator-tool

`orchestrator-tool` 是以 Rust 開發的多儀器調度器，預計透過共用 Core 協調外部儀器工具。

## 架構

- Core library（`src/lib.rs`）：共用調度與領域邏輯，不依賴 CLI 或 Desktop 顯示層。
- CLI binary（`src/main.rs`）：輕量工程 CLI，定位於設定、偵測、診斷與維護，並使用同一個 `orchestrator-tool` Cargo package 內的 Core。
- Desktop 應用程式：採用 Tauri 2，已提供 external tool 狀態、僅限目前 session 的有序 Sequence editor、點擊新增的 Step Palette、步驟順序調整、執行結果狀態、參數編輯、Template 載入／儲存、Simulation 與 Live Workflow 執行及完整 StepResult 顯示。

專案部署以 Windows-first 為原則，同時在合理範圍內維持 Core 的平台中立。Core 已定義線性 workflow domain、版本化 JSON template、per-step result domain 與 linear workflow executor。Desktop 為 Powers 與 Meters 提供 Run Simulation 和獨立的 Run Live 操作，兩者共用 StepResult。Template schema version 1 與線性 Workflow 不保存 execution mode、resource、output authorization 或 safety cleanup state。CLI 不提供 workflow run command。

## Instrument Setup 與 Workflow Template

Template schema 維持 `schema_version = 1`，測試定義分成兩部分：

```text
Template
├─ Instrument Setup
└─ Workflow Sequence
```

Instrument Setup 定義 run 前建立 instrument session 的設定，不是 Workflow Step。Workflow 則是在所需 Worker Ready 後依序執行的線性測試程序。Desktop 的 Instrument Setup editor 位於 Workflow 頁、Sequence 上方。Template 儲存／載入會保留這兩部分。

Meters Setup 支援 DC Voltage 與 DC Current，兩者皆提供 Auto / Manual Range Mode、Manual Range、NPLC 與 Auto Zero。DC Voltage 另提供 Input Impedance；DC Current 另提供 Current Terminal。DCV 不可攜帶 Current Terminal，DCI 不可攜帶 DCV Input Impedance。Manual mode 必須提供 Manual Range；Auto mode 忽略已儲存的 Manual Range，不產生 `--range` startup argument。Trigger 固定為 Software。

Run preparation 會驗證 setup，透過 Core Meters adapter 將其轉成 `meters-tool` startup arguments，再啟動 Worker。Simulation 與 Live 共用相同 setup semantics。Run 等待 Worker Ready 後才呼叫 Executor。`Meter Measure` 維持 runtime measurement action，不負責 session 設定。Core 檢查 setup 一致性；實際支援的 model 與數值設定仍由 `meters-tool` 驗證，Orchestrator 不建立 capability database。

頂層 `instrument_setup` 欄位為必填。使用 Meters 的 Workflow 必須提供 Meters setup；未使用 Meters 的 Workflow 可使用 `"instrument_setup": {"meters": null}`。缺少此欄位的舊 Template 不做 migration，也沒有 compatibility layer 或 schema v2。

ExecutionMode、Live VISA Resource、runtime results、output authorization 與 safety cleanup state 均不屬於 Template。Live resource 存在 Desktop configuration，execution mode 則在每次 run 時選擇。DCI 的 Current Terminal 設為 10 時，Live confirmation 也會要求操作者確認量測線實際接在 10 A terminal。目前 Instrument Setup 的驗證仍以 Simulation 為主；特定硬體型號與設定組合是否支援，仍以對應 external instrument tool 的驗證結果為準。

## Executable 設定

Core 可以載入由呼叫端指定的 TOML 設定檔，並用它覆寫 built-in portable executable path：

```toml
[tools]
meters = "D:/tools/meters-tool.exe"
powers = "D:/tools/powers-tool.exe"

[live_resources]
meters = "USB0::VENDOR::METER_SERIAL::INSTR"
powers = "USB0::VENDOR::POWER_SERIAL::INSTR"
```

Configured path 的優先順序高於 portable path。Configured path 不存在時會回報 missing，不會 fallback 到 portable path。Relative configured path 以設定檔所在目錄為基準解析。`tools list` 支援 optional 的呼叫端指定設定檔路徑，不會自動搜尋設定檔。

Desktop 應用程式透過 Tools tab 提供相同的設定能力：每個 built-in tool 都提供 Browse... 來保存 configured executable path，以及 Use Portable Default 來移除該 override。Powers 與 Meters 另提供 Live Resource，以及 Save Resource／Clear Resource 操作。Desktop 將這些設定保存到 OS / Tauri application config directory（application bundle identifier 之下）的單一 `orchestrator.toml`。Tool Status、Run Simulation 與 Run Live 讀取同一份設定。設定檔不存在時使用 portable executable path。

可選的 `live_resources` table 會原樣保存非空白 resource 字串，不做 path 解析、掃描或 fallback。Live preparation 會拒絕缺少或僅含空白的 resource，並在啟動任何 Worker 前驗證 executable、manifest 與 Worker compatibility。Simulation 仍可使用，且不需要 live resource。

Run Live 必須先經過操作人員確認，對話框會列出 Workflow 引用的 resource，並警告即將控制真實儀器、可能改變電源輸出。Powers live writes 同時使用兩道授權：短生命週期的 Desktop runtime config 設定 Worker `settings.allow_output_writes=true`，runtime adapter 則為 Live output-affecting request 注入 `arguments.confirm_output=true`。執行結束後會 best-effort 刪除此支援檔案。

只要 Live run 已啟動 Powers Worker，就會在 Worker shutdown 前嘗試 bounded `safe-off`，關閉所有通道，包括 Workflow 失敗或後續其他 Worker 啟動失敗的情況。Workflow 中明確的 Output OFF step 不會取代這道安全清理。Cleanup 失敗會讓 run 回報失敗，錯誤中同時保留原有 Workflow failure；Worker shutdown 仍會嘗試執行。Simulation 不會額外執行這項 Live cleanup。

實體硬體支援仍受各 external instrument tool 的 manifest 與 product support policy 約束。Live Powers／Meters Workflow 已進行部分真實硬體端到端驗證，包含電源安全清理行為。目前 Instrument Setup 的驗證仍以 Simulation 為主，不代表所有硬體型號與設定組合都已完成實機驗證。Scopes 與 Wavegen 尚不支援 Live Workflow。

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
