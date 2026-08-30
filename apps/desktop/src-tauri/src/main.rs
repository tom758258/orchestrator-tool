#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{collections::HashMap, path::Path, time::Duration};

use orchestrator_tool::{
    adapters::{meters, powers},
    config::Config,
    discovery::{ExecutableStatus, built_in_tool_definitions, current_application_dir},
    inspection::inspect_tool,
    manifest::WorkerCompatibility,
    manifest_probe::probe_manifest,
    run::run_simulated_workflow,
    status::{ManifestStatus, inspect_built_in_tool_statuses},
    template::Template,
    tool::ToolId,
    worker::WorkerLaunchSpec,
    workflow::{StepKind, StepOutcome, StepResult, Workflow},
};
use serde::Serialize;
use serde_json::Value;

const RUN_STARTUP_TIMEOUT: Duration = Duration::from_secs(10);
const RUN_ACTION_TIMEOUT: Duration = Duration::from_secs(10);
const RUN_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

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

#[derive(Debug, Serialize)]
struct StepResultDto {
    step_id: String,
    status: String,
    output: Option<Value>,
    message: Option<String>,
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
async fn run_workflow_simulation(template_json: String) -> Result<Vec<StepResultDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let template =
            Template::from_json_str(&template_json).map_err(|error| error.to_string())?;
        let application_dir = current_application_dir()
            .map_err(|error| format!("could not determine application directory: {error}"))?;
        let launch_specs = prepare_simulate_launch_specs(
            template.workflow(),
            &application_dir,
            &Config::default(),
        )?;
        let results = run_simulated_workflow(
            template.workflow(),
            &launch_specs,
            RUN_STARTUP_TIMEOUT,
            RUN_ACTION_TIMEOUT,
            RUN_SHUTDOWN_TIMEOUT,
        )
        .map_err(|error| error.to_string())?;

        Ok(results.iter().map(step_result_dto).collect())
    })
    .await
    .map_err(|error| error.to_string())?
}

fn referenced_simulation_tools(workflow: &Workflow) -> Vec<ToolId> {
    let mut tools = Vec::new();

    for step in workflow.steps() {
        let StepKind::ToolAction { tool, .. } = step.kind() else {
            continue;
        };
        if matches!(tool.as_str(), "powers" | "meters") && !tools.contains(tool) {
            tools.push(tool.clone());
        }
    }

    tools
}

fn prepare_simulate_launch_specs(
    workflow: &Workflow,
    application_dir: &Path,
    config: &Config,
) -> Result<HashMap<ToolId, WorkerLaunchSpec>, String> {
    let definitions = built_in_tool_definitions();
    let mut launch_specs = HashMap::new();

    for tool in referenced_simulation_tools(workflow) {
        let definition = definitions
            .iter()
            .find(|definition| definition.id() == &tool)
            .expect("supported simulation tool must be built in");
        let inspection = inspect_tool(application_dir, config, definition)
            .map_err(|error| format!("{tool} executable inspection failed: {error}"))?;

        match inspection.status() {
            ExecutableStatus::Available => {}
            ExecutableStatus::Missing => {
                return Err(format!(
                    "{tool} executable is missing: {}",
                    inspection.resolved().path().display()
                ));
            }
            ExecutableStatus::NotFile => {
                return Err(format!(
                    "{tool} executable is not a file: {}",
                    inspection.resolved().path().display()
                ));
            }
        }

        let executable = inspection.resolved().path();
        let probe = probe_manifest(executable, &tool)
            .map_err(|error| format!("{tool} manifest probe failed: {error}"))?;
        if probe.manifest().worker_compatibility() != WorkerCompatibility::Compatible {
            return Err(format!("{tool} Worker protocol is incompatible"));
        }

        let spec = match tool.as_str() {
            "powers" => powers::simulate_worker_launch_spec(executable),
            "meters" => meters::simulate_worker_launch_spec(executable),
            _ => unreachable!("referenced simulation tools are filtered"),
        };
        launch_specs.insert(tool, spec);
    }

    Ok(launch_specs)
}

fn step_result_dto(result: &StepResult) -> StepResultDto {
    let (status, output, message) = match result.outcome() {
        StepOutcome::Succeeded { output } => ("succeeded".to_owned(), Some(output.clone()), None),
        StepOutcome::Failed { message } => ("failed".to_owned(), None, Some(message.clone())),
        StepOutcome::Cancelled => ("cancelled".to_owned(), None, None),
    };

    StepResultDto {
        step_id: result.step_id().as_str().to_owned(),
        status,
        output,
        message,
    }
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

#[tauri::command]
fn save_workflow_template(path: String, template_json: String) -> Result<String, String> {
    let template = Template::from_json_str(&template_json).map_err(|error| error.to_string())?;
    template
        .save_to_file(&path)
        .map_err(|error| error.to_string())?;
    template.to_json_string().map_err(|error| error.to_string())
}

#[tauri::command]
fn load_workflow_template(path: String) -> Result<String, String> {
    let template = Template::load_from_file(&path).map_err(|error| error.to_string())?;
    template.to_json_string().map_err(|error| error.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_tool_status,
            run_workflow_simulation,
            create_workflow_draft,
            validate_workflow_draft,
            save_workflow_template,
            load_workflow_template
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{
        create_workflow_draft, load_workflow_template, referenced_simulation_tools,
        save_workflow_template, step_result_dto, validate_workflow_draft,
    };
    use orchestrator_tool::{
        template::Template,
        tool::ToolId,
        workflow::{StepId, StepOutcome, StepResult},
    };
    use serde_json::json;

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

    #[test]
    fn save_and_load_workflow_template_round_trip() {
        use std::{
            fs, process,
            sync::atomic::{AtomicU64, Ordering},
            time::{SystemTime, UNIX_EPOCH},
        };

        static NEXT_ID: AtomicU64 = AtomicU64::new(0);

        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis();
        let dir = std::env::temp_dir().join(format!(
            "orchestrator-tool-desktop-test-{}-{timestamp}-{id}",
            process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("template.json");

        let template_json = r#"{
            "schema_version": 1,
            "name": "Round Trip",
            "workflow": {
                "steps": [
                    { "type": "tool-action", "id": "power-set-1", "tool": "powers", "action": "set-voltage", "arguments": { "channel": 1, "voltage": 5.0 } },
                    { "type": "wait", "id": "wait-1", "duration_ms": 500 }
                ]
            }
        }"#;

        let saved_canonical =
            save_workflow_template(path.display().to_string(), template_json.to_owned()).unwrap();

        let loaded_canonical = load_workflow_template(path.display().to_string()).unwrap();

        assert_eq!(saved_canonical, loaded_canonical);

        let template = Template::from_json_str(&loaded_canonical).unwrap();
        assert_eq!(template.name(), "Round Trip");
        assert_eq!(template.workflow().steps().len(), 2);
        assert_eq!(template.workflow().steps()[0].id().as_str(), "power-set-1");
        assert_eq!(template.workflow().steps()[1].id().as_str(), "wait-1");

        let _ = fs::remove_file(&path);
        let _ = fs::remove_dir(&dir);
    }

    #[test]
    fn step_result_dto_preserves_outcome_data() {
        let succeeded = step_result_dto(&StepResult::new(
            StepId::new("meter-read-1").unwrap(),
            StepOutcome::Succeeded {
                output: json!({"event": "sample", "value": 3.3, "unit": "V"}),
            },
        ));
        assert_eq!(succeeded.step_id, "meter-read-1");
        assert_eq!(succeeded.status, "succeeded");
        assert_eq!(succeeded.output.as_ref().unwrap()["value"], 3.3);
        assert_eq!(succeeded.output.as_ref().unwrap()["unit"], "V");
        assert!(succeeded.message.is_none());

        let failed = step_result_dto(&StepResult::new(
            StepId::new("meter-read-2").unwrap(),
            StepOutcome::Failed {
                message: "measurement failed".to_owned(),
            },
        ));
        assert_eq!(failed.status, "failed");
        assert_eq!(failed.message.as_deref(), Some("measurement failed"));
        assert!(failed.output.is_none());

        let cancelled = step_result_dto(&StepResult::new(
            StepId::new("wait-1").unwrap(),
            StepOutcome::Cancelled,
        ));
        assert_eq!(cancelled.status, "cancelled");
        assert!(cancelled.output.is_none());
        assert!(cancelled.message.is_none());
    }

    #[test]
    fn referenced_simulation_tools_only_selects_used_supported_tools() {
        let template = Template::from_json_str(
            r#"{
                "schema_version": 1,
                "name": "Meters Only",
                "workflow": {
                    "steps": [
                        { "type": "wait", "id": "wait-1", "duration_ms": 1 },
                        { "type": "tool-action", "id": "meter-read-1", "tool": "meters", "action": "measure", "arguments": {} },
                        { "type": "tool-action", "id": "scope-read-1", "tool": "scopes", "action": "capture", "arguments": {} },
                        { "type": "tool-action", "id": "meter-read-2", "tool": "meters", "action": "measure", "arguments": {} }
                    ]
                }
            }"#,
        )
        .unwrap();

        assert_eq!(
            referenced_simulation_tools(template.workflow()),
            vec![ToolId::meters()]
        );
    }
}
