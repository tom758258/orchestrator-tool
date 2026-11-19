# Orchestrator Tool Core

[English](README.md) | [專案 README](../../README.zh-TW.md) | [CLI](../cli/README.zh-TW.md) | [Desktop](../desktop/README.zh-TW.md)

Core 是根目錄 `orchestrator-tool` Cargo Package 中，以 `src/lib.rs` 為入口的共用 Rust Library，提供診斷 CLI 與 Tauri Desktop 後端使用的協調執行邏輯。它不是獨立 Crate，也不是儀器驅動程式。

## 主要職責

| 範圍 | 主要模組 | 負責內容 |
| --- | --- | --- |
| Template 與 Workflow | `template.rs`、`workflow.rs`、`executor.rs` | 載入、驗證、依序執行、運算式與控制流程 |
| Run 準備與生命週期 | `run_preparation.rs`、`run.rs`、`run_failure.rs` | 確認執行需求、啟動與清理外部 Worker |
| 外部工具探索 | `config.rs`、`discovery.rs`、`inspection.rs`、`manifest_probe.rs` | 本機設定、執行檔狀態、Manifest 與相容性檢查 |
| Worker 通訊 | `worker.rs`、`worker_http.rs`、`common_job.rs`、`common_v3.rs` | Process／Worker 生命週期及 Common Worker 互動 |
| 工具整合 | `adapters/`、`meters_setup.rs`、`powers_setup.rs`、`scopes_setup.rs`、`serial_setup.rs` | Orchestrator 端的準備與驗證，不包含設備專用 Driver |
| 結果與 Background | `data_context.rs`、`background.rs`、`background_export.rs`、`workflow_csv.rs`、`workflow_export.rs` | 已提交的結果、背景擷取及匯出 |

上述是模組分組，不代表新增 Package。完整執行及結果生命週期請參閱 [Architecture Overview](../architecture/overview.md)；Template 與 Workflow 的正式規則以 [Template Format](../contracts/template-schema.md) 為準。

## 架構邊界

- `src/main.rs` 是 CLI 入口，透過 Core 進行探索與診斷；參數解析及命令列顯示不屬於 Core。
- `apps/desktop/src-tauri` 直接依賴根目錄 Rust Library。Tauri Commands 與 React／TypeScript UI 不應另外實作一套 Workflow Engine。
- Meters、Powers、Scopes、Serial 等外部工具是獨立執行檔與發行項目。實體 I/O、VISA／SCPI、儀器型號及設備層級安全由其各自專案負責，參閱 [External Tool Boundary](../architecture/external-tool-boundary.md)。
- Template 保存可攜式 Tool Instance 與 Workflow 定義；EXE 路徑和 Live Resource 屬於本機設定。Runtime Results 不會形成持久化 Run History 資料庫。
- Core 協調 Worker 啟動、執行與清理。Worker 接受 Job 不等於 Job 完成；Run 結果仍需依最終 Job 與關閉／安全清理狀態判定。

## 開發與驗證

從 Repository 根目錄執行：

```sh
cargo build --locked
cargo test --locked
```

修改時應先執行最相關的聚焦檢查，再視需要進行更廣泛的 Package 驗證。依循 [AGENTS.md](../../AGENTS.md) 與 [Testing Guidelines](../testing-guidelines.md)；一般驗證不需要實體儀器。機器可讀 Schema 應以正式 Contract 為準，而不是以本 README 取代規格。
