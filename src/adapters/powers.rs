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
    worker::{WorkerLaunchSpec, WorkerReady, WorkerShutdownError, WorkerStartError, start_worker},
    worker_http::{WorkerClient, WorkerHttpError},
};

const WORKER_SCHEMA_VERSION: u32 = 2;
const SERVICE_NAME: &str = "powers-tool";
const READ_STATUS_COMMAND: &str = "read-status";
const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// Builds the Powers Worker launch specification used for simulate diagnostics.
pub fn simulate_worker_launch_spec(executable: impl AsRef<Path>) -> WorkerLaunchSpec {
    WorkerLaunchSpec::new(
        executable.as_ref(),
        [
            OsString::from("worker"),
            OsString::from("--mode"),
            OsString::from("simulate"),
            OsString::from("--control-port"),
            OsString::from("0"),
            OsString::from("--artifact-mode"),
            OsString::from("memory"),
        ],
    )
}

/// Runs the bounded Powers simulate Worker diagnostic.
pub fn run_worker_smoke(
    executable: impl AsRef<Path>,
    startup_timeout: Duration,
    operation_timeout: Duration,
    shutdown_timeout: Duration,
) -> Result<(), PowersSmokeError> {
    let spec = simulate_worker_launch_spec(executable);
    let session = start_worker(&spec, startup_timeout).map_err(PowersSmokeError::Startup)?;
    let operation = run_smoke_operation(session.ready(), operation_timeout);
    let shutdown = session.shutdown(shutdown_timeout);

    match (operation, shutdown) {
        (Ok(()), Ok(status)) if status.success() => Ok(()),
        (Ok(()), Ok(status)) => Err(PowersSmokeError::WorkerExit(status)),
        (Ok(()), Err(error)) => Err(PowersSmokeError::Shutdown(error)),
        (Err(operation), Ok(status)) if !status.success() => {
            Err(PowersSmokeError::OperationAndWorkerExit {
                operation: operation.to_string(),
                status,
            })
        }
        (Err(error), Ok(_)) => Err(error),
        (Err(operation), Err(shutdown)) => Err(PowersSmokeError::OperationAndShutdown {
            operation: operation.to_string(),
            shutdown,
        }),
    }
}

fn run_smoke_operation(
    ready: &WorkerReady,
    operation_timeout: Duration,
) -> Result<(), PowersSmokeError> {
    let deadline = Instant::now() + operation_timeout;
    let client = WorkerClient::new(ready);

    let status = client
        .status_with_timeout(remaining(deadline, operation_timeout)?)
        .map_err(PowersSmokeError::Http)?;
    validate_status_identity(&status, ready)?;

    let (http_status, response) = client
        .command_with_timeout(
            &read_status_request(),
            remaining(deadline, operation_timeout)?,
        )
        .map_err(PowersSmokeError::Http)?;
    let worker_job_id = validate_accepted_response(http_status, response)?;

    loop {
        let status = client
            .status_with_timeout(remaining(deadline, operation_timeout)?)
            .map_err(PowersSmokeError::Http)?;
        let status = parse_status(status, ready)?;

        if let Some(last_job) = status.last_job
            && last_job.worker_job_id == worker_job_id
        {
            match last_job.status.as_str() {
                "accepted" | "queued" | "running" => {}
                "succeeded" => {
                    if last_job.result.is_some_and(|result| result.ok) {
                        return Ok(());
                    }
                    return Err(PowersSmokeError::InvalidResponse(
                        "succeeded read-status job did not contain result.ok=true".to_owned(),
                    ));
                }
                "failed" | "cancelled" => {
                    return Err(PowersSmokeError::TerminalFailure {
                        status: last_job.status,
                        detail: diagnostic_detail(last_job.error.as_ref()),
                    });
                }
                status => {
                    return Err(PowersSmokeError::InvalidResponse(format!(
                        "read-status job had unknown status {status:?}"
                    )));
                }
            }
        }

        let wait = POLL_INTERVAL.min(remaining(deadline, operation_timeout)?);
        thread::sleep(wait);
    }
}

fn remaining(deadline: Instant, timeout: Duration) -> Result<Duration, PowersSmokeError> {
    let now = Instant::now();
    if now >= deadline {
        return Err(PowersSmokeError::OperationTimeout(timeout));
    }
    Ok(deadline.saturating_duration_since(now))
}

fn read_status_request() -> Value {
    json!({
        "schema_version": WORKER_SCHEMA_VERSION,
        "command": READ_STATUS_COMMAND,
        "arguments": {
            "channel": "all"
        },
        "context": {
            "mode": "simulate",
            "planning_model_id": "keysight-e36312a"
        }
    })
}

#[derive(Deserialize)]
struct StatusResponse {
    schema_version: u32,
    service: String,
    run_id: String,
    status: String,
    #[serde(default)]
    fatal_error: Option<DiagnosticError>,
    #[serde(default)]
    last_job: Option<LastJob>,
}

#[derive(Deserialize)]
struct LastJob {
    worker_job_id: String,
    status: String,
    #[serde(default)]
    result: Option<JobResult>,
    #[serde(default)]
    error: Option<DiagnosticError>,
}

#[derive(Deserialize)]
struct JobResult {
    ok: bool,
}

#[derive(Deserialize)]
struct DiagnosticError {
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

#[derive(Deserialize)]
struct AcceptedResponse {
    schema_version: u32,
    status: String,
    command: String,
    worker_job_id: String,
}

fn validate_status_identity(value: &Value, ready: &WorkerReady) -> Result<(), PowersSmokeError> {
    parse_status(value.clone(), ready).map(|_| ())
}

fn parse_status(value: Value, ready: &WorkerReady) -> Result<StatusResponse, PowersSmokeError> {
    let status: StatusResponse = serde_json::from_value(value)
        .map_err(|error| PowersSmokeError::InvalidResponse(error.to_string()))?;

    if status.schema_version != WORKER_SCHEMA_VERSION {
        return Err(PowersSmokeError::InvalidResponse(format!(
            "status schema_version was {}, expected {WORKER_SCHEMA_VERSION}",
            status.schema_version
        )));
    }
    if status.service != SERVICE_NAME {
        return Err(PowersSmokeError::InvalidResponse(format!(
            "status service was {:?}, expected {SERVICE_NAME:?}",
            status.service
        )));
    }
    if status.run_id != ready.run_id() {
        return Err(PowersSmokeError::InvalidResponse(format!(
            "status run_id was {:?}, expected {:?}",
            status.run_id,
            ready.run_id()
        )));
    }
    validate_worker_health(&status)?;

    Ok(status)
}

fn validate_worker_health(status: &StatusResponse) -> Result<(), PowersSmokeError> {
    let has_fatal_error = status.fatal_error.is_some();
    if status.status != "error" && !has_fatal_error {
        return Ok(());
    }

    let detail = diagnostic_detail(status.fatal_error.as_ref()).unwrap_or_else(|| {
        if status.status == "error" {
            "Worker status is error".to_owned()
        } else {
            "Worker status contained fatal_error".to_owned()
        }
    });
    Err(PowersSmokeError::WorkerFatal(detail))
}

fn diagnostic_detail(error: Option<&DiagnosticError>) -> Option<String> {
    let error = error?;
    let code = error
        .code
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let message = error
        .message
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    match (code, message) {
        (Some(code), Some(message)) => Some(format!("{code}: {message}")),
        (Some(code), None) => Some(code.to_owned()),
        (None, Some(message)) => Some(message.to_owned()),
        (None, None) => None,
    }
}

fn validate_accepted_response(http_status: u16, value: Value) -> Result<String, PowersSmokeError> {
    if http_status != 202 {
        return Err(PowersSmokeError::InvalidResponse(format!(
            "read-status returned HTTP {http_status}, expected 202"
        )));
    }

    let accepted: AcceptedResponse = serde_json::from_value(value)
        .map_err(|error| PowersSmokeError::InvalidResponse(error.to_string()))?;
    if accepted.schema_version != WORKER_SCHEMA_VERSION
        || accepted.status != "accepted"
        || accepted.command != READ_STATUS_COMMAND
        || accepted.worker_job_id.is_empty()
    {
        return Err(PowersSmokeError::InvalidResponse(
            "read-status acceptance payload did not match the Powers Worker contract".to_owned(),
        ));
    }

    Ok(accepted.worker_job_id)
}

/// Errors from the Powers Worker smoke diagnostic.
#[derive(Debug)]
pub enum PowersSmokeError {
    Startup(WorkerStartError),
    Http(WorkerHttpError),
    InvalidResponse(String),
    TerminalFailure {
        status: String,
        detail: Option<String>,
    },
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

impl fmt::Display for PowersSmokeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Startup(error) => write!(formatter, "Powers Worker startup failed: {error}"),
            Self::Http(error) => write!(formatter, "Powers Worker HTTP failed: {error}"),
            Self::InvalidResponse(reason) => {
                write!(formatter, "invalid Powers Worker response: {reason}")
            }
            Self::TerminalFailure { status, detail } => {
                write!(formatter, "Powers read-status job ended with {status}")?;
                if let Some(detail) = detail {
                    write!(formatter, ": {detail}")?;
                }
                Ok(())
            }
            Self::WorkerFatal(detail) => write!(formatter, "Powers Worker fatal error: {detail}"),
            Self::OperationTimeout(timeout) => {
                write!(formatter, "Powers Worker check timed out after {timeout:?}")
            }
            Self::Shutdown(error) => write!(formatter, "Powers Worker shutdown failed: {error}"),
            Self::WorkerExit(status) => write!(formatter, "Powers Worker exited with {status}"),
            Self::OperationAndWorkerExit { operation, status } => write!(
                formatter,
                "Powers Worker check failed: {operation}; Worker also exited with {status}"
            ),
            Self::OperationAndShutdown {
                operation,
                shutdown,
            } => write!(
                formatter,
                "Powers Worker check failed: {operation}; shutdown also failed: {shutdown}"
            ),
        }
    }
}

impl Error for PowersSmokeError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Startup(source) => Some(source),
            Self::Http(source) => Some(source),
            Self::Shutdown(source) => Some(source),
            Self::OperationAndShutdown { shutdown, .. } => Some(shutdown),
            Self::InvalidResponse(_)
            | Self::TerminalFailure { .. }
            | Self::WorkerFatal(_)
            | Self::OperationTimeout(_)
            | Self::WorkerExit(_)
            | Self::OperationAndWorkerExit { .. } => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{ffi::OsString, path::Path};

    use serde_json::json;

    use super::{
        PowersSmokeError, StatusResponse, read_status_request, simulate_worker_launch_spec,
        validate_worker_health,
    };

    #[test]
    fn powers_simulate_contract_shape_is_correct() {
        let spec = simulate_worker_launch_spec(Path::new("powers-tool.exe"));

        assert_eq!(spec.executable(), Path::new("powers-tool.exe"));
        assert_eq!(
            spec.arguments(),
            [
                OsString::from("worker"),
                OsString::from("--mode"),
                OsString::from("simulate"),
                OsString::from("--control-port"),
                OsString::from("0"),
                OsString::from("--artifact-mode"),
                OsString::from("memory"),
            ]
        );
        assert_eq!(
            read_status_request(),
            json!({
                "schema_version": 2,
                "command": "read-status",
                "arguments": { "channel": "all" },
                "context": {
                    "mode": "simulate",
                    "planning_model_id": "keysight-e36312a"
                }
            })
        );
    }

    #[test]
    fn worker_error_status_fails_fast_without_fatal_detail() {
        let status: StatusResponse = serde_json::from_value(json!({
            "schema_version": 2,
            "service": "powers-tool",
            "run_id": "run-123",
            "status": "error"
        }))
        .unwrap();

        let error = validate_worker_health(&status).unwrap_err();

        assert!(
            matches!(error, PowersSmokeError::WorkerFatal(detail) if detail == "Worker status is error")
        );
    }
}
