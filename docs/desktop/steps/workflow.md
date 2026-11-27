# Workflow Steps

<!-- help-source -->

## Basic workflow steps

| Step | Settings and purpose | Example |
| --- | --- | --- |
| Wait | Wait a specified duration in milliseconds | 500 ms waits half a second |
| Set Variable | Name and value source; create or update a variable | x = 5 |
| Assert | Compare two values; fail the workflow if false | Check whether a reading is greater than 0 |
| Output | Name, Page and value source; add a result column | Voltage = Measure reading |

These steps do not require a Tool Instance; using an instrument result requires the corresponding earlier measurement. Assert can provide a failure message. See [Input Values](input-values.md) for sources and comparison rules.

## For: repeat over a range

```text
Example: Start = 1, Stop = 3, Step = 1
i = 1 -> Body -> i = 2 -> Body -> i = 3 -> Body -> Done
```

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

## While: repeat while a condition is true

```text
Check condition -- false --> Done
    |
    true
    v
  Run Body
    |
    +----> Check again (respect iteration limit)
```

A While condition is evaluated before each iteration. Its iteration limit can
be:

- a positive finite `max_iterations` value; or
- **Unlimited**, meaning no finite iteration limit is imposed.

If the condition is initially false, the body executes zero times. An
Unlimited While is allowed at root or inside If branches without For or
While ancestors. Its body must be non-empty and may contain finite nested
loops. It may not contain another Unlimited While.

### Simulation sample limit

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

## If / Else: select a branch

```text
           Condition
          /         \
        true       false
        THEN        ELSE
          \         /
             Next
```

An If step evaluates its condition once and executes only its THEN or ELSE
body. Select an If step and choose which branch receives new palette steps;
drag and paste steps into either branch independently. Branch-local Variables
and Step Outputs do not escape; changes to previously defined Variables
remain available later. Outputs in either branch use the enclosing Page row
scope, with unexecuted branch columns left empty. If does not create an
additional row.

## Stop a workflow or a loop

| Control | Effect |
| --- | --- |
| Stop Workflow | Stop the entire run and wait for required safe cleanup |
| Stop / Stop Loop ID | Exit the selected loop after its current iteration commits; the outer workflow may continue |

### Stop the entire workflow

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

### Stop only the selected loop

The separate **Stop** / **Stop <Loop ID>** controls keep their graceful loop behavior:

1. The active innermost iteration continues until its successful commit point.
2. The selected loop then unwinds.
3. A parent loop or the root workflow can continue after that unwind.

An iteration failure takes precedence over loop Stop. Loop Stop alone does not
mark the whole run Stopped; its final status follows normal workflow success rules.

## Output Pages

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

## Show Message

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

## String Process and Byte Process

Both are Workflow steps with no Tool Instance requirement. Each data parameter
can use Fixed value, Variable, or Previous step result. They do not provide
inline Calculation, Elapsed time, or Timestamp sources. Their result is available
as Value (JSON Pointer `/value`) to later steps. Neither step changes the source
variable or creates an Output column.

### Edit fixed strings

In Process Fixed value string fields, Enter inserts LF. The visible escape
`\r` represents CR, `\n` represents LF, and `\\` represents a literal
backslash. Other backslash sequences remain literal. A loaded CRLF is shown
as `\r` followed by a line break, so CR and LF are not silently merged or
lost. Select complete escapes when editing or copying those characters.
Copy and cut transfer raw selected text; paste and external drops treat
received text as raw. Dragging within or between Process string fields uses
the displayed representation, including when dragging out to another app.
The stored Template and Process values remain ordinary JSON strings; the
1 MiB limit applies to the decoded UTF-8 string, not its editor representation.

Each input and output string is limited to 1 MiB (1,048,576 UTF-8 bytes).
Exceeding this limit fails the step; data is not truncated. This limit does not
change existing Variable, Serial RX, or Capture Dataset limits.

### String operations

**String Process** operates on Unicode code points, not UTF-8 bytes. Indexes
start at zero, and searches are case-sensitive.

| Operation | Parameters after Input String | Result |
|---|---|---|
| Length | — | Number of code points |
| Substring | Start Index, Length | String; zero length returns an empty string |
| Concat | Append | String; an empty append is allowed |
| Contains | Search | Boolean |
| Index Of | Search | First matching index, or -1 |
| Replace | Search, Replacement | String; replaces all non-overlapping matches |
| Trim | — | String without leading/trailing whitespace |
| To Upper Case | — | String |
| To Lower Case | — | String |
| To Number | — | Number; accepts integers, decimals, signs, scientific notation and surrounding whitespace |

Empty search strings, out-of-range indexes, wrong types, and invalid or
non-finite number conversions and nonzero numbers that underflow to zero fail the step. For example, Substring of
`STATUS:PASS` at Start Index 7 and Length 4 returns `PASS`.

### Byte operations

**Byte Process** operates on raw bytes represented by Hex Strings. Hex input
accepts either letter case and whitespace between complete byte pairs. Hex
output is uppercase without spaces; an unspaced Hex String represents at most
524,288 raw bytes within the string limit. Byte indexes start at zero.

| Operation | Data parameters after input | Result |
|---|---|---|
| Byte Length | — | Number of bytes |
| Get Byte | Byte Index | Number, 0–255 |
| Get Bytes | Start Index, Byte Count | Hex String |
| Concat | Append | Hex String |
| Contains | Search | Boolean; matches complete bytes only |
| Hex to Number | Start Index, Byte Count | Number |
| Number to Hex | Byte Count (Input is Number) | Hex String |
| Hex to Text | — | UTF-8 String or Null if bytes are not valid UTF-8 |
| Text to Hex | — (Input is String) | UTF-8 bytes as Hex String |

Hex to Number and Number to Hex additionally require Byte Order (MSB First
(Big Endian) or LSB First (Little Endian)) and Number Format (Signed or
Unsigned). Only these two numeric conversions are limited to 1–4 Bytes;
Signed uses two's complement. Values must be integers in the selected range.
Byte Order does not reverse bits within a byte. Invalid Hex, empty searches,
wrong data types, non-integer indexes, out-of-range slices and numeric overflow
fail without truncation. Invalid UTF-8 is the exception: Hex to Text succeeds
with Null for valid Hex containing invalid UTF-8.

For example, the Serial RX Hex String `AA010CE400FF` can be passed to Hex to
Number at Start Index 2, Byte Count 2, MSB First and Unsigned. Its `/value`
is 3300; a later Calculation can divide it by 1000 to obtain 3.3.
For `1234`, MSB First returns 4660 and LSB First returns 13330.

These steps process the data they receive. They do not assemble Serial RX
events into frames, pair TX with RX, or change Serial Send capabilities.

## Array Process

Array Process is a Workflow Step independent of FG/BG Interaction. Select an
existing Array from **Variable** or **Previous step result**, for example
Get Buffer Data `/data`. Fixed Value Array editing is not supported.
**Length** returns the number of elements (0 for an empty Array). **Get Item**
takes a zero-based integer Index, supplied as Fixed Value, Variable or Previous
step result, and returns the original JSON value (including Null, Object or
nested Array). Invalid input or index fails; the source is never modified.
Use `/value` for the result or a nested pointer such as `/value/rx_hex`.
To process a batch, set i=0, repeat While i is less than the batch count,
use Get Item with Index i, process the item, and increment i with Calculation.
There is no added global Array size limit. Existing String and Byte Process
string limits still apply when those Steps receive an extracted string.


| Array Process operation | Result |
| --- | --- |
| Length | Item count; 0 for an empty array |
| Get Item | The element at a zero-based index |

Example: Length of [10, 20, 30] is 3; Get Item with Index = 1 returns 20.
