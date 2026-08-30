#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use orchestrator_tool::{
    config::Config,
    discovery::{ExecutableStatus, current_application_dir},
    status::{ManifestStatus, inspect_built_in_tool_statuses},
    template::Template,
    workflow::Workflow,
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
                        ManifestStatus::Error(error) => (
                            "error".to_owned(),
                            None,
                            Vec::new(),
                            Some(error.to_string()),
                        ),
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

#[tauri::command]
fn create_workflow_draft() -> Result<String, String> {
    let workflow = Workflow::new(Vec::new()).map_err(|error| error.to_string())?;
    Template::new("Untitled".to_owned(), workflow)
        .to_json_string()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn validate_workflow_draft(template_json: String) -> Result<String, String> {
    Template::from_json_str(&template_json)
        .and_then(|template| template.to_json_string())
        .map_err(|error| error.to_string())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_tool_status,
            create_workflow_draft,
            validate_workflow_draft
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{create_workflow_draft, validate_workflow_draft};
    use orchestrator_tool::template::Template;

    #[test]
    fn create_workflow_draft_returns_restorable_empty_template() {
        let json = create_workflow_draft().unwrap();
        let template = Template::from_json_str(&json).unwrap();

        assert_eq!(template.name(), "Untitled");
        assert!(template.workflow().steps().is_empty());
    }

    #[test]
    fn validate_workflow_draft_rejects_invalid_step_id() {
        let invalid = r#"{
            "schema_version": 1,
            "name": "Invalid",
            "workflow": {
                "steps": [
                    { "type": "wait", "id": "Wait-1", "duration_ms": 1 }
                ]
            }
        }"#;

        let error = validate_workflow_draft(invalid.to_owned()).unwrap_err();

        assert!(
            error.contains("invalid step ID"),
            "unexpected error: {error}"
        );
    }
}
