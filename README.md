# orchestrator-tool

`orchestrator-tool` is a Rust-based multi-instrument orchestrator intended to coordinate external instrument tools through a shared core.

## Architecture

- Core library (`src/lib.rs`): shared orchestration and domain logic. It must remain independent of CLI and desktop presentation layers.
- CLI binary (`src/main.rs`): lightweight engineering CLI for setup, discovery, diagnostics, and maintenance. It uses Core from the same `orchestrator-tool` Cargo package.
- Desktop application: planned Tauri 2 frontend for visual workflow editing, templates, execution, and monitoring. It is intentionally not part of P0.

The project is Windows-first for deployment, while keeping shared Core code platform-neutral where practical. Instrument contracts, IPC, workflow execution, and Tauri integration are intentionally deferred until their respective implementation work begins.

## Executable configuration

Core can load a TOML configuration file selected by its caller and use it to override built-in portable executable paths:

```toml
[tools]
meters = "D:/tools/meters-tool.exe"
```

Configured paths take priority over portable paths. A missing configured path is reported as missing without falling back to the portable path. Relative configured paths are resolved from the directory containing the configuration file. `tools list` accepts an optional caller-supplied configuration path and does not auto-discover configuration files.

## External process management

Core can start generic external processes with arguments and expose their process ID, non-blocking status checks, waiting, and forced termination. Standard input, output, and error remain inherited. A managed process performs best-effort termination and cleanup when dropped.

The CLI does not expose process management yet, and IPC and instrument-specific contracts remain deferred.

## CLI

P5-A established the command framework, P5-B implemented external tool listing, and P5-C implements environment diagnostics:

```text
orchestrator-tool --help
orchestrator-tool --version
orchestrator-tool doctor
orchestrator-tool tools list
orchestrator-tool --config <PATH> doctor
orchestrator-tool --config <PATH> tools list
```

`tools list` lists the four built-in external tools and reports each executable's `configured` or `portable` source and `available`, `missing`, or `not-file` status. Missing tools are normal discovery results and do not cause the command to fail. Configuration errors and other discovery I/O errors are reported to stderr with a non-zero exit code.

`doctor` reports the application directory, configuration state, the status of the four built-in external tools, and summary counts. Missing and not-file tools are normal diagnostic results and do not cause the command to fail. Configuration errors and other discovery I/O errors are reported to stderr with a non-zero exit code. It does not perform instrument-level diagnostics.

The CLI still does not expose process management, and instrument-specific contracts and IPC remain deferred.

## Development

Use stable Rust and run checks from the repository root:

```text
cargo build --locked
cargo test --locked
cargo fmt --all --check
cargo clippy --locked --all-targets --all-features -- -D warnings
```

The CLI currently provides P5-B tool listing and P5-C environment diagnostics. Instrument-level diagnostics remain deferred.
