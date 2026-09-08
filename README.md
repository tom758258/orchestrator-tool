# orchestrator-tool

`orchestrator-tool` is a Rust-based multi-instrument orchestrator intended to coordinate external instrument tools through a shared core.

## Architecture

- Core library (`src/lib.rs`): shared orchestration and domain logic. It must remain independent of CLI and desktop presentation layers.
- CLI binary (`src/main.rs`): lightweight engineering CLI for setup, discovery, diagnostics, and maintenance. It uses Core from the same `orchestrator-tool` Cargo package.
- Desktop application: Tauri 2 frontend with built-in external-tool status, a session-only visual workflow builder with a click-to-add step palette, a linear canvas, node execution controls and result status, parameter editing, template load/save, simulated workflow runs, and full step-result display.

The project is Windows-first for deployment, while keeping shared Core code platform-neutral where practical. Core includes Common Worker process and local HTTP IPC support plus focused Powers and Meters Worker diagnostics. Core defines a linear workflow domain, versioned JSON templates, per-step results, and a linear workflow executor. A Powers and Meters simulate-mode vertical slice exercises workflow execution through Worker HTTP and stdout events into step results, and Desktop can run that simulation and display its results. Desktop builds the linear workflow through a session-only visual canvas; canvas positions are not persisted in templates, the CLI does not provide a workflow run command, and live-hardware workflow execution is not enabled.

## Executable configuration

Core can load a TOML configuration file selected by its caller and use it to override built-in portable executable paths:

```toml
[tools]
meters = "D:/tools/meters-tool.exe"
powers = "D:/tools/powers-tool.exe"

[live_resources]
meters = "USB0::VENDOR::METER_SERIAL::INSTR"
powers = "USB0::VENDOR::POWER_SERIAL::INSTR"
```

Configured paths take priority over portable paths. A missing configured path is reported as missing without falling back to the portable path. Relative configured paths are resolved from the directory containing the configuration file. `tools list` accepts an optional caller-supplied configuration path and does not auto-discover configuration files.

The Desktop application exposes the same configuration through its Tools tab: each built-in tool offers Browse... to persist a configured executable path and Use Portable Default to remove that override. The Desktop persists these overrides in a single `orchestrator.toml` file inside the OS / Tauri application config directory (under the application bundle identifier). Tool Status and Run Simulation load the same persisted configuration, so the executables shown in the Tools tab are the ones used for simulated runs. A missing config file simply means portable behavior.

The optional `live_resources` table stores exact resource strings without path resolution, scanning, or fallback. Core adapters and Desktop preparation can build live Worker launch details; live workflow execution remains disabled. Simulation behavior is unchanged.

## External process management

Core can start generic external processes with arguments and expose their process ID, non-blocking status checks, waiting, and forced termination. Standard input, output, and error remain inherited. A managed process performs best-effort termination and cleanup when dropped.

The CLI exposes focused Powers and Meters Worker diagnostics while Core retains process ownership and cleanup.

## CLI

The CLI provides command discovery, external tool listing, and environment diagnostics:

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
