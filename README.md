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

Configured paths take priority over portable paths. A missing configured path is reported as missing without falling back to the portable path. Relative configured paths are resolved from the directory containing the configuration file. The CLI does not load configuration files yet.

## Development

Use stable Rust and run checks from the repository root:

```text
cargo build --locked
cargo test --locked
cargo fmt --all --check
cargo clippy --locked --all-targets --all-features -- -D warnings
```

The CLI currently provides only the repository baseline and prints the product name and version.
