# orchestrator-tool

`orchestrator-tool` is a Rust-based multi-instrument orchestrator intended to coordinate external instrument tools through a shared core.

## Architecture

- Core library (`src/lib.rs`): shared orchestration and domain logic. It must remain independent of CLI and desktop presentation layers.
- CLI binary (`src/main.rs`): lightweight engineering CLI for setup, discovery, diagnostics, and maintenance. It uses Core from the same `orchestrator-tool` Cargo package.
- Desktop application: Tauri 2 frontend with built-in external-tool status, a session-only visual workflow builder with a click-to-add step palette, a linear canvas, node execution controls and result status, parameter editing, template load/save, simulation and live workflow runs, and full step-result display.

The project is Windows-first for deployment, while keeping shared Core code platform-neutral where practical. Core includes Common Worker process and local HTTP IPC support plus focused Powers and Meters Worker diagnostics. Core defines a linear workflow domain, versioned JSON templates, per-step results, and a linear workflow executor. Desktop supports Run Simulation and a separate Run Live action for Powers and Meters, sharing the same step results. Template schema version 1 and the linear Workflow do not store execution mode, resources, output authorization, safety cleanup, or canvas positions. The CLI does not provide a workflow run command.

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

The Desktop application exposes the same configuration through its Tools tab: each built-in tool offers Browse... to persist a configured executable path and Use Portable Default to remove that override. Powers and Meters also offer Live Resource with Save Resource and Clear Resource. Desktop persists these settings in a single `orchestrator.toml` file inside the OS / Tauri application config directory (under the application bundle identifier). Tool Status, Run Simulation, and Run Live load this same configuration. A missing config file uses portable executable paths.

The optional `live_resources` table preserves exact non-empty resource strings without path resolution, scanning, or fallback. Live preparation rejects missing or whitespace-only resources and validates executables, manifests, and Worker compatibility before starting any Worker. Simulation remains available without live resources.

Run Live requires operator confirmation showing the referenced resources and warning that real instruments will be controlled and power outputs may change. Powers live writes use both authorization gates: a short-lived Desktop runtime config sets Worker `settings.allow_output_writes=true`, and the runtime adapter injects `arguments.confirm_output=true` into live output-affecting requests. This support file is removed best-effort after the run.

Every live run with a started Powers Worker attempts bounded `safe-off` for all channels before Worker shutdown, including after workflow failure or a later Worker startup failure. An explicit Output OFF step does not replace this safety cleanup. Cleanup failure makes the run fail and preserves any original workflow failure in the error; Worker shutdown is still attempted. Simulation does not perform this additional live cleanup.

Physical hardware support remains subject to each external instrument tool's manifest and product support policy. Real-hardware end-to-end testing has not been performed for this implementation. Scopes and Wavegen live workflows are not supported.

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

### Rust checks

Use stable Rust and run checks from the repository root:

```text
cargo build --locked
cargo test --locked
cargo fmt --all --check
cargo clippy --locked --all-targets --all-features -- -D warnings
```

### Desktop development

The Desktop application is located in `apps/desktop`.

From the repository root, install frontend dependencies the first time you set up the Desktop application, or after its dependencies change:

```powershell
cd apps\desktop
npm.cmd install
```

You do not need to run `npm.cmd install` every time you start the Desktop application.

To start the frontend-only development server from `apps/desktop`:

```powershell
npm.cmd run dev
```

`npm.cmd run dev` starts only the Vite frontend development server. To start the complete Tauri Desktop application, run:

```powershell
cd apps\desktop
npm.cmd run tauri dev
```

Use `npm.cmd run tauri dev` to validate complete Desktop functionality, including Tauri commands, dialogs, configuration, and workflow execution.

Common frontend static checks from `apps/desktop` are:

```powershell
npx.cmd tsc --noEmit
npm.cmd run build
```

The CLI provides tool listing, manifest inspection, environment diagnostics, and focused Powers and Meters Worker checks.
