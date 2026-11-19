# Orchestrator Tool Desktop

[繁體中文](README.zh-TW.md) | [Desktop User Guide](USER_GUIDE.md) | [Core](../core/README.md) | [Project README](../../README.md)

Desktop is the primary interface for creating Tool Instances, editing Templates and Workflows, running supported Simulation/Live workflows, and viewing or exporting committed results. This README covers development and component boundaries. For controls and step-by-step operation use the [Desktop User Guide](USER_GUIDE.md).

## Implementation and ownership

- `apps/desktop/` contains the React/TypeScript frontend, built with Vite and Tauri 2.
- `apps/desktop/src-tauri/` contains the Tauri Rust application. Its dependency on the root `orchestrator-tool` library delegates shared validation, orchestration and Worker lifecycle to Core.
- The frontend owns UI state, controls, localized presentation, interaction and result views; it does not duplicate Core's Template or Worker execution rules.
- The CLI is a separate diagnostic interface, not the Desktop workflow runner. See [CLI README](../cli/README.md).
- External tool programs are separate installations. Desktop stores machine-local EXE paths and Live Resources separately from portable Templates. See [External Tool Boundary](../architecture/external-tool-boundary.md).

## Development

The project is Windows-first. Install Rust, Node.js/npm and the Tauri prerequisites. On Windows the released Desktop requires the system Microsoft Edge WebView2 Runtime; the application does not install it automatically.

From `apps/desktop`, install frontend dependencies on first setup or after lockfile changes, then launch the complete Desktop:

```powershell
npm.cmd ci
npm.cmd run tauri dev
```

For frontend-only work, `npm.cmd run dev` starts Vite without the Tauri backend and therefore cannot exercise native workflow operations.

Relevant frontend checks from `apps/desktop`:

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
```

The Tauri crate has its own Cargo manifest at `apps/desktop/src-tauri/Cargo.toml`. For changes affecting that layer, run the applicable Tauri checks from the repository root as defined in [AGENTS.md](../../AGENTS.md). Select checks according to [Testing Guidelines](../testing-guidelines.md); do not run unrelated hardware or release validation.

## Help and reference documents

Desktop's English and Traditional Chinese offline Help is generated from [USER_GUIDE.md](USER_GUIDE.md) and [USER_GUIDE.zh-TW.md](USER_GUIDE.zh-TW.md). The canonical sources and regeneration/check procedure are described in [Desktop offline Help](../help/README.md). Do not edit generated Help HTML directly.

For overall run behavior and process boundaries see [Architecture Overview](../architecture/overview.md); for exact Template fields and Workflow semantics see [Template Format](../contracts/template-schema.md). This README is not a second operator manual or contract.
