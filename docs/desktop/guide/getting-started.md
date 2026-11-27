# Getting Started

<!-- help-source -->

## 1. Overview

Orchestrator Tool Desktop coordinates independent external tools through a
reusable Template. You can configure Tool Types, create logical Tool
Instances, build an ordered Workflow, and run it in Simulation or Live mode.
After a run, Desktop shows committed Results, Output Pages, Charts, and Data,
and can export the available results.

Desktop is the main workflow operation interface. External tools remain
separate programs and distributions; they are not bundled into
orchestrator-tool.

## 2. Requirements

- The application is Windows-first.
- It uses the system Microsoft Edge WebView2 Runtime. If no usable WebView2
  Runtime is detected, Desktop shows a native warning before creating the
  Tauri WebView and can open Microsoft's official download page; the application
  window is not created. If the availability check passes but the main
  Tauri/WebView window still cannot initialize, Desktop shows a native startup
  error with the underlying Tauri detail and exits. The application does not
  download or install WebView2 automatically.
- Meters, Powers, Scopes, Serial, and Wavegen are independent external tool
  distributions. Install and maintain those tools separately, then configure
  their actual executable paths in Desktop.

This guide does not assume an installer or package deployment flow for the
external tools.

## 3. Main Desktop areas

The Desktop tabs are:

- **Tools** — configure each Tool Type's executable path and inspect its
  availability and compatibility.
- **Setup** — create Tool Instances, edit their per-instance setup, and save
  or clear local Live Resources where supported.
- **Workflow** — edit the ordered steps, validate the Template, run
  Simulation or Live mode, request a graceful Stop, and configure CSV
  streaming.
- **Output** — inspect the Last Run, execution results, Output Pages, Charts,
  Summary, Output Data, and manual exports.

The top-right controls provide **Appearance**, **Language**, and **Help**.
**New Template**, **Open Template**, and **Save Template** are grouped under
**Template** on the left of the next row, while **Execution Mode** remains on
the right. Help opens the bundled offline Desktop User Guide in a separate
application window.

The global **Execution Mode** selector controls the whole Desktop execution,
not individual Tool Instances. Desktop starts in **Simulation**, and New
Template or Open Template resets it to Simulation. The prominent
**SIMULATION · NO HARDWARE I/O** or **LIVE · REAL HARDWARE** label and the same
badge on every Tool Instance show the current target. The selector is locked
while a Workflow or manual external operation is active. Execution Mode is
session state; it is not saved in a Template or local configuration.

All Tool Instances show this badge. The badge
does not add runtime support for Wavegen. Scopes supports the selected
Workflow actions described below.

