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
    powers_setup::PowersProtectionChannelSetup,
    process::{CaptureError, run_output_with_timeout},
    run::ExecutionMode,
    tool::ToolId,
    worker::{
        WorkerLaunchSpec, WorkerReady, WorkerSession, WorkerShutdownError, WorkerStartError,
        start_worker,
    },
    worker_http::{WorkerClient, WorkerHttpError},
    workflow::ActionId,
};

const WORKER_SCHEMA_VERSION: u32 = 2;
const SERVICE_NAME: &str = "powers-tool";
const READ_STATUS_COMMAND: &str = "read-status";
const SIMULATION_MODEL_ID: &str = "keysight-e36312a";
const SIMULATION_RESOURCE: &str = "USB0::SIM::E36312A::INSTR";
const POLL_INTERVAL: Duration = Duration::from_millis(50);

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PowersProtectionFeatures {
    pub ovp_voltage: bool,
    pub ocp: bool,
    pub ocp_delay: bool,
    pub ocp_delay_triggers: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PowersCapabilities {
    pub model_id: String,
    pub model_name: String,
    pub channels: Vec<u32>,
    pub protection_features: PowersProtectionFeatures,
}

pub fn get_capabilities(
    application_dir: &Path,
    config: &Config,
    model_id: &str,
) -> Result<PowersCapabilities, String> {
    if model_id.trim().is_empty() {
        return Err("Powers canonical model ID is missing".into());
    }
    let definition = built_in_tool_definitions()
        .into_iter()
        .find(|definition| definition.id() == &ToolId::powers())
        .expect("powers is built in");
    let inspection = inspect_tool(application_dir, config, &definition)
        .map_err(|error| format!("powers executable inspection failed: {error}"))?;
    if inspection.status() != ExecutableStatus::Available {
        return Err("powers executable is unavailable".into());
    }
    let output = run_output_with_timeout(
        inspection
            .resolved()
            .path()
            .expect("available executable has a path"),
        ["capabilities", "--model", model_id, "--json"],
        Duration::from_secs(10),
    )
    .map_err(|error| match error {
        CaptureError::Io(error) => format!("powers capabilities query failed: {error}"),
        CaptureError::Timeout => "powers capabilities query timed out after 10 seconds".into(),
    })?;
    if !output.status.success() {
        return Err(format!(
            "powers capabilities query failed with {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    parse_capabilities(&output.stdout)
}

fn parse_capabilities(stdout: &[u8]) -> Result<PowersCapabilities, String> {
    #[derive(Deserialize)]
    struct Command {
        name: String,
    }
    #[derive(Deserialize)]
    struct Response {
        schema_version: u32,
        ok: bool,
        status: String,
        command: Command,
        data: PowersCapabilities,
    }
    let response: Response = serde_json::from_slice(stdout)
        .map_err(|error| format!("powers capabilities returned invalid JSON or shape: {error}"))?;
    if response.schema_version != 2
        || !response.ok
        || response.status != "ok"
        || response.command.name != "capabilities"
        || response.data.model_id.trim().is_empty()
        || response.data.model_name.trim().is_empty()
        || response.data.channels.contains(&0)
    {
        return Err("powers capabilities returned invalid success data".into());
    }
    Ok(response.data)
}

/// Builds the Powers Worker launch specification used for simulate diagnostics.
pub fn simulate_worker_launch_spec(executable: impl AsRef<Path>) -> WorkerLaunchSpec {
    WorkerLaunchSpec::new(
        executable.as_ref(),
        [
            OsString::from("worker"),
            OsString::from("--mode"),
            OsString::from("simulate"),
            OsString::from("--resource"),
            OsString::from(SIMULATION_RESOURCE),
            OsString::from("--control-port"),
            OsString::from("0"),
            OsString::from("--artifact-mode"),
            OsString::from("memory"),
        ],
    )
}

/// Builds live Worker launch details using the exact caller-supplied resource.
pub fn live_worker_launch_spec(executable: impl AsRef<Path>, resource: &str) -> WorkerLaunchSpec {
    WorkerLaunchSpec::new(
        executable.as_ref(),
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
    let worker_job_id = validate_accepted_response(http_status, response, READ_STATUS_COMMAND)?;

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
                    if last_job
                        .result
                        .is_some_and(|result| result.get("ok") == Some(&Value::Bool(true)))
                    {
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
            "planning_model_id": SIMULATION_MODEL_ID
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
    result: Option<Value>,
    #[serde(default)]
    error: Option<DiagnosticError>,
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

/// Validates that the Worker returned an accepted command response with a job ID.
///
/// `command_name` is the expected command field for diagnostic error messages;
/// use an empty string to skip command validation (runtime actions).
fn validate_accepted_response(
    http_status: u16,
    value: Value,
    command_name: &str,
) -> Result<String, PowersSmokeError> {
    if http_status != 202 {
        return Err(PowersSmokeError::InvalidResponse(format!(
            "{command_name} returned HTTP {http_status}, expected 202"
        )));
    }

    let accepted: AcceptedResponse = serde_json::from_value(value)
        .map_err(|error| PowersSmokeError::InvalidResponse(error.to_string()))?;
    if accepted.schema_version != WORKER_SCHEMA_VERSION
        || accepted.status != "accepted"
        || (!command_name.is_empty() && accepted.command != command_name)
        || accepted.worker_job_id.is_empty()
    {
        return Err(PowersSmokeError::InvalidResponse(format!(
            "{command_name} acceptance payload did not match the Powers Worker contract",
        )));
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

/// Runs a single runtime Powers action on an already-started Worker session.
///
/// Supported actions: `set-output`, `set-voltage`, `output-on`, `output-off`, `protection-status`.
/// Execution context and output confirmation are runtime-only.
pub fn run_action(
    session: &WorkerSession,
    action: &ActionId,
    arguments: &Value,
    execution_mode: ExecutionMode,
    timeout: Duration,
) -> Result<Value, PowersActionError> {
    let worker_command = match action.as_str() {
        "set-output" | "set-voltage" => "set",
        "output-on" => "output-on",
        "output-off" => "output-off",
        "protection-status" => "protection-status",
        _ => {
            return Err(PowersActionError::UnsupportedAction(action.clone()));
        }
    };

    let arguments = validate_arguments(action.as_str(), arguments)?;
    let result = run_command(session, worker_command, arguments, execution_mode, timeout)?;
    if action.as_str() == "protection-status" {
        augment_protection_status_result(result)
    } else {
        Ok(result)
    }
}

fn augment_protection_status_result(mut result: Value) -> Result<Value, PowersActionError> {
    let protection = result
        .get("data")
        .and_then(Value::as_object)
        .and_then(|data| data.get("protection"))
        .and_then(Value::as_object)
        .ok_or_else(|| {
            PowersActionError::InvalidResponse("missing data.protection object".to_owned())
        })?;
    let flag = |name: &str| {
        protection
            .get(name)
            .and_then(Value::as_bool)
            .ok_or_else(|| {
                PowersActionError::InvalidResponse(format!(
                    "data.protection.{name} must be a boolean"
                ))
            })
    };
    let over_voltage = flag("over_voltage_tripped")?;
    let over_current = flag("over_current_tripped")?;
    let object = result
        .as_object_mut()
        .expect("data object implies result object");
    object.insert(
        "protection_tripped".to_owned(),
        json!(over_voltage || over_current),
    );
    object.insert("over_voltage_tripped".to_owned(), json!(over_voltage));
    object.insert("over_current_tripped".to_owned(), json!(over_current));
    Ok(result)
}

/// Requests bounded live safe-off for every Powers channel before shutdown.
pub fn safe_off_all(
    session: &WorkerSession,
    timeout: Duration,
) -> Result<Value, PowersActionError> {
    run_command(
        session,
        "safe-off",
        json!({ "channel": "all" }),
        ExecutionMode::Live,
        timeout,
    )
}

pub fn protection_status_all(
    session: &WorkerSession,
    timeout: Duration,
) -> Result<bool, PowersActionError> {
    let result = run_command(
        session,
        "protection-status",
        json!({"channel": "all"}),
        ExecutionMode::Live,
        timeout,
    )?;
    let result = augment_protection_status_result(result)?;
    result["protection_tripped"].as_bool().ok_or_else(|| {
        PowersActionError::InvalidResponse("missing protection_tripped boolean".into())
    })
}

fn protection_set_arguments(record: &PowersProtectionChannelSetup) -> Value {
    let mut arguments = json!({"channel": record.channel});
    if let Some(value) = record.ovp_voltage {
        arguments["ovp_voltage"] = json!(value);
    }
    if let Some(value) = record.ocp {
        arguments["ocp"] = json!(value);
    }
    if let Some(value) = record.ocp_delay {
        arguments["ocp_delay"] = json!(value);
    }
    if let Some(value) = record.ocp_delay_trigger {
        arguments["ocp_delay_trigger"] = json!(value);
    }
    arguments
}

#[cfg(test)]
mod protection_setup_tests {
    use super::*;
    use crate::powers_setup::{OcpDelayTrigger, OcpState};

    #[test]
    fn parses_offline_capabilities_and_rejects_malformed_features() {
        let mut payload = json!({"schema_version":2,"ok":true,"status":"ok",
            "command":{"name":"capabilities"},"data":{"model_id":"test-model","model_name":"Test",
                "channels":[1,2],"protection_features":{"ovp_voltage":true,"ocp":true,
                    "ocp_delay":true,"ocp_delay_triggers":["setting-change","cc-transition"]}}});
        payload["future"] = json!(42);
        let full = parse_capabilities(payload.to_string().as_bytes()).unwrap();
        assert_eq!(full.channels, vec![1, 2]);
        assert!(full.protection_features.ocp_delay);
        assert_eq!(full.protection_features.ocp_delay_triggers.len(), 2);
        payload["data"]["protection_features"]["ocp_delay"] = json!(false);
        payload["data"]["protection_features"]["ocp_delay_triggers"] = json!([]);
        let limited = parse_capabilities(payload.to_string().as_bytes()).unwrap();
        assert!(limited.protection_features.ovp_voltage && limited.protection_features.ocp);
        assert!(!limited.protection_features.ocp_delay);
        payload["data"]["protection_features"]["ocp"] = json!("yes");
        assert!(parse_capabilities(payload.to_string().as_bytes()).is_err());
    }

    #[test]
    fn maps_only_configured_protection_fields() {
        let mut record = PowersProtectionChannelSetup {
            channel: 1,
            ovp_voltage: Some(5.5),
            ocp: Some(OcpState::On),
            ocp_delay: None,
            ocp_delay_trigger: None,
        };
        assert_eq!(
            protection_set_arguments(&record),
            json!({"channel":1,"ovp_voltage":5.5,"ocp":"on"})
        );
        record.ovp_voltage = None;
        record.ocp = None;
        record.ocp_delay = Some(0.05);
        record.ocp_delay_trigger = Some(OcpDelayTrigger::SettingChange);
        assert_eq!(
            protection_set_arguments(&record),
            json!({"channel":1,"ocp_delay":0.05,
            "ocp_delay_trigger":"setting-change"})
        );
    }
}

pub fn apply_protection_setup(
    session: &WorkerSession,
    record: &PowersProtectionChannelSetup,
    timeout: Duration,
) -> Result<Value, PowersActionError> {
    run_command(
        session,
        "protection-set",
        protection_set_arguments(record),
        ExecutionMode::Live,
        timeout,
    )
}

fn run_command(
    session: &WorkerSession,
    worker_command: &str,
    mut arguments: Value,
    execution_mode: ExecutionMode,
    timeout: Duration,
) -> Result<Value, PowersActionError> {
    let deadline = Instant::now() + timeout;
    let client = WorkerClient::new(session.ready());
    let context = match execution_mode {
        ExecutionMode::Simulate => json!({
            "mode": "simulate",
            "planning_model_id": SIMULATION_MODEL_ID
        }),
        ExecutionMode::Live => {
            arguments["confirm_output"] = json!(true);
            json!({ "mode": "live" })
        }
    };

    let request = json!({
        "schema_version": WORKER_SCHEMA_VERSION,
        "command": worker_command,
        "arguments": arguments,
        "context": context
    });

    let remaining =
        remaining_duration(deadline, timeout).ok_or(PowersActionError::Timeout(timeout))?;

    let (http_status, response) = client
        .command_with_timeout(&request, remaining)
        .map_err(PowersActionError::Http)?;
    let worker_job_id = validate_accepted_response(http_status, response, worker_command)
        .map_err(|error| PowersActionError::InvalidResponse(error.to_string()))?;

    run_runtime_operation(&client, session.ready(), &worker_job_id, deadline, timeout)
}

fn run_runtime_operation(
    client: &WorkerClient,
    ready: &WorkerReady,
    worker_job_id: &str,
    deadline: Instant,
    timeout: Duration,
) -> Result<Value, PowersActionError> {
    loop {
        let remaining = match remaining_duration(deadline, timeout) {
            Some(duration) => duration,
            None => return Err(PowersActionError::Timeout(timeout)),
        };

        let status = client
            .status_with_timeout(remaining)
            .map_err(PowersActionError::Http)?;
        let parsed = parse_runtime_status(status, ready)?;

        if let Some(last_job) = parsed.last_job.as_ref()
            && last_job.worker_job_id == worker_job_id
        {
            match last_job.status.as_str() {
                "accepted" | "queued" | "running" => {}
                "succeeded" | "failed" | "cancelled" => {
                    return terminal_result(last_job, timeout);
                }
                other => {
                    return Err(PowersActionError::InvalidResponse(format!(
                        "job had unknown status {other:?}"
                    )));
                }
            }
        }

        let remaining = remaining_duration(deadline, timeout).unwrap_or(Duration::ZERO);
        let wait = POLL_INTERVAL.min(remaining);
        thread::sleep(wait);
    }
}

fn terminal_result(last_job: &LastJob, _timeout: Duration) -> Result<Value, PowersActionError> {
    match last_job.status.as_str() {
        "succeeded" => match last_job.result.clone() {
            Some(value) => Ok(value),
            None => Err(PowersActionError::InvalidResponse(
                "succeeded job missing result".to_owned(),
            )),
        },
        "failed" | "cancelled" => Err(PowersActionError::WorkerFailure {
            status: last_job.status.clone(),
            detail: diagnostic_detail(last_job.error.as_ref()),
        }),
        other => Err(PowersActionError::InvalidResponse(format!(
            "job had unknown status {other:?}"
        ))),
    }
}

fn parse_runtime_status(
    value: Value,
    ready: &WorkerReady,
) -> Result<StatusResponse, PowersActionError> {
    let parsed: StatusResponse = serde_json::from_value(value)
        .map_err(|error| PowersActionError::InvalidResponse(error.to_string()))?;
    if parsed.schema_version != WORKER_SCHEMA_VERSION {
        return Err(PowersActionError::InvalidResponse(format!(
            "status schema_version was {}, expected {WORKER_SCHEMA_VERSION}",
            parsed.schema_version
        )));
    }
    if parsed.service != SERVICE_NAME {
        return Err(PowersActionError::InvalidResponse(format!(
            "status service was {:?}, expected {SERVICE_NAME:?}",
            parsed.service
        )));
    }
    if parsed.run_id != ready.run_id() {
        return Err(PowersActionError::InvalidResponse(format!(
            "status run_id was {:?}, expected {:?}",
            parsed.run_id,
            ready.run_id()
        )));
    }
    if let Some(ref fatal) = parsed.fatal_error
        && let Some(detail) = diagnostic_detail(Some(fatal))
    {
        return Err(PowersActionError::WorkerFatal(detail));
    }
    if parsed.status == "error" {
        return Err(PowersActionError::WorkerFatal(
            "Worker status is error".to_owned(),
        ));
    }

    Ok(parsed)
}

fn remaining_duration(deadline: Instant, _timeout: Duration) -> Option<Duration> {
    let now = Instant::now();
    if now >= deadline {
        None
    } else {
        Some(deadline.saturating_duration_since(now))
    }
}

fn validate_arguments(action: &str, arguments: &Value) -> Result<Value, PowersActionError> {
    let object = arguments.as_object().ok_or_else(|| {
        PowersActionError::InvalidArguments("arguments must be a JSON object".to_owned())
    })?;

    let (required_fields, allowed_fields): (&[&str], &[&str]) = match action {
        "set-voltage" => (&["channel", "voltage"], &["channel", "voltage"]),
        "set-output" => (&["channel"], &["channel", "voltage", "current"]),
        "output-on" | "output-off" | "protection-status" => (&["channel"], &["channel"]),
        _ => {
            return Err(PowersActionError::InvalidArguments(format!(
                "unsupported action {action:?}"
            )));
        }
    };

    for &field in required_fields {
        if !object.contains_key(field) {
            return Err(PowersActionError::InvalidArguments(format!(
                "missing required field {field:?}"
            )));
        }
    }

    if object
        .keys()
        .any(|key| !allowed_fields.contains(&key.as_str()))
    {
        return Err(PowersActionError::InvalidArguments(
            "unexpected argument field".to_owned(),
        ));
    }

    if action == "protection-status" && object.get("channel") == Some(&json!("all")) {
        return Ok(json!({ "channel": "all" }));
    }
    let channel = object
        .get("channel")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            PowersActionError::InvalidArguments("channel must be a positive integer".to_owned())
        })?;
    if channel == 0 {
        return Err(PowersActionError::InvalidArguments(
            "channel must be a positive integer".to_owned(),
        ));
    }

    if action == "set-output" && !object.contains_key("voltage") && !object.contains_key("current")
    {
        return Err(PowersActionError::InvalidArguments(
            "set-output requires voltage or current".to_owned(),
        ));
    }
    for field in ["voltage", "current"] {
        if let Some(value) = object.get(field)
            && !value.is_number()
        {
            return Err(PowersActionError::InvalidArguments(format!(
                "{field} must be a number"
            )));
        }
    }

    let mut normalized = json!({ "channel": channel });
    for field in ["voltage", "current"] {
        if let Some(value) = object.get(field) {
            normalized[field] = value.clone();
        }
    }
    Ok(normalized)
}

/// Errors from Powers runtime action execution.
#[derive(Debug)]
pub enum PowersActionError {
    UnsupportedAction(ActionId),
    InvalidArguments(String),
    Http(WorkerHttpError),
    InvalidResponse(String),
    WorkerFailure {
        status: String,
        detail: Option<String>,
    },
    WorkerFatal(String),
    Timeout(Duration),
}

impl fmt::Display for PowersActionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedAction(action) => {
                write!(formatter, "unsupported Powers action {action}")
            }
            Self::InvalidArguments(reason) => {
                write!(formatter, "invalid Powers arguments: {reason}")
            }
            Self::Http(error) => write!(formatter, "Powers Worker HTTP failed: {error}"),
            Self::InvalidResponse(reason) => {
                write!(formatter, "invalid Powers Worker response: {reason}")
            }
            Self::WorkerFailure { status, detail } => {
                write!(formatter, "Powers job ended with {status}")?;
                if let Some(detail) = detail {
                    write!(formatter, ": {detail}")?;
                }
                Ok(())
            }
            Self::WorkerFatal(detail) => write!(formatter, "Powers Worker fatal error: {detail}"),
            Self::Timeout(timeout) => {
                write!(
                    formatter,
                    "Powers runtime action timed out after {timeout:?}"
                )
            }
        }
    }
}

impl Error for PowersActionError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Http(source) => Some(source),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{ffi::OsString, path::Path};

    use serde_json::json;

    use super::{
        PowersActionError, PowersSmokeError, StatusResponse, augment_protection_status_result,
        read_status_request, simulate_worker_launch_spec, validate_arguments,
        validate_worker_health,
    };

    #[test]
    fn powers_live_contract_shape_is_correct() {
        let resource = " USB0::Vendor::Serial With Spaces::INSTR ";
        let spec = super::live_worker_launch_spec("powers-tool.exe", resource);
        assert_eq!(spec.executable(), Path::new("powers-tool.exe"));
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
            ]
        );
    }

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
                OsString::from("--resource"),
                OsString::from("USB0::SIM::E36312A::INSTR"),
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

    #[test]
    fn powers_action_mapping_and_argument_validation() {
        let set_voltage =
            validate_arguments("set-voltage", &json!({ "channel": 1, "voltage": 5.0 })).unwrap();
        assert_eq!(set_voltage, json!({ "channel": 1, "voltage": 5.0 }));
        for arguments in [
            json!({ "channel": 1, "voltage": 5.0 }),
            json!({ "channel": 1, "current": 0.2 }),
            json!({ "channel": 1, "voltage": 5.0, "current": 0.2 }),
        ] {
            assert_eq!(
                validate_arguments("set-output", &arguments).unwrap(),
                arguments
            );
        }

        let output_on = validate_arguments("output-on", &json!({ "channel": 2 })).unwrap();
        assert_eq!(output_on, json!({ "channel": 2 }));

        let output_off = validate_arguments("output-off", &json!({ "channel": 1 })).unwrap();
        assert_eq!(output_off, json!({ "channel": 1 }));
    }

    #[test]
    fn powers_unsupported_action_and_invalid_arguments_are_rejected() {
        let error = validate_arguments("unknown-action", &json!({ "channel": 1 })).unwrap_err();
        assert!(matches!(error, PowersActionError::InvalidArguments(_)));

        let error = validate_arguments("set-voltage", &json!({ "channel": 0, "voltage": 5.0 }))
            .unwrap_err();
        assert!(matches!(error, PowersActionError::InvalidArguments(_)));

        let error = validate_arguments("set-voltage", &json!({ "channel": 1, "voltage": "high" }))
            .unwrap_err();
        assert!(matches!(error, PowersActionError::InvalidArguments(_)));

        let error = validate_arguments(
            "set-voltage",
            &json!({ "channel": 1, "voltage": 5.0, "extra": true }),
        )
        .unwrap_err();
        assert!(matches!(error, PowersActionError::InvalidArguments(_)));

        let error = validate_arguments("set-voltage", &json!("not-an-object")).unwrap_err();
        assert!(matches!(error, PowersActionError::InvalidArguments(_)));

        for arguments in [
            json!({ "channel": 1 }),
            json!({ "channel": 0, "current": 0.2 }),
            json!({ "channel": 1, "voltage": "high" }),
            json!({ "channel": 1, "current": null }),
            json!({ "channel": 1, "current": 0.2, "extra": true }),
        ] {
            assert!(matches!(
                validate_arguments("set-output", &arguments),
                Err(PowersActionError::InvalidArguments(_))
            ));
        }
        assert!(matches!(
            validate_arguments(
                "set-voltage",
                &json!({ "channel": 1, "voltage": 5.0, "current": 0.2 })
            ),
            Err(PowersActionError::InvalidArguments(_))
        ));
    }

    #[test]
    fn protection_status_arguments_are_exact() {
        for channel in [json!("all"), json!(1), json!(2)] {
            let arguments = json!({ "channel": channel });
            assert_eq!(
                validate_arguments("protection-status", &arguments).unwrap(),
                arguments
            );
        }
        for arguments in [
            json!({}),
            json!({ "channel": 0 }),
            json!({ "channel": -1 }),
            json!({ "channel": 1.5 }),
            json!({ "channel": true }),
            json!({ "channel": "1" }),
            json!({ "channel": "ALL" }),
            json!({ "channel": null }),
            json!({ "channel": 1, "extra": true }),
        ] {
            assert!(
                matches!(
                    validate_arguments("protection-status", &arguments),
                    Err(PowersActionError::InvalidArguments(_))
                ),
                "{arguments}"
            );
        }
    }

    #[test]
    fn protection_status_derives_flags_and_preserves_envelope() {
        for (over_voltage, over_current) in
            [(false, false), (true, false), (false, true), (true, true)]
        {
            let original = json!({
                "request": { "command": "protection-status" },
                "data": { "protection": { "over_voltage_tripped": over_voltage, "over_current_tripped": over_current } },
                "metadata": { "source": "worker" }
            });
            let result = augment_protection_status_result(original.clone()).unwrap();
            assert_eq!(result["protection_tripped"], over_voltage || over_current);
            assert_eq!(result["over_voltage_tripped"], over_voltage);
            assert_eq!(result["over_current_tripped"], over_current);
            for key in ["request", "data", "metadata"] {
                assert_eq!(result[key], original[key]);
            }
        }
    }

    #[test]
    fn malformed_protection_status_fails_closed() {
        for result in [
            json!({ "data": {} }),
            json!({ "data": { "protection": { "over_voltage_tripped": false } } }),
            json!({ "data": { "protection": { "over_voltage_tripped": "false", "over_current_tripped": false } } }),
        ] {
            assert!(matches!(
                augment_protection_status_result(result),
                Err(PowersActionError::InvalidResponse(_))
            ));
        }
    }
}
