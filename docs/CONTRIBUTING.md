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
    npm.cmd test
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

Follow [Testing Guidelines](testing-guidelines.md) for test ownership, focused
coverage, UI/IPC checks, real external Worker Simulation, safety cases and
evidence reporting. Use the relevant development commands above; the baseline
commands and testing constraints in [AGENTS.md](../AGENTS.md) remain
authoritative. Default tests must not require real instruments.

## Live hardware and safety-sensitive changes

Follow the hardware and cleanup boundaries in
[Testing Guidelines](testing-guidelines.md). Changes involving Live execution,
power-output control or Worker shutdown must document any operator
authorization, hardware assumptions and actual validation in the pull request.
Do not change runtime semantics or external-tool contracts as a side effect of
documentation or refactoring.

## Documentation expectations

Official documentation should describe actual project behavior, architecture,
and maintenance requirements. Omit unnecessary conversation history, informal
design references, and temporary decisions.

The root README files are project entry points. Keep them concise and link
durable details to focused documentation:

- [Architecture Overview](architecture/overview.md)
- [External Tool Boundary](architecture/external-tool-boundary.md)
- [Template Format](contracts/template-schema.md)

Keep English engineering documents as the canonical focused source unless a
translation is explicitly requested. The Desktop User Guide is an
operator-facing bilingual document: update `desktop/USER_GUIDE.md` and
`desktop/USER_GUIDE.zh-TW.md` together whenever documented operator behavior
changes, and keep their user-facing semantics aligned. Keep tracked
documentation durable: omit temporary review notes, run-specific evidence,
local paths, private hardware identifiers, and transient validation output.
Generated Help must come from maintained canonical sources. Do not edit the
generated runtime bundle by hand; regenerate it after changing either User
Guide, another Help content source, the template, or CSS, and keep the tracked
bundle synchronized with those sources.

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
- [ ] Desktop User Guide changes are semantically synchronized between English
      and Traditional Chinese, and the tracked Help bundle is regenerated.
- [ ] The diff contains no transient validation evidence, private resource
      identifiers, hand-edited generated Help output, or unrelated refactor.
- [ ] The PR summary states what was tested and what was not run.
