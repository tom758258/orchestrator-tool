# Input Values and Data Flow

<!-- help-source -->

## Choose a value source

| Source | Purpose | Example |
| --- | --- | --- |
| Fixed value | Enter a literal value | 3.3 |
| Variable | Use a workflow variable | voltage |
| Previous step result | Use an earlier visible step's result | Measure reading |
| Calculation | Arithmetic, comparison or rounding | voltage × 2 |
| Elapsed time | Elapsed run time | 10.5 seconds |
| Timestamp | Date and time during the run | 2026-10-12T23:24:10.123+08:00 |

Previous step result offers earlier Tool Actions, BG Get Latest / Wait Next / Get Command Result / Get Buffer Data / Get Buffer Status, and String / Byte / Array Process results. Usually choose a named result from the dropdown; use the custom JSON Pointer (data path) only for other fields.

Calculation uses two operands for arithmetic/comparison and one for Round, Floor, Ceil and Trunc. Round half values away from zero; Trunc removes fractions toward zero.

```text
Measure -> Set Variable: voltage -> Output: voltage
  3.3 V           3.3                   3.3
```

This is an example of data flow, not an actual measurement.

## Data types and comparisons

Set Variable steps create or update variables. Fixed value supports Number,
String, Boolean, and Null. Boolean uses the True / False selection; Null needs
no value field. String "true" and "null" are text, not Boolean or Null. A Previous step result can
refer only to a step that is earlier and visible in the current lexical scope.
Calculations use arithmetic and comparison operators. Assert, While, and If
offer `==`, `!=`, `>`, `>=`, `<`, and `<=`. Their Fixed value operands support
Number, String, Boolean, and Null. Equality compares JSON values without type
coercion, with case-sensitive strings; arithmetic and ordering comparisons require
numbers. A missing variable or result path is an error, not Null. A Calculation
is not an arbitrary nested expression tree.

## Elapsed time and timestamps

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

## Include values in output data

An Output step is what creates a ResultRow column. Values used as inputs do
not become result columns merely because they were referenced.

An Array returned by a Step can be stored as a Variable and used by Array Process;
no manual fixed Array editor is provided. Use a dynamic Index in Get Item.
