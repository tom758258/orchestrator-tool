# Orchestrator Tool CLI

[繁體中文](README.zh-TW.md) | [CLI User Guide](USER_GUIDE.md) | [Core](../core/README.md) | [Project README](../../README.md)

The `orchestrator-tool` binary (`orchestrator-tool.exe` on Windows) is an engineering and diagnostic interface over the shared Rust Core. It checks local tool configuration, executable status, external-tool manifests and selected Worker startup paths. The CLI does **not** edit or execute workflow Templates.

## Commands

| Command | Behavior |
| --- | --- |
| `orchestrator-tool --help` / `--version` | Show command help or product version |
| `orchestrator-tool doctor` | Summarize configured external-tool executable availability |
| `orchestrator-tool tools list` | List registered tool IDs and executable path, source and status |
| `orchestrator-tool tools inspect <TOOL_ID>` | Inspect one tool; probe its manifest if the executable is available |
| `orchestrator-tool tools worker-check meters` | Run the bounded Meters Worker simulation diagnostic |
| `orchestrator-tool tools worker-check powers` | Run the bounded Powers Worker simulation diagnostic |

`--config <PATH>` is a global option accepted with the commands above. Use `orchestrator-tool <command> --help` for the current parser syntax. The built-in registry includes `meters`, `powers`, `scopes`, `serial` and `wavegen`; registry membership does not imply that every diagnostic or workflow action is supported for every tool. In particular, `worker-check` currently accepts only `meters` and `powers`.

## Configuration

Without `--config`, the CLI uses an empty in-memory configuration, **not** an automatically discovered Desktop settings file. To inspect specific external EXEs, supply an existing TOML file:

```toml
[tools]
meters = "C:/Example/Meters/meters-tool.exe"
powers = "C:/Example/Powers/powers-tool.exe"
```

The paths above are illustrative; use paths to your installed tools. Relative executable paths in the file are resolved relative to that file's directory. An unknown tool ID or invalid configuration fails validation. No executable search fallback is performed when a path is unconfigured.

## Status and exit behavior

`doctor` and `tools list` report `available`, `missing`, `not-file` or `not-configured` status; `doctor` shows `[OK]` for available entries. Those commands do not turn an unavailable external tool into a command failure by themselves. `tools inspect` reports `not-probed` when its executable is unavailable; otherwise it invokes the configured tool to inspect the manifest and compatibility. A manifest probe failure produces a failing exit status.

`worker-check` requires a configured, available executable, performs a bounded simulation Worker check, and returns failure for an unsupported ID or unsuccessful check. A successful simulation diagnostic is **not** evidence of Live hardware operation. Diagnostic text is human-readable; this CLI does not advertise a JSON output flag.

## Development and references

From the repository root:

```sh
cargo run --locked -- --help
cargo run --locked -- doctor
cargo run --locked -- tools list
```

For practical PowerShell steps and troubleshooting see the [CLI User Guide](USER_GUIDE.md). For Core/module ownership see [Core README](../core/README.md); for external execution rules see [External Tool Boundary](../architecture/external-tool-boundary.md). Follow [AGENTS.md](../../AGENTS.md) and [Testing Guidelines](../testing-guidelines.md) when modifying code.
