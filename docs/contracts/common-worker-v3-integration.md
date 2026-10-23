# Common Worker v3 — Orchestrator integration

This document describes **Orchestrator ownership only**. The normative Common
Worker v3.0 protocol, JSONL, optional streaming and workflow contracts remain
the four `docs/contracts/common-*.md` documents in the pinned
[meters-tool Common v3.0 revision](https://github.com/tom758258/meters-tool/tree/56024a92ff34f957b5e35c10cf08605c9f08cc2d/docs/contracts).
This file does not change or replace those contracts.

## Compatibility

- Manifest schema stays **2**; the launched Worker HTTP and JSONL schema is **3**.
- A selected executable must pass `manifest --json` before orchestration.
  Worker compatibility is `v3-only`; no v2 execution path or package-version inference.
- Execution model, startup/per-command binding, known Common feature contract
  versions and required command kinds are checked before submission.
- Runtime `ready.features`, not the Manifest alone, determines features adopted
  by this Worker session. Status snapshots must agree with the validated
  `run_id`, endpoint origin, and Runtime feature adoption.
- Current Workflow-domain adapters are Meters, Powers and Scopes. Common v3
  protocol parsing is deliberately independent of tool IDs; Serial and Wavegen
  need no new domain Workflow actions as part of this migration.

## Responsibility split

| Common session and protocol | Existing thin adapter |
| --- | --- |
| Ready, HTTP status/command/stop envelopes, no proxy/redirect, loopback origin and run identity | Tool-specific launch arguments and hardware context |
| Common JSONL events, fatal/error/snapshot semantics | Domain command arguments, result interpretation, artifact checks |
| One in-memory async Job Tracker per Worker session | Existing device safety authorization, cleanup and output policy |
| Job completion vs Worker summary/EOF/exit evidence | Workflow success criteria and existing safety cleanup |

The tracker registers a unique client `job_id` **before** HTTP submission;
it links Accepted to `worker_job_id` and complete JSONL or HTTP snapshot
terminal evidence without resubmitting commands. Duplicate terminals do not
advance the state. Contradictory evidence is retained and must not be
reported as a successful Workflow. A confirmed Job result remains intact
when subsequent Worker shutdown or cleanup fails. No persistent history,
replay system, generic queue, VISA session, acquisition or generic cleanup is
introduced.

Meters remains `run_bound` without Common async Jobs. Optional streaming
is an explicit runtime opt-in only. When a Workflow depends on source
readiness, it observes `stream.state: active` without introducing a
new stream-start command, acquisition, or instrument query. Ready alone
is not source readiness.

When the selected Worker uses `--control-port 0`, a lost Ready record
does not reveal a trustworthy endpoint. Never guess or scan for ports; use
Status fallback only if a validated endpoint was already known through an
existing trusted path. Stop HTTP 200/202 means accepted, **not** that
cleanup or Worker shutdown has completed.

## No-hardware acceptance

Validate the Common owning-layer contracts first, then fake Worker/HTTP
concurrency and failure paths, followed by **explicitly enabled** real Tool
subprocess SIM for existing integrations. Standard `cargo test` alone does
not cover ignored real-executable tests. Respect the repository's
`AGENTS.md` Core checks and report missing binaries, skipped tests or
packaged smoke separately as **unverified**, not passing. Protocol-only
changes do not trigger hardware LIVE scripts.
