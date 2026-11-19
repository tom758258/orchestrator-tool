# Orchestrator Tool CLI

[English](README.md) | [CLI 使用者指南](USER_GUIDE.zh-TW.md) | [Core](../core/README.zh-TW.md) | [專案 README](../../README.zh-TW.md)

`orchestrator-tool` 執行檔（Windows 為 `orchestrator-tool.exe`）是使用共用 Rust Core 的工程診斷介面，可檢查本機工具設定、EXE 狀態、外部工具 Manifest 與部分 Worker 啟動流程。CLI **不提供** Workflow Template 編輯或執行功能。

## 指令

| 指令 | 功能 |
| --- | --- |
| `orchestrator-tool --help`／`--version` | 顯示指令說明或產品版本 |
| `orchestrator-tool doctor` | 彙整外部工具 EXE 的設定與可用性 |
| `orchestrator-tool tools list` | 列出註冊的 Tool ID、EXE 路徑、來源與狀態 |
| `orchestrator-tool tools inspect <TOOL_ID>` | 檢查單一工具；EXE 可用時探測 Manifest |
| `orchestrator-tool tools worker-check meters` | 執行有界的 Meters Worker Simulation 診斷 |
| `orchestrator-tool tools worker-check powers` | 執行有界的 Powers Worker Simulation 診斷 |

`--config <PATH>` 為上述指令可使用的全域選項；實際參數形式可用 `orchestrator-tool <command> --help` 查詢。內建 Tool Registry 包含 `meters`、`powers`、`scopes`、`serial`、`wavegen`，但列入 Registry 不表示每個工具都支援所有診斷或 Workflow Action。目前 `worker-check` 只接受 `meters` 與 `powers`。

## 設定檔

未提供 `--config` 時，CLI 使用空的記憶體內設定，**不會**自動讀取 Desktop 的本機設定檔。若需檢查指定 EXE，請提供已存在的 TOML 檔：

```toml
[tools]
meters = "C:/Example/Meters/meters-tool.exe"
powers = "C:/Example/Powers/powers-tool.exe"
```

上述路徑只是範例，應改成實際安裝位置。檔案內的相對 EXE 路徑以設定檔所在目錄為基準。未知 Tool ID 或無效設定會造成驗證失敗。未設定路徑時，不會自動搜尋其他執行檔。

## 狀態與結束結果

`doctor` 與 `tools list` 會顯示 `available`、`missing`、`not-file`、`not-configured`；`doctor` 對可用項目顯示 `[OK]`。僅因外部工具不可用，不代表這兩個指令本身會回傳失敗。`tools inspect` 遇到不可用的 EXE 時顯示 `not-probed`；EXE 可用時會呼叫該工具讀取 Manifest 並檢查相容性。Manifest 探測失敗時則回傳失敗。

`worker-check` 需要已設定且可用的 EXE，執行有時間界線的 Worker Simulation 診斷；不支援的 Tool ID 或診斷失敗時會回傳失敗。Simulation 通過**不代表**實體硬體 Live 測試通過。診斷輸出為人類可讀文字；目前 CLI 沒有提供 JSON 輸出選項。

## 開發與參考

從 Repository 根目錄執行：

```sh
cargo run --locked -- --help
cargo run --locked -- doctor
cargo run --locked -- tools list
```

PowerShell 實際操作與問題排除請見 [CLI 使用者指南](USER_GUIDE.zh-TW.md)。Core／模組職責見 [Core README](../core/README.zh-TW.md)，外部執行規則見 [External Tool Boundary](../architecture/external-tool-boundary.md)。修改程式時請遵守 [AGENTS.md](../../AGENTS.md) 與 [Testing Guidelines](../testing-guidelines.md)。
