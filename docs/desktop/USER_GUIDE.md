# Orchestrator Tool Desktop User Guide

This guide describes the Desktop behavior currently available in
Orchestrator Tool. It is written for operators and engineers who configure
external tools, build reusable Templates, run workflows, and inspect or export
their results.

<!-- help-navigation -->

## Choose Your Interface

The Windows release provides two user-facing executables:

| Program | Purpose |
| --- | --- |
| `orchestrator-tool.exe` | CLI engineering diagnostics: environment, external EXEs, manifests and supported Worker checks. |
| `Orchestrator Tool.exe` | Desktop: author and run Workflows; inspect and export results. |

This guide covers Desktop. Start `Orchestrator Tool.exe` and select **Help** in the upper-right corner for offline guidance. To open the CLI guide from Windows PowerShell, use `.\orchestrator-tool.exe user-guide --lang en`. The Windows build places both programs in `dist/windows-x64/`; install external Tool EXEs separately.

## Guide Chapters

- [Getting Started](guide/getting-started.md)
- [Configure External Tools](guide/external-tools.md)
- [Tool Setup and Instances](guide/tool-setup.md)
- [Workflow Editor](guide/workflow-editor.md)
- [Input Values and Data Flow](steps/input-values.md)
- [Powers Steps](steps/powers.md)
- [Workflow Steps](steps/workflow.md)
- [Scopes Actions](steps/scopes.md)
- [Background Interaction Steps](steps/background.md)
- [Run Simulation and Live](guide/execution.md)
- [Background Streaming and Streaming CSV](guide/background-streaming.md)
- [Run Results](guide/results.md)
- [Charts](guide/charts.md)
- [Output Data and Export](guide/results-and-export.md)
- [Templates and Preferences](guide/templates-and-settings.md)
- [Troubleshooting and Safety](guide/troubleshooting.md)
- [Serial Background RX and Actions](steps/serial.md)

## Step Reference

See **Workflow Steps, Input Values, Powers, Scopes, Background and Serial** above for the implemented Step parameters and limits. Detailed per-Step examples can be added to their own pages when available.
