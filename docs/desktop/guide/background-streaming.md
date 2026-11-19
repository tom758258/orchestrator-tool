# Background Streaming and Streaming CSV

<!-- help-source -->

## Background Streaming

In **Tool Setup**, select **Enable Background Streaming** for a Meters
or Scopes Tool Instance. Meters offers six acquisition modes. Scopes Background
captures read-only numeric Measure cycles, not screenshots or waveforms.
Powers and Wavegen do not support Background.
A Background instance cannot also be used by foreground Tool actions. Existing
steps are retained when switching roles; resolve the displayed conflict before
running. Turning off Background while another mode is selected requires choosing
Single before using foreground Measure. Two instances cannot share one Live
resource in a run.

Choose **Finite** or **Infinite**. For Scopes, Finite **Cycles** counts
complete measurement cycles, each containing all selected Channel/Item pairs;
Infinite continues until Worker OFF or Stop Workflow. Set **Measure interval
(seconds)** (default 1) as the wait **after** a complete cycle, not a precise
sample rate. In **Measurements**, add or remove rows and select each **Channel**
and **Item** from the Scopes capabilities. Each row has an internal stable
Measurement ID. Individual measurements in a cycle are read sequentially.
Scopes validates supported items and channel/model parameters when starting.

For Meters, Finite Simple modes use **Max Samples**; finite
Custom modes use **Trigger Count**, with **Sample Count** readings per trigger.
Infinite Custom requires explicit **Allow Buffer Overflow Risk**. Infinite
Background acquisition has no hidden Simulation sample limit.

**Software** and **Software Custom** use **Timer Interval (ms)** by default, initially
**1000**. The first trigger is sent when the source is ready. After one reading
or a complete Custom batch arrives, Orchestrator waits the selected interval
before the next trigger. This is a delay between completed measurements, not a
fixed sampling frequency. Capture OFF leaves triggering and optional Live Monitor
running. Worker OFF, Stop Workflow, source completion or failure stops triggering.
A rejected trigger or measurement timeout fails the run and preserves available data.
For Software Simple, **Trigger with BG Command** replaces this timer with
Workflow commands; enable FG/BG Interaction in Workflow before using it.

**External** and **External Custom** use the connected trigger signal in Live.
Simulation generates virtual triggers on supported models, including 34461A;
34460A does not support External. Slope and delay settings are passed to the tool.
Simulation does not verify physical trigger timing.

**Live Monitor** is optional and starts unchecked. For Scopes, the Monitor has a
**Measurement** selector and plots one numeric field at a time, independently
of Capture; an invalid reading is not plotted as zero. The Allow Risk warning in
**5.1 Meters Setup** applies to Custom Background sources. Lost readings cannot
be recovered by Stop; check captured counts and data quality after stopping.

Add these Workflow actions and select the Background in Step Properties:

- **Worker ON** starts its source at that Step. For Scopes, it launches the
  streaming Worker, applies existing Scopes Setup while the stream waits, then
  starts Measure Streaming after Setup succeeds. Simultaneous Capture ON starts
  unchecked; check it to retain the first samples from startup.
- **Capture ON** starts a new Dataset while the Worker continues independently.
- **Capture OFF** finishes that Dataset and its optional streaming CSV without
  stopping the Worker or automatically exporting another file.
- **Worker OFF** releases the source. Simultaneous Capture OFF starts checked.
  Uncheck it if Capture was already explicitly switched OFF. Stopping a finite
  source before its configured count is reached fails the run; use **Stop Workflow**
  to end the run early and retain a partial Dataset.

Repeated ON/OFF is a Step error. A finite source automatically retains its tail
and finishes its Dataset. The first subsequent Capture OFF acknowledges that
automatic finish; the first Worker OFF releases the source. A second explicit
OFF fails. An ended source cannot Capture ON again until Worker OFF and a new
Worker ON. Every run also cleans up remaining Workers, including on failure,
while preserving the existing Powers Safe-Off behavior.

**Output** contains **Charts**, optional **Live Monitors**, **Foreground Output**,
and **Background Output** as separate expandable sections. Background-only runs can use
Charts and Background Output. Background Output appears only when the Last Run
had Background bindings; changing the current Draft does not hide those results.
Its Background and Capture Dataset selectors control its Summary, Output Data
and export, independently of each Chart's selection.

Foreground Output has a Source card with an Output Page selector, the current page number, and short guidance. Changing the Output Page updates its Summary, Output Data, and selected-page export. Background Output has a Source card for its Background and Capture Dataset selectors and Worker status. Both outputs place their export options under Export settings below Output Data.

Background numeric Summary and Output Data use the same styled tables as Foreground. Background numeric values share the Auto, Fixed, and Raw Number display setting, without changing stored data or export precision. Background Summary shows only statistics already present in the Dataset, including Scopes valid and invalid counts; Serial RX shows event and byte counts instead. Background still reads 100 rows per page, independently of Foreground Output Pages.

Background Source places Background and Capture Dataset side by side when space permits and wraps them on narrow windows. Pagination controls appear only for Datasets exceeding 100 rows and use the standard action-button style. Foreground Export settings explains whether the selected option opens a file or folder picker; Background Export settings always selects a destination folder and exports the complete selected or all Datasets, not just the visible rows. The Background export button shows the chosen format.

In **Charts**, use **Chart settings** to choose **Ground** (Foreground or Background),
then **Page** (a Foreground Output Page or Background source), and select **Add Chart**.
Each Chart displays a colored Foreground or Background source label and its Page or
Background ID. The **Save charts with template** option and shared chart count appear
at the top-right of Charts. All Foreground Pages and Background Charts appear together in Chart number order, regardless of source.
Each Background Chart offers **Export PNG**, **Settings**, **Source settings**, and **Remove**.
**Source settings** shows the selected Background as read-only and offers
**Capture Dataset** and **X-axis data** (Elapsed Time, Timestamp or Sample Index).
Scopes adds a **Measurement** selector. The Background source is chosen when the
Chart is created; when unavailable in the current Draft or Last Run, use
**Reassign source** to select a valid Background present in both. Changes apply
immediately, and the Chart card retains its source badge and **Data summary**. Each Scopes Chart selects
one Measurement field; use
multiple Charts to plot different measurements rather than combining different
units on one axis.
Background Charts can be removed down to zero. Choose Line, XY Scatter, Column,
Area or Bar in Settings; only Line updates during a run. Foreground retains all
its existing chart types. Each Chart initially selects the latest available
Dataset for its Background and then keeps that selection, even if newer Datasets
arrive. Each new run chooses afresh. With no Dataset, the Chart waits for captured
data and never substitutes Monitor samples.

Background X uses actual Elapsed Time in seconds, Timestamp, or Sample Index.
Hover identifies an actual displayed sample. Line/Area retain peaks, troughs and
endpoints when sampled; Scatter/Column/Bar show representative observations.
**Data summary** shows Total samples, In range and Plotted, with the current sampling status. Line/Area/Column
Zoom requests detail for the visible range; Scatter/Bar have no Zoom controls.
Line **Settings → General → Show All Raw Data** displays all visible samples up
to **25,000**. Above this limit the Chart shows no points and asks you to narrow
Zoom or turn the option off. Full Dataset storage and CSV/XLSX export are unchanged.

Last Run Charts remain viewable and editable after removing their binding from
the current Workflow. Display settings never recreate or modify Draft bindings.
With **Save charts with template** enabled, a Chart referring to a Background
missing from the Draft prevents Template Save and identifies the Chart to fix.
Remove that Chart, select a valid source, or turn off saving Charts.

When enabled in Setup, **Live Monitors** appears immediately below Charts as a
separate expandable framed section with matching inner cards. Charts and
Live Monitors collapse independently; without any enabled Monitor, the section
is hidden. Each monitor has a compact **Monitor info** section: numeric monitors
describe the latest-1,000-Worker-sample buffer, while Serial RX monitors describe
their bounded-byte buffer. Both operate independently of Capture. Numeric
monitors retain Line appearance, Hover and Zoom, and continue updating while
Capture is OFF. Worker OFF stops updates; restarting a Worker clears its
Monitor. It has no Chart Settings, Add/Remove, saved Chart, PNG, Dataset, Summary,
CSV or XLSX, and consumes no Chart slot. Summary in Background Output shows Dataset
count/min/max/average, status and quality for Meters. For Scopes, it shows
valid/invalid counts and min/max/average **per Measurement field**. The Scopes
Output Data table displays the selected fields and leaves invalid values blank,
with the reason available on hover. **Output Data** uses pages of 100 rows.
`no_loss_detected` describes the Tool's evidence, not a zero-loss guarantee.

Capture boundaries follow received event processing, not hardware sample time.
Full captured samples stay in memory for the current run. A new run or **Clear
Last Run** releases them; there is no history or recovery store. Background
samples do not feed Workflow variables, calculations, assertions or ResultRows.

**CSV Export → Stream Background CSV during Capture** is independent of
foreground CSV. Choose All Backgrounds or one Background and its output folder.
The default is `<application folder>/data`. For Scopes, **Scopes CSV columns**
selects **Values + units** or **Values + units + validity + reason** before
Run; the latter includes per-Measurement quality fields. Both formats retain
blank values for invalid measurements rather than writing zero. Meters retains
its existing five-column CSV. Each Capture creates a new CSV;
Monitor-only operation creates none. Every enabled CSV destination follows the
failure policy below and keeps any partial files.

After the run, **Export Background** saves the selected or all Datasets as CSV
or XLSX, including partial data from a failed run. When a Scopes Dataset is
present, **Scopes export columns** lets each manual export choose the same
two formats independently of the format used during streaming; captured memory
data always retains `value`, `unit`, `valid` and `reason`. More than
300,000 samples shows a warning. XLSX defaults to 300,000 samples per file; edit **Samples per
XLSX file** from 1 to 1,048,575. Larger Datasets split into new files without
truncation. Export names avoid overwriting streaming or previous manual files.
No Capture OFF or run completion automatically performs manual export.

## 9. Streaming CSV

Streaming CSV is configured in the Workflow area's **CSV Export** panel. It
is different from exporting a completed run later. The panel starts collapsed
when the application opens. Click its title to expand or collapse it; collapsing
only hides the controls and does not change their values.

Foreground streaming requires at least one Output; Background streaming does
not. Choose one of these foreground modes:

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
- Any enabled CSV creation, write or final-flush failure fails the run, stops
  further ordinary Steps and performs background and Powers safety cleanup.
  It is independent of Graceful Loop Stop and preserves committed rows,
  received Background samples and partial CSV files.
- CSV data already written from committed rows remains after workflow failure
  or Stop Workflow / loop Stop.
- Streaming does not produce XLSX files.
- Streaming settings are locked while the run is active.

