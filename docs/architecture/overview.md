# Architecture Overview

This document describes the current architecture of Orchestrator Tool. It is
an engineering reference, not an operator guide. Template and runtime
semantics are defined in [Template Schema v1](../contracts/template-schema-v1.md).

## Component ownership

Orchestrator Tool keeps three product layers:

- **Core** is the Rust library in the root Cargo package. It owns template
  loading and validation, workflow execution, variables and expressions,
  output/result projection, configuration, executable inspection, process
  management, Common Worker sessions, and the adapters needed to prepare
  supported external-tool runs. Core must remain independent of Tauri,
  frontend frameworks, TypeScript, and WebView APIs.
- **CLI** is the binary in the same Cargo package. It is an engineering and
  diagnostic interface for command discovery, tool listing, configuration
  inspection, manifest inspection, and bounded Powers/Meters Worker checks. It
  may call Core, but it is not a second Desktop workflow editor and does not
  provide a workflow run command.
- **Desktop** is the Tauri application under apps/desktop. It is the primary
  workflow operation interface. Tauri commands remain thin application
  boundaries; orchestration, validation, scheduling, template semantics, and
  process/Worker lifecycle belong to Core.

The product is Windows-first for development and deployment. Shared Core code
uses platform-neutral Rust path and process abstractions where practical.
External tools remain independent programs and distributions; their boundary
is described in [External Tool Boundary](external-tool-boundary.md).

## Workflow execution architecture

A run follows this high-level flow:

1. Desktop or another caller loads and validates a Template.
2. Run preparation combines the Template's Tool Setup with machine-local
   configuration and the selected Simulation or Live mode.
3. Core resolves each required executable, probes its manifest, checks Worker
   compatibility, and builds a Worker launch specification for each referenced
   Tool Instance.
4. Core starts the Workers and waits for validated Worker Ready information
   before invoking the Executor.
5. The Executor evaluates the ordered workflow sequentially, including nested
   For and While bodies, and emits progress events as steps complete and rows
   commit.
6. After Executor completion, run orchestration performs the applicable
   external-tool cleanup and Worker shutdown. Core callers that request a
   retained result receive WorkflowRunResult only after that lifecycle
   completes successfully; a cleanup or shutdown failure can make the run API
   return an error instead. Desktop uses the streaming execution path and
   retains committed results in its current StoredRun rather than retaining a
   second Core WorkflowRunResult.

The Template contains the durable test definition: Tool Instances, setup
data, and Workflow steps. Execution mode, executable paths, Live Resources,
runtime results, output authorization, and safety-cleanup state are not stored
in the Template. This separation keeps portable workflow definitions distinct
from machine-local state.

For and While execution is sequential. The current workflow validator permits
nested loops up to five levels. The exact decimal range, lexical scope,
Output Page, row staging, graceful Stop, and loop occurrence rules are
contract details, not redefined here.

## Process and Worker lifecycle

Core's generic process layer starts an executable with arguments, exposes its
process ID, supports non-blocking status checks, waiting, and forced
termination, and inherits standard input, output, and error by default. A
ManagedProcess performs best-effort termination and waiting when it is dropped.

WorkerSession adds the Common Worker protocol around a managed process:

- WorkerLaunchSpec owns the executable path and operating-system arguments.
- Startup consumes and validates Worker Ready information, including the
  Worker schema version, run identifier, status URL, command URL, and stop
  URL.
- Subsequent non-empty stdout lines are decoded as JSON Worker events and are
  received with a caller-provided timeout.
- Shutdown first requests a graceful stop through the Worker stop endpoint,
  polls for process exit within a bounded timeout, and force-cleans the
  process if the request fails or the timeout expires.
- Run orchestration attempts cleanup and shutdown for every started Worker,
  including workflow execution failure and failure while starting a later
  Worker. Original workflow errors and cleanup errors remain distinguishable.

The current manifest and Worker compatibility boundary uses manifest schema
version 2 and the supported Worker protocol schema version 2. The
external-tool contract, rather than this document, is authoritative for
tool-specific Worker actions and payloads.

## Progress and result model

Core exposes two execution events:

- StepCompleted contains a completed StepExecution.
- ResultRowCommitted contains a ResultRow only after its owning row has been
  successfully committed.

The final WorkflowRunResult contains ordered StepExecution records and
committed ResultRow values. Step IDs remain stable definition identities;
loop occurrences use separate ForIteration or WhileIteration metadata. Root
executions and root rows have no loop occurrence metadata. Detailed occurrence
and row semantics are defined in the contract document.

Desktop consumes the event stream through the non-retaining Core execution
path. Its Rust StoredRun is the authoritative in-memory owner of the current
Desktop run: committed ResultRows, compact execution records, the Template
snapshot, status, and incremental Page metadata. Progress IPC carries compact
metadata rather than full ResultRows or full execution history. A failed run
keeps rows that were already committed, while manual export still requires a
successfully completed run. Pause and hard cancel are not part of the current
execution model; graceful Stop is defined by the template/runtime contract.

Core does not provide Run History, a database, or SQL persistence. Desktop
keeps one current Last Run in Rust memory. Starting another run replaces it;
opening another Template, creating a new draft, or clearing Last Run removes
it. Editing the current Workflow does not reinterpret the existing run
snapshot.

## Result data and Desktop projections

ResultRows are the authoritative committed data source for Desktop tables,
charts, CSV, and XLSX export. Presentation layers may derive views, summaries,
or page datasets, but they must not change the committed values or their
chronological row order.

The current Desktop presentation architecture has these properties:

- Output Pages are independent page-local datasets. A chart workspace belongs
  to one Last Run Page and selects numeric Outputs from that page.
- Charts use Apache ECharts Canvas rendering. There are at most eight chart
  panels across the run pages, and the final remaining panel cannot be
  removed. Last Run Page tabs keep Charts, Summary, and Data views on the same
  run snapshot. Chart panel configuration survives Page/tab changes only
  within that Last Run; starting a new run resets the configuration, and the
  first Page receives one default panel when it has numeric Outputs. Each
  panel keeps its title, legend visibility, and axis scale and display settings
  in Last Run session state. These settings are not Template data. Single-chart
  PNG export captures the ECharts-rendered title and plot.
- Large datasets use pixel-aware display decimation. Omitted display points
  remain in the committed ResultRows, and hover inspection resolves the exact
  raw iteration and values. The horizontal coordinate is the 1-based page row
  sequence; charts and CSV remain chronological while the Data view may show
  newest rows first.
- Output tables query newest-first row windows from the Rust StoredRun and
  virtualize only the visible window in the frontend. Logical row indices map
  onto a bounded physical scroll space so million-row Pages do not require a
  tens-of-millions-of-pixels DOM layout. Scrolling away from the newest rows
  keeps the viewed history anchored while new committed rows arrive.
- Charts request only the selected numeric Output series. The frontend keeps
  shared raw Float64 series needed for exact hover and appends bounded tails;
  renderer input remains pixel-decimated. These numeric projections do not
  replace the authoritative ResultRows.
- Page numeric eligibility and Count, Min, Max, and Avg summaries are
  maintained incrementally in Rust rather than rescanning all rows in the
  frontend.
- Execution Results are queried from Rust in bounded newest-first windows, and
  Sequence status uses incremental per-Step summaries.

Desktop derives incremental progress from Core StepCompleted and
ResultRowCommitted events. The Tauri boundary batches compact run metadata
into ProgressBatch messages and delivers it through a Tauri Channel, including
a final flush before completion. Run completion returns compact metadata; it
does not resend the full result dataset across the Tauri boundary.

CSV streaming and XLSX serialization are contract-level behaviors documented
in [Template Schema v1](../contracts/template-schema-v1.md). The key
architecture rule is that both batch and streaming export consume committed
ResultRow data rather than re-evaluating the Workflow or reading presentation
state.
