# Orchestrator Tool

Orchestrator Tool 是一個以 Windows 為優先、由 Desktop application 與 Rust
Core 組成的 external tools orchestrator，透過可重複使用的 Workflow
Template 協調獨立的外部工具。Desktop 是主要的 Workflow 操作介面；CLI
則是工程與診斷介面。

Core 在可行的範圍內維持 platform-neutral。Meters、Powers、Scopes、
Wavegen 等 external tools 仍是獨立專案與獨立 distribution。

## Features

- 建立包含 Tool Setup 與有順序 Workflow 的 reusable Template。
- 執行包含 Tool Action、Expression、Output、Output Page、For 與 While
  的 sequential workflow。
- 以 Simulation 或 Live mode 執行目前支援的 Powers 與 Meters workflow。
- 在 Desktop 中檢視 committed results、progress、Output Page、chart 與
  export。
- 透過 CLI 進行 external tool discovery、設定檢查與 bounded Worker
  diagnostics。

完整的 Template 與 execution contract 請見
[Template Schema v1](docs/contracts/template-schema-v1.md)。Process、Worker、
result、chart 與 export data flow 的 architecture-level 說明請見
[Architecture Overview](docs/architecture/overview.md)。

## Architecture

- **Core**（src/lib.rs）負責 Workflow 與 Template semantics、validation、
  execution、configuration、process/Worker lifecycle、result data，以及
  shared external-tool adapters。
- **CLI**（src/main.rs）透過 Core 提供 command discovery、tool inspection、
  environment diagnostics，以及 Powers/Meters Worker checks。CLI 不提供
  workflow run command。
- **Desktop**（apps/desktop）是 Tauri 2 application，負責 setup、workflow
  editing、Template load/save、Simulation 與 Live run、progress、results、
  charts 與 export。

Tauri commands 是 application boundary；orchestration behavior 仍由 Core
負責。元件 ownership 與 lifecycle 詳情請見
[Architecture Overview](docs/architecture/overview.md)。

## Project Structure

    src/lib.rs                         Core library
    src/main.rs                        Engineering / diagnostic CLI
    apps/desktop                       Tauri frontend
    apps/desktop/src-tauri              Tauri application crate
    tests                               Integration tests
    docs/architecture                   Architecture references
    docs/contracts                      Durable contract references
    Cargo.toml                          Core 與 CLI package metadata
    LICENSE                             MIT License

## Development / Quick Start

在 repository root 執行 Rust package checks：

    cargo build --locked
    cargo test --locked
    cargo fmt --all --check
    cargo clippy --locked --all-targets --all-features -- -D warnings

在 apps/desktop 設定並檢查 Desktop frontend：

    npm.cmd ci
    npm.cmd run typecheck
    npm.cmd run build

使用 npm.cmd run dev 啟動 frontend-only Vite server；使用
npm.cmd run tauri dev 啟動完整的 Tauri Desktop application。

Desktop 在 Windows 上使用系統的 Microsoft Edge WebView2 Runtime。建立
Tauri window 前必須先安裝它；application 不會自動下載或安裝 WebView2
Runtime。必要條件請參閱
[Microsoft 官方 WebView2 頁面](https://developer.microsoft.com/microsoft-edge/webview2/)。

## Desktop

Desktop 提供主要的 Workflow experience：Tool Setup、有順序的 workflow
editor、Template load/save、Simulation 與 Live run、incremental execution
results、Output Page、chart、graceful Stop，以及成功 run 的 CSV/XLSX
export。Desktop 也負責 external executable path 與 Live Resource 的 local
configuration UI。

Durable 的 architecture 或 contract 詳情放在
[architecture](docs/architecture/overview.md) 與
[contract](docs/contracts/template-schema-v1.md) 文件，不在此重複完整
specification。

## CLI

CLI 用於工程設定與診斷：

    orchestrator-tool --help
    orchestrator-tool --version
    orchestrator-tool doctor
    orchestrator-tool tools list
    orchestrator-tool tools inspect <TOOL_ID>
    orchestrator-tool tools worker-check powers
    orchestrator-tool tools worker-check meters
    orchestrator-tool --config <PATH> doctor
    orchestrator-tool --config <PATH> tools list

CLI 回報 configured executable status，並在支援的工具上執行 bounded
simulate-mode Worker checks。CLI 不取代 Desktop Workflow interface；本階段
也不建立 CLI USER_GUIDE。

## Documentation

- [Architecture Overview](docs/architecture/overview.md)
- [External Tool Boundary](docs/architecture/external-tool-boundary.md)
- [Template Schema v1](docs/contracts/template-schema-v1.md)
- [Contributing](docs/CONTRIBUTING.md)
- [Agent repository rules](AGENTS.md)
- [English entry point](README.md)

Focused engineering documents 目前以英文作為 canonical source。root 繁中
README 維持相同的 project entry-point 結構，並連結到這些文件。

## Contributing

請參閱 [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)，了解 development setup、
baseline commands、ownership boundaries、testing expectations、安全敏感變更、
documentation guidance 與 pull request checklist。

## License and Disclaimer

Orchestrator Tool 採用 [MIT License](LICENSE)。

Orchestrator Tool 是 independent project。Meters、Powers、Scopes、Wavegen
以及相關 external programs 都是 separate projects 與 distributions。本
repository 不 bundle 或 redistribute 這些工具，也不宣稱與其 maintainers
或 vendors 有 affiliation、sponsorship 或 endorsement。相關名稱與
trademarks（如有）仍歸其各自所有者所有。

Live mode 可能影響連接中的硬體；使用前請遵循適用的 external tool 與
instrument safety requirements。
