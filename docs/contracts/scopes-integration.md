# Scopes integration

Scopes remains an external executable. Core uses its published Common Worker
v2 and Scopes contracts; Desktop only edits Template v1 definitions and local
run options. No VISA/SCPI or physical model rules live in Orchestrator.

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

After Ready and startup identity validation, Core applies acquisition and
explicit channel fields before Workflow execution. Failure stops Workflow,
reports the instance/channel, and shuts down started Workers. Scopes has no
Orchestrator reset, restore, or Powers safety-cleanup behavior.

Desktop queries `capabilities --json` offline. Simulation leaves model selection
to Scopes' default profile. Live adds the canonical model ID from saved local
Resource identity. Missing capabilities disable new selections and retain
saved values; changing model never removes existing setup. Live startup passes
the opaque saved Resource and canonical model ID exactly. Missing, changed,
duplicate, or unknown selections fail without a fallback.

The selected channel controls are common analog-channel operations in Scopes'
published supported-model tables. Their channel availability uses
`analog_channels`; physical probe limits and other instrument constraints remain
external. Orchestrator contains no vendor or model lookup table.

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
| `measure` | `channel`, `item` |
| `capture` | `channel` array, `points` |
| `screenshot` | `format` |

Measure returns Scopes' structured result, including `value`, `unit`, `channel`,
and `item`, for ordinary Output/Assert/dataflow. Orchestrator does not infer
measurement units from channel Setup. HTTP 202 only admits a job. Completion
requires a matching schema/run/job/worker-job/command terminal event, succeeded
state, `ok: true`, and zero exit code. Rejection, failure, cancellation, malformed
correlation, disconnection, and timeout fail the action with diagnostics.

Capture/Screenshot have a 30-second minimum action timeout because screenshot
transport alone can take ten seconds. Other actions retain the caller timeout.

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
They load directly as v1 Templates. Configure the external executables locally
before running them in Desktop Simulation.

Default unit tests do not require instruments. The explicitly ignored tests
`scopes_real_setup_state_survives_jobs` and
`scopes_real_simulation_vertical_slices` require `ORCHESTRATOR_TEST_SCOPES_EXE`;
the latter also requires `ORCHESTRATOR_TEST_METERS_EXE`. Both run Simulation
only. `cargo test --locked --test worker -- --scopes-tests` selects Scopes
protocol/setup cases and directly affected Powers/Meters lifecycle regression
groups without executing the full Worker suite.
