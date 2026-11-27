# Tool Setup and Instances

<!-- help-source -->

## Understand Tool Instances

A Tool Instance is a named set of instrument settings in a Template. A Template can contain multiple instances of the same Tool Type, such as two Meters instances for voltage and current.

| Information | Storage |
| --- | --- |
| Instance and instrument setup | Template |
| Executable path | Local computer, shared by Tool Type |
| Live Resource | Local computer, per instance |

### Setup sections

```text
Tool Instance
  +-- Tool-specific setup
  +-- Background Streaming (initially collapsed)
  +-- Live Device (initially expanded)
```

Each instance has its own bordered card and starts expanded. Use **+ / −** to
collapse or expand it. **Tool Instance Summary**, above Add Tool Instance, counts
instances by Tool Type, including types not configured locally. Unused types
are omitted, and the summary is hidden when there are no instances.

Within each instance, tool settings come first, followed by **Background
Streaming**, then **Live Device**, with separators around Background Streaming.
Both sections have independent **− / +** controls. Background Streaming starts
collapsed; Live Device starts expanded. Expand Background Streaming and select
**Enable Background Streaming** to show the supported Background options.
Unsupported Tool Types keep this checkbox disabled and show an explanation.
Use Worker and Capture actions to control background streaming and data recording.

Group and card expansion states persist while editing, switching tabs, or
collapsing an outer instance. Successful **New Template** or **Open Template**
restores the default states, including External Tools cards. These UI states
are not saved in the Template or local settings.

### Add and name an instance

**Add Tool Instance** has a **Tool type (select from list)** dropdown that offers only Tool Types configured in Tools, including
those with a Missing or Error status. With no configured Tool Type, adding an
instance is disabled. Existing instances remain visible when their Tool Type
is not locally configured, with a warning that disappears after configuration.

Expand any Tool Instance to edit **Display Name
(optional)**. Leave it blank to use the default instance ID. Names may include
Chinese, English, numbers, and spaces, and different instances may share a name.
The Setup title and Workflow Target options update immediately; the original
**Instance ID** remains visible, including when collapsed. Target options keep
any available model and serial information. Sequence summaries that show a target
also show its name and ID; action and parameter summaries keep their existing format.
Names are saved with the Template and restored on loading. Leading and trailing
spaces are trimmed on leaving the field or saving; clearing the name or entering
only whitespace restores the ID. Editing is disabled while busy. Renaming does
not change Workflow references, Simulation/Live mode, or saved Live Resources.
Wavegen names can be saved even though its runtime actions are not yet supported.

Numeric fields use direct typing and native ArrowUp / ArrowDown stepping;
spinner buttons are hidden.

## Meters measurement setup

Meters **Measurement Setup** starts expanded; use **− / +** to hide or show its
measurement and trigger settings without hiding Background Streaming or Live
Device. These settings apply to Foreground or Background as supported by the
selected mode. The current Setup controls:

| Field | Choices and purpose |
| --- | --- |
| Measurement | DC Voltage or DC Current |
| Range Mode | Auto or Manual |
| Manual Range | Fixed choices supplied by the tool, not arbitrary text |
| NPLC | 0.02, 0.2, 1, 10, 100; measurement integration time |
| Auto Zero | On, Off, Once |
| DCV Input Impedance | Voltage: Not specified, Default, 10 MΩ, Auto |
| Current Terminal | Current: Not specified, 3 A terminal, 10 A terminal |
| VM Comp Slope | Voltage/current: Not specified, Positive, Negative; unspecified keeps the current setting |

### Measurement and trigger modes

Choose whether to enable Background Streaming first. Foreground uses Single, one reading per Measure.

| Mode | Settings |
| --- | --- |
| Single (foreground) | One trigger per Measure |
| Software, Immediate, External (background Simple) | Finite sources use Max Samples |
| Software Custom, Immediate Custom, External Custom (background) | Sample Count, optional Buffer Drain Size, Allow Buffer Overflow Risk; finite sources use Trigger Count |
| External / External Custom | Optional Hardware Trigger Slope and Hardware Trigger Delay (s); unspecified uses tool defaults |

Unsupported modes are disabled when model capabilities are available. Known reading-memory limits are shown. Planned readings above capacity display Reading memory exceeded and require explicit risk acceptance.

Measurement fields stay visible; inapplicable fields are disabled. The external
meters-tool remains authoritative for the actual model capability and numeric
limits. Desktop does not replace its capability database. In Simulation,
capability choices come from the meter simulator profile rather than a saved
Live meter identity. Live uses the saved identity when available.

### Warning: Custom acquisition can lose data

In a Custom mode, selecting **Allow Buffer Overflow Risk** explicitly accepts
possible unrecoverable data loss. **High Buffer Overflow Risk Accepted** appears
whenever it is selected, even below the memory limit or before capabilities are
available. Samples can be lost whenever acquisition outpaces the Worker's
draining of reading memory; lower NPLC can increase that risk. Conversely,
planned readings above capacity may still be captured completely if draining
keeps up. Exceeding the planned capacity alone does not confirm overflow.

If a finite Custom acquisition loses samples, the Worker may keep waiting for
missing samples after all planned triggers finish and may not finish naturally.
This does not necessarily mean it has stopped responding: it may still accept
existing Workflow or Worker Stop controls. Use those controls to end the
operation as appropriate; Stop cannot recover lost data. These warnings apply
in both Simulation and Live. The waiting behavior has been reproduced in
Simulation; the same behavior has not been confirmed on physical instruments.

Neither `summary.ok=true` nor process exit code 0 guarantees that all expected
readings were captured. Check **Captured**, **Expected Readings**, **Stop Reason**
and **Data Integrity** together. Allow Risk does not ensure overflow monitoring
is active, and Meters Setup has no separate monitoring control. Without
monitoring results, absence of a detected overflow is not evidence of no data
loss.

## Configure Live Resources

A Live Resource is the real device address for an instance, stored locally. Last-known model and serial information is not a current connection check.

| Tool | Specify the connection |
| --- | --- |
| Meters, Powers, Scopes | Select VISA Backend, then List Resources or enter manually |
| Serial | UART COM Port or TCP Host / Port; see [Serial steps](../steps/serial.md) |
| Wavegen | Workflow execution is not supported |

1. Expand Live Device.
2. Choose the applicable backend or transport.
3. List or enter the address and check the device information.
4. Select **Save Resource**; use Clear Resource to remove the saved connection.

### VISA Backend and unsaved settings

Each supported instance has its own **VISA Backend**: **System VISA** (the
default, including older configurations) or **PyVISA-py (@py)**. Choose the
backend before **List Resources**. Changing it immediately clears that
instance's resource and identity drafts, discovery results and errors, and old
Powers Device Status. Other instances are unaffected. The saved configuration
stays unchanged until **Save Resource**, which saves the backend, resource and
identity together. List resources again or enter a resource manually, then save;
addresses from different backends are not converted or matched. Unsaved changes
block Live runs and invalidate the previous Live Preflight result.

The backend is local to this machine and is not included in Templates.
Simulation does not use it. If the selected backend is unavailable, discovery
or connection fails with an error; Desktop does not switch backends automatically.

Live Resources always represent machine-local real hardware. Simulation does
not require or use them, but you may list, edit, and save one for a future Live
run without switching Execution Mode. Desktop does not create a fake simulator
resource in local configuration.

### Model identity and capabilities

Powers discovery may provide a canonical model ID. Desktop saves it with the
last-known local resource identity and queries `powers-tool capabilities
--model` offline to show available protection controls and channels. The Setup
page does not connect to an instrument for this query. If the model ID or
capabilities are unavailable in Live, select and save a supported Live
Resource to enable new protection settings. In Simulation, Desktop queries
powers-tool for the existing Powers simulator model, so Protection Setup does
not require discovery or a saved resource. Existing Template settings remain
visible when the current model does not support them.

### Read & Drain Errors

Open **Live Device** in a Powers, Meters, or Scopes instance and select
**Read & Drain Errors** in **Error Queue**. Meters requires a CLI with the
`read-errors` command. Desktop checks the CLI and any known saved Meters model
without connecting to the instrument. If you replace the Meters executable at
the same path, select **Refresh** in **Tools** to check support again. In Live,
save a discovered Scopes resource so Desktop can verify model support.

- **Simulation** uses the Tool's simulator and displays **NO HARDWARE I/O**.
- **Live** uses the saved Live Resource and VISA Backend, even if the Resource
  fields show a draft. The confirmation identifies the saved address. Reading
  removes the returned entries from the instrument's queue without issuing
  `*CLS` or clearing other instrument status.

All instances' buttons are disabled from Workflow start through stopping and
cleanup. The diagnostic is manual and its results are shown only in Setup.

The result lists original error codes and messages in read order.

| Result | Meaning |
| --- | --- |
| Queue Empty | First read confirms empty |
| Drained | Entries were read and queue confirmed empty |
| Not Fully Drained | 20-read limit reached without confirming empty |
| Failed | Shows the failure and preserves returned entries |

A connection failure during a read may mean the instrument removed an entry before returning it.

## Powers protection setup

Protection Setup is optional. Within a Powers Tool Instance, use **+** beside
**Protection Setup** to expand the group, which starts collapsed. Protection
fields and the Device area, including Device Status, Refresh Status, Protection
Summary, channel protection status and clear actions, and related messages and
results, expand and collapse together. Live Device, VISA Backend, Live Resource
and resource discovery controls and messages, and Remove Tool Instance and its
workflow reference restriction remain visible. Collapsing preserves protection
settings, runtime status and operation results without reading or operating the
instrument. Select
**Use Protection Setup** to edit supported fields. This single checkbox applies
to the whole instance; new instances start unchecked with all fields disabled.
Selecting it alone does not store any protection data or checkbox state in the
Template. All channels reported by powers-tool are shown in aligned rows,
together with any channels already configured in the Template. Each row shows OVP Voltage, OCP,
OCP Delay, and OCP Delay Trigger. Unsupported controls remain visible but are
disabled. Existing unsupported values are displayed with a warning and preserved
when saving; the external tool still validates actual model support and limits.

### Protection fields

| Field | Purpose |
| --- | --- |
| OVP Voltage | Overvoltage protection setting |
| OCP | Overcurrent protection setting |
| OCP Delay | Overcurrent protection delay |
| OCP Delay Trigger | Condition for triggering that delay |

### Clear and save settings

An empty numeric field or **Unchanged** leaves that instrument setting unchanged
and is not stored in the Template. Only configured channels and fields are saved.
Existing Protection Setup opens with the checkbox checked. Clearing the last
setting removes that channel's record; clearing all settings returns to an empty
setup, unchecks **Use Protection Setup**, and disables the fields. Unchecking it
also clears the entire Protection Setup and returns all fields to Unchanged.
Channel rows stay visible according to capabilities; there are no Add Channel
or Remove Channel controls. Protection Setup and Device Status tables show
plain channel numbers under **Channel**; confirmations and clear plans use
**Channel 1**. Workflow Sequence compact summaries retain **CH1**.

### Protection setup execution order

In both modes, a referenced Powers instance with Protection Setup requests
Safe-Off, reads Protection Status, applies settings one channel at a time only
when status is clear, then starts Workflow steps. A reported trip blocks the
run; Orchestrator never clears it automatically. The final Safe-Off still runs.
In Simulation these operations use powers-tool's simulate/planning contract,
so they validate sequencing without real hardware I/O. To fail a Workflow on
a trip detected during execution, add a **Power Protection Status** step
followed by **Assert**.

### Live safety checks

Before a Live run, every referenced supported Tool Instance must have a
non-empty saved resource. Two referenced instances may not use the same resource in one
run. Live confirmation displays each referenced instance and Tool Type, saved
backend and resource, and available last-known identity. If the backend or
resource changes after confirmation, the run is rejected and must be confirmed
again.

For a DC Current measurement using the **10 A terminal**, Live confirmation
also asks you to verify that the physical leads are connected to the 10 A
terminal.

## Powers device status and clearing protection

Expand Protection Setup to show the **Device** area and **Device Status**.
**Live Device** / Live Resource controls remain below it in both Simulation and
Live modes, including when Protection Setup is collapsed. The execution mode
badge appears in the Tool Instance heading.
Device Status is runtime-only and is not
saved in the Template. Opening Setup does not connect to a Worker and there is no
background polling. A single **Protection Summary** panel groups aggregate
Protection, OVP, and OCP. These and per-channel values show **—** until status is
read, then show CLEAR / OK or TRIPPED as reported. Channel rows include offline
model capabilities, existing Template settings, and channels returned by a
successful **Refresh Status**, which also updates their values.
Simulation uses the simulator channels without a saved Live Resource. Live uses
the saved model identity without connecting to hardware to build the rows; if
capabilities are unavailable, configured channels remain visible and no other
channels are guessed before Refresh. Even without a saved model identity,
a successful Refresh displays the actual returned channels and makes reported
trip channels eligible for Clear Protection under the usual rules.
Switching Execution Mode clears stale values back to **—**
and shows the channels known for the selected mode.

### Simulation: generate a clear plan

In Simulation, Refresh Status starts the configured powers-tool simulate
Worker and does not require a saved Live Resource. **Generate Clear Plan...**
is available for every simulator-supported channel, even when status is not
tripped. After confirmation, Orchestrator sends simulated Safe-Off All and
`clear-protection` for the selected channel, then shuts down without rereading
status. The result is shown as **PLAN GENERATED · SIMULATION** and **NO HARDWARE
I/O**. **Show Plan** presents the target channel, Safe-Off first, protection clear,
outputs remaining OFF, and no hardware I/O as a short operator preview. It does
not display raw JSON or instrument commands. No real protection latch was changed.

### Live: refresh and clear protection

In Live, Refresh Status uses a temporary Powers connection and the saved Live
Resource and backend. Unsaved Live Resource or backend changes must be saved before Refresh Status or
Clear Protection can be used. Device Status prompts you to save the Live Resource
in the controls below when no resource is saved or draft changes are unsaved.

Each channel row has a fixed Action column. **Generate Clear Plan...** is enabled
for simulator-supported channels when no operation is busy. In Live,
**Clear Protection...** remains visible but disabled before Refresh Status and
when the channel has no reported OVP or OCP trip. It becomes enabled for a reported
trip when no Workflow or manual operation is busy, and always requires explicit
confirmation. Orchestrator first performs
Safe-Off All, clears only the selected channel protection latch, then rereads
the full status. Clear Protection does not fix the cause of a trip and never
turns an output back on. If the latch remains tripped, the status remains
visible as unresolved; if the reread reports an output still ON, Desktop shows
that state and a warning rather than hiding it or automatically changing it.

Refresh Status and Clear Protection are unavailable while a Workflow or another
manual external operation is active. If remote clear is unsupported for the model,
clear the protection latch from the instrument front panel and then use
**Refresh Status**.

## Scopes acquisition and channel setup

Scopes Setup is optional. New instances start with all settings **Unchanged**.
**Acquisition Setup** and **Channel Configuration** start collapsed; use each
heading's **+ / −** independently. Collapsing preserves settings, and Live
Resource remains outside both groups.
Choose Acquisition Type (Normal, Average, High Resolution, or Peak); Average
Count is editable only with Average. Channel rows provide Input Coupling,
Probe Ratio, Bandwidth Limit, Waveform Invert, and Channel Units. Only explicit
settings are saved, applied, and read back. Blank values and Unchanged send no
commands.

### Setup fields

| Section | Fields |
| --- | --- |
| Acquisition Setup | Acquisition Type, Average Count (Average only) |
| Channel Configuration | Input Coupling, Probe Ratio, Bandwidth Limit, Waveform Invert, Channel Units |

### Model support, readback and errors

The controls use offline Scopes capabilities. Simulation uses Scopes' default
Keysight DSOX4024A profile. Live uses the canonical model ID saved with the
selected Resource. Unknown or unavailable capability information disables new
settings with an explanation. Unsupported fields remain visible and disabled;
changing models preserves existing settings. Scopes validates actual model
support and instrument limits when applying Setup. The run reports Setup FAIL
if a readback fails, is missing, or differs from the requested value. The error
identifies the instance and, for channel settings, the channel. Workflow steps
start only after Setup succeeds. For example, if you set Channel 2 Waveform
Invert to On and leave the other settings Unchanged, Setup verifies Channel 2
inversion before the Workflow starts.
