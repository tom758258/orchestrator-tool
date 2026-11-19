# Output Data and Export

<!-- help-source -->

### 10.5 Data and Summary

**Output Data** is built from committed ResultRows. Large tables use
virtualization for display, but the rows remain available for charts and
export.

**Number display** shares one setting between Summary and Output Data. **Auto**
(default) shows up to 15 significant digits and simplifies floating-point tails;
**Fixed** shows 0–12 decimal places; **Raw** shows the original JavaScript Number
string. Changes apply immediately and carry across Run Pages for the current
Desktop session. Count stays an integer, and Elapsed Time/Timestamp formats take
priority. These settings do not change stored values, statistics, Charts, exports,
or templates.

**Summary** shows Count, Min, Max, and Avg by default. **Columns ▾** independently
controls these columns plus Range (Max − Min), Std Dev (σ), 2σ, and 3σ. Std Dev
is the sample standard deviation, calculated as `sqrt(M2 / (n - 1))`; 2σ and 3σ
are its multiples. One sample displays `—` for all three σ columns, while Range
remains available; constant data with at least two samples has Std Dev = 0.
For Elapsed time Outputs, Min, Max, Avg, Range, Std Dev, 2σ, and 3σ follow the
Output's Time Format from that run, matching Output Data and Scatter X display.
Count remains an integer, and missing statistics remain `—`. Formatting affects
display only; the underlying statistics retain their original precision in seconds.
Column choices are temporary presentation settings. If a Page has no numeric
Outputs, there is no numeric summary to show.

## 11. Manual export

Manual export is available from the Output area after the run is no longer
active and the selected export scope contains committed Output rows. Failed or
incomplete runs keep their failure/incomplete status and export those committed
rows as partial results.

Manual export defaults to **XLSX** each time the application starts. You can
switch between **CSV** and **XLSX** during the current session; this choice is not
saved. Streaming CSV behavior is unchanged.

Choose **Run Page** or **All Run Pages**, then choose **CSV** or **XLSX**:

- **Run Page / CSV** — exports the selected Page as one CSV file.
- **Run Page / XLSX** — exports the selected Page as one worksheet.
- **All Run Pages / CSV** — creates one CSV file per Page in the selected
  destination folder.
- **All Run Pages / XLSX** — creates one workbook with one worksheet per Page.

All XLSX time formats use numeric cells suitable for calculations and plotting.
Elapsed **Seconds** stores seconds; the other three formats store seconds / 86400
(Excel days). Timestamp stores the complete date/time serial even when Date is
hidden; `T` and `+08:00` are fixed display text. To convert a difference in Excel
days to seconds, multiply by 86400. CSV and streaming always retain raw Elapsed
seconds and the full ISO Timestamp, regardless of display settings.

Exports use committed ResultRows. XLSX writes finite floating-point values within
Excel's supported numeric range as Number cells without rounding stored values,
so you can calculate and plot them directly at Excel's native precision (about 15
significant digits). JSON integers retain the existing precision protection;
unsafe integers and numbers outside Excel's range remain Text using their stored
JSON representation. Numeric-looking strings remain Text; booleans become
Boolean cells, null becomes Blank, and arrays/objects remain compact JSON Text.
Export preserves stored results; it cannot recover precision already lost when
JSON was parsed. Exports do not add formulas or embedded charts. CSV output is
unchanged, and All-Pages CSV export does not overwrite existing Page CSV files.

Loop Stop is not itself a failure. Stop Workflow produces a stopped run when
cleanup succeeds. After execution stops, rows already committed before a
failure or incomplete termination remain
eligible for manual export. Rows still staged by a failed or stopped owning
scope are not exported.

