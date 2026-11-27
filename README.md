[繁體中文](README.zh-TW.md)

# Orchestrator Tool

Orchestrator Tool is a Windows-first, Rust-based workflow execution tool for
coordinating independent external tools through reusable Templates. It provides
a shared Core, an engineering and diagnostic CLI, and a Tauri 2 Desktop
application. Desktop is the primary interface for workflow authoring and
execution; CLI does not edit or run workflows.

Orchestrator coordinates external programs, not instrument drivers or
device-specific VISA/SCPI logic. It is an execution tool, not a persistent
test-record or run-history database.

## Features

- Create, validate, open and save reusable Templates with Tool Setup and
  ordered Workflows; use multiple Tool Instances, including instances of the
  same Tool Type.
- Compose Tool Actions, expressions, If, For, While, Output Pages, and
  String, Byte and Array processing.
- Run supported Meters, Powers, Scopes and Serial workflows in Simulation or
  Live mode; inspect progress and stop a run.
- Use supported Meters, Scopes and Serial Background Streaming, capture,
  interaction and optional Data Buffer features within their tool-specific limits.
- Inspect committed results, statistics, charts and Output Pages; export
  available data as CSV or XLSX, stream supported capture data to CSV, and
  export committed partial results from failed or incomplete runs.
- Optionally save chart definitions with the Template; keep runtime results,
  external EXE paths and Live Resources separate from portable Templates.
- Configure external tools, inspect status, manifests and Worker compatibility,
  and run bounded Meters and Powers Worker Simulation diagnostics from CLI.
- Use English or Traditional Chinese Desktop UI, System/Light/Dark appearance,
  and bilingual offline Help in both Desktop and CLI.

Wavegen is registered but does not yet support Workflow execution. External
tools remain separate projects and distributions. Simulation does not perform
physical instrument I/O; Live requires explicitly configured resources and
operator confirmation. Supported Scopes settings are read back and verified;
failed or mismatched readback fails the affected Setup or Step. See the
[Scopes integration contract](docs/contracts/scopes-integration.md#settings-readback)
and [Template Format](docs/contracts/template-schema.md) for exact behavior.

## Components

- **Core** (`src/lib.rs`): Template validation, Workflow execution, local
  configuration, external process and Worker lifecycle, adapters and results.
- **CLI** (`src/main.rs`): command discovery, tool inspection, configuration
  diagnostics and supported Worker checks over Core; not a workflow runner.
- **Desktop** (`apps/desktop`): React/TypeScript frontend and Tauri 2 Rust
  application for Tool Setup, Workflow editing, execution, results and export.

Core and CLI share the root Cargo package. Desktop depends on Core directly;
Tauri commands remain the application boundary. See
[Architecture Overview](docs/architecture/overview.md) and
[External Tool Boundary](docs/architecture/external-tool-boundary.md).

## Project Structure

```text
src/
  lib.rs                    # Shared Rust Core
  main.rs                   # Engineering and diagnostic CLI
apps/desktop/
  src/                      # React / TypeScript frontend
  src-tauri/                # Tauri application crate
docs/
  core/ cli/ desktop/       # Component references and user guides
  architecture/ contracts/  # Architecture and formal contracts
  help/                     # Offline Help maintenance
scripts/                    # Build and Help maintenance
tests/                      # Integration tests
.github/workflows/          # CI and manual Windows build
Cargo.toml
Cargo.lock
```

## Key Dependencies

| Component | Purpose |
| --- | --- |
| Rust, Clap | Core and CLI |
| Serde, serde_json, TOML | Template data and local configuration |
| ureq, rust_decimal | Worker HTTP communication and decimal calculations |
| csv, rust_xlsxwriter | CSV and XLSX export |
| Tauri 2, React, TypeScript, Vite | Desktop application and frontend |
| React Flow (@xyflow/react), Apache ECharts | Workflow editor and charts |
| Microsoft Edge WebView2 Runtime | System-provided Windows Desktop runtime |

Exact resolved dependencies are in [Cargo.lock](Cargo.lock),
[Desktop Cargo.lock](apps/desktop/src-tauri/Cargo.lock) and
[package-lock.json](apps/desktop/package-lock.json). See the
[third-party notices](THIRD_PARTY_NOTICES.txt) for licensing and distribution.
Python is used only to maintain and verify offline Help; normal Desktop builds
and users do not need Python.

## Install

For a prebuilt Windows x64 package, extract the entire distribution, including
license and notice files. No installer is required. Desktop requires the
system [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/);
the application does not bundle or install it. Install external tools separately
as needed by the Workflow. Select their CLI/Worker executable and preserve the
complete external distribution, including any adjacent runtime files. See
[Configure External Tools](docs/desktop/guide/external-tools.md).

Source development requires stable Rust supporting edition 2024, Node.js/npm
(Node.js 24 is used by CI) and Tauri 2 platform prerequisites. From the
repository root, install frontend dependencies on first setup or after
lockfile changes:

```powershell
cd apps\desktop
npm.cmd ci
```

Cargo resolves Rust dependencies using the existing manifests and lockfiles.

## Quick Start

### Windows application

Run `Orchestrator Tool.exe` to edit and run workflows; no separate CLI startup
is required. Follow the first Simulation tutorial in the
[Desktop User Guide](docs/desktop/USER_GUIDE.md), or select **Help** in Desktop.

From PowerShell in the distribution directory, inspect the CLI:

```powershell
.\orchestrator-tool.exe --help
.\orchestrator-tool.exe --version
.\orchestrator-tool.exe doctor
.\orchestrator-tool.exe tools list
.\orchestrator-tool.exe user-guide --lang en
```

These commands do not run a workflow or verify hardware. CLI does not
automatically read Desktop settings; use `--config` with an existing TOML file
for configured EXEs. See the [CLI User Guide](docs/cli/USER_GUIDE.md).

### Source development

From the repository root, inspect the CLI with `cargo run --locked -- --help`.
After the Install step, launch the full Desktop from the repository root:

```powershell
cd apps\desktop
npm.cmd run tauri dev
```

Tauri starts Vite automatically. For frontend-only work, `npm.cmd run dev`
(from `apps/desktop`) starts only Vite, without native Tauri workflow operations.

## Build

From the repository root in Windows PowerShell:

```powershell
.\scripts\build-all.ps1
```

The script builds the locked CLI and Desktop, checks CLI startup and stages the
Windows x64 distribution without an installer:

```text
dist/windows-x64/
  Orchestrator Tool.exe
  orchestrator-tool.exe
  LICENSE
  THIRD_PARTY_NOTICES.txt
  licenses/
```

The notice directory includes upstream ECharts notices and collected package
notice files with a dependency/source index (`licenses/DEPENDENCIES.txt`).
Keep these accompanying files with the EXEs and review the index before
distribution.

The existing **Build Windows CLI and Desktop** GitHub Actions workflow runs on
demand and uploads the distribution with the short Git commit SHA in the
artifact name. It does not create a release or tag. A successful build is not
a GUI or hardware test.

## Test

From the repository root, the Core/CLI baseline is:

```powershell
cargo fmt --all --check
cargo clippy --locked --all-targets --all-features -- -D warnings
cargo test --locked
cargo build --locked
```

From `apps/desktop`, after installing frontend dependencies:

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
```

Select focused checks first; see [AGENTS.md](AGENTS.md) for Tauri checks and
[Testing Guidelines](docs/testing-guidelines.md) for test ownership and evidence
boundaries. Existing CI runs on Linux and Windows for pull requests and pushes
to `main`. Default tests are hardware-free. Automated tests, fake Workers,
real Tool Simulation, Windows builds, GUI checks and Live hardware validation
are distinct forms of evidence.

## Documentation

- [Desktop User Guide](docs/desktop/USER_GUIDE.md)
- [CLI User Guide](docs/cli/USER_GUIDE.md)
- [Core README](docs/core/README.md)
- [CLI README](docs/cli/README.md)
- [Desktop README](docs/desktop/README.md)
- [Architecture Overview](docs/architecture/overview.md)
- [External Tool Boundary](docs/architecture/external-tool-boundary.md)
- [Template Format](docs/contracts/template-schema.md) and [Contracts](docs/contracts/)
- [Testing Guidelines](docs/testing-guidelines.md)
- [Offline Help Maintenance](docs/help/README.md)
- [Changelog](CHANGELOG.md)

## Contributing

Read [Contributing](docs/CONTRIBUTING.md), [AGENTS.md](AGENTS.md), applicable
[Testing Guidelines](docs/testing-guidelines.md) and contracts. Keep changes
focused, preserve component and safety boundaries, and report what was and was
not verified. Live validation requires separate authorization and applicable
external tool safety requirements.

## License and Disclaimer

Copyright (c) 2026 tom758258. Orchestrator Tool is licensed under the
[MIT License](LICENSE). Third-party components retain their respective license
terms; see [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt).

The Orchestrator Tool application icon was generated with OpenAI image generation in ChatGPT, then reviewed and selected by the project maintainer.

Orchestrator Tool is an independent, unofficial project. It does not claim
affiliation, sponsorship or endorsement by instrument manufacturers or
third-party vendors. Meters, Powers, Scopes, Serial, Wavegen and other external
tools remain separate projects and distributions; this repository does not
bundle or redistribute them. Third-party names and trademarks belong to their
respective owners. Users must comply with applicable software, driver,
instrument and documentation license terms.

Live operation can affect connected hardware. Follow applicable external tool
and instrument safety requirements. No warranty is provided under the MIT License.
