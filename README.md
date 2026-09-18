# orchestrator-tool

`orchestrator-tool` is a Rust-based external tools orchestrator that coordinates external programs through a shared core.

## Architecture

- Core library (`src/lib.rs`): shared orchestration and domain logic. It must remain independent of CLI and desktop presentation layers.
- CLI binary (`src/main.rs`): lightweight engineering CLI for setup, discovery, diagnostics, and maintenance. It uses Core from the same `orchestrator-tool` Cargo package.
- Desktop application: Tauri 2 frontend with built-in external-tool status, a session-only ordered sequence editor with a click-to-add step palette, step reordering, execution result status, parameter editing, template load/save, simulation and live workflow runs, and full step-result display.

The project is Windows-first for deployment, while keeping shared Core code platform-neutral where practical. Core includes Common Worker process and local HTTP IPC support plus focused Powers and Meters Worker diagnostics. Core defines an ordered workflow domain with For and While nested up to five levels, versioned JSON templates, occurrence-aware results, and sequential execution. Desktop supports Run Simulation and a separate Run Live action for Powers and Meters, sharing the same workflow run result contract. Template schema version 1 and the Workflow do not store execution mode, resources, output authorization, or safety cleanup state. The CLI does not provide a workflow run command.

## Tool Setup and workflow templates

Template schema uses `schema_version = 1` and stores the test definition in two parts:

```text
Template
├─ Tool Setup
└─ Workflow Sequence
```

Tool Setup defines each tool instance session established before a run; it is not a Workflow Step. The Workflow is the ordered test procedure executed after the referenced Workers are ready. Desktop places the Tool Setup editor on the Setup tab, separate from the Workflow tab. The app-level Open Template and Save Template actions preserve both parts together.

Meters Setup supports DC Voltage and DC Current. Both provide Auto / Manual Range Mode, Manual Range, NPLC, and Auto Zero. DC Voltage additionally provides Input Impedance; DC Current provides Current Terminal. DCV cannot carry Current Terminal, and DCI cannot carry DCV Input Impedance. Manual mode requires Manual Range; Auto mode ignores any stored Manual Range and does not emit a `--range` startup argument. Trigger is fixed to Software.

Run preparation validates setup and maps it through the Core Meters adapter to `meters-tool` startup arguments before Worker launch. Simulation and Live share these setup semantics. The run then waits for Worker Ready before invoking the Executor. `Meter Measure` remains a runtime measurement action and does not configure the session. Core checks setup consistency; supported models and numeric settings remain the responsibility of `meters-tool`, without an orchestrator capability database.

The required `tool_instances` array separates logical instance `id` from external tool type `tool`. Each entry has its own `setup`: Meters requires its existing setup fields; other tool types currently use `{}`. IDs must be unique within the Template. Workflow tool actions use `target` to reference an existing instance. During development, the schema v1 wire structure is updated directly. Templates using the previous setup or action fields are rejected; there is no migration or compatibility layer.

ExecutionMode, Live VISA Resource, runtime results, output authorization, and safety cleanup state remain outside the Template. Live resources belong to Desktop configuration, and the execution mode is selected for each run. For DCI with Current Terminal set to 10, the Live confirmation also asks the operator to confirm physical connection to the 10 A terminal. Tool Setup coverage is primarily simulation-based; specific hardware models and setup combinations remain subject to validation by the corresponding external instrument tool.

## Template expressions

A workflow run returns a Core `WorkflowRunResult` containing ordered `StepExecution` records and `ResultRow` values. Each execution retains its `StepResult`; Step IDs remain stable definition identities. Optional `ForIteration` or `WhileIteration` metadata stores the enclosing step ID and a zero-based iteration index separately from Step IDs and Output columns. Existing `for_iteration` fields remain unchanged; parallel `while_iteration` fields identify While occurrences. An execution or row cannot carry both.

Each root Output Page commits one ResultRow after successful root completion, including workflows with For or While steps. Its cells reuse `WorkflowOutput`, with that Page's Output names as columns in step order. A successful workflow without any Output still produces one empty root row. A failed or incomplete workflow commits no root row. Root executions and rows have neither For nor While iteration metadata.

Core now executes For bodies sequentially for every index from `NumericRange::iteration_count()`, obtaining each exact range value solely from `NumericRange::value_at(index)`. The Executor converts that Decimal once into a JSON number before binding the loop variable; runtime expressions and tool arguments retain their existing JSON numeric behavior. The binding exists only within the For scope: a previous value is restored on success or failure, or the variable is removed if it did not previously exist. Inherited ordinary variables remain mutable across iterations and after the For; newly introduced body variables are local to that iteration. Body step outputs are cleared before each iteration and when leaving the For; bodies can read earlier root outputs and current-iteration earlier sibling outputs.

Body StepExecutions keep their original Step IDs and carry `ForIteration` metadata. Completion order is earlier root steps, body occurrences in iteration order, the For aggregate root execution, then later root steps. A successful For stores JSON null as its aggregate output. A body failure records the failed occurrence and then a failed For aggregate naming the body step and its original diagnostic; remaining body steps, iterations, and later root steps do not execute. Live Powers safe-off and Worker shutdown still run through the existing lifecycle.

Each Output belongs to a named Page. Schema v1 requires every Output to contain explicit `id`, `name`, `page`, and `value` fields. Desktop initializes a newly created Output with Page `Results`, but Page is explicit Template data rather than a deserialization fallback. Pages are derived from Outputs in definition order and bind to the full lexical loop Step ID path, not its depth. Different paths cannot share a Page, while one path may have several Pages. Each Page has its own flat rows and Output columns. Its row commits only after its entire owning iteration succeeds. A failed or stopped ancestor iteration discards its staged rows without rolling back committed descendant rows. For example, three outer iterations with four inner iterations produce three Outer rows and twelve Inner rows. Step IDs and Output names remain workflow-global unique.

While evaluates an Assert-style comparison before every iteration using current runtime variables and earlier root StepOutputs. It introduces no loop variable: updates to inherited ordinary variables persist across iterations and after completion. Body StepOutputs follow the same lexical scope and clearing rules as For. An initially false condition succeeds with no body executions; condition resolution errors or body failures fail the aggregate. A successful aggregate produces null. While rows use the same staging, progress events, and successful-run CSV gate as For; an initially false row-producing While commits no synthetic row.

`max_iterations` can be a positive integer or `null`. `null` means unlimited iterations: While runs until the condition becomes false, the body fails, or the user requests graceful Stop. An Unlimited While must be top-level and contain at least one body step; it may contain finite nested loops. With a finite limit, after exactly that many successful body executions, While evaluates the condition once more: false succeeds, true fails with `While reached max_iterations while condition is still true`. It is not an expected iteration count or progress percentage. Desktop defaults it to 1000 and offers an explicit Unlimited option. It shows While identity, 1-based iteration information, and Running state using completed-step events, without a percentage. For presentation is unchanged. External tool limits still apply.

Meters capacity is calculated separately for each instance. Finite measurement bounds retain the extra sample reserved until shutdown. Live supports unbounded Meter measurement inside an Unlimited While and omits `--max-samples`. Run Simulation does not support Meter Measure inside an Unlimited While; use a finite Max iterations value for Simulation.

While reuses the existing comparison operands and operators, with no equality, boolean trees, break, continue, or timeout semantics. In Template schema v1, `max_iterations` is required: a positive integer means a finite limit, explicit `null` means Unlimited, and omitting the field is invalid. A finite limit is represented as:

```json
{
  "type": "while", "id": "warm-up",
  "left": { "source": "variable", "variable": "temperature" },
  "operator": "less-than",
  "right": { "source": "literal", "value": 80 },
  "max_iterations": 1000,
  "steps": []
}
```

Core For steps define a static decimal numeric range using `start`, `stop`, and nonzero `step`. Ascending ranges require a positive step; descending ranges require a negative step. Stop is inclusive when reachable on the step grid: `0 -> 0.3 step 0.1` has four iterations. A non-grid stop is never crossed: `0 -> 0.35 step 0.1` also ends at `0.3`. Equal start and stop always produce one iteration with any nonzero step.

`NumericRange` owns the exact count and `value_at(index)` values; out-of-range indices return `None` without allocating a value list. Only For ranges use `rust_decimal::Decimal` (96-bit mantissa, scale 0–28). Normalized inputs must fit at a common decimal scale, except equal endpoints; otherwise construction reports a representable-domain error. Count uses exact scaled-integer division and must fit `usize`, with no floating-point tolerance or rounded decimal division. Expression arithmetic and measurement values are unchanged.

Template schema v1 stores range values exclusively as exact decimal strings; numeric JSON values are rejected, and invalid or unrepresentable decimal strings fail parsing. Text formatting such as trailing zeros need not be preserved. For example:

```json
{
  "type": "for", "id": "sweep", "variable": "voltage",
  "range": { "start": "0", "stop": "0.3", "step": "0.1" },
  "steps": []
}
```

Desktop can create, load, edit, validate, save, and run For and While nested up to five levels workflows in Simulation or Live mode using Template schema v1. Range fields remain decimal strings. The nested Sequence editor keeps root and body moves within their own lists; the palette shows its insertion target and disables further nesting at depth five. Tool Setup usage checks and Live resource confirmation include body ToolActions.

Input suggestions follow Core scope: loop body steps can read root outputs that exist before the loop and earlier body sibling outputs from the same iteration, plus earlier ordinary variables. A For body can additionally use its enclosing For loop variable; While has no loop variable. Later root steps cannot see body StepOutputs, and a newly introduced For loop variable does not leak (a pre-existing variable of the same name is restored after For), and newly introduced body variables are local to the body iteration; inherited ordinary variables remain mutable. A row-producing While may execute zero iterations.

Core `execute_workflow_with_events` and `run_workflow_with_events` notify callers of completed `StepExecution` records and committed `ResultRow` values during execution. Desktop Simulation and Live use a Tauri Channel to update Execution Results and the Output table incrementally. Rows are notified only after commit, including each successful row-producing For or While iteration. Partial progress remains available for inspection if the command fails; the final command result is the authoritative `WorkflowRunResult`. Manual export requires a successfully completed run. Pause and hard cancel are not supported.

Desktop optionally streams CSV during Simulation or Live runs. Before running, choose either one Page and a new destination CSV, or All Pages and a destination folder. These choices are locked during the run and Live confirmation. All Pages creates a unique timestamped run directory containing one CSV per Page. Headers are flushed before execution; each committed row appends and flushes only its Page file on the existing run thread. Other Pages still accumulate in memory in selected mode. Creation errors prevent execution; write errors stop streaming while execution continues. Failure and graceful Stop preserve committed files. Writers close on every completion path. Streaming XLSX is not supported; flush does not guarantee power-loss durability.

Active For / While loops offer targeted **Stop** after body progress is observed. Stop finishes the active innermost iteration to its successful commit point, then unwinds to the selected loop. Stopping an inner loop permits its parent to continue. Stopping an ancestor skips remaining descendant iterations and discards incomplete ancestor Page rows, then continues root steps after the target. Iteration failure takes precedence over Stop. Normal Powers cleanup and Worker shutdown remain unchanged. Stop is not a hard cancel.

Both Desktop run commands return `WorkflowRunResult` DTOs with iteration metadata and committed ResultRows. Execution Results distinguish body occurrences and display iterations starting at 1; root executions retain null metadata. The Output page uses ResultRows directly for either one root row or multiple iteration rows. Its Iteration column is presentation metadata, not a Workflow Output.

Desktop retains one Last Run in memory. That Last Run is associated with the Workflow definition used for its execution, so editing the current Workflow does not reinterpret or remove its results. Opening another Template or creating a new draft clears the Last Run.

Desktop Charts show iterative Page rows chronologically as lines, with X fixed to the Page row sequence number (1-based Iteration). Each panel belongs to one Page and can select multiple numeric Outputs only from that Page. At most eight panels persist across Page/tab switches within the session; stale Page and Output selections are reconciled when definitions change. Axis titles and PNG export remain supported. Output tables display the selected Page newest-first; CSV and charts remain chronological.

Output tables use virtualized UI rendering for large Last Run Pages while keeping complete committed ResultRows in memory for Charts, CSV, and XLSX export.
Each Run Page also displays a numeric Count / Min / Max / Avg summary from its committed ResultRows.

Manual export supports Run Page as CSV or one-sheet XLSX, and All Run Pages as multiple CSV files or a single workbook with one worksheet per Page. `workflow_export::page_datasets` supplies shared columns and committed chronological rows; CSV and XLSX share cell text conversion (strings unchanged, null empty, other JSON compact). XLSX uses `rust_xlsxwriter` and writes plain text cells without formulas or styling. Page names are 1-31 filename/worksheet-safe characters; case-insensitive aliases and reserved names are rejected. Existing CSV files are not overwritten by All Run Pages export. Export requires authoritative final success and committed rows; failed or incomplete runs remain inspection-only. Break and continue remain unsupported.

Output steps require explicit `id`, `name`, `page`, and `value` fields in schema v1. Names must not be blank and must be unique within the workflow (case-sensitive, without normalization). Missing `name` or `page` fields are rejected during Template JSON loading. Core `Workflow::project_outputs(&[StepResult])` returns ordered `WorkflowOutput` values with `name()` and `value()` accessors, collecting only Output steps in workflow order. A missing, failed, or cancelled Output result rejects the projection. Projection does not persist results or serialize CSV.

Standard Dataflow InputValue sources include `literal`, `variable`, `step-output`, `expression`, and two runtime time sources in schema version 1:

- `{"source":"elapsed-time"}`: monotonic seconds since Workflow execution started, truncated to millisecond resolution. Timing starts with the Executor's runtime context, after worker preparation and CSV creation.
- `{"source":"timestamp"}`: wall-clock time in fixed UTC+08:00 ISO-8601 format, such as `2026-09-15T12:34:56.007+08:00`, with exactly three millisecond digits.

Both are ordinary InputValues sampled when resolved, available in Set Variable, Output, and ToolAction bindings. Only explicit Outputs become ResultRow/CSV columns. Elapsed time is numeric and can use existing numeric charts; Timestamp is a string and has no datetime chart axis. ExpressionOperand does not support either time source.

Template schema version 1 persists structured Expression inputs in Set Variable, Output, and ToolAction bindings using the existing Core domain. For example, `x * 2` is stored as:

```json
{
  "source": "expression",
  "left": { "source": "variable", "variable": "x" },
  "operator": "multiply",
  "right": { "source": "literal", "value": 2 }
}
```

Operands support `literal`, `variable`, and `step-output` (for example, `{ "source": "step-output", "step_id": "meter-read-1", "pointer": "/value" }`). Operators are `add`, `subtract`, `multiply`, `divide`, `greater-than`, `greater-than-or-equal`, `less-than`, and `less-than-or-equal`. Nested expressions are not supported. Save/load preserves the operator, operands, identifiers, JSON Pointers, and workflow step order without storing runtime values.


Assert is a device-independent step with `type: "assert"`, `id`, `left`, `operator`, `right`, and `message` fields in schema v1. It reuses the expression operands above and accepts only the four comparison operators; Core validation rejects arithmetic operators and references to steps that are not earlier in the workflow. A true comparison succeeds with boolean `true` as its step output. A false comparison fails with the configured message (or `Assertion failed.` when blank); resolution errors retain their existing diagnostic messages. Both failures stop later steps through the existing executor, and Live runs retain the existing Power safety cleanup. Desktop Assert properties share Calculation operand and Meter result-field selectors. Assert does not publish a Workflow Output or add CSV columns.

Instance examples: Powers only uses powers-1; Powers + Scopes uses powers-1 and scopes-1; one Meters uses meters-1; two Meters use meters-1 and meters-2, both with tool = meters and independent setups, Live resources, and Worker sessions. Executable paths remain shared by tool type; physical resources are never stored in Templates. Templates reusing an instance ID share its Desktop resource binding, which must be confirmed before Live execution.

Desktop Tool Setup can add built-in tool instances with unique generated IDs and blocks removal of referenced instances. Action editors select compatible instances and prompt users to create one when none exists. The Steps palette groups Workflow, Powers, and Meters actions. Scopes/Wavegen instances can be declared, but their runtime actions return an unsupported error. Serial-tool, additional runtime adapters, manifest-driven UI, plugin systems, and setup registries are not implemented.

## Executable configuration

Core can load a TOML configuration file selected by its caller and use it to override built-in portable executable paths:

```toml
[tools]
meters = "D:/tools/meters-tool.exe"
powers = "D:/tools/powers-tool.exe"

[live_resources]
meters-1 = "USB0::VENDOR::METER_SERIAL::INSTR"
powers-1 = "USB0::VENDOR::POWER_SERIAL::INSTR"
```

Configured paths take priority over portable paths. A missing configured path is reported as missing without falling back to the portable path. Relative configured paths are resolved from the directory containing the configuration file. `tools list` accepts an optional caller-supplied configuration path and does not auto-discover configuration files.

The Desktop application exposes the same configuration through its Tools tab: each built-in tool offers Browse... to persist a configured executable path and Use Portable Default to remove that override. The Setup tab offers Add Tool Instance, Meters setup, and Live Resource controls with Save Resource, Clear Resource, and on-demand discovery for each Powers or Meters instance. Selected resources retain last-known manufacturer, model, serial, and raw identity metadata in the same local configuration. Desktop persists these settings in a single `orchestrator.toml` file inside the OS / Tauri application config directory (under the application bundle identifier). Tool Status, Run Simulation, and Run Live load this same configuration. A missing config file uses portable executable paths.

The optional `live_resources` table preserves exact non-empty resource strings without path resolution, scanning, or fallback. The optional `live_resource_identities` table stores only last-known presentation metadata keyed by ToolInstanceId. Neither table is part of the Template. Live preparation rejects missing or whitespace-only resources and validates executables, manifests, and Worker compatibility before starting any Worker. Simulation remains available without live resources.

Run Live requires operator confirmation showing each referenced instance ID, tool type, and resource, and warning that external tools will run in Live mode and power outputs may change. Powers live writes use both authorization gates: a short-lived Desktop runtime config sets Worker `settings.allow_output_writes=true`, and the runtime adapter injects `arguments.confirm_output=true` into live output-affecting requests. This support file is removed best-effort after the run.

Every live run attempts bounded `safe-off` for all channels on every started Powers instance before Worker shutdown, including after workflow failure or a later Worker startup failure. An explicit Output OFF step does not replace this safety cleanup. Cleanup failure makes the run fail and preserves any original workflow failure in the error; Worker shutdown is still attempted. Simulation does not perform this additional live cleanup.

Physical hardware support remains subject to each external instrument tool's manifest and product support policy. Live Powers and Meters workflows have received limited real-hardware end-to-end validation, including power safety cleanup behavior. Tool Setup coverage remains primarily simulation-based, and this does not imply full validation of all hardware models or setup combinations. Scopes and Wavegen live workflows are not supported.

## External process management

Core can start generic external processes with arguments and expose their process ID, non-blocking status checks, waiting, and forced termination. Standard input, output, and error remain inherited. A managed process performs best-effort termination and cleanup when dropped.

The CLI exposes focused Powers and Meters Worker diagnostics while Core retains process ownership and cleanup.

## CLI

The CLI provides command discovery, external tool listing, and environment diagnostics:

```text
orchestrator-tool --help
orchestrator-tool --version
orchestrator-tool doctor
orchestrator-tool tools list
orchestrator-tool tools inspect <TOOL_ID>
orchestrator-tool tools worker-check powers
orchestrator-tool tools worker-check meters
orchestrator-tool --config <PATH> doctor
orchestrator-tool --config <PATH> tools list
```

`tools list` lists the four built-in external tools and reports each executable's `configured` or `portable` source and `available`, `missing`, or `not-file` status. Missing tools are normal discovery results and do not cause the command to fail. Configuration errors and other discovery I/O errors are reported to stderr with a non-zero exit code.

`doctor` reports the application directory, configuration state, the status of the four built-in external tools, and summary counts. Missing and not-file tools are normal diagnostic results and do not cause the command to fail. Configuration errors and other discovery I/O errors are reported to stderr with a non-zero exit code. It does not perform instrument-level diagnostics.

`tools worker-check powers` validates the resolved Powers executable and manifest, then runs a bounded simulate-mode `read-status` Worker check without requiring hardware. `tools worker-check meters` validates the resolved Meters executable and manifest, then runs a bounded simulate-mode software-trigger check without requiring hardware.

## Development

### Rust checks

Use stable Rust and run checks from the repository root:

```text
cargo build --locked
cargo test --locked
cargo fmt --all --check
cargo clippy --locked --all-targets --all-features -- -D warnings
```

### Desktop development

The Desktop application is located in `apps/desktop`.

From the repository root, install frontend dependencies the first time you set up the Desktop application, or after its dependencies change:

```powershell
cd apps\desktop
npm.cmd install
```

You do not need to run `npm.cmd install` every time you start the Desktop application.

To start the frontend-only development server from `apps/desktop`:

```powershell
npm.cmd run dev
```

`npm.cmd run dev` starts only the Vite frontend development server. To start the complete Tauri Desktop application from the repository root, run:

```powershell
cd apps\desktop
npm.cmd run tauri dev
```

Use `npm.cmd run tauri dev` to validate complete Desktop functionality, including Tauri commands, dialogs, configuration, and workflow execution.

Common frontend static checks from `apps/desktop` are:

```powershell
npx.cmd tsc --noEmit
npm.cmd run build
```

The CLI provides tool listing, manifest inspection, environment diagnostics, and focused Powers and Meters Worker checks.
