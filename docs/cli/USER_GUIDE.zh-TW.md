# Orchestrator Tool CLI 使用者指南

CLI 用於診斷 Orchestrator 環境及已設定的外部工具 EXE。Workflow 編輯與 Simulation／Live Workflow 執行由 Desktop 負責，不是 CLI 功能。

## 選擇操作介面

Windows 發行版包含兩個 EXE：

| 程式 | 用途 |
| --- | --- |
| `orchestrator-tool.exe` | CLI：外部工具設定、Manifest、Worker 診斷。 |
| `Orchestrator Tool.exe` | Desktop：Workflow 編輯、Simulation／Live 執行及結果匯出。 |

本指南介紹 CLI；Desktop 的操作說明由 `Orchestrator Tool.exe` 右上角 **Help** 開啟。

## 開啟離線使用指南

```powershell
.\orchestrator-tool.exe user-guide
.\orchestrator-tool.exe user-guide --lang en
.\orchestrator-tool.exe user-guide --lang zh-TW
```

預設英文；指南隨 EXE 提供、由系統預設瀏覽器離線開啟，不需 Desktop 或儀器。

## 1. 開啟 CLI

在 Windows Release 的 `orchestrator-tool.exe` 所在資料夾開啟 PowerShell：

```powershell
.\orchestrator-tool.exe --help
.\orchestrator-tool.exe --version
.\orchestrator-tool.exe doctor
.\orchestrator-tool.exe tools list
```

如果 EXE 已加入 `PATH`，可省略 `.\`，直接使用 `orchestrator-tool`。在開發專案根目錄也可使用 `cargo run --locked -- <arguments>`。

`doctor` 彙整外部 EXE 的可用性；`tools list` 顯示各註冊工具的狀態與路徑。這兩個指令都不會啟動 Workflow，也不代表已驗證實體儀器通訊。

### 常用指令

| 指令 | 用途 |
| --- | --- |
| --help / --version | 查閱語法及版本 |
| doctor | 環境及外部執行檔狀態 |
| tools list | 列出工具及設定路徑 |
| tools inspect | 檢查工具識別資訊與相容性 |
| tools worker-check | 支援工具的模擬診斷（Meters、Powers） |

## 2. 指定工具 EXE

| 工具 | 選擇的執行檔 |
| --- | --- |
| Meters | meters-tool.exe |
| Powers | powers-tool.exe |
| Scopes | scopes-tool.exe |
| Serial | serial-tool.exe |

選擇 CLI／Worker，而不是名稱含空格的 Desktop EXE、WebUI Launcher 或私用 Host。Meters、Powers、Scopes 的 onedir 發行包請完整解壓縮並保留 EXE 旁的 `_internal` 及其他檔案。Serial 的 Windows 發行包則提供兩個獨立 EXE。Wavegen 目前未提供獨立 Windows 發行包的建置方式；請勿將它視為已完成工作流程整合。

沒有 `--config` 時，CLI 使用空設定。若要檢查已安裝工具，可以建立 `orchestrator.toml`，例如：

```toml
[tools]
meters = "C:/Example/Meters/meters-tool.exe"
powers = "C:/Example/Powers/powers-tool.exe"
```

請將路徑改為實際安裝位置，再執行：

```powershell
.\orchestrator-tool.exe --config .\orchestrator.toml doctor
.\orchestrator-tool.exe --config .\orchestrator.toml tools list
```

CLI 不會自動繼承 Desktop 已保存的 EXE 路徑。缺少或尚未設定 EXE 時會回報其狀態，但 `doctor` 和 `tools list` 仍可能成功結束。

## 3. 檢查單一工具

```powershell
.\orchestrator-tool.exe --config .\orchestrator.toml tools inspect meters
```

如果 EXE 可用，指令會執行 Manifest 探測並顯示 Worker 相容性資訊；不可用時則顯示 `not-probed`。Inspect EXE 不等於實體硬體 Live 測試。

## 4. 檢查支援的 Worker

```powershell
.\orchestrator-tool.exe --config .\orchestrator.toml tools worker-check meters
.\orchestrator-tool.exe --config .\orchestrator.toml tools worker-check powers
```

上述指令會啟動所設定的外部工具 EXE，執行有時間界線的 Worker Simulation 診斷，因此必須先安裝並設定對應工具。目前 `worker-check` **不支援** Scopes、Serial 或 Wavegen。Simulation 通過不可視為已完成實體設備驗證。

## 5. 常見問題與限制

| 現象 | 檢查方式 |
| --- | --- |
| `not-configured` | 用 `--config` 指定含 `[tools]` 的 TOML；CLI 不會自動讀取 Desktop 設定 |
| `missing` 或 `not-file` | 修正 EXE 路徑，確認指向一般檔案 |
| Manifest `not-probed` | EXE 不可用，先處理其狀態再檢查 Manifest |
| Manifest 或 Worker 檢查失敗 | 確認外部工具可執行，且 Manifest／Worker 行為符合支援的 Contract |
| `worker check is not supported` | 僅接受 `meters` 與 `powers` |
| 設定或 Tool ID 錯誤 | 檢查 TOML 語法、已註冊 ID 與指令拼字 |

CLI 沒有 `run`、Workflow Editor、`--json`。完整語法與結束狀態請參閱 CLI README 及 `--help`。
