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
- Run supported Powers, Meters, Scopes, and Serial workflows in Simulation or Live mode.
- Inspect committed results, progress, Output Pages, charts, and exports in
  the Desktop application.
- Discover configured external tools and run bounded Worker diagnostics from
  the CLI.

Scopes reads back explicitly configured Acquisition Type, Average Count,
Channel Coupling, Probe Ratio, Bandwidth Limit, Channel Invert, and Channel Units
in Tool Setup. It also verifies Channel Display, Channel Scale, Channel Offset,
Horizontal Scale, Horizontal Position, and Edge Trigger in Workflow. Set and
Query each use the existing timeout. A failed or missing readback or a mismatch
fails Setup before Workflow starts or fails the affected Step. TDS2024B and
TBS1052B use an absolute ±0.05 V tolerance for Edge Trigger Level, which can
allow a large relative difference for settings close to zero. See the
[Scopes integration contract](docs/contracts/scopes-integration.md#settings-readback).

The exact Template and execution contract is documented in
[Template Format](docs/contracts/template-schema.md). Architecture-level
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
    docs/core                           Core engineering docs
    docs/cli                            CLI reference and user guide
    docs/desktop                        Desktop engineering docs and user guide
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

### First-time setup

On a fresh clone, navigate to the Desktop application and install npm dependencies:

    cd apps\desktop
    npm.cmd ci

* Run this only on a fresh clone or when `package.json` / `package-lock.json` changes.
* Do not run this every time you start development.
* No separate installation step is required for Rust crate dependencies. Cargo resolves them from the Rust project manifests when the Desktop application is built or run.

### Normal Desktop development

To run the complete Tauri Desktop application:

    cd apps\desktop
    npm.cmd run tauri dev

* This command starts both the Vite development server and the Tauri Desktop application together.
* Vite is launched automatically via `beforeDevCommand` defined in `tauri.conf.json`.
* You do not need to run `npm.cmd run dev` manually or open two terminals.

Use this for regular development, including Tauri features, backend commands, and workflow execution.

### Frontend-only development

For frontend work that does not require Tauri-backed application state or native commands:

    cd apps\desktop
    npm.cmd run dev

* This starts only the Vite development server without the Tauri backend.
* Open `http://localhost:5173` in a browser if needed.
* The complete Desktop workflow experience is not available in a regular browser because it depends on Tauri commands.

### Validation

Common frontend checks from `apps/desktop`:

    npm.cmd test
    npm.cmd run typecheck
    npm.cmd run build

Python is used only to generate and validate Desktop offline Help; normal
Desktop builds and Desktop users do not need it. Developers changing Help
should see [Desktop offline Help](docs/help/README.md). A virtual environment
is recommended but optional.

### Windows release build (no installer)

On Windows, run `./scripts/build-all.ps1` from PowerShell in the repository root to build the release CLI and Desktop executables. The script uses the tracked dependency lockfiles, checks CLI startup, and places `orchestrator-tool.exe` (diagnostics) and `Orchestrator Tool.exe` (Desktop) in `dist/windows-x64/`.

The **Build Windows CLI and Desktop** GitHub Actions workflow runs on demand and uploads both EXEs with the short Git commit SHA in the artifact name. Automatic CI runs on pull requests and pushes to `main` on Linux and Windows. Desktop runtime still requires WebView2; a successful build does not certify GUI or hardware behavior.

### WebView2 runtime

The Desktop uses the system Microsoft Edge WebView2 Runtime on Windows. It
must be installed before creating a Tauri window. The application does not
download or install a WebView2 runtime automatically. See the
[official WebView2 page](https://developer.microsoft.com/microsoft-edge/webview2/)
for the prerequisite.

## Desktop

Desktop is the primary interface for authoring Templates, running Workflows and inspecting results. See [Desktop README](docs/desktop/README.md) for development and ownership, and [Desktop User Guide](docs/desktop/USER_GUIDE.md) for operations.

## CLI

The CLI covers engineering setup and external-tool diagnostics, not Workflow runs. See [CLI README](docs/cli/README.md) for commands and flags, and [CLI User Guide](docs/cli/USER_GUIDE.md) for PowerShell walkthroughs.

## Documentation

- [Core README](docs/core/README.md) — shared Rust library ownership and modules.
- [CLI README](docs/cli/README.md) / [CLI User Guide](docs/cli/USER_GUIDE.md) — command reference and operation.
- [Desktop README](docs/desktop/README.md) / [Desktop User Guide](docs/desktop/USER_GUIDE.md) — implementation and UI operation.
- [Architecture Overview](docs/architecture/overview.md) / [External Tool Boundary](docs/architecture/external-tool-boundary.md) — system architecture and external-tool boundaries.
- [Template Format](docs/contracts/template-schema.md) — normative Template and Workflow rules.
- [Contributing](docs/CONTRIBUTING.md) / [AGENTS.md](AGENTS.md) — contribution and validation rules.
- [Traditional Chinese entry point](README.zh-TW.md).

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
