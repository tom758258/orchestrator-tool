//! Shared core for orchestrator-tool.
//!
//! The core is intentionally independent of CLI and desktop presentation
//! layers so both can reuse the same orchestration behavior.

pub mod adapters;
pub mod config;
pub mod discovery;
pub mod executor;
pub mod inspection;
pub mod manifest;
pub mod manifest_probe;
pub mod process;
pub mod status;
pub mod template;
pub mod tool;
pub mod worker;
pub mod worker_http;
pub mod workflow;

/// Product name shared by application frontends.
pub const PRODUCT_NAME: &str = "orchestrator-tool";

/// Package version shared by application frontends.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
