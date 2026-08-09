# Agent Instructions

These instructions define long-term, repository-specific boundaries for agents working on orchestrator-tool. Keep changes small and avoid building future layers before a concrete requirement exists.

## 1. Project Context

- Read the affected code and relevant documentation before changing behavior.
- Keep the product structure as Core / CLI / Desktop unless the user explicitly approves an architecture change.
- The Desktop application is expected to use Tauri 2, but Tauri is a presentation/application layer rather than the orchestration core.
- The CLI is an engineering and diagnostic interface. It is not required to mirror advanced Desktop workflow-building features.

## 2. Architecture Boundaries

- The root `orchestrator-tool` Cargo package contains the Core library in `src/lib.rs` and the CLI binary in `src/main.rs`.
- The CLI may depend on Core. Core must not contain CLI-specific behavior.
- The future Desktop/Tauri application may depend on Core. Core must not depend on Tauri, frontend frameworks, TypeScript, or WebView APIs.
- Keep Tauri commands thin. Tool discovery, process management, workflow validation, scheduling, template semantics, and instrument adapters belong in Core when those features are introduced.
- Do not introduce WebUI, an HTTP server, VISA/SCPI control, embedded Python, instrument contracts, IPC schemas, workflow schemas, or plugin systems without a concrete requirement.

## 3. External Tool Boundary

- Instrument programs such as meters-tool, powers-tool, scopes-tool, and wavegen-tool remain external tools. The orchestrator must not duplicate their instrument-specific VISA, SCPI, model, or safety logic.
- Keep tool identity separate from tool-specific adapters and contracts so additional external tools can be added later without redesigning shared process and registry infrastructure.
- Do not guess or prematurely define external tool contracts while those contracts are still evolving.

## 4. Platform And Packaging

- Development and deployment are Windows-first, but use Rust path and process abstractions that do not unnecessarily hard-code Windows behavior in Core.
- Do not add a pinned Rust toolchain, minimum Rust version, Tauri dependencies, async runtime, serialization framework, or other dependency until the implementation needs it.
- Keep Core and CLI in the same Cargo package unless a real component boundary requires another package.

## 5. Testing And Validation

- Default tests and validation must not require real instruments.
- Run the narrowest relevant checks first, then the package checks when practical.
- Repository baseline checks are:
  - `cargo fmt --all --check`
  - `cargo clippy --locked --all-targets --all-features -- -D warnings`
  - `cargo test --locked`
  - `cargo build --locked`
- Report failed, skipped, blocked, or unexecuted verification steps rather than implying they passed.

## 6. Scope Control

- Prefer the smallest implementation that establishes the current requirement.
- Do not implement future phases opportunistically.
- Ask for user confirmation before changing durable component ownership, contract boundaries, workflow/template semantics, external process lifecycle semantics, or distribution strategy.
