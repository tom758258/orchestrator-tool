//! Shared core for orchestrator-tool.
//!
//! The core is intentionally independent of CLI and desktop presentation
//! layers so both can reuse the same orchestration behavior.

pub mod config;
pub mod discovery;
pub mod inspection;
pub mod manifest;
pub mod manifest_probe;
pub mod process;
pub mod status;
pub mod tool;
pub mod worker;
pub mod worker_http;

/// Product name shared by application frontends.
pub const PRODUCT_NAME: &str = "orchestrator-tool";

/// Package version shared by application frontends.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
