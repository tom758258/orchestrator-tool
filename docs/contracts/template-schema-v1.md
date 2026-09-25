# Template Schema v1

This document is the durable contract reference for the current Template JSON
and the workflow semantics that are already implemented. It does not define a
future schema, migration framework, or compatibility layer.

## Version and ownership

The root JSON object has schema_version 1, a template name, a tool_instances
array, and a workflow object containing ordered steps:

    {
      "schema_version": 1,
      "name": "Example",
      "tool_instances": [],
      "workflow": { "steps": [] }
    }

The Template is split into:

- Tool Setup: the setup definition for each logical Tool Instance.
- Workflow Sequence: the ordered procedure executed after the referenced
  Workers are ready.

Schema v1 is parsed and serialized directly. Unsupported schema versions,
unknown fields, invalid IDs, invalid references, and invalid values are
rejected. Existing previous setup/action shapes are not migrated.

The Template does not contain:

- Simulation or Live execution mode;
- machine-local executable paths;
- machine-local Live Resources or last-known resource identity;
- runtime StepExecution or ResultRow data;
- Desktop output-write authorization; or
- Powers safety-cleanup state.

Those values belong to run state or local configuration. The separation is
intentional: a Template can be moved between machines without carrying
machine-specific resources.

## Tool Instances and setup

Each Tool Instance has:

- id: a unique logical Tool Instance ID within the Template;
- tool: the external Tool Type ID; and
- setup: tool-specific setup data.

The Tool Type selects the setup schema; setup fields do not determine the Tool
Type. Meters uses MetersSetup. Powers uses its own PowersSetup, whose canonical
schema v1 representation is currently `{}`. Existing Powers instances with
`"setup": {}` remain valid and serialize the same way. Scopes and Wavegen
continue to use empty setup objects. The schema_version remains 1.

Workflow Tool Actions use target to reference an existing Tool Instance. A
Template can declare multiple instances of one Tool Type. Meters setup uses
the existing DC Voltage and DC Current fields, including Auto/Manual range
mode, manual range, NPLC, and Auto Zero. DC Voltage additionally supports
Input Impedance; DC Current additionally supports Current Terminal. These
fields are mutually constrained by the selected measurement type.

Both DC Voltage and DC Current may specify `vm_comp_slope` as `pos` or `neg`.
When omitted, Orchestrator does not pass `--vm-comp-slope`, leaving the
instrument's VM Comp setting unchanged. Existing schema v1 Templates without
this field load with no VM Comp slope specified.

Manual range mode requires a manual range. Auto mode ignores any stored manual
range and does not emit a range startup argument. Meters trigger mode defaults
to `software`, presented by Desktop as **Single**, and may also be
`software-custom`, `immediate-custom`, or `external-custom`. Single sends
one software trigger and resolves one reading per Measure. Software Custom sends
one software trigger and resolves one batch per Measure. Immediate Custom and
External Custom do not send a software trigger from Measure; they consume the
next ordered batch produced by the already-running Worker.

All Custom modes require `sample_count` from 1 through 1,000,000, may specify
`buffer_drain_size`, and may opt into the external tool's
buffer-overflow-risk override. Trigger Count is not Template input: run
preparation derives it from the maximum number of Measure occurrences for that
Tool Instance. Orchestrator does not impose a separate one-million total-reading
limit; meters-tool remains authoritative for per-field limits, model trigger
support, reading-memory capacity, and overflow-risk validation. Meter
measurement remains a runtime action; it does not configure the session.

Declaring a Scopes or Wavegen instance does not imply that its runtime actions
are supported.

## Workflow steps

Schema v1 supports these step kinds:

- Assert: a comparison expression and failure message.
- Set Variable: assign an InputValue to a variable.
- Output: publish an InputValue under a unique name on a named Output Page.
- Wait: wait for a duration in milliseconds.
- Tool Action: invoke an action on a target Tool Instance with JSON arguments
  and optional InputValue bindings.
- For: bind a loop variable over an exact numeric range and execute a body.
- While: evaluate a comparison and execute a body repeatedly.

Every step has an explicit stable id. Step IDs are unique across the whole
workflow, including nested bodies. Output names are unique across the whole
workflow, case-sensitive and without normalization. Step-output references
must refer to an earlier step that is visible from the current lexical scope.

For and While bodies are ordered step lists. Loop nesting is limited to five
levels. There is no break, continue, equality operator, boolean expression
tree, or timeout semantics in schema v1.

## InputValue and Expression

An InputValue can use these sources:

- elapsed-time;
- timestamp;
- literal;
- variable;
- step-output; or
- expression.

An expression has a left operand, operator, and right operand. Expression
operands can be literal, variable, or step-output. Nested expressions are not
supported. Operators are add, subtract, multiply, divide, greater-than,
greater-than-or-equal, less-than, and less-than-or-equal.

For example, x multiplied by 2 is represented as:

    {
      "source": "expression",
      "left": { "source": "variable", "variable": "x" },
      "operator": "multiply",
      "right": { "source": "literal", "value": 2 }
    }

A step-output operand contains a step_id and a JSON Pointer, for example:

    {
      "source": "step-output",
      "step_id": "meter-read-1",
      "pointer": "/value"
    }

Elapsed time is sampled from the Executor's monotonic runtime context,
measured in seconds and truncated to millisecond resolution. Timing starts
after Worker preparation and CSV setup. Timestamp is a wall-clock value in
fixed UTC+08:00 ISO-8601 form with exactly three millisecond digits. Both are
resolved when the InputValue is used in a Set Variable, Output, or Tool Action
binding. Only explicit Outputs become ResultRow/CSV columns. Expression
operands do not support the two time sources.

Assert reuses the same operand representation but accepts only the four
comparison operators. A true comparison succeeds with boolean true as its
step result. A false comparison uses the configured message, or
Assertion failed. when the message is blank. Invalid references and expression
resolution errors retain their existing validation/diagnostic behavior.

## For ranges and lexical scope

A For range stores start, stop, and step as exact decimal strings:

    {
      "type": "for",
      "id": "sweep",
      "variable": "voltage",
      "range": { "start": "0", "stop": "0.3", "step": "0.1" },
      "steps": []
    }

Numeric JSON values are rejected for these fields. The range uses
rust_decimal::Decimal and exact scaled-integer arithmetic. Decimal values
have a 96-bit mantissa and scale 0 through 28. Normalized start, stop, and
step must fit at a common scale, except that equal endpoints produce one
iteration. A zero step, wrong direction, unrepresentable common scale, or
count overflow is invalid.

The stop is inclusive only when it is reachable on the step grid. For
example, 0 to 0.3 by 0.1 has four values, while 0 to 0.35 by 0.1 ends at
0.3. Equal start and stop always produce one value with any nonzero step.
NumericRange owns the exact iteration count and computes value_at(index)
without allocating a value list. The count fits in usize and uses no
floating-point tolerance or rounded decimal division. Expression arithmetic
and measurement values retain their existing JSON behavior.

For bodies execute sequentially for every range index. The Executor converts
the exact Decimal value once into the existing JSON numeric representation
before binding the loop variable. The binding is lexical: a previous value is
restored after success or failure, or the variable is removed if it did not
exist before the For. Inherited ordinary variables remain mutable across
iterations and after the For. Newly introduced body variables are local to
that iteration.

Body StepOutputs are cleared before each iteration and when leaving the For.
A body can read earlier root outputs and earlier body siblings from the
current iteration, as well as variables visible in its enclosing scope. A
later root step cannot read a body StepOutput.

## While semantics

While evaluates its comparison before each iteration using current variables
and visible earlier StepOutputs. It has no loop variable. Updates to inherited
ordinary variables persist across iterations and after the While; body
StepOutputs follow the same lexical clearing rules as For.

The schema requires max_iterations to be present. A positive integer is a
finite limit. Explicit null means Unlimited. Zero is invalid and omission is
invalid. A finite While evaluates its condition once more after exactly the
allowed number of successful body executions; false succeeds, while a still
true condition fails with the existing max-iterations diagnostic.

An initially false While succeeds without executing its body. A condition
resolution error or body failure fails the aggregate. A successful aggregate
produces JSON null. Unlimited While runs until the condition becomes false,
the body fails, or graceful Stop is requested. Unlimited While is currently
top-level only, must contain at least one body step, and may contain finite
nested loops. A row-producing While that executes zero iterations commits no
synthetic row.

Desktop presents completed iteration numbers starting at 1, but the contract
metadata is zero-based. While does not expose a percentage for unlimited
execution, and external tool limits still apply.

## Output Pages and ResultRow semantics

Every Output step has explicit id, name, page, and value fields. A newly
created Desktop Output may default to the Results page, but page is explicit
Template data and is not a deserialization fallback.

Pages are derived from Outputs in definition order. Each Page is bound to the
complete lexical loop Step ID path that owns its row scope, not merely to loop
depth. Different paths cannot share a Page; one path may contain multiple
Pages. A Page has its own ordered headers and flat rows. Page names are also
CSV file stems and Excel worksheet names: they must be 1-31 characters,
trimmed, non-control, free of filename/worksheet-invalid characters, and not
reserved Windows or Excel names.

A root Output Page commits one ResultRow after the complete owning root
execution succeeds. A successful workflow without any Output still produces
one empty root row. A failed or incomplete workflow commits no root row.
Nested Page rows commit only after their entire owning iteration succeeds.
Rows staged by a failed or stopped ancestor iteration are discarded without
rolling back already committed descendant rows. For example, three outer
iterations and four inner iterations produce three Outer rows and twelve
Inner rows when all iterations succeed.

ResultRow outputs reuse WorkflowOutput values and use the Page's Output names
as columns. Iteration metadata is not a Workflow Output column.

A Custom Meters Measure is a batch source. One Measure action resolves exactly
`sample_count` ordered samples for that occurrence. Software Custom first
sends one software trigger request; Immediate Custom and External Custom only
consume samples already produced or wait for the next samples to arrive. An
Output that directly references that batch, or an expression that depends on
it, is resolved once per sample. The owning Page therefore expands one logical
row into `sample_count` physical committed ResultRows; scalar Outputs on that
Page are broadcast to each physical row.

Several Outputs on one Page may depend on the same batch source and remain
index-aligned. A Page cannot combine two independent Custom Measure sources.
Batch-dependent values are rejected for Assert, Set Variable, While conditions,
and Tool Action bindings. Expansion is Page-local and remains staged until the
owning scope or iteration succeeds, so a later failure discards the staged
batch rows.

Custom Trigger Count is planned per Meters Tool Instance from the maximum
possible Measure occurrences: root occurrence counts once, For counts multiply
by exact iteration counts, finite While counts multiply by `max_iterations`,
nested counts multiply, and separate Measure occurrences add. An Unlimited
While that can reach a Custom Measure is invalid. Trigger Count is capped at
the meters-tool maximum of 1,000,000. Run preparation checked-multiplies
Trigger Count by `sample_count` only for arithmetic overflow; model reading
memory and overflow-risk policy are validated by meters-tool. For Software Custom and External Custom, a finite While that exits early or a
graceful Stop may leave planned triggers unused. Immediate Custom starts the
complete planned acquisition when its Worker session starts, so readings for
later planned Measure occurrences may already exist even if execution exits
early; any unconsumed readings are discarded during Worker cleanup.

## Execution occurrence metadata

WorkflowRunResult contains ordered StepExecution records and committed
ResultRows. Step IDs identify definitions and are not duplicated to represent
occurrences. A body execution carries either:

- ForIteration: the enclosing For Step ID and a zero-based iteration index; or
- WhileIteration: the enclosing While Step ID and a zero-based iteration index.

An occurrence never carries both kinds of metadata. Root executions and root
rows carry neither. Body StepExecutions retain their original Step IDs. For a
successful For, completion order is earlier root steps, body occurrences in
iteration order, the For aggregate execution, and later root steps. A
successful loop aggregate has JSON null as its output.

A body failure records the failed occurrence and then a failed aggregate with
the original diagnostic. Remaining body steps, iterations, and later root
steps do not execute. Graceful Stop finishes the active innermost iteration
through its successful commit point, unwinds to the selected loop, and can
allow parent/root steps to continue. Iteration failure takes precedence over
Stop. It is not a hard cancel.

## CSV streaming and export contract

Desktop may stream CSV during Simulation or Live execution. Before the run,
the caller chooses one Page and a new destination CSV, or All Pages and a
destination folder. These choices are locked during the run and Live
confirmation. All Pages creates a unique timestamped directory containing one
CSV per Page.

Headers are written and flushed before execution. Each committed row is
appended and flushed only to its Page file on the run thread. Other Pages may
still accumulate in memory in the selected streaming mode. Destination
creation errors prevent execution. A write or flush error stops streaming
while workflow execution continues. Committed files are preserved after
failure or graceful Stop, and writers close on every completion path.
Streaming XLSX is not supported, and flush does not guarantee power-loss
durability.

Manual CSV writes committed chronological StoredRun rows directly with the
Page's declared columns, while Core batch helpers and XLSX serialization may
use PageDataset row references. CSV excludes For/While iteration metadata.
Every committed row must match its owning Page's declared Output names, order,
and count. Page export also validates row occurrence metadata against the Page's
innermost owning loop. Root Page rows must carry no loop occurrence metadata.
Cell conversion is shared: strings retain their contents, null becomes empty,
and other JSON values use compact JSON text.

Run Page export can produce CSV or a one-worksheet XLSX. All Run Pages can
produce multiple CSV files or one workbook with one worksheet per Page.
XLSX uses rust_xlsxwriter and writes plain text cells without formulas,
styling, charts, or native numeric cell typing. All-Page export does not
overwrite existing CSV files. Export is allowed only for an authoritative
successful run. Failed or incomplete runs remain inspection-only. Graceful
Stop does not by itself mark a run as failed or cancelled. If the workflow
completes successfully according to the normal completion gate after the
selected loop is gracefully unwound, its committed ResultRows remain eligible
for manual export. Already committed streaming CSV data is preserved after
workflow failure or graceful Stop.
