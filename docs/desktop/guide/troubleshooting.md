# Troubleshooting and Safety

<!-- help-source -->

## Common problems at a glance

| Symptom | First check |
| --- | --- |
| Tool not configured or EXE rejected | Correct CLI/Worker EXE, version and compatibility |
| Missing / Not a file | Whether the executable moved |
| Live Resource missing/unsaved/duplicate | Setup address and Save Resource |
| Simulation asks for sample count | Meters SIM Max Samples |
| Export unavailable | Run ended and exportable data exists |
| Streaming CSV failed | Error details and destination folder |
| Application cannot start | WebView2 Runtime and startup details |

### Detailed troubleshooting

### Tool shows Not configured

In **Tools**, select the Tool Type under **Select tool to add** and use **Add Tool** to
configure the correct external executable.

### Selected executable is rejected

The executable may have the wrong manifest Tool ID or an incompatible Worker.
Select the executable for the intended Tool Type.

### Executable shows Missing or Not a file

The saved path no longer exists or does not identify a file. Use **Change
Path...** to select the current executable; Desktop does not silently search
for a replacement.

### Live Resource is missing

In **Setup**, select or enter the resource for the referenced Tool Instance
and save it before running Live.

### Live Resource changes are unsaved

Use **Save Resource**, then start Live again so the confirmation uses the
persisted backend, resource and identity. Changing the backend clears the drafts;
list or enter the resource again before saving.

### Duplicate Live Resource

Different referenced Tool Instances cannot point to the same resource in one
Live run. Assign distinct resources.

### Simulation asks for Meters sample counts

Enter the per-instance SIM Max Samples or Cancel. This does not change the
Unlimited While. Custom modes are available only in Background.

### Manual export is unavailable

Manual export requires the run to be finished and the selected export scope to
contain committed rows. While a run is active, export stays disabled. A failed
or incomplete run can export its already committed rows as partial results;
zero-row selections remain unavailable.

### Streaming CSV failed

A CSV creation, write or final-flush error fails the run and triggers safety
cleanup. Committed rows, received Background samples and partial CSV files
remain available for inspection and manual export.

### WebView2 is missing

Use the native warning's Yes action to open Microsoft's official WebView2
download page, install or repair the system runtime, then restart the
application. If a Startup failed dialog appears after the availability check,
keep its Details text for diagnosis and make sure Windows is supported and
WebView2 is installed and up to date.

## Safety notes

- Live mode can affect connected hardware.
- Verify every Live Resource before confirmation.
- Powers output writes require Live confirmation and runtime authorization.
- Run-level Powers `safe-off` is cleanup behavior; it does not replace the
  external tool's or instrument's safety requirements.
- For Meters DC Current with the 10 A terminal, verify the physical lead
  connection before confirming Live.
- External tools remain responsible for instrument-specific limits and safety
  behavior.
