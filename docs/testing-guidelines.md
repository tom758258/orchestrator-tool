# Testing Guidelines

Orchestrator Tool validates workflow coordination and integration with external tools, not instrument drivers. Keep tests proportional to the behavior changed. [AGENTS.md](../AGENTS.md) is authoritative for required development boundaries and baseline commands; [CONTRIBUTING.md](CONTRIBUTING.md) covers contributor workflow. This document explains how to select tests and report their evidence.

## Test ownership

- **Core:** Template parsing and validation, Workflow control and scoping, Binding, tool-instance ownership, Worker lifecycle, Foreground results, Background capture, data quality, Output, export, and safety cleanup.
- **CLI:** Diagnostic command arguments, observable output and exit behavior; it need not reproduce the Desktop Workflow editor.
- **Desktop frontend:** Rendered user controls, editing and Template round trips, visible states and errors. Prefer Vitest/React Testing Library for components and existing Node tests for pure modules. Mock native I/O at the Tauri boundary.
- **Desktop Tauri:** Command/IPC serialization, local resources and Core delegation. Assert serialized IPC contracts in Rust tests; do not duplicate Core business rules in Tauri tests.
- **Tool adapters and Worker integration:** Manifest/capability compatibility, valid requests, replies, failures, Worker start/stop, and actual data flow across Orchestrator boundaries. Test against fakes for deterministic paths; use a real external Tool in Simulation when its executable-specific integration is the risk.
- **External tool repositories:** Own instrument protocols, VISA/SCPI, physical I/O, device-specific safety, and their native mode behavior. Do not copy their test matrices or contract files into Orchestrator.

## Select the smallest useful tests

- Read the changed code and applicable contract first. Test the changed behavior and its directly affected safety or contract boundary, primarily at the owning layer.
- **Template/Workflow:** Verify meaningful acceptance and rejection, Binding and scope rules, loop/Stop behavior, result-row commit semantics, or execution ordering only when those contracts are affected.
- **Worker/adapter:** Cover request/result shape, invalid responses, timeouts, startup failures and cleanup as applicable. A fake Worker proves Orchestrator handling, not compatibility with a particular external executable.
- **Background and export:** Where affected, check Worker/Capture separation, event validation, incomplete data, overflow, ordered shutdown, and export failure; do not assume all tools share a sample format.
- **Desktop/UI:** Test user-visible behavior and stable IPC interfaces. Avoid freezing CSS sizes, markup snapshots, internal variable/function names, source slicing, fake Hook harnesses, noncontractual wording, or incidental rendering order.
- Prefer extending or consolidating existing focused tests. Do not add a permanent regression test for every small fix, require the same contract at every layer, or create an all-tool/all-mode matrix without demonstrated risk.
- Documentation-only changes should receive relevant link, path and command checks. Do not run unrelated instrument or release validation just because a document changed.

## Keep evidence categories separate

| Evidence | What it can establish | What it cannot establish by itself |
| --- | --- | --- |
| Unit and component tests | Logic or UI behavior exercised in the test environment | A real external Tool, Windows WebView2, or physical device works |
| Fake Worker integration | Orchestrator request/response, execution and failure paths | An actual external Tool EXE accepted or produced the same behavior |
| Real external Tool Simulation | Integration with the specified Tool executable and Simulation mode | Real hardware I/O, physical timing, or instrument accuracy |
| Windows Desktop GUI check | User-visible behavior in the particular native application/run | Every platform, Tool mode or hardware operation is verified |
| Real hardware Live check | The explicitly tested device, configuration, action and safety behavior | Other models, modes, equipment or untested failure paths are verified |

- Successful CI establishes only the checks that actually ran for that commit and platform. `#[ignore]` tests and conditional CI steps are **not executed** unless explicitly run.
- A Windows EXE build or uploaded artifact is not a Desktop GUI test or release acceptance. A GUI check with a simulated Tool is not Live hardware validation.
- Do not substitute an earlier Tool/mode test for a new transport, mode, model or behavior whose execution differs.

## Checks, CI and packaging

- Run the narrowest relevant tests first, then applicable Rust, Desktop frontend and Tauri baselines from [AGENTS.md](../AGENTS.md) when practical. Do not maintain a competing command list here.
- `.github/workflows/ci.yml` runs Rust and Desktop checks on Linux and Windows for pull requests and pushes to `main`. Some format and generated Help checks run only on Linux; inspect actual job steps before claiming coverage.
- For changes to Desktop User Guides or Help sources, follow the generated Help discipline in `AGENTS.md`: run the existing `scripts/test_generate_help.py` and `scripts/generate_help.py --check`, and keep the English and Traditional Chinese operator guides semantically aligned when affected. These are not required merely because this engineering guideline changes.
- `scripts/build-all.ps1` and the manually triggered `.github/workflows/build-desktop-windows.yml` build/check the two Windows executables. Use them for relevant packaging changes or release preparation, not routine documentation changes. Build success does not establish GUI, external Worker or hardware success.
- Default tests and CI must remain hardware-free. Real external Worker Simulation and real hardware Live checks are separate, risk-based activities; hardware tests require appropriate equipment, operator authorization and safety assumptions.

## Safety and data integrity

- Changes to Live execution, Powers output control, Worker shutdown, global Stop, or cleanup should examine applicable startup, failure, cancellation and safe-off paths without weakening external tool safety ownership.
- Changes to Background acquisition or CSV/export should preserve observable partial or incomplete results and surface data-quality or flush errors. A clean Worker exit alone does not prove complete capture.
- Do not add direct hardware access to tests, silently change runtime semantics, or create new test infrastructure solely to satisfy a document.

## Report validation precisely

- Record the tested commit/ref, platform, command or manual procedure, relevant executable/mode, and outcome when making validation claims.
- **Passed:** The stated check has verifiable success evidence. **Reported Passed:** A user/developer supplied success evidence that the reviewer did not independently execute. **Reviewed:** Code or tests were inspected without executing that check.
- **Failed:** Executed and failed. **Skipped:** Intentionally or conditionally skipped. **Blocked:** Could not execute due to an unmet prerequisite. **Not Run:** No execution occurred. Do not represent any of these as Passed.
- Distinguish pull-request head CI from a separate post-merge `main` push run; one is not evidence for the other. Identify fake Worker, actual Tool Simulation, Windows GUI and hardware Live individually.
- Summarize the tests that ran and those that did not in the pull request. Keep run-specific evidence and transient test reports out of tracked documentation.

## Review standard

Before requesting review, confirm the changes are in scope, links and commands are valid, ownership and safety rules are unchanged, and applicable checks have been assessed. Prefer a small, maintainable test that protects a real contract over broad tests of incidental implementation details. Do not expand CI jobs or hardware validation without a concrete need.
