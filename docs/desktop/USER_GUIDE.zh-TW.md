# Orchestrator Tool Desktop 使用者指南

本指南從第一次使用開始，介紹如何準備外部工具、建立範本與工作流程、執行測試，以及查看和匯出結果。不需要先了解程式內部架構。

<!-- help-navigation -->

## 選擇操作介面

Windows 發行包提供兩個使用者操作入口：

| 程式 | 用途 |
| --- | --- |
| `orchestrator-tool.exe` | CLI 工程診斷：環境、外部工具 EXE、Manifest 與支援的 Worker 檢查。 |
| `Orchestrator Tool.exe` | Desktop：建立及執行 Workflow、查看與匯出結果。 |

一般使用者請直接開啟 `Orchestrator Tool.exe`，不需要先啟動 CLI。執行 `Orchestrator Tool.exe` 後，可按右上角 **Help** 開啟離線指南；CLI 的說明可在 Windows PowerShell 輸入 `.\orchestrator-tool.exe user-guide --lang zh-TW`。這兩個 EXE 由 Windows 建置流程放在同一個 `dist/windows-x64/` 資料夾；外部工具 EXE 須另外安裝。

## 使用指南章節

建議新手依序閱讀「第一次使用」，完成一次模擬後再查閱進階功能。

### 第一次使用

- [快速開始](guide/getting-started.zh-TW.md)
- [設定外部工具](guide/external-tools.zh-TW.md)
- [Tool Setup 與 Instance](guide/tool-setup.zh-TW.md)，含手動讀取錯誤佇列
- [Workflow 編輯器](guide/workflow-editor.zh-TW.md)
- [Simulation 與 Live 執行](guide/execution.zh-TW.md)

### 基本操作與步驟參考

- [輸入值與資料流](steps/input-values.zh-TW.md)
- [Workflow 步驟](steps/workflow.zh-TW.md)，含 String Process、Byte Process 固定字串編輯及 Array Process
- [Meters 步驟](steps/meters.zh-TW.md)
- [Powers 步驟](steps/powers.zh-TW.md)
- [Scopes 動作](steps/scopes.zh-TW.md)
- [Serial Background RX 與動作](steps/serial.zh-TW.md)

### 進階擷取

- [Background Streaming 與 CSV](guide/background-streaming.zh-TW.md)
- [Background 互動步驟（含選用 Data Buffer）](steps/background.zh-TW.md)

### 結果、範本與疑難排解

- [執行結果](guide/results.zh-TW.md)
- [圖表](guide/charts.zh-TW.md)
- [輸出資料與匯出](guide/results-and-export.zh-TW.md)
- [範本與偏好設定](guide/templates-and-settings.zh-TW.md)
- [常見問題與安全](guide/troubleshooting.zh-TW.md)
