# Orchestrator Tool

Orchestrator Tool is a Windows-first desktop application and Rust core for
coordinating independent external tools through reusable workflow templates.
The Desktop application is the primary workflow operation interface; the CLI
is an engineering and diagnostic interface.

Core is kept platform-neutral where practical. External tools such as Meters,
Powers, Scopes, and Wavegen remain separate projects and distributions.

## Features

- Define reusable Templates containing Tool Setup and an ordered Workflow.
- Execute sequential workflows with Tool Actions, expressions, Outputs,
  Output Pages, For, and While.
- Run supported Powers and Meters workflows in Simulation or Live mode.
- Inspect committed results, progress, Output Pages, charts, and exports in
  the Desktop application.
- Discover configured external tools and run bounded Worker diagnostics from
  the CLI.

The exact Template and execution contract is documented in
[Template Schema v1](docs/contracts/template-schema-v1.md). Architecture-level
process, Worker, result, chart, and export data flow is described in
[Architecture Overview](docs/architecture/overview.md).

## Architecture

- **Core** (src/lib.rs) owns workflow and Template semantics, validation,
  execution, configuration, process/Worker lifecycle, result data, and shared
  external-tool adapters.
- **CLI** (src/main.rs) uses Core for command discovery, tool inspection,
  environment diagnostics, and focused Powers/Meters Worker checks. It does
  not provide a workflow run command.
- **Desktop** (apps/desktop) is the Tauri 2 application for setup, workflow
  editing, Template load/save, Simulation and Live runs, progress, results,
  charts, and export.

Tauri commands are an application boundary; orchestration behavior remains in
Core. The ownership and lifecycle details are in
[Architecture Overview](docs/architecture/overview.md).

## Project Structure

    src/lib.rs                         Core library
    src/main.rs                        Engineering and diagnostic CLI
    apps/desktop                       Tauri frontend
    apps/desktop/src-tauri              Tauri application crate
    tests                               Integration tests
    docs/architecture                   Architecture references
    docs/contracts                      Durable contract references
    Cargo.toml                          Core and CLI package metadata
    LICENSE                             MIT License

## Development / Quick Start

Run the Rust package checks from the repository root:

    cargo build --locked
    cargo test --locked
    cargo fmt --all --check
    cargo clippy --locked --all-targets --all-features -- -D warnings

Set up and check the Desktop frontend from apps/desktop:

    npm.cmd ci
    npm.cmd run typecheck
    npm.cmd run build

Use npm.cmd run dev for the frontend-only Vite server, or
npm.cmd run tauri dev for the complete Tauri Desktop application.

The Desktop uses the system Microsoft Edge WebView2 Runtime on Windows. It
must be installed before creating a Tauri window. The application does not
download or install a WebView2 runtime automatically. See the
[official WebView2 page](https://developer.microsoft.com/microsoft-edge/webview2/)
for the prerequisite.

## Desktop

Desktop provides the main workflow experience: Tool Setup, an ordered
workflow editor, Template load/save, Simulation and Live run actions,
incremental execution results, Output Pages, charts, graceful Stop, and CSV
or XLSX export for successful runs. It also owns the local configuration UI
for external executable paths and Live Resources.

Desktop behavior that is durable architecture or contract knowledge is kept
in the [architecture](docs/architecture/overview.md) and
[contract](docs/contracts/template-schema-v1.md) documents rather than
duplicated here.

## CLI

The CLI is intended for engineering setup and diagnostics:

    orchestrator-tool --help
    orchestrator-tool --version
    orchestrator-tool doctor
    orchestrator-tool tools list
    orchestrator-tool tools inspect <TOOL_ID>
    orchestrator-tool tools worker-check powers
    orchestrator-tool tools worker-check meters
    orchestrator-tool --config <PATH> doctor
    orchestrator-tool --config <PATH> tools list

It reports configured executable status and performs bounded, simulate-mode
Worker checks where supported. It does not replace the Desktop workflow
interface and does not require a CLI USER_GUIDE in this phase.

## Documentation

- [Desktop User Guide](docs/desktop/USER_GUIDE.md)
- [Architecture Overview](docs/architecture/overview.md)
- [External Tool Boundary](docs/architecture/external-tool-boundary.md)
- [Template Schema v1](docs/contracts/template-schema-v1.md)
- [Contributing](docs/CONTRIBUTING.md)
- [Agent repository rules](AGENTS.md)
- [Traditional Chinese entry point](README.zh-TW.md)

Focused engineering documents are currently maintained in English as the
canonical source. The root Traditional Chinese README keeps the same project
entry-point structure and links to those documents.

## Contributing

See [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) for development setup,
baseline commands, ownership boundaries, testing expectations, safety-sensitive
changes, documentation guidance, and the pull request checklist.

## License and Disclaimer

Orchestrator Tool is released under the [MIT License](LICENSE).

Orchestrator Tool is an independent project. Meters, Powers, Scopes, Wavegen,
and related external programs are separate projects and distributions. This
repository does not bundle or redistribute those tools and does not claim
affiliation, sponsorship, or endorsement by their maintainers or vendors.
Their names and trademarks, if any, remain with their respective owners.

Live operation can affect connected hardware. Follow the applicable external
tool and instrument safety requirements before using Live mode.
