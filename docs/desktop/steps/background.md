# Background Interaction Steps

<!-- help-source -->

### FG/BG Interaction

The **FG/BG Interaction** settings panel is at the bottom of the Workflow
sidebar, below **Chart Options**, and starts collapsed. Without a Background
binding it is locked and its controls are hidden. After enabling Background
Streaming in Setup, expand the panel and select **Enable FG/BG Interaction**
to unlock interaction Steps. Removing the last unreferenced Background binding
disables Interaction but retains the capacity value. **Max Active Command Status**
defaults to **4096** and accepts **1–65536**. It is shared across Backgrounds
for commands still being tracked, not cumulative commands in a Run. Both
settings are saved with the Template. Version 0.3.0 requires the current
Template format; older Templates without these settings cannot be loaded.

First enable Background Streaming for the Tool Instance in Setup, then add
**Worker ON** before interaction Steps. Interaction does not start a Worker
automatically. Capture may remain OFF.

- **BG Command**: supports Meters **Software (Simple)** and Serial **Send / Send File**. For Meters, in
  Background Setup select **Trigger with BG Command**; this replaces the automatic
  timer. The Step succeeds when the Worker accepts the trigger. Select **Wait for
  Completion** to wait for its measurement within the same Step. For Serial, select
  Send or Send File and configure TX using the same inputs as Foreground; no
  additional enable switch is needed. Wait for Completion waits for the TX job.
- **Get Latest**: returns the newest native Background event. Missing or invalid
  newest data fails the Step; it does not substitute an older valid reading.
- **Wait Next**: waits for the first event arriving after the Step starts. The
  first invalid event fails the Step. It can wait for a Source that is starting,
  but fails immediately once the Source has ended.
- **Get Command Result**: select the earlier **Source BG Command Step**. It waits
  for that command's completion and result, then returns the native event. In a
  Loop, the source must have run in the applicable iteration. A source skipped by
  an IF branch fails the Get; another command's result is never substituted.

Get Steps expose the complete native event as Step Output, for example Meters
`/value` in an existing Binding or Output: choose **Previous step result**, select
the Get Step, then choose a common field under **Result**, or use **Custom pointer...** to enter a **JSON Pointer**. BG Command itself supplies no data
output; Get Command Result resolves its invocation internally by source Step.
Latest/Next also support existing
Scopes numeric cycles and Serial RX events. Command/Result is unavailable for
Custom batches and Scopes. Serial Command/Result supports TX only; Latest/Next
continue to return RX events. Powers and Wavegen do not support Background.

**Step timeout (ms)** is optional; blank uses the action timeout. One deadline
covers the whole Step. Each Background can retain one requested result; consume
it before sending another command whose result is needed. Busy or capacity
limits fail immediately without queuing. A command failure after acceptance
fails the Run and starts cleanup, even though its dispatch Step already succeeded.
An uncertain dispatch is not retried. If an IF skips Get Command Result, the
result remains reserved until its enclosing Loop iteration ends, or until Run
end for a command outside Loops. Consume it before sending another command
whose result is needed in the same scope.

Normal Run end waits for outstanding commands with one action timeout. Worker OFF
waits for required commands within its own deadline. Unread results add no wait;
existing finite sample-count and capture-quality rules still apply. Stop Workflow
uses cooperative cleanup without extra ordinary command waits. Worker OFF and a
new Worker ON invalidate old data/result references. If shutdown cannot be
confirmed, the same resource remains blocked even if you switch to timer
triggering or Foreground use. Verify the external tool is stopped before
restarting the application; restarting alone does not verify shutdown.

