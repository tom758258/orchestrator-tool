# Contributing to Orchestrator Tool

This document is guidance for human contributors. Repository rules for agents
are in [AGENTS.md](../AGENTS.md); do not treat this file as a second copy of
those rules.

## Development setup

Orchestrator Tool is Windows-first. Install stable Rust, a current Node.js
environment, and the Microsoft Edge WebView2 Runtime when running the full
Desktop application. The repository already contains the Rust lockfile and
the Desktop frontend package lockfile.

From the repository root, the normal package commands are:

    cargo build --locked
    cargo test --locked
    cargo fmt --all --check
    cargo clippy --locked --all-targets --all-features -- -D warnings

For Desktop frontend work, run from apps/desktop:

    npm.cmd ci
    npm.cmd run typecheck
    npm.cmd run build

Use npm.cmd run tauri dev from apps/desktop when the change needs the complete
Tauri application, including native commands, dialogs, local configuration,
and workflow execution. npm.cmd run dev starts only the Vite frontend.

Desktop Tauri checks run from the repository root:

    cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check
    cargo clippy --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
    cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml

Run the narrowest relevant check first. Report checks that were failed,
skipped, blocked, or not run.

## Component ownership

- **Core** is the root Rust library. It owns workflow and Template semantics,
  validation, execution, configuration, external process and Worker
  lifecycle, result data, and shared adapters.
- **CLI** is the root package's engineering and diagnostic binary. It owns
  command-line presentation for discovery, inspection, and Worker diagnostics;
  it is not required to mirror Desktop workflow authoring.
- **Desktop** is the Tauri application and the primary workflow operation
  interface. Tauri commands should remain thin and delegate domain behavior
  to Core.

Keep Core independent of Tauri, frontend frameworks, TypeScript, and WebView
APIs. Do not move durable ownership between Core, CLI, and Desktop as part of
an unrelated change.

## External Tool boundary

Meters, Powers, Scopes, Wavegen, and other external programs remain separate
projects and distributions. The orchestrator owns shared process,
configuration, manifest/Worker compatibility, and workflow coordination; it
does not duplicate external tools' VISA, SCPI, model, instrument capability,
or instrument safety logic.

Read [External Tool Boundary](architecture/external-tool-boundary.md) before
changing executable paths, Tool Types, Tool Instances, Live Resources,
manifests, Worker lifecycle, or Powers cleanup. Do not guess an evolving
external contract. Changes to an external tool should be made in that
external project and reviewed there.

## Testing expectations

Default tests and validation must not require a real instrument. Prefer Core
unit tests, simulated Workers, temporary configuration files, and deterministic
fixtures. Keep live hardware tests explicit and separate from the default
test commands.

For workflow or Template changes, cover the durable contract that changed:
schema parsing and rejection, stable IDs, lexical scope, loop boundaries,
Output Pages, ResultRow commit behavior, progress events, or export data
conversion. Do not add tests that only lock README wording or heading order.

For Desktop changes, run the relevant frontend checks and, when native
behavior is involved, the Tauri checks or a full Desktop run. For external
process or safety-sensitive changes, also verify failure and cleanup paths.

## Live hardware and safety-sensitive changes

Treat Live execution, power-output writes, Worker shutdown, and cleanup as
safety-sensitive. Before changing them:

- understand the existing bounded shutdown and Powers safe-off sequence;
- keep Simulation and default tests hardware-free;
- preserve the external tool's responsibility for instrument-specific safety;
- test workflow failure, Worker startup failure, graceful Stop, and cleanup
  failure paths where applicable; and
- describe required hardware, operator confirmation, and safety assumptions
  in the pull request.

Do not use a documentation or refactor change as a reason to alter runtime
behavior, setup interpretation, or external-tool contracts.

## Documentation expectations

The root README files are project entry points. Keep them concise and link
durable details to focused documentation:

- [Architecture Overview](architecture/overview.md)
- [External Tool Boundary](architecture/external-tool-boundary.md)
- [Template Schema v1](contracts/template-schema-v1.md)

Keep English engineering documents as the canonical focused source unless a
translation is explicitly requested. Keep tracked documentation durable:
omit temporary review notes, run-specific evidence, local paths, private
hardware identifiers, and transient validation output. Generated Help must
come from maintained canonical sources. Do not edit the generated runtime
bundle by hand; regenerate it after changing Help content, template, or CSS,
and keep the tracked bundle synchronized with those sources.

Update the relevant README or focused document when a public architecture or
contract changes. Do not create placeholder documents, empty documentation
categories, or a documentation framework for a single change.

## Pull request checklist

- [ ] The change stays within the stated Core / CLI / Desktop ownership.
- [ ] External Tool boundary and machine-local configuration behavior remain
      explicit and unchanged unless the PR says otherwise.
- [ ] Relevant Rust, frontend, Tauri, or focused tests/checks were run.
- [ ] No default check requires real hardware.
- [ ] Live or safety-sensitive changes describe cleanup and failure behavior.
- [ ] Public Template/runtime contract changes are documented in the focused
      contract document.
- [ ] README links and terminology remain consistent in English and
      Traditional Chinese entry points.
- [ ] The diff contains no transient validation evidence, private resource
      identifiers, hand-edited generated Help output, or unrelated refactor.
- [ ] The PR summary states what was tested and what was not run.
