# orchestrator-tool

`orchestrator-tool` 是以 Rust 開發的多儀器調度器，預計透過共用 Core 協調外部儀器工具。

## 架構

- `orchestrator-core`：共用調度與領域邏輯，不依賴 CLI 或 Desktop 顯示層。
- `orchestrator-cli`：輕量工程 CLI，定位於設定、偵測、診斷與維護。
- Desktop 應用程式：規劃採用 Tauri 2，負責視覺化 Workflow 編輯、Template、執行與監控；初始 Rust workspace 暫不加入 Desktop。

專案部署以 Windows-first 為原則，同時在合理範圍內維持 Core 的平台中立。儀器合約、IPC、Workflow 執行與 Tauri 整合會等到對應開發階段再加入，不在初始骨架預先實作。

## 開發

使用 stable Rust，並在 repository 根目錄執行：

```text
cargo build --workspace
cargo test --workspace
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
```

目前 CLI 僅提供 repository 基礎骨架驗證，執行時會輸出產品名稱與版本。
