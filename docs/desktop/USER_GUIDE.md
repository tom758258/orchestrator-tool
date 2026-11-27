# Orchestrator Tool Desktop User Guide

Start here if you are new to Orchestrator Tool. Learn to prepare external tools, build reusable workflows, run them and inspect or export results. You do not need to know the internal architecture.

<!-- help-navigation -->

## Choose Your Interface

The Windows release provides two user-facing executables:

| Program | Purpose |
| --- | --- |
| `orchestrator-tool.exe` | CLI engineering diagnostics: environment, external EXEs, manifests and supported Worker checks. |
| `Orchestrator Tool.exe` | Desktop: author and run Workflows; inspect and export results. |

For ordinary operation, open `Orchestrator Tool.exe`; there is no need to start the CLI first. Start `Orchestrator Tool.exe` and select **Help** in the upper-right corner for offline guidance. To open the CLI guide from Windows PowerShell, use `.\orchestrator-tool.exe user-guide --lang en`. The Windows build places both programs in `dist/windows-x64/`; install external Tool EXEs separately.

## Guide Chapters

Follow First use in order, complete a Simulation, then use the other sections as references.

### First use

- [Getting Started](guide/getting-started.md)
- [Configure External Tools](guide/external-tools.md)
- [Tool Setup and Instances](guide/tool-setup.md), including manual Error Queue diagnostics
- [Workflow Editor](guide/workflow-editor.md)
- [Run Simulation and Live](guide/execution.md)

### Basic operations and step reference

- [Input Values and Data Flow](steps/input-values.md)
- [Workflow Steps](steps/workflow.md), including String Process, Byte Process fixed-string editing, and Array Process
- [Meters Steps](steps/meters.md)
- [Powers Steps](steps/powers.md)
- [Scopes Actions](steps/scopes.md)
- [Serial Background RX and Actions](steps/serial.md)

### Advanced acquisition

- [Background Streaming and Streaming CSV](guide/background-streaming.md)
- [Background Interaction Steps (including optional Data Buffer)](steps/background.md)

### Results, templates and troubleshooting

- [Run Results](guide/results.md)
- [Charts](guide/charts.md)
- [Output Data and Export](guide/results-and-export.md)
- [Templates and Preferences](guide/templates-and-settings.md)
- [Troubleshooting and Safety](guide/troubleshooting.md)
