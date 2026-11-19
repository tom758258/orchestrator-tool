# Orchestrator Tool Core

[繁體中文](README.zh-TW.md) | [Project README](../../README.md) | [CLI](../cli/README.md) | [Desktop](../desktop/README.md)

Core is the shared Rust library in `src/lib.rs` of the root `orchestrator-tool` Cargo package. It supplies orchestration behavior to the diagnostic CLI and the Tauri Desktop backend. It is not a separate crate or an instrument driver.

## Responsibilities

| Area | Main modules | Ownership |
| --- | --- | --- |
| Templates and workflows | `template.rs`, `workflow.rs`, `executor.rs` | Loading, validation, ordered execution, expressions and control flow |
| Run preparation and lifecycle | `run_preparation.rs`, `run.rs`, `run_failure.rs` | Resolving run requirements, starting and cleaning up external Workers |
| External-tool discovery | `config.rs`, `discovery.rs`, `inspection.rs`, `manifest_probe.rs` | Machine-local configuration, executable status, manifest and compatibility inspection |
| Worker communication | `worker.rs`, `worker_http.rs`, `common_job.rs`, `common_v3.rs` | Process/Worker lifecycle and Common Worker interaction |
| Tool integration | `adapters/`, `meters_setup.rs`, `powers_setup.rs`, `scopes_setup.rs`, `serial_setup.rs` | Orchestrator-side preparation and validation; no device-specific drivers |
| Results and background work | `data_context.rs`, `background.rs`, `background_export.rs`, `workflow_csv.rs`, `workflow_export.rs` | Committed results, background capture and export |

These are module groups, not additional packages. Consult [Architecture Overview](../architecture/overview.md) for detailed execution and result lifecycles, and [Template Format](../contracts/template-schema.md) for normative Template and Workflow rules.

## Boundaries

- `src/main.rs` is the CLI entry point. It calls Core for discovery and diagnostics; Core does not own argument parsing or command-line presentation.
- `apps/desktop/src-tauri` depends directly on the root Rust library. Tauri commands and the React/TypeScript interface must not become a second workflow engine.
- Meters, Powers, Scopes, Serial and other supported external tools are separate executables and distributions. Their own projects own physical I/O, VISA/SCPI, instrument models and device-level safety. See [External Tool Boundary](../architecture/external-tool-boundary.md).
- Templates describe portable Tool Instances and Workflow behavior. Executable paths and Live Resources are machine-local configuration; runtime results are not a persistent run-history database.
- Core coordinates Worker startup, execution and cleanup. A Worker accepting a Job is not proof of completion; a run's outcome must respect final Job results and shutdown/safety behavior.

## Development and verification

From the repository root:

```sh
cargo build --locked
cargo test --locked
```

Run only the checks relevant to a change before any broader package baseline. Follow [AGENTS.md](../../AGENTS.md) and [Testing Guidelines](../testing-guidelines.md); normal validation does not require real instruments. The relevant contracts, not this overview, define machine-readable schemas.
