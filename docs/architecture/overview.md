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
6. The run returns a WorkflowRunResult and then performs the applicable
   external-tool cleanup and Worker shutdown.

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
  including paths where preparation, execution, or another Worker startup
  fails. Original workflow errors and cleanup errors remain distinguishable.

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

Desktop uses the event stream to update Execution Results and Output Pages
incrementally. Partial progress can remain available when a command fails,
but the returned WorkflowRunResult is the authoritative completed result when
the run succeeds. Manual export requires an authoritative successful run.
Pause and hard cancel are not part of the current execution model; graceful
Stop is defined by the template/runtime contract.

Core does not provide Run History, a database, or SQL persistence. Desktop
keeps one Last Run in memory and associates it with the Workflow definition
that produced it. Editing that Workflow does not reinterpret the existing
snapshot; opening another Template or creating a new draft clears it.

## Result data and Desktop projections

ResultRows are the authoritative committed data source for Desktop tables,
charts, CSV, and XLSX export. Presentation layers may derive views, summaries,
or page datasets, but they must not change the committed values or their
chronological row order.

The current Desktop presentation architecture has these properties:

- Output Pages are independent page-local datasets. A chart workspace belongs
  to one Last Run Page and selects numeric Outputs from that page.
- Charts use Apache ECharts Canvas rendering. There are at most eight chart
  panels across the run pages. Last Run Page tabs keep Charts, Summary, and
  Data views on the same run snapshot. Compatible chart panels are retained
  for a new Last Run; when none remain, only the first Page receives a
  default panel when it has numeric Outputs. Axis titles and single-chart PNG
  export remain presentation features, and chart settings are session state
  rather than Template data.
- Large datasets use pixel-aware display decimation. Omitted display points
  remain in the committed ResultRows, and hover inspection resolves the exact
  raw iteration and values. The horizontal coordinate is the 1-based page row
  sequence; charts and CSV remain chronological while the Data view may show
  newest rows first.
- Output tables use virtualized rendering for large pages without discarding
  rows needed by charts or exports. Page summaries expose Count, Min, Max, and
  Avg calculated from committed rows.

Desktop run commands expose the same WorkflowRunResult data through their
Tauri DTO boundary. Tauri Channels carry StepCompleted and
ResultRowCommitted events to the Desktop while the run is active; the
authoritative result remains the completed Core data.

CSV streaming and XLSX serialization are contract-level behaviors documented
in [Template Schema v1](../contracts/template-schema-v1.md). The key
architecture rule is that both batch and streaming export consume committed
ResultRow data rather than re-evaluating the Workflow or reading presentation
state.
