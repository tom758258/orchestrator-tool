# orchestrator-tool

`orchestrator-tool` 是以 Rust 開發的多儀器調度器，預計透過共用 Core 協調外部儀器工具。

## 架構

- Core library（`src/lib.rs`）：共用調度與領域邏輯，不依賴 CLI 或 Desktop 顯示層。
- CLI binary（`src/main.rs`）：輕量工程 CLI，定位於設定、偵測、診斷與維護，並使用同一個 `orchestrator-tool` Cargo package 內的 Core。
- Desktop 應用程式：規劃採用 Tauri 2，負責視覺化 Workflow 編輯、Template、執行與監控；P0 尚未建立 Desktop。

專案部署以 Windows-first 為原則，同時在合理範圍內維持 Core 的平台中立。儀器合約、IPC、Workflow 執行與 Tauri 整合會等到對應開發階段再加入，不在初始骨架預先實作。

## Executable 設定

Core 可以載入由呼叫端指定的 TOML 設定檔，並用它覆寫 built-in portable executable path：

```toml
[tools]
meters = "D:/tools/meters-tool.exe"
```

Configured path 的優先順序高於 portable path。Configured path 不存在時會回報 missing，不會 fallback 到 portable path。Relative configured path 以設定檔所在目錄為基準解析。目前 CLI 尚未載入設定檔。

## External process 管理

Core 可以使用 arguments 啟動 generic external process，並提供 process ID、非阻塞狀態檢查、等待與強制終止能力。Standard input、output 與 error 維持 inherited。Managed process 被 Drop 時會 best-effort 終止並清理 child process。

目前 CLI 尚未提供 process management，IPC 與 instrument-specific contract 仍留待後續階段實作。

## 開發

使用 stable Rust，並在 repository 根目錄執行：

```text
cargo build --locked
cargo test --locked
cargo fmt --all --check
cargo clippy --locked --all-targets --all-features -- -D warnings
```

目前 CLI 僅提供 repository 基礎骨架驗證，執行時會輸出產品名稱與版本。
