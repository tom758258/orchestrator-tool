# orchestrator-tool

`orchestrator-tool` 是以 Rust 開發的多儀器調度器，預計透過共用 Core 協調外部儀器工具。

## 架構

- Core library（`src/lib.rs`）：共用調度與領域邏輯，不依賴 CLI 或 Desktop 顯示層。
- CLI binary（`src/main.rs`）：輕量工程 CLI，定位於設定、偵測、診斷與維護，並使用同一個 `orchestrator-tool` Cargo package 內的 Core。
- Desktop 應用程式：規劃採用 Tauri 2，負責視覺化 Workflow 編輯、Template、執行與監控；P0 尚未建立 Desktop。

專案部署以 Windows-first 為原則，同時在合理範圍內維持 Core 的平台中立。Core 已定義線性 workflow domain、版本化 JSON template 與 per-step result domain，workflow execution 仍延後。

## Executable 設定

Core 可以載入由呼叫端指定的 TOML 設定檔，並用它覆寫 built-in portable executable path：

```toml
[tools]
meters = "D:/tools/meters-tool.exe"
```

Configured path 的優先順序高於 portable path。Configured path 不存在時會回報 missing，不會 fallback 到 portable path。Relative configured path 以設定檔所在目錄為基準解析。`tools list` 支援 optional 的呼叫端指定設定檔路徑，不會自動搜尋設定檔。

## External process 管理

Core 可以使用 arguments 啟動 generic external process，並提供 process ID、非阻塞狀態檢查、等待與強制終止能力。Standard input、output 與 error 維持 inherited。Managed process 被 Drop 時會 best-effort 終止並清理 child process。

目前 CLI 尚未提供 process management，IPC 與 instrument-specific contract 仍留待後續階段實作。

## CLI

P5-A 建立 command framework，P5-B 已實作 external tool listing，P5-C 已實作 environment diagnostics：

```text
orchestrator-tool --help
orchestrator-tool --version
orchestrator-tool doctor
orchestrator-tool tools list
orchestrator-tool --config <PATH> doctor
orchestrator-tool --config <PATH> tools list
```

`tools list` 會列出四個 built-in external tools，並顯示 executable path 的 `configured` 或 `portable` source，以及 `available`、`missing` 或 `not-file` status。Missing tools 是正常的 discovery 結果，不會使 command 失敗。設定檔錯誤與其他 discovery I/O error 會輸出到 stderr，並回傳非 0 exit code。

`doctor` 會顯示 application directory、configuration 狀態、四個 built-in external tools 的 status，以及 summary counts。Missing 與 not-file tools 是正常的診斷結果，不會使 command 失敗。設定檔錯誤與其他 discovery I/O error 會輸出到 stderr，並回傳非 0 exit code。`doctor` 不會執行 instrument-level diagnostics。

CLI 目前仍未暴露 process management，instrument-specific contract 與 IPC 也尚待後續實作。

## 開發

使用 stable Rust，並在 repository 根目錄執行：

```text
cargo build --locked
cargo test --locked
cargo fmt --all --check
cargo clippy --locked --all-targets --all-features -- -D warnings
```

目前 CLI 已提供 P5-B tool listing 與 P5-C environment diagnostics；instrument-level diagnostics 尚待後續實作。
