#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use orchestrator_tool::{
    config::Config,
    discovery::{ExecutableStatus, current_application_dir},
    status::{ManifestStatus, inspect_built_in_tool_statuses},
};
use serde::Serialize;

#[derive(Serialize)]
struct ToolStatusDto {
    tool_id: String,
    path: Option<String>,
    source: Option<String>,
    executable_status: String,
    compatibility: String,
    tool_version: Option<String>,
    worker_schema_versions: Vec<u32>,
    reason: Option<String>,
}

#[tauri::command]
async fn get_tool_status() -> Result<Vec<ToolStatusDto>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let application_dir = current_application_dir().map_err(|error| error.to_string())?;
        let statuses = inspect_built_in_tool_statuses(application_dir, &Config::default());

        let dtos = statuses
            .iter()
            .map(|status| {
                let (path, source, executable_status, reason) = match status.executable() {
                    Ok(inspection) => (
                        Some(inspection.resolved().path().display().to_string()),
                        Some(match inspection.resolved().source() {
                            orchestrator_tool::discovery::ExecutablePathSource::Configured => {
                                "configured".to_owned()
                            }
                            orchestrator_tool::discovery::ExecutablePathSource::Portable => {
                                "portable".to_owned()
                            }
                        }),
                        match inspection.status() {
                            ExecutableStatus::Available => "available".to_owned(),
                            ExecutableStatus::Missing => "missing".to_owned(),
                            ExecutableStatus::NotFile => "not-file".to_owned(),
                        },
                        None,
                    ),
                    Err(error) => (None, None, "error".to_owned(), Some(error.to_string())),
                };

                let (compatibility, tool_version, worker_schema_versions, manifest_reason) =
                    match status.manifest() {
                        ManifestStatus::NotProbed => {
                            ("not-probed".to_owned(), None, Vec::new(), None)
                        }
                        ManifestStatus::Probed(probe) => {
                            let compat = match probe.manifest().worker_compatibility() {
                                orchestrator_tool::manifest::WorkerCompatibility::Compatible => {
                                    "compatible".to_owned()
                                }
                                orchestrator_tool::manifest::WorkerCompatibility::Incompatible => {
                                    "incompatible".to_owned()
                                }
                            };
                            (
                                compat,
                                Some(probe.manifest().tool_version().to_owned()),
                                probe
                                    .manifest()
                                    .worker_protocol()
                                    .schema_versions()
                                    .to_vec(),
                                None,
                            )
                        }
                        ManifestStatus::Error(error) => {
                            ("error".to_owned(), None, Vec::new(), Some(error.to_string()))
                        }
                    };

                let final_reason = reason.or(manifest_reason);

                ToolStatusDto {
                    tool_id: status.tool_id().as_str().to_owned(),
                    path,
                    source,
                    executable_status,
                    compatibility,
                    tool_version,
                    worker_schema_versions,
                    reason: final_reason,
                }
            })
            .collect();

        Ok::<Vec<ToolStatusDto>, String>(dtos)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_tool_status])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
