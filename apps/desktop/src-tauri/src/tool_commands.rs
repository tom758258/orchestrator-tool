use orchestrator_tool::{
    config::VisaBackend,
    discovery::{ExecutablePathSource, ExecutableStatus, current_application_dir},
    live_resources::LiveResourceCandidate,
    run::ExecutionMode,
    status::{ManifestStatus, inspect_built_in_tool_statuses},
    tool_instance::ToolInstanceId,
};
use serde::Serialize;
use tauri::AppHandle;

use super::ActiveRun;
use crate::desktop_config::{load_desktop_config, resolve_built_in_tool_id};

#[tauri::command]
pub(super) async fn read_and_drain_errors(
    app: AppHandle,
    state: tauri::State<'_, ActiveRun>,
    tool_id: String,
    instance_id: String,
    execution_mode: ExecutionMode,
) -> Result<orchestrator_tool::error_queue::ErrorQueueResult, String> {
    state.register_manual()?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let tool = resolve_built_in_tool_id(&tool_id)?;
        let instance = ToolInstanceId::new(instance_id).map_err(|error| error.to_string())?;
        let application_dir = current_application_dir().map_err(|error| error.to_string())?;
        let config = load_desktop_config(&app)?;
        orchestrator_tool::error_queue::read_and_drain_errors(
            &application_dir,
            &config,
            &tool,
            &instance,
            execution_mode,
        )
    })
    .await
    .map_err(|error| error.to_string());
    state.clear();
    result?
}

#[tauri::command]
pub(super) async fn check_meters_error_queue_support(
    app: AppHandle,
    instance_id: String,
    execution_mode: ExecutionMode,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let instance = ToolInstanceId::new(instance_id).map_err(|error| error.to_string())?;
        let application_dir = current_application_dir().map_err(|error| error.to_string())?;
        let config = load_desktop_config(&app)?;
        orchestrator_tool::error_queue::check_meters_error_queue_support(
            &application_dir,
            &config,
            &instance,
            execution_mode,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(super) async fn list_live_resources(
    app: AppHandle,
    tool_id: String,
    backend: VisaBackend,
) -> Result<Vec<LiveResourceCandidate>, String> {
    let tool = resolve_built_in_tool_id(&tool_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let application_dir = current_application_dir().map_err(|error| error.to_string())?;
        let config = load_desktop_config(&app)?;
        orchestrator_tool::live_resources::list_live_resources(
            &application_dir,
            &config,
            &tool,
            backend,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(super) async fn get_meters_capabilities(
    app: AppHandle,
    model: Option<String>,
    execution_mode: ExecutionMode,
) -> Result<orchestrator_tool::adapters::meters::MetersCapabilities, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let application_dir = current_application_dir().map_err(|error| error.to_string())?;
        let config = load_desktop_config(&app)?;
        orchestrator_tool::adapters::meters::get_capabilities(
            &application_dir,
            &config,
            if execution_mode == ExecutionMode::Live {
                model.as_deref()
            } else {
                None
            },
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(super) async fn get_powers_capabilities(
    app: AppHandle,
    model_id: Option<String>,
    execution_mode: ExecutionMode,
) -> Result<orchestrator_tool::adapters::powers::PowersCapabilities, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let application_dir = current_application_dir().map_err(|error| error.to_string())?;
        let config = load_desktop_config(&app)?;
        orchestrator_tool::adapters::powers::get_capabilities_for_mode(
            &application_dir,
            &config,
            execution_mode,
            model_id.as_deref(),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(super) async fn get_scopes_capabilities(
    app: AppHandle,
    model_id: Option<String>,
    execution_mode: ExecutionMode,
) -> Result<orchestrator_tool::adapters::scopes::ScopesCapabilities, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let application_dir = current_application_dir().map_err(|error| error.to_string())?;
        let config = load_desktop_config(&app)?;
        orchestrator_tool::adapters::scopes::get_capabilities_for_mode(
            &application_dir,
            &config,
            execution_mode,
            model_id.as_deref(),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Serialize)]
pub(super) struct ToolStatusDto {
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
pub(super) async fn get_tool_status(app: AppHandle) -> Result<Vec<ToolStatusDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let application_dir = current_application_dir().map_err(|error| error.to_string())?;
        let config = load_desktop_config(&app)?;
        let statuses = inspect_built_in_tool_statuses(application_dir, &config);

        let dtos = statuses
            .iter()
            .map(|status| {
                let (path, source, executable_status, reason) = match status.executable() {
                    Ok(inspection) => (
                        inspection
                            .resolved()
                            .path()
                            .map(|path| path.display().to_string()),
                        Some(match inspection.resolved().source() {
                            ExecutablePathSource::Configured => "configured".to_owned(),
                            ExecutablePathSource::NotConfigured => "not-configured".to_owned(),
                        }),
                        match inspection.status() {
                            ExecutableStatus::NotConfigured => "not-configured".to_owned(),
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
