# Configure External Tools

<!-- help-source -->

## Choose the right executable

External tools are separate programs. Orchestrator stores a path to each one and starts its CLI/Worker when needed. It does not bundle, install, or start the standalone Desktop or WebUI for you.

| Tool Type | Purpose | EXE to select in Tools |
| --- | --- | --- |
| [Meters](https://github.com/tom758258/meters-tool) | Digital multimeter | `meters-tool.exe` |
| [Powers](https://github.com/tom758258/powers-tool) | Power supply | `powers-tool.exe` |
| [Scopes](https://github.com/tom758258/scopes-tool) | Oscilloscope | `scopes-tool.exe` |
| [Serial](https://github.com/tom758258/serial-tool) | UART / TCP communication | `serial-tool.exe` |
| [Wavegen](https://github.com/tom758258/wavegen-tool) | Waveform generator | Workflow execution not supported yet. The separate project currently documents a Python CLI, not a standalone Windows release. |

Choose only tools you need. Consult each project's release instructions for compatible versions and supported instruments. The file name alone is not proof of compatibility.

### Why there are several EXEs

The Meters, Powers and Scopes Windows packages can include multiple executables. Select only the CLI/Worker EXE in Tools; keep the other files in the original distribution.

| Tool | Select this CLI/Worker | Other interface and helper EXEs (do not select) |
| --- | --- | --- |
| Meters | `meters-tool.exe` | `Meters Tool.exe`, `meters-tool-webui-launcher.exe`, `meters-tool-webui-host.exe` |
| Powers | `powers-tool.exe` | `Powers Tool.exe`, `powers-tool-webui-launcher.exe`, `powers-tool-webui-host.exe` |
| Scopes | `scopes-tool.exe` | `Scopes Tool.exe`, `scopes-tool-webui-launcher.exe`, `scopes-tool-webui-host.exe` |

| File category | Purpose |
| --- | --- |
| Desktop (e.g. `Meters Tool.exe`) | Standalone graphical interface |
| WebUI Launcher | Opens the browser interface |
| WebUI Host | Private Desktop helper |
| `_internal/` | Shared Python runtime and dependencies |

Serial uses a different Windows package: `Serial Tool.exe` is its standalone Desktop; `serial-tool.exe` is its CLI/Worker. The package contains two standalone EXEs and notices, rather than the Python onedir layout.

## Extract and keep the full package

For a PyInstaller `onedir` package, the EXE needs the adjacent runtime directory. Extract the entire ZIP, keep all files and folders together, and select the CLI EXE in its original folder. Do not copy only the EXE into Orchestrator's directory. You do not need to open the external tool's Desktop or WebUI first.

Example folder layout (not a required location or an exhaustive file list):

```text
D:/InstrumentTools/
  Orchestrator/
    Orchestrator Tool.exe
    orchestrator-tool.exe
  Meters/
    Meters Tool.exe
    meters-tool.exe              <-- SELECT THIS
    meters-tool-webui-launcher.exe
    meters-tool-webui-host.exe
    _internal/                   <-- KEEP WITH THE EXE
    resources/
    ...
  Serial/
    Serial Tool.exe
    serial-tool.exe              <-- SELECT THIS
    ...
```

Powers and Scopes follow the same Python package principle as Meters. Orchestrator does not move or copy the EXE or its `_internal` directory. If you move a complete package later, use Change Path to update its location.

## Add a tool

1. Open the **Tools** tab.
2. Under **Select tool to add**, select an unconfigured Tool Type.
3. Choose **Add Tool** and select the corresponding CLI/Worker EXE.
4. Check its availability and compatibility. Desktop checks the executable's manifest (tool identity and supported interface information) and Worker compatibility before saving the path.
5. Go to **Setup** to add the Tool Instance you want to use.

A wrong Tool ID or incompatible Worker is rejected. A rejected selection does not replace an existing valid path. Canceling the file picker leaves configuration unchanged.

## Understand the status

| Status or situation | What it means | What to do |
| --- | --- | --- |
| EXE available | The configured file can be found | Check compatibility too; this is not a hardware test. |
| Missing | The saved file path no longer exists | Choose Change Path and select the actual EXE. |
| Not a file | The path is not a file | Select the correct EXE. |
| Manifest or compatibility error | Identity or interface checks failed | Check the selected EXE and tool version; read the reported reason. |
| No external tools configured. | No path has been saved | Use Add Tool. |

Cards show only configured Tool Types, even when the saved path has errors. Unconfigured types appear in the Add candidates; Add is disabled when all are configured. Desktop does not search `PATH`, Windows registry or arbitrary folders, or silently choose a different executable.

## Manage configured tools

| Control | Effect |
| --- | --- |
| Change Path... | Replace the saved executable path after validation. |
| Remove Tool | Remove only the local executable setting; the type returns to the Add list. |
| Refresh | Check the current tool status again. |
| + / − | Show or hide card details and actions. |

Cards start collapsed, showing the tool name and executable status. Refresh and tab changes preserve the card state. Removing a tool does not delete its files, Template instances or Workflow steps.

## One path, multiple Tool Instances

Configure the executable once per Tool Type in Tools. Each named Tool Instance in Setup has its own settings and, when supported, its own saved Live Resource.

```text
Tools: Meters -> meters-tool.exe
                  |
                  +-- Setup: Meter A (DC Voltage)
                  |
                  +-- Setup: Meter B (DC Current)
```

Both instances use the same EXE; an instance does not store a separate executable path. The path belongs to this computer, not the reusable Template.
