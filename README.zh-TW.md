# orchestrator-tool

`orchestrator-tool` 是以 Rust 開發的多儀器調度器，預計透過共用 Core 協調外部儀器工具。

## 架構

- Core library（`src/lib.rs`）：共用調度與領域邏輯，不依賴 CLI 或 Desktop 顯示層。
- CLI binary（`src/main.rs`）：輕量工程 CLI，定位於設定、偵測、診斷與維護，並使用同一個 `orchestrator-tool` Cargo package 內的 Core。
- Desktop 應用程式：採用 Tauri 2，已提供 external tool 狀態、線性 Workflow 與參數編輯、Template 載入／儲存、simulate Workflow 執行及 StepResult 顯示。

專案部署以 Windows-first 為原則，同時在合理範圍內維持 Core 的平台中立。Core 已定義線性 workflow domain、版本化 JSON template、per-step result domain 與 linear workflow executor。Powers 與 Meters 的 simulate-mode vertical slice 已涵蓋從 Worker HTTP 與 stdout event 到 step result 的 workflow execution，Desktop 也能執行此 simulation 並顯示結果。Visual Canvas 尚未完成，CLI 不提供 workflow run command，live-hardware workflow execution 也尚未開放。

## Executable 設定

Core 可以載入由呼叫端指定的 TOML 設定檔，並用它覆寫 built-in portable executable path：

```toml
[tools]
meters = "D:/tools/meters-tool.exe"
```

Configured path 的優先順序高於 portable path。Configured path 不存在時會回報 missing，不會 fallback 到 portable path。Relative configured path 以設定檔所在目錄為基準解析。`tools list` 支援 optional 的呼叫端指定設定檔路徑，不會自動搜尋設定檔。

## External process 管理

Core 可以使用 arguments 啟動 generic external process，並提供 process ID、非阻塞狀態檢查、等待與強制終止能力。Standard input、output 與 error 維持 inherited。Managed process 被 Drop 時會 best-effort 終止並清理 child process。

Core 已提供 Common Worker process/session 與 local HTTP IPC 支援，CLI 已透過 `tools worker-check` 暴露針對 Powers 與 Meters 的 Worker diagnostic，Core 仍持有 process lifecycle 與 cleanup 責任。

## CLI

P5-A 建立 command framework，P5-B 實作 external tool listing，P5-C 實作 environment diagnostics：

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

使用 stable Rust，並在 repository 根目錄執行：

```text
cargo build --locked
cargo test --locked
cargo fmt --all --check
cargo clippy --locked --all-targets --all-features -- -D warnings
```

目前 CLI 已提供 tool listing、manifest inspection、environment diagnostics，以及針對 Powers 與 Meters 的 Worker diagnostic。
