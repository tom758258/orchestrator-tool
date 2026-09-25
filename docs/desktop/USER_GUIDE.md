# Orchestrator Tool Desktop User Guide

This guide describes the Desktop behavior currently available in
Orchestrator Tool. It is written for operators and engineers who configure
external tools, build reusable Templates, run workflows, and inspect or export
their results.

## 1. Overview

Orchestrator Tool Desktop coordinates independent external tools through a
reusable Template. You can configure Tool Types, create logical Tool
Instances, build an ordered Workflow, and run it in Simulation or Live mode.
After a run, Desktop shows committed Results, Output Pages, Charts, and Data,
and can export the available results.

Desktop is the main workflow operation interface. External tools remain
separate programs and distributions; they are not bundled into
orchestrator-tool.

## 2. Requirements

- The application is Windows-first.
- It uses the system Microsoft Edge WebView2 Runtime. If WebView2 is missing,
  Desktop shows a native warning before creating the Tauri WebView and does not
  start the application window. The application does not download or install
  WebView2 automatically.
- Meters, Powers, Scopes, and Wavegen are independent external tool
  distributions. Install and maintain those tools separately, then configure
  their actual executable paths in Desktop.

This guide does not assume an installer or package deployment flow for the
external tools.

## 3. Main Desktop areas

The Desktop tabs are:

- **Tools** — configure each Tool Type's executable path and inspect its
  availability and compatibility.
- **Setup** — create Tool Instances, edit their per-instance setup, and save
  or clear local Live Resources where supported.
- **Workflow** — edit the ordered steps, validate the Template, run
  Simulation or Live mode, request a graceful Stop, and configure CSV
  streaming.
- **Output** — inspect the Last Run, execution results, Output Pages, Charts,
  Summary, Output Data, and manual exports.

The application also has an **Appearance** control for the Desktop theme and
toolbar actions for **Open Template**, **Save Template**, and **Help**. Help
opens the bundled offline Desktop User Guide in a separate application window.

## 4. Configure external Tools

Executable paths belong to a Tool Type. They are shared by all Tool Instances
of that type; an individual Tool Instance does not store its own executable
path.

In **Tools**, choose **Browse...** and select the actual executable supplied by
the external tool distribution. Desktop validates the executable's manifest
and Worker compatibility for the expected Tool Type before saving the path. A
path with the wrong Tool ID or incompatible Worker is rejected, and an
existing valid path is not replaced by the invalid selection. Use **Clear
Path** when the saved path should be removed.

The status area reports states such as **Not configured**, **Available**,
**Missing**, **Not a file**, or **Error**, together with compatibility and an
explanation when one is available. Desktop does not search `PATH`, the
Windows registry, or arbitrary folders, and does not silently fall back to a
different executable.

If an external tool is distributed by PyInstaller in `onedir` form, select
the real executable inside that distribution. Orchestrator Tool does not move
or copy the executable or its `_internal` directory.

## 5. Setup and Tool Instances

A Tool Instance is a logical, named instance stored in the Template. A
Template can contain multiple instances of the same Tool Type, and each
instance has its own setup values. Tool setup is part of the Template;
machine-specific executable paths and Live Resources are not.

### 5.1 Meters Setup

For a Meters Tool Instance, the current Setup controls:

- Measurement: **DC Voltage** or **DC Current**.
- Range Mode: **Auto** or **Manual**.
- Manual Range: a fixed list of choices supplied from the configured meters
  tool's capabilities. It is not an arbitrary text value.
- NPLC: the currently exposed standard choices are `0.02`, `0.2`, `1`, `10`,
  and `100`.
- Auto Zero: **On**, **Off**, or **Once**.
- Trigger Mode: **Single** (stored as `software`), **Software Custom**,
  **Immediate Custom**, or **External Custom**. Unsupported modes are disabled
  when the selected model capability is available.
- Single sends one software trigger for each Measure and returns one reading.
  Software Custom sends a software trigger and returns one batch. Immediate
  Custom and External Custom do not send a software trigger from Measure; they
  return the next ordered batch produced by the Meter Worker.
- All Custom modes expose **Sample Count**, optional **Buffer Drain Size**, and
  **Allow Buffer Overflow Risk**. Trigger Count is derived from the Workflow
  and is not editable. The UI shows the selected model's reading-memory limit
  and warns when the planned acquisition exceeds it. Lower NPLC increases
  acquisition rate and therefore increases buffer-drain risk.
- For DC Voltage, DCV Input Impedance: **Not specified**, **Default**,
  **10 MΩ**, or **Auto**.
- For DC Current, Current Terminal: **Not specified**, **3 A terminal**, or
  **10 A terminal**.
- VM Comp Slope for DC Voltage and DC Current: **Not specified**,
  **Positive**, or **Negative**. Not specified leaves the instrument's
  existing VM Comp setting unchanged.

Measurement fields stay visible; inapplicable fields are disabled. The external
meters-tool remains authoritative for the actual model capability and numeric
limits. Desktop does not replace its capability database.

### 5.2 Live Resources

A Live Resource is bound to a Tool Instance and is stored in the machine-local
Desktop configuration. It is not carried in a Template. Optional last-known
identity information is also stored locally for display; that cached identity
is not a current connection check.

The current Desktop supports resource discovery for **Meters** and **Powers**.
Do not expect discovery for unsupported Tool Types. Use the resource controls
in Setup to list available resources, choose one, **Save Resource**, or
**Clear Resource**.

Before a Live run, every referenced supported Tool Instance must have a
non-empty saved resource. Two referenced instances may not use the same resource in one
run. Live confirmation displays the referenced instances and resources. If a
resource changes after confirmation, the run is rejected and must be
confirmed again.

For a DC Current measurement using the **10 A terminal**, Live confirmation
also asks you to verify that the physical leads are connected to the 10 A
terminal.

## 6. Workflow Editor

The Workflow editor builds an ordered sequence of steps. The current step
types are:

- **Assert** — check a condition and fail the workflow if it is not true.
- **Set Variable** — create or update a workflow variable.
- **Output** — publish a value as a final workflow result column. It does not
  control a Powers output.
- **Wait** — wait for a specified duration.
- **Tool Action** — invoke an action on a configured Tool Instance, such as a
  Powers set or output action or a Meters measurement.
- **For** — repeat a body over an exact decimal range.
- **While** — repeat a body while a condition remains true.

Steps can be placed in the root workflow or inside loop bodies. Use the step
properties area to edit the selected step. Use Validate when you want to
check the current Template before running; Simulation and Live also validate
the Template when the run starts, so pressing Validate first is useful but is
not a separate run prerequisite.

### 6.1 Input values and data flow

The current InputValue choices in the editor are:

- **Fixed value** — a literal value.
- **Variable** — the current value of a workflow variable.
- **Previous step result** — a result from an earlier visible step. The current
  UI offers results from prior Tool Actions.
- **Calculation** — one left operand, one operator, and one right operand.
- **Elapsed time** — a runtime elapsed-time value.
- **Timestamp** — a runtime timestamp value.

Set Variable steps create or update variables. A Previous step result can
refer only to a step that is earlier and visible in the current lexical scope.
Calculations use the currently supported arithmetic and comparison operators,
including addition, subtraction, multiplication, division, and the displayed
greater-than/less-than comparisons. A Calculation is not an arbitrary nested
expression tree.

An Output step is what creates a ResultRow column. Values used as inputs do
not become result columns merely because they were referenced.

### 6.2 For

Configure a For step with **Start**, **Stop**, **Step**, a loop variable, and a
body.

- The Stop value is included when the step grid reaches it.
- Positive and negative directions must agree with Start and Stop.
- A zero Step is invalid.
- Equal Start and Stop values execute one iteration.
- Loop nesting is limited to five levels.

For ranges use exact decimal range semantics rather than floating-point
tolerance. The range is evaluated according to the configured step, so a Stop
value that is not reachable is not rounded into an extra iteration.

### 6.3 While

A While condition is evaluated before each iteration. Its iteration limit can
be:

- a positive finite `max_iterations` value; or
- **Unlimited**, meaning no finite iteration limit is imposed.

If the condition is initially false, the body executes zero times. An
Unlimited While is currently allowed only at the top level, must have a
non-empty body, and may contain finite nested loops. It may not contain
another Unlimited While.

Simulation currently rejects a Software Meters **Measure** inside an Unlimited
While because it cannot establish a finite sample bound. Use a finite
`max_iterations` for that Simulation workflow, or use Live mode when the
operation is appropriate. A Live Software Meters Measure inside an Unlimited
While is allowed and does not set a finite `max-samples` limit.

All Custom trigger modes require a finite maximum trigger count in both
Simulation and Live. The count adds every Measure occurrence for the same Tool
Instance and multiplies each occurrence by its enclosing For iteration counts
and finite While `max_iterations`. A Custom Measure inside an Unlimited While
is rejected. Trigger Count and Sample Count each follow meters-tool's current
1-to-1,000,000 limits; Orchestrator does not add a separate one-million
total-reading limit. For Software Custom and External Custom, a While that exits early can leave planned
triggers unused. Immediate Custom is different: the Worker starts the complete
planned acquisition when the session starts, so readings for later planned
Measure occurrences may already have been acquired even if the Workflow exits
early; unconsumed readings are discarded when the Worker is cleaned up.

### 6.4 Graceful Stop

During an active run, Stop targets a loop selected by the operator. It is a
graceful loop stop, not an immediate termination of the current step:

1. The active innermost iteration continues until its successful commit point.
2. The selected loop then unwinds.
3. A parent loop or the root workflow can continue after that unwind.

If the current iteration fails, the failure takes precedence over the Stop
request. Stop is not Pause, Resume, or Hard Cancel, and Stop by itself does
not automatically mark the entire run as cancelled. The final run status is
still subject to the normal workflow success rules.

### 6.5 Output Pages

An Output step has a name and a Page. Outputs on the same Page form columns in
one dataset. Different Pages are independent datasets, and a nested loop can
own its own Page.

Each Page belongs to one fixed owning lexical loop path. The same Page name
cannot be shared by different lexical loop paths. Page names also have to be
valid as CSV filename stems and Excel worksheet names, so the same naming
restrictions apply to both export formats.

A Custom Meters Measure produces one batch per Measure step. An
Output that directly references that step, or a Calculation that references
it, is resolved once per sample. Its Page expands the logical row to the batch
size, while scalar Outputs on that Page are copied to every expanded row.
Several Outputs may use the same Measure batch, but one Page cannot combine
two independent Measure batches. Batch-dependent values are not supported by
Assert, Set Variable, While conditions, or Tool Action bindings.

Expansion is Page-local and remains staged until the owning scope or iteration
succeeds. CSV streaming, manual CSV/XLSX export, and Charts consume the
resulting committed rows without another expansion pass.

## 7. Run Simulation

Before Simulation, configure every referenced external executable and ensure
its manifest and Worker compatibility checks can succeed. You can use
Validate first for an explicit Template check; the run also validates the
Template when it starts.

Simulation does not require Live Resources. It uses the external Workers'
simulate mode and is not intended to operate physical hardware. The
Unlimited While plus Meters Measure restriction described above still
applies.

## 8. Run Live

Before starting Live, Desktop:

- checks the referenced Tool Instances;
- loads their persisted Live Resources;
- rejects any unsaved Live Resource draft changes;
- shows a Live confirmation listing each referenced instance and resource;
- warns that Live mode can change Powers outputs; and
- adds the 10 A terminal warning for the applicable Meters setup.

Confirm only after checking the displayed resources and the connected
hardware. The run validates that the resources are still exactly the ones
confirmed. A changed resource or duplicate resource causes Live execution to
be rejected and require a new confirmation.

The currently supported Live external tools are Powers and Meters. An
unsupported Tool Type is reported as an error; the Desktop does not currently
promise Scopes or Wavegen runtime execution.

### 8.1 Powers actions and cleanup

Powers Live actions include setting values and the `output-on` and
`output-off` actions. Live Powers write authorization exists only for the
runtime of the Live run.

At run completion, and also on workflow failure or later Worker startup
failure paths, the orchestrator requests Powers `safe-off` for every started
Powers instance before Worker shutdown. A cleanup failure makes the run fail,
while preserving the original workflow failure when one already exists. The
temporary runtime authorization file is used only for the run and removed on
a best-effort basis.

An explicit Powers `output-off` Tool Action does not replace the run-level
cleanup. Simulation does not perform this additional Live safe-off sequence.

## 9. Streaming CSV

Streaming CSV is configured in the Workflow area's **Streaming** panel. It
is different from exporting a completed run later.

Streaming requires at least one Output. Choose one of these modes:

- **Selected Page** — choose one Output Page and optionally choose an output
  folder. Desktop automatically creates a timestamped CSV filename. The
  selected Page is fixed once the run starts.
- **All Pages** — optionally choose an output folder. Desktop creates a
  timestamped destination directory and one CSV file for each Page.

If no folder is selected, Streaming output uses the application's data
folder:

Default output folder: `<application folder>/data`

Streaming behavior:

- Headers are created and flushed before workflow execution.
- Only committed ResultRows are written.
- Each written row is flushed.
- A CSV write or flush failure stops further streaming attempts, but workflow
  execution continues.
- CSV data already written from committed rows remains after workflow failure
  or Graceful Stop.
- Streaming does not produce XLSX files.
- Streaming settings are locked while the run is active.

## 10. Run Results

After a run, the Output area can show the following visible sections:

- **Last Run Execution Results** — execution statuses and progress results,
  shown latest first when the result list is paged.
- **Last Run** — the current run's Output Pages and result workspace.
- **Charts** — chart panels for the selected Page.
- **Summary** — numeric Count, Min, Max, and Avg values when applicable.
- **Output Data** — committed rows for the selected Page, shown latest first.

### 10.1 Last Run

Desktop keeps one **Last Run** in memory. It does not provide Run History, a
database, or SQL storage.

At run start, Desktop saves a Workflow snapshot for that run. Editing the
current Workflow afterward does not reinterpret the Last Run. Opening a
Template clears the Last Run, and **Clear Last Run** removes the current
in-memory result and snapshot.

If a run did not complete successfully, committed rows remain available for
inspection, but manual export is unavailable.

### 10.2 Charts

Charts use Apache ECharts with a Canvas renderer. A chart belongs to one
Output Page and can plot numeric Outputs from that Page. Desktop supports up
to eight chart panels across the run's Pages.

While execution is running, Charts use **Line**. After execution stops, any run
with committed numeric rows, including a failed run, can select **Line**,
**XY Scatter**, **Column**, **Area**, **Bar**, **Combo**, **Histogram**, or
**Box & Whisker** from **Settings → General → Chart type**. Line shows the
Iteration trend; Area fills below the line; Column uses vertical grouped bars;
Bar uses horizontal grouped bars; and XY Scatter compares numeric X and Y
values.

A chart panel can select multiple **Outputs** to compare numeric series.
Scatter **X source** can be Iteration or any numeric Output, and an Output used
only as Scatter X does not need to be selected as a Y series. **Display** can
show Markers, Lines, or Lines + markers. **Marker size** and **Line width** accept
positive finite numbers and apply to the modes that show them. Scatter keeps
raw X/Y pairs in original row order, including nonmonotonic X values; Lines
connect those pairs in that order. Scatter hover uses screen-space proximity;
line displays may be selected through a visible segment but always report an
actual raw row rather than an interpolated measurement. Combo requires
at least two selected Outputs; each Output can use Line or Column rendering and
the Left Y or Right Y axis. The two Y axes are configured independently, and
Combo supports Iteration X-axis zoom.

Histogram uses exactly one numeric Output. **Bins** can use Auto, Count from
1 to 200, or a positive Width; a Width that would create more than 200 bins
reports an error. Box & Whisker draws one box for each selected Output and can
show or hide outlier points. These statistical charts are computed from
committed StoredRun rows and do not load their full raw samples into the
frontend chart cache.

For large datasets, Line and Area decimate only the visible Iteration range,
and Combo applies the same viewport decimation to its Line series. Column and
Combo Column series keep every raw row in the visible range; Scatter and Bar
preserve raw pairs. Scatter does not sample or decimate its raw pairs. Markers
use ECharts large scatter rendering, while Lines and Lines + markers use line
rendering. These display optimizations do not remove committed ResultRows.
Line, Area, Column, and Combo hover inspection resolves exact raw iteration and
values; Scatter hover reports the nearest actual raw XY row. Bar, Histogram,
and Box & Whisker do not provide hover inspection. Iteration is the Page row
sequence; Charts and CSV are
chronological, while **Output Data** is displayed latest first.

**Settings** can configure the chart title, **Show legend**, **Legend position**
(Top, Bottom, Left, or Right), X/Y axis titles, minimum,
maximum, major interval, labels, tick marks, and major gridlines. Blank numeric
fields mean Auto; when both minimum and maximum are set, minimum must be less
than maximum; a major interval must be greater than zero. Combo also has an
independent Right Y Axis. Recognized automatic axis titles follow the selected
chart type and Scatter X source, while custom titles are retained. Numeric
settings hidden because they are inactive for the selected chart type do not
block Apply: valid inactive values are retained, while invalid values return to
Auto or the control's default.

**Apply** applies valid settings and closes the dialog. **Cancel** discards the
draft and closes it. Clicking the backdrop or pressing Esc does not close
Settings, so the draft remains available. **Show legend** displays a legend even
for a single series; turning it off hides the legend at every position.

Line, Area, Column, and Combo can enable **Settings → Zoom → Enable zoom**.
Use the mouse wheel to zoom the X axis and drag inside the chart to pan.
**Show zoom slider** controls the bottom slider without clearing the current
range; wheel zoom and drag pan remain available when the slider is hidden.
**Reset Zoom** returns to the full X range. An active Line chart follows new
rows until the user manually zooms or pans; after that, new rows do not move
the current viewport until Reset Zoom. Applying a changed X Axis Minimum or
Maximum, disabling zoom, or switching to a chart type without zoom resets the
manual viewport. Scatter, Bar, Histogram, and Box & Whisker do not expose
Zoom controls.

Each chart has an individual **Save image** action that exports a PNG including
the chart title. **Settings → Save image → Background** can use Light or Dark
independently of the Application theme. The PNG keeps the current zoomed X
range but excludes the zoom slider and Reset Zoom control.

Chart settings belong only to the current Last Run session. They survive
Page/tab changes within that Last Run, but starting a new run, **Open Template**,
or **Clear Last Run** resets them. Chart settings are not Template data.

### 10.3 Data and Summary

**Output Data** is built from committed ResultRows. Large tables use
virtualization for display, but the rows remain available for charts and
export.

**Summary** reports Count, Min, Max, and Avg for applicable numeric Outputs.
If a Page has no numeric Outputs, there is no numeric summary to show.

## 11. Manual export

Manual export is available from the Output area after an authoritative,
successfully completed run with exportable Output rows.

Choose **Run Page** or **All Run Pages**, then choose **CSV** or **XLSX**:

- **Run Page / CSV** — exports the selected Page as one CSV file.
- **Run Page / XLSX** — exports the selected Page as one worksheet.
- **All Run Pages / CSV** — creates one CSV file per Page in the selected
  destination folder.
- **All Run Pages / XLSX** — creates one workbook with one worksheet per Page.

Exports use committed ResultRows. XLSX cells are currently written as plain
text; exports do not add formulas, embedded charts, or native numeric cell
types. All-Pages CSV export does not overwrite existing Page CSV files.

Graceful Stop is not itself a failure or cancellation. If the workflow later
completes under the normal success gate, its authoritative committed results
can be exported. Failed or incomplete runs cannot be manually exported.

## 12. Templates and local machine settings

When the application starts, it creates a blank `Untitled` draft. There is no
separate `New` button in the current UI.

- **Open Template** loads an existing Template.
- **Save Template** writes the current Template.

A Template contains:

- Template name
- Tool Instances
- Tool setup
- Workflow

A Template does not contain:

- executable paths;
- Live Resources or last-known resource identity;
- Simulation/Live mode;
- Last Run or committed results;
- chart session state; or
- runtime Powers authorization.

This separation keeps Templates portable while keeping executable paths,
resources, and other machine/runtime state local to the Desktop installation.

## 13. Theme

The **Appearance** control supports **System**, **Light**, and **Dark**. The
theme choice is a Desktop preference. It is not part of the Template
contract.

## 14. Common problems

### Tool shows Not configured

In **Tools**, browse to the correct external executable and save the path.

### Selected executable is rejected

The executable may have the wrong manifest Tool ID or an incompatible Worker.
Select the executable for the intended Tool Type.

### Executable shows Missing or Not a file

The saved path no longer exists or does not identify a file. Browse to the
current executable; Desktop does not silently search for a replacement.

### Live Resource is missing

In **Setup**, select or enter the resource for the referenced Tool Instance
and save it before running Live.

### Live Resource changes are unsaved

Use **Save Resource**, then start Live again so the confirmation uses the
persisted value.

### Duplicate Live Resource

Different referenced Tool Instances cannot point to the same resource in one
Live run. Assign distinct resources.

### Simulation rejects Unlimited While with Meters Measure

Set a finite `max_iterations`, or use Live mode when that operation is
appropriate.

### Manual export is unavailable

Manual export requires an authoritative successfully completed run with
exportable committed rows. A failed or incomplete run can still be inspected
but cannot be exported.

### Streaming CSV failed

A stream write or flush error stops CSV streaming but does not necessarily
stop workflow execution. CSV data already written from committed rows remains
available.

### WebView2 is missing

Install the system Microsoft Edge WebView2 Runtime, then restart the
application.

## 15. Safety notes

- Live mode can affect connected hardware.
- Verify every Live Resource before confirmation.
- Powers output writes require Live confirmation and runtime authorization.
- Run-level Powers `safe-off` is cleanup behavior; it does not replace the
  external tool's or instrument's safety requirements.
- For Meters DC Current with the 10 A terminal, verify the physical lead
  connection before confirming Live.
- External tools remain responsible for instrument-specific limits and safety
  behavior.
