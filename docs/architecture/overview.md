# Architecture Overview

This document describes the current architecture of Orchestrator Tool. It is
an engineering reference, not an operator guide. Template and runtime
semantics are defined in [Template Schema v2](../contracts/template-schema-v2.md).

## Component ownership

Orchestrator Tool keeps three product layers:

- **Core** is the Rust library in the root Cargo package. It owns template
  loading and validation, workflow execution, variables and expressions,
  output/result projection, configuration, executable inspection, process
  management, Common Worker sessions, and the adapters needed to prepare
  supported external-tool runs. Core must remain independent of Tauri,
  frontend frameworks, TypeScript, and WebView APIs.
- **CLI** is the binary in the same Cargo package. It is an engineering and
  diagnostic interface for command discovery, tool listing, configuration
  inspection, manifest inspection, and bounded Powers/Meters Worker checks. It
  may call Core, but it is not a second Desktop workflow editor and does not
  provide a workflow run command.
- **Desktop** is the Tauri application under apps/desktop. It is the primary
  workflow operation interface. Tauri commands remain thin application
  boundaries; orchestration, validation, scheduling, template semantics, and
  process/Worker lifecycle belong to Core.

The product is Windows-first for development and deployment. Shared Core code
uses platform-neutral Rust path and process abstractions where practical.
External tools remain independent programs and distributions; their boundary
is described in [External Tool Boundary](external-tool-boundary.md).

## Workflow execution architecture

A run follows this high-level flow:

1. Desktop or another caller loads and validates a Template.
2. Run preparation combines the Template's Tool Setup with machine-local
   configuration and the selected Simulation or Live mode.
3. Core resolves each required executable, probes its manifest, checks Worker
   compatibility, and builds a Worker launch specification for each referenced
   Tool Instance.
4. Core starts the Workers and waits for validated Worker Ready information
   before applying referenced Scopes Setup and invoking the Executor.
5. The Executor evaluates the ordered workflow sequentially, including nested
   For and While bodies, and emits progress events as steps complete and rows
   commit.
6. After Executor completion, run orchestration performs the applicable
   external-tool cleanup and Worker shutdown. Core callers that request a
   retained result receive WorkflowRunResult only after that lifecycle
   completes successfully; a cleanup or shutdown failure can make the run API
   return an error instead. Desktop uses the streaming execution path and
   retains committed results in its current StoredRun rather than retaining a
   second Core WorkflowRunResult.

The Template contains the durable test definition: Tool Instances, setup
data, and Workflow steps. It may also contain optional Output Views with saved
Chart definitions/settings in output_views.charts when the Desktop author
enables **Save charts with template**. This opt-in is off by default; saving
with it off omits output_views. Execution mode, executable paths, Live
Resources, runtime results, output authorization, and safety-cleanup state are
not stored in the Template. This separation keeps portable workflow definitions
distinct from machine-local state.

For and While execution is sequential. The current workflow validator permits
nested loops up to five levels. The exact decimal range, lexical scope,
Output Page, row staging, graceful Stop, and loop occurrence rules are
contract details, not redefined here.

## Process and Worker lifecycle

Core's generic process layer starts an executable with arguments, exposes its
process ID, supports non-blocking status checks, waiting, and forced
termination, and inherits standard input, output, and error by default. A
ManagedProcess performs best-effort termination and waiting when it is dropped.

WorkerSession adds the Common Worker protocol around a managed process:

- WorkerLaunchSpec owns the executable path and operating-system arguments.
- Startup consumes and validates Worker Ready information, including the
  Worker schema version, run identifier, status URL, command URL, and stop
  URL.
- Subsequent non-empty stdout lines are decoded as JSON Worker events and are
  received with a caller-provided timeout.
- Shutdown first requests a graceful stop through the Worker stop endpoint,
  polls for process exit within a bounded timeout, and force-cleans the
  process if the request fails or the timeout expires.
- Run orchestration attempts cleanup and shutdown for every started Worker,
  including workflow execution failure and failure while starting a later
  Worker. Original workflow errors and cleanup errors remain distinguishable.

The current manifest and Worker compatibility boundary uses manifest schema
version 2 and the supported Worker protocol schema version 2. The
external-tool contract, rather than this document, is authoritative for
tool-specific Worker actions and payloads.

## Progress and result model

Core exposes two execution events:

- StepCompleted contains a completed StepExecution.
- ResultRowCommitted contains a ResultRow only after its owning row has been
  successfully committed.

The final WorkflowRunResult contains ordered StepExecution records and
committed ResultRow values. Step IDs remain stable definition identities;
loop occurrences use separate ForIteration or WhileIteration metadata. Root
executions and root rows have no loop occurrence metadata. Detailed occurrence
and row semantics are defined in the contract document.

Desktop consumes the event stream through the non-retaining Core execution
path. Its Rust StoredRun is the authoritative in-memory owner of the current
Desktop run: committed ResultRows, compact execution records, the Template
snapshot, status, and incremental Page metadata. Progress IPC carries compact
metadata rather than full ResultRows or full execution history. A terminal
failed or incomplete run keeps rows that were already committed and permits
manual export of those rows as partial results. Active runs remain
non-exportable, and staged rows from a failed or stopped owning scope are never
promoted just to support export. Pause and hard cancel are not part of the
current execution model; graceful Stop is defined by the template/runtime
contract.

Core does not provide Run History, a database, or SQL persistence. Desktop
keeps one current Last Run in Rust memory. Starting another run replaces it;
opening another Template, creating a new draft, or clearing Last Run removes
it. Editing the current Workflow does not reinterpret the existing run
snapshot.

## Result data and Desktop projections

ResultRows are the authoritative committed foreground data source for Desktop
tables, charts, CSV, and XLSX export. Background samples belong to the separate
run-scoped BackgroundStore. Presentation layers may derive views, summaries,
or page datasets, but they must not change the committed values or their
chronological row order.

The current Desktop presentation architecture has these properties:

- Output has three independently collapsible sections: Charts, Foreground
  Output, and Background Output. Charts brings together charts from all Last
  Run Pages and Background bindings, along with enabled Live Monitors.
  Foreground Page tabs select Summary and Output Data, without filtering Charts.
  All sections and their collapsible children start expanded; collapsing them
  preserves mounted views and data updates. Background Output visibility follows
  the Last Run snapshot, so editing Draft bindings does not hide existing results.
- Output Pages remain independent page-local datasets. Each foreground chart
  selects numeric Outputs from one Last Run Page. Each background chart selects
  its own Background and Capture Dataset, initially the latest Dataset and then
  fixed until explicitly changed. Dataset selection survives tabs and resets for
  a new run; it is never Template data.
- Charts use Apache ECharts Canvas rendering. Foreground and Background panels
  share a limit of eight, including session-only and saved charts; Live Monitors
  do not count toward it. The final foreground panel cannot be removed, while
  Background panels can be removed down to zero. Chart panel configuration
  survives Page/tab changes and new Simulation/Live runs subject to the existing
  Page/Output compatibility rules.
  Session-only foreground panels use Page/Output reconciliation; when none
  remain, the first Page receives one default panel if it has numeric Outputs
  and the shared limit allows it. When **Save charts with template** is on,
  runtime run metadata does not reconcile
  saved Chart definitions. **Open Template** replaces the current Chart
  configuration with the Template's saved Charts and turns the checkbox on
  when output_views is present. Without output_views, no persisted Chart
  configuration is restored and the checkbox is off. Restored Charts use the
  new run's data when Simulation runs, without requiring Chart setup. A new
  blank Template clears Chart configuration. **Clear Last Run** removes Last
  Run data and clears session Charts when the opt-in is off; when it is on,
  Chart configuration is retained. Turning the opt-in off keeps the current
  Charts but omits output_views on the next Save Template. Each
  panel keeps its type, Scatter X source, selected Outputs, per-Output colors
  and marker styles, per-Output Line marker enablement, Combo series and
  right-axis settings, Histogram bins and Normal overrides, Box outlier
  visibility, title, legend visibility, axis scale and display settings, X-axis zoom settings, and image
  background in Desktop session state by default. With **Save charts with
  template** enabled, these definitions/settings become optional Template
  output_views.charts. Background definitions identify a stable Background ID;
  they do not store a runtime Dataset ID or settings in backgrounds[].chart.
  A missing Background reference blocks Validate and Save Template with a visible
  error, without leaving the application busy. Last Run charts remain usable;
  chart changes never recreate Draft bindings. Runtime panel IDs, actual run
  samples/data, calculated runtime/statistical results, Run IDs, loading/error UI state, dialog state,
  and export destinations/paths are never Template data. The current interactive
  zoom/pan viewport remains transient presentation state and resets when the
  configured X-axis minimum or maximum changes; it is not saved with the
  configured zoom settings. Workflow **Chart Options** (Sampling, Preserve
  Significant Changes, Show Significant Change Markers, and Fit Data) remain
  session-only even when the opt-in is on. Single-chart PNG export uses a light
  or dark palette independently of the application theme, captures the current
  viewport and ECharts-rendered title, and excludes interactive DataZoom controls.
  Application actions remain busy until every active PNG export has completed,
  failed, or been cancelled.
- Background Charts share the same card, settings, renderer, and PNG export as
  foreground charts. They support Line, Scatter, Column, Area, and Bar with
  Elapsed Time, Timestamp, or Sample Index as the source axis. Core queries return
  at most 2,000 points by default: Line/Area preserve bucket extrema and endpoints,
  while other types select representative observations. Background Line's Show
  All Raw Data permits at most 25,000 samples in the visible range; exceeding it
  returns an explicit limit result instead of silently sampling. Live Monitors
  use the existing rolling 1,000 Worker samples and shared Line renderer,
  independently of Capture, with no chart settings, PNG export, or saved definition.
- Live visualization for both sources remains Line only, defined by
  `chartSupportsLive`. While running, preserved non-Line panels display Waiting without a plot; Output
  selection and Export PNG remain disabled, while Settings and Remove are
  available subject to PNG-saving and last-chart removal guards. Chart Settings
  allows retaining the current type or switching non-Line to Line, including
  before the first committed row; options and Apply enforce this rule. Line
  cannot switch to non-Line while running. Applying Line resumes requests for
  that chart's source using the current run ID. Simulation and Live share these
  rules through the same running flag. Only Line panels request chart data while
  running, and foreground statistical requests
  remain post-run only. When running becomes false, the existing loaders and
  statistical effects automatically load the new run's committed rows. Raw
  caches remain isolated by run ID, and statistical keys include the run ID.
  For foreground charts after execution stops, committed numeric
  rows can use Line, XY Scatter, Column, Area, Bar, Combo, Histogram, and Box &
  Whisker; failed runs with committed rows remain available for inspection.
  Selecting multiple Outputs compares their series
  on the same chart. Scatter uses Iteration or a numeric Output as X; an Output
  used only as Scatter X remains a chart data dependency. Analysis charts wait
  until all required series are loaded before rendering. Line and Combo Line
  series can enable per-Output markers with configurable size, shape, fill, and
  border; Scatter keeps chart-wide marker size while sharing the per-Output
  marker shape/fill/border settings. Auto marker colors resolve from the
  Output's current series color. Legend icons follow the rendered series style,
  including marker-free Line, Scatter Lines, Combo Line, and Area. Combo uses
  one Iteration X axis and per-Output Column, Line, or Line + markers rendering
  on the left or right Y axis. Both Combo Line styles use viewport min/max
  decimation while Column series keep every raw row in the viewport. Combo uses
  the existing raw-series loader and X-axis zoom.
- Histogram and Box & Whisker are post-run projections computed from committed
  StoredRun rows. They do not load their full raw samples into the frontend
  chart cache. Histogram accepts one numeric Output and uses Auto (Sturges),
  Count (1–200), or positive Width bins, with at most 200 bins. Its optional
  Normal overlay uses mean and sample standard deviation from the same Rust
  online Welford accumulator as Summary, or presentation-only custom values;
  bin-center PDF values scale by sample count and each bin's actual width.
  Summary optional Range and sigma multiples derive only from Rust metadata.
  Box & Whisker uses sorted samples and linearly interpolated percentiles at positions
  `(n - 1) * p`; whiskers are the outermost observed values within 1.5 IQR
  fences, and values outside the fences are outliers.
- Foreground Line and Area decimate only the visible raw iteration range according
  to plot pixel width, including when custom X-axis bounds narrow the view. Column
  renders raw rows in its visible iteration viewport. Scatter preserves raw XY
  pairs in original row order: Markers use ECharts large scatter rendering,
  while Lines and Lines + markers use the line renderer without sorting,
  sampling, or decimation. Horizontal Bar preserves raw value and iteration
  pairs; Column and Bar use ECharts large rendering. Omitted display points
  remain in the committed ResultRows. Line, Area, Column, and Combo hover
  inspection resolves exact raw iteration and values. Scatter hover uses
  screen-space proximity to raw points and, for line displays, raw segments,
  then reports a real endpoint row rather than an interpolated value. Bar,
  Histogram, and Box & Whisker do not provide hover inspection.
  X-axis zoom for Line, Area, Column, and Combo supports an automatic full-range view that follows new rows and a
  manual absolute iteration range that stays fixed as rows arrive. The horizontal
  coordinate is the 1-based page row sequence; charts and CSV remain
  chronological while the Data view may show newest rows first.
- Output tables query newest-first row windows from the Rust StoredRun and
  virtualize only the visible window in the frontend. Logical row indices map
  onto a bounded physical scroll space so million-row Pages do not require a
  tens-of-millions-of-pixels DOM layout. Scrolling away from the newest rows
  keeps the viewed history anchored while new committed rows arrive.
- Foreground charts request the selected numeric Output series and any separate
  Scatter X Output. The frontend keeps
  shared raw Float64 series needed for exact iteration and Scatter hover and appends bounded tails;
  Line and Area renderer input remains pixel-decimated. These numeric projections do not
  replace the authoritative ResultRows.
- Page numeric eligibility and Count, Min, Max, and Avg summaries are
  maintained incrementally in Rust rather than rescanning all rows in the
  frontend.
- Execution Results are queried from Rust in bounded newest-first windows, and
  Sequence status uses incremental per-Step summaries.

Desktop derives incremental progress from Core StepCompleted and
ResultRowCommitted events. The Tauri boundary batches compact run metadata
into ProgressBatch messages and delivers it through a Tauri Channel, including
a final flush before completion. Run completion returns compact metadata; it
does not resend the full result dataset across the Tauri boundary.

Background streaming is owned by a small run-scoped Core manager. Foreground
Workers retain their pre-run startup path; Background Workers start and stop at
explicit Workflow actions. Each background has one dispatcher consuming its
WorkerSession and acknowledged control commands. Its bounded stdout queue
reports overflow as failure; optional bounded monitoring does not own or limit
the full memory Dataset. Capture and Worker lifecycles are independent, and
natural completion requires tail, Summary, EOF, actual exit and Tool-specific
quality checks before pending release.

The current StoredRun holds the shared authoritative BackgroundStore. Tauri
only exposes metadata, bounded row/chart/monitor queries and manual export;
background samples never enter foreground DataContext or ResultRows. Manual
XLSX reads bounded windows and uses the existing writer's constant-memory
worksheet mode for export spooling. This is not a file-backed Dataset store.

A shared first-failure signal connects foreground CSV observers, background
writers and executor checkpoints. It prevents new ordinary Steps and interrupts
Wait promptly, separately from graceful loop stopping. In-flight Tool actions
finish within their existing timeout/cancellation contract. Every run still
attempts background cleanup and all Powers Safe-Off operations; cleanup errors
retain the original failure and do not erase partial results.

CSV streaming and XLSX serialization are contract-level behaviors documented
in [Template Schema v2](../contracts/template-schema-v2.md). The key
architecture rule is that both batch and streaming export consume committed
ResultRow data rather than re-evaluating the Workflow or reading presentation
state.
