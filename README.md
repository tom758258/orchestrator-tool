# orchestrator-tool

`orchestrator-tool` is a Rust-based multi-instrument orchestrator intended to coordinate external instrument tools through a shared core.

## Architecture

- Core library (`src/lib.rs`): shared orchestration and domain logic. It must remain independent of CLI and desktop presentation layers.
- CLI binary (`src/main.rs`): lightweight engineering CLI for setup, discovery, diagnostics, and maintenance. It uses Core from the same `orchestrator-tool` Cargo package.
- Desktop application: Tauri 2 frontend with built-in external-tool status, linear workflow and parameter editing, template load/save, simulated workflow runs, and step-result display.

The project is Windows-first for deployment, while keeping shared Core code platform-neutral where practical. Core includes Common Worker process and local HTTP IPC support plus focused Powers and Meters Worker diagnostics. Core defines a linear workflow domain, versioned JSON templates, per-step results, and a linear workflow executor. A Powers and Meters simulate-mode vertical slice exercises workflow execution through Worker HTTP and stdout events into step results, and Desktop can run that simulation and display its results. The visual canvas is not yet implemented, the CLI does not provide a workflow run command, and live-hardware workflow execution is not enabled.

## Executable configuration

Core can load a TOML configuration file selected by its caller and use it to override built-in portable executable paths:

```toml
[tools]
meters = "D:/tools/meters-tool.exe"
```

Configured paths take priority over portable paths. A missing configured path is reported as missing without falling back to the portable path. Relative configured paths are resolved from the directory containing the configuration file. `tools list` accepts an optional caller-supplied configuration path and does not auto-discover configuration files.

## External process management

Core can start generic external processes with arguments and expose their process ID, non-blocking status checks, waiting, and forced termination. Standard input, output, and error remain inherited. A managed process performs best-effort termination and cleanup when dropped.

The CLI exposes focused Powers and Meters Worker diagnostics while Core retains process ownership and cleanup.

## CLI

P5-A established the command framework, P5-B implemented external tool listing, and P5-C implements environment diagnostics:

```text
orchestrator-tool --help
orchestrator-tool --version
orchestrator-tool doctor
orchestrator-tool tools list
orchestrator-tool tools inspect <TOOL_ID>
orchestrator-tool tools worker-check powers
orchestrator-tool tools worker-check meters
orchestrator-tool --config <PATH> doctor
orchestrator-tool --config <PATH> tools list
```

`tools list` lists the four built-in external tools and reports each executable's `configured` or `portable` source and `available`, `missing`, or `not-file` status. Missing tools are normal discovery results and do not cause the command to fail. Configuration errors and other discovery I/O errors are reported to stderr with a non-zero exit code.

`doctor` reports the application directory, configuration state, the status of the four built-in external tools, and summary counts. Missing and not-file tools are normal diagnostic results and do not cause the command to fail. Configuration errors and other discovery I/O errors are reported to stderr with a non-zero exit code. It does not perform instrument-level diagnostics.

`tools worker-check powers` validates the resolved Powers executable and manifest, then runs a bounded simulate-mode `read-status` Worker check without requiring hardware. `tools worker-check meters` validates the resolved Meters executable and manifest, then runs a bounded simulate-mode software-trigger check without requiring hardware.

## Development

Use stable Rust and run checks from the repository root:

```text
cargo build --locked
cargo test --locked
cargo fmt --all --check
cargo clippy --locked --all-targets --all-features -- -D warnings
```

The CLI provides tool listing, manifest inspection, environment diagnostics, and focused Powers and Meters Worker checks.
