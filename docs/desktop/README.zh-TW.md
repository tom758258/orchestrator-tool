# Orchestrator Tool Desktop

[Desktop 使用者指南](USER_GUIDE.zh-TW.md) | [Core](../core/README.zh-TW.md) | [專案 README](../../README.zh-TW.md)
Desktop 是建立 Tool Instance、編輯 Template 與 Workflow、執行支援的 Simulation／Live Workflow，以及檢視或匯出已提交結果的主要介面。本 README 說明開發與元件邊界；畫面操作與步驟請參閱 [Desktop 使用者指南](USER_GUIDE.zh-TW.md)。

## 實作與職責

- `apps/desktop/` 包含 React／TypeScript 前端，使用 Vite 與 Tauri 2。
- `apps/desktop/src-tauri/` 是 Tauri Rust Application，依賴根目錄的 `orchestrator-tool` Library，將共用驗證、協調執行及 Worker 生命週期交由 Core。
- 前端負責 UI State、控制項、雙語顯示、互動與結果畫面；不另外實作 Core 的 Template 或 Worker 執行規則。
- CLI 是獨立的診斷介面，不是 Desktop Workflow Runner；參閱 [CLI README](../cli/README.zh-TW.md)。
- 外部工具程式須另外安裝。Desktop 的本機 EXE 路徑與 Live Resource 不與可攜式 Template 混存，參閱 [External Tool Boundary](../architecture/external-tool-boundary.md)。

## 開發方式

專案以 Windows 為主要開發與部署平台。需安裝 Rust、Node.js／npm 與 Tauri 必要環境。Windows Release Desktop 需要系統的 Microsoft Edge WebView2 Runtime；程式不會自動安裝。

在 `apps/desktop` 首次設定或 Lockfile 變更後安裝前端依賴，再啟動完整 Desktop：

```powershell
npm.cmd ci
npm.cmd run tauri dev
```

只修改前端時，可用 `npm.cmd run dev` 啟動 Vite，但此模式沒有 Tauri Backend，無法驗證 Native Workflow 操作。

在 `apps/desktop` 執行相關前端檢查：

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
```

Tauri Crate 使用 `apps/desktop/src-tauri/Cargo.toml` 作為自己的 Cargo Manifest。變更該層時，從 Repository 根目錄依 [AGENTS.md](../../AGENTS.md) 執行適用的 Tauri 檢查，並依 [Testing Guidelines](../testing-guidelines.md) 選擇測試；不要額外執行無關的硬體或 Release 驗證。

## Help 與參考文件

Desktop 的英文與繁中 Offline Help 由 [USER_GUIDE.md](USER_GUIDE.md) 和 [USER_GUIDE.zh-TW.md](USER_GUIDE.zh-TW.md) 產生。正式來源、重新產生與檢查方式見 [Desktop offline Help](../help/README.md)。不得直接修改已產生的 Help HTML。

完整 Run 流程與 Process 邊界請見 [Architecture Overview](../architecture/overview.md)；Template 欄位與 Workflow 正式語意請見 [Template Format](../contracts/template-schema.md)。本 README 不取代操作手冊或 Contract。
