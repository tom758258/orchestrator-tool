# Scopes integration

Scopes remains an external executable. Core uses its published Common Worker
v3 and Scopes contracts; Desktop edits Template definitions and local
run options. Scopes owns VISA/SCPI, instrument limits, and model support.

## Template Setup

Empty `setup: {}` remains valid. All settings are optional and omitted when
Unchanged. An example is:

```json
{
  "acquisition": { "acquisition_type": "average", "average_count": 16 },
  "channels": [
    { "channel": 1, "coupling": "dc", "probe_ratio": 10,
      "bandwidth_limit": true, "invert": false, "units": "volt" }
  ]
}
```

Acquisition types are `normal`, `average`, `high_resolution`, and `peak`.
Average Count requires Average and an integer at least two. Channel IDs must
be positive and unique; probe ratios must be finite and positive. Empty
acquisition/channel records, unknown fields, and invalid enum types fail at
Template validation. Physical limits and model support remain Scopes' concern.

After Ready and startup identity validation, Core applies and verifies
acquisition and explicit channel fields before Workflow execution. Failure
stops Workflow, reports the instance/channel, and shuts down started Workers.
A deferred Background Worker ON waits for Setup verification and the source
to become active. Setup failure prevents Measure Streaming from starting.
Scopes has no Orchestrator reset, restore, or Powers
safety-cleanup behavior.

Desktop queries `capabilities --json` offline. Simulation leaves model selection
to Scopes' default profile. Live adds the canonical model ID from saved local
Resource identity. Missing capabilities disable new selections and retain
saved values; changing model never removes existing setup. Live startup passes
the opaque saved Resource and canonical model ID exactly. Missing, changed,
duplicate, or unknown selections fail without a fallback.

The selected channel controls are common analog-channel operations in Scopes'
published supported-model tables. Their channel availability uses
`analog_channels`; Scopes enforces physical probe limits and other instrument
constraints.

## Selected Workflow actions

The adapter forwards canonical arguments and existing resolved InputValue
bindings. Instrument validation remains external.

| Action | Main configure arguments |
| --- | --- |
| `channel-display` | `channel`, `on: true` or `off: true` |
| `channel-scale` | `channel`, `volts_per_division` |
| `channel-offset` | `channel`, `volts` |
| `timebase-scale` | `seconds_per_division` |
| `timebase-position` | `seconds` |
| `trigger-edge` | `source_channel`, `level`, `slope` |
| `single-wait` | optional fixed `trigger_timeout_ms` (5000), `trigger_poll_interval_ms` (100) |
| `measure` | `channel`, `item` |
| `capture` | `channel` array, `points` |
| `screenshot` | `format` |
| `autoscale` | optional `source_channel` array, `acquire_mode`, `channels` |

Desktop uses the required `direct_measurement_items`, `trigger_edge_slopes`,
and `capture_point_options` arrays from `capabilities --json` for fixed
Measure Item, Trigger Slope, and Capture Points dropdowns. Missing required
fields fail capability parsing; empty arrays disable selection. The broader
`measurement_items` allowlist is not the direct Measure option source.
Capabilities are queried again when mode, canonical model ID, target, or
executable changes; cancelled requests cannot overwrite current choices.
Invalid or unconfirmed choices require explicit reselection.

Template/Core requires fixed nonempty Item/Slope strings and a fixed positive
integer Points value, with no bindings. It does not duplicate model allowlists.
The five numeric Scopes setpoints accept numeric literal, Variable, or arithmetic
Calculation sources only; Calculation operands are numeric literals or Variables.
These restrictions also apply inside For and While bodies. Scopes remains
responsible for runtime values and final model support.

Single Wait is a Foreground-only acquisition-control Step. Its optional
`trigger_timeout_ms` and `trigger_poll_interval_ms` arguments must be fixed
positive integers, with the poll interval no larger than the trigger timeout.
Bindings, force-on-timeout and other arguments are not accepted. Orchestrator
does not issue a force-trigger command. It gives this Action the caller's action
timeout plus the trigger timeout to allow Worker overhead; other Action
deadlines are unchanged. A matching Worker failed terminal with exit code 1
is treated as a successful Step only when the complete trigger result confirms
an unforced `timeout` without result/domain/instrument errors. Keysight uses
the Scopes Worker `result.system_error` status; Tektronix uses its checked
`result.post_command_status`. Missing or null `system_error` is never proof of
a clean Keysight status. A real Worker deadline, cancellation, or other error
still fails the Step. The original result remains available to IF/ELSE, including
`/outcome`, `/timed_out` and `/capture_allowed`. This does not imply that a
waveform was captured, and no reset, retry or stop command is added.

Measure returns Scopes' structured result, including `value`, `unit`, `channel`,
`item`, and `valid`, for ordinary Output/Assert/dataflow. Orchestrator does not infer
measurement units from channel Setup. HTTP 202 only admits a job. Normal
completion requires a matching schema/run/job/worker-job/command terminal event,
succeeded state, `ok: true`, and zero exit code.

The only Measure exception is a confirmed invalid measurement sentinel: a
matching Worker terminal with `state=failed`, `ok=false`, exit code 1,
the normal `execution/job_failed` wrapper without domain errors, and a
structured result with `valid=false`, `value=null`, and
`reason="invalid measurement sentinel"`. Keysight requires a clean
`system_error` (code 0, no error). Tektronix requires a complete native
`post_command_status` with source `tektronix-sesr`, a nonempty raw
checkpoint, status value 0, and no events. Tektronix may set the native
`is_error` flag merely because the measurement is invalid; the
clean status checkpoint is independently required. Missing or conflicting
instrument evidence is not accepted. Only this confirmed invalid result is
exposed as a successful Step preserving Scopes' original `/valid=false`
and `/value=null` for IF/ELSE; no Worker job state or exit code is rewritten.
This is Foreground-only and adds no retry, trigger, or instrument reconfiguration.

A confirmed Single Wait trigger-timeout is the other existing exception.
Other rejection, failure, cancellation, malformed correlation, disconnection,
and timeout conditions fail the action with diagnostics.

AutoScale is a Foreground-only Tool Action admitted by Orchestrator only for
the registered Keysight DSOX2004A, DSOX3024A, DSOX4024A, and DSOX4034A
models. This Orchestrator restriction does not remove Tektronix AutoSet
from Scopes Tool. Omitted parameters remain omitted; optional fixed
`source_channel` is a nonempty list of distinct positive channel IDs, with
actual channel availability checked against model capabilities. Optional
`acquire_mode` is `normal` or `current`; optional `channels` is `all`
or `displayed`. Bindings and additional arguments are rejected. Template
Templates carry no Live model identity: Template validation checks syntax, Live
Preflight checks the saved canonical model, and Core Run checks the launch
model even for direct callers. Worker identity checks remain authoritative.
AutoScale may alter channel display/scale, timebase, and trigger settings
without automatic restoration or reapplication of Scopes Setup. Scopes Tool
may retry bare AutoScale for specific Keysight source-command errors; the
result's `fallback` and `commands` fields remain available to the Step.
AutoScale uses a 60-second minimum job timeout; other ordinary actions retain
their existing timeouts. Background Streaming remains a distinct,
setup-before-source workflow, and AutoScale is not dispatched to its active
Worker.

Capture/Screenshot have a 30-second minimum action timeout because screenshot
transport alone can take ten seconds.

## Settings readback

For the settings below, a successful Set is followed by a separate Query of
the same command and a comparison with the requested value. Each job has the
existing timeout in full. Channel queries send `query: true` and the original
`channel`, which must also agree with the returned channel. Acquisition,
timebase, and Edge Trigger queries send only `query: true`. The Query result
must report `operation: "query"`. Fields left Unchanged are excluded from
comparison and cause no extra Query. A single
`acquisition` Query covers both `type` and `count` when both are configured.

| Scope | Setting | Worker command | Set argument → Query result field |
| --- | --- | --- | --- |
| Setup | Acquisition Type | `acquisition` | `type` → `type` |
| Setup | Average Count | `acquisition` | `count` → `count` |
| Setup | Channel Coupling | `channel-coupling` | `coupling` → `coupling` |
| Setup | Probe Ratio | `channel-probe` | `ratio` → `probe_ratio` |
| Setup | Bandwidth Limit | `channel-bandwidth-limit` | `on` / `off` → `bandwidth_limit` |
| Setup | Channel Invert | `channel-invert` | `on` / `off` → `invert` |
| Setup | Channel Units | `channel-units` | `units` → `units` |
| Workflow | Channel Display | `channel-display` | `on` / `off` → `display` |
| Workflow | Channel Scale | `channel-scale` | `volts_per_division` → `volts_per_division` |
| Workflow | Channel Offset | `channel-offset` | `volts` → `volts` |
| Workflow | Horizontal Scale | `timebase-scale` | `seconds_per_division` → `seconds_per_division` |
| Workflow | Horizontal Position | `timebase-position` | `seconds` → `position_seconds` |
| Workflow | Edge Trigger | `trigger-edge` | `source_channel` → `source_channel`, `level` → `level_volts`, `slope` → `slope` |

Booleans, canonical strings, channel numbers, and Average Count must match
exactly. A continuous value must be a finite JSON number. Core compares
`abs(actual - expected)` against the following tolerance.

| Model and field | Tolerance |
| --- | --- |
| Keysight DSOX2004A, DSOX3024A, DSOX4024A, and DSOX4034A | `max(1e-12, abs(expected) * 1e-3)` |
| Tektronix TBS2074, TDS2024B, and TBS1052B, general numeric fields | `1e-6 * max(1e-12, abs(expected))` |
| Tektronix TBS2074, Edge Trigger Level | `max(1e-12, abs(expected) * 1e-3)` |
| Tektronix TDS2024B and TBS1052B, Edge Trigger Level | `0.05` V absolute, after rounding the difference to 12 decimal places |

Before each numeric Set, Core checks the bounded `/status` response against
the mode, canonical model, and resource verified at startup. A missing,
changed, or unsupported identity fails verification. Source Channel and
Slope always require exact agreement. On the two models with the 0.05 V
exception, a 1.00 V request accepts 1.04 V and 1.05 V, and rejects 1.06 V.
The absolute limit can allow a large relative difference near zero. These
rules define software acceptance. See the
[Keysight CLI check](https://github.com/tom758258/scopes-tool/blob/b437f65a396a469685f52b8678e814015a0a890c/scripts/live-cli-check.ps1#L1186-L1207)
and the
[Tektronix CLI check](https://github.com/tom758258/scopes-tool/blob/b437f65a396a469685f52b8678e814015a0a890c/scripts/_live_tektronix_helpers.ps1#L283-L325).

Query rejection, failure, timeout, missing or invalid fields, and mismatches
fail the Setup or Workflow Step. A numeric mismatch reports the expected
value, actual value, and tolerance. Setup failure prevents Workflow execution.
For a successful Workflow Step, its Result is the original Set result.
Readback does not retry or restore instrument settings.

## Runtime file output

The shared folder is a Desktop runtime option, separate from Workflow CSV
Export. Default is the Orchestrator executable's parent folder plus `data`.
Core requires an absolute selected folder and allocates unique absolute paths
for every execution, including repeated runs and loop iterations. Capture
receives required `csv` and `meta` destinations; Screenshot receives `output`.
Plot output is optional in the external contract and is not requested here.
Existing files are never reused. Terminal files must include each requested
destination and those files must exist before success is exposed.

Template capture/screenshot arguments and bindings cannot specify `csv`,
`meta`, `plot`, `output`, or `query_hardcopy`. Local folders, executable paths,
Resources, model IDs, and generated artifact paths are not Template settings.

## Focused examples and validation

[Example Templates](../../tests/fixtures/scopes/) cover Setup/Measure/Output,
dynamic settings/bindings, repeated Capture/Screenshot, and mixed Scopes/Meters.
They load directly using the current versionless Template format. Configure the external executables locally
before running them in Desktop Simulation.

Default unit tests do not require instruments. The explicitly ignored tests
`scopes_real_setup_state_survives_jobs` and
`scopes_real_simulation_vertical_slices` require `ORCHESTRATOR_TEST_SCOPES_EXE`;
the latter also requires `ORCHESTRATOR_TEST_METERS_EXE`. Both run Simulation
only. `cargo test --locked --test worker -- --scopes-tests` selects Scopes
protocol/setup cases and directly affected Powers/Meters lifecycle regression
groups without executing the full Worker suite.
