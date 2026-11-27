# Getting Started

<!-- help-source -->

## What Orchestrator Tool does

Orchestrator Tool runs reusable test and measurement workflows. You choose the instruments, arrange the steps, and inspect or export the results. The separate external tools handle communication with the instruments.

```text
Orchestrator Tool (Desktop)
        |
        +-- Meters Tool  --> digital multimeter
        +-- Powers Tool  --> power supply
        +-- Scopes Tool  --> oscilloscope
        +-- Serial Tool  --> UART / TCP device
```

This is a conceptual diagram for Live mode. Simulation uses the tools' simulators instead. Wavegen is a separate project; Workflow execution with Wavegen is not supported yet.

## What you need

| Requirement | What to do |
| --- | --- |
| Windows | Use the Windows Desktop release and extract it to a folder. |
| Microsoft Edge WebView2 Runtime | Install the system runtime if it is missing. |
| External tool EXEs | Obtain the tools you need separately. See [Configure External Tools](external-tools.md). |
| Physical instruments | Not needed for the Simulation tutorial. Required for Live operation with the relevant connections and supported devices. |

The application does not install WebView2 or external tools. If WebView2 is missing, the startup warning offers the official download page and the Desktop window is not created. If the check passes but the window still cannot initialize, Desktop shows a startup error with technical details and exits. Keep those details if you need help.

## Find your way around

| Tab | What you do there |
| --- | --- |
| Tools | Set the external tool EXE paths; check availability and compatibility. |
| Setup | Add named Tool Instances, configure instruments and save local Live Resources where supported. |
| Workflow | Add and arrange steps, validate, run or stop, and configure CSV streaming. |
| Output | Inspect the latest run, messages, charts, summary, data and export results. |

**Appearance**, **Language**, and **Help** are at the upper right. The **Template** controls (New, Open and Save) are on the left of the next row; **Execution Mode** is on the right. Help opens this offline guide in a separate application window.

## Key terms

| Term | Meaning |
| --- | --- |
| Tool Type | Instrument category, such as Meters. Configure its EXE path once. |
| Tool Instance | A named set of instrument settings used by a workflow. A type can have multiple instances. |
| Step | An action in a workflow, such as measuring, waiting or outputting data. |
| Template | Reusable tool settings and workflow steps, without local EXE paths or measurement results. |
| Worker | An external tool process started by Orchestrator to perform instrument operations; no manual launch is needed. |

## Your first Simulation

Start with one simulated multimeter measurement. You do not need an actual meter or VISA connection for this example.

1. Extract Orchestrator Tool and a compatible Meters Tool release into separate folders. Open `Orchestrator Tool.exe`.
2. In **Tools**, select **Meters**, choose **Add Tool**, and select `meters-tool.exe`. Confirm availability and compatibility.
3. In **Setup**, add one Meters Tool Instance. Select **DC Voltage**, use Auto range and keep Background Streaming off. Use a supported NPLC and Auto Zero setting. Foreground uses Single measurement.
4. In **Workflow**, choose the **Meter Measure** step in the Steps palette and press **Add Step**. Select the Meters instance in Properties. Add an **Output** step after Meter Measure.
5. In Output Properties, choose a name (for example, `Voltage`) and a Page (for example, `Results`). Choose **Previous step result**, select the preceding Meter Measure step and its **Value** result.
6. Keep **Simulation** selected. Use **Validate** to check the template, then **Run Simulation**.
7. Open the **Output** tab. Check the execution status and the Results page: the Output column contains a simulated reading. The value is simulator data, not an actual voltage.
8. When the run has ended, you can export the row as CSV or XLSX. Use **Save Template** to save the reusable workflow, not the measurement itself.

```text
Tools -> Setup -> Workflow -> Run Simulation -> Output
                                           -> Save Template
```

If an instrument category is unavailable, check whether you added the matching Tool Instance. If a run fails, read its error and see [Troubleshooting and Safety](troubleshooting.md).

## Choose the execution mode

| Mode | Meaning |
| --- | --- |
| Simulation | Test the workflow without physical hardware I/O. Default at startup and after New or Open Template. |
| Live | Operate real hardware after saving resources and confirming the run. |

One mode applies to the entire execution, not to individual Tool Instances. The mode label and the label on each instance show **SIMULATION · NO HARDWARE I/O** or **LIVE · REAL HARDWARE**. The selector is locked while a workflow or manual external operation is active. The choice is temporary; it is not saved in a Template or local configuration. A badge does not indicate that Wavegen execution is supported.

For real instruments, read [Run Simulation and Live](execution.md) and its safety requirements before changing the mode.
