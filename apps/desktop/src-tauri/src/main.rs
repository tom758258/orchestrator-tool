#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use orchestrator_tool::{
    config::{Config, ConfigError, ResourceIdentity},
    discovery::{ExecutableStatus, built_in_tool_definitions, current_application_dir},
    live_resources::LiveResourceCandidate,
    run::{ExecutionMode, run_workflow_with_loop_stop},
    run_preparation::{prepare_worker_launch_specs, validate_confirmed_live_resources},
    status::{ManifestStatus, inspect_built_in_tool_statuses},
    template::Template,
    tool::ToolId,
    tool_instance::ToolInstanceId,
    worker::WorkerLaunchSpec,
    workflow::{
        ForIteration, ResultRow, StepExecution, StepId, StepOutcome, StepResult, WhileIteration,
        Workflow, WorkflowOutput, WorkflowRunEvent, WorkflowRunResult,
    },
    workflow_csv::serialize_result_rows_csv,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, ipc::Channel};

const RUN_STARTUP_TIMEOUT: Duration = Duration::from_secs(10);
const RUN_ACTION_TIMEOUT: Duration = Duration::from_secs(10);
const RUN_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);
const DESKTOP_CONFIG_FILENAME: &str = "orchestrator.toml";

#[derive(Default)]
struct ActiveRun(Mutex<Option<Arc<Mutex<Option<String>>>>>);

impl ActiveRun {
    fn register(&self) -> Result<Arc<Mutex<Option<String>>>, String> {
        let mut active = self.0.lock().unwrap();
        if active.is_some() {
            return Err("A workflow run is already active".to_owned());
        }
        let control = Arc::new(Mutex::new(None));
        *active = Some(control.clone());
        Ok(control)
    }

    fn clear(&self) {
        *self.0.lock().unwrap() = None;
    }

    fn request(&self, loop_step_id: String) -> bool {
        let active = self.0.lock().unwrap();
        let Some(control) = active.as_ref() else {
            return false;
        };
        *control.lock().unwrap() = Some(loop_step_id);
        true
    }
}

fn consume_loop_stop(control: &Mutex<Option<String>>, step_id: &StepId) -> bool {
    let mut target = control.lock().unwrap();
    if target.as_deref() == Some(step_id.as_str()) {
        target.take();
        true
    } else {
        false
    }
}

#[tauri::command]
fn request_workflow_stop(state: tauri::State<'_, ActiveRun>, loop_step_id: String) -> bool {
    state.request(loop_step_id)
}

#[tauri::command]
async fn list_live_resources(
    app: AppHandle,
    tool_id: String,
) -> Result<Vec<LiveResourceCandidate>, String> {
    let tool = resolve_built_in_tool_id(&tool_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let application_dir = current_application_dir().map_err(|error| error.to_string())?;
        let config = load_desktop_config(&app)?;
        orchestrator_tool::live_resources::list_live_resources(&application_dir, &config, &tool)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn get_meters_range_options(
    app: AppHandle,
    model: Option<String>,
) -> Result<Vec<orchestrator_tool::adapters::meters::MetersRangeOptions>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let application_dir = current_application_dir().map_err(|error| error.to_string())?;
        let config = load_desktop_config(&app)?;
        orchestrator_tool::adapters::meters::get_range_options(
            &application_dir,
            &config,
            model.as_deref(),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

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

#[derive(Debug, Deserialize, Serialize)]
struct StepExecutionDto {
    step_id: String,
    status: String,
    output: Option<Value>,
    message: Option<String>,
    for_iteration: Option<ForIterationDto>,
    while_iteration: Option<WhileIterationDto>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum WorkflowRunEventDto {
    StepCompleted { execution: StepExecutionDto },
    ResultRowCommitted { row: ResultRowDto },
}

#[derive(Debug, Deserialize, Serialize)]
struct WorkflowRunResultDto {
    step_executions: Vec<StepExecutionDto>,
    result_rows: Vec<ResultRowDto>,
}

#[derive(Debug, Deserialize, Serialize)]
struct ForIterationDto {
    for_step_id: String,
    iteration_index: usize,
}

#[derive(Debug, Deserialize, Serialize)]
struct WhileIterationDto {
    while_step_id: String,
    iteration_index: usize,
}

#[derive(Debug, Deserialize, Serialize)]
struct ResultRowDto {
    outputs: Vec<WorkflowOutputDto>,
    for_iteration: Option<ForIterationDto>,
    while_iteration: Option<WhileIterationDto>,
}

#[derive(Debug, Deserialize, Serialize)]
struct WorkflowOutputDto {
    name: String,
    value: Value,
}

#[tauri::command]
async fn get_tool_status(app: AppHandle) -> Result<Vec<ToolStatusDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let application_dir = current_application_dir().map_err(|error| error.to_string())?;
        let config = load_desktop_config(&app)?;
        let statuses = inspect_built_in_tool_statuses(application_dir, &config);

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
async fn run_workflow_simulation(
    app: AppHandle,
    state: tauri::State<'_, ActiveRun>,
    template_json: String,
    on_progress: Channel<WorkflowRunEventDto>,
) -> Result<WorkflowRunResultDto, String> {
    let control = state.register()?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let template =
            Template::from_json_str(&template_json).map_err(|error| error.to_string())?;
        let application_dir = current_application_dir()
            .map_err(|error| format!("could not determine application directory: {error}"))?;
        let config = load_desktop_config(&app)?;
        let launch_specs = prepare_worker_launch_specs(
            &template,
            ExecutionMode::Simulate,
            &application_dir,
            &config,
        )?;
        let results = run_workflow_with_loop_stop(
            &template,
            ExecutionMode::Simulate,
            &launch_specs,
            RUN_STARTUP_TIMEOUT,
            RUN_ACTION_TIMEOUT,
            RUN_SHUTDOWN_TIMEOUT,
            |event| {
                let _ = on_progress.send(workflow_run_event_dto(&event));
            },
            |step_id| consume_loop_stop(&control, step_id),
        )
        .map_err(|error| error.to_string())?;

        Ok(workflow_run_result_dto(&results))
    })
    .await
    .map_err(|error| error.to_string());
    state.clear();
    result?
}

#[tauri::command]
async fn run_workflow_live(
    app: AppHandle,
    state: tauri::State<'_, ActiveRun>,
    template_json: String,
    confirmed_resources: HashMap<String, String>,
    on_progress: Channel<WorkflowRunEventDto>,
) -> Result<WorkflowRunResultDto, String> {
    let control = state.register()?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let template =
            Template::from_json_str(&template_json).map_err(|error| error.to_string())?;
        let application_dir = current_application_dir().map_err(|error| error.to_string())?;
        let config = load_desktop_config(&app)?;
        validate_confirmed_live_resources(&template, &config, &confirmed_resources)?;
        let mut launch_specs =
            prepare_worker_launch_specs(&template, ExecutionMode::Live, &application_dir, &config)?;
        let mut authorizations = Vec::new();
        for instance in template.referenced_tool_instances() {
            if instance.tool == ToolId::powers() {
                let dir = app
                    .path()
                    .app_cache_dir()
                    .map_err(|error| error.to_string())?;
                let spec = launch_specs
                    .get_mut(&instance.id)
                    .expect("referenced instance was prepared");
                authorizations.push(PowersWriteAuthorization::prepare(&dir, spec)?);
            }
        }
        let results = run_workflow_with_loop_stop(
            &template,
            ExecutionMode::Live,
            &launch_specs,
            RUN_STARTUP_TIMEOUT,
            RUN_ACTION_TIMEOUT,
            RUN_SHUTDOWN_TIMEOUT,
            |event| {
                let _ = on_progress.send(workflow_run_event_dto(&event));
            },
            |step_id| consume_loop_stop(&control, step_id),
        )
        .map_err(|error| error.to_string())?;
        Ok(workflow_run_result_dto(&results))
    })
    .await
    .map_err(|error| error.to_string());
    state.clear();
    result?
}

struct PowersWriteAuthorization(PathBuf);

impl PowersWriteAuthorization {
    fn prepare(dir: &Path, spec: &mut WorkerLaunchSpec) -> Result<Self, String> {
        use std::{
            fs::{self, OpenOptions},
            io::Write,
            sync::atomic::{AtomicU64, Ordering},
        };
        static NEXT_ID: AtomicU64 = AtomicU64::new(0);
        fs::create_dir_all(dir).map_err(|error| error.to_string())?;
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_nanos();
        let path = dir.join(format!(
            "powers-write-{}-{timestamp}-{}.json",
            std::process::id(),
            NEXT_ID.fetch_add(1, Ordering::Relaxed)
        ));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|error| format!("could not create Powers write authorization: {error}"))?;
        let authorization = Self(path);
        let written = file.write_all(br#"{"settings":{"allow_output_writes":true}}"#);
        drop(file);
        written.map_err(|error| format!("could not write Powers authorization: {error}"))?;
        let mut arguments = spec.arguments().to_vec();
        arguments.push("--config".into());
        arguments.push(authorization.0.as_os_str().to_owned());
        *spec = WorkerLaunchSpec::new(spec.executable(), arguments);
        Ok(authorization)
    }
}

impl Drop for PowersWriteAuthorization {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Returns the persisted Desktop configuration file path.
fn desktop_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("could not determine application config directory: {error}"))?;

    Ok(dir.join(DESKTOP_CONFIG_FILENAME))
}

/// Loads the persisted Desktop configuration.
///
/// A missing file falls back to portable behavior; any other load failure is
/// reported instead of being silently ignored.
fn load_desktop_config(app: &AppHandle) -> Result<Config, String> {
    let path = desktop_config_path(app)?;

    load_desktop_config_from_path(&path)
}

fn load_desktop_config_from_path(path: &Path) -> Result<Config, String> {
    match Config::load(path) {
        Ok(config) => Ok(config),
        Err(ConfigError::Read { source, .. }) if source.kind() == std::io::ErrorKind::NotFound => {
            Ok(Config::default())
        }
        Err(error) => Err(error.to_string()),
    }
}

/// Validates a caller-supplied tool ID against the built-in registry.
fn resolve_built_in_tool_id(raw_tool_id: &str) -> Result<ToolId, String> {
    let tool_id = ToolId::new(raw_tool_id)
        .map_err(|error| format!("invalid tool ID {raw_tool_id:?}: {error}"))?;

    if built_in_tool_definitions()
        .iter()
        .any(|definition| definition.id() == &tool_id)
    {
        Ok(tool_id)
    } else {
        Err(format!("unknown tool ID {raw_tool_id:?}"))
    }
}

fn set_desktop_tool_executable(
    config_path: &Path,
    tool_id: &ToolId,
    executable_path: &Path,
) -> Result<(), String> {
    let mut config = load_desktop_config_from_path(config_path)?;
    config.set_executable_path(tool_id, executable_path);
    config.save(config_path).map_err(|error| error.to_string())
}

fn reset_desktop_tool_executable(config_path: &Path, tool_id: &ToolId) -> Result<(), String> {
    let mut config = load_desktop_config_from_path(config_path)?;
    config.remove_executable_path(tool_id);
    config.save(config_path).map_err(|error| error.to_string())
}

#[tauri::command]
fn set_tool_executable(app: AppHandle, tool_id: String, path: String) -> Result<(), String> {
    let tool_id = resolve_built_in_tool_id(&tool_id)?;
    let config_path = desktop_config_path(&app)?;

    set_desktop_tool_executable(&config_path, &tool_id, Path::new(&path))
}

#[tauri::command]
fn reset_tool_executable(app: AppHandle, tool_id: String) -> Result<(), String> {
    let tool_id = resolve_built_in_tool_id(&tool_id)?;
    let config_path = desktop_config_path(&app)?;

    reset_desktop_tool_executable(&config_path, &tool_id)
}

fn edit_desktop_live_resource(
    config_path: &Path,
    raw_instance_id: &str,
    resource: Option<&str>,
    identity: Option<ResourceIdentity>,
) -> Result<(), String> {
    let instance_id = ToolInstanceId::new(raw_instance_id).map_err(|error| error.to_string())?;
    if resource.is_some_and(|value| value.trim().is_empty()) {
        return Err(format!("{instance_id} live resource must not be blank"));
    }
    let mut config = load_desktop_config_from_path(config_path)?;
    match resource {
        Some(value) => config.set_live_resource_with_identity(&instance_id, value, identity),
        None => {
            config.remove_live_resource(&instance_id);
        }
    }
    config.save(config_path).map_err(|error| error.to_string())
}

#[tauri::command]
fn get_live_resources(
    app: AppHandle,
) -> Result<std::collections::BTreeMap<String, String>, String> {
    Ok(load_desktop_config(&app)?.live_resources().clone())
}

#[tauri::command]
fn get_live_resource_identities(
    app: AppHandle,
) -> Result<std::collections::BTreeMap<String, ResourceIdentity>, String> {
    Ok(load_desktop_config(&app)?
        .live_resource_identities()
        .clone())
}

#[tauri::command]
fn set_live_resource(
    app: AppHandle,
    instance_id: String,
    resource: String,
    identity: Option<ResourceIdentity>,
) -> Result<(), String> {
    edit_desktop_live_resource(
        &desktop_config_path(&app)?,
        &instance_id,
        Some(&resource),
        identity,
    )
}

#[tauri::command]
fn remove_live_resource(app: AppHandle, instance_id: String) -> Result<(), String> {
    edit_desktop_live_resource(&desktop_config_path(&app)?, &instance_id, None, None)
}

fn for_iteration_dto(iteration: &ForIteration) -> ForIterationDto {
    ForIterationDto {
        for_step_id: iteration.for_step_id().as_str().to_owned(),
        iteration_index: iteration.iteration_index(),
    }
}

fn while_iteration_dto(iteration: &WhileIteration) -> WhileIterationDto {
    WhileIterationDto {
        while_step_id: iteration.while_step_id().as_str().to_owned(),
        iteration_index: iteration.iteration_index(),
    }
}

fn workflow_run_event_dto(event: &WorkflowRunEvent) -> WorkflowRunEventDto {
    match event {
        WorkflowRunEvent::StepCompleted(execution) => WorkflowRunEventDto::StepCompleted {
            execution: step_execution_dto(execution),
        },
        WorkflowRunEvent::ResultRowCommitted(row) => WorkflowRunEventDto::ResultRowCommitted {
            row: result_row_dto(row),
        },
    }
}

fn workflow_run_result_dto(result: &WorkflowRunResult) -> WorkflowRunResultDto {
    WorkflowRunResultDto {
        step_executions: result
            .step_executions()
            .iter()
            .map(step_execution_dto)
            .collect(),
        result_rows: result.result_rows().iter().map(result_row_dto).collect(),
    }
}

fn result_row_dto(row: &ResultRow) -> ResultRowDto {
    ResultRowDto {
        outputs: row
            .outputs()
            .iter()
            .map(|output| WorkflowOutputDto {
                name: output.name().to_owned(),
                value: output.value().clone(),
            })
            .collect(),
        for_iteration: row.for_iteration().map(for_iteration_dto),
        while_iteration: row.while_iteration().map(while_iteration_dto),
    }
}

fn step_execution_dto(execution: &StepExecution) -> StepExecutionDto {
    let result = execution.result();
    let (status, output, message) = match result.outcome() {
        StepOutcome::Succeeded { output } => ("succeeded".to_owned(), Some(output.clone()), None),
        StepOutcome::Failed { message } => ("failed".to_owned(), None, Some(message.clone())),
        StepOutcome::Cancelled => ("cancelled".to_owned(), None, None),
    };

    StepExecutionDto {
        step_id: result.step_id().as_str().to_owned(),
        status,
        output,
        message,
        for_iteration: execution.for_iteration().map(for_iteration_dto),
        while_iteration: execution.while_iteration().map(while_iteration_dto),
    }
}

impl TryFrom<ForIterationDto> for ForIteration {
    type Error = String;

    fn try_from(dto: ForIterationDto) -> Result<Self, Self::Error> {
        let id = StepId::new(dto.for_step_id).map_err(|error| error.to_string())?;
        Ok(Self::new(id, dto.iteration_index))
    }
}

impl TryFrom<WhileIterationDto> for WhileIteration {
    type Error = String;

    fn try_from(dto: WhileIterationDto) -> Result<Self, Self::Error> {
        let id = StepId::new(dto.while_step_id).map_err(|error| error.to_string())?;
        Ok(Self::new(id, dto.iteration_index))
    }
}

impl TryFrom<ResultRowDto> for ResultRow {
    type Error = String;

    fn try_from(dto: ResultRowDto) -> Result<Self, Self::Error> {
        if dto.for_iteration.is_some() && dto.while_iteration.is_some() {
            return Err("a row cannot have both For and While iteration metadata".to_owned());
        }
        let outputs = dto
            .outputs
            .into_iter()
            .map(|output| WorkflowOutput::new(output.name, output.value))
            .collect();
        Ok(if let Some(iteration) = dto.while_iteration {
            Self::in_while(outputs, iteration.try_into()?)
        } else {
            Self::new(
                outputs,
                dto.for_iteration.map(ForIteration::try_from).transpose()?,
            )
        })
    }
}

impl TryFrom<StepExecutionDto> for StepExecution {
    type Error = String;

    fn try_from(dto: StepExecutionDto) -> Result<Self, Self::Error> {
        let step_id = StepId::new(&dto.step_id)
            .map_err(|error| format!("invalid step ID {:?}: {error}", dto.step_id))?;
        let outcome = match dto.status.as_str() {
            "succeeded" => StepOutcome::Succeeded {
                // Option<Value> deserializes a JSON null output as None.
                output: dto.output.unwrap_or(Value::Null),
            },
            "failed" => StepOutcome::Failed {
                message: dto.message.ok_or_else(|| {
                    format!("failed step {:?} is missing its message", dto.step_id)
                })?,
            },
            "cancelled" => StepOutcome::Cancelled,
            _ => {
                return Err(format!(
                    "unknown result status {:?} for step {:?}",
                    dto.status, dto.step_id
                ));
            }
        };
        if dto.for_iteration.is_some() && dto.while_iteration.is_some() {
            return Err(
                "an execution cannot have both For and While iteration metadata".to_owned(),
            );
        }
        let result = StepResult::new(step_id, outcome);
        Ok(if let Some(iteration) = dto.while_iteration {
            Self::in_while(result, iteration.try_into()?)
        } else {
            Self::new(
                result,
                dto.for_iteration.map(ForIteration::try_from).transpose()?,
            )
        })
    }
}

fn validate_completed_successful_run(
    workflow: &Workflow,
    results: &[StepExecution],
) -> Result<(), String> {
    let all_succeeded = results
        .iter()
        .all(|result| matches!(result.outcome(), StepOutcome::Succeeded { .. }));
    let all_root_steps_completed = workflow.steps().iter().all(|step| {
        results.iter().any(|result| {
            result.for_iteration().is_none()
                && result.while_iteration().is_none()
                && result.step_id() == step.id()
        })
    });
    if !all_succeeded || !all_root_steps_completed {
        return Err(
            "workflow run did not complete successfully; CSV export is unavailable".to_owned(),
        );
    }
    Ok(())
}

#[tauri::command]
fn export_workflow_csv(
    template_json: String,
    run_result: WorkflowRunResultDto,
    destination_path: String,
) -> Result<(), String> {
    let template = Template::from_json_str(&template_json).map_err(|error| error.to_string())?;
    let results = run_result
        .step_executions
        .into_iter()
        .map(StepExecution::try_from)
        .collect::<Result<Vec<_>, _>>()?;
    validate_completed_successful_run(template.workflow(), &results)?;
    let rows = run_result
        .result_rows
        .into_iter()
        .map(ResultRow::try_from)
        .collect::<Result<Vec<_>, _>>()?;
    let csv = serialize_result_rows_csv(&rows).map_err(|error| error.to_string())?;
    if csv.is_empty() {
        return Err("workflow has no outputs available for export".to_owned());
    }
    std::fs::write(&destination_path, csv)
        .map_err(|error| format!("could not write CSV to {destination_path:?}: {error}"))
}

#[tauri::command]
fn create_workflow_draft() -> Result<String, String> {
    let workflow = Workflow::new(Vec::new()).map_err(|error| error.to_string())?;
    Template::new("Untitled".to_owned(), Default::default(), workflow)
        .and_then(|template| template.to_json_string())
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
        .manage(ActiveRun::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_tool_status,
            list_live_resources,
            get_meters_range_options,
            run_workflow_simulation,
            run_workflow_live,
            request_workflow_stop,
            get_live_resources,
            get_live_resource_identities,
            set_live_resource,
            remove_live_resource,
            set_tool_executable,
            reset_tool_executable,
            create_workflow_draft,
            validate_workflow_draft,
            save_workflow_template,
            load_workflow_template,
            export_workflow_csv
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{
        create_workflow_draft, load_desktop_config_from_path, load_workflow_template,
        reset_desktop_tool_executable, resolve_built_in_tool_id, save_workflow_template,
        set_desktop_tool_executable, validate_workflow_draft,
    };
    use orchestrator_tool::{
        template::Template,
        tool::ToolId,
        tool_instance::ToolInstanceId,
        workflow::{
            ForIteration, ResultRow, StepExecution, StepId, StepOutcome, StepResult,
            WorkflowOutput, WorkflowRunEvent, WorkflowRunResult,
        },
    };
    use serde_json::json;

    #[test]
    fn active_run_stop_is_targeted_and_cleared_between_runs() {
        let state = super::ActiveRun::default();
        let a = StepId::new("loop-a").unwrap();
        let b = StepId::new("loop-b").unwrap();
        assert!(!state.request(a.to_string()));
        let control = state.register().unwrap();
        assert!(state.register().is_err());
        assert!(state.request(a.to_string()));
        assert!(!super::consume_loop_stop(&control, &b));
        assert!(super::consume_loop_stop(&control, &a));
        assert!(!super::consume_loop_stop(&control, &a));
        assert!(state.request(a.to_string()));
        state.clear();
        assert!(!state.request(b.to_string()));
        let next = state.register().unwrap();
        assert!(!super::consume_loop_stop(&next, &a));
        assert!(state.request(b.to_string()));
        assert!(super::consume_loop_stop(&next, &b));
        state.clear();
    }

    #[test]
    fn desktop_live_resources_preserve_exact_values_and_reject_blank_edits() {
        let dir = unique_test_dir("orchestrator-live-resource-test");
        let path = dir.join("orchestrator.toml");
        let powers = " USB0::Power Serial::INSTR ";
        let meters = " TCPIP0::MeterHost::inst0::INSTR ";
        super::edit_desktop_live_resource(&path, "powers-1", Some(powers), None).unwrap();
        super::edit_desktop_live_resource(&path, "meters-1", Some(meters), None).unwrap();
        let loaded = load_desktop_config_from_path(&path).unwrap();
        assert_eq!(
            loaded.live_resource(&ToolInstanceId::new("powers-1").unwrap()),
            Some(powers)
        );
        assert_eq!(
            loaded.live_resource(&ToolInstanceId::new("meters-1").unwrap()),
            Some(meters)
        );
        for resource in ["", " ", "\t\r\n"] {
            assert!(
                super::edit_desktop_live_resource(&path, "powers-1", Some(resource), None).is_err()
            );
        }
        for tool in ["", "bad_id", "Uppercase"] {
            assert!(super::edit_desktop_live_resource(&path, tool, Some(powers), None).is_err());
            assert!(super::edit_desktop_live_resource(&path, tool, None, None).is_err());
        }
        super::edit_desktop_live_resource(&path, "powers-1", None, None).unwrap();
        let loaded = load_desktop_config_from_path(&path).unwrap();
        assert_eq!(
            loaded.live_resource(&ToolInstanceId::new("powers-1").unwrap()),
            None
        );
        assert_eq!(
            loaded.live_resource(&ToolInstanceId::new("meters-1").unwrap()),
            Some(meters)
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn powers_live_launch_authorization_is_scoped_to_run() {
        use std::ffi::OsString;
        let dir = unique_test_dir("orchestrator-powers-authorization-test");
        let resource = " USB0::Power Serial::INSTR ";
        let mut spec = orchestrator_tool::adapters::powers::live_worker_launch_spec(
            "powers-tool.exe",
            resource,
        );
        let authorization = super::PowersWriteAuthorization::prepare(&dir, &mut spec).unwrap();
        let path = authorization.0.clone();
        let value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(
            value,
            json!({ "settings": { "allow_output_writes": true } })
        );
        assert_eq!(
            spec.arguments(),
            [
                OsString::from("worker"),
                OsString::from("--mode"),
                OsString::from("live"),
                OsString::from("--resource"),
                OsString::from(resource),
                OsString::from("--control-port"),
                OsString::from("0"),
                OsString::from("--artifact-mode"),
                OsString::from("memory"),
                OsString::from("--config"),
                path.as_os_str().to_owned(),
            ]
        );
        drop(authorization);
        assert!(!path.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

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
            "tool_instances": [],
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
            "tool_instances": [{"id": "powers-1", "tool": "powers", "setup": {}}],
            "name": "Round Trip",
            "workflow": {
                "steps": [
                    { "type": "tool-action", "id": "power-set-1", "target": "powers-1", "action": "set-voltage", "arguments": { "channel": 1, "voltage": 5.0 } },
                    { "type": "wait", "id": "wait-1", "duration_ms": 500 },
                    { "type": "for", "id": "sweep", "variable": "x",
                      "range": { "start": "0", "stop": "0.3", "step": "0.1" },
                      "steps": [{ "type": "output", "id": "sample", "name": "sample",
                                  "value": { "source": "variable", "variable": "x" } }] }
                ]
            }
        }"#;

        let saved_canonical =
            save_workflow_template(path.display().to_string(), template_json.to_owned()).unwrap();

        let loaded_canonical = load_workflow_template(path.display().to_string()).unwrap();

        assert_eq!(saved_canonical, loaded_canonical);

        let template = Template::from_json_str(&loaded_canonical).unwrap();
        assert_eq!(template.name(), "Round Trip");
        assert_eq!(template.workflow().steps().len(), 3);
        assert_eq!(template.workflow().steps()[0].id().as_str(), "power-set-1");
        assert_eq!(template.workflow().steps()[1].id().as_str(), "wait-1");
        let wire: serde_json::Value = serde_json::from_str(&loaded_canonical).unwrap();
        assert_eq!(
            wire["workflow"]["steps"][2]["range"],
            json!({ "start": "0", "stop": "0.3", "step": "0.1" })
        );
        assert_eq!(wire["workflow"]["steps"][2]["steps"][0]["id"], "sample");

        let _ = fs::remove_file(&path);
        let _ = fs::remove_dir(&dir);
    }

    #[test]
    fn export_workflow_csv_writes_completed_results() {
        let template_json = json!({
            "schema_version": 1,
            "tool_instances": [],
            "name": "CSV export",
            "workflow": { "steps": [
                { "type": "output", "id": "voltage", "name": "voltage",
                  "value": { "source": "literal", "value": 0 } },
                { "type": "output", "id": "passed", "name": "passed",
                  "value": { "source": "literal", "value": false } }
            ] }
        })
        .to_string();
        let results = serde_json::from_value(json!({
            "step_executions": [
                { "step_id": "voltage", "status": "succeeded", "output": 5, "for_iteration": null },
                { "step_id": "passed", "status": "succeeded", "output": true, "for_iteration": null }
            ],
            "result_rows": [{ "outputs": [
                { "name": "voltage", "value": 5 }, { "name": "passed", "value": true }
            ], "for_iteration": null }]
        }))
        .unwrap();
        let dir = unique_test_dir("orchestrator-desktop-csv-success");
        let path = dir.join("results.csv");

        super::export_workflow_csv(template_json, results, path.display().to_string()).unwrap();

        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "voltage,passed\n5,true\n"
        );
        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }

    #[test]
    fn export_workflow_csv_rejects_failed_and_incomplete_runs_without_creating_file() {
        let template_json = json!({
            "schema_version": 1,
            "tool_instances": [],
            "name": "Unsuccessful CSV export",
            "workflow": { "steps": [
                { "type": "output", "id": "result", "name": "result",
                  "value": { "source": "literal", "value": 5 } },
                { "type": "assert", "id": "check",
                  "left": { "source": "literal", "value": 1 },
                  "operator": "less-than",
                  "right": { "source": "literal", "value": 0 },
                  "message": "Check failed." }
            ] }
        })
        .to_string();
        let dir = unique_test_dir("orchestrator-desktop-csv-unsuccessful");

        for (case, results) in [
            (
                "failed",
                json!([
                    { "step_id": "result", "status": "succeeded", "output": 5 },
                    { "step_id": "check", "status": "failed", "message": "Check failed." }
                ]),
            ),
            (
                "incomplete",
                json!([
                    { "step_id": "result", "status": "succeeded", "output": 5 }
                ]),
            ),
        ] {
            let path = dir.join(format!("{case}.csv"));
            assert!(!path.exists());
            let error = super::export_workflow_csv(
                template_json.clone(),
                serde_json::from_value(json!({
                    "step_executions": results,
                    "result_rows": [{ "outputs": [{ "name": "result", "value": 5 }], "for_iteration": null }]
                })).unwrap(),
                path.display().to_string(),
            )
            .unwrap_err();

            assert_eq!(
                error,
                "workflow run did not complete successfully; CSV export is unavailable"
            );
            assert!(!path.exists());
        }

        std::fs::remove_dir(dir).unwrap();
    }

    #[test]
    fn export_workflow_csv_without_outputs_does_not_create_file() {
        let template_json = json!({
            "schema_version": 1,
            "tool_instances": [],
            "name": "No outputs",
            "workflow": { "steps": [
                { "type": "wait", "id": "wait-1", "duration_ms": 0 }
            ] }
        })
        .to_string();
        let results = serde_json::from_value(json!({
            "step_executions": [{ "step_id": "wait-1", "status": "succeeded", "output": null, "for_iteration": null }],
            "result_rows": [{ "outputs": [], "for_iteration": null }]
        }))
        .unwrap();
        let dir = unique_test_dir("orchestrator-desktop-csv-no-outputs");
        let path = dir.join("results.csv");
        assert!(!path.exists());

        let error = super::export_workflow_csv(template_json, results, path.display().to_string())
            .unwrap_err();

        assert_eq!(error, "workflow has no outputs available for export");
        assert!(!path.exists());
        std::fs::remove_dir(dir).unwrap();
    }

    #[test]
    fn progress_event_dto_preserves_tags_and_occurrence_metadata() {
        let iteration = ForIteration::new(StepId::new("sweep").unwrap(), 1);
        let execution = StepExecution::new(
            StepResult::new(
                StepId::new("out").unwrap(),
                StepOutcome::Succeeded { output: json!(3) },
            ),
            Some(iteration.clone()),
        );
        let row = ResultRow::new(
            vec![WorkflowOutput::new("value".to_owned(), json!(3))],
            Some(iteration),
        );
        let step_event = serde_json::to_value(super::workflow_run_event_dto(
            &WorkflowRunEvent::StepCompleted(execution),
        ))
        .unwrap();
        let row_event = serde_json::to_value(super::workflow_run_event_dto(
            &WorkflowRunEvent::ResultRowCommitted(row),
        ))
        .unwrap();
        assert_eq!(
            step_event,
            json!({
                "type": "step-completed",
                "execution": { "step_id": "out", "status": "succeeded", "output": 3, "message": null,
                    "for_iteration": { "for_step_id": "sweep", "iteration_index": 1 }, "while_iteration": null }
            })
        );
        assert_eq!(
            row_event,
            json!({
                "type": "result-row-committed",
                "row": { "outputs": [{ "name": "value", "value": 3 }],
                    "for_iteration": { "for_step_id": "sweep", "iteration_index": 1 }, "while_iteration": null }
            })
        );
    }

    #[test]
    fn run_result_dto_preserves_occurrences_rows_and_outcomes() {
        let iteration = ForIteration::new(StepId::new("sweep").unwrap(), 1);
        let run = WorkflowRunResult::new(
            vec![
                StepExecution::new(
                    StepResult::new(
                        StepId::new("measure").unwrap(),
                        StepOutcome::Succeeded {
                            output: json!({"value": 3.3, "unit": "V"}),
                        },
                    ),
                    Some(iteration.clone()),
                ),
                StepExecution::new(
                    StepResult::new(
                        StepId::new("sweep").unwrap(),
                        StepOutcome::Succeeded {
                            output: serde_json::Value::Null,
                        },
                    ),
                    None,
                ),
                StepExecution::new(
                    StepResult::new(
                        StepId::new("check").unwrap(),
                        StepOutcome::Failed {
                            message: "Check failed.".to_owned(),
                        },
                    ),
                    None,
                ),
                StepExecution::new(
                    StepResult::new(StepId::new("wait").unwrap(), StepOutcome::Cancelled),
                    None,
                ),
            ],
            vec![
                ResultRow::new(
                    vec![WorkflowOutput::new("voltage".to_owned(), json!(3.3))],
                    Some(iteration),
                ),
                ResultRow::new(vec![], None),
            ],
        );
        let dto = serde_json::to_value(super::workflow_run_result_dto(&run)).unwrap();
        assert_eq!(dto["step_executions"][0]["step_id"], "measure");
        assert_eq!(
            dto["step_executions"][0]["output"],
            json!({"value": 3.3, "unit": "V"})
        );
        let metadata = json!({"for_step_id": "sweep", "iteration_index": 1});
        assert_eq!(dto["step_executions"][0]["for_iteration"], metadata);
        assert!(dto["step_executions"][1]["for_iteration"].is_null());
        assert_eq!(dto["step_executions"][2]["status"], "failed");
        assert_eq!(dto["step_executions"][2]["message"], "Check failed.");
        assert_eq!(dto["step_executions"][3]["status"], "cancelled");
        assert_eq!(dto["result_rows"][0]["for_iteration"], metadata);
        assert_eq!(
            dto["result_rows"][0]["outputs"],
            json!([{"name": "voltage", "value": 3.3}])
        );
        assert!(dto["result_rows"][1]["for_iteration"].is_null());
    }

    #[test]
    fn export_for_result_rows_requires_successful_completion() {
        let template_json = json!({
            "schema_version": 1, "tool_instances": [], "name": "For CSV",
            "workflow": { "steps": [{
                "type": "for", "id": "sweep", "variable": "x",
                "range": { "start": "0", "stop": "0.2", "step": "0.1" },
                "steps": [
                    { "type": "output", "id": "voltage", "name": "voltage", "value": { "source": "variable", "variable": "x" } },
                    { "type": "output", "id": "passed", "name": "passed", "value": { "source": "literal", "value": true } }
                ]
            }] }
        }).to_string();
        let template = Template::from_json_str(&template_json).unwrap();
        let run = orchestrator_tool::run::run_simulated_workflow(
            &template,
            &Default::default(),
            super::RUN_STARTUP_TIMEOUT,
            super::RUN_ACTION_TIMEOUT,
            super::RUN_SHUTDOWN_TIMEOUT,
        )
        .unwrap();
        let dir = unique_test_dir("orchestrator-desktop-for-csv");
        let path = dir.join("results.csv");
        super::export_workflow_csv(
            template_json.clone(),
            super::workflow_run_result_dto(&run),
            path.display().to_string(),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "voltage,passed\n0.0,true\n0.1,true\n0.2,true\n"
        );
        std::fs::remove_file(&path).unwrap();
        for status in ["failed", "cancelled", "missing-root"] {
            let mut dto = super::workflow_run_result_dto(&run);
            let aggregate = dto.step_executions.last_mut().unwrap();
            if status == "missing-root" {
                aggregate.for_iteration = Some(super::ForIterationDto {
                    for_step_id: "sweep".to_owned(),
                    iteration_index: 0,
                });
            } else {
                aggregate.status = status.to_owned();
                aggregate.message = Some("Run stopped.".to_owned());
            }
            let error =
                super::export_workflow_csv(template_json.clone(), dto, path.display().to_string())
                    .unwrap_err();
            assert!(error.contains("did not complete successfully"));
            assert!(!path.exists());
        }
        std::fs::remove_dir(dir).unwrap();
    }

    #[test]
    fn while_dtos_preserve_occurrences_and_csv_requires_root_completion() {
        let template_json = json!({
            "schema_version": 1, "tool_instances": [], "name": "While CSV",
            "workflow": { "steps": [
                { "type": "set-variable", "id": "init", "variable": "x", "value": { "source": "literal", "value": 0 } },
                { "type": "while", "id": "repeat", "max_iterations": 1,
                  "left": { "source": "variable", "variable": "x" }, "operator": "less-than",
                  "right": { "source": "literal", "value": 1 }, "steps": [
                    { "type": "output", "id": "out", "name": "x", "value": { "source": "variable", "variable": "x" } },
                    { "type": "set-variable", "id": "advance", "variable": "x", "value": { "source": "literal", "value": 1 } }
                  ] }
            ] }
        }).to_string();
        let template = Template::from_json_str(&template_json).unwrap();
        let run = orchestrator_tool::run::run_simulated_workflow(
            &template,
            &Default::default(),
            super::RUN_STARTUP_TIMEOUT,
            super::RUN_ACTION_TIMEOUT,
            super::RUN_SHUTDOWN_TIMEOUT,
        )
        .unwrap();
        let execution = &run.step_executions()[1];
        let row = &run.result_rows()[0];
        assert_eq!(
            StepExecution::try_from(super::step_execution_dto(execution)).unwrap(),
            *execution
        );
        assert_eq!(
            ResultRow::try_from(super::result_row_dto(row)).unwrap(),
            *row
        );
        for (event, field) in [
            (
                WorkflowRunEvent::StepCompleted(execution.clone()),
                "execution",
            ),
            (WorkflowRunEvent::ResultRowCommitted(row.clone()), "row"),
        ] {
            let wire = serde_json::to_value(super::workflow_run_event_dto(&event)).unwrap();
            assert_eq!(
                wire[field]["while_iteration"],
                json!({ "while_step_id": "repeat", "iteration_index": 0 })
            );
            assert!(wire[field]["for_iteration"].is_null());
        }
        let mut ambiguous = super::step_execution_dto(execution);
        ambiguous.for_iteration = Some(super::ForIterationDto {
            for_step_id: "sweep".to_owned(),
            iteration_index: 0,
        });
        assert!(StepExecution::try_from(ambiguous).is_err());
        let mut ambiguous = super::result_row_dto(row);
        ambiguous.for_iteration = Some(super::ForIterationDto {
            for_step_id: "sweep".to_owned(),
            iteration_index: 0,
        });
        assert!(ResultRow::try_from(ambiguous).is_err());
        let dir = unique_test_dir("orchestrator-desktop-while-csv");
        let path = dir.join("results.csv");
        super::export_workflow_csv(
            template_json.clone(),
            super::workflow_run_result_dto(&run),
            path.display().to_string(),
        )
        .unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "x\n0\n");
        std::fs::remove_file(&path).unwrap();
        for missing_root in [false, true] {
            let mut dto = super::workflow_run_result_dto(&run);
            let aggregate = dto.step_executions.last_mut().unwrap();
            if missing_root {
                aggregate.while_iteration = Some(super::WhileIterationDto {
                    while_step_id: "repeat".to_owned(),
                    iteration_index: 0,
                });
            } else {
                aggregate.status = "failed".to_owned();
                aggregate.message =
                    Some("While reached max_iterations while condition is still true".to_owned());
            }
            assert!(
                super::export_workflow_csv(template_json.clone(), dto, path.display().to_string())
                    .unwrap_err()
                    .contains("did not complete successfully")
            );
            assert!(!path.exists());
        }
        std::fs::remove_dir(dir).unwrap();
    }

    #[test]
    fn referenced_tool_instances_only_selects_used_instances() {
        let template = Template::from_json_str(
            r#"{
                "schema_version": 1,
                "tool_instances": [{"id": "meters-1", "tool": "meters", "setup": {
                    "measurement": "voltage-dc", "range_mode": "auto", "manual_range": null,
                    "nplc": 1.0, "auto_zero": "on", "dcv_input_impedance": null,
                    "current_terminal": null
                }}, {"id": "powers-1", "tool": "powers", "setup": {}}, {"id": "scopes-1", "tool": "scopes", "setup": {}}],
                "name": "Referenced instances",
                "workflow": {
                    "steps": [
                        { "type": "wait", "id": "wait-1", "duration_ms": 1 },
                        { "type": "tool-action", "id": "meter-read-1", "target": "meters-1", "action": "measure", "arguments": {} },
                        { "type": "tool-action", "id": "scope-read-1", "target": "scopes-1", "action": "capture", "arguments": {} },
                        { "type": "tool-action", "id": "meter-read-2", "target": "meters-1", "action": "measure", "arguments": {} }
                    ]
                }
            }"#,
        )
        .unwrap();

        assert_eq!(
            template
                .referenced_tool_instances()
                .iter()
                .map(|instance| instance.id.as_str())
                .collect::<Vec<_>>(),
            vec!["meters-1", "scopes-1"]
        );
    }

    fn unique_test_dir(prefix: &str) -> std::path::PathBuf {
        use std::{
            process,
            sync::atomic::{AtomicU64, Ordering},
            time::{SystemTime, UNIX_EPOCH},
        };

        static NEXT_ID: AtomicU64 = AtomicU64::new(0);

        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis();
        let dir = std::env::temp_dir().join(format!("{prefix}-{}-{timestamp}-{id}", process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn desktop_tool_config_set_load_reset_round_trip() {
        let dir = unique_test_dir("orchestrator-tool-desktop-config-test");
        let config_path = dir.join("orchestrator.toml");
        let meters_exe = dir.join("meters-tool.exe");
        let powers_exe = dir.join("powers-tool.exe");

        let config = load_desktop_config_from_path(&config_path).unwrap();
        assert_eq!(config.executable_path(&ToolId::meters()), None);

        set_desktop_tool_executable(&config_path, &ToolId::meters(), &meters_exe).unwrap();
        set_desktop_tool_executable(&config_path, &ToolId::powers(), &powers_exe).unwrap();

        let config = load_desktop_config_from_path(&config_path).unwrap();
        assert_eq!(
            config.executable_path(&ToolId::meters()),
            Some(meters_exe.as_path())
        );
        assert_eq!(
            config.executable_path(&ToolId::powers()),
            Some(powers_exe.as_path())
        );

        reset_desktop_tool_executable(&config_path, &ToolId::meters()).unwrap();

        let config = load_desktop_config_from_path(&config_path).unwrap();
        assert_eq!(config.executable_path(&ToolId::meters()), None);
        assert_eq!(
            config.executable_path(&ToolId::powers()),
            Some(powers_exe.as_path())
        );

        std::fs::write(&config_path, "[tools\n").unwrap();
        assert!(load_desktop_config_from_path(&config_path).is_err());

        assert_eq!(
            resolve_built_in_tool_id("meters").unwrap(),
            ToolId::meters()
        );
        assert!(resolve_built_in_tool_id("foobar").is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
