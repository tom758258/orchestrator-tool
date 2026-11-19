# Charts

<!-- help-source -->

### 10.4 Charts

Charts use Apache ECharts with a Canvas renderer. A Foreground chart belongs to one
Output Page and can plot numeric Outputs from that Page. Session-only and saved Foreground and
Background Charts share a maximum of eight. Live Monitor and Background bindings
without a Chart configuration do not count toward this limit.

Charts are session-only by default. The Charts heading includes **Save charts
with template**, which is off by default. Enable it when the current chart
panels and their Chart Settings should be restored with the Template. Opening a
Template that contains saved Foreground or Background Chart settings turns the
checkbox on, including a Background-only Template, and restores those settings.
Templates without saved Chart settings start with zero Charts. Choose a source
and **+ Add Chart** to create one. Deleting all Charts keeps the count at zero
through Run, Validate, Page changes and Save/Load. Saved valid settings still
load normally. Live Monitor works independently and uses no Chart slot.
Turning it off does not remove the Charts from the current session; the
next Save Template simply omits them. **Clear Last Run** keeps the chart
configuration while this option is enabled; ordinary session-only Charts keep
the previous clear behavior.

This opt-in saves the chart definitions and settings only. It never saves run
data, Run IDs, the current interactive zoom/pan position, loading/error UI
state, dialog state, or export destinations/paths. The Workflow **Chart
Options** described below remain session options even when Charts are saved
with the Template.

Chart Options sits in the narrow Workflow sidebar immediately below
**CSV Export**. The outer **Chart Options** panel, its **Sampling** section, and
its **Y-axis** section can each be expanded or collapsed independently.
**Chart Options** starts collapsed when the application opens; **Sampling** and
**Y-axis** each start expanded inside it. Collapsing a section only hides its
controls and does not change their values.

The **Sampling** section applies to both Simulation and Live Line Charts.
**Preserve Significant Changes** is **off** by default, and the positive finite
percentage threshold defaults to **5%**. The original pixel-bucket Min/Max
remains intact whether or not sampling is enabled. When enabled, a scan of the
visible Raw Data can preserve up to two *additional* locally significant turns
(upward Max and downward Min) per bucket, in original Iteration order, without
deleting the original Min/Max extrema. Its normal comparison reference survives
quiet buckets; one- or two-sample spikes do not become the permanent baseline
when measurements recover. The entire plotted output remains bounded by
approximately four points per bucket plus the global endpoints, even for large
runs.

The optional **Show Significant Change Markers** checkbox sits directly below
the threshold, defaults to **off**, and is disabled while Preserve Significant
Changes is off. When enabled, it labels only the qualifying upward/downward
excursions, up to two markers per bucket; normal recoveries are not marked simply
because they reverse a preceding spike. It does not enable symbols on every Line
vertex or alter which points the Line plots. A plain Line may customize the
per-Output marker size, shape, fill and border at
**Chart Settings → Series → Marker appearance** without choosing Line + markers.
The existing Line + markers option remains an independent setting that shows
symbols for every plotted vertex. Marker shape/color also follows the existing
per-Output styling and Export PNG.

A blank, zero, negative or non-finite percentage blocks Run when Preserve
Significant Changes is enabled; Simulation and Live use the same parser. Zero to
nonzero counts as 100%, and zero to zero counts as 0%.

The **Y-axis** section contains **Fit Data**, which is **off** by default and
applies to Simulation and Live Line Charts. With Fit Data off, the automatic
Y-axis keeps the existing behavior and may include zero. With Fit Data on, the
automatic Y-axis follows the plotted data range without forcing zero into view,
making small changes in an offset signal easier to see. Manual Y-axis
**Minimum** and **Maximum** values in Chart Settings still apply. Fit Data does
not change non-Line chart types.

Sampling controls and Fit Data are snapshotted at RUN start and retained by
Last Run. They are Desktop session options, not Template data. Changing these
controls after RUN does not change the current Last Run chart; start a new run
to use the new settings.

For a Line Chart, **Chart Settings → General → Show All Raw Data** (off by
default) bypasses plotted-point downsampling and draws every loaded raw sample
in the visible X range, including the two neighboring clipping samples when
available. It takes effect immediately, even during a run, independently for
each Chart; you do not need to RUN again. Optional significant-change markers
may remain visible if enabled for that run. Displaying all raw data can slow the
Desktop interface or make it temporarily unresponsive, especially during Live.
None of these display options modify committed Raw Data, CSV/XLSX exports or
non-Line charts.

Only **Line** supports live updates while execution is running. After execution stops, any run
with committed numeric rows, including a failed run, can select **Line**,
**XY Scatter**, **Column**, **Area**, **Bar**, **Combo**, **Histogram**, or
**Box & Whisker** from **Settings → General → Chart type**. Line shows the
Iteration trend; Area fills below the line; Column uses vertical grouped bars;
Bar uses horizontal grouped bars; and XY Scatter compares numeric X and Y
values.

Chart Settings has five tabs: **General**, **Series**, **Axes**, **Analysis**,
and **Export**. Series contains per-Output **Auto** or **Custom color**, Line
styles, Scatter settings, and Combo Type/Axis settings. Each Line Output can
use **Line** or **Line + markers**. Combo Outputs can use **Column**, **Line**,
or **Line + markers**. Marker-enabled Line and Combo Outputs can set marker
size, shape (Circle, Square, Diamond, or Triangle), fill, and border. Scatter
keeps its chart-wide marker size and line width while marker shape, fill, and
border are per Output. Marker fill and border use the Output series color in
**Auto** mode or an independent custom color. Legends mirror the rendered
line/marker style; Area remains marker-free. Box & Whisker retains its
automatic colors.

**General → Chart type** also shows the Output-count helper for Combo and
Histogram. When switching to Histogram with multiple Outputs selected,
**Apply** keeps the first selected Output.

A chart panel can select multiple **Outputs** to compare numeric series.
Scatter **X source** can be Iteration, any numeric Output, or a Timestamp Output, and an Output used
only as Scatter X does not need to be selected as a Y series. **Display** can
show Markers, Lines, or Lines + markers. Scatter **Marker size** and **Line
width** accept positive finite numbers and apply to the modes that show them.
Scatter keeps raw X/Y pairs in original row order, including nonmonotonic X
values; Lines connect those pairs in that order. Timestamp X uses the full date/time
as an absolute millisecond coordinate, so it remains continuous across midnight.
X labels and hover use that Output's Include Date / Include UTC Offset options in
fixed UTC+08:00, independent of the computer timezone. Timestamp is excluded from
Y series, Summary, Histogram, and other measurement statistics. Elapsed X retains
raw seconds regardless of its display format. Elapsed X-axis labels and Tooltip X
values follow the Output's Time Format. In Chart Settings, X-axis **Minimum**,
**Maximum**, and **Major unit** always use raw seconds, including when labels show
minutes, hours, or decimal days. Scatter hover uses screen-space
proximity; line displays may be selected through a visible segment but always
report an actual raw row rather than an interpolated measurement. Combo
requires at least two selected Outputs; each Output can use Column, Line, or
Line + markers rendering and the Left Y or Right Y axis. The two Y axes are
configured independently, and Combo supports Iteration X-axis zoom.

Histogram uses exactly one numeric Output. **Bins** can use Auto, Count from
1 to 200, or a positive Width. Auto uses the Sturges rule; a Width that would
create more than 200 bins reports an error. Box & Whisker draws one box for each selected Output and can
show or hide outlier points. These statistical charts are computed from
committed StoredRun rows and do not load their full raw samples into the
frontend chart cache. **Analysis → Show normal curve** overlays a line on
Histogram. Blank **Mean** and **Std Dev** use the same mean and sample standard
deviation as Summary; custom Mean must be finite and custom Std Dev must be
finite and greater than zero. Each bin-center normal PDF is scaled by sample
count and that bin's actual width to match the Count axis. With automatic Std
Dev, fewer than two samples or zero variance omits the curve while keeping the
Histogram usable.

For large datasets, Line and Area decimate only the visible Iteration range,
and Combo applies the same viewport decimation to both Line styles. Column and
Combo Column series keep every raw row in the visible range; Scatter and Bar
preserve raw pairs. Scatter does not sample or decimate its raw pairs. Scatter
Markers use ECharts large rendering for marker sizes of 4 or greater; smaller
markers use normal scatter rendering so the requested shape is preserved.
Scatter Lines and Lines + markers use line rendering. These display
optimizations do not remove committed ResultRows.
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

Line, Area, Column, and Combo can enable **Settings → Axes → Zoom → Enable zoom**.
Use the mouse wheel to zoom the X axis and drag inside the chart to pan.
**Show zoom slider** controls the bottom slider without clearing the current
range; wheel zoom and drag pan remain available when the slider is hidden.
**Reset Zoom** returns to the full X range. An active Line chart follows new
rows until the user manually zooms or pans; after that, new rows do not move
the current viewport until Reset Zoom. Applying a changed X Axis Minimum or
Maximum, disabling zoom, or switching to a chart type without zoom resets the
manual viewport. Scatter, Bar, Histogram, and Box & Whisker do not expose
Zoom controls.

Each chart has an individual **Export PNG** action. The subtle chart boundary
marks the exported chart surface: title, legend, axes, plot, and current zoom
range are included; Output selection controls, chart action buttons, zoom slider,
and Reset Zoom are excluded. **Settings → Export → Background** can use Light
or Dark independently of the Application theme. Custom series colors and the
Normal curve are included in either background.

Chart configuration survives Page/tab changes and subsequent Simulation or
Live runs, subject to Page/Output compatibility. Non-Line panels stay in their
original Page and order while running, display **Waiting for run to finish**,
and hide the plot. Their Output selection and Export PNG remain disabled;
Settings and Remove remain available. Every Chart can be removed, including
the final Foreground or Background Chart.
During execution, Chart type allows keeping the current type or switching a
non-Line chart to Line, even before the first row arrives. Line cannot switch
to a non-Line type until execution stops. After Apply, Line uses the current
run's data and updates live. Panels that remain non-Line do not load live chart
data and automatically update from the new run's committed rows when execution
stops; no refresh is needed.
Panels stay visible and non-Line panels enter Waiting as soon as the run starts,
even before its first progress update. Until the new run's data is available,
Line displays **Waiting for run data** without showing the previous run's plot
or loading chart data. It then updates live, and **+ Add Chart** still creates a Line chart.
**Open Template** replaces the current Chart configuration with the Template's
saved Charts. If it has no saved Charts, no persisted Chart configuration is
restored and **Save charts with template** is off. After opening a Template
with saved Charts, run Simulation directly to display the new results using
those definitions and settings; no Chart setup is needed. A new blank Template
clears the Chart configuration. **Clear Last Run** removes Last Run data and
clears session Charts when **Save charts with template** is off; when it is on,
the Chart configuration is retained. Chart settings become Template data only
when **Save charts with template** is enabled.

