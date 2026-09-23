use std::{
    error::Error,
    ffi::OsString,
    fmt,
    path::Path,
    process::ExitStatus,
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    config::Config,
    discovery::{ExecutableStatus, built_in_tool_definitions},
    inspection::inspect_tool,
    meters_setup::{
        AutoZero, DcvInputImpedance, MetersMeasurement, MetersSetup, MetersTriggerMode, RangeMode,
    },
    process::{CaptureError, run_output_with_timeout},
    tool::ToolId,
    worker::{
        WorkerEventError, WorkerLaunchSpec, WorkerReady, WorkerSession, WorkerShutdownError,
        WorkerStartError, start_worker,
    },
    worker_http::{WorkerClient, WorkerHttpError},
    workflow::ActionId,
};

const WORKER_SCHEMA_VERSION: u32 = 2;
const SERVICE_NAME: &str = "keysight-meter";
const SOFTWARE_TRIGGER_COMMAND: &str = "software_trigger";
const SMOKE_JOB_ID: &str = "orchestrator-meter-smoke";
const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// Manual ranges advertised by meters-tool for one measurement.
#[derive(Debug, Deserialize, Serialize)]
pub struct MetersRangeOptions {
    pub measurement_name: String,
    pub range_values: Vec<f64>,
}

/// Integer limits advertised by meters-tool capabilities.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct MetersIntegerLimit {
    pub min: usize,
    pub max: usize,
}

/// Capability limits used by the Desktop Meters setup UI.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct MetersCapabilityLimits {
    pub buffer_drain_size: MetersIntegerLimit,
    pub sample_count: MetersIntegerLimit,
    pub trigger_count: MetersIntegerLimit,
}

/// Measurement capabilities used by Orchestrator.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct MetersMeasurementCapabilities {
    pub measurement_name: String,
    pub range_values: Vec<f64>,
    pub nplc_values: Vec<f64>,
}

/// Model capabilities used by Orchestrator without duplicating meters-tool policy.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct MetersCapabilities {
    pub model: String,
    pub model_id: String,
    pub reading_memory_limit: usize,
    pub trigger_modes: Vec<String>,
    pub limits: MetersCapabilityLimits,
    pub measurements: Vec<MetersMeasurementCapabilities>,
}

/// Queries offline model capabilities using the configured executable.
///
/// A missing model queries the executable without `--model` so meters-tool
/// uses its own default fallback profile.
pub fn get_capabilities(
    application_dir: &Path,
    config: &Config,
    model: Option<&str>,
) -> Result<MetersCapabilities, String> {
    let definition = built_in_tool_definitions()
        .into_iter()
        .find(|definition| definition.id() == &ToolId::meters())
        .expect("meters is built in");
    let inspection = inspect_tool(application_dir, config, &definition)
        .map_err(|error| format!("meters executable inspection failed: {error}"))?;
    if inspection.status() != ExecutableStatus::Available {
        return Err(format!(
            "meters executable is unavailable: {}",
            inspection
                .resolved()
                .path()
                .map(|path| path.display().to_string())
                .unwrap_or_else(|| "not configured".to_owned())
        ));
    }
    let mut arguments = vec![OsString::from("capabilities"), OsString::from("--json")];
    if let Some(model) = model {
        arguments.push(OsString::from("--model"));
        arguments.push(OsString::from(model));
    }
    let output = run_output_with_timeout(
        inspection
            .resolved()
            .path()
            .expect("available executable has a path"),
        arguments,
        Duration::from_secs(10),
    )
    .map_err(|error| match error {
        CaptureError::Io(error) => format!("meters capabilities query failed: {error}"),
        CaptureError::Timeout => "meters capabilities query timed out after 10 seconds".to_owned(),
    })?;
    if !output.status.success() {
        return Err(format!(
            "meters capabilities query failed with {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    parse_capabilities(&output.stdout)
}

/// Backward-compatible range-only projection for callers that do not need full capabilities.
pub fn get_range_options(
    application_dir: &Path,
    config: &Config,
    model: Option<&str>,
) -> Result<Vec<MetersRangeOptions>, String> {
    Ok(get_capabilities(application_dir, config, model)?
        .measurements
        .into_iter()
        .map(|measurement| MetersRangeOptions {
            measurement_name: measurement.measurement_name,
            range_values: measurement.range_values,
        })
        .collect())
}

fn parse_capabilities(stdout: &[u8]) -> Result<MetersCapabilities, String> {
    #[derive(Deserialize)]
    struct CapabilityProfile {
        model: String,
        model_id: String,
        reading_memory_limit: usize,
    }

    #[derive(Deserialize)]
    struct Capabilities {
        schema_version: u32,
        event: String,
        capability_profile: CapabilityProfile,
        limits: MetersCapabilityLimits,
        measurements: Vec<MetersMeasurementCapabilities>,
        trigger_modes: Vec<String>,
    }

    let response: Capabilities = serde_json::from_slice(stdout)
        .map_err(|error| format!("meters capabilities returned invalid JSON or shape: {error}"))?;
    if response.schema_version != 2 || response.event != "capabilities" {
        return Err(
            "meters capabilities expected schema_version 2 and event capabilities".to_owned(),
        );
    }
    Ok(MetersCapabilities {
        model: response.capability_profile.model,
        model_id: response.capability_profile.model_id,
        reading_memory_limit: response.capability_profile.reading_memory_limit,
        trigger_modes: response.trigger_modes,
        limits: response.limits,
        measurements: response.measurements,
    })
}

/// Maps setup to `meters-tool start-trigger-record` setup arguments.
/// Call [`MetersSetup::validate`] before using this mapping.
///
/// # Panics
/// Panics if manual range mode has no range value.
pub fn setup_arguments(setup: &MetersSetup) -> Vec<OsString> {
    let mut arguments = vec![
        OsString::from("--measurement"),
        OsString::from(match setup.measurement {
            MetersMeasurement::VoltageDc => "voltage-dc",
            MetersMeasurement::CurrentDc => "current-dc",
        }),
        OsString::from("--auto-range"),
        OsString::from(match setup.range_mode {
            RangeMode::Auto => "on",
            RangeMode::Manual => "off",
        }),
    ];
    if setup.range_mode == RangeMode::Manual {
        arguments.extend([
            OsString::from("--range"),
            OsString::from(
                setup
                    .manual_range
                    .expect("validated manual range mode requires a range")
                    .to_string(),
            ),
        ]);
    }
    arguments.extend([
        OsString::from("--nplc"),
        OsString::from(setup.nplc.to_string()),
        OsString::from("--auto-zero"),
        OsString::from(match setup.auto_zero {
            AutoZero::On => "on",
            AutoZero::Off => "off",
            AutoZero::Once => "once",
        }),
    ]);
    match setup.measurement {
        MetersMeasurement::VoltageDc => {
            if let Some(impedance) = setup.dcv_input_impedance {
                arguments.extend([
                    OsString::from("--dcv-input-impedance"),
                    OsString::from(match impedance {
                        DcvInputImpedance::Default => "default",
                        DcvInputImpedance::TenMegohm => "10m",
                        DcvInputImpedance::Auto => "auto",
                    }),
                ]);
            }
        }
        MetersMeasurement::CurrentDc => {
            if let Some(terminal) = setup.current_terminal {
                arguments.extend([
                    OsString::from("--current-terminal"),
                    OsString::from(terminal.to_string()),
                ]);
            }
        }
    }
    arguments
}

fn trigger_arguments(limit: Option<usize>, setup: &MetersSetup) -> Vec<OsString> {
    match setup.trigger_mode {
        MetersTriggerMode::Software => {
            [OsString::from("--trigger-mode"), OsString::from("software")]
                .into_iter()
                .chain(limit.into_iter().flat_map(|limit| {
                    [
                        OsString::from("--max-samples"),
                        OsString::from(limit.to_string()),
                    ]
                }))
                .collect()
        }
        mode => {
            let trigger_count = limit.expect("Custom Meters mode requires a planned trigger count");
            let mode = match mode {
                MetersTriggerMode::SoftwareCustom => "software-custom",
                MetersTriggerMode::ImmediateCustom => "immediate-custom",
                MetersTriggerMode::ExternalCustom => "external-custom",
                MetersTriggerMode::Software => unreachable!(),
            };
            let mut arguments = vec![
                OsString::from("--trigger-mode"),
                OsString::from(mode),
                OsString::from("--trigger-count"),
                OsString::from(trigger_count.to_string()),
                OsString::from("--sample-count"),
                OsString::from(setup.sample_count.to_string()),
            ];
            if let Some(size) = setup.buffer_drain_size {
                arguments.extend([
                    OsString::from("--buffer-drain-size"),
                    OsString::from(size.to_string()),
                ]);
            }
            if setup.allow_buffer_overflow_risk {
                arguments.push(OsString::from("--allow-buffer-overflow-risk"));
            }
            arguments
        }
    }
}

/// Builds a simulate Worker launch specification from a validated setup.
pub fn simulate_worker_launch_spec(
    executable: impl AsRef<Path>,
    max_samples: Option<usize>,
    setup: &MetersSetup,
) -> WorkerLaunchSpec {
    WorkerLaunchSpec::new(
        executable.as_ref(),
        [
            OsString::from("start-trigger-record"),
            OsString::from("--resource"),
            OsString::from("SIM::34461A"),
            OsString::from("--simulate"),
        ]
        .into_iter()
        .chain(trigger_arguments(max_samples, setup))
        .chain([
            OsString::from("--status-format"),
            OsString::from("jsonl"),
            OsString::from("--sw-trigger-port"),
            OsString::from("0"),
            OsString::from("--no-csv"),
        ])
        .chain(setup_arguments(setup)),
    )
}

/// Builds live Worker launch details from a validated setup and exact resource.
pub fn live_worker_launch_spec(
    executable: impl AsRef<Path>,
    resource: &str,
    max_samples: Option<usize>,
    setup: &MetersSetup,
) -> WorkerLaunchSpec {
    WorkerLaunchSpec::new(
        executable.as_ref(),
        [
            OsString::from("start-trigger-record"),
            OsString::from("--resource"),
            OsString::from(resource),
        ]
        .into_iter()
        .chain(trigger_arguments(max_samples, setup))
        .chain([
            OsString::from("--status-format"),
            OsString::from("jsonl"),
            OsString::from("--sw-trigger-port"),
            OsString::from("0"),
            OsString::from("--no-csv"),
        ])
        .chain(setup_arguments(setup)),
    )
}

/// Runs the bounded Meters simulate Worker diagnostic.
pub fn run_worker_smoke(
    executable: impl AsRef<Path>,
    startup_timeout: Duration,
    operation_timeout: Duration,
    shutdown_timeout: Duration,
) -> Result<(), MetersSmokeError> {
    let setup = MetersSetup {
        measurement: MetersMeasurement::VoltageDc,
        range_mode: RangeMode::Auto,
        manual_range: None,
        nplc: 1.0,
        auto_zero: AutoZero::On,
        dcv_input_impedance: None,
        current_terminal: None,
        ..MetersSetup::default()
    };
    let spec = simulate_worker_launch_spec(executable, Some(2), &setup);
    let session = start_worker(&spec, startup_timeout).map_err(MetersSmokeError::Startup)?;
    let operation = run_smoke_operation(session.ready(), operation_timeout);
    let shutdown = session.shutdown(shutdown_timeout);

    match (operation, shutdown) {
        (Ok(()), Ok(status)) if status.success() => Ok(()),
        (Ok(()), Ok(status)) => Err(MetersSmokeError::WorkerExit(status)),
        (Ok(()), Err(error)) => Err(MetersSmokeError::Shutdown(error)),
        (Err(operation), Ok(status)) if !status.success() => {
            Err(MetersSmokeError::OperationAndWorkerExit {
                operation: operation.to_string(),
                status,
            })
        }
        (Err(error), Ok(_)) => Err(error),
        (Err(operation), Err(shutdown)) => Err(MetersSmokeError::OperationAndShutdown {
            operation: operation.to_string(),
            shutdown,
        }),
    }
}

fn run_smoke_operation(
    ready: &WorkerReady,
    operation_timeout: Duration,
) -> Result<(), MetersSmokeError> {
    let deadline = Instant::now() + operation_timeout;
    let client = WorkerClient::new(ready);

    let status = client
        .status_with_timeout(remaining(deadline, operation_timeout)?)
        .map_err(MetersSmokeError::Http)?;
    parse_status(status, ready)?;

    let (http_status, response) = client
        .command_with_timeout(
            &software_trigger_request(),
            remaining(deadline, operation_timeout)?,
        )
        .map_err(MetersSmokeError::Http)?;
    validate_accepted_response(http_status, response)?;

    loop {
        let status = client
            .status_with_timeout(remaining(deadline, operation_timeout)?)
            .map_err(MetersSmokeError::Http)?;
        let status = parse_status(status, ready)?;
        if status.captured.is_some_and(|captured| captured >= 1) {
            return Ok(());
        }

        let wait = POLL_INTERVAL.min(remaining(deadline, operation_timeout)?);
        thread::sleep(wait);
    }
}

fn remaining(deadline: Instant, timeout: Duration) -> Result<Duration, MetersSmokeError> {
    let now = Instant::now();
    if now >= deadline {
        return Err(MetersSmokeError::OperationTimeout(timeout));
    }
    Ok(deadline.saturating_duration_since(now))
}

fn software_trigger_request() -> Value {
    json!({
        "schema_version": WORKER_SCHEMA_VERSION,
        "command": SOFTWARE_TRIGGER_COMMAND,
        "job_id": SMOKE_JOB_ID
    })
}

#[derive(Deserialize)]
struct StatusResponse {
    schema_version: u32,
    service: String,
    run_id: String,
    status: String,
    captured: Option<u64>,
    #[serde(default)]
    fatal_error: Option<String>,
}

#[derive(Deserialize)]
struct AcceptedResponse {
    schema_version: u32,
    status: String,
    command: String,
    job_id: String,
}

fn parse_status(value: Value, ready: &WorkerReady) -> Result<StatusResponse, MetersSmokeError> {
    let status: StatusResponse = serde_json::from_value(value)
        .map_err(|error| MetersSmokeError::InvalidResponse(error.to_string()))?;

    if status.schema_version != WORKER_SCHEMA_VERSION {
        return Err(MetersSmokeError::InvalidResponse(format!(
            "status schema_version was {}, expected {WORKER_SCHEMA_VERSION}",
            status.schema_version
        )));
    }
    if status.service != SERVICE_NAME {
        return Err(MetersSmokeError::InvalidResponse(format!(
            "status service was {:?}, expected {SERVICE_NAME:?}",
            status.service
        )));
    }
    if status.run_id != ready.run_id() {
        return Err(MetersSmokeError::InvalidResponse(format!(
            "status run_id was {:?}, expected {:?}",
            status.run_id,
            ready.run_id()
        )));
    }
    if let Some(detail) = status
        .fatal_error
        .as_deref()
        .map(str::trim)
        .filter(|detail| !detail.is_empty())
    {
        return Err(MetersSmokeError::WorkerFatal(detail.to_owned()));
    }
    if status.status == "error" {
        return Err(MetersSmokeError::WorkerFatal(
            "Worker status is error".to_owned(),
        ));
    }

    Ok(status)
}

fn validate_accepted_response(http_status: u16, value: Value) -> Result<(), MetersSmokeError> {
    if http_status != 202 {
        return Err(MetersSmokeError::InvalidResponse(format!(
            "software_trigger returned HTTP {http_status}, expected 202"
        )));
    }

    let accepted: AcceptedResponse = serde_json::from_value(value)
        .map_err(|error| MetersSmokeError::InvalidResponse(error.to_string()))?;
    if accepted.schema_version != WORKER_SCHEMA_VERSION
        || accepted.status != "accepted"
        || accepted.command != SOFTWARE_TRIGGER_COMMAND
        || accepted.job_id != SMOKE_JOB_ID
    {
        return Err(MetersSmokeError::InvalidResponse(
            "software_trigger acceptance payload did not match the Meters Worker contract"
                .to_owned(),
        ));
    }

    Ok(())
}

/// Errors from the Meters Worker smoke diagnostic.
#[derive(Debug)]
pub enum MetersSmokeError {
    Startup(WorkerStartError),
    Http(WorkerHttpError),
    InvalidResponse(String),
    WorkerFatal(String),
    OperationTimeout(Duration),
    Shutdown(WorkerShutdownError),
    WorkerExit(ExitStatus),
    OperationAndWorkerExit {
        operation: String,
        status: ExitStatus,
    },
    OperationAndShutdown {
        operation: String,
        shutdown: WorkerShutdownError,
    },
}

impl fmt::Display for MetersSmokeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Startup(error) => write!(formatter, "Meters Worker startup failed: {error}"),
            Self::Http(error) => write!(formatter, "Meters Worker HTTP failed: {error}"),
            Self::InvalidResponse(reason) => {
                write!(formatter, "invalid Meters Worker response: {reason}")
            }
            Self::WorkerFatal(detail) => write!(formatter, "Meters Worker fatal error: {detail}"),
            Self::OperationTimeout(timeout) => {
                write!(formatter, "Meters Worker check timed out after {timeout:?}")
            }
            Self::Shutdown(error) => write!(formatter, "Meters Worker shutdown failed: {error}"),
            Self::WorkerExit(status) => write!(formatter, "Meters Worker exited with {status}"),
            Self::OperationAndWorkerExit { operation, status } => write!(
                formatter,
                "Meters Worker check failed: {operation}; Worker also exited with {status}"
            ),
            Self::OperationAndShutdown {
                operation,
                shutdown,
            } => write!(
                formatter,
                "Meters Worker check failed: {operation}; shutdown also failed: {shutdown}"
            ),
        }
    }
}

impl Error for MetersSmokeError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Startup(source) => Some(source),
            Self::Http(source) => Some(source),
            Self::Shutdown(source) => Some(source),
            Self::OperationAndShutdown { shutdown, .. } => Some(shutdown),
            Self::InvalidResponse(_)
            | Self::WorkerFatal(_)
            | Self::OperationTimeout(_)
            | Self::WorkerExit(_)
            | Self::OperationAndWorkerExit { .. } => None,
        }
    }
}

/// Runs a single runtime Meters action on an already-started Worker session.
///
/// The default Single setup sends `software_trigger`. Custom behavior follows
/// the configured trigger mode: Software Custom sends the trigger, while
/// Immediate Custom and External Custom only consume Worker sample events.
/// Software-trigger requests contain no `context` or `job_id` field.
pub fn run_action(
    session: &WorkerSession,
    action: &ActionId,
    arguments: &Value,
    timeout: Duration,
) -> Result<Value, MetersActionError> {
    run_action_with_setup(session, action, arguments, &MetersSetup::default(), timeout)
}

/// Runs a Meters action using the configured trigger mode.
pub fn run_action_with_setup(
    session: &WorkerSession,
    action: &ActionId,
    arguments: &Value,
    setup: &MetersSetup,
    timeout: Duration,
) -> Result<Value, MetersActionError> {
    if action.as_str() != "measure" {
        return Err(MetersActionError::UnsupportedAction(action.clone()));
    }
    validate_measure_arguments(arguments)?;

    let client = WorkerClient::new(session.ready());

    if setup.trigger_mode.uses_software_trigger() {
        let command_deadline = Instant::now() + timeout;
        let request = json!({
            "schema_version": WORKER_SCHEMA_VERSION,
            "command": SOFTWARE_TRIGGER_COMMAND,
            "arguments": {}
        });

        let remaining =
            remaining_duration(command_deadline).ok_or(MetersActionError::Timeout(timeout))?;
        let (http_status, response) = client
            .command_with_timeout(&request, remaining)
            .map_err(MetersActionError::Http)?;
        validate_runtime_accepted_response(http_status, response)?;
    }

    let expected_samples = if setup.trigger_mode.is_custom() {
        setup.sample_count
    } else {
        1
    };
    let mut sample_deadline = Instant::now() + timeout;
    let mut samples = Vec::with_capacity(expected_samples);
    loop {
        let Some(remaining) = remaining_duration(sample_deadline) else {
            return Err(MetersActionError::Timeout(timeout));
        };
        match session.recv_event(remaining) {
            Ok(value) => match classify_meters_event(&value, session.ready().run_id()) {
                MetersEventDecision::Continue => {}
                MetersEventDecision::Success(sample) => {
                    samples.push(sample);
                    if samples.len() == expected_samples {
                        return Ok(if setup.trigger_mode.is_custom() {
                            Value::Array(samples)
                        } else {
                            samples.pop().unwrap()
                        });
                    }
                    if setup.trigger_mode.is_custom() {
                        sample_deadline = Instant::now() + timeout;
                    }
                }
                MetersEventDecision::Failure(error) => return Err(error),
            },
            Err(WorkerEventError::Timeout(_)) => {
                return Err(MetersActionError::Timeout(timeout));
            }
            Err(WorkerEventError::Disconnected) => {
                return Err(MetersActionError::Disconnected);
            }
            Err(WorkerEventError::Io(error)) => {
                return Err(MetersActionError::Io(error));
            }
            Err(WorkerEventError::InvalidJson(error)) => {
                return Err(MetersActionError::InvalidResponse(error.to_string()));
            }
        }
    }
}

fn validate_measure_arguments(arguments: &Value) -> Result<(), MetersActionError> {
    let object = arguments.as_object().ok_or_else(|| {
        MetersActionError::InvalidArguments("arguments must be a JSON object".to_owned())
    })?;
    if !object.is_empty() {
        return Err(MetersActionError::InvalidArguments(
            "unexpected argument field".to_owned(),
        ));
    }
    Ok(())
}

fn validate_runtime_accepted_response(
    http_status: u16,
    value: Value,
) -> Result<(), MetersActionError> {
    if http_status != 202 {
        return Err(MetersActionError::InvalidResponse(format!(
            "software_trigger returned HTTP {http_status}, expected 202"
        )));
    }
    // Allow job_id to be null or string for runtime; only validate common fields.
    let accepted: RuntimeAcceptedResponse = serde_json::from_value(value)
        .map_err(|error| MetersActionError::InvalidResponse(error.to_string()))?;
    if accepted.schema_version != WORKER_SCHEMA_VERSION
        || accepted.status != "accepted"
        || accepted.command != SOFTWARE_TRIGGER_COMMAND
    {
        return Err(MetersActionError::InvalidResponse(
            "software_trigger acceptance payload did not match the Meters Worker contract"
                .to_owned(),
        ));
    }
    Ok(())
}

#[derive(Deserialize)]
struct RuntimeAcceptedResponse {
    schema_version: u32,
    status: String,
    command: String,
    #[serde(default)]
    #[allow(dead_code)]
    job_id: Option<String>,
}

enum MetersEventDecision {
    Continue,
    Success(Value),
    Failure(MetersActionError),
}

fn classify_meters_event(value: &Value, expected_run_id: &str) -> MetersEventDecision {
    let event = value.get("event").and_then(Value::as_str).unwrap_or("");
    match event {
        "sample" => match value.get("run_id").and_then(Value::as_str) {
            Some(run_id) if run_id == expected_run_id => {
                MetersEventDecision::Success(value.clone())
            }
            Some(run_id) => MetersEventDecision::Failure(MetersActionError::InvalidResponse(
                format!("sample run_id mismatch: expected {expected_run_id:?}, got {run_id:?}"),
            )),
            None => MetersEventDecision::Failure(MetersActionError::InvalidResponse(
                "sample missing run_id".to_owned(),
            )),
        },
        "error" => {
            let detail = extract_meters_diagnostic(value)
                .unwrap_or_else(|| "Meters Worker reported error".to_owned());
            MetersEventDecision::Failure(MetersActionError::WorkerFatal(detail))
        }
        "summary" => {
            if let Some(detail) = extract_meters_diagnostic(value) {
                MetersEventDecision::Failure(MetersActionError::WorkerFatal(detail))
            } else {
                MetersEventDecision::Failure(MetersActionError::InvalidResponse(
                    "Meters Worker ended before producing a sample".to_owned(),
                ))
            }
        }
        "status" | "message" => MetersEventDecision::Continue,
        _ => MetersEventDecision::Continue,
    }
}

fn extract_meters_diagnostic(value: &Value) -> Option<String> {
    if let Some(message) = value
        .get("message")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return Some(message.to_owned());
    }
    if let Some(fatal) = value.get("fatal_error") {
        if let Some(text) = fatal.as_str().map(str::trim).filter(|s| !s.is_empty()) {
            return Some(text.to_owned());
        }
        if let Some(object) = fatal.as_object() {
            if let Some(message) = object
                .get("message")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                return Some(message.to_owned());
            }
            if let Some(code) = object
                .get("code")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                return Some(code.to_owned());
            }
        }
    }
    None
}

fn remaining_duration(deadline: Instant) -> Option<Duration> {
    let now = Instant::now();
    if now >= deadline {
        None
    } else {
        Some(deadline.saturating_duration_since(now))
    }
}

/// Errors from Meters runtime action execution.
#[derive(Debug)]
pub enum MetersActionError {
    UnsupportedAction(ActionId),
    InvalidArguments(String),
    Http(WorkerHttpError),
    InvalidResponse(String),
    Timeout(Duration),
    Disconnected,
    Io(std::io::Error),
    WorkerFatal(String),
}

impl fmt::Display for MetersActionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedAction(action) => {
                write!(formatter, "unsupported Meters action {action}")
            }
            Self::InvalidArguments(reason) => {
                write!(formatter, "invalid Meters arguments: {reason}")
            }
            Self::Http(error) => write!(formatter, "Meters Worker HTTP failed: {error}"),
            Self::InvalidResponse(reason) => {
                write!(formatter, "invalid Meters Worker response: {reason}")
            }
            Self::Timeout(timeout) => {
                write!(
                    formatter,
                    "Meters runtime action timed out after {timeout:?}"
                )
            }
            Self::Disconnected => write!(formatter, "Meters Worker event channel disconnected"),
            Self::Io(error) => write!(formatter, "Meters Worker event I/O error: {error}"),
            Self::WorkerFatal(detail) => write!(formatter, "Meters Worker fatal error: {detail}"),
        }
    }
}

impl Error for MetersActionError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Http(source) => Some(source),
            Self::Io(source) => Some(source),
            Self::UnsupportedAction(_)
            | Self::InvalidArguments(_)
            | Self::InvalidResponse(_)
            | Self::Timeout(_)
            | Self::Disconnected
            | Self::WorkerFatal(_) => None,
        }
    }
}

#[cfg(test)]
mod tests {
    fn capabilities_payload(event: &str, schema_version: u32) -> String {
        serde_json::json!({
            "schema_version": schema_version,
            "event": event,
            "capability_profile": {
                "model": "34461A",
                "model_id": "keysight-34461a",
                "reading_memory_limit": 10000,
                "other": true
            },
            "limits": {
                "buffer_drain_size": { "min": 1, "max": 10000 },
                "sample_count": { "min": 1, "max": 1000000 },
                "trigger_count": { "min": 1, "max": 1000000 },
                "other": { "min": 0, "max": 1 }
            },
            "measurements": [
                {
                    "measurement_name": "voltage-dc",
                    "range_values": [0.1, 10],
                    "nplc_values": [0.02, 0.2, 1],
                    "other": true
                },
                {
                    "measurement_name": "current-dc",
                    "range_values": [0.0001, 0.001],
                    "nplc_values": [0.02, 1]
                }
            ],
            "trigger_modes": [
                "software", "immediate", "immediate-custom",
                "software-custom", "external-custom"
            ],
            "other": true
        })
        .to_string()
    }

    #[test]
    fn capabilities_parse_v2_with_additive_fields() {
        let payload = capabilities_payload("capabilities", 2);
        let capabilities = super::parse_capabilities(payload.as_bytes()).unwrap();
        assert_eq!(capabilities.model, "34461A");
        assert_eq!(capabilities.model_id, "keysight-34461a");
        assert_eq!(capabilities.reading_memory_limit, 10_000);
        assert!(capabilities.trigger_modes.contains(&"external-custom".to_owned()));
        assert_eq!(capabilities.limits.sample_count.max, 1_000_000);
        assert_eq!(capabilities.limits.buffer_drain_size.max, 10_000);
        assert_eq!(capabilities.measurements[0].nplc_values, vec![0.02, 0.2, 1.0]);
        assert_eq!(capabilities.measurements[0].range_values, vec![0.1, 10.0]);
        assert_eq!(
            capabilities.measurements[1].range_values,
            vec![0.0001, 0.001]
        );
    }

    #[test]
    fn capabilities_reject_invalid_contract() {
        for payload in [
            capabilities_payload("capabilities", 1),
            capabilities_payload("other", 2),
            r#"{"schema_version":2,"event":"capabilities","measurements":[]}"#.to_owned(),
        ] {
            assert!(super::parse_capabilities(payload.as_bytes()).is_err());
        }
    }

    use std::{ffi::OsString, path::Path};

    use serde_json::json;

    use crate::meters_setup::{
        AutoZero, DcvInputImpedance, MetersMeasurement, MetersSetup, MetersTriggerMode, RangeMode,
    };

    use super::{
        MetersActionError, MetersEventDecision, classify_meters_event, simulate_worker_launch_spec,
        software_trigger_request,
    };

    #[test]
    fn meters_setup_arguments_dcv_manual() {
        let mut setup = MetersSetup {
            measurement: MetersMeasurement::VoltageDc,
            range_mode: RangeMode::Manual,
            manual_range: Some(10.0),
            nplc: 1.0,
            auto_zero: AutoZero::Once,
            dcv_input_impedance: Some(DcvInputImpedance::TenMegohm),
            current_terminal: None,
            ..MetersSetup::default()
        };
        setup.validate().unwrap();
        let expected = [
            "--measurement",
            "voltage-dc",
            "--auto-range",
            "off",
            "--range",
            "10",
            "--nplc",
            "1",
            "--auto-zero",
            "once",
            "--dcv-input-impedance",
            "10m",
        ]
        .map(OsString::from);
        assert_eq!(super::setup_arguments(&setup), expected);

        setup.current_terminal = Some(3);
        assert_eq!(super::setup_arguments(&setup), expected);

        setup.dcv_input_impedance = None;
        assert_eq!(super::setup_arguments(&setup), expected[..10]);
    }

    #[test]
    fn meters_setup_arguments_dci_auto() {
        let mut setup = MetersSetup {
            measurement: MetersMeasurement::CurrentDc,
            range_mode: RangeMode::Auto,
            manual_range: None,
            nplc: 0.2,
            auto_zero: AutoZero::On,
            dcv_input_impedance: None,
            current_terminal: Some(3),
            ..MetersSetup::default()
        };
        setup.validate().unwrap();
        let expected = [
            "--measurement",
            "current-dc",
            "--auto-range",
            "on",
            "--nplc",
            "0.2",
            "--auto-zero",
            "on",
            "--current-terminal",
            "3",
        ]
        .map(OsString::from);
        assert_eq!(super::setup_arguments(&setup), expected);

        setup.manual_range = Some(10.0);
        assert_eq!(super::setup_arguments(&setup), expected);

        setup.dcv_input_impedance = Some(DcvInputImpedance::TenMegohm);
        assert_eq!(super::setup_arguments(&setup), expected);

        setup.current_terminal = None;
        assert_eq!(super::setup_arguments(&setup), expected[..8]);
    }

    #[test]
    fn meters_live_contract_shape_is_correct() {
        let resource = " USB0::Vendor::Serial With Spaces::INSTR ";
        let setup = MetersSetup {
            measurement: MetersMeasurement::VoltageDc,
            range_mode: RangeMode::Auto,
            manual_range: None,
            nplc: 1.0,
            auto_zero: AutoZero::On,
            dcv_input_impedance: None,
            current_terminal: None,
            ..MetersSetup::default()
        };
        let spec = super::live_worker_launch_spec("meters-tool.exe", resource, Some(2), &setup);
        assert_eq!(spec.executable(), Path::new("meters-tool.exe"));
        assert_eq!(
            spec.arguments(),
            [
                OsString::from("start-trigger-record"),
                OsString::from("--resource"),
                OsString::from(resource),
                OsString::from("--trigger-mode"),
                OsString::from("software"),
                OsString::from("--max-samples"),
                OsString::from("2"),
                OsString::from("--status-format"),
                OsString::from("jsonl"),
                OsString::from("--sw-trigger-port"),
                OsString::from("0"),
                OsString::from("--no-csv"),
            ]
            .into_iter()
            .chain(super::setup_arguments(&setup))
            .collect::<Vec<_>>()
        );
    }

    #[test]
    fn meters_event_matching_sample_is_success() {
        let value = json!({
            "event": "sample",
            "run_id": "run-123",
            "value": 1.23
        });
        assert!(matches!(
            classify_meters_event(&value, "run-123"),
            MetersEventDecision::Success(v) if v["event"] == "sample"
        ));
    }

    #[test]
    fn meters_event_mismatched_and_missing_run_id_are_invalid_response() {
        let mismatched = json!({
            "event": "sample",
            "run_id": "other-run",
            "value": 1.23
        });
        assert!(matches!(
            classify_meters_event(&mismatched, "run-123"),
            MetersEventDecision::Failure(MetersActionError::InvalidResponse(_))
        ));

        let missing = json!({
            "event": "sample",
            "value": 1.23
        });
        assert!(matches!(
            classify_meters_event(&missing, "run-123"),
            MetersEventDecision::Failure(MetersActionError::InvalidResponse(_))
        ));
    }

    #[test]
    fn meters_event_error_is_worker_fatal() {
        let value = json!({
            "event": "error",
            "message": "sensor fault",
            "run_id": "run-123"
        });
        assert!(matches!(
            classify_meters_event(&value, "run-123"),
            MetersEventDecision::Failure(MetersActionError::WorkerFatal(msg)) if msg.contains("sensor fault")
        ));

        let with_fatal = json!({
            "event": "error",
            "fatal_error": "fatal sensor error",
            "run_id": "run-123"
        });
        assert!(matches!(
            classify_meters_event(&with_fatal, "run-123"),
            MetersEventDecision::Failure(MetersActionError::WorkerFatal(_))
        ));
    }

    #[test]
    fn meters_event_summary_before_sample_is_failure() {
        let summary = json!({
            "event": "summary",
            "run_id": "run-123",
            "count": 0
        });
        assert!(matches!(
            classify_meters_event(&summary, "run-123"),
            MetersEventDecision::Failure(MetersActionError::InvalidResponse(msg)) if msg.contains("before producing a sample")
        ));

        let summary_with_fatal = json!({
            "event": "summary",
            "run_id": "run-123",
            "fatal_error": "early termination"
        });
        assert!(matches!(
            classify_meters_event(&summary_with_fatal, "run-123"),
            MetersEventDecision::Failure(MetersActionError::WorkerFatal(msg)) if msg.contains("early termination")
        ));
    }

    #[test]
    fn meters_event_harmless_events_are_ignored() {
        for value in [
            json!({"event": "status", "run_id": "run-123"}),
            json!({"event": "message", "run_id": "run-123", "message": "calibrating"}),
            json!({"event": "heartbeat", "run_id": "run-123"}),
        ] {
            assert!(matches!(
                classify_meters_event(&value, "run-123"),
                MetersEventDecision::Continue
            ));
        }
    }

    #[test]
    fn meters_simulate_contract_shape_is_correct() {
        let setup = MetersSetup {
            measurement: MetersMeasurement::VoltageDc,
            range_mode: RangeMode::Auto,
            manual_range: None,
            nplc: 1.0,
            auto_zero: AutoZero::On,
            dcv_input_impedance: None,
            current_terminal: None,
            ..MetersSetup::default()
        };
        let spec = simulate_worker_launch_spec(Path::new("meters-tool.exe"), Some(2), &setup);

        assert_eq!(spec.executable(), Path::new("meters-tool.exe"));
        assert_eq!(
            spec.arguments(),
            [
                OsString::from("start-trigger-record"),
                OsString::from("--resource"),
                OsString::from("SIM::34461A"),
                OsString::from("--simulate"),
                OsString::from("--trigger-mode"),
                OsString::from("software"),
                OsString::from("--max-samples"),
                OsString::from("2"),
                OsString::from("--status-format"),
                OsString::from("jsonl"),
                OsString::from("--sw-trigger-port"),
                OsString::from("0"),
                OsString::from("--no-csv"),
            ]
            .into_iter()
            .chain(super::setup_arguments(&setup))
            .collect::<Vec<_>>()
        );
        assert_eq!(
            software_trigger_request(),
            json!({
                "schema_version": 2,
                "command": "software_trigger",
                "job_id": "orchestrator-meter-smoke"
            })
        );
    }

    #[test]
    fn meters_custom_launch_modes_use_batch_contract_without_max_samples() {
        for (trigger_mode, cli_mode) in [
            (MetersTriggerMode::SoftwareCustom, "software-custom"),
            (MetersTriggerMode::ImmediateCustom, "immediate-custom"),
            (MetersTriggerMode::ExternalCustom, "external-custom"),
        ] {
            let setup = MetersSetup {
                trigger_mode,
                sample_count: 3,
                buffer_drain_size: Some(50),
                allow_buffer_overflow_risk: true,
                ..MetersSetup::default()
            };
            for spec in [
                simulate_worker_launch_spec(Path::new("meters-tool.exe"), Some(7), &setup),
                super::live_worker_launch_spec(
                    "meters-tool.exe",
                    "USB0::Meter::INSTR",
                    Some(7),
                    &setup,
                ),
            ] {
                let arguments = spec.arguments();
                for pair in [
                    ["--trigger-mode", cli_mode],
                    ["--trigger-count", "7"],
                    ["--sample-count", "3"],
                    ["--buffer-drain-size", "50"],
                ] {
                    assert!(arguments.windows(2).any(|window| window == pair));
                }
                assert!(
                    arguments
                        .iter()
                        .any(|argument| argument == "--allow-buffer-overflow-risk")
                );
                assert!(!arguments.iter().any(|argument| argument == "--max-samples"));
            }
        }
    }}
