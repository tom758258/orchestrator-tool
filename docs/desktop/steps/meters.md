# Meters Steps

<!-- help-source -->

## Meter Measure: one reading

Meter Measure triggers a single measurement for the selected Meters Tool Instance and obtains one reading. Configure the measurement type and range in Setup rather than repeating them in each step.

| Item | Meaning |
| --- | --- |
| Prerequisite | Compatible meters-tool.exe configured in Tools and a Meters instance in Setup |
| Target | Select the instance to use |
| Settings | DC Voltage or DC Current and other settings from that instance |
| Mode | Foreground Single; use Background Streaming for background operation |
| Result | One measurement; choose Value or Unit in Previous step result |
| Failure | Inspect the step error if measurement or Worker execution fails; no automatic Output column is created |

## Save the reading as a data column

1. Add a Meters instance in Setup with Background Streaming off.
2. Add the Meter Measure step in Workflow and select the instance.
3. Add Output and choose Previous step result as the Value Source.
4. Choose the Meter Measure step and its Value result, then run Simulation.
5. Inspect the column in Output.

Meter Measure alone does not create an Output column. If a step fails, inspect the error. For continuous acquisition or Immediate/External triggering, see [Background Streaming](../guide/background-streaming.md). An instance cannot be both foreground and background in one workflow.

For instrument settings and data-loss risks, see [Tool Setup](../guide/tool-setup.md).
