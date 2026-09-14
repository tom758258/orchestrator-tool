# orchestrator-tool

`orchestrator-tool` is a Rust-based external tools orchestrator that coordinates external programs through a shared core.

## Architecture

- Core library (`src/lib.rs`): shared orchestration and domain logic. It must remain independent of CLI and desktop presentation layers.
- CLI binary (`src/main.rs`): lightweight engineering CLI for setup, discovery, diagnostics, and maintenance. It uses Core from the same `orchestrator-tool` Cargo package.
- Desktop application: Tauri 2 frontend with built-in external-tool status, a session-only ordered sequence editor with a click-to-add step palette, step reordering, execution result status, parameter editing, template load/save, simulation and live workflow runs, and full step-result display.

The project is Windows-first for deployment, while keeping shared Core code platform-neutral where practical. Core includes Common Worker process and local HTTP IPC support plus focused Powers and Meters Worker diagnostics. Core defines an ordered workflow domain with one-level For, versioned JSON templates, occurrence-aware results, and sequential execution. Desktop supports Run Simulation and a separate Run Live action for Powers and Meters, sharing the same workflow run result contract. Template schema version 1 and the Workflow do not store execution mode, resources, output authorization, or safety cleanup state. The CLI does not provide a workflow run command.

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

A workflow run returns a Core `WorkflowRunResult` containing ordered `StepExecution` records and `ResultRow` values. Each execution retains its `StepResult`; Step IDs remain stable definition identities. Optional `ForIteration` metadata stores the For step ID and a zero-based iteration index separately from Step IDs and Output columns.

A successfully completed workflow without body Outputs produces one root ResultRow, including workflows with For steps. Its cells reuse `WorkflowOutput`, with root Output names as columns in Output step order. A successful workflow without any Output still produces one empty root row. A failed or incomplete workflow commits no root row. Root executions and rows have no For iteration metadata.

Core now executes For bodies sequentially for every index from `NumericRange::iteration_count()`, obtaining each exact range value solely from `NumericRange::value_at(index)`. The Executor converts that Decimal once into a JSON number before binding the loop variable; runtime expressions and tool arguments retain their existing JSON numeric behavior. The binding exists only within the For scope: a previous value is restored on success or failure, or the variable is removed if it did not previously exist. Ordinary variables remain mutable across iterations and after the For. Body step outputs are cleared before each iteration and when leaving the For; bodies can read earlier root outputs and current-iteration earlier sibling outputs.

Body StepExecutions keep their original Step IDs and carry `ForIteration` metadata. Completion order is earlier root steps, body occurrences in iteration order, the For aggregate root execution, then later root steps. A successful For stores JSON null as its aggregate output. A body failure records the failed occurrence and then a failed For aggregate naming the body step and its original diagnostic; remaining body steps, iterations, and later root steps do not execute. Live Powers safe-off and Worker shutdown still run through the existing lifecycle.

When a For body contains Outputs, each fully successful iteration commits one ResultRow with `ForIteration` metadata and body Output names in step order. Outputs are staged until the entire body succeeds; a later failure discards only that iteration's staged row. Previously committed iteration rows remain in the Core result after failure. Iteration metadata does not add Output columns. Validation continues to prohibit mixed root/body Outputs and more than one top-level For with body Outputs.

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

Desktop can create, load, edit, validate, save, and run one-level For workflows in Simulation or Live mode using Template schema v1. Range fields remain decimal strings. The nested Sequence editor keeps root and body moves within their own lists; the palette shows its insertion target and disables For inside a body. Tool Setup usage checks and Live resource confirmation include body ToolActions.

Input suggestions follow Core scope: body steps can read earlier root outputs and earlier body sibling outputs, plus the loop variable and earlier ordinary variables. Later root steps cannot see body StepOutputs or a newly introduced loop variable, but can reuse ordinary variables set in the body. A pre-existing variable with the loop variable's name is restored after For.

Both Desktop run commands return `WorkflowRunResult` DTOs with iteration metadata and committed ResultRows. Execution Results distinguish body occurrences and display iterations starting at 1; root executions retain null metadata. The Output page uses ResultRows directly for either one root row or multiple iteration rows. Its Iteration column is presentation metadata, not a Workflow Output.

CSV export uses `serialize_result_rows_csv`: the first row's Output names form the header, every ResultRow supplies a data row, and subsequent names, order, and counts must match. Iteration metadata is excluded from CSV. Successful For body rows can be exported as multi-row CSV; failed, cancelled, or incomplete runs remain rejected by the backend, even when prior committed rows exist. Desktop labels those rows as inspection-only and disables export. Runs without Outputs do not create a CSV file. Nested For, break, and continue remain unsupported.

Output steps contain a result `name` and an input `value`. Names must not be blank and must be unique within the workflow (case-sensitive, without normalization). Output steps without a name load using the step ID as the name; saving writes the name explicitly. Core `Workflow::project_outputs(&[StepResult])` returns ordered `WorkflowOutput` values with `name()` and `value()` accessors, collecting only Output steps in workflow order. A missing, failed, or cancelled Output result rejects the projection. Projection does not persist results or serialize CSV.

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
