# Scopes Actions

<!-- help-source -->

## Scopes actions at a glance

| Step | Purpose |
| --- | --- |
| Channel Display | Enable or disable a channel display |
| Channel Scale / Offset | Set vertical scale (V/div) and offset (V) |
| Horizontal Scale / Position | Set horizontal scale (s/div) and position (s) |
| Edge Trigger | Set trigger source, slope and level |
| Single Wait | Start one acquisition and wait for triggering |
| Measure | Read a numeric measurement |
| Capture | Save waveform CSV and metadata JSON |
| Screenshot | Save an instrument image |
| AutoScale | Automatically adjust display; specified Keysight models only |

Add a Scopes instance in Setup, then select the target in each step. Parameters and limits follow.

### Setpoint sources

The Scopes group offers Channel Display, Channel Scale, Channel Offset,
Horizontal Scale, Horizontal Position, Edge Trigger, Measure, Capture, Screenshot, and
AutoScale. Channel Scale, Channel Offset, Horizontal Scale, Horizontal Position,
and Edge Trigger Level allow only numeric **Fixed value**, **Variable**, or
**Calculation** setpoints. Calculation operands are fixed numbers or variables,
with Add, Subtract, Multiply, or Divide. Templates enforce these restrictions;
general Output, Set Variable, Assert, and While sources remain available.
Each of these five Scopes setpoints is required, supplied by a fixed value or binding.
Measure exposes Value, Unit, Channel, and Item for Output or Assert.

### Readback after setting

Channel Display, Channel Scale, Channel Offset, Horizontal Scale, Horizontal
Position, and Edge Trigger read back the setting after applying it. If the
readback fails, is missing, or differs beyond the allowed tolerance, the Step
reports FAIL. For a mismatch, the error shows the requested and returned values
and any numeric tolerance that applies.
When verification succeeds, Result comes from the Set command. Set and Query
each use the existing timeout.

TDS2024B and TBS1052B accept an absolute difference up to ±0.05 V for Edge
Trigger Level, including settings close to zero. For example, a 1.00 V setting
passes with a 1.04 V readback and fails with a 1.06 V readback. Source Channel
and Slope must still match exactly.

## Scope Measure: validity

Foreground Measure also offers Valid (`/valid`) for IF/ELSE. A measurement
with a usable value returns `true`. A confirmed invalid measurement sentinel
with clean instrument status completes as a successful Step with `/valid` =
`false` and `/value` = `null`. In IF/ELSE choose Previous step result → Valid
and compare it with Boolean false. All other invalid responses, instrument or
Worker errors, and cancellation still fail the Step. Invalid data does not
prove that no waveform exists; Orchestrator does not retry automatically.

### Model-specific choices

**Measurement Item**, trigger **Slope**, and Capture **Points** are fixed dropdowns
from the current Scopes capabilities. Measurement items and slopes save canonical
strings; Measurement Item capitalizes the first English letter for display,
with `vpp` shown as **Vp-p** while still saving `vpp`. Points saves a number and
cannot use a binding. Simulation uses the
default model; Live uses the target's canonical model ID. Changing mode, model,
target instance, or executable reloads the options. Loading, unavailable
capabilities, or empty lists disable selection. An invalid or unconfirmed value
requires explicit reselection; options never change saved values automatically.
Scopes validates final model support.
A queued job counts as complete only after Scopes reports its terminal result.

## Scope Single Wait

**Scope Single Wait** starts a single acquisition and waits finitely for its trigger.
**Trigger Timeout (ms)** defaults to **5000** and **Poll Interval (ms)** to
**100**; both are fixed positive integers, and Poll Interval cannot exceed
Trigger Timeout. There is no Force Trigger option. A confirmed trigger timeout
is a successful Step with `/outcome` = `timeout` and `/timed_out` = `true`;
use those fields in the existing IF/ELSE. Instrument, Worker, and cancellation
errors still fail the Step. A timed-out trigger does not mean capture succeeded,
and Orchestrator does not automatically force, stop, or reset the instrument.

The Single Wait Result selector shows comparison types and values: Outcome is String (natural means trigger completed; timeout means trigger wait expired); Timed Out and Capture Allowed are Boolean (true or false). Choose the matching type on the other side of IF/ELSE; selecting a result does not change the other operand.

## Select channels

Channel Display, Channel Scale, Channel Offset, and Measure use a fixed
**Channel** dropdown; Edge Trigger uses **Source Channel**. Options are **CH1**,
**CH2**, etc., from offline Scopes capabilities. Simulation uses simulator
channels; Live uses the target instance's identified model. Changing mode,
target instance, Live model, or Scopes executable refreshes the options.
Loading, missing Live model, query failure, or no supported channels prevents
new fixed selections and shows a hint. Saved unsupported values stay visible
and are preserved when saving and reloading. Existing Channel bindings are
preserved with a hint; only explicitly choosing a supported fixed channel
replaces the value and removes its binding. Other bindings remain unchanged.

## Scope Capture: channels

Capture **Channels** uses capability-based **CH1**, **CH2**, etc., checkboxes.
Choose one or more channels; the last selected channel cannot be unchecked.
Saved unsupported channels or invalid values are preserved with a hint and
shown with no boxes checked. Checking a supported channel replaces them with
a valid selection. Existing Channel bindings are likewise preserved until
fixed channels are explicitly selected. Loading capabilities or changing models
never rewrites saved channels automatically.

## Scope AutoScale

**Scope AutoScale** is a Keysight-only Foreground Step (DSOX2004A, DSOX3024A, DSOX4024A, DSOX4034A).
Source Channels, Acquire Mode (Normal/Current), and Channels Mode (All/Displayed) are optional;
omitted choices are not sent to Scopes Tool. Unchecking every Source Channel omits that option.
AutoScale may change channel display/scale, horizontal scale, trigger, and other instrument state;
Orchestrator does not restore those settings automatically. For Background Measure Streaming,
finish the required Scopes Setup before Worker ON; AutoScale cannot run on an active streaming Worker.
A Step succeeds only when its Async Job completes, and Scopes Tool may report a fallback to bare
AutoScale if a selected-source command is rejected. Simulation does not verify physical waveform scaling.

## Scope Screenshot: format

Screenshot **Image Format** uses offline Scopes capabilities: Simulation uses
the default model, and Live uses the saved device model. Unsupported formats
remain visible but disabled. A saved unsupported format is preserved with a
warning when the model changes. If capabilities are unavailable, the editor
shows the reason and disables new format selections.

## Scopes File Output

**Scopes File Output** in the left Workflow panel requires at least one Scopes
Tool Instance in the current Template. Without one, its header is greyed out,
shows a lock and **No Scopes Tool Instance. Add one in Setup.**, and cannot be
expanded; its settings are hidden. Adding the first Scopes instance unlocks it;
removing the last locks it again. Loading a Template updates this lock from its
instances. Simulation and Live use the same rule, without requiring a saved Live
Resource. Locking or unlocking preserves the chosen folder and expand/collapse
state, independently of the Scopes step category.

When unlocked, expand **Scopes File Output**. **Select Folder**
chooses a folder shared by Capture and Screenshot; **Use Default** restores
**Orchestrator application folder / data**. The choice is local runtime state
and is never saved in a Template. Capture produces CSV and metadata JSON;
Screenshot produces an image in the selected format. Every execution, including
loop iterations and later runs, receives new absolute file paths. Existing
files are not overwritten. Job failure or missing required files fails the step.
This panel is separate from CSV Export of Workflow Output rows.
