# Run Simulation and Live

<!-- help-source -->

## 7. Run Simulation

Before Simulation, configure every referenced external executable and ensure
its manifest and Worker compatibility checks can succeed. You can use
Validate first for an explicit Template check; the run also validates the
Template when it starts.

Select **Simulation** in Execution Mode and use the single **Run Simulation**
button. Simulation does not require Live Resources. It uses the external
Workers' simulate contracts and is not intended to operate physical hardware.
For Powers, Protection Setup and final Safe-Off are still sent to powers-tool
for simulation or planning; this is orchestration validation, not Live hardware
validation. Indeterminate Simple Software sources show the run-only sample
warning described above. Custom modes are available only in Background.

## 8. Run Live

Select **Live** in Execution Mode; the same Run control becomes **Run Live**.
Desktop automatically checks fixed Powers and Scopes Workflow parameters and
Setup against each referenced instance's saved model capabilities. **Live
Preflight: Checking** blocks Run while checking; **Passed** allows the existing
Live confirmation flow. **Failed** shows the known incompatibilities in red and
blocks Run until corrected and checked successfully. Required capabilities or
model IDs that cannot be obtained also block Live. Unused instances and unused
optional capability fields do not block it.

Changing the Template, Workflow parameters, Setup, saved Resource/model, or
Powers/Scopes executable invalidates the previous result and triggers another
check. Save any Resource or identity draft changes first. Fixed values inside
For/While/If are checked without running their bodies; values overridden by bindings
remain subject to Worker runtime validation. Preflight never changes your
Template or substitutes a supported channel. This automatic check does not validate
Workflow references or scopes; use Validate or Run for full Template validation.
Simulation is unaffected.

The backend checks the current saved settings again before starting Workers,
creating Powers write authorization, or replacing Last Run. A rejected
Preflight leaves the previous Last Run, results, and Output intact and is shown
as a Preflight failure, rather than a completed Workflow failure.

Before starting Live, Desktop:

- checks the referenced Tool Instances;
- loads their persisted Live Resources and backends;
- rejects unsaved Live Resource, backend or identity draft changes;
- shows a Live confirmation listing each referenced instance, Tool Type, backend, resource and available identity;
- warns that Live mode can change Powers outputs; and
- adds the 10 A terminal warning for the applicable Meters setup.

Confirm only after checking the displayed resources and the connected
hardware. The run validates that both backends and resources still exactly match
what was confirmed. A changed backend or resource, or duplicate resource, causes Live execution to
be rejected and require a new confirmation.

The currently supported Live external tools are Powers, Meters, and Scopes.
Powers and Scopes preflight use saved canonical model IDs. Scopes uses the exact saved Resource;
unknown identities fail without a fallback. Wavegen runtime execution remains
unsupported. Scopes Shutdown does not reset or restore instrument settings.

### 8.1 Powers actions and cleanup

Powers Live actions include setting values and the `output-on` and
`output-off` actions. Live Powers write authorization exists only for the
runtime of the Live run.

At run completion, and also on workflow failure or later Worker startup
failure paths, the orchestrator requests Powers `safe-off` for every started
Powers instance before Worker shutdown. A cleanup failure makes the run fail,
while preserving the original workflow failure when one already exists. The
temporary runtime authorization file is used only for the run and removed on
a best-effort basis.

An explicit Powers `output-off` Tool Action does not replace the run-level
cleanup. Simulation follows the same cleanup position by sending simulated
Safe-Off through powers-tool; it does not claim that real outputs were changed.

