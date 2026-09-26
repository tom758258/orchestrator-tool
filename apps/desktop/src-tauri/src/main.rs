#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod stored_run;
mod stream_csv;
#[cfg(windows)]
mod webview2;

use stored_run::{
    BoxPlotDto, ChartSeriesDto, ExecutionRowsDto, HistogramDto, PageRowsDto, RunMetadataDto,
    StoredRun, StoredRuns,
};
use stream_csv::{StreamCsvOptions, StreamCsvStatus, run_streaming_with_stream};

use std::{
    collections::{BTreeSet, HashMap},
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex, RwLock},
    thread,
    time::{Duration, Instant},
};

use orchestrator_tool::{
    config::{Config, ConfigError, ResourceIdentity},
    discovery::{
        ExecutablePathSource, ExecutableStatus, built_in_tool_definitions, current_application_dir,
    },
    live_resources::LiveResourceCandidate,
    run::{ExecutionMode, run_workflow_streaming_with_loop_stop},
    run_preparation::{prepare_worker_launch_specs, validate_confirmed_live_resources},
    status::{ManifestStatus, inspect_built_in_tool_statuses},
    template::Template,
    tool::ToolId,
    tool_instance::ToolInstanceId,
    worker::WorkerLaunchSpec,
    workflow::{StepId, Workflow, WorkflowRunEvent},
};
use serde::Serialize;
use tauri::{AppHandle, Manager, ipc::Channel};

const RUN_STARTUP_TIMEOUT: Duration = Duration::from_secs(10);
const RUN_ACTION_TIMEOUT: Duration = Duration::from_secs(10);
const RUN_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);
const DESKTOP_CONFIG_FILENAME: &str = "orchestrator.toml";

enum ActiveOperation {
    Workflow(Arc<Mutex<Option<String>>>),
    ManualOperation,
}

#[derive(Default)]
struct ActiveRun(Mutex<Option<ActiveOperation>>);

impl ActiveRun {
    fn register(&self) -> Result<Arc<Mutex<Option<String>>>, String> {
        let mut active = self.0.lock().unwrap();
        if active.is_some() {
            return Err("Another external operation is already active".to_owned());
        }
        let control = Arc::new(Mutex::new(None));
        *active = Some(ActiveOperation::Workflow(control.clone()));
        Ok(control)
    }

    fn register_manual(&self) -> Result<(), String> {
        let mut active = self.0.lock().unwrap();
        if active.is_some() {
            return Err("Another external operation is already active".to_owned());
        }
        *active = Some(ActiveOperation::ManualOperation);
        Ok(())
    }

    fn clear(&self) {
        *self.0.lock().unwrap() = None;
    }

    fn request(&self, loop_step_id: String) -> bool {
        let active = self.0.lock().unwrap();
        let Some(ActiveOperation::Workflow(control)) = active.as_ref() else {
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

fn powers_worker_spec(
    app: &AppHandle,
    instance_id: &str,
    execution_mode: ExecutionMode,
) -> Result<WorkerLaunchSpec, String> {
    let instance_id = ToolInstanceId::new(instance_id).map_err(|error| error.to_string())?;
    let application_dir = current_application_dir().map_err(|error| error.to_string())?;
    let config = load_desktop_config(app)?;
    let definition = built_in_tool_definitions()
        .into_iter()
        .find(|definition| definition.id() == &ToolId::powers())
        .expect("powers is built in");
    let inspection =
        orchestrator_tool::inspection::inspect_tool(&application_dir, &config, &definition)
            .map_err(|error| format!("powers executable inspection failed: {error}"))?;
    if inspection.status() != ExecutableStatus::Available {
        return Err("powers executable is unavailable".to_owned());
    }
    let executable = inspection
        .resolved()
        .path()
        .expect("available executable has a path");
    match execution_mode {
        ExecutionMode::Simulate => {
            Ok(orchestrator_tool::adapters::powers::simulate_worker_launch_spec(executable))
        }
        ExecutionMode::Live => {
            let resource = config
                .live_resources()
                .get(instance_id.as_str())
                .filter(|resource| !resource.trim().is_empty())
                .ok_or_else(|| format!("{instance_id} saved Live Resource is not configured"))?;
            Ok(orchestrator_tool::adapters::powers::live_worker_launch_spec(executable, resource))
        }
    }
}

fn finish_manual_powers_operation<T>(
    operation: Result<T, String>,
    shutdown: Result<std::process::ExitStatus, orchestrator_tool::worker::WorkerShutdownError>,
) -> Result<T, String> {
    match (operation, shutdown) {
        (Ok(value), Ok(status)) if status.success() => Ok(value),
        (Ok(_), Ok(status)) => Err(format!("Powers Worker exited with {status}")),
        (Ok(_), Err(error)) => Err(format!("Powers Worker shutdown failed: {error}")),
        (Err(error), Ok(_)) => Err(error),
        (Err(error), Err(shutdown)) => Err(format!(
            "{error}; Powers Worker shutdown also failed: {shutdown}"
        )),
    }
}

#[tauri::command]
async fn refresh_powers_status(
    app: AppHandle,
    state: tauri::State<'_, ActiveRun>,
    instance_id: String,
    execution_mode: ExecutionMode,
) -> Result<orchestrator_tool::adapters::powers::PowersProtectionStatus, String> {
    state.register_manual()?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let spec = powers_worker_spec(&app, &instance_id, execution_mode)?;
        let session = orchestrator_tool::worker::start_worker(&spec, RUN_STARTUP_TIMEOUT)
            .map_err(|error| format!("Powers Worker startup failed: {error}"))?;
        let operation = orchestrator_tool::adapters::powers::normalized_protection_status_all(
            &session,
            execution_mode,
            RUN_ACTION_TIMEOUT,
        )
        .map_err(|error| error.to_string());
        let shutdown = session.shutdown(RUN_SHUTDOWN_TIMEOUT);
        finish_manual_powers_operation(operation, shutdown)
    })
    .await
    .map_err(|error| error.to_string());
    state.clear();
    result?
}

#[derive(Serialize)]
#[serde(tag = "mode", rename_all = "lowercase")]
enum PowersClearResult {
    Simulate {
        outcome: &'static str,
        plan: serde_json::Value,
    },
    Live {
        outcome: &'static str,
        status: orchestrator_tool::adapters::powers::PowersProtectionStatus,
    },
}

#[tauri::command]
async fn clear_powers_protection(
    app: AppHandle,
    state: tauri::State<'_, ActiveRun>,
    instance_id: String,
    channel: u32,
    execution_mode: ExecutionMode,
) -> Result<PowersClearResult, String> {
    if channel == 0 {
        return Err("Clear Protection channel must be a positive integer".to_owned());
    }
    state.register_manual()?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut spec = powers_worker_spec(&app, &instance_id, execution_mode)?;
        let _authorization = if execution_mode == ExecutionMode::Live {
            let dir = app
                .path()
                .app_cache_dir()
                .map_err(|error| error.to_string())?;
            Some(PowersWriteAuthorization::prepare(&dir, &mut spec)?)
        } else {
            None
        };
        let session = orchestrator_tool::worker::start_worker(&spec, RUN_STARTUP_TIMEOUT)
            .map_err(|error| format!("Powers Worker startup failed: {error}"))?;
        let operation = (|| {
            orchestrator_tool::adapters::powers::safe_off_all(
                &session,
                execution_mode,
                RUN_ACTION_TIMEOUT,
            )
            .map_err(|error| format!("Safe-Off All failed: {error}"))?;
            let clear_result = orchestrator_tool::adapters::powers::clear_protection(
                &session,
                channel,
                execution_mode,
                RUN_ACTION_TIMEOUT,
            )
            .map_err(|error| error.to_string())?;
            match execution_mode {
                ExecutionMode::Simulate => Ok(PowersClearResult::Simulate {
                    outcome: "planned",
                    plan: clear_result,
                }),
                ExecutionMode::Live => {
                    orchestrator_tool::adapters::powers::normalized_protection_status_all(
                        &session,
                        execution_mode,
                        RUN_ACTION_TIMEOUT,
                    )
                    .map(|status| PowersClearResult::Live {
                        outcome: "completed",
                        status,
                    })
                    .map_err(|error| error.to_string())
                }
            }
        })();
        let shutdown = session.shutdown(RUN_SHUTDOWN_TIMEOUT);
        finish_manual_powers_operation(operation, shutdown)
    })
    .await
    .map_err(|error| error.to_string());
    state.clear();
    result?
}

#[tauri::command]
async fn get_meters_capabilities(
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
async fn get_powers_capabilities(
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

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum WorkflowRunEventDto {
    ProgressBatch {
        run: Box<RunMetadataDto>,
        completed_step_ids: Vec<String>,
    },
    CsvStream {
        status: StreamCsvStatus,
    },
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

#[tauri::command]
async fn run_workflow_simulation(
    app: AppHandle,
    state: tauri::State<'_, ActiveRun>,
    runs: tauri::State<'_, StoredRuns>,
    template_json: String,
    on_progress: Channel<WorkflowRunEventDto>,
    stream_csv: Option<StreamCsvOptions>,
) -> Result<RunMetadataDto, String> {
    let control = state.register()?;
    let runs = runs.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        runs.clear_current();
        let template =
            Template::from_json_str(&template_json).map_err(|error| error.to_string())?;
        let stored = runs.begin(template.clone());
        let mut batcher = DesktopProgressBatcher::new(&on_progress, stored.clone());
        let outcome = (|| {
            let application_dir = current_application_dir()
                .map_err(|error| format!("could not determine application directory: {error}"))?;
            let config = load_desktop_config(&app)?;
            let launch_specs = prepare_worker_launch_specs(
                &template,
                ExecutionMode::Simulate,
                &application_dir,
                &config,
            )?;
            run_streaming_with_stream(
                &template,
                stream_csv.as_ref(),
                &application_dir,
                |status| {
                    let _ = on_progress.send(WorkflowRunEventDto::CsvStream { status });
                },
                |event| batcher.push(&event),
                |on_event| {
                    run_workflow_streaming_with_loop_stop(
                        &template,
                        ExecutionMode::Simulate,
                        &launch_specs,
                        RUN_STARTUP_TIMEOUT,
                        RUN_ACTION_TIMEOUT,
                        RUN_SHUTDOWN_TIMEOUT,
                        on_event,
                        |step_id| consume_loop_stop(&control, step_id),
                    )
                    .map_err(|error| error.to_string())
                },
                |summary| summary.succeeded() && stored.read().unwrap().completed_successfully(),
            )
        })();
        match outcome {
            Ok(summary) if summary.succeeded() => stored.write().unwrap().succeed(),
            Ok(summary) => stored
                .write()
                .unwrap()
                .fail(summary.failure().unwrap_or("workflow failed")),
            Err(error) => stored.write().unwrap().fail(error.clone()),
        }
        batcher.flush();
        let metadata = stored.read().unwrap().metadata();
        Ok(metadata)
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
    runs: tauri::State<'_, StoredRuns>,
    template_json: String,
    confirmed_resources: HashMap<String, String>,
    on_progress: Channel<WorkflowRunEventDto>,
    stream_csv: Option<StreamCsvOptions>,
) -> Result<RunMetadataDto, String> {
    let control = state.register()?;
    let runs = runs.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        runs.clear_current();
        let template =
            Template::from_json_str(&template_json).map_err(|error| error.to_string())?;
        let stored = runs.begin(template.clone());
        let mut batcher = DesktopProgressBatcher::new(&on_progress, stored.clone());
        let outcome = (|| {
            let application_dir = current_application_dir().map_err(|error| error.to_string())?;
            let config = load_desktop_config(&app)?;
            validate_confirmed_live_resources(&template, &config, &confirmed_resources)?;
            let mut launch_specs = prepare_worker_launch_specs(
                &template,
                ExecutionMode::Live,
                &application_dir,
                &config,
            )?;
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
            run_streaming_with_stream(
                &template,
                stream_csv.as_ref(),
                &application_dir,
                |status| {
                    let _ = on_progress.send(WorkflowRunEventDto::CsvStream { status });
                },
                |event| batcher.push(&event),
                |on_event| {
                    run_workflow_streaming_with_loop_stop(
                        &template,
                        ExecutionMode::Live,
                        &launch_specs,
                        RUN_STARTUP_TIMEOUT,
                        RUN_ACTION_TIMEOUT,
                        RUN_SHUTDOWN_TIMEOUT,
                        on_event,
                        |step_id| consume_loop_stop(&control, step_id),
                    )
                    .map_err(|error| error.to_string())
                },
                |summary| summary.succeeded() && stored.read().unwrap().completed_successfully(),
            )
        })();
        match outcome {
            Ok(summary) if summary.succeeded() => stored.write().unwrap().succeed(),
            Ok(summary) => stored
                .write()
                .unwrap()
                .fail(summary.failure().unwrap_or("workflow failed")),
            Err(error) => stored.write().unwrap().fail(error.clone()),
        }
        batcher.flush();
        let metadata = stored.read().unwrap().metadata();
        Ok(metadata)
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
/// A missing file leaves tools unconfigured; any other load failure is
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
    let executable_path =
        std::path::absolute(executable_path).map_err(|error| error.to_string())?;
    let probe = orchestrator_tool::manifest_probe::probe_manifest(&executable_path, tool_id)
        .map_err(|error| error.to_string())?;
    if probe.manifest().worker_compatibility()
        != orchestrator_tool::manifest::WorkerCompatibility::Compatible
    {
        return Err(format!("{tool_id} Worker protocol is incompatible"));
    }
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
async fn set_tool_executable(app: AppHandle, tool_id: String, path: String) -> Result<(), String> {
    let tool_id = resolve_built_in_tool_id(&tool_id)?;
    let config_path = desktop_config_path(&app)?;

    tauri::async_runtime::spawn_blocking(move || {
        set_desktop_tool_executable(&config_path, &tool_id, Path::new(&path))
    })
    .await
    .map_err(|error| error.to_string())?
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

const PROGRESS_BATCH_INTERVAL: Duration = Duration::from_millis(100);

struct DesktopProgressBatcher {
    shared: Arc<(Mutex<DesktopProgressPending>, Condvar)>,
    worker: Option<thread::JoinHandle<()>>,
}

struct DesktopProgressPending {
    channel: Channel<WorkflowRunEventDto>,
    run: Arc<RwLock<StoredRun>>,
    completed_step_ids: BTreeSet<String>,
    dirty: bool,
    deadline: Option<Instant>,
    closed: bool,
}

impl DesktopProgressPending {
    fn flush(&mut self) {
        self.deadline = None;
        if !self.dirty {
            return;
        }
        self.dirty = false;
        let run = self.run.read().unwrap().metadata();
        // Serialize sends with pushes and final flush to preserve batch ordering.
        let _ = self.channel.send(WorkflowRunEventDto::ProgressBatch {
            run: Box::new(run),
            completed_step_ids: std::mem::take(&mut self.completed_step_ids)
                .into_iter()
                .collect(),
        });
    }
}

impl DesktopProgressBatcher {
    fn new(channel: &Channel<WorkflowRunEventDto>, run: Arc<RwLock<StoredRun>>) -> Self {
        let shared = Arc::new((
            Mutex::new(DesktopProgressPending {
                channel: channel.clone(),
                run,
                completed_step_ids: BTreeSet::new(),
                dirty: false,
                deadline: None,
                closed: false,
            }),
            Condvar::new(),
        ));
        let timer = shared.clone();
        let worker = thread::spawn(move || {
            let (lock, wake) = &*timer;
            let mut pending = lock.lock().unwrap();
            while !pending.closed {
                if let Some(deadline) = pending.deadline {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        pending.flush();
                    } else {
                        pending = wake.wait_timeout(pending, remaining).unwrap().0;
                    }
                } else {
                    pending = wake.wait(pending).unwrap();
                }
            }
        });
        Self {
            shared,
            worker: Some(worker),
        }
    }

    fn push(&mut self, event: &WorkflowRunEvent) {
        let (lock, wake) = &*self.shared;
        let mut pending = lock.lock().unwrap();
        pending.run.write().unwrap().append_event(event);
        if let WorkflowRunEvent::StepCompleted(execution) = event {
            pending
                .completed_step_ids
                .insert(execution.step_id().as_str().to_owned());
        }
        pending.dirty = true;
        if pending.deadline.is_none() {
            pending.deadline = Some(Instant::now() + PROGRESS_BATCH_INTERVAL);
            wake.notify_one();
        }
    }

    fn flush(&mut self) {
        self.shared.0.lock().unwrap().flush();
    }
}

impl Drop for DesktopProgressBatcher {
    fn drop(&mut self) {
        let (lock, wake) = &*self.shared;
        lock.lock().unwrap().closed = true;
        wake.notify_one();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

#[tauri::command]
fn save_chart_png(destination_path: String, png_bytes: Vec<u8>) -> Result<(), String> {
    std::fs::write(&destination_path, png_bytes)
        .map_err(|error| format!("could not write PNG to {destination_path:?}: {error}"))
}

#[tauri::command]
fn get_last_run_page_rows(
    state: tauri::State<'_, StoredRuns>,
    run_id: u64,
    page: String,
    offset: usize,
    limit: usize,
) -> Result<PageRowsDto, String> {
    state.with_current(run_id, |run| run.page_rows(&page, offset, limit))?
}

#[tauri::command]
fn get_last_run_executions(
    state: tauri::State<'_, StoredRuns>,
    run_id: u64,
    offset: usize,
    limit: usize,
) -> Result<ExecutionRowsDto, String> {
    state.with_current(run_id, |run| run.executions(offset, limit))
}

#[tauri::command]
fn get_last_run_chart_series(
    state: tauri::State<'_, StoredRuns>,
    run_id: u64,
    page: String,
    outputs: Vec<String>,
    start_row: usize,
    limit: usize,
) -> Result<ChartSeriesDto, String> {
    state.with_current(run_id, |run| {
        run.chart_series(&page, &outputs, start_row, limit)
    })?
}

#[tauri::command]
fn get_last_run_histogram(
    state: tauri::State<'_, StoredRuns>,
    run_id: u64,
    page: String,
    output: String,
    mode: String,
    value: Option<f64>,
) -> Result<HistogramDto, String> {
    state.with_current(run_id, |run| run.histogram(&page, &output, &mode, value))?
}

#[tauri::command]
fn get_last_run_box_plot(
    state: tauri::State<'_, StoredRuns>,
    run_id: u64,
    page: String,
    outputs: Vec<String>,
) -> Result<BoxPlotDto, String> {
    state.with_current(run_id, |run| run.box_plot(&page, &outputs))?
}

#[tauri::command]
fn clear_last_run(state: tauri::State<'_, StoredRuns>, run_id: u64) -> Result<(), String> {
    state.clear(run_id)
}

#[tauri::command]
fn export_last_run_pages(
    state: tauri::State<'_, StoredRuns>,
    run_id: u64,
    destination_path: String,
    page: Option<String>,
    format: String,
) -> Result<(), String> {
    state.with_current(run_id, |run| {
        export_stored_run_pages(run, &destination_path, page.as_deref(), &format)
    })?
}

fn export_stored_run_pages(
    run: &StoredRun,
    destination_path: &str,
    page: Option<&str>,
    format: &str,
) -> Result<(), String> {
    use orchestrator_tool::workflow_export::{PageDataset, pages_xlsx, write_page_csv_rows};
    if !run.manual_exportable() {
        return Err("workflow run did not complete successfully; export is unavailable".to_owned());
    }
    if let Some(name) = page
        && run.page(name).is_none()
    {
        return Err(format!("Unknown Output Page {name:?}"));
    }
    let selected_pages = run
        .pages()
        .filter(|(definition, _)| page.is_none_or(|name| name == definition.name()))
        .collect::<Vec<_>>();
    if selected_pages.is_empty() || !selected_pages.iter().any(|(_, rows)| !rows.is_empty()) {
        return Err("workflow has no outputs available for export".to_owned());
    }
    match format {
        "xlsx" => {
            let datasets = selected_pages
                .iter()
                .map(|(page, rows)| PageDataset {
                    page,
                    rows: rows.iter().collect(),
                })
                .collect::<Vec<_>>();
            std::fs::write(destination_path, pages_xlsx(&datasets)?).map_err(|e| e.to_string())
        }
        "csv" if page.is_some() => {
            let file = std::fs::File::create(destination_path).map_err(|e| e.to_string())?;
            let (page, rows) = selected_pages[0];
            write_page_csv_rows(page, rows.iter(), file)
        }
        "csv" => {
            let folder = Path::new(destination_path);
            let files = selected_pages
                .iter()
                .map(|(page, _)| folder.join(format!("{}.csv", page.name())))
                .collect::<Vec<_>>();
            if files.iter().any(|path| path.exists()) {
                return Err(
                    "Destination already contains Page CSV files; choose another folder".to_owned(),
                );
            }
            std::fs::create_dir_all(folder).map_err(|e| e.to_string())?;
            for ((page, rows), path) in selected_pages.iter().zip(files) {
                let file = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(path)
                    .map_err(|e| e.to_string())?;
                write_page_csv_rows(page, rows.iter(), file)?;
            }
            Ok(())
        }
        _ => Err("Unsupported export format".to_owned()),
    }
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

fn help_url(theme: &str) -> Result<tauri::WebviewUrl, String> {
    match theme {
        "system" | "light" | "dark" => Ok(tauri::WebviewUrl::App(
            format!("help/desktop.html?theme={theme}").into(),
        )),
        _ => Err("Help theme must be system, light, or dark".to_owned()),
    }
}

#[tauri::command]
async fn open_help(app: AppHandle, theme: String) -> Result<(), String> {
    let url = help_url(&theme)?;
    tauri::async_runtime::spawn_blocking(move || {
        // Serialize lookup and creation, including concurrent toolbar clicks.
        static HELP_WINDOW: Mutex<()> = Mutex::new(());
        let _guard = HELP_WINDOW.lock().map_err(|error| error.to_string())?;
        if let Some(window) = app.get_webview_window("help") {
            window.show().map_err(|error| error.to_string())?;
            window.set_focus().map_err(|error| error.to_string())?;
        } else {
            tauri::WebviewWindowBuilder::new(&app, "help", url)
                .title("Orchestrator Tool Help")
                .inner_size(1200.0, 800.0)
                .resizable(true)
                .build()
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

fn main() {
    #[cfg(windows)]
    if !webview2::preflight() {
        return;
    }

    let result = tauri::Builder::default()
        .manage(ActiveRun::default())
        .manage(StoredRuns::default())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let main_window = app
                .config()
                .app
                .windows
                .first()
                .ok_or_else(|| "main window configuration is missing".to_owned())
                .and_then(|config| {
                    tauri::WebviewWindowBuilder::from_config(app.handle(), config)
                        .and_then(|builder| builder.build())
                        .map_err(|error| error.to_string())
                });

            if let Err(error) = main_window {
                #[cfg(windows)]
                {
                    webview2::show_startup_error(&error);
                    app.handle().exit(1);
                }
                #[cfg(not(windows))]
                panic!("Orchestrator Tool desktop startup failed: {error}");
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_help,
            get_tool_status,
            list_live_resources,
            get_meters_capabilities,
            get_powers_capabilities,
            refresh_powers_status,
            clear_powers_protection,
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
            get_last_run_page_rows,
            get_last_run_executions,
            get_last_run_chart_series,
            get_last_run_histogram,
            get_last_run_box_plot,
            clear_last_run,
            export_last_run_pages,
            save_chart_png
        ])
        .run(tauri::generate_context!());

    if let Err(error) = result {
        #[cfg(windows)]
        {
            webview2::show_startup_error(&error.to_string());
            std::process::exit(1);
        }
        #[cfg(not(windows))]
        panic!("error while running tauri application: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::{export_stored_run_pages, stored_run::StoredRuns};
    use orchestrator_tool::workflow::{
        ResultRow, StepExecution, StepId, StepOutcome, StepResult, WorkflowOutput, WorkflowRunEvent,
    };
    use serde_json::json;

    pub fn unique_test_dir(label: &str) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "orchestrator-tool-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    fn export_template() -> orchestrator_tool::template::Template {
        orchestrator_tool::template::Template::from_json_str(
            &json!({
                "schema_version": 1,
                "name": "export",
                "tool_instances": [],
                "workflow": { "steps": [{
                    "type": "output", "id": "out", "name": "Voltage", "page": "Results",
                    "value": { "source": "literal", "value": 1 }
                }] }
            })
            .to_string(),
        )
        .unwrap()
    }

    #[test]
    fn successful_stored_run_exports_selected_csv_without_frontend_payload() {
        let runs = StoredRuns::default();
        let stored = runs.begin(export_template());
        let run_id = stored.read().unwrap().run_id;
        stored
            .write()
            .unwrap()
            .append_event(&WorkflowRunEvent::ResultRowCommitted(
                ResultRow::new(
                    vec![WorkflowOutput::new("Voltage".to_owned(), json!(1))],
                    None,
                )
                .with_page("Results"),
            ));
        stored
            .write()
            .unwrap()
            .append_event(&WorkflowRunEvent::StepCompleted(StepExecution::new(
                StepResult::new(
                    StepId::new("out").unwrap(),
                    StepOutcome::Succeeded { output: json!(1) },
                ),
                None,
            )));
        stored.write().unwrap().succeed();

        let dir = unique_test_dir("stored-export-success");
        let path = dir.join("results.csv");
        let guard = stored.read().unwrap();
        export_stored_run_pages(&guard, &path.display().to_string(), Some("Results"), "csv")
            .unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "Voltage\n1\n");
        assert_eq!(runs.with_current(run_id, |run| run.run_id).unwrap(), run_id);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_stored_run_cannot_be_manually_exported() {
        let runs = StoredRuns::default();
        let stored = runs.begin(export_template());
        stored
            .write()
            .unwrap()
            .append_event(&WorkflowRunEvent::ResultRowCommitted(
                ResultRow::new(
                    vec![WorkflowOutput::new("Voltage".to_owned(), json!(1))],
                    None,
                )
                .with_page("Results"),
            ));
        stored.write().unwrap().fail("workflow failed");

        let dir = unique_test_dir("stored-export-failed");
        let path = dir.join("results.csv");
        let guard = stored.read().unwrap();
        let error =
            export_stored_run_pages(&guard, &path.display().to_string(), Some("Results"), "csv")
                .unwrap_err();
        assert!(error.contains("export is unavailable"));
        assert!(!path.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[cfg(test)]
mod regression_tests {
    use super::stored_run::StoredRuns;
    use super::{
        create_workflow_draft, help_url, load_desktop_config_from_path, load_workflow_template,
        reset_desktop_tool_executable, resolve_built_in_tool_id, save_chart_png,
        save_workflow_template, set_desktop_tool_executable, validate_workflow_draft,
    };
    use orchestrator_tool::{
        template::Template,
        tool::ToolId,
        tool_instance::ToolInstanceId,
        workflow::{
            ResultRow, StepExecution, StepId, StepOutcome, StepResult, WorkflowOutput,
            WorkflowRunEvent,
        },
    };
    use serde_json::json;

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

    fn progress_template() -> Template {
        Template::from_json_str(
            &json!({
                "schema_version": 1,
                "name": "progress",
                "tool_instances": [],
                "workflow": { "steps": [{
                    "type": "output", "id": "out", "name": "value", "page": "Results",
                    "value": { "source": "literal", "value": 1 }
                }] }
            })
            .to_string(),
        )
        .unwrap()
    }

    #[test]
    fn help_url_accepts_only_supported_themes() {
        for theme in ["system", "light", "dark"] {
            assert_eq!(
                help_url(theme).unwrap(),
                tauri::WebviewUrl::App(format!("help/desktop.html?theme={theme}").into())
            );
        }
        for theme in ["", "Dark", "auto", "dark&url=https://example.com"] {
            assert!(help_url(theme).is_err());
        }
    }

    #[test]
    fn save_chart_png_preserves_binary_bytes() {
        let dir = unique_test_dir("orchestrator-chart-png");
        let path = dir.join("chart.png");
        let bytes = vec![0, 137, 80, 78, 71, 13, 10, 26, 255];
        save_chart_png(path.display().to_string(), bytes.clone()).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn active_run_stop_is_targeted_and_cleared_between_runs() {
        let state = super::ActiveRun::default();
        let a = StepId::new("loop-a").unwrap();
        let b = StepId::new("loop-b").unwrap();
        assert!(!state.request(a.to_string()));
        let control = state.register().unwrap();
        assert!(state.register().is_err());
        assert!(state.register_manual().is_err());
        assert!(state.request(a.to_string()));
        assert!(!super::consume_loop_stop(&control, &b));
        assert!(super::consume_loop_stop(&control, &a));
        assert!(!super::consume_loop_stop(&control, &a));
        state.clear();
        assert!(!state.request(b.to_string()));
        state.register_manual().unwrap();
        assert!(state.register().is_err());
        assert!(state.register_manual().is_err());
        assert!(!state.request(b.to_string()));
        state.clear();
        assert!(state.register().is_ok());
    }

    #[test]
    fn powers_clear_result_distinguishes_planned_simulation_from_completed_live() {
        let simulated = serde_json::to_value(super::PowersClearResult::Simulate {
            outcome: "planned",
            plan: json!({"execution":{"hardware_touched":false},"data":{"plan":[]}}),
        })
        .unwrap();
        assert_eq!(simulated["mode"], "simulate");
        assert_eq!(simulated["outcome"], "planned");
        assert_eq!(simulated["plan"]["execution"]["hardware_touched"], false);

        let live = serde_json::to_value(super::PowersClearResult::Live {
            outcome: "completed",
            status: orchestrator_tool::adapters::powers::PowersProtectionStatus {
                protection_tripped: false,
                over_voltage_tripped: false,
                over_current_tripped: false,
                channels: Vec::new(),
            },
        })
        .unwrap();
        assert_eq!(live["mode"], "live");
        assert_eq!(live["outcome"], "completed");
    }

    #[test]
    fn progress_batch_flushes_compact_metadata_only() {
        let messages = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let received = messages.clone();
        let channel = tauri::ipc::Channel::new(move |body| {
            let tauri::ipc::InvokeResponseBody::Json(json) = body else {
                panic!("expected JSON progress");
            };
            received
                .lock()
                .unwrap()
                .push(serde_json::from_str::<serde_json::Value>(&json).unwrap());
            Ok(())
        });
        let stored = StoredRuns::default().begin(progress_template());
        let mut batcher = super::DesktopProgressBatcher::new(&channel, stored);
        batcher.shared.0.lock().unwrap().deadline =
            Some(std::time::Instant::now() + std::time::Duration::from_secs(60));
        batcher.push(&WorkflowRunEvent::StepCompleted(StepExecution::new(
            StepResult::new(
                StepId::new("out").unwrap(),
                StepOutcome::Succeeded { output: json!(1) },
            ),
            None,
        )));
        batcher.push(&WorkflowRunEvent::ResultRowCommitted(
            ResultRow::new(
                vec![WorkflowOutput::new("value".to_owned(), json!(1))],
                None,
            )
            .with_page("Results"),
        ));
        batcher.flush();
        let messages = messages.lock().unwrap();
        assert_eq!(messages.len(), 1);
        let wire = &messages[0];
        assert_eq!(wire["type"], "progress-batch");
        assert_eq!(wire["run"]["execution_count"], 1);
        assert_eq!(wire["run"]["pages"][0]["row_count"], 1);
        assert_eq!(wire["completed_step_ids"], json!(["out"]));
        assert!(wire.get("result_rows").is_none());
        assert!(wire.get("step_executions").is_none());
    }

    #[test]
    fn sparse_progress_flushes_without_another_event() {
        let (sent, received) = std::sync::mpsc::channel();
        let channel = tauri::ipc::Channel::new(move |body| {
            sent.send(body).unwrap();
            Ok(())
        });
        let stored = StoredRuns::default().begin(progress_template());
        let mut batcher = super::DesktopProgressBatcher::new(&channel, stored);
        batcher.push(&WorkflowRunEvent::StepCompleted(StepExecution::new(
            StepResult::new(
                StepId::new("out").unwrap(),
                StepOutcome::Succeeded { output: json!(1) },
            ),
            None,
        )));
        let body = received
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        let tauri::ipc::InvokeResponseBody::Json(json) = body else {
            panic!("expected JSON progress");
        };
        let wire: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(wire["run"]["latest_execution"]["step_id"], "out");
    }

    #[test]
    fn final_flush_does_not_duplicate_when_timer_wakes() {
        let (sent, received) = std::sync::mpsc::channel();
        let channel = tauri::ipc::Channel::new(move |body| {
            sent.send(body).unwrap();
            Ok(())
        });
        let stored = StoredRuns::default().begin(progress_template());
        let mut batcher = super::DesktopProgressBatcher::new(&channel, stored);
        batcher.push(&WorkflowRunEvent::ResultRowCommitted(
            ResultRow::new(
                vec![WorkflowOutput::new("value".to_owned(), json!(1))],
                None,
            )
            .with_page("Results"),
        ));
        batcher.flush();
        received
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        assert!(matches!(
            received.recv_timeout(super::PROGRESS_BATCH_INTERVAL * 3),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));
        batcher.flush();
        assert!(received.try_recv().is_err());
    }

    #[test]
    fn progress_batch_send_failure_does_not_lose_stored_run_updates() {
        let channel = tauri::ipc::Channel::new(|_| Err(tauri::Error::FailedToReceiveMessage));
        let stored = StoredRuns::default().begin(progress_template());
        let observed = stored.clone();
        let mut batcher = super::DesktopProgressBatcher::new(&channel, stored);
        batcher.push(&WorkflowRunEvent::StepCompleted(StepExecution::new(
            StepResult::new(
                StepId::new("out").unwrap(),
                StepOutcome::Succeeded { output: json!(1) },
            ),
            None,
        )));
        batcher.push(&WorkflowRunEvent::ResultRowCommitted(
            ResultRow::new(
                vec![WorkflowOutput::new("value".to_owned(), json!(1))],
                None,
            )
            .with_page("Results"),
        ));
        batcher.flush();

        let metadata = observed.read().unwrap().metadata();
        assert_eq!(metadata.execution_count, 1);
        assert_eq!(metadata.pages[0].row_count, 1);
        assert_eq!(metadata.status, "running");
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
        super::edit_desktop_live_resource(&path, "powers-1", None, None).unwrap();
        assert_eq!(
            load_desktop_config_from_path(&path)
                .unwrap()
                .live_resource(&ToolInstanceId::new("powers-1").unwrap()),
            None
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
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&std::fs::read(&path).unwrap()).unwrap(),
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
    fn create_and_validate_workflow_drafts_use_current_schema() {
        let json = create_workflow_draft().unwrap();
        let template = Template::from_json_str(&json).unwrap();
        assert_eq!(template.name(), "Untitled");
        assert!(template.workflow().steps().is_empty());
        let invalid = r#"{
            "schema_version": 1,
            "tool_instances": [],
            "name": "Invalid",
            "workflow": { "steps": [
                { "type": "wait", "id": "Wait-1", "duration_ms": 1 }
            ] }
        }"#;
        assert!(
            validate_workflow_draft(invalid.to_owned())
                .unwrap_err()
                .contains("invalid step ID")
        );
    }

    #[test]
    fn save_and_load_workflow_template_round_trip() {
        let dir = unique_test_dir("orchestrator-template-round-trip");
        let path = dir.join("template.json");
        let template_json = r#"{
            "schema_version": 1,
            "tool_instances": [],
            "name": "Round Trip",
            "workflow": { "steps": [
                { "type": "wait", "id": "wait-1", "duration_ms": 1 }
            ] }
        }"#;
        let saved =
            save_workflow_template(path.display().to_string(), template_json.to_owned()).unwrap();
        let loaded = load_workflow_template(path.display().to_string()).unwrap();
        assert_eq!(saved, loaded);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn referenced_tool_instances_only_selects_used_instances() {
        let template = Template::from_json_str(
            r#"{
                "schema_version": 1,
                "tool_instances": [
                    {"id": "meters-1", "tool": "meters", "setup": {
                        "measurement": "voltage-dc", "range_mode": "auto", "manual_range": null,
                        "nplc": 1.0, "auto_zero": "on", "dcv_input_impedance": null,
                        "current_terminal": null
                    }},
                    {"id": "powers-1", "tool": "powers", "setup": {}},
                    {"id": "scopes-1", "tool": "scopes", "setup": {}}
                ],
                "name": "Referenced instances",
                "workflow": { "steps": [
                    { "type": "wait", "id": "wait-1", "duration_ms": 1 },
                    { "type": "tool-action", "id": "meter-read-1", "target": "meters-1", "action": "measure", "arguments": {} },
                    { "type": "tool-action", "id": "scope-read-1", "target": "scopes-1", "action": "capture", "arguments": {} }
                ] }
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

    fn manifest_fixture(
        dir: &std::path::Path,
        tool: &str,
        worker_version: u32,
    ) -> std::path::PathBuf {
        let manifest = serde_json::json!({
            "event": "tool_manifest", "schema_version": 2, "tool_id": tool,
            "tool_version": "1.0.0", "worker_protocol": {
                "schema_versions": [worker_version], "compatibility_policy": "v2-only"
            }
        });
        #[cfg(windows)]
        {
            let path = dir.join(format!("{tool}-{worker_version}.cmd"));
            std::fs::write(&path, format!("@echo off\r\necho {manifest}\r\n")).unwrap();
            path
        }
        #[cfg(not(windows))]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = dir.join(format!("{tool}-{worker_version}"));
            std::fs::write(&path, format!("#!/bin/sh\nprintf '%s\\n' '{manifest}'\n")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        }
    }

    #[test]
    fn desktop_tool_config_set_load_reset_round_trip() {
        let dir = unique_test_dir("orchestrator-tool-desktop-config-test");
        let config_path = dir.join("orchestrator.toml");
        let meters_exe = manifest_fixture(&dir, "meters", 2);
        let powers_exe = manifest_fixture(&dir, "powers", 2);
        assert_eq!(
            load_desktop_config_from_path(&config_path)
                .unwrap()
                .executable_path(&ToolId::meters()),
            None
        );
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
        let saved = std::fs::read(&config_path).unwrap();
        for rejected in [
            dir.join("missing.exe"),
            powers_exe.clone(),
            manifest_fixture(&dir, "meters", 99),
        ] {
            assert!(
                set_desktop_tool_executable(&config_path, &ToolId::meters(), &rejected).is_err()
            );
            assert_eq!(std::fs::read(&config_path).unwrap(), saved);
        }
        reset_desktop_tool_executable(&config_path, &ToolId::meters()).unwrap();
        let config = load_desktop_config_from_path(&config_path).unwrap();
        assert_eq!(config.executable_path(&ToolId::meters()), None);
        assert_eq!(
            config.executable_path(&ToolId::powers()),
            Some(powers_exe.as_path())
        );
        assert_eq!(
            resolve_built_in_tool_id("meters").unwrap(),
            ToolId::meters()
        );
        assert!(resolve_built_in_tool_id("foobar").is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
