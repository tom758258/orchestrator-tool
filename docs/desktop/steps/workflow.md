# Workflow Steps

<!-- help-source -->

### 6.2 For

Configure a For step with **Start**, **Stop**, **Step**, a loop variable, and a
body.

- The Stop value is included when the step grid reaches it.
- Positive and negative directions must agree with Start and Stop.
- A zero Step is invalid.
- Equal Start and Stop values execute one iteration.
- If, For, and While share a maximum nesting depth of eight levels.

For ranges use exact decimal range semantics rather than floating-point
tolerance. The range is evaluated according to the configured step, so a Stop
value that is not reachable is not rounded into an extra iteration.

### 6.3 While

A While condition is evaluated before each iteration. Its iteration limit can
be:

- a positive finite `max_iterations` value; or
- **Unlimited**, meaning no finite iteration limit is imposed.

If the condition is initially false, the body executes zero times. An
Unlimited While is allowed at root or inside If branches without For or
While ancestors. Its body must be non-empty and may contain finite nested
loops. It may not contain another Unlimited While.

If Software Meters **Measure** is inside an Unlimited While and Simulation
cannot determine the source size, **Run Simulation** shows a sample warning.
Each affected instance starts at **1,000 SIM Max Samples**; enter a whole number
from 1 to 1,000,000 or Cancel. These are source startup parameters for this run,
not While iteration limits. They are not saved in Template, Setup or Steps and
do not affect Live. Every new run starts with 1,000 again. If the source runs out
while another Measure is requested, that Measure fails and cleanup runs; the
Worker is not restarted. A Live Software Measure does not receive this SIM bound.

Foreground Meters uses Single in both Simulation and Live. To collect batches
or use Immediate or External triggering, enable Background for that instance.

An If step evaluates its condition once and executes only its THEN or ELSE
body. Select an If step and choose which branch receives new palette steps;
drag and paste steps into either branch independently. Branch-local Variables
and Step Outputs do not escape; changes to previously defined Variables
remain available later. Outputs in either branch use the enclosing Page row
scope, with unexecuted branch columns left empty. If does not create an
additional row.

### 6.4 Stop Workflow and loop Stop

**Stop Workflow** is available whenever Simulation or Live shows Running,
including startup and workflows without loops. It stops the entire workflow:

1. A running Wait ends early. Other actions, Worker startup, and Tool setup
   finish their current operation or reach their existing timeout.
2. No subsequent ordinary step or loop iteration starts. Already committed
   rows, messages, and received Background samples are retained; uncommitted
   rows from an unfinished scope are discarded.
3. Background Workers finish their bounded shutdown and final sample drain,
   followed by Powers Safe-Off and Foreground Worker shutdown. The display stays
   **Stopping Workflow…** until cleanup finishes. A failed stop request displays
   an error and allows retry.

An effective early stop with successful cleanup ends as **Run stopped**, distinct
from success and failure. A real action, data integrity, CSV, or cleanup error
still makes the run fail. A request arriving after the workflow has naturally
finished does not change its successful result. Stop is not Pause or Resume.

Background Dataset completeness and data quality are separate from the run
status. An active finite Capture that ends below its target is **incomplete**;
an active infinite Capture is also incomplete when stopped. Actual samples and
partial CSV files remain available. Quality follows the Worker evidence, and
previously completed Captures are not made incomplete by a later intentional
shortfall. Stopping a Worker without an active Capture creates no Dataset.
Missing termination evidence, sample gaps, overflow, and CSV errors remain failures.

The separate **Stop** / **Stop <Loop ID>** controls keep their graceful loop behavior:

1. The active innermost iteration continues until its successful commit point.
2. The selected loop then unwinds.
3. A parent loop or the root workflow can continue after that unwind.

An iteration failure takes precedence over loop Stop. Loop Stop alone does not
mark the whole run Stopped; its final status follows normal workflow success rules.

### 6.5 Output Pages

An Output step has a name and a Page. Outputs on the same Page form columns in
one dataset. Different Pages are independent datasets, and a nested loop can
own its own Page.

Each Page belongs to one fixed owning lexical loop path. The same Page name
cannot be shared by different lexical loop paths. Page names also have to be
valid as CSV filename stems and Excel worksheet names, so the same naming
restrictions apply to both export formats.

Each foreground Meters Measure supplies one sample. Outputs, calculations,
variables and assertions may use that sample normally. Output rows are committed
only when their owning scope or iteration succeeds; a later failure discards
uncommitted rows. Background samples are recorded separately in Capture Datasets.

### 6.6 Show Message

A **Show Message** step writes text to the Messages Panel while the workflow
runs. Its only purpose is that message: it is not a Popup, not an Assert, and
not an Output Page, so it never adds columns to your data, CSV, or charts.

- **Target Message** selects **Message 1**, **Message 2**, or **Message 3**.
  The default is Message 1.
- **Content Fields** hold the message. A step needs at least 1 and at most 10
  fields, and the default is one empty String field. Use **Add Field** and
  **Delete Field** to change the count. Fields are joined in the order shown.
- A **String** field is text you type, up to 256 characters.
- An **Output** field shows the value of an Output step. The list shows Output
  names, and only Outputs that come earlier in the workflow and are visible in
  the current loop scope are offered. Validation also requires a real Output
  step, so a reference to an earlier Wait, Set Variable, or Show Message step is
  rejected and is never redirected to a different step. A Show Message Output
  must be a single value. If a
  referenced value is not a single number, piece of text, Boolean, or null, the
  step fails with a clear error instead of writing a partial message.
- **Newline** adds a line break after that field. Every message ends with a
  line break on its own, so two Show Message steps never run together on the
  same line, and the last field does not need a Newline checkbox.

**Message Preview** shows the combined result while you edit. An Output field is
shown with its name as a placeholder, so you do not need to run the workflow
to check the layout. This example:

| Field | Type | Value | Newline |
|---|---|---|---|
| 1 | String | `Iteration: ` | Off |
| 2 | Output | `Iteration` | On |
| 3 | String | `Double: ` | Off |
| 4 | Output | `Double` | — |

produces:

```text
Iteration: 3000
Double: 6000
```

Because the fields are resolved when the step runs, a Show Message inside a For
or While loop always reports the current iteration, never a previous one.

