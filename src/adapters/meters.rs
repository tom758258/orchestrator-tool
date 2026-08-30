use std::{
    error::Error,
    ffi::OsString,
    fmt,
    path::Path,
    process::ExitStatus,
    thread,
    time::{Duration, Instant},
};

use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
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

/// Builds the Meters Worker launch specification used for simulate diagnostics.
pub fn simulate_worker_launch_spec(executable: impl AsRef<Path>) -> WorkerLaunchSpec {
    WorkerLaunchSpec::new(
        executable.as_ref(),
        [
            OsString::from("start-trigger-record"),
            OsString::from("--resource"),
            OsString::from("SIM::34461A"),
            OsString::from("--simulate"),
            OsString::from("--measurement"),
            OsString::from("voltage-dc"),
            OsString::from("--trigger-mode"),
            OsString::from("software"),
            OsString::from("--max-samples"),
            OsString::from("2"),
            OsString::from("--status-format"),
            OsString::from("jsonl"),
            OsString::from("--sw-trigger-port"),
            OsString::from("0"),
            OsString::from("--no-csv"),
        ],
    )
}

/// Runs the bounded Meters simulate Worker diagnostic.
pub fn run_worker_smoke(
    executable: impl AsRef<Path>,
    startup_timeout: Duration,
    operation_timeout: Duration,
    shutdown_timeout: Duration,
) -> Result<(), MetersSmokeError> {
    let spec = simulate_worker_launch_spec(executable);
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
/// Supported action: `measure` → `software_trigger`.
/// The request contains no `context` field and uses `job_id: null`.
pub fn run_action(
    session: &WorkerSession,
    action: &ActionId,
    arguments: &Value,
    timeout: Duration,
) -> Result<Value, MetersActionError> {
    if action.as_str() != "measure" {
        return Err(MetersActionError::UnsupportedAction(action.clone()));
    }
    validate_measure_arguments(arguments)?;

    let deadline = Instant::now() + timeout;
    let client = WorkerClient::new(session.ready());

    let request = json!({
        "schema_version": WORKER_SCHEMA_VERSION,
        "command": SOFTWARE_TRIGGER_COMMAND,
        "job_id": Value::Null
    });

    let remaining = remaining_duration(deadline).ok_or(MetersActionError::Timeout(timeout))?;
    let (http_status, response) = client
        .command_with_timeout(&request, remaining)
        .map_err(MetersActionError::Http)?;
    validate_runtime_accepted_response(http_status, response)?;

    loop {
        let Some(remaining) = remaining_duration(deadline) else {
            return Err(MetersActionError::Timeout(timeout));
        };
        match session.recv_event(remaining) {
            Ok(value) => {
                if is_matching_sample(&value, session.ready().run_id()) {
                    return Ok(value);
                }
            }
            Err(WorkerEventError::Timeout(original)) => {
                return Err(MetersActionError::Timeout(original));
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
    #[allow(dead_code)]
    job_id: Value,
}

fn is_matching_sample(value: &Value, expected_run_id: &str) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    if object.get("event").and_then(Value::as_str) != Some("sample") {
        return false;
    }
    // Correlate on run_id == session.ready().run_id() when present.
    if let Some(run_id) = object.get("run_id").and_then(Value::as_str) {
        return run_id == expected_run_id;
    }
    // If run_id is absent, do not treat as matching to avoid cross-run contamination.
    false
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
    use std::{ffi::OsString, path::Path};

    use serde_json::json;

    use super::{simulate_worker_launch_spec, software_trigger_request};

    #[test]
    fn meters_simulate_contract_shape_is_correct() {
        let spec = simulate_worker_launch_spec(Path::new("meters-tool.exe"));

        assert_eq!(spec.executable(), Path::new("meters-tool.exe"));
        assert_eq!(
            spec.arguments(),
            [
                OsString::from("start-trigger-record"),
                OsString::from("--resource"),
                OsString::from("SIM::34461A"),
                OsString::from("--simulate"),
                OsString::from("--measurement"),
                OsString::from("voltage-dc"),
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
}
