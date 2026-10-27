//! Run-scoped streaming ownership and authoritative in-memory captures.
use crate::{
    run_failure::RunFailure,
    tool_instance::ToolInstanceId,
    worker::{WorkerEventError, WorkerLaunchSpec, WorkerSession, start_worker},
    workflow::{ResultRow, WorkflowOutput},
    workflow_csv::ResultRowsCsvWriter,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, VecDeque},
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, mpsc},
    thread::{self, JoinHandle},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub const MONITOR_POINTS: usize = 1_000;
pub const QUERY_LIMIT: usize = 1_000;
pub const CHART_POINTS: usize = 2_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BackgroundAction {
    WorkerOn,
    WorkerOff,
    CaptureOn,
    CaptureOff,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BackgroundXAxis {
    Elapsed,
    Timestamp,
    Index,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BackgroundChart {
    pub x_axis: BackgroundXAxis,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BackgroundConfig {
    pub id: String,
    pub tool_instance_id: ToolInstanceId,
    #[serde(default)]
    pub live_monitor: bool,
    /// Immediate Custom: null selects the Tool's native infinite trigger count.
    pub trigger_count: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chart: Option<BackgroundChart>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BackgroundCsvOptions {
    pub output_folder: PathBuf,
    /// None selects every configured background.
    pub background_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct DatasetMetadata {
    pub id: String,
    pub background_id: String,
    pub worker_run_id: String,
    pub started_ms: u64,
    pub finished_ms: Option<u64>,
    pub status: String,
    pub quality: String,
    pub row_count: usize,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub avg: Option<f64>,
    pub csv_path: Option<String>,
    pub error: Option<String>,
}

pub struct Dataset {
    pub metadata: DatasetMetadata,
    // Never serialized wholesale; readers request bounded windows.
    pub(crate) samples: Vec<Value>,
}

#[derive(Clone, Debug, Serialize)]
pub struct BackgroundStatus {
    pub id: String,
    pub state: String,
    pub stream_state: Option<String>,
    pub live_monitor: bool,
    pub error: Option<String>,
    #[serde(skip)]
    monitor: VecDeque<Value>,
}

#[derive(Default)]
pub struct BackgroundStore {
    pub datasets: Vec<Dataset>,
    pub workers: Vec<BackgroundStatus>,
}

pub type SharedBackgroundStore = Arc<Mutex<BackgroundStore>>;

impl BackgroundStore {
    pub fn dataset(&self, id: &str) -> Result<&Dataset, String> {
        self.datasets
            .iter()
            .find(|d| d.metadata.id == id)
            .ok_or_else(|| "Unknown background dataset".into())
    }
    pub fn metadata(&self) -> Vec<DatasetMetadata> {
        self.datasets.iter().map(|d| d.metadata.clone()).collect()
    }
    pub fn rows(&self, id: &str, offset: usize, limit: usize) -> Result<Vec<Value>, String> {
        Ok(self
            .dataset(id)?
            .samples
            .iter()
            .skip(offset)
            .take(limit.min(QUERY_LIMIT))
            .cloned()
            .collect())
    }
    pub fn chart(&self, id: &str) -> Result<Vec<Value>, String> {
        let samples = &self.dataset(id)?.samples;
        // Even sampling retains the endpoints and never copies a full large capture.
        let count = samples.len().min(CHART_POINTS);
        Ok((0..count)
            .map(|i| {
                samples[if count <= 1 {
                    0
                } else {
                    i * (samples.len() - 1) / (count - 1)
                }]
                .clone()
            })
            .collect())
    }
    pub fn monitor(&self, id: &str) -> Vec<Value> {
        self.workers
            .iter()
            .find(|w| w.id == id && w.live_monitor)
            .map(|w| w.monitor.iter().cloned().collect())
            .unwrap_or_default()
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub const SAMPLE_COLUMNS: [&str; 5] = ["timestamp_utc", "elapsed_s", "captured", "value", "unit"];
fn sample_row(value: &Value) -> ResultRow {
    ResultRow::new(
        SAMPLE_COLUMNS
            .iter()
            .map(|name| WorkflowOutput::new((*name).into(), value[*name].clone()))
            .collect(),
        None,
    )
}

/// Atomically reserve an unused name. Streaming and manual exports share this rule.
pub(crate) fn unique_file(
    folder: &Path,
    stem: &str,
    extension: &str,
) -> Result<(PathBuf, File), String> {
    fs::create_dir_all(folder).map_err(|e| e.to_string())?;
    for suffix in 0_u64.. {
        let name = if suffix == 0 {
            format!("{stem}.{extension}")
        } else {
            format!("{stem}-{suffix}.{extension}")
        };
        let path = folder.join(name);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    unreachable!()
}

enum Command {
    Action(BackgroundAction, bool, mpsc::SyncSender<Result<(), String>>),
    Cleanup(mpsc::SyncSender<Result<(), String>>),
}
struct Runtime {
    sender: mpsc::SyncSender<Command>,
    thread: JoinHandle<()>,
}

pub struct BackgroundManager {
    configs: Vec<BackgroundConfig>,
    specs: HashMap<ToolInstanceId, WorkerLaunchSpec>,
    runtimes: HashMap<String, Runtime>,
    pub store: SharedBackgroundStore,
    pub failure: RunFailure,
    csv: Option<BackgroundCsvOptions>,
    startup: Duration,
    shutdown: Duration,
}

impl BackgroundManager {
    pub fn new(
        configs: &[BackgroundConfig],
        specs: &HashMap<ToolInstanceId, WorkerLaunchSpec>,
        store: SharedBackgroundStore,
        failure: RunFailure,
        csv: Option<BackgroundCsvOptions>,
        startup: Duration,
        shutdown: Duration,
    ) -> Self {
        {
            let mut data = store.lock().unwrap_or_else(|e| e.into_inner());
            data.workers = configs
                .iter()
                .map(|c| BackgroundStatus {
                    id: c.id.clone(),
                    state: "off".into(),
                    stream_state: None,
                    live_monitor: c.live_monitor,
                    error: None,
                    monitor: VecDeque::new(),
                })
                .collect();
        }
        Self {
            configs: configs.to_vec(),
            specs: specs.clone(),
            runtimes: HashMap::new(),
            store,
            failure,
            csv,
            startup,
            shutdown,
        }
    }

    pub fn action(
        &mut self,
        id: &str,
        action: BackgroundAction,
        capture: bool,
    ) -> Result<(), String> {
        self.failure.check()?;
        if action == BackgroundAction::WorkerOn {
            if self.runtimes.contains_key(id) {
                return Err(format!(
                    "{id}: Worker already ON; release it before restarting"
                ));
            }
            let config = self
                .configs
                .iter()
                .find(|c| c.id == id)
                .cloned()
                .ok_or("Unknown Background ID")?;
            if let Some(worker) = self
                .store
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .workers
                .iter_mut()
                .find(|w| w.id == id)
            {
                worker.monitor.clear();
                worker.stream_state = None;
                worker.error = None;
            }
            let spec = self
                .specs
                .get(&config.tool_instance_id)
                .cloned()
                .ok_or("Missing Background launch specification")?;
            let manifest = match spec.manifest() {
                Some(manifest) => manifest.clone(),
                None => crate::adapters::probe_existing_worker_integration(
                    spec.executable(),
                    &crate::tool::ToolId::meters(),
                )?,
            };
            if manifest.tool_id() != &crate::tool::ToolId::meters()
                || manifest.feature("common.streaming").is_none()
            {
                return Err("Background Unsupported by selected Worker Manifest".into());
            }
            let spec = spec.with_manifest(manifest);
            let (sender, receiver) = mpsc::sync_channel(1);
            let (ready_tx, ready_rx) = mpsc::sync_channel(1);
            let mut dispatcher = Dispatcher {
                config,
                store: self.store.clone(),
                failure: self.failure.clone(),
                csv: self.csv.clone(),
                current: None,
                writer: None,
                auto_closed: false,
                stream_state: None,
                total: 0,
                summary: None,
                ended: false,
                first_sample_ms: None,
            };
            let startup = self.startup;
            let shutdown = self.shutdown;
            let thread = thread::Builder::new()
                .name(format!("background-{id}"))
                .spawn(move || {
                    let prepared: Result<WorkerSession, String> = (|| {
                        if capture {
                            dispatcher.capture_on("")?;
                        }
                        let session = start_worker(&spec.with_bounded_events(), startup)
                            .map_err(|e| e.to_string())?;
                        let adoption = &session.ready().features()["common.streaming"];
                        if adoption["contract_version"] != 1
                            || adoption["lifecycles"] != serde_json::json!(["run_bound"])
                        {
                            let _ = session.shutdown(shutdown);
                            return Err("Unsupported Background streaming lifecycle".into());
                        }
                        if let Some(index) = dispatcher.current {
                            dispatcher
                                .store
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .datasets[index]
                                .metadata
                                .worker_run_id = session.ready().run_id().into();
                        }
                        dispatcher.state("on", None);
                        Ok(session)
                    })();
                    match prepared {
                        Ok(session) => {
                            let _ = ready_tx.send(Ok(()));
                            dispatcher.run(session, receiver, shutdown);
                        }
                        Err(error) => {
                            dispatcher.fail(&error);
                            dispatcher.finish("failed", "incomplete", Some(error.clone()));
                            let _ = ready_tx.send(Err(error));
                        }
                    }
                })
                .map_err(|e| e.to_string())?;
            self.runtimes.insert(id.into(), Runtime { sender, thread });
            return ready_rx
                .recv_timeout(self.startup + self.shutdown + Duration::from_secs(1))
                .map_err(|e| e.to_string())?;
        }
        let runtime = self
            .runtimes
            .get(id)
            .ok_or_else(|| format!("{id}: Worker is OFF"))?;
        let (tx, rx) = mpsc::sync_channel(1);
        runtime
            .sender
            .send(Command::Action(action, capture, tx))
            .map_err(|e| e.to_string())?;
        let result = rx
            .recv_timeout(self.shutdown + Duration::from_secs(1))
            .map_err(|e| e.to_string())?;
        if action == BackgroundAction::WorkerOff && result.is_ok() {
            let runtime = self.runtimes.remove(id).unwrap();
            runtime
                .thread
                .join()
                .map_err(|_| "Background dispatcher panicked")?;
        }
        result
    }

    /// Internal cleanup is idempotent, and attempts every background after failure.
    pub fn cleanup(&mut self) -> Result<(), String> {
        let mut errors = Vec::new();
        for (id, runtime) in self.runtimes.drain() {
            let (tx, rx) = mpsc::sync_channel(1);
            if runtime.sender.send(Command::Cleanup(tx)).is_ok() {
                match rx.recv_timeout(self.shutdown + Duration::from_secs(1)) {
                    Ok(Ok(())) => {}
                    Ok(Err(e)) => errors.push(format!("{id}: {e}")),
                    Err(e) => errors.push(format!("{id}: {e}")),
                }
            }
            if runtime.thread.join().is_err() {
                errors.push(format!("{id}: dispatcher panicked"));
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
}

impl Drop for BackgroundManager {
    fn drop(&mut self) {
        let _ = self.cleanup();
    }
}

struct Dispatcher {
    config: BackgroundConfig,
    store: SharedBackgroundStore,
    failure: RunFailure,
    csv: Option<BackgroundCsvOptions>,
    current: Option<usize>,
    writer: Option<ResultRowsCsvWriter<File>>,
    auto_closed: bool,
    stream_state: Option<String>,
    total: usize,
    summary: Option<Value>,
    ended: bool,
    first_sample_ms: Option<i64>,
}

impl Dispatcher {
    fn state(&self, state: &str, error: Option<String>) {
        let mut data = self.store.lock().unwrap_or_else(|e| e.into_inner());
        let worker = data
            .workers
            .iter_mut()
            .find(|w| w.id == self.config.id)
            .unwrap();
        worker.state = state.into();
        worker.stream_state = self.stream_state.clone();
        worker.error = error;
    }
    fn fail(&mut self, error: &str) {
        self.failure.fail(format!("{}: {error}", self.config.id));
        // Keep accepting valid tail samples until bounded shutdown completes.
        if let Some(index) = self.current {
            let mut data = self.store.lock().unwrap_or_else(|e| e.into_inner());
            let metadata = &mut data.datasets[index].metadata;
            metadata.status = "failed".into();
            metadata.quality = "incomplete".into();
            metadata.error = Some(error.into());
        }
        if let Some(writer) = &mut self.writer {
            let _ = writer.finish();
        }
        self.writer = None;
        self.state("failed", Some(error.into()));
    }
    fn capture_on(&mut self, worker_run_id: &str) -> Result<(), String> {
        if self.ended || self.stream_state.as_deref() == Some("ended") {
            return Err("Cannot Capture ON an ended stream; release Worker first".into());
        }
        if self.current.is_some() {
            return Err("Capture already ON".into());
        }
        let mut data = self.store.lock().unwrap_or_else(|e| e.into_inner());
        let id = format!("{}-capture-{}", self.config.id, data.datasets.len() + 1);
        let mut metadata = DatasetMetadata {
            id: id.clone(),
            background_id: self.config.id.clone(),
            worker_run_id: worker_run_id.into(),
            started_ms: now_ms(),
            finished_ms: None,
            status: "recording".into(),
            quality: "unknown".into(),
            row_count: 0,
            min: None,
            max: None,
            avg: None,
            csv_path: None,
            error: None,
        };
        if let Some(options) = &self.csv
            && options
                .background_id
                .as_ref()
                .is_none_or(|id| id == &self.config.id)
        {
            let (path, file) =
                unique_file(&options.output_folder, &format!("{}-{id}", now_ms()), "csv")?;
            metadata.csv_path = Some(path.display().to_string());
            self.writer = Some(
                ResultRowsCsvWriter::new(file, SAMPLE_COLUMNS.map(str::to_owned).to_vec())
                    .map_err(|e| e.to_string())?,
            );
        }
        self.current = Some(data.datasets.len());
        self.auto_closed = false;
        data.datasets.push(Dataset {
            metadata,
            samples: Vec::new(),
        });
        Ok(())
    }
    fn finish(&mut self, status: &str, quality: &str, error: Option<String>) {
        let quality = if quality == "no_loss_detected" {
            self.summary
                .as_ref()
                .and_then(|s| s["data_integrity"].as_str())
                .unwrap_or("unknown")
        } else {
            quality
        };
        let flush_error = self
            .writer
            .as_mut()
            .and_then(|writer| writer.finish().err())
            .map(|e| format!("Background CSV final flush: {e}"));
        if let Some(error) = &flush_error {
            self.failure.fail(error.clone());
        }
        if let Some(index) = self.current.take() {
            let mut data = self.store.lock().unwrap_or_else(|e| e.into_inner());
            let metadata = &mut data.datasets[index].metadata;
            if metadata.status != "failed" {
                metadata.status = if flush_error.is_some() {
                    "failed"
                } else {
                    status
                }
                .into();
                metadata.quality = quality.into();
            }
            if let Some(error) = error.or(flush_error) {
                metadata.error.get_or_insert(error);
            }
            metadata.finished_ms = Some(now_ms());
        }
        self.writer = None;
    }
    fn capture_off(&mut self) -> Result<(), String> {
        if self.current.is_none() {
            if self.auto_closed {
                self.auto_closed = false;
                return Ok(());
            }
            return Err("Capture already OFF".into());
        }
        self.finish("completed", "unknown", None);
        self.failure.check()
    }
    fn event(&mut self, mut event: Value) -> Result<(), String> {
        match event["event"].as_str().unwrap_or("") {
            "status" => {
                self.stream_state = event["stream"]["state"].as_str().map(str::to_owned);
                self.state("on", None);
                if event["worker_state"] == "failed" || !event["fatal_error"].is_null() {
                    return Err(format!("Worker failed: {event}"));
                }
            }
            "sample" => {
                if self.stream_state.as_deref() != Some("active") {
                    return Err("Sample outside active stream".into());
                }
                crate::adapters::meters::validate_background_sample(&event)?;
                let sequence_error = event["captured"].as_u64() != Some((self.total + 1) as u64);
                let timestamp =
                    chrono::DateTime::parse_from_rfc3339(event["timestamp_utc"].as_str().unwrap())
                        .map_err(|e| e.to_string())?
                        .timestamp_millis();
                let first = *self.first_sample_ms.get_or_insert(timestamp);
                event["elapsed_s"] = serde_json::json!((timestamp - first) as f64 / 1000.0);
                self.total += 1;
                {
                    let mut data = self.store.lock().unwrap_or_else(|e| e.into_inner());
                    if self.config.live_monitor {
                        let monitor = &mut data
                            .workers
                            .iter_mut()
                            .find(|w| w.id == self.config.id)
                            .unwrap()
                            .monitor;
                        if monitor.len() == MONITOR_POINTS {
                            monitor.pop_front();
                        }
                        monitor.push_back(event.clone());
                    }
                    if let Some(index) = self.current {
                        let dataset = &mut data.datasets[index];
                        let value = event["value"].as_f64().unwrap();
                        let m = &mut dataset.metadata;
                        m.row_count += 1;
                        m.min = Some(m.min.map_or(value, |v| v.min(value)));
                        m.max = Some(m.max.map_or(value, |v| v.max(value)));
                        m.avg = Some(
                            m.avg
                                .map_or(value, |avg| avg + (value - avg) / m.row_count as f64),
                        );
                        dataset.samples.push(event.clone());
                    }
                }
                if let Some(writer) = &mut self.writer {
                    writer
                        .write_row(&sample_row(&event))
                        .map_err(|e| format!("Background CSV: {e}"))?;
                }
                if sequence_error {
                    return Err(
                        "Meters captured sequence gap or duplicate; received values retained"
                            .into(),
                    );
                }
            }
            "summary" => self.summary = Some(event),
            "error" if event["fatal"] == true => {
                return Err(format!("Worker fatal error: {event}"));
            }
            _ => {}
        }
        Ok(())
    }
    fn stop(&mut self, session: WorkerSession, shutdown: Duration) -> Result<(), String> {
        let worker_run_id = session.ready().run_id().to_owned();
        let mut event_error = None;
        let result = session
            .shutdown_with_events(shutdown, |event| {
                if let Err(error) = self.event(event) {
                    event_error.get_or_insert(error);
                }
            })
            .map_err(|e| e.to_string());
        if let Some(error) = event_error {
            return Err(error);
        }
        let status = result?;
        if !status.success() {
            return Err(format!("Background Worker exit {status}"));
        }
        if self.stream_state.as_deref() != Some("ended") {
            return Err("Background ended evidence missing".into());
        }
        crate::adapters::meters::validate_background_summary(
            self.summary.as_ref().ok_or("Meters summary missing")?,
            self.total,
        )?;
        let quality = self.summary.as_ref().unwrap()["data_integrity"]
            .as_str()
            .unwrap_or("unknown");
        for dataset in &mut self
            .store
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .datasets
        {
            if dataset.metadata.worker_run_id == worker_run_id
                && dataset.metadata.background_id == self.config.id
                && dataset.metadata.status != "failed"
            {
                dataset.metadata.quality = quality.into();
            }
        }
        Ok(())
    }
    fn run(
        &mut self,
        session: WorkerSession,
        receiver: mpsc::Receiver<Command>,
        shutdown: Duration,
    ) {
        let mut session = Some(session);
        loop {
            match receiver.try_recv() {
                Ok(Command::Action(action, capture, reply)) => {
                    let result = match action {
                        BackgroundAction::CaptureOn => self
                            .capture_on(session.as_ref().map(|s| s.ready().run_id()).unwrap_or("")),
                        BackgroundAction::CaptureOff => self.capture_off(),
                        BackgroundAction::WorkerOff => {
                            if capture && self.current.is_none() && !self.auto_closed {
                                Err("Capture already OFF; uncheck simultaneous Capture OFF".into())
                            } else if !capture && self.current.is_some() {
                                Err("Capture is ON; switch it OFF before Worker OFF".into())
                            } else {
                                if let Some(session) = session.take()
                                    && let Err(e) = self.stop(session, shutdown)
                                {
                                    self.fail(&e);
                                    self.finish("failed", "incomplete", Some(e.clone()));
                                    let _ = reply.send(Err(e));
                                    return;
                                }
                                self.auto_closed = false;
                                self.finish("completed", "no_loss_detected", None);
                                self.state("off", None);
                                self.failure.check()
                            }
                        }
                        BackgroundAction::WorkerOn => Err("Worker already ON".into()),
                    };
                    let done = action == BackgroundAction::WorkerOff && result.is_ok();
                    let _ = reply.send(result);
                    if done {
                        return;
                    }
                }
                Ok(Command::Cleanup(reply)) => {
                    let result = session
                        .take()
                        .map(|s| self.stop(s, shutdown))
                        .unwrap_or(Ok(()));
                    if let Err(e) = &result {
                        self.fail(e);
                        self.finish("failed", "incomplete", Some(e.clone()));
                    } else {
                        self.finish("completed", "no_loss_detected", None);
                        self.state("off", None);
                    }
                    let _ = reply.send(result);
                    return;
                }
                Err(mpsc::TryRecvError::Disconnected) => {
                    if let Some(session) = session.take() {
                        let _ = self.stop(session, shutdown);
                    }
                    self.finish("incomplete", "unknown", None);
                    return;
                }
                Err(mpsc::TryRecvError::Empty) => {}
            }
            if let Some(active) = &session {
                match active.recv_event(Duration::from_millis(5)) {
                    Ok(event) => {
                        if let Err(error) = self.event(event) {
                            self.fail(&error);
                            if let Some(s) = session.take() {
                                let _ = self.stop(s, shutdown);
                            }
                            self.finish("failed", "incomplete", Some(error));
                        }
                    }
                    Err(WorkerEventError::Timeout(_)) => {}
                    Err(WorkerEventError::Disconnected) => {
                        let result = self.stop(session.take().unwrap(), shutdown);
                        self.ended = true;
                        match result {
                            Ok(()) => {
                                self.auto_closed = self.current.is_some();
                                self.finish("completed", "no_loss_detected", None);
                                self.state("pending-release", None);
                            }
                            Err(e) => {
                                self.fail(&e);
                                self.finish("failed", "incomplete", Some(e));
                            }
                        }
                    }
                    Err(error) => {
                        self.fail(&error.to_string());
                        if let Some(s) = session.take() {
                            let _ = self.stop(s, shutdown);
                        }
                        self.finish("failed", "incomplete", Some(error.to_string()));
                    }
                }
            } else {
                thread::sleep(Duration::from_millis(5));
            }
        }
    }
}
