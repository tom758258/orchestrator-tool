[English](README.md)

# Orchestrator Tool

Orchestrator Tool 是一個以 Windows 為優先、使用 Rust 開發的工作流程執行工具，
透過可重複使用的 Template 協調獨立外部工具。專案包含共用 Core、工程與診斷 CLI，
以及 Tauri 2 Desktop 應用程式。Desktop 是編輯與執行 Workflow 的主要介面；
CLI 不提供 Workflow 編輯或執行功能。

Orchestrator 負責協調外部程式，不負責儀器驅動程式或設備專屬的 VISA／SCPI 邏輯。
本專案是執行工具，不是持久化的測試紀錄或 Run History 資料庫。

## 主要功能

- 建立、驗證、開啟及儲存包含 Tool Setup 與依序執行 Workflow 的可重複使用 Template；
  支援多個 Tool Instance，包括同一 Tool Type 的不同 Instance。
- 組合 Tool Action、運算式、If、For、While、Output Page，以及 String、Byte、Array Process。
- 以 Simulation 或 Live 模式執行支援的 Meters、Powers、Scopes 與 Serial Workflow，
  檢視執行進度並停止 Run。
- 在各工具支援範圍內，使用 Meters、Scopes、Serial 的 Background Streaming、
  Capture、Interaction 及選用的 Data Buffer。
- 檢視已提交的結果、統計資料、圖表與 Output Page；將可用資料匯出為 CSV 或 XLSX，
  將支援的擷取資料串流寫入 CSV，並匯出失敗或未完成 Run 的已提交部分結果。
- 選擇是否將圖表定義與 Template 一起儲存；執行結果、外部 EXE 路徑及 Live Resource
  不會保存於可攜式 Template。
- 設定外部工具，檢查狀態、Manifest 與 Worker 相容性；透過 CLI 執行有時間界線的
  Meters、Powers Worker Simulation 診斷。
- Desktop 支援英文與繁體中文介面、System／Light／Dark 外觀；
  Desktop 與 CLI 均提供雙語離線 Help。

Wavegen 已列入工具 Registry，但尚不支援 Workflow 執行。各外部工具仍是獨立專案與
發行套件。Simulation 不進行實體儀器 I/O；Live 需要明確設定的資源及操作者確認。
支援的 Scopes 設定會進行讀回驗證；讀回失敗或不符設定時，受影響的 Setup 或 Step
會失敗。完整行為請參閱 [Scopes 整合契約](docs/contracts/scopes-integration.md#settings-readback)
及 [Template Format](docs/contracts/template-schema.md)。

## 元件分工

- **Core**（`src/lib.rs`）：Template 驗證、Workflow 執行、本機設定、
  外部 Process／Worker 生命週期、工具整合及結果。
- **CLI**（`src/main.rs`）：透過 Core 提供指令探索、工具檢查、設定診斷及支援的
  Worker 檢查；不負責執行 Workflow。
- **Desktop**（`apps/desktop`）：React／TypeScript 前端與 Tauri 2 Rust 應用程式，
  負責 Tool Setup、Workflow 編輯與執行、結果及匯出。

Core 與 CLI 共用根目錄的 Cargo Package。Desktop 直接依賴 Core；
Tauri Commands 維持應用程式邊界。參閱 [Architecture Overview](docs/architecture/overview.md)
及 [External Tool Boundary](docs/architecture/external-tool-boundary.md)。

## 專案結構

```text
src/
  lib.rs                    # 共用 Rust Core
  main.rs                   # 工程與診斷 CLI
apps/desktop/
  src/                      # React / TypeScript 前端
  src-tauri/                # Tauri 應用程式 Crate
docs/
  core/ cli/ desktop/       # 元件參考文件與使用者指南
  architecture/ contracts/  # 架構與正式契約
  help/                     # 離線 Help 維護
scripts/                    # 建置與 Help 維護
tests/                      # 整合測試
.github/workflows/          # CI 與手動 Windows 建置
Cargo.toml
Cargo.lock
```

## 主要相依技術

| 元件 | 用途 |
| --- | --- |
| Rust、Clap | Core 與 CLI |
| Serde、serde_json、TOML | Template 資料與本機設定 |
| ureq、rust_decimal | Worker HTTP 通訊及十進位數值運算 |
| csv、rust_xlsxwriter | CSV 與 XLSX 匯出 |
| Tauri 2、React、TypeScript、Vite | Desktop 應用程式及前端 |
| React Flow（@xyflow/react）、Apache ECharts | Workflow 編輯器與圖表 |
| Microsoft Edge WebView2 Runtime | Windows 系統提供的 Desktop 執行環境 |

確切的相依套件版本見 [Cargo.lock](Cargo.lock)、
[Desktop Cargo.lock](apps/desktop/src-tauri/Cargo.lock) 及
[package-lock.json](apps/desktop/package-lock.json)。
發行與授權資訊請參閱 [第三方授權聲明](THIRD_PARTY_NOTICES.txt)。
Python 僅用於維護與驗證離線 Help，一般 Desktop 建置與使用者不需要 Python。

## 安裝

若使用預先建置的 Windows x64 套件，請完整解壓縮，包括授權與聲明文件，
不需要安裝程式。Desktop 需要系統的
[Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)；
應用程式不包含或自動安裝此執行環境。依 Workflow 需求另外安裝外部工具，
選擇其 CLI／Worker 執行檔，並保留完整外部工具發行套件及相鄰的執行期檔案。
參閱 [設定外部工具](docs/desktop/guide/external-tools.zh-TW.md)。

從原始碼開發需使用支援 edition 2024 的 stable Rust、Node.js／npm（CI 使用
Node.js 24），以及 Tauri 2 對應平台的必要環境。首次設定或 Lockfile 變更時，
從 Repository 根目錄安裝前端依賴：

```powershell
cd apps\desktop
npm.cmd ci
```

Rust 依賴由 Cargo 依既有 Manifest 與 Lockfile 解析。

## 快速開始

### Windows 應用程式

執行 `Orchestrator Tool.exe` 即可編輯及執行 Workflow，不需要先啟動 CLI。
初次使用請依照 [Desktop 使用者指南](docs/desktop/USER_GUIDE.zh-TW.md) 的
首次 Simulation 教學；也可在 Desktop 選擇 **Help** 開啟離線說明。

在發行套件目錄開啟 PowerShell，查看 CLI：

```powershell
.\orchestrator-tool.exe --help
.\orchestrator-tool.exe --version
.\orchestrator-tool.exe doctor
.\orchestrator-tool.exe tools list
.\orchestrator-tool.exe user-guide --lang zh-TW
```

這些指令不會執行 Workflow 或驗證硬體。CLI 不會自動讀取 Desktop 設定；
使用 `--config` 指定已存在的 TOML 檔以檢查已設定的 EXE。
參閱 [CLI 使用者指南](docs/cli/USER_GUIDE.zh-TW.md)。

### 從原始碼開發

從 Repository 根目錄可執行 `cargo run --locked -- --help` 查看 CLI。
完成安裝步驟後，從 Repository 根目錄啟動完整 Desktop：

```powershell
cd apps\desktop
npm.cmd run tauri dev
```

Tauri 會自動啟動 Vite。只進行前端開發時，可在 `apps/desktop` 執行
`npm.cmd run dev`，此模式僅啟動 Vite，不具備原生 Tauri Workflow 操作功能。

## 建置

在 Windows PowerShell 中，從 Repository 根目錄執行：

```powershell
.\scripts\build-all.ps1
```

腳本依 Lockfile 建置 CLI 與 Desktop、檢查 CLI 啟動，並準備不含安裝程式的
Windows x64 發行套件：

```text
dist/windows-x64/
  Orchestrator Tool.exe
  orchestrator-tool.exe
  LICENSE
  THIRD_PARTY_NOTICES.txt
  licenses/
```

授權目錄包含 ECharts 上游聲明、蒐集的相依套件授權文件，以及套件與來源索引
（`licenses/DEPENDENCIES.txt`）。請將這些文件與 EXE 一併保留，散布前應審查索引。

現有 GitHub Actions **Build Windows CLI and Desktop** 可手動觸發，並上傳
發行套件，Artifact 名稱包含 Git Commit 短 SHA。不會建立 Release 或 Tag。
建置成功不代表 GUI 或硬體測試通過。

## 測試

Core／CLI 基準檢查從 Repository 根目錄執行：

```powershell
cargo fmt --all --check
cargo clippy --locked --all-targets --all-features -- -D warnings
cargo test --locked
cargo build --locked
```

安裝前端依賴後，從 `apps/desktop` 執行：

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
```

優先執行與修改相關的聚焦檢查。Tauri 檢查請參閱 [AGENTS.md](AGENTS.md)；
測試分工及驗證證據的界線請參閱 [Testing Guidelines](docs/testing-guidelines.md)。
現有 CI 在 Pull Request 與推送至 `main` 時於 Linux、Windows 執行。
預設測試不需要實體硬體。自動化測試、Fake Worker、實際 Tool Simulation、
Windows 建置、GUI 檢查及 Live 硬體驗證屬於不同種類的證據。

## 文件導覽

- [Desktop 使用者指南](docs/desktop/USER_GUIDE.zh-TW.md)
- [CLI 使用者指南](docs/cli/USER_GUIDE.zh-TW.md)
- [Core README](docs/core/README.zh-TW.md)
- [CLI README](docs/cli/README.zh-TW.md)
- [Desktop README](docs/desktop/README.zh-TW.md)
- [Architecture Overview](docs/architecture/overview.md)
- [External Tool Boundary](docs/architecture/external-tool-boundary.md)
- [Template Format](docs/contracts/template-schema.md) 與 [Contracts](docs/contracts/)
- [Testing Guidelines](docs/testing-guidelines.md)
- [離線 Help 維護](docs/help/README.md)
- [Changelog](CHANGELOG.md)

## 參與開發

請先閱讀 [Contributing](docs/CONTRIBUTING.md)、[AGENTS.md](AGENTS.md) 及適用的
[Testing Guidelines](docs/testing-guidelines.md) 與正式契約。
保持修改聚焦，維持元件與安全邊界，記錄已驗證及未驗證的項目。
Live 驗證需要另外取得授權，並遵守適用的外部工具安全要求。

## 授權與免責聲明

Copyright (c) 2026 tom758258。Orchestrator Tool 採用 [MIT License](LICENSE)
授權。第三方元件仍適用各自的授權條款，參閱
[THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)。

Orchestrator Tool 的應用程式圖示使用 ChatGPT 中的 OpenAI 圖像生成功能製作，並由專案維護者審查及挑選。

Orchestrator Tool 為獨立且非官方的專案，不宣稱與儀器製造商或第三方供應商有
隸屬、贊助或背書關係。Meters、Powers、Scopes、Serial、Wavegen 及其他外部工具均為
獨立專案與發行套件，本 Repository 不包含或重新散布這些工具。第三方名稱與商標歸
各自所有者所有。使用者應遵守適用的軟體、驅動程式、儀器及文件授權條款。

Live 操作可能影響已連接的硬體。請遵循適用的外部工具及儀器安全要求。
本專案依 MIT License 提供，不附帶任何保證。
