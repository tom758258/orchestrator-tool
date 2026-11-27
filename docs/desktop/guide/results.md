# Run Results

<!-- help-source -->

## Navigate the Output tab

| Area | What to inspect |
| --- | --- |
| Last Run Execution Results | Step status and errors |
| Messages | Text from Show Message |
| Charts / Live Monitors | Charts and current monitor view |
| Foreground Output | Output Pages, statistics and data |
| Background Output | Captured datasets, statistics and data |

Last Run is the current result workspace. Execution records and committed rows appear newest first; Messages appear in production order. Enabled Live Monitors appear below Charts.

## Last Run: the most recent execution

> **Note:** Orchestrator retains the latest run, not a test-record database. Export measurement data before starting a new run or leaving the application if you need to retain it.

Desktop keeps one **Last Run** in memory. It does not provide Run History, a
database, or SQL storage.

At run start, Desktop saves a Workflow snapshot for that run. Editing the
current Workflow afterward does not reinterpret the Last Run. Opening a
Template clears the Last Run, and **Clear Last Run** removes the current
in-memory result and snapshot.

Last Run also keeps the Execution Mode captured when that run started. Its
Simulation or Live badge does not change when the current selector changes, so
a simulated success is never presented as a real-hardware success.

If a run did not fully complete, committed rows remain available as partial
results and can be manually exported after execution stops.

## Inspect and collapse result panels

| Area | Selection and export |
| --- | --- |
| Foreground Output | Source selects an Output Page and updates Summary, Output Data and export scope. |
| Background Output | Source selects Background and Capture Dataset, with Worker status. Pages contain 100 rows; paging appears only when needed. |

Both sections put export controls in Export settings below Output Data. Foreground chooses a file or folder according to scope; Background always chooses a destination folder and exports the full selected or all datasets, not just the visible rows. Its export button names the chosen format.

Both share Auto, Fixed and Raw number display settings without changing stored data or export precision. Background statistics show only available dataset values; Scopes retains Valid/Invalid, while Serial RX shows event and byte counts. Foreground pages and background datasets are selected separately.

Charts, optional Live Monitors, Foreground Output and Background Output, each Chart and Live Monitor,
and both Output sections' Summary and Output Data have independent `− / +`
controls. All start expanded. Collapsing hides content without clearing settings,
removing Charts, stopping Capture or pausing Monitor reception. Collapse state
is not saved with Templates.

When Charts is collapsed, **Save charts with template** and the chart count remain visible.

**Last Run Execution Results** and **Messages** each have a `+ / −` control on
the right of their heading. Both start expanded, and each collapses on its own
without affecting the other. Collapsing changes what is displayed only: it
never removes execution data, stops a run, or clears results. Expanding again
restores the same position in the result list.

When **Last Run Execution Results** is collapsed it keeps its heading, the
Execution Mode badge, and the execution count summary. The execution list and
its Newer / Older paging are hidden until it is expanded.

### Read error feedback

Failed runs and failed execution records show a short plain-language explanation
first. The original error remains visible under **Technical details** for
debugging. This extra explanation appears only for failures; successful and
cancelled execution records keep the existing compact display. Instrument-specific
SCPI/VISA details are preserved rather than reinterpreted by Desktop.

## Messages

| Setting or limit | Behavior |
| --- | --- |
| Message 1 / 2 / 3 | Three independent tabs |
| Order | Oldest at top, newest below |
| Retention | Most recent 1,000 per tab; summary shows the total count |
| Message length | Up to 4,096 characters; longer values are truncated |
| Export | Not available |

**Messages** collects the text written by Show Message steps. It has three
independent tabs, **Message 1**, **Message 2**, and **Message 3**, and a step
chooses which one it writes to. Each tab lists its messages in the order the
workflow produced them, oldest first, so a loop reads top to bottom. This is the
opposite of **Last Run Execution Results** and **Output Data**, which are shown
newest first. A message keeps its own line breaks. Switching tabs or collapsing
the panel never discards a message.

Because a loop can run many times, each tab keeps only its most recent 1,000
messages. The summary line shows the total number of messages the run produced,
so you can still see that older messages exist. While **Messages** is collapsed
it does not reload the message list, but the run keeps collecting messages and
updating the total, and the latest messages appear when you expand it again.

One message is limited to 4,096 characters so a very long Output value cannot
fill the panel. A longer message is shortened, marked with `…[truncated]`, and
still ends with its own line break.

Messages belong to the run that produced them. A run that ends normally, fails,
or is stopped keeps the messages it already produced. Starting a new run clears
the previous run's messages. **Clear Last Run**, a new Template, and opening a
Template all clear them with the rest of the Last Run. Messages are not saved to
disk and cannot be exported.
