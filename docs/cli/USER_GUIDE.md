# Orchestrator Tool CLI User Guide

Use the CLI to diagnose the Orchestrator environment and configured external tool executables. Workflow editing and Simulation/Live workflow runs belong to the Desktop, not the CLI.

## Choose Your Interface

The Windows release contains two EXEs:

| Program | Purpose |
| --- | --- |
| `orchestrator-tool.exe` | CLI: external-tool configuration, manifest and Worker diagnostics. |
| `Orchestrator Tool.exe` | Desktop: Workflow authoring, Simulation/Live runs and result export. |

This guide covers the CLI; use **Help** in the upper-right corner of `Orchestrator Tool.exe` for Desktop operation.

## Open the Offline User Guide

```powershell
.\orchestrator-tool.exe user-guide
.\orchestrator-tool.exe user-guide --lang en
.\orchestrator-tool.exe user-guide --lang zh-TW
```

The default language is English. The guide opens offline in your system browser; Desktop and instruments are not required.

## 1. Open the CLI

For a Windows release, open PowerShell in the folder containing `orchestrator-tool.exe`:

```powershell
.\orchestrator-tool.exe --help
.\orchestrator-tool.exe --version
.\orchestrator-tool.exe doctor
.\orchestrator-tool.exe tools list
```

If the executable is on `PATH`, use `orchestrator-tool` without `.\`. In a development checkout, the equivalent entry point is `cargo run --locked -- <arguments>` from the repository root.

`doctor` summarizes external executable availability; `tools list` shows each registered tool's resolved status and path. Neither starts a workflow or verifies physical instrument communication.

### Common commands

| Command | Purpose |
| --- | --- |
| --help / --version | Command syntax and version |
| doctor | Environment and external EXE status |
| tools list | Tool list and configured paths |
| tools inspect | Tool identity and compatibility checks |
| tools worker-check | Supported Worker simulation diagnostics (Meters, Powers) |

## 2. Point the CLI to tool executables

| Tool | EXE to select |
| --- | --- |
| Meters | meters-tool.exe |
| Powers | powers-tool.exe |
| Scopes | scopes-tool.exe |
| Serial | serial-tool.exe |

Select the CLI/Worker, not the Desktop EXE with spaces in its name, WebUI Launcher, or private Host. Extract Meters, Powers and Scopes onedir packages completely and retain the adjacent `_internal` directory and other files. Serial's Windows package instead contains two standalone EXEs. Wavegen does not currently document a standalone Windows release build; do not assume completed Workflow integration.

Without a `--config` option, the CLI uses an empty configuration. Create a TOML file if you want to check installed tools, for example `orchestrator.toml`:

```toml
[tools]
meters = "C:/Example/Meters/meters-tool.exe"
powers = "C:/Example/Powers/powers-tool.exe"
```

Replace the example paths with actual installed EXEs. Run:

```powershell
.\orchestrator-tool.exe --config .\orchestrator.toml doctor
.\orchestrator-tool.exe --config .\orchestrator.toml tools list
```

The CLI does not automatically inherit the Desktop's saved EXE paths. A missing or unconfigured EXE is reported as a status; `doctor` and `tools list` can still complete successfully.

## 3. Inspect a tool

```powershell
.\orchestrator-tool.exe --config .\orchestrator.toml tools inspect meters
```

If the configured EXE exists, inspection runs a manifest probe and reports its Worker compatibility information. If not, the manifest is `not-probed`. Inspecting an EXE is not a hardware Live test.

## 4. Check a supported Worker

```powershell
.\orchestrator-tool.exe --config .\orchestrator.toml tools worker-check meters
.\orchestrator-tool.exe --config .\orchestrator.toml tools worker-check powers
```

These checks launch the configured external executable in a bounded Worker simulation diagnostic. They require that the relevant tool is installed and configured. `worker-check` currently does **not** support Scopes, Serial or Wavegen. Do not interpret a passed Worker simulation as physical device verification.

## 5. Common problems and limits

| Symptom | What to check |
| --- | --- |
| `not-configured` | Supply `--config` with a TOML `[tools]` entry; the CLI does not load Desktop settings automatically |
| `missing` or `not-file` | Correct the configured EXE path or point it to a regular file |
| Manifest `not-probed` | The EXE was not available; fix its status before inspecting the manifest |
| Manifest probe or Worker check fails | Confirm the external tool is executable and that its manifest/Worker behavior matches the supported contract |
| `worker check is not supported` | Only `meters` and `powers` are accepted |
| Invalid configuration or Tool ID | Check TOML syntax, registered IDs and the command spelling |

The CLI has no `run`, workflow editor, `--json`. For complete command syntax and exit behavior, use the CLI README and built-in `--help`.
