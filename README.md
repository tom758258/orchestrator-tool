# orchestrator-tool

`orchestrator-tool` is a Rust-based multi-instrument orchestrator intended to coordinate external instrument tools through a shared core.

## Architecture

- `orchestrator-core`: shared orchestration and domain logic. It must remain independent of CLI and desktop presentation layers.
- `orchestrator-cli`: lightweight engineering CLI for setup, discovery, diagnostics, and maintenance.
- Desktop application: planned Tauri 2 frontend for visual workflow editing, templates, execution, and monitoring. It is intentionally not part of the initial Rust workspace yet.

The project is Windows-first for deployment, while keeping shared Core code platform-neutral where practical. Instrument contracts, IPC, workflow execution, and Tauri integration are intentionally deferred until their respective implementation work begins.

## Development

Use stable Rust and run checks from the repository root:

```text
cargo build --workspace
cargo test --workspace
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
```

The CLI currently provides only the repository baseline and prints the product name and version.
