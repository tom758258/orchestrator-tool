#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod desktop_config;
mod powers_commands;
mod stored_run;
mod stream_csv;
mod template_commands;
mod tool_commands;
#[cfg(windows)]
mod webview2;

use desktop_config::load_desktop_config;
use stored_run::{
    BoxPlotDto, ChartSeriesDto, ExecutionRowsDto, HistogramDto, MessageRowsDto, PageRowsDto,
    RunMetadataDto, StoredRun, StoredRuns,
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
    config::{Config, VisaBackend},
    discovery::current_application_dir,
    live_preflight::{validate_live_preflight, validate_live_preflight_draft},
    run::{ExecutionMode, RunOptions, WorkflowStop, run_workflow_streaming_controlled},
    run_preparation::{
        prepare_worker_launch_specs, prepare_worker_launch_specs_with_simulation,
        simulation_sample_requirements, validate_confirmed_live_resources,
    },
    template::Template,
    tool::ToolId,
    tool_instance::ToolInstanceId,
    worker::WorkerLaunchSpec,
    workflow::{StepId, WorkflowRunEvent},
};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, ipc::Channel};

#[cfg(test)]
pub(crate) fn unique_test_dir(prefix: &str) -> std::path::PathBuf {
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

const RUN_STARTUP_TIMEOUT: Duration = Duration::from_secs(10);
const RUN_ACTION_TIMEOUT: Duration = Duration::from_secs(10);
const RUN_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Default)]
struct WorkflowControl {
    loop_stop: Mutex<Option<String>>,
    run_id: Mutex<Option<u64>>,
    workflow_stop: WorkflowStop,
}

enum ActiveOperation {
    Workflow(Arc<WorkflowControl>),
    ManualOperation,
}

#[derive(Default)]
struct ActiveRun(Mutex<Option<ActiveOperation>>);

impl ActiveRun {
    fn register(&self) -> Result<Arc<WorkflowControl>, String> {
        let mut active = self.0.lock().unwrap();
        if active.is_some() {
            return Err("Another external operation is already active".to_owned());
        }
        let control = Arc::new(WorkflowControl::default());
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
        *control.loop_stop.lock().unwrap() = Some(loop_step_id);
        true
    }

    fn request_global(&self, run_id: u64) -> bool {
        let active = self.0.lock().unwrap();
        let Some(ActiveOperation::Workflow(control)) = active.as_ref() else {
            return false;
        };
        if *control.run_id.lock().unwrap() != Some(run_id) {
            return false;
        }
        control.workflow_stop.request();
        true
    }
}

#[tauri::command]
fn request_global_workflow_stop(state: tauri::State<'_, ActiveRun>, run_id: u64) -> bool {
    state.request_global(run_id)
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
async fn check_live_preflight(
    app: AppHandle,
    template_json: String,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let application_dir = current_application_dir().map_err(|error| error.to_string())?;
        validate_live_preflight_draft(
            &template_json,
            &application_dir,
            &load_desktop_config(&app)?,
        )
    })
    .await
    .map_err(|error| error.to_string())?
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
#[allow(clippy::too_many_arguments)]
async fn run_workflow_simulation(
    app: AppHandle,
    state: tauri::State<'_, ActiveRun>,
    runs: tauri::State<'_, StoredRuns>,
    template_json: String,
    on_progress: Channel<WorkflowRunEventDto>,
    stream_csv: Option<StreamCsvOptions>,
    scopes_output_folder: Option<String>,
    simulation_samples: Option<HashMap<String, usize>>,
    background_csv: Option<orchestrator_tool::background::BackgroundCsvOptions>,
) -> Result<RunMetadataDto, String> {
    let control = state.register()?;
    let runs = runs.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let template =
            Template::from_json_str(&template_json).map_err(|error| error.to_string())?;
        let invalid_files = orchestrator_tool::adapters::serial::send_file_path_errors(&template);
        if !invalid_files.is_empty() {
            return Err(format!(
                "Serial Send File preflight failed:\n{}",
                invalid_files.join("\n")
            ));
        }
        runs.clear_current();
        let stored = runs.begin(template.clone());
        *control.run_id.lock().unwrap() = Some(stored.read().unwrap().run_id);
        let _ = on_progress.send(WorkflowRunEventDto::ProgressBatch {
            run: Box::new(stored.read().unwrap().metadata()),
            completed_step_ids: Vec::new(),
        });
        let mut batcher = DesktopProgressBatcher::new(&on_progress, stored.clone());
        let outcome = (|| {
            let application_dir = current_application_dir()
                .map_err(|error| format!("could not determine application directory: {error}"))?;
            let config = load_desktop_config(&app)?;
            let launch_specs = prepare_worker_launch_specs_with_simulation(
                &template,
                ExecutionMode::Simulate,
                &application_dir,
                &config,
                &simulation_samples.unwrap_or_default(),
            )?;
            run_streaming_with_stream(
                &template,
                stream_csv.as_ref(),
                &application_dir,
                |status| {
                    let _ = on_progress.send(WorkflowRunEventDto::CsvStream { status });
                },
                |event| batcher.push(&event),
                |on_event, failure| {
                    let backgrounds = stored.read().unwrap().backgrounds.clone();
                    let background_csv = background_csv.map(|mut options| {
                        options.output_folder = application_dir.join(options.output_folder);
                        options
                    });
                    run_workflow_streaming_controlled(
                        &template,
                        ExecutionMode::Simulate,
                        &launch_specs,
                        RUN_STARTUP_TIMEOUT,
                        RUN_ACTION_TIMEOUT,
                        RUN_SHUTDOWN_TIMEOUT,
                        scopes_output_folder.as_deref().map(Path::new),
                        RunOptions {
                            backgrounds,
                            failure,
                            background_csv,
                            workflow_stop: control.workflow_stop.clone(),
                        },
                        on_event,
                        |step_id| consume_loop_stop(&control.loop_stop, step_id),
                    )
                    .map_err(|error| error.to_string())
                },
                |summary| summary.succeeded() && stored.read().unwrap().completed_successfully(),
            )
        })();
        match outcome {
            Ok(summary) if summary.succeeded() => stored.write().unwrap().succeed(),
            Ok(summary) if summary.stopped() => stored.write().unwrap().stop(),
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
#[allow(clippy::too_many_arguments)]
async fn run_workflow_live(
    app: AppHandle,
    state: tauri::State<'_, ActiveRun>,
    runs: tauri::State<'_, StoredRuns>,
    template_json: String,
    confirmed_resources: HashMap<String, String>,
    confirmed_backends: HashMap<String, VisaBackend>,
    on_progress: Channel<WorkflowRunEventDto>,
    stream_csv: Option<StreamCsvOptions>,
    scopes_output_folder: Option<String>,
    background_csv: Option<orchestrator_tool::background::BackgroundCsvOptions>,
) -> Result<RunMetadataDto, String> {
    let control = state.register()?;
    let runs = runs.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let template =
            Template::from_json_str(&template_json).map_err(|error| error.to_string())?;
        let invalid_files = orchestrator_tool::adapters::serial::send_file_path_errors(&template);
        if !invalid_files.is_empty() {
            return Err(format!(
                "Serial Send File preflight failed:\n{}",
                invalid_files.join("\n")
            ));
        }
        let application_dir = current_application_dir().map_err(|error| error.to_string())?;
        let config = load_desktop_config(&app)?;
        let (stored, mut launch_specs) = begin_live_run(
            &runs,
            &template,
            &application_dir,
            &config,
            &confirmed_resources,
            &confirmed_backends,
            &on_progress,
            &control,
        )?;
        let mut batcher = DesktopProgressBatcher::new(&on_progress, stored.clone());
        let outcome = (|| {
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
                    authorizations.push(PowersWorkerConfig::prepare(
                        &dir,
                        spec,
                        config.live_backend(&instance.id),
                        true,
                    )?);
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
                |on_event, failure| {
                    let backgrounds = stored.read().unwrap().backgrounds.clone();
                    let background_csv = background_csv.map(|mut options| {
                        options.output_folder = application_dir.join(options.output_folder);
                        options
                    });
                    run_workflow_streaming_controlled(
                        &template,
                        ExecutionMode::Live,
                        &launch_specs,
                        RUN_STARTUP_TIMEOUT,
                        RUN_ACTION_TIMEOUT,
                        RUN_SHUTDOWN_TIMEOUT,
                        scopes_output_folder.as_deref().map(Path::new),
                        RunOptions {
                            backgrounds,
                            failure,
                            background_csv,
                            workflow_stop: control.workflow_stop.clone(),
                        },
                        on_event,
                        |step_id| consume_loop_stop(&control.loop_stop, step_id),
                    )
                    .map_err(|error| error.to_string())
                },
                |summary| summary.succeeded() && stored.read().unwrap().completed_successfully(),
            )
        })();
        match outcome {
            Ok(summary) if summary.succeeded() => stored.write().unwrap().succeed(),
            Ok(summary) if summary.stopped() => stored.write().unwrap().stop(),
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

struct PowersWorkerConfig(PathBuf);

#[allow(clippy::type_complexity, clippy::too_many_arguments)]
fn begin_live_run(
    runs: &StoredRuns,
    template: &Template,
    application_dir: &Path,
    config: &Config,
    confirmed_resources: &HashMap<String, String>,
    confirmed_backends: &HashMap<String, VisaBackend>,
    on_progress: &Channel<WorkflowRunEventDto>,
    control: &WorkflowControl,
) -> Result<
    (
        Arc<RwLock<StoredRun>>,
        HashMap<ToolInstanceId, WorkerLaunchSpec>,
    ),
    String,
> {
    validate_confirmed_live_resources(template, config, confirmed_resources, confirmed_backends)?;
    let errors = validate_live_preflight(template, application_dir, config);
    if !errors.is_empty() {
        return Err(format!("Live Preflight failed:\n{}", errors.join("\n")));
    }
    let specs =
        prepare_worker_launch_specs(template, ExecutionMode::Live, application_dir, config)?;
    let stored = runs.begin(template.clone());
    *control.run_id.lock().unwrap() = Some(stored.read().unwrap().run_id);
    // Notify Desktop before authorization, Worker startup, or the first Step completes.
    let _ = on_progress.send(WorkflowRunEventDto::ProgressBatch {
        run: Box::new(stored.read().unwrap().metadata()),
        completed_step_ids: Vec::new(),
    });
    Ok((stored, specs))
}

impl PowersWorkerConfig {
    fn prepare(
        dir: &Path,
        spec: &mut WorkerLaunchSpec,
        backend: VisaBackend,
        allow_output_writes: bool,
    ) -> Result<Self, String> {
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
        let mut settings = serde_json::json!({"allow_output_writes": allow_output_writes});
        if backend == VisaBackend::Py {
            settings["backend"] = serde_json::json!("@py");
        }
        let contents = serde_json::json!({"settings": settings}).to_string();
        let written = file.write_all(contents.as_bytes());
        drop(file);
        written.map_err(|error| format!("could not write Powers authorization: {error}"))?;
        let mut arguments = spec.arguments().to_vec();
        arguments.push("--config".into());
        arguments.push(authorization.0.as_os_str().to_owned());
        let manifest = spec.manifest().cloned();
        *spec = WorkerLaunchSpec::new(spec.executable(), arguments);
        if let Some(manifest) = manifest {
            *spec = spec.clone().with_manifest(manifest);
        }
        Ok(authorization)
    }
}

impl Drop for PowersWorkerConfig {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
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
fn get_simulation_sample_requirements(template_json: String) -> Result<Vec<String>, String> {
    simulation_sample_requirements(
        &Template::from_json_str(&template_json).map_err(|e| e.to_string())?,
    )
}

#[derive(Serialize)]
struct BackgroundOutputDto {
    datasets: Vec<orchestrator_tool::background::DatasetMetadata>,
    workers: Vec<orchestrator_tool::background::BackgroundStatus>,
    rows: Vec<Value>,
    monitor: Vec<Value>,
    text_prefix_hex: String,
}

#[tauri::command]
fn get_background_output(
    state: tauri::State<'_, StoredRuns>,
    run_id: u64,
    background_id: String,
    dataset_id: Option<String>,
    offset: usize,
    limit: usize,
) -> Result<BackgroundOutputDto, String> {
    state.with_current(run_id, |run| {
        let store = run.backgrounds.lock().unwrap_or_else(|e| e.into_inner());
        let dataset = dataset_id.as_deref().filter(|id| {
            store
                .datasets
                .iter()
                .any(|d| d.metadata.id == *id && d.metadata.background_id == background_id)
        });
        Ok(BackgroundOutputDto {
            datasets: store.metadata(),
            workers: store.workers.clone(),
            rows: dataset
                .map(|id| store.rows(id, offset, limit))
                .transpose()?
                .unwrap_or_default(),
            monitor: store.monitor(&background_id),
            text_prefix_hex: dataset
                .map(|id| {
                    let start = offset.saturating_sub(3);
                    // Prefix only the bytes before the requested window.
                    // At offset 0, no prefix is allowed.
                    let tail = store.rows(id, start, offset - start)?;
                    let mut hex = String::new();
                    for sample in tail {
                        if let Some(fragment) = sample["rx_hex"].as_str() {
                            hex.push_str(fragment);
                        }
                    }
                    if hex.len() > 6 {
                        hex = hex[hex.len() - 6..].to_owned();
                    }
                    Ok::<_, String>(hex)
                })
                .transpose()?
                .unwrap_or_default(),
        })
    })?
}

#[tauri::command]
async fn get_background_chart_series(
    state: tauri::State<'_, StoredRuns>,
    run_id: u64,
    background_id: String,
    dataset_id: String,
    query: orchestrator_tool::background::BackgroundChartQuery,
) -> Result<orchestrator_tool::background::BackgroundChartSeries, String> {
    let store = state.with_current(run_id, |run| run.backgrounds.clone())?;
    tauri::async_runtime::spawn_blocking(move || {
        orchestrator_tool::background::query_chart(&store, &background_id, &dataset_id, &query)
    })
    .await
    .map_err(|e| e.to_string())?
}

// Keep the existing flat Tauri IPC contract, adding only Serial display mode.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn export_background_datasets(
    state: tauri::State<'_, StoredRuns>,
    run_id: u64,
    dataset_ids: Vec<String>,
    output_folder: String,
    format: orchestrator_tool::background_export::BackgroundExportFormat,
    rows_per_file: usize,
    scopes_mode: Option<orchestrator_tool::background::ScopesExportMode>,
    serial_format: Option<orchestrator_tool::serial_text::SerialDataFormat>,
) -> Result<Vec<String>, String> {
    let store = state.with_current(run_id, |run| {
        if run.metadata().status == "running" {
            Err("Finish the run before manual export".to_owned())
        } else {
            Ok(run.backgrounds.clone())
        }
    })??;
    tauri::async_runtime::spawn_blocking(move || {
        orchestrator_tool::background_export::export_datasets_with_serial_format(
            &store,
            &dataset_ids,
            Path::new(&output_folder),
            format,
            rows_per_file,
            scopes_mode.unwrap_or_default(),
            serial_format.unwrap_or_default(),
        )
        .map(|paths| paths.iter().map(|p| p.display().to_string()).collect())
    })
    .await
    .map_err(|e| e.to_string())?
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
fn get_last_run_messages(
    state: tauri::State<'_, StoredRuns>,
    run_id: u64,
    target: String,
    offset: usize,
    limit: usize,
) -> Result<MessageRowsDto, String> {
    state.with_current(run_id, |run| run.messages(&target, offset, limit))?
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
        return Err("workflow run is still active; export is unavailable".to_owned());
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

fn help_url(locale: &str, theme: &str) -> Result<tauri::WebviewUrl, String> {
    let page = match locale {
        "en" => "desktop.html",
        "zh-TW" => "desktop.zh-TW.html",
        _ => return Err("Help locale must be en or zh-TW".to_owned()),
    };
    if !matches!(theme, "system" | "light" | "dark") {
        return Err("Help theme must be system, light, or dark".to_owned());
    }
    Ok(tauri::WebviewUrl::App(
        format!("help/{page}?theme={theme}").into(),
    ))
}

fn help_navigation_target(
    main_url: &tauri::Url,
    current_url: &tauri::Url,
    url: &tauri::WebviewUrl,
) -> Result<Option<tauri::Url>, String> {
    let tauri::WebviewUrl::App(path) = url else {
        return Err("Help requires an application asset".to_owned());
    };
    let target = main_url
        .join(&format!("/{}", path.to_string_lossy()))
        .map_err(|error| error.to_string())?;
    // A second Help click should not reset a chapter when locale and theme match.
    // Preserve the selected chapter when the Desktop preference changes.
    let current_page = current_url.path().rsplit('/').next().unwrap_or("");
    let (stem, current_locale) = if let Some(base) = current_page.strip_suffix(".zh-TW.html") {
        (base, "zh-TW")
    } else if let Some(base) = current_page.strip_suffix(".html") {
        (base, "en")
    } else {
        ("desktop", "")
    };
    let valid_stem = matches!(
        stem,
        "desktop"
            | "guide-getting-started"
            | "guide-external-tools"
            | "guide-tool-setup"
            | "guide-workflow-editor"
            | "steps-input-values"
            | "steps-powers"
            | "steps-workflow"
            | "steps-scopes"
            | "steps-background"
            | "guide-execution"
            | "guide-background-streaming"
            | "guide-results"
            | "guide-charts"
            | "guide-results-and-export"
            | "guide-templates-and-settings"
            | "guide-troubleshooting"
            | "steps-serial"
    );
    let desired_locale = if target.path().ends_with(".zh-TW.html") {
        "zh-TW"
    } else {
        "en"
    };
    let desired_theme = target.query().unwrap_or("theme=system");
    if current_url.origin() == target.origin()
        && current_url.path().starts_with("/help/")
        && valid_stem
        && current_locale == desired_locale
        && current_url.query() == Some(desired_theme)
    {
        return Ok(None);
    }
    if current_url.origin() != target.origin()
        || !valid_stem
        || !current_url.path().starts_with("/help/")
    {
        return Ok(Some(target));
    }
    let locale_suffix = if desired_locale == "zh-TW" {
        ".zh-TW"
    } else {
        ""
    };
    Ok(Some(
        main_url
            .join(&format!("/help/{stem}{locale_suffix}.html?{desired_theme}"))
            .map_err(|error| error.to_string())?,
    ))
}

#[tauri::command]
async fn open_help(app: AppHandle, locale: String, theme: String) -> Result<(), String> {
    let url = help_url(&locale, &theme)?;
    let title = if locale == "zh-TW" {
        "Orchestrator Tool 使用說明"
    } else {
        "Orchestrator Tool Help"
    };
    tauri::async_runtime::spawn_blocking(move || {
        // Serialize lookup and creation, including concurrent toolbar clicks.
        static HELP_WINDOW: Mutex<()> = Mutex::new(());
        let _guard = HELP_WINDOW.lock().map_err(|error| error.to_string())?;
        if let Some(window) = app.get_webview_window("help") {
            let main_url = app
                .get_webview_window("main")
                .ok_or("Main window is unavailable")?
                .url()
                .map_err(|error| error.to_string())?;
            let current_url = window.url().map_err(|error| error.to_string())?;
            if let Some(target) = help_navigation_target(&main_url, &current_url, &url)? {
                window.navigate(target).map_err(|error| error.to_string())?;
            }
            window.set_title(title).map_err(|error| error.to_string())?;
            window.show().map_err(|error| error.to_string())?;
            window.set_focus().map_err(|error| error.to_string())?;
        } else {
            tauri::WebviewWindowBuilder::new(&app, "help", url)
                .title(title)
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
            tool_commands::get_tool_status,
            tool_commands::list_live_resources,
            tool_commands::read_and_drain_errors,
            tool_commands::check_meters_error_queue_support,
            tool_commands::get_meters_capabilities,
            tool_commands::get_powers_capabilities,
            tool_commands::get_scopes_capabilities,
            check_live_preflight,
            powers_commands::refresh_powers_status,
            powers_commands::clear_powers_protection,
            run_workflow_simulation,
            get_simulation_sample_requirements,
            get_background_output,
            get_background_chart_series,
            export_background_datasets,
            run_workflow_live,
            request_workflow_stop,
            request_global_workflow_stop,
            desktop_config::get_live_resources,
            desktop_config::get_live_backends,
            desktop_config::get_live_resource_identities,
            desktop_config::set_live_resource,
            desktop_config::remove_live_resource,
            desktop_config::set_tool_executable,
            desktop_config::reset_tool_executable,
            template_commands::create_workflow_draft,
            template_commands::validate_workflow_draft,
            template_commands::save_workflow_template,
            template_commands::load_workflow_template,
            template_commands::check_serial_send_files,
            get_last_run_page_rows,
            get_last_run_executions,
            get_last_run_messages,
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
    use orchestrator_tool::{
        run::{ExecutionMode, run_workflow_streaming_with_loop_stop},
        template::Template,
        workflow::{
            ResultRow, StepExecution, StepId, StepOutcome, StepResult, WorkflowOutput,
            WorkflowRunEvent,
        },
    };
    use serde_json::json;
    use std::time::Duration;

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
                "name": "export",
                "tool_instances": [],
                "workflow": {"interaction":{"enabled":false,"max_active_command_status":4096,"buffer":{"enabled":false,"mode":"fifo","overflow_policy":"fail-run"}}, "steps": [{
                    "type": "output", "id": "out", "name": "Voltage", "page": "Results",
                    "value": { "source": "literal", "value": 1 }
                }] }
            })
            .to_string(),
        )
        .unwrap()
    }

    #[test]
    fn live_preflight_backend_rechecks_saved_models_before_replacing_last_run() {
        use super::{Config, ToolId, ToolInstanceId, VisaBackend, begin_live_run};
        use orchestrator_tool::config::ResourceIdentity;
        let dir = unique_test_dir("live-preflight");
        let marker = dir.join("invocations.txt");
        let capabilities = |model: &str, channels| {
            json!({"schema_version":2,"ok":true,"status":"ok",
            "command":{"name":"capabilities"},"data":{"model_id":model,"model_name":model,"channels":channels,
            "protection_features":{"ovp_voltage":true,"ocp":true,"ocp_delay":true,"ocp_delay_triggers":[]}}})
        };
        let two = capabilities("two-channel", json!([1, 2]));
        let three = capabilities("three-channel", json!([1, 2, 3]));
        let manifest = json!({"schema_version":2,"event":"tool_manifest","tool_id":"powers","tool_version":"test",
            "worker_protocol":{"compatibility_policy":"v3-only","schema_versions":[3]},
            "execution":{"model":"multi_job","context_binding":"per_command"},
            "features":{"common.async_jobs":{"contract_version":1}}});
        #[cfg(windows)]
        let executable = {
            let path = dir.join("powers-tool.cmd");
            std::fs::write(&path, format!("@echo off\r\necho %*>>\"{}\"\r\nif \"%1\"==\"manifest\" goto manifest\r\nif not \"%1\"==\"capabilities\" exit /b 1\r\nif \"%3\"==\"three-channel\" goto three\r\necho {two}\r\nexit /b 0\r\n:three\r\necho {three}\r\nexit /b 0\r\n:manifest\r\necho {manifest}\r\n", marker.display())).unwrap();
            path
        };
        #[cfg(unix)]
        let executable = {
            use std::os::unix::fs::PermissionsExt;
            let path = dir.join("powers-tool");
            std::fs::write(&path, format!("#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}'\nif [ \"$1\" = manifest ]; then printf '%s\\n' '{manifest}'; elif [ \"$1\" = capabilities ]; then if [ \"$3\" = three-channel ]; then printf '%s\\n' '{three}'; else printf '%s\\n' '{two}'; fi; else exit 1; fi\n", marker.display())).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
            path
        };
        let template = Template::from_json_str(&json!({"name":"Live", "tool_instances":[
            {"id":"first","tool":"powers","setup":{}}, {"id":"second","tool":"powers","setup":{}}
        ],"workflow":{"interaction":{"enabled":false,"max_active_command_status":4096,"buffer":{"enabled":false,"mode":"fifo","overflow_policy":"fail-run"}},"steps":[
            {"type":"tool-action","id":"first-off","target":"first","action":"output-off","arguments":{"channel":3}},
            {"type":"tool-action","id":"second-off","target":"second","action":"output-off","arguments":{"channel":3}}
        ]}}).to_string()).unwrap();
        let mut config = Config::default();
        config.set_executable_path(&ToolId::powers(), &executable);
        let first = ToolInstanceId::new("first").unwrap();
        let second = ToolInstanceId::new("second").unwrap();
        let identity = |model: &str| {
            Some(ResourceIdentity {
                model_id: Some(model.into()),
                ..Default::default()
            })
        };
        config.set_live_resource_with_identity(&first, "USB::FIRST", identity("three-channel"));
        config.set_live_resource_with_identity(&second, "USB::SECOND", identity("two-channel"));
        let confirmed_backends = template
            .referenced_tool_instances()
            .into_iter()
            .map(|instance| (instance.id.as_str().to_owned(), VisaBackend::System))
            .collect();
        let confirmed = config
            .live_resources()
            .iter()
            .map(|(id, resource)| (id.clone(), resource.clone()))
            .collect();
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
        let runs = StoredRuns::default();
        let previous = runs.begin(export_template());
        previous
            .write()
            .unwrap()
            .append_event(&WorkflowRunEvent::ResultRowCommitted(
                ResultRow::new(vec![WorkflowOutput::new("Voltage".into(), json!(5))], None)
                    .with_page("Results"),
            ));
        previous.write().unwrap().succeed();
        let before = serde_json::to_value(previous.read().unwrap().metadata()).unwrap();
        let id = previous.read().unwrap().run_id;
        let previous_rows = serde_json::to_value(
            previous
                .read()
                .unwrap()
                .page_rows("Results", 0, 10)
                .unwrap(),
        )
        .unwrap();
        let error = match begin_live_run(
            &runs,
            &template,
            &dir,
            &config,
            &confirmed,
            &confirmed_backends,
            &channel,
            &super::WorkflowControl::default(),
        ) {
            Err(error) => error,
            Ok(_) => panic!("incompatible model must be rejected"),
        };
        assert!(
            error.contains("Live Preflight failed") && error.contains("second-off"),
            "{error}"
        );
        assert!(messages.lock().unwrap().is_empty());
        assert!(std::sync::Arc::ptr_eq(&runs.get(id).unwrap(), &previous));
        assert_eq!(
            serde_json::to_value(
                runs.get(id)
                    .unwrap()
                    .read()
                    .unwrap()
                    .page_rows("Results", 0, 10)
                    .unwrap()
            )
            .unwrap(),
            previous_rows
        );
        assert_eq!(
            serde_json::to_value(runs.get(id).unwrap().read().unwrap().metadata()).unwrap(),
            before
        );
        assert!(
            std::fs::read_to_string(&marker)
                .unwrap()
                .lines()
                .all(|line| line.starts_with("capabilities"))
        );
        let queries = std::fs::read_to_string(&marker).unwrap();
        assert!(
            queries.contains("--model three-channel") && queries.contains("--model two-channel")
        );

        // The same confirmed resources now use the newly saved model, never the UI's old pass.
        config.set_live_resource_with_identity(&second, "USB::SECOND", identity("three-channel"));
        let (accepted, specs) = begin_live_run(
            &runs,
            &template,
            &dir,
            &config,
            &confirmed,
            &confirmed_backends,
            &channel,
            &super::WorkflowControl::default(),
        )
        .unwrap();
        assert_eq!(accepted.read().unwrap().run_id, id + 1);
        {
            let messages = messages.lock().unwrap();
            assert_eq!(messages.len(), 1);
            assert_eq!(messages[0]["type"], "progress-batch");
            assert_eq!(messages[0]["run"]["run_id"], id + 1);
            assert_eq!(messages[0]["run"]["status"], "running");
            assert_eq!(messages[0]["run"]["execution_count"], 0);
            assert_eq!(messages[0]["completed_step_ids"], json!([]));
        }
        assert_eq!(specs.len(), 2);
        assert!(
            specs[&first]
                .arguments()
                .windows(2)
                .any(|pair| pair == ["--resource", "USB::FIRST"])
        );
        let accepted_id = accepted.read().unwrap().run_id;
        config.set_executable_path(&ToolId::powers(), dir.join("unavailable-tool.cmd"));
        assert!(
            begin_live_run(
                &runs,
                &template,
                &dir,
                &config,
                &confirmed,
                &confirmed_backends,
                &channel,
                &super::WorkflowControl::default(),
            )
            .is_err()
        );
        assert!(std::sync::Arc::ptr_eq(
            &runs.get(accepted_id).unwrap(),
            &accepted
        ));
        config.set_executable_path(&ToolId::powers(), &executable);
        config.set_live_resource_with_identity(&second, "USB::SECOND", identity("two-channel"));
        assert!(
            begin_live_run(
                &runs,
                &template,
                &dir,
                &config,
                &confirmed,
                &confirmed_backends,
                &channel,
                &super::WorkflowControl::default(),
            )
            .is_err()
        );
        assert!(std::sync::Arc::ptr_eq(
            &runs.get(accepted_id).unwrap(),
            &accepted
        ));
        config.set_live_resource_with_identity(&second, "USB::CHANGED", identity("three-channel"));
        assert!(
            begin_live_run(
                &runs,
                &template,
                &dir,
                &config,
                &confirmed,
                &confirmed_backends,
                &channel,
                &super::WorkflowControl::default(),
            )
            .is_err()
        );
        assert!(std::sync::Arc::ptr_eq(
            &runs.get(accepted_id).unwrap(),
            &accepted
        ));
        assert_eq!(messages.lock().unwrap().len(), 1);
        assert!(!std::fs::read_to_string(marker).unwrap().contains("worker"));
        // Startup failure belongs to the accepted Run even without a completed Step.
        accepted.write().unwrap().fail("Worker startup failed");
        let failed = accepted.read().unwrap().metadata();
        assert_eq!(failed.run_id, accepted_id);
        assert_eq!(failed.status, "failed");
        assert_eq!(failed.execution_count, 0);
        assert_eq!(failed.error.as_deref(), Some("Worker startup failed"));
        std::fs::remove_dir_all(dir).unwrap();
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
    fn active_stored_run_cannot_be_manually_exported() {
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

        let dir = unique_test_dir("stored-export-running");
        let path = dir.join("results.csv");
        let guard = stored.read().unwrap();
        let error =
            export_stored_run_pages(&guard, &path.display().to_string(), Some("Results"), "csv")
                .unwrap_err();
        assert!(error.contains("still active"));
        assert!(!path.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn partial_stored_run_with_committed_rows_exports_csv_and_xlsx() {
        for stopped in [false, true] {
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
            if stopped {
                stored.write().unwrap().stop();
            } else {
                stored.write().unwrap().fail("workflow failed");
            }

            let dir = unique_test_dir("stored-export-failed");
            let csv = dir.join("results.csv");
            let xlsx = dir.join("results.xlsx");
            let guard = stored.read().unwrap();
            assert!(guard.manual_exportable());
            export_stored_run_pages(&guard, &csv.display().to_string(), Some("Results"), "csv")
                .unwrap();
            export_stored_run_pages(&guard, &xlsx.display().to_string(), Some("Results"), "xlsx")
                .unwrap();
            assert_eq!(std::fs::read_to_string(&csv).unwrap(), "Voltage\n1\n");
            assert!(std::fs::metadata(&xlsx).unwrap().len() > 0);
            std::fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn failed_stored_run_without_committed_rows_is_not_exported() {
        let runs = StoredRuns::default();
        let stored = runs.begin(export_template());
        stored.write().unwrap().fail("workflow failed");

        let dir = unique_test_dir("stored-export-empty-failed");
        let path = dir.join("results.csv");
        let guard = stored.read().unwrap();
        assert!(guard.manual_exportable());
        let error =
            export_stored_run_pages(&guard, &path.display().to_string(), Some("Results"), "csv")
                .unwrap_err();
        assert!(error.contains("no outputs available for export"));
        assert!(!path.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn incomplete_terminal_run_with_committed_rows_can_be_exported() {
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
        stored.write().unwrap().succeed();

        let dir = unique_test_dir("stored-export-incomplete");
        let path = dir.join("results.csv");
        let guard = stored.read().unwrap();
        assert!(!guard.completed_successfully());
        assert!(guard.manual_exportable());
        export_stored_run_pages(&guard, &path.display().to_string(), Some("Results"), "csv")
            .unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "Voltage\n1\n");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn executor_failure_exports_only_rows_committed_before_failure() {
        let template = Template::from_json_str(
            &json!({
                "name": "partial export",
                "tool_instances": [],
                "workflow": {"interaction":{"enabled":false,"max_active_command_status":4096,"buffer":{"enabled":false,"mode":"fifo","overflow_policy":"fail-run"}}, "steps": [{
                    "type": "for",
                    "id": "sweep",
                    "variable": "x",
                    "range": { "start": "1", "stop": "3", "step": "1" },
                    "steps": [
                        {
                            "type": "output",
                            "id": "out",
                            "name": "Voltage",
                            "page": "Results",
                            "value": { "source": "variable", "variable": "x" }
                        },
                        {
                            "type": "assert",
                            "id": "check",
                            "left": { "source": "variable", "variable": "x" },
                            "operator": "less-than",
                            "right": { "source": "literal", "value": 3 },
                            "message": "intentional failure"
                        }
                    ]
                }] }
            })
            .to_string(),
        )
        .unwrap();
        let runs = StoredRuns::default();
        let stored = runs.begin(template.clone());
        let summary = run_workflow_streaming_with_loop_stop(
            &template,
            ExecutionMode::Simulate,
            &Default::default(),
            Duration::from_secs(1),
            Duration::from_secs(1),
            Duration::from_secs(1),
            |event| stored.write().unwrap().append_event(&event),
            |_| false,
        )
        .unwrap();
        assert!(!summary.succeeded());
        stored
            .write()
            .unwrap()
            .fail(summary.failure().unwrap_or("workflow failed"));

        let dir = unique_test_dir("stored-export-executor-failure");
        let path = dir.join("results.csv");
        let guard = stored.read().unwrap();
        assert_eq!(guard.metadata().pages[0].row_count, 2);
        assert!(guard.manual_exportable());
        export_stored_run_pages(&guard, &path.display().to_string(), Some("Results"), "csv")
            .unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "Voltage\n1\n2\n");
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[cfg(test)]
mod regression_tests {
    use super::stored_run::StoredRuns;
    use super::{help_navigation_target, help_url, save_chart_png};
    use crate::unique_test_dir;
    use orchestrator_tool::config::VisaBackend;
    use orchestrator_tool::{
        template::Template,
        workflow::{
            MessageRecord, MessageTarget, ResultRow, StepExecution, StepId, StepOutcome,
            StepResult, WorkflowOutput, WorkflowRunEvent,
        },
    };
    use serde_json::json;

    fn progress_template() -> Template {
        Template::from_json_str(
            &json!({
                "name": "progress",
                "tool_instances": [],
                "workflow": {"interaction":{"enabled":false,"max_active_command_status":4096,"buffer":{"enabled":false,"mode":"fifo","overflow_policy":"fail-run"}}, "steps": [{
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
                help_url("en", theme).unwrap(),
                tauri::WebviewUrl::App(format!("help/desktop.html?theme={theme}").into())
            );
        }
        for theme in ["", "Dark", "auto", "dark&url=https://example.com"] {
            assert!(help_url("en", theme).is_err());
        }
    }

    #[test]
    fn help_language_and_existing_window_navigation() {
        let main = tauri::Url::parse("http://tauri.localhost/index.html").unwrap();
        let current =
            tauri::Url::parse("http://tauri.localhost/help/desktop.html?theme=dark#chapter")
                .unwrap();
        assert!(
            help_navigation_target(&main, &current, &help_url("en", "dark").unwrap())
                .unwrap()
                .is_none()
        );
        for (locale, theme, expected) in [
            ("zh-TW", "dark", "desktop.zh-TW.html?theme=dark"),
            ("en", "light", "desktop.html?theme=light"),
        ] {
            let target = help_navigation_target(&main, &current, &help_url(locale, theme).unwrap())
                .unwrap()
                .unwrap();
            assert_eq!(
                target.as_str(),
                format!("http://tauri.localhost/help/{expected}")
            );
        }
        for locale in [
            "",
            "zh-CN",
            "../desktop.html",
            "en?theme=light",
            "zh-TW/../../file",
        ] {
            assert!(help_url(locale, "dark").is_err());
        }
        let external =
            tauri::Url::parse("https://example.com/help/desktop.html?theme=dark").unwrap();
        assert_eq!(
            help_navigation_target(&main, &external, &help_url("en", "dark").unwrap())
                .unwrap()
                .unwrap()
                .origin(),
            main.origin()
        );
    }

    #[test]
    fn help_navigation_preserves_chapter_and_preferences() {
        let main = tauri::Url::parse("http://tauri.localhost/index.html").unwrap();
        let chapter = tauri::Url::parse(
            "http://tauri.localhost/help/steps-powers.html?theme=dark#power-measure",
        )
        .unwrap();
        assert!(
            help_navigation_target(&main, &chapter, &help_url("en", "dark").unwrap())
                .unwrap()
                .is_none()
        );
        assert_eq!(
            help_navigation_target(&main, &chapter, &help_url("zh-TW", "dark").unwrap())
                .unwrap()
                .unwrap()
                .as_str(),
            "http://tauri.localhost/help/steps-powers.zh-TW.html?theme=dark"
        );
        assert_eq!(
            help_navigation_target(&main, &chapter, &help_url("en", "light").unwrap())
                .unwrap()
                .unwrap()
                .as_str(),
            "http://tauri.localhost/help/steps-powers.html?theme=light"
        );
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
        assert!(!state.request_global(7));
        let control = state.register().unwrap();
        assert!(state.register_manual().is_err());
        assert!(!state.request_global(7));
        *control.run_id.lock().unwrap() = Some(7);
        assert!(!state.request_global(8));
        assert!(state.request_global(7));
        assert!(state.request_global(7));
        assert!(control.workflow_stop.is_requested());
        assert!(state.register().is_err());
        assert!(state.register_manual().is_err());
        assert!(state.request(a.to_string()));
        assert!(!super::consume_loop_stop(&control.loop_stop, &b));
        assert!(super::consume_loop_stop(&control.loop_stop, &a));
        assert!(!super::consume_loop_stop(&control.loop_stop, &a));
        state.clear();
        assert!(!state.request(b.to_string()));
        state.register_manual().unwrap();
        assert!(!state.request_global(7));
        assert!(state.register().is_err());
        assert!(state.register_manual().is_err());
        assert!(!state.request(b.to_string()));
        state.clear();
        let next = state.register().unwrap();
        *next.run_id.lock().unwrap() = Some(8);
        assert!(!state.request_global(7));
        assert!(!next.workflow_stop.is_requested());
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
        batcher.push(&WorkflowRunEvent::MessageEmitted(MessageRecord::new(
            MessageTarget::Message1,
            "hello\n",
        )));
        batcher.flush();
        let messages = messages.lock().unwrap();
        assert_eq!(messages.len(), 1);
        let wire = &messages[0];
        assert_eq!(wire["type"], "progress-batch");
        assert_eq!(wire["run"]["execution_count"], 1);
        assert_eq!(wire["run"]["pages"][0]["row_count"], 1);
        assert_eq!(wire["completed_step_ids"], json!(["out"]));
        // The batch carries per-tab counts and revisions, never the message bodies.
        assert_eq!(
            wire["run"]["messages"][0],
            json!({ "target": "message-1", "total": 1, "revision": 1 })
        );
        assert!(wire["run"].get("messages").is_some_and(|value| {
            value
                .as_array()
                .is_some_and(|list| list.iter().all(|item| item.get("text").is_none()))
        }));
        assert_eq!(wire.as_object().unwrap().len(), 3);
        let run = &wire["run"];
        for field in ["result_rows", "step_executions", "rows", "executions"] {
            assert!(run.get(field).is_none(), "unbounded payload field: {field}");
        }
        assert!(run["pages"][0].get("rows").is_none());
        assert_eq!(run["pages"][0]["summaries"][0]["count"], 1);
        assert_eq!(run["latest_execution"]["step_id"], "out");
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
    fn powers_live_launch_authorization_is_scoped_to_run() {
        use std::ffi::OsString;
        let dir = unique_test_dir("orchestrator-powers-authorization-test");
        let resource = " USB0::Power Serial::INSTR ";
        for (backend, allow_writes) in [
            (VisaBackend::System, true),
            (VisaBackend::Py, true),
            (VisaBackend::Py, false),
        ] {
            let mut spec = orchestrator_tool::adapters::powers::live_worker_launch_spec(
                "powers-tool.exe",
                resource,
            );
            let authorization =
                super::PowersWorkerConfig::prepare(&dir, &mut spec, backend, allow_writes).unwrap();
            let path = authorization.0.clone();
            let settings =
                serde_json::from_slice::<serde_json::Value>(&std::fs::read(&path).unwrap())
                    .unwrap();
            assert_eq!(settings["settings"]["allow_output_writes"], allow_writes);
            assert_eq!(
                settings["settings"]["backend"],
                if backend == VisaBackend::Py {
                    json!("@py")
                } else {
                    serde_json::Value::Null
                }
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
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn referenced_tool_instances_only_selects_used_instances() {
        let template = Template::from_json_str(
            r#"{
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
                "workflow": {"interaction":{"enabled":false,"max_active_command_status":4096,"buffer":{"enabled":false,"mode":"fifo","overflow_policy":"fail-run"}}, "steps": [
                    { "type": "wait", "id": "wait-1", "duration_ms": 1 },
                    { "type": "tool-action", "id": "meter-read-1", "target": "meters-1", "action": "measure", "arguments": {} },
                    { "type": "tool-action", "id": "scope-read-1", "target": "scopes-1", "action": "capture", "arguments": { "channel": [1], "points": 1000 } }
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
}
