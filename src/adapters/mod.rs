//! Tool-specific adapters built on the Common Worker protocol.

pub mod meters;
pub mod powers;
pub mod scopes;

/// Current domain adapter requirements, separate from the Common v3 parser.
/// A new Tool registers its own thin adapter; no Common parser branch changes.
pub fn validate_existing_worker_integration(
    tool: &crate::tool::ToolId,
    manifest: &crate::manifest::ToolManifest,
) -> Result<(), String> {
    let (model, binding, async_jobs) = match tool.as_str() {
        "meters" => ("run_bound", "startup", false),
        "powers" => ("multi_job", "per_command", true),
        "scopes" => ("multi_job", "startup", true),
        other => return Err(format!("no existing domain adapter for {other}")),
    };
    if manifest.execution_model() != Some(model) || manifest.context_binding() != Some(binding) {
        return Err(format!(
            "{} execution model or context binding incompatible",
            tool
        ));
    }
    if async_jobs && manifest.feature("common.async_jobs").is_none() {
        return Err(format!("{} requires common.async_jobs version 1", tool));
    }
    if tool.as_str() == "meters"
        && manifest
            .command_kind("software_trigger")
            .is_some_and(|kind| kind != "control")
    {
        return Err("Meters software_trigger must be a control command".into());
    }
    Ok(())
}
