#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use orchestrator_tool::{
    config::Config,
    discovery::{ExecutablePathSource, ExecutableStatus, current_application_dir},
    inspection::inspect_built_in_tools,
};
use serde::Serialize;

#[derive(Serialize)]
struct ToolStatusDto {
    tool_id: String,
    path: String,
    source: String,
    status: String,
}

#[tauri::command]
fn get_tool_status() -> Result<Vec<ToolStatusDto>, String> {
    let application_dir = current_application_dir().map_err(|error| error.to_string())?;
    let inspections = inspect_built_in_tools(application_dir, &Config::default())
        .map_err(|error| error.to_string())?;

    Ok(inspections
        .iter()
        .map(|inspection| ToolStatusDto {
            tool_id: inspection.resolved().tool_id().as_str().to_owned(),
            path: inspection.resolved().path().display().to_string(),
            source: source_label(inspection.resolved().source()).to_owned(),
            status: status_label(inspection.status()).to_owned(),
        })
        .collect())
}

fn source_label(source: ExecutablePathSource) -> &'static str {
    match source {
        ExecutablePathSource::Configured => "configured",
        ExecutablePathSource::Portable => "portable",
    }
}

fn status_label(status: ExecutableStatus) -> &'static str {
    match status {
        ExecutableStatus::Available => "available",
        ExecutableStatus::Missing => "missing",
        ExecutableStatus::NotFile => "not-file",
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_tool_status])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
