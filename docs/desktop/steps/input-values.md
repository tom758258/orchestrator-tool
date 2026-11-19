# Input Values and Data Flow

<!-- help-source -->

### 6.1 Input values and data flow

The current InputValue choices in the editor are:

- **Fixed value** — a literal value.
- **Variable** — the current value of a workflow variable.
- **Previous step result** — a result from an earlier visible step. The current
  UI offers results from prior Tool Actions.
- **Calculation** — two operands for arithmetic/comparison, or one operand for Round, Floor, Ceil, and Trunc (Round half values away from zero; Trunc toward zero).
- **Elapsed time** — a runtime elapsed-time value.
- **Timestamp** — a runtime timestamp value.

Set Variable steps create or update variables. A Previous step result can
refer only to a step that is earlier and visible in the current lexical scope.
Calculations use arithmetic and comparison operators. Assert, While, and If
offer `==`, `!=`, `>`, `>=`, `<`, and `<=`. Assert Fixed value operands can
be Number or Boolean; While and If also allow String. Equality compares JSON
values without type coercion; arithmetic and ordering comparisons require
numbers. A Calculation is not an arbitrary nested expression tree.

For an Output with **Elapsed time**, **Time Format** offers **Seconds** (default),
**Minutes:Seconds**, **Hours:Minutes:Seconds**, and **Days (Decimal)**. Minutes
and hours accumulate beyond 60 minutes and 24 hours. Output Data shows three
decimal places for seconds and nine for decimal days. For example, 90061.123
seconds displays as 1501:01.123, 25:01:01.123, or 1.042374109 d.

For a **Timestamp** Output, **Include Date** and **Include UTC Offset** default
to enabled, displaying `2026-10-12T23:24:10.123+08:00`. Disable either option to
hide its portion. This affects display only; the full date/time remains stored
in fixed UTC+08:00, including across midnight. These settings belong to each
Output and survive Template save/load and step copy/paste. Changing Value Source
clears the old time settings. Set Variable and Tool Action time sources are unchanged.

An Output step is what creates a ResultRow column. Values used as inputs do
not become result columns merely because they were referenced.

