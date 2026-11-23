# Orchestrator Tool Desktop 使用者指南

本指南描述目前 Orchestrator Tool Desktop 已實作且可使用的行為，讀者是
需要設定 external tools、建立 reusable Template、執行 Workflow，以及檢視或
匯出結果的 operator 與 engineer。

<!-- help-navigation -->

## 選擇操作介面

Windows 發行包提供兩個使用者操作入口：

| 程式 | 用途 |
| --- | --- |
| `orchestrator-tool.exe` | CLI 工程診斷：環境、外部工具 EXE、Manifest 與支援的 Worker 檢查。 |
| `Orchestrator Tool.exe` | Desktop：建立及執行 Workflow、查看與匯出結果。 |

本指南介紹 Desktop。執行 `Orchestrator Tool.exe` 後，可按右上角 **Help** 開啟離線指南；CLI 的說明可在 Windows PowerShell 輸入 `.\orchestrator-tool.exe user-guide --lang zh-TW`。這兩個 EXE 由 Windows 建置流程放在同一個 `dist/windows-x64/` 資料夾；外部工具 EXE 須另外安裝。

## 使用指南章節

- [快速開始](guide/getting-started.zh-TW.md)
- [設定外部工具](guide/external-tools.zh-TW.md)
- [Tool Setup 與 Instance](guide/tool-setup.zh-TW.md)，含手動讀取錯誤佇列
- [Workflow 編輯器](guide/workflow-editor.zh-TW.md)
- [輸入值與資料流](steps/input-values.zh-TW.md)
- [Powers 步驟](steps/powers.zh-TW.md)
- [Workflow 步驟](steps/workflow.zh-TW.md)
- [Scopes 動作](steps/scopes.zh-TW.md)
- [Background 互動步驟](steps/background.zh-TW.md)
- [Simulation 與 Live 執行](guide/execution.zh-TW.md)
- [Background Streaming 與 CSV](guide/background-streaming.zh-TW.md)
- [執行結果](guide/results.zh-TW.md)
- [圖表](guide/charts.zh-TW.md)
- [輸出資料與匯出](guide/results-and-export.zh-TW.md)
- [範本與偏好設定](guide/templates-and-settings.zh-TW.md)
- [常見問題與安全](guide/troubleshooting.zh-TW.md)
- [Serial Background RX 與動作](steps/serial.zh-TW.md)

## Step Reference

從上述 **Workflow Steps、Input Values、Powers、Scopes、Background、Serial** 章節查閱目前已實作的 Step 設定與限制。每個 Step 的範例會在有實際內容時獨立擴充。
