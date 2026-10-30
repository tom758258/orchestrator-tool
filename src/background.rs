//! Run-scoped streaming ownership and authoritative in-memory captures.
use crate::{
    run_failure::RunFailure,
    template::Template,
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
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub const MONITOR_POINTS: usize = 1_000;
pub const QUERY_LIMIT: usize = 1_000;
pub const CHART_POINTS: usize = 2_000;
pub const CHART_RAW_LIMIT: usize = 25_000;
const CHART_SCAN_BATCH: usize = 256;

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
pub struct BackgroundChartSource {
    pub kind: BackgroundSourceKind,
    pub background_id: String,
    pub field: String,
    pub x_axis: BackgroundXAxis,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BackgroundSourceKind {
    Background,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BackgroundChartType {
    Line,
    Scatter,
    Column,
    Area,
    Bar,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ChartRange {
    pub min: f64,
    pub max: f64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BackgroundChartQuery {
    pub x_axis: BackgroundXAxis,
    pub chart_type: BackgroundChartType,
    pub range: Option<ChartRange>,
    pub point_budget: usize,
    pub raw: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct BackgroundChartPoint {
    pub x: f64,
    pub value: f64,
    pub sample_index: u64,
    pub timestamp_utc: String,
    pub elapsed_s: f64,
    pub unit: String,
}

#[derive(Debug, Serialize)]
pub struct BackgroundChartSeries {
    pub total_count: usize,
    pub visible_count: usize,
    pub returned_count: usize,
    pub sampled: bool,
    pub raw_limit: usize,
    pub raw_limit_exceeded: bool,
    pub domain: Option<ChartRange>,
    pub points: Vec<BackgroundChartPoint>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BackgroundConfig {
    pub id: String,
    pub tool_instance_id: ToolInstanceId,
    #[serde(default)]
    pub live_monitor: bool,
    /// Simple sample limit or Custom trigger limit; null selects native infinite acquisition.
    pub limit_count: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timer_interval_ms: Option<u64>,
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
    chart_query_gate: Arc<Mutex<()>>,
}

pub type SharedBackgroundStore = Arc<Mutex<BackgroundStore>>;

#[cfg(not(test))]
type CsvDestination = File;
// Keep fault injection private to unit tests; production continues to write File directly.
#[cfg(test)]
type CsvDestination = Box<dyn std::io::Write + Send>;

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

/// Query a stable prefix without copying the Dataset or holding its writer lock
/// for an entire scan. Samples are append-only during a run.
pub fn query_chart(
    store: &SharedBackgroundStore,
    background_id: &str,
    dataset_id: &str,
    query: &BackgroundChartQuery,
) -> Result<BackgroundChartSeries, String> {
    if !(4..=CHART_POINTS).contains(&query.point_budget) {
        return Err(format!(
            "Chart point budget must be between 4 and {CHART_POINTS}"
        ));
    }
    if query
        .range
        .is_some_and(|r| !r.min.is_finite() || !r.max.is_finite() || r.min > r.max)
    {
        return Err("Chart range must contain finite, ordered bounds".into());
    }
    if query.raw && !matches!(query.chart_type, BackgroundChartType::Line) {
        return Err("Show All Raw Data is available for Line only".into());
    }
    // Multiple charts share one scan at a time, leaving the sample writer free
    // to acquire the store between batches. This gate never guards writes.
    let gate = store
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .chart_query_gate
        .clone();
    let _query = gate.lock().unwrap_or_else(|e| e.into_inner());
    let total_count = {
        let store = store.lock().unwrap_or_else(|e| e.into_inner());
        let dataset = store.dataset(dataset_id)?;
        if dataset.metadata.background_id != background_id {
            return Err("Dataset does not belong to the selected Background".into());
        }
        dataset.samples.len()
    };
    let scan = |visit: &mut dyn FnMut(usize, &BackgroundChartPoint)| -> Result<(), String> {
        for start in (0..total_count).step_by(CHART_SCAN_BATCH) {
            let batch = {
                let store = store.lock().unwrap_or_else(|e| e.into_inner());
                let samples = &store.dataset(dataset_id)?.samples;
                samples[start..(start + CHART_SCAN_BATCH).min(total_count)]
                    .iter()
                    .map(|sample| BackgroundChartPoint {
                        x: 0.0,
                        value: sample["value"].as_f64().unwrap_or(f64::NAN),
                        sample_index: sample["captured"].as_u64().unwrap_or_default(),
                        timestamp_utc: sample["timestamp_utc"].as_str().unwrap_or_default().into(),
                        elapsed_s: sample["elapsed_s"].as_f64().unwrap_or(f64::NAN),
                        unit: sample["unit"].as_str().unwrap_or_default().into(),
                    })
                    .collect::<Vec<_>>()
            };
            // Parse and select outside the writer lock. Copy only a bounded batch
            // of chart fields, never the full Dataset or its JSON objects.
            for (offset, mut point) in batch.into_iter().enumerate() {
                point.x = match query.x_axis {
                    BackgroundXAxis::Elapsed => Some(point.elapsed_s),
                    BackgroundXAxis::Index => Some(point.sample_index as f64),
                    BackgroundXAxis::Timestamp => {
                        chrono::DateTime::parse_from_rfc3339(&point.timestamp_utc)
                            .ok()
                            .map(|t| t.timestamp_millis() as f64)
                    }
                }
                .filter(|v| v.is_finite())
                .ok_or("Sample has an invalid chart X value")?;
                if !point.value.is_finite() {
                    return Err("Sample has an invalid numeric value".into());
                }
                visit(start + offset, &point);
            }
        }
        Ok(())
    };
    let visible = |x: f64| query.range.is_none_or(|r| x >= r.min && x <= r.max);
    let mut domain: Option<ChartRange> = None;
    let mut visible_count = 0;
    scan(&mut |_, point| {
        let x = point.x;
        domain = Some(match domain {
            Some(r) => ChartRange {
                min: r.min.min(x),
                max: r.max.max(x),
            },
            None => ChartRange { min: x, max: x },
        });
        if visible(x) {
            visible_count += 1;
        }
    })?;
    let raw_limit_exceeded = query.raw && visible_count > CHART_RAW_LIMIT;
    let budget = if query.raw {
        CHART_RAW_LIMIT
    } else {
        query.point_budget
    };
    let mut chosen: Vec<(usize, BackgroundChartPoint)> =
        Vec::with_capacity(visible_count.min(budget));
    if visible_count > 0 && !raw_limit_exceeded {
        let min_max = !query.raw
            && visible_count > budget
            && matches!(
                query.chart_type,
                BackgroundChartType::Line | BackgroundChartType::Area
            );
        let buckets = (budget - 2) / 2;
        type IndexedPoint = (usize, BackgroundChartPoint);
        let mut extrema: Vec<Option<(IndexedPoint, IndexedPoint)>> = vec![None; buckets];
        let mut ordinal = 0;
        let mut target = 0;
        scan(&mut |index, point| {
            if !visible(point.x) {
                return;
            }
            if visible_count <= budget {
                chosen.push((index, point.clone()));
            } else if min_max {
                if ordinal == 0 || ordinal + 1 == visible_count {
                    chosen.push((index, point.clone()));
                } else {
                    let bucket = (ordinal - 1) * buckets / (visible_count - 2);
                    match &mut extrema[bucket] {
                        None => {
                            let entry = (index, point.clone());
                            extrema[bucket] = Some((entry.clone(), entry));
                        }
                        Some((min, max)) => {
                            if point.value < min.1.value {
                                *min = (index, point.clone());
                            }
                            if point.value > max.1.value {
                                *max = (index, point.clone());
                            }
                        }
                    }
                }
            } else if target < budget && ordinal == target * (visible_count - 1) / (budget - 1) {
                // Discrete charts retain actual representative observations, never aggregates.
                chosen.push((index, point.clone()));
                target += 1;
            }
            ordinal += 1;
        })?;
        for (min, max) in extrema.into_iter().flatten() {
            chosen.extend([min, max]);
        }
        chosen.sort_unstable_by_key(|(index, _)| *index);
        chosen.dedup_by_key(|(index, _)| *index);
    }
    let points: Vec<_> = chosen.into_iter().map(|(_, point)| point).collect();
    Ok(BackgroundChartSeries {
        total_count,
        visible_count,
        returned_count: points.len(),
        sampled: !raw_limit_exceeded && points.len() < visible_count,
        raw_limit: CHART_RAW_LIMIT,
        raw_limit_exceeded,
        domain,
        points,
    })
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
    Cleanup(bool, mpsc::SyncSender<Result<(), String>>),
}
struct Runtime {
    sender: mpsc::SyncSender<Command>,
    thread: JoinHandle<()>,
}

pub struct BackgroundManager {
    configs: Vec<(BackgroundConfig, crate::meters_setup::MetersSetup)>,
    specs: HashMap<ToolInstanceId, WorkerLaunchSpec>,
    runtimes: HashMap<String, Runtime>,
    pub store: SharedBackgroundStore,
    pub failure: RunFailure,
    csv: Option<BackgroundCsvOptions>,
    startup: Duration,
    shutdown: Duration,
    action_timeout: Duration,
    workflow_stop: crate::run::WorkflowStop,
}

impl BackgroundManager {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        template: &Template,
        specs: &HashMap<ToolInstanceId, WorkerLaunchSpec>,
        store: SharedBackgroundStore,
        failure: RunFailure,
        csv: Option<BackgroundCsvOptions>,
        startup: Duration,
        shutdown: Duration,
        action_timeout: Duration,
        workflow_stop: crate::run::WorkflowStop,
    ) -> Self {
        let configs = template.backgrounds();
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
            configs: configs
                .iter()
                .map(|config| {
                    let setup = template
                        .tool_instances()
                        .iter()
                        .find(|instance| instance.id == config.tool_instance_id)
                        .and_then(|instance| instance.meters_setup())
                        .expect("Background Meters setup was validated");
                    (config.clone(), setup.clone())
                })
                .collect(),
            specs: specs.clone(),
            runtimes: HashMap::new(),
            store,
            failure,
            csv,
            startup,
            shutdown,
            action_timeout,
            workflow_stop,
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
            let (config, setup) = self
                .configs
                .iter()
                .find(|(c, _)| c.id == id)
                .cloned()
                .ok_or("Unknown Background ID")?;
            let sample_count = if setup.trigger_mode.is_custom() {
                setup.sample_count
            } else {
                1
            };
            let expected_readings = config
                .limit_count
                .map(|count| {
                    count
                        .checked_mul(sample_count)
                        .ok_or_else(|| format!("{}: expected reading count overflow", config.id))
                })
                .transpose()?;
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
                config: config.clone(),
                expected_readings,
                custom: setup.trigger_mode.is_custom(),
                timer: config_timer(&config, sample_count, self.startup, self.action_timeout)?,
                workflow_stop: self.workflow_stop.clone(),
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
            .recv_timeout(self.action_timeout + self.shutdown + Duration::from_secs(1))
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
        self.cleanup_after_workflow(false)
    }

    pub(crate) fn cleanup_after_workflow(&mut self, stopped: bool) -> Result<(), String> {
        let mut errors = Vec::new();
        for (id, runtime) in self.runtimes.drain() {
            let (tx, rx) = mpsc::sync_channel(1);
            if runtime.sender.send(Command::Cleanup(stopped, tx)).is_ok() {
                match rx.recv_timeout(self.action_timeout + self.shutdown + Duration::from_secs(1))
                {
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

/// One in-flight measurement; only validated source samples advance it.
struct SoftwareTimer {
    interval: Duration,
    batch_size: usize,
    batch_timeout: Duration,
    control_timeout: Duration,
    next_at: Instant,
    pending: Option<(usize, Instant)>,
    ready_deadline: Instant,
    end_deadline: Option<Instant>,
    stopping: bool,
}

fn config_timer(
    config: &BackgroundConfig,
    batch_size: usize,
    startup: Duration,
    action: Duration,
) -> Result<Option<SoftwareTimer>, String> {
    config
        .timer_interval_ms
        .map(|interval| {
            let now = Instant::now();
            let batch_timeout = u32::try_from(batch_size)
                .ok()
                .and_then(|n| action.checked_mul(n))
                .filter(|timeout| now.checked_add(*timeout).is_some())
                .ok_or("Software measurement timeout is too large")?;
            Ok(SoftwareTimer {
                interval: Duration::from_millis(interval),
                batch_size,
                batch_timeout,
                control_timeout: action,
                next_at: now,
                pending: None,
                ready_deadline: now
                    .checked_add(startup)
                    .ok_or("Software startup timeout is too large")?,
                end_deadline: None,
                stopping: false,
            })
        })
        .transpose()
}

impl SoftwareTimer {
    fn sample(&mut self, now: Instant) -> Result<(), String> {
        if self.stopping {
            return Ok(());
        }
        let (remaining, deadline) = self
            .pending
            .as_mut()
            .ok_or("Software sample received without an outstanding trigger")?;
        if now >= *deadline {
            return Err(
                "Software Background timed out waiting for the complete measurement".into(),
            );
        }
        *remaining -= 1;
        if *remaining == 0 {
            self.pending = None;
            self.next_at = now
                .checked_add(self.interval)
                .ok_or("Timer Interval is too large")?;
        }
        Ok(())
    }
}

struct Dispatcher {
    config: BackgroundConfig,
    expected_readings: Option<usize>,
    custom: bool,
    timer: Option<SoftwareTimer>,
    workflow_stop: crate::run::WorkflowStop,
    store: SharedBackgroundStore,
    failure: RunFailure,
    csv: Option<BackgroundCsvOptions>,
    current: Option<usize>,
    writer: Option<ResultRowsCsvWriter<CsvDestination>>,
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
        worker.stream_state = self.stream_state.clone();
        if worker.error.is_some() && error.is_none() {
            return;
        }
        worker.state = state.into();
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
            #[cfg(test)]
            let file = Box::new(file) as CsvDestination;
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
                if self
                    .expected_readings
                    .is_some_and(|count| self.total > count)
                {
                    return Err("Meters produced more samples than configured".into());
                }
                if let Some(timer) = &mut self.timer {
                    timer.sample(Instant::now())?;
                }
            }
            "summary" => self.summary = Some(event),
            "error" => {
                return Err(format!("Worker fatal error: {event}"));
            }
            _ => {}
        }
        Ok(())
    }
    fn stop(
        &mut self,
        session: WorkerSession,
        shutdown: Duration,
        stopped: bool,
    ) -> Result<bool, String> {
        if let Some(timer) = &mut self.timer {
            timer.stopping = true;
        }
        let worker_run_id = session.ready().run_id().to_owned();
        let mut event_error = None;
        let result = session
            .shutdown_background_with_events(shutdown, |event| {
                if let Err(error) = self.event(event) {
                    event_error.get_or_insert(error);
                }
            })
            .map_err(|e| e.to_string());
        if let Some(error) = event_error {
            return Err(error);
        }
        let (status, stop_accepted) = result?;
        if self.stream_state.as_deref() != Some("ended") {
            return Err("Background ended evidence missing".into());
        }
        let summary = self.summary.as_ref().ok_or("Meters summary missing")?;
        if stopped && !stop_accepted && summary["stop_reason"] == "stop_requested" {
            return Err("Background stopped without accepting this workflow's stop request".into());
        }
        let incomplete = if stopped && stop_accepted {
            crate::adapters::meters::validate_stopped_background_summary(
                summary,
                self.total,
                status.code(),
                self.expected_readings,
                self.custom,
            )?
        } else {
            if !status.success() {
                return Err(format!("Background Worker exit {status}"));
            }
            crate::adapters::meters::validate_background_summary(summary, self.total)?;
            if self
                .expected_readings
                .is_some_and(|count| count != self.total)
            {
                return Err("Meters ended before the configured sample count; use Stop Workflow to retain partial data".into());
            }
            false
        };
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
                && !(incomplete && dataset.metadata.status == "completed")
            {
                dataset.metadata.quality = quality.into();
            }
        }
        Ok(incomplete)
    }
    fn tick(&mut self, session: &WorkerSession, allow_trigger: bool) -> Result<(), String> {
        let Some(timer) = &mut self.timer else {
            return Ok(());
        };
        if timer.stopping
            || self.workflow_stop.is_requested()
            || self.failure.check().is_err()
            || self.ended
            || self.stream_state.as_deref() == Some("ended")
        {
            return Ok(());
        }
        let now = Instant::now();
        if self.stream_state.as_deref() != Some("active") {
            return if now >= timer.ready_deadline {
                Err("Software Background timed out waiting to become active".into())
            } else {
                Ok(())
            };
        }
        if let Some((_, deadline)) = timer.pending {
            return if now >= deadline {
                Err("Software Background timed out waiting for the complete measurement".into())
            } else {
                Ok(())
            };
        }
        if self.expected_readings == Some(self.total) {
            let deadline = timer
                .end_deadline
                .get_or_insert(now + timer.control_timeout);
            return if now >= *deadline {
                Err("Software Background timed out waiting for source completion".into())
            } else {
                Ok(())
            };
        }
        if allow_trigger && now >= timer.next_at {
            crate::adapters::meters::trigger_background(session, timer.control_timeout)?;
            timer.pending = Some((timer.batch_size, Instant::now() + timer.batch_timeout));
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
                                    && let Err(e) = self.stop(session, shutdown, false)
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
                Ok(Command::Cleanup(stopped, reply)) => {
                    let result = session
                        .take()
                        .map(|s| self.stop(s, shutdown, stopped))
                        .unwrap_or(Ok(false));
                    if let Err(e) = &result {
                        self.fail(e);
                        self.finish("failed", "incomplete", Some(e.clone()));
                    } else {
                        self.finish(
                            if result == Ok(true) {
                                "incomplete"
                            } else {
                                "completed"
                            },
                            "no_loss_detected",
                            None,
                        );
                        self.state("off", None);
                    }
                    let _ = reply.send(result.map(|_| ()));
                    return;
                }
                Err(mpsc::TryRecvError::Disconnected) => {
                    if let Some(session) = session.take() {
                        let _ = self.stop(session, shutdown, false);
                    }
                    self.finish("incomplete", "unknown", None);
                    return;
                }
                Err(mpsc::TryRecvError::Empty) => {}
            }
            if let Some(active) = &session {
                // Drain queued events before sending another trigger, including ended evidence.
                match active.recv_event(Duration::from_millis(1)) {
                    Ok(event) => {
                        if let Err(error) =
                            self.event(event).and_then(|()| self.tick(active, false))
                        {
                            self.fail(&error);
                            if let Some(s) = session.take() {
                                let _ = self.stop(s, shutdown, false);
                            }
                            self.finish("failed", "incomplete", Some(error));
                        }
                    }
                    Err(WorkerEventError::Timeout(_)) => {
                        if let Err(error) = self.tick(active, true) {
                            self.fail(&error);
                            if let Some(s) = session.take() {
                                let _ = self.stop(s, shutdown, false);
                            }
                            self.finish("failed", "incomplete", Some(error));
                        }
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(WorkerEventError::Disconnected) => {
                        let result = self.stop(session.take().unwrap(), shutdown, false);
                        self.ended = true;
                        match result {
                            Ok(_) => {
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
                            let _ = self.stop(s, shutdown, false);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        run::{ExecutionMode, RunOptions, run_workflow_streaming_controlled},
        template::Template,
        workflow::WorkflowRunEvent,
    };
    use serde_json::json;
    use std::{
        io::{self, Write},
        sync::atomic::{AtomicBool, Ordering},
    };

    #[test]
    fn chart_queries_bound_data_preserve_extrema_and_validate_sources() {
        let count = CHART_RAW_LIMIT + 1;
        let store = SharedBackgroundStore::default();
        store.lock().unwrap().datasets.push(Dataset {
            metadata: DatasetMetadata {
                id: "capture".into(),
                background_id: "background-1".into(),
                worker_run_id: "worker".into(),
                started_ms: 0,
                finished_ms: None,
                status: "recording".into(),
                quality: "unknown".into(),
                row_count: count,
                min: None,
                max: None,
                avg: None,
                csv_path: None,
                error: None,
            },
            samples: (0..count)
                .map(|i| {
                    json!({"timestamp_utc":"2026-10-28T00:00:00.125Z",
                "captured": i + 10, "elapsed_s": i as f64 * 0.003,
                "value": if i == 17 { 100.0 } else if i == 19 { -100.0 } else { 1.0 }, "unit":"V"})
                })
                .collect(),
        });
        let mut query = BackgroundChartQuery {
            x_axis: BackgroundXAxis::Elapsed,
            chart_type: BackgroundChartType::Line,
            range: None,
            point_budget: 50,
            raw: false,
        };
        for chart_type in [
            BackgroundChartType::Line,
            BackgroundChartType::Area,
            BackgroundChartType::Scatter,
            BackgroundChartType::Column,
            BackgroundChartType::Bar,
        ] {
            query.chart_type = chart_type;
            let result = query_chart(&store, "background-1", "capture", &query).unwrap();
            assert!(result.returned_count <= 50 && result.sampled);
            assert_eq!(result.visible_count, count);
            assert_eq!(result.points[0].sample_index, 10);
            assert_eq!(
                result.points.last().unwrap().sample_index,
                (count + 9) as u64
            );
            if matches!(
                chart_type,
                BackgroundChartType::Line | BackgroundChartType::Area
            ) {
                assert!(result.points.iter().any(|point| point.value == 100.0));
                assert!(result.points.iter().any(|point| point.value == -100.0));
            }
        }
        query.chart_type = BackgroundChartType::Line;
        query.raw = true;
        let result = query_chart(&store, "background-1", "capture", &query).unwrap();
        assert!(result.raw_limit_exceeded && !result.sampled && result.points.is_empty());
        query.range = Some(ChartRange {
            min: 0.003,
            max: 0.06,
        });
        let result = query_chart(&store, "background-1", "capture", &query).unwrap();
        assert_eq!(result.returned_count, 20);
        assert_eq!(result.points[0].x, 0.003);
        assert!(!result.sampled && !result.raw_limit_exceeded);
        query.x_axis = BackgroundXAxis::Index;
        query.range = Some(ChartRange {
            min: 11.0,
            max: 12.0,
        });
        let result = query_chart(&store, "background-1", "capture", &query).unwrap();
        assert_eq!(
            result.points.iter().map(|p| p.x).collect::<Vec<_>>(),
            [11.0, 12.0]
        );
        query.x_axis = BackgroundXAxis::Timestamp;
        query.raw = false;
        query.range = None;
        let result = query_chart(&store, "background-1", "capture", &query).unwrap();
        assert_eq!(result.points[0].x, 1_793_145_600_125.0);
        assert!(query_chart(&store, "other", "capture", &query).is_err());
        assert!(query_chart(&store, "background-1", "missing", &query).is_err());
        query.point_budget = CHART_POINTS + 1;
        assert!(query_chart(&store, "background-1", "capture", &query).is_err());
        assert_eq!(store.lock().unwrap().datasets[0].samples.len(), count);
    }

    struct FailingFile {
        file: File,
        armed: Arc<AtomicBool>,
        flush_failure: bool,
    }
    impl Write for FailingFile {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if self.armed.load(Ordering::Relaxed) && !self.flush_failure {
                return Err(io::Error::other("injected CSV write failure"));
            }
            self.file.write(bytes)
        }
        fn flush(&mut self) -> io::Result<()> {
            if self.armed.load(Ordering::Relaxed) && self.flush_failure {
                return Err(io::Error::other("injected CSV flush failure"));
            }
            self.file.flush()
        }
    }

    #[test]
    fn csv_write_and_final_flush_failures_keep_samples_and_fail_the_workflow() {
        for flush_failure in [false, true] {
            let folder = std::env::temp_dir().join(format!(
                "orchestrator-bg-csv-fault-{}-{flush_failure}",
                std::process::id()
            ));
            let config = BackgroundConfig {
                id: "background-1".into(),
                tool_instance_id: ToolInstanceId::new("meter").unwrap(),
                live_monitor: false,
                limit_count: Some(10),
                timer_interval_ms: None,
            };
            let store = SharedBackgroundStore::default();
            let failure = RunFailure::default();
            store.lock().unwrap().workers.push(BackgroundStatus {
                id: config.id.clone(),
                state: "on".into(),
                stream_state: Some("active".into()),
                live_monitor: false,
                error: None,
                monitor: VecDeque::new(),
            });
            let mut dispatcher = Dispatcher {
                config,
                expected_readings: Some(10),
                custom: true,
                timer: None,
                workflow_stop: crate::run::WorkflowStop::default(),
                store: store.clone(),
                failure: failure.clone(),
                csv: Some(BackgroundCsvOptions {
                    output_folder: folder.clone(),
                    background_id: None,
                }),
                current: None,
                writer: None,
                auto_closed: false,
                stream_state: Some("active".into()),
                total: 0,
                summary: None,
                ended: false,
                first_sample_ms: None,
            };
            dispatcher.capture_on("worker").unwrap();
            let path = store.lock().unwrap().metadata()[0]
                .csv_path
                .clone()
                .unwrap();
            dispatcher.writer = None;
            let armed = Arc::new(AtomicBool::new(false));
            dispatcher.writer = Some(
                ResultRowsCsvWriter::new(
                    Box::new(FailingFile {
                        file: File::create(&path).unwrap(),
                        armed: armed.clone(),
                        flush_failure,
                    }) as CsvDestination,
                    SAMPLE_COLUMNS.map(str::to_owned).to_vec(),
                )
                .unwrap(),
            );
            let sample = |captured| {
                json!({"event":"sample", "captured":captured, "value":captured as f64, "unit":"V",
                "status":"ok", "timestamp_utc":"2026-10-27T00:00:00Z"})
            };
            dispatcher.event(sample(1)).unwrap();
            let partial = fs::read_to_string(&path).unwrap();
            assert_eq!(
                csv::Reader::from_reader(partial.as_bytes())
                    .records()
                    .count(),
                1
            );
            let template = Template::from_json_str(&json!({"schema_version":2,"name":"CSV failure", "tool_instances":[],
                "workflow":{"steps":[{"type":"for","id":"loop","variable":"i","range":{"start":"0","stop":"2","step":"1"},
                    "steps":[{"type":"output","id":"out","name":"value","page":"Results","value":{"source":"literal","value":1}}]},
                    {"type":"wait","id":"after-loop","duration_ms":0}]}}).to_string()).unwrap();
            let mut committed = Vec::new();
            let mut completed = Vec::new();
            let mut graceful_stop_called = false;
            let result = run_workflow_streaming_controlled(
                &template,
                ExecutionMode::Simulate,
                &HashMap::new(),
                Duration::from_secs(1),
                Duration::from_secs(1),
                Duration::from_secs(1),
                None,
                RunOptions {
                    failure: failure.clone(),
                    ..Default::default()
                },
                |event| {
                    if let WorkflowRunEvent::StepCompleted(step) = &event {
                        completed.push(step.step_id().as_str().to_owned());
                    }
                    if let WorkflowRunEvent::ResultRowCommitted(row) = event {
                        committed.push(row);
                        armed.store(true, Ordering::Relaxed);
                        if flush_failure {
                            assert!(
                                dispatcher
                                    .capture_off()
                                    .unwrap_err()
                                    .contains("CSV final flush")
                            );
                        } else {
                            let error = dispatcher.event(sample(2)).unwrap_err();
                            assert!(error.contains("injected CSV write failure"));
                            dispatcher.fail(&error);
                            // The normal dispatcher retains valid tail data during shutdown.
                            dispatcher.event(sample(3)).unwrap();
                            dispatcher.finish("failed", "incomplete", Some(error));
                        }
                    }
                },
                |_| {
                    graceful_stop_called = true;
                    false
                },
            );
            assert!(result.unwrap_err().to_string().contains(if flush_failure {
                "CSV final flush"
            } else {
                "CSV:"
            }));
            assert_eq!(committed.len(), 1);
            assert_eq!(completed.iter().filter(|id| *id == "out").count(), 1);
            assert!(!completed.iter().any(|id| id == "after-loop"));
            assert!(!graceful_stop_called);
            let data = store.lock().unwrap();
            let metadata = &data.metadata()[0];
            assert_eq!(metadata.status, "failed");
            assert!(metadata.finished_ms.is_some());
            assert!(metadata.error.is_some());
            assert_eq!(
                data.rows(&metadata.id, 0, 10).unwrap().len(),
                if flush_failure { 1 } else { 3 }
            );
            assert_eq!(fs::read_to_string(&path).unwrap(), partial);
            drop(data);
            drop(dispatcher);
            fs::remove_dir_all(folder).unwrap();
        }
    }
}
