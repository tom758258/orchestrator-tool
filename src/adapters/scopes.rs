//! Scopes Common Worker v3 thin adapter; instrument policy stays in scopes-tool.

use crate::{
    config::Config,
    discovery::{ExecutableStatus, built_in_tool_definitions},
    inspection::inspect_tool,
    process::run_output_with_timeout,
    run::ExecutionMode,
    scopes_setup::ScopesSetup,
    tool::ToolId,
    worker::{WorkerLaunchSpec, WorkerSession},
    workflow::ActionId,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ScopesCapabilities {
    pub model_id: String,
    pub model_name: String,
    pub analog_channels: u32,
    pub acquisition_modes: Option<Vec<String>>,
    pub average_counts: Option<Vec<u32>>,
    pub screenshot_formats: Vec<String>,
    pub measurement_items: Option<Vec<String>>,
    pub direct_measurement_items: Vec<String>,
    pub trigger_edge_slopes: Vec<String>,
    pub capture_point_options: Vec<u32>,
    #[serde(default)]
    pub autoscale_supported: bool,
    #[serde(default)]
    pub check_error_supported: bool,
}

pub(crate) const DEFAULT_SIMULATED_MODEL_ID: &str = "keysight-dsox4024a";

fn is_keysight_model(model_id: &str) -> bool {
    matches!(
        model_id,
        "keysight-dsox2004a" | "keysight-dsox3024a" | "keysight-dsox4024a" | "keysight-dsox4034a"
    )
}

pub(crate) fn autoscale_supported_model(model_id: &str) -> bool {
    is_keysight_model(model_id)
}

pub(crate) const DEFAULT_SCREENSHOT_FORMAT: &str = "png";

pub(crate) fn validate_preflight_action(
    action: &str,
    arguments: &Value,
    caps: &ScopesCapabilities,
    check: &mut crate::live_preflight::CapabilityCheck<'_>,
) {
    let channels = json!((1..=caps.analog_channels).collect::<Vec<_>>());
    if action == "autoscale" {
        if !caps.autoscale_supported {
            check.invalid(
                "model",
                "AutoScale is available only for registered Keysight models",
            );
        }
        if let Some(sources) = arguments.get("source_channel") {
            if let Some(sources) = sources.as_array() {
                for channel in sources {
                    check.option("source_channel", channel, Some(channels.clone()));
                }
            } else {
                check.invalid("source_channel", "must be an array of channels");
            }
        }
    }
    let channel_field = match action {
        "channel-display" | "channel-scale" | "channel-offset" | "measure" | "capture" => {
            Some("channel")
        }
        "trigger-edge" => Some("source_channel"),
        _ => None,
    };
    if let Some(field) = channel_field
        && let Some(value) = arguments.get(field)
    {
        if let Some(values) = value.as_array() {
            if action == "capture" {
                if values.is_empty() {
                    check.invalid(field, "must contain at least one channel");
                }
                if values
                    .iter()
                    .enumerate()
                    .any(|(index, value)| values[..index].contains(value))
                {
                    check.invalid(field, "must not contain duplicate channels");
                }
            }
            for value in values {
                check.option(field, value, Some(channels.clone()));
            }
        } else if action == "capture" {
            check.invalid(field, "must be an array of channels");
        } else {
            check.option(field, value, Some(channels));
        }
    }
    let option = match action {
        "measure" => Some(("item", json!(caps.direct_measurement_items))),
        "trigger-edge" => Some(("slope", json!(caps.trigger_edge_slopes))),
        "capture" => Some(("points", json!(caps.capture_point_options))),
        "screenshot" => Some(("format", json!(caps.screenshot_formats))),
        _ => None,
    };
    if let Some((field, supported)) = option
        && let Some(value) = arguments.get(field)
    {
        check.option(field, value, Some(supported));
    }
}

pub(crate) fn validate_preflight_setup(
    setup: &ScopesSetup,
    caps: &ScopesCapabilities,
    check: &mut crate::live_preflight::CapabilityCheck<'_>,
) {
    for channel in &setup.channels {
        check.option(
            "channel",
            &json!(channel.channel),
            Some(json!((1..=caps.analog_channels).collect::<Vec<_>>())),
        );
    }
    if let Some(acquisition) = &setup.acquisition {
        if let Some(mode) = acquisition.acquisition_type {
            check.option(
                "acquisition_type",
                &json!(mode),
                caps.acquisition_modes.as_ref().map(|values| json!(values)),
            );
        }
        if let Some(count) = acquisition.average_count {
            check.option(
                "average_count",
                &json!(count),
                caps.average_counts.as_ref().map(|values| json!(values)),
            );
        }
    }
}

pub fn get_capabilities_for_mode(
    application_dir: &Path,
    config: &Config,
    mode: ExecutionMode,
    model_id: Option<&str>,
) -> Result<ScopesCapabilities, String> {
    let model_id = match mode {
        ExecutionMode::Simulate => None,
        ExecutionMode::Live => Some(
            model_id
                .filter(|id| !id.trim().is_empty())
                .ok_or("Scopes canonical model ID is missing")?,
        ),
    };
    let definition = built_in_tool_definitions()
        .into_iter()
        .find(|d| d.id() == &ToolId::scopes())
        .expect("scopes is built in");
    let inspection =
        inspect_tool(application_dir, config, &definition).map_err(|e| e.to_string())?;
    if inspection.status() != ExecutableStatus::Available {
        return Err("scopes executable is unavailable".into());
    }
    let mut args = vec![OsString::from("capabilities"), OsString::from("--json")];
    if let Some(id) = model_id {
        args.extend([OsString::from("--model"), OsString::from(id)]);
    }
    let output = run_output_with_timeout(
        inspection.resolved().path().expect("available path"),
        args,
        Duration::from_secs(10),
    )
    .map_err(|e| format!("scopes capabilities query failed: {e:?}"))?;
    if !output.status.success() {
        return Err(format!(
            "scopes capabilities query failed with {}: {}",
            output.status,
            cli_error_detail("capabilities", &output.stdout)
                .unwrap_or_else(|| String::from_utf8_lossy(&output.stderr).trim().to_owned())
        ));
    }
    parse_capabilities(&output.stdout, model_id)
}

pub(crate) fn cli_error_detail(command: &str, stdout: &[u8]) -> Option<String> {
    let response: Value = serde_json::from_slice(stdout).ok()?;
    if response["schema_version"].as_u64() != Some(2)
        || response["event"] != "error"
        || response["command"] != command
        || response["ok"] != false
    {
        return None;
    }
    response["error"]["message"]
        .as_str()
        .filter(|message| !message.trim().is_empty())
        .map(str::to_owned)
}

fn parse_capabilities(stdout: &[u8], model_id: Option<&str>) -> Result<ScopesCapabilities, String> {
    #[derive(Deserialize)]
    struct Model {
        model_id: String,
        display_name: String,
    }
    #[derive(Deserialize)]
    struct Data {
        analog_channels: u32,
        acquisition_modes: Option<Vec<String>>,
        average_counts: Option<Vec<u32>>,
        screenshot_formats: Vec<String>,
        measurement_items: Option<Vec<String>>,
        direct_measurement_items: Vec<String>,
        trigger_edge_slopes: Vec<String>,
        capture_point_options: Vec<u32>,
        supported_operations: Option<Vec<String>>,
    }
    #[derive(Deserialize)]
    struct Response {
        schema_version: u32,
        event: String,
        model: Model,
        capabilities: Data,
    }
    let r: Response = serde_json::from_slice(stdout)
        .map_err(|e| format!("scopes capabilities returned invalid JSON or shape: {e}"))?;
    if r.schema_version != 2
        || r.event != "capabilities"
        || r.model.model_id.trim().is_empty()
        || model_id.is_some_and(|id| id != r.model.model_id)
        || r.capabilities.analog_channels == 0
    {
        return Err("scopes capabilities returned invalid identity or success data".into());
    }
    let autoscale_supported = autoscale_supported_model(&r.model.model_id);
    Ok(ScopesCapabilities {
        model_id: r.model.model_id,
        model_name: r.model.display_name,
        analog_channels: r.capabilities.analog_channels,
        acquisition_modes: r.capabilities.acquisition_modes,
        average_counts: r.capabilities.average_counts,
        screenshot_formats: r.capabilities.screenshot_formats,
        measurement_items: r.capabilities.measurement_items,
        direct_measurement_items: r.capabilities.direct_measurement_items,
        trigger_edge_slopes: r.capabilities.trigger_edge_slopes,
        capture_point_options: r.capabilities.capture_point_options,
        autoscale_supported,
        check_error_supported: r
            .capabilities
            .supported_operations
            .is_none_or(|operations| operations.iter().any(|name| name == "check-error")),
    })
}

pub fn simulate_worker_launch_spec(executable: impl AsRef<Path>) -> WorkerLaunchSpec {
    WorkerLaunchSpec::new(
        executable.as_ref(),
        ["worker", "--simulate", "--port", "0", "--format", "jsonl"],
    )
}
pub fn live_worker_launch_spec(
    executable: impl AsRef<Path>,
    resource: &str,
    model_id: &str,
    backend: crate::config::VisaBackend,
) -> WorkerLaunchSpec {
    WorkerLaunchSpec::new(
        executable.as_ref(),
        [
            "worker",
            "--live",
            "--resource",
            resource,
            "--model",
            model_id,
            "--port",
            "0",
            "--format",
            "jsonl",
        ]
        .into_iter()
        .chain(
            (backend == crate::config::VisaBackend::Py)
                .then_some(["--visa-library", "@py"])
                .into_iter()
                .flatten(),
        ),
    )
}

/// Scopes background opts into the existing Worker Stream without changing
/// the foreground worker launch arguments.
pub fn background_worker_launch_spec(spec: &WorkerLaunchSpec) -> WorkerLaunchSpec {
    WorkerLaunchSpec::new(
        spec.executable(),
        spec.arguments()
            .iter()
            .cloned()
            .chain(std::iter::once(OsString::from("--streaming"))),
    )
}

/// Start the Scopes-specific deferred source after all setup jobs have completed.
/// HTTP acceptance is not evidence that the source is active.
pub fn start_background_stream(
    session: &WorkerSession,
    measurements: &[crate::background::ScopesMeasurement],
    count: Option<usize>,
    interval_seconds: f64,
    timeout: Duration,
) -> Result<(), String> {
    let (code, result) = crate::worker_http::WorkerClient::new(session.ready())
        .command_with_rejection_timeout(
            &json!({
                "schema_version": 3,
                "command": "measure-stream-start",
                "arguments": {
                    "measurements": measurements,
                    "count": count,
                    "interval_seconds": interval_seconds
                }
            }),
            timeout,
        )
        .map_err(|e| e.to_string())?;
    if code != 202
        || result["kind"] != "control"
        || result["run_id"] != session.ready().run_id()
        || !result["worker_job_id"].is_null()
        || !result["error"].is_null()
    {
        return Err(format!(
            "Scopes source start rejected or invalid: HTTP {code}: {result}"
        ));
    }
    session.wait_for_deferred_stream_start(timeout)
}

pub fn validate_session(
    session: &WorkerSession,
    mode: ExecutionMode,
    spec: &WorkerLaunchSpec,
    timeout: Duration,
) -> Result<(), String> {
    let status = validated_status(session, timeout)?;
    let argument = |flag: &str| {
        spec.arguments()
            .windows(2)
            .find(|pair| pair[0] == flag)
            .and_then(|pair| pair[1].to_str())
    };
    let model = match mode {
        ExecutionMode::Simulate => argument("--model").unwrap_or(DEFAULT_SIMULATED_MODEL_ID),
        ExecutionMode::Live => argument("--model")
            .filter(|id| !id.trim().is_empty())
            .ok_or("Scopes canonical model ID is missing from the Live launch")?,
    };
    let resource = if mode == ExecutionMode::Live {
        Some(
            argument("--resource")
                .filter(|value| !value.is_empty())
                .ok_or("Scopes resource is missing from the Live launch")?,
        )
    } else {
        None
    };
    if status["mode"] != mode.to_string()
        || status["model"] != model
        || (mode == ExecutionMode::Live && status["resource"].as_str() != resource)
    {
        return Err(
            "Scopes Worker startup identity did not match the selected mode, model and resource"
                .into(),
        );
    }
    let identity = status_identity(&status);
    if session.startup_identity.get_or_init(|| identity.clone()) != &identity {
        return Err("Scopes Worker identity changed after startup".into());
    }
    Ok(())
}

fn status_identity(status: &Value) -> Value {
    json!({
        "mode": status["mode"],
        "model": status["model"],
        "resource": status["resource"],
    })
}

fn validated_status(session: &WorkerSession, timeout: Duration) -> Result<Value, String> {
    let status = crate::worker_http::WorkerClient::new(session.ready())
        .status_with_timeout(timeout)
        .map_err(|e| e.to_string())?;
    if status["schema_version"].as_u64() != Some(3)
        || status["service"] != "scopes-tool"
        || status["run_id"] != session.ready().run_id()
    {
        return Err("invalid Scopes Worker status identity".into());
    }
    if status.get("fatal_error").is_some_and(|e| !e.is_null()) || status["worker_state"] == "failed"
    {
        return Err(format!(
            "Scopes Worker fatal error: {}",
            status["fatal_error"]
        ));
    }
    Ok(status)
}

static NEXT_JOB: AtomicU64 = AtomicU64::new(0);

fn run_command(
    session: &WorkerSession,
    command: &str,
    arguments: &Value,
    timeout: Duration,
) -> Result<Value, String> {
    let job_id = format!(
        "orchestrator-scopes-{}-{}",
        std::process::id(),
        NEXT_JOB.fetch_add(1, Ordering::Relaxed)
    );
    let terminal = session.run_async_job(command, arguments, None, &job_id, timeout)?;
    terminal_result(&terminal, command, arguments)
}

fn run_with_readback(
    session: &WorkerSession,
    command: &str,
    arguments: &Value,
    timeout: Duration,
) -> Result<Value, String> {
    if arguments["query"] == true {
        return run_command(session, command, arguments, timeout);
    }
    let fields: &[(&str, &str)] = match command {
        "acquisition" => &[("type", "type"), ("count", "count")],
        "channel-coupling" => &[("coupling", "coupling")],
        "channel-probe" => &[("ratio", "probe_ratio")],
        "channel-bandwidth-limit" => &[("on/off", "bandwidth_limit")],
        "channel-invert" => &[("on/off", "invert")],
        "channel-units" => &[("units", "units")],
        "channel-display" => &[("on/off", "display")],
        "channel-scale" => &[("volts_per_division", "volts_per_division")],
        "channel-offset" => &[("volts", "volts")],
        "timebase-scale" => &[("seconds_per_division", "seconds_per_division")],
        "timebase-position" => &[("seconds", "position_seconds")],
        "trigger-edge" => &[
            ("source_channel", "source_channel"),
            ("level", "level_volts"),
            ("slope", "slope"),
        ],
        _ => return run_command(session, command, arguments, timeout),
    };
    let channel = arguments.get("channel");
    let target = match channel {
        Some(channel) => format!("Scopes {command}, channel {channel}"),
        None => format!("Scopes {command}"),
    };
    let numeric_policy = fields
        .iter()
        .any(|(argument, field)| is_numeric_readback(field) && arguments.get(argument).is_some())
        .then(|| readback_model_policy(session, timeout))
        .transpose()
        .map_err(|error| format!("{target} readback model check failed: {error}"))?;
    let result = run_command(session, command, arguments, timeout)
        .map_err(|error| format!("{target} Set failed: {error}"))?;
    let mut query = json!({"query":true});
    if let Some(channel) = channel {
        query["channel"] = channel.clone();
    }
    let readback = run_command(session, command, &query, timeout)
        .map_err(|error| format!("{target} readback query failed: {error}"))?;
    if readback["operation"] != "query" {
        return Err(format!(
            "{target} readback expected operation \"query\", got {}",
            readback["operation"]
        ));
    }
    let check = |field, expected: &Value| {
        let policy = numeric_policy.filter(|_| is_numeric_readback(field));
        compare_readback(field, expected, &readback[field], policy)
            .map_err(|error| format!("{target} readback {error}"))
    };
    if let Some(channel) = channel {
        check("channel", channel)?;
    }
    for &(argument, field) in fields {
        if argument == "on/off" {
            check(field, &Value::Bool(arguments["on"] == true))?;
        } else if let Some(expected) = arguments.get(argument) {
            check(field, expected)?;
        }
    }
    Ok(result)
}

#[derive(Clone, Copy)]
enum ReadbackPolicy {
    Keysight,
    Tektronix,
    TektronixAbsoluteEdgeLevel,
}

fn readback_model_policy(
    session: &WorkerSession,
    timeout: Duration,
) -> Result<ReadbackPolicy, String> {
    let startup_identity = session
        .startup_identity
        .get()
        .ok_or("Scopes Worker startup identity has not been verified")?;
    let status = validated_status(session, timeout)?;
    if &status_identity(&status) != startup_identity {
        return Err("Scopes Worker identity changed after startup".into());
    }
    match status["model"].as_str() {
        Some("tektronix-tbs2074") => Ok(ReadbackPolicy::Tektronix),
        Some("tektronix-tds2024b" | "tektronix-tbs1052b") => {
            Ok(ReadbackPolicy::TektronixAbsoluteEdgeLevel)
        }
        Some(model) if is_keysight_model(model) => Ok(ReadbackPolicy::Keysight),
        model => Err(format!(
            "unsupported Scopes Worker model for numeric readback: {model:?}"
        )),
    }
}

fn is_numeric_readback(field: &str) -> bool {
    matches!(
        field,
        "probe_ratio"
            | "volts_per_division"
            | "volts"
            | "seconds_per_division"
            | "position_seconds"
            | "level_volts"
    )
}

fn compare_readback(
    field: &str,
    expected: &Value,
    actual: &Value,
    policy: Option<ReadbackPolicy>,
) -> Result<(), String> {
    if actual.is_null() {
        return Err(format!("is missing {field} (expected {expected})"));
    }
    if let Some(policy) = policy {
        let (expected_number, actual_number) = expected
            .as_f64()
            .zip(actual.as_f64())
            .filter(|(expected, actual)| expected.is_finite() && actual.is_finite())
            .ok_or_else(|| format!("invalid numeric {field}: expected {expected}, got {actual}"))?;
        let mut difference = (expected_number - actual_number).abs();
        let magnitude = expected_number.abs();
        let tolerance = match (policy, field) {
            (ReadbackPolicy::TektronixAbsoluteEdgeLevel, "level_volts") => {
                // Match the Scopes CLI check at the absolute tolerance boundary.
                difference = (difference * 1e12).round_ties_even() / 1e12;
                0.05
            }
            (ReadbackPolicy::Keysight, _) | (_, "level_volts") => (magnitude * 1e-3).max(1e-12),
            _ => 1e-6 * magnitude.max(1e-12),
        };
        if difference > tolerance {
            return Err(format!(
                "mismatch for {field}: expected {expected}, got {actual} (tolerance {tolerance:e})"
            ));
        }
    } else if actual != expected {
        return Err(format!(
            "mismatch for {field}: expected {expected}, got {actual}"
        ));
    }
    Ok(())
}

pub(crate) fn validate_single_wait_arguments(arguments: &Value) -> Result<u64, String> {
    let fields = arguments
        .as_object()
        .ok_or("Scopes single-wait arguments must be an object")?;
    for key in fields.keys() {
        if !matches!(
            key.as_str(),
            "trigger_timeout_ms" | "trigger_poll_interval_ms"
        ) {
            return Err(format!("unsupported Scopes single-wait parameter {key}"));
        }
    }
    let positive = |key: &str, default: u64| -> Result<u64, String> {
        match fields.get(key) {
            None => Ok(default),
            Some(value) => value
                .as_u64()
                .filter(|number| *number > 0)
                .ok_or_else(|| format!("Scopes single-wait {key} must be a positive integer")),
        }
    };
    let trigger_timeout = positive("trigger_timeout_ms", 5000)?;
    let poll_interval = positive("trigger_poll_interval_ms", 100)?;
    if poll_interval > trigger_timeout {
        return Err(
            "Scopes single-wait trigger_poll_interval_ms must not exceed trigger_timeout_ms".into(),
        );
    }
    Ok(trigger_timeout)
}

fn expected_single_wait_timeout(event: &Value) -> bool {
    let result = &event["result"];
    let error = &event["error"];
    if event["state"] != "failed"
        || event["ok"] != false
        || event["exit_code"].as_i64() != Some(1)
        || error["category"] != "execution"
        || error["code"] != "job_failed"
        || !error["details"]
            .as_object()
            .is_some_and(|details| details.is_empty())
        || result["operation"] != "single-wait"
        || result["outcome"] != "timeout"
        || result["timed_out"] != true
        || result["forced"] != false
        || result["force_on_timeout"] != false
        || result["capture_allowed"] != false
        || result.get("error") != Some(&Value::Null)
    {
        return false;
    }
    let system_ok = result["system_error"]["is_error"] == false
        && result["system_error"]["code"].as_i64() == Some(0);
    let status = &result["post_command_status"];
    // Scopes' Tektronix CLI performs the native status check before returning.
    // Legacy Tektronix status may have only the raw and numeric SESR fields.
    let tek_ok = status["raw"].as_str().is_some_and(|raw| !raw.is_empty())
        && status["value"].as_u64().is_some()
        && status
            .get("is_error")
            .is_none_or(|value| value.as_bool() == Some(false))
        && status
            .get("complete")
            .is_none_or(|value| value.as_bool() == Some(true));
    // Neither clean status may override an explicit error from the other.
    (system_ok || tek_ok)
        && (result["system_error"].is_null() || system_ok)
        && (status.is_null() || tek_ok)
}

fn expected_measure_invalid(event: &Value) -> bool {
    let result = &event["result"];
    let error = &event["error"];
    if event["state"] != "failed"
        || event["ok"] != false
        || event["exit_code"].as_i64() != Some(1)
        || error["category"] != "execution"
        || error["code"] != "job_failed"
        || !error["details"]
            .as_object()
            .is_some_and(|details| details.is_empty())
        || result["valid"] != false
        || result.get("value") != Some(&Value::Null)
        || result["reason"] != "invalid measurement sentinel"
        || result.get("error").is_some_and(|error| !error.is_null())
    {
        return false;
    }

    let system_ok = result["system_error"]["code"].as_i64() == Some(0)
        && result["system_error"]["is_error"] == false;
    let status = &result["post_command_status"];
    // Tektronix may report is_error=true solely because the measurement is
    // invalid. Its native, completed SESR checkpoint must still be clean.
    let tek_ok = status["source"] == "tektronix-sesr"
        && status["raw"].as_str().is_some_and(|raw| !raw.is_empty())
        && status["value"].as_u64() == Some(0)
        && status["complete"] == true
        && status["is_error"].as_bool().is_some()
        && status["events"]
            .as_array()
            .is_some_and(|events| events.is_empty());
    // Neither status can override conflicting evidence from the other.
    (system_ok || tek_ok)
        && (result["system_error"].is_null() || system_ok)
        && (status.is_null() || tek_ok)
}

fn terminal_result(event: &Value, command: &str, arguments: &Value) -> Result<Value, String> {
    if !(command == "single-wait" && expected_single_wait_timeout(event))
        && !(command == "measure" && expected_measure_invalid(event))
        && (event["state"] != "succeeded"
            || event["ok"] != true
            || event["exit_code"].as_i64() != Some(0)
            || !event["error"].is_null())
    {
        let state = event["state"].as_str().unwrap_or("unknown");
        let mut message = format!("Scopes {command} ended with {state:?}");
        if let Some(exit_code) = event["exit_code"].as_i64() {
            message.push_str(&format!(" (exit code {exit_code})"));
        }
        let detail = event["error"]["message"]
            .as_str()
            .filter(|message| !message.trim().is_empty())
            .or_else(|| {
                // Cancellation and other abnormal states are not invalid measurements.
                if command == "measure" && state == "failed" && event["result"]["valid"] == false {
                    event["result"]["reason"]
                        .as_str()
                        .filter(|reason| !reason.trim().is_empty())
                } else {
                    None
                }
            });
        if let Some(detail) = detail {
            message.push_str(": ");
            message.push_str(detail);
        }
        return Err(message);
    }
    let mut result = event["result"]
        .as_object()
        .cloned()
        .ok_or("Scopes job_finished has no structured result")?;
    if matches!(command, "capture" | "screenshot") {
        let files = event["files"]
            .as_array()
            .ok_or("Scopes job_finished has no files array")?;
        for key in if command == "capture" {
            &["csv", "meta"][..]
        } else {
            &["output"][..]
        } {
            let path = arguments[key]
                .as_str()
                .ok_or("missing Scopes output path")?;
            if !files.iter().any(|file| file["path"].as_str() == Some(path))
                || !Path::new(path).is_file()
            {
                return Err(format!(
                    "Scopes {command} did not produce the required {key} file: {path}"
                ));
            }
        }
        result.insert("files".into(), event["files"].clone());
    }
    Ok(Value::Object(result))
}

pub fn setup_commands(setup: &ScopesSetup) -> Vec<(String, Value)> {
    let mut commands = Vec::new();
    if let Some(a) = &setup.acquisition {
        let mut args = json!({});
        if let Some(value) = a.acquisition_type {
            args["type"] = json!(value);
        }
        if let Some(value) = a.average_count {
            args["count"] = json!(value);
        }
        commands.push(("acquisition".into(), args));
    }
    for c in &setup.channels {
        for (command, key, value) in [
            ("channel-coupling", "coupling", c.coupling.map(|v| json!(v))),
            ("channel-probe", "ratio", c.probe_ratio.map(|v| json!(v))),
            (
                "channel-bandwidth-limit",
                if c.bandwidth_limit == Some(true) {
                    "on"
                } else {
                    "off"
                },
                c.bandwidth_limit.map(|_| json!(true)),
            ),
            (
                "channel-invert",
                if c.invert == Some(true) { "on" } else { "off" },
                c.invert.map(|_| json!(true)),
            ),
            ("channel-units", "units", c.units.map(|v| json!(v))),
        ] {
            if let Some(value) = value {
                let mut args = json!({"channel":c.channel});
                args[key] = value;
                commands.push((command.into(), args));
            }
        }
    }
    commands
}

pub fn apply_setup(
    session: &WorkerSession,
    setup: &ScopesSetup,
    timeout: Duration,
) -> Result<(), String> {
    for (command, arguments) in setup_commands(setup) {
        run_with_readback(session, &command, &arguments, timeout)?;
    }
    Ok(())
}

/// Validate a complete cycle without interpreting instrument-specific items.
pub fn validate_background_sample(
    sample: &Value,
    measurements: &[crate::background::ScopesMeasurement],
) -> Result<(), String> {
    if sample["schema_version"].as_u64() != Some(3)
        || sample["event"] != "sample"
        || sample["index"].as_u64().is_none_or(|n| n == 0)
        || sample["elapsed_seconds"]
            .as_f64()
            .is_none_or(|n| !n.is_finite() || n < 0.0)
        || sample["timestamp_utc"].as_str().is_none()
    {
        return Err("Invalid Scopes measurement cycle envelope".into());
    }
    let values = sample["values"]
        .as_object()
        .ok_or("Scopes sample has no values map")?;
    if values.len() != measurements.len() {
        return Err("Scopes sample measurement field count mismatch".into());
    }
    for measurement in measurements {
        let reading = values
            .get(&measurement.id)
            .ok_or_else(|| format!("Scopes sample missing measurement {}", measurement.id))?;
        let valid = reading["valid"]
            .as_bool()
            .ok_or("Scopes sample measurement lacks valid flag")?;
        if !reading["unit"].is_string() && !reading["unit"].is_null() {
            return Err("Scopes sample measurement has invalid unit".into());
        }
        if !reading["reason"].is_string() && !reading["reason"].is_null() {
            return Err("Scopes sample measurement has invalid reason".into());
        }
        if valid {
            if reading["value"].as_f64().is_none_or(|v| !v.is_finite()) {
                return Err("Scopes sample valid measurement must be a finite number".into());
            }
        } else if !reading["value"].is_null() {
            return Err("Scopes sample invalid measurement must have null value".into());
        }
    }
    Ok(())
}

pub const ACTIONS: &[&str] = &[
    "channel-display",
    "channel-scale",
    "channel-offset",
    "timebase-scale",
    "timebase-position",
    "trigger-edge",
    "single-wait",
    "measure",
    "capture",
    "screenshot",
    "autoscale",
];
pub fn run_action(
    session: &WorkerSession,
    action: &ActionId,
    arguments: &Value,
    output_folder: Option<&Path>,
    timeout: Duration,
) -> Result<Value, String> {
    let command = action.as_str();
    if !ACTIONS.contains(&command) {
        return Err(format!("unsupported Scopes action {action}"));
    }
    let mut arguments = arguments.clone();
    if !arguments.is_object() {
        return Err("Scopes arguments must be an object".into());
    }
    if matches!(command, "capture" | "screenshot") {
        prepare_file_arguments(command, &mut arguments, output_folder)?;
    }
    // The trigger wait belongs to Scopes; the caller timeout covers Worker overhead.
    let timeout = match command {
        "single-wait" => {
            let trigger_ms = validate_single_wait_arguments(&arguments)?;
            let deadline = timeout
                .checked_add(Duration::from_millis(trigger_ms))
                .ok_or("Scopes single-wait action timeout overflow")?;
            if Instant::now().checked_add(deadline).is_none() {
                return Err("Scopes single-wait action deadline is not representable".into());
            }
            deadline
        }
        "capture" | "screenshot" => timeout.max(Duration::from_secs(30)),
        "autoscale" => timeout.max(Duration::from_secs(60)),
        _ => timeout,
    };
    run_with_readback(session, command, &arguments, timeout)
}

fn prepare_file_arguments(
    command: &str,
    arguments: &mut Value,
    folder: Option<&Path>,
) -> Result<(), String> {
    for key in ["csv", "meta", "plot", "output", "query_hardcopy"] {
        if arguments.get(key).is_some() {
            return Err(format!("Scopes {key} is managed by Scopes File Output"));
        }
    }
    let folder = match folder {
        Some(folder) => folder.to_path_buf(),
        None => std::env::current_exe()
            .map_err(|e| e.to_string())?
            .parent()
            .ok_or("Orchestrator application folder is unavailable")?
            .join("data"),
    };
    if !folder.is_absolute() {
        return Err("Scopes File Output folder must be absolute".into());
    }
    fs::create_dir_all(&folder).map_err(|e| {
        format!(
            "could not create Scopes File Output folder {}: {e}",
            folder.display()
        )
    })?;
    let extension = match command {
        "capture" => "csv",
        _ => match arguments
            .get("format")
            .and_then(Value::as_str)
            .unwrap_or(DEFAULT_SCREENSHOT_FORMAT)
        {
            "png" => "png",
            "bmp" | "bmp8bit" => "bmp",
            "jpeg" => "jpeg",
            other => return Err(format!("unsupported screenshot format {other}")),
        },
    };
    let (output, meta) = unique_output_paths(&folder, command, extension)?;
    if command == "capture" {
        arguments["csv"] = json!(output);
        arguments["meta"] = json!(meta);
    } else {
        arguments["output"] = json!(output);
    }
    Ok(())
}

fn unique_output_paths(
    folder: &Path,
    command: &str,
    extension: &str,
) -> Result<(PathBuf, PathBuf), String> {
    loop {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos();
        let name = format!(
            "scopes-{command}-{stamp}-{}-{}",
            std::process::id(),
            NEXT_JOB.fetch_add(1, Ordering::Relaxed)
        );
        let output = folder.join(format!("{name}.{extension}"));
        let meta = folder.join(format!("{name}-meta.json"));
        if !output.exists() && !meta.exists() {
            return Ok((output, meta));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "Requires explicitly supplied Scopes simulation executable"]
    fn scopes_real_setup_state_survives_jobs() {
        let exe = std::env::var_os("ORCHESTRATOR_TEST_SCOPES_EXE").expect("Scopes EXE required");
        let spec = simulate_worker_launch_spec(PathBuf::from(exe));
        let session = crate::worker::start_worker(&spec, Duration::from_secs(10)).unwrap();
        validate_session(
            &session,
            ExecutionMode::Simulate,
            &spec,
            Duration::from_secs(5),
        )
        .unwrap();
        let template = crate::template::Template::from_json_str(include_str!(
            "../../tests/fixtures/scopes/setup-measure.json"
        ))
        .unwrap();
        apply_setup(
            &session,
            template.tool_instances()[0].scopes_setup().unwrap(),
            Duration::from_secs(5),
        )
        .unwrap();
        let acquisition = run_command(
            &session,
            "acquisition",
            &json!({"query":true}),
            Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(acquisition["type"], "average");
        assert_eq!(acquisition["count"], 16);
        for channel in [1, 2] {
            for command in [
                "channel-coupling",
                "channel-probe",
                "channel-bandwidth-limit",
                "channel-invert",
                "channel-units",
            ] {
                let result = run_command(
                    &session,
                    command,
                    &json!({"channel":channel,"query":true}),
                    Duration::from_secs(5),
                )
                .unwrap();
                let expected = match command {
                    "channel-coupling" => {
                        ("coupling", json!(if channel == 1 { "dc" } else { "ac" }))
                    }
                    "channel-probe" => {
                        ("probe_ratio", json!(if channel == 1 { 10.0 } else { 1.0 }))
                    }
                    "channel-bandwidth-limit" => ("bandwidth_limit", json!(channel == 1)),
                    "channel-invert" => ("invert", json!(channel == 1)),
                    _ => ("units", json!(if channel == 1 { "amp" } else { "volt" })),
                };
                assert_eq!(
                    result[expected.0], expected.1,
                    "{command} channel {channel}: {result}"
                );
            }
        }
        assert!(session.shutdown(Duration::from_secs(5)).unwrap().success());
    }
    #[test]
    fn scopes_autoscale_model_policy_accepts_only_registered_keysight() {
        for model in [
            "keysight-dsox2004a",
            "keysight-dsox3024a",
            "keysight-dsox4024a",
            "keysight-dsox4034a",
        ] {
            assert!(autoscale_supported_model(model), "{model}");
        }
        for model in [
            "tektronix-tbs2074",
            "tektronix-tds2024b",
            "tektronix-tbs1052b",
            "keysight-unknown",
            "",
        ] {
            assert!(!autoscale_supported_model(model), "{model}");
        }
    }

    #[test]
    fn scopes_maps_only_explicit_setup() {
        assert!(setup_commands(&ScopesSetup::default()).is_empty());
        let setup: ScopesSetup = serde_json::from_value(json!({"acquisition":{"acquisition_type":"average","average_count":16},"channels":[{"channel":2,"invert":false,"bandwidth_limit":true,"units":"amp"}]})).unwrap();
        assert_eq!(
            setup_commands(&setup),
            vec![
                ("acquisition".into(), json!({"type":"average","count":16})),
                (
                    "channel-bandwidth-limit".into(),
                    json!({"channel":2,"on":true})
                ),
                ("channel-invert".into(), json!({"channel":2,"off":true})),
                ("channel-units".into(), json!({"channel":2,"units":"amp"}))
            ]
        );
    }

    #[test]
    fn scopes_readback_compares_numeric_boundaries_and_rejects_malformed_values() {
        let keysight = Some(ReadbackPolicy::Keysight);
        let tektronix = Some(ReadbackPolicy::Tektronix);
        let absolute_edge = Some(ReadbackPolicy::TektronixAbsoluteEdgeLevel);
        for (field, expected, actual, policy, matches) in [
            ("position_seconds", json!(0), json!(1e-12), keysight, true),
            (
                "position_seconds",
                json!(0),
                json!(1.1e-12),
                keysight,
                false,
            ),
            (
                "seconds_per_division",
                json!(1e-9),
                json!(1.0005e-9),
                keysight,
                true,
            ),
            (
                "seconds_per_division",
                json!(1e-9),
                json!(1.0005e-9),
                tektronix,
                false,
            ),
            ("probe_ratio", json!(10), json!(10.009), keysight, true),
            ("level_volts", json!(1.0), json!(1.04), keysight, false),
            ("level_volts", json!(1.0), json!(1.0005), tektronix, true),
            ("level_volts", json!(1.0), json!(1.0011), tektronix, false),
            ("level_volts", json!(1.0), json!(1.05), absolute_edge, true),
            ("level_volts", json!(1.0), json!(1.06), absolute_edge, false),
            ("level_volts", json!(1e-9), json!(0.05), absolute_edge, true),
            ("volts", json!(1.0), json!(1.0005), absolute_edge, false),
            ("volts", json!(1), json!("1"), keysight, false),
            ("volts", json!(1), Value::Null, keysight, false),
            ("count", json!(16), json!(17), None, false),
            ("invert", json!(false), json!(0), None, false),
            ("source_channel", json!(1), json!(2), None, false),
            ("slope", json!("positive"), json!("negative"), None, false),
        ] {
            assert_eq!(
                compare_readback(field, &expected, &actual, policy).is_ok(),
                matches,
                "{field}: expected {expected}, got {actual}"
            );
        }
    }
    #[test]
    fn scopes_capabilities_preserves_unknown_information_and_checks_model() {
        let value = json!({"schema_version":2,"event":"capabilities","model":{"model_id":"test","display_name":"Test"},"capabilities":{"analog_channels":2,"acquisition_modes":["normal","average"],"average_counts":[4,16],"screenshot_formats":["bmp"],"measurement_items":["pair-only"],"direct_measurement_items":["vpp","frequency"],"trigger_edge_slopes":["positive","negative"],"capture_point_options":[1000,5000],"future":true}});
        let caps = parse_capabilities(value.to_string().as_bytes(), Some("test")).unwrap();
        assert_eq!(caps.average_counts, Some(vec![4, 16]));
        assert_eq!(caps.measurement_items, Some(vec!["pair-only".into()]));
        assert_eq!(caps.direct_measurement_items, vec!["vpp", "frequency"]);
        assert_eq!(caps.trigger_edge_slopes, vec!["positive", "negative"]);
        assert_eq!(caps.capture_point_options, vec![1000, 5000]);
        for (operations, supported) in [
            (Value::Null, true),
            (json!(["check-error"]), true),
            (json!(["measure"]), false),
        ] {
            let mut capability = value.clone();
            capability["capabilities"]["supported_operations"] = operations;
            assert_eq!(
                parse_capabilities(capability.to_string().as_bytes(), None)
                    .unwrap()
                    .check_error_supported,
                supported
            );
        }
        let serialized = serde_json::to_value(&caps).unwrap();
        for field in [
            "direct_measurement_items",
            "trigger_edge_slopes",
            "capture_point_options",
        ] {
            assert_eq!(serialized[field], value["capabilities"][field]);
            let mut missing = value.clone();
            missing["capabilities"]
                .as_object_mut()
                .unwrap()
                .remove(field);
            assert!(
                parse_capabilities(missing.to_string().as_bytes(), None)
                    .unwrap_err()
                    .contains(field)
            );
            for invalid in [Value::Null, json!("invalid")] {
                let mut malformed = value.clone();
                malformed["capabilities"][field] = invalid;
                assert!(parse_capabilities(malformed.to_string().as_bytes(), None).is_err());
            }
            let mut empty = value.clone();
            empty["capabilities"][field] = json!([]);
            assert_eq!(
                serde_json::to_value(
                    parse_capabilities(empty.to_string().as_bytes(), None).unwrap()
                )
                .unwrap()[field],
                json!([])
            );
        }
        let mut no_allowlist = value.clone();
        no_allowlist["capabilities"]
            .as_object_mut()
            .unwrap()
            .remove("measurement_items");
        assert!(
            parse_capabilities(no_allowlist.to_string().as_bytes(), None)
                .unwrap()
                .measurement_items
                .is_none()
        );
        assert!(parse_capabilities(value.to_string().as_bytes(), Some("other")).is_err());
        let error = json!({"schema_version":2,"event":"error","command":"capabilities","ok":false,
            "error":{"message":"Unsupported physical oscilloscope model ID: unknown-model"}});
        assert!(
            cli_error_detail("capabilities", error.to_string().as_bytes())
                .unwrap()
                .contains("unknown-model")
        );
        assert!(cli_error_detail("list-resources", error.to_string().as_bytes()).is_none());
    }
    #[test]
    fn scopes_measure_only_clean_invalid_sentinel_is_branchable() {
        let event = json!({
            "event":"job_finished", "state":"failed", "ok":false, "exit_code":1,
            "error":{"category":"execution","code":"job_failed",
                     "message":"job failed","details":{}},
            "result":{
                "item":"vpp","channel":1,"value":null,"unit":"V",
                "valid":false,"raw_value":"9.9E+37",
                "reason":"invalid measurement sentinel",
                "system_error":{"code":0,"is_error":false}
            }
        });
        assert_eq!(
            terminal_result(&event, "measure", &json!({})).unwrap(),
            event["result"]
        );
        assert!(terminal_result(&event, "single-wait", &json!({})).is_err());

        let mut tek = event.clone();
        tek["result"]
            .as_object_mut()
            .unwrap()
            .remove("system_error");
        // Native SESR is clean; Scopes marks is_error because the value is invalid.
        tek["result"]["post_command_status"] = json!({
            "source":"tektronix-sesr", "raw":"0", "value":0,
            "complete":true, "events":[], "is_error":true
        });
        assert_eq!(
            terminal_result(&tek, "measure", &json!({})).unwrap(),
            tek["result"]
        );

        for (field, replacement) in [
            ("state", json!("cancelled")),
            ("ok", json!(true)),
            ("exit_code", json!(3)),
            (
                "error",
                json!({"category":"execution","code":"job_failed",
                    "message":"instrument failed",
                    "details":{"domain_error":{"message":"instrument failed"}}}),
            ),
        ] {
            let mut altered = event.clone();
            altered[field] = replacement;
            assert!(terminal_result(&altered, "measure", &json!({})).is_err());
        }
        for (field, replacement) in [
            ("valid", json!(true)),
            ("value", json!(0)),
            ("reason", json!("unsupported measurement")),
            ("system_error", json!(null)),
            ("system_error", json!({"code":-222,"is_error":true})),
            ("error", json!({"message":"unexpected domain error"})),
        ] {
            let mut altered = event.clone();
            altered["result"][field] = replacement;
            assert!(terminal_result(&altered, "measure", &json!({})).is_err());
        }
        let mut missing = event.clone();
        missing["result"]
            .as_object_mut()
            .unwrap()
            .remove("system_error");
        assert!(terminal_result(&missing, "measure", &json!({})).is_err());

        for (field, replacement) in [
            ("source", json!("unknown")),
            ("raw", json!("")),
            ("value", json!(4)),
            ("complete", json!(false)),
            ("events", json!([{"code":123,"category":"error"}])),
            ("is_error", json!(null)),
        ] {
            let mut altered = tek.clone();
            altered["result"]["post_command_status"][field] = replacement;
            assert!(terminal_result(&altered, "measure", &json!({})).is_err());
        }
        let mut conflicting = tek;
        conflicting["result"]["system_error"] = json!({"code":-222,"is_error":true});
        assert!(terminal_result(&conflicting, "measure", &json!({})).is_err());
    }

    #[test]
    fn scopes_terminal_measure_failure_uses_result_reason() {
        let event = json!({"event":"job_finished","state":"failed","ok":false,"exit_code":3,
            "error":null,"result":{"valid":false,"reason":"Measurement is out of range",
                "channel":1,"item":"vpp"}});
        let error = terminal_result(&event, "measure", &json!({})).unwrap_err();
        assert!(error.contains("Measurement is out of range"));
        assert!(!error.contains("null"));
    }
    #[test]
    fn scopes_terminal_worker_error_takes_priority() {
        let event = json!({"event":"job_finished","state":"failed","ok":false,"exit_code":3,
            "error":{"message":"  Instrument communication failed  "},
            "result":{"valid":false,"reason":"Measurement is out of range"}});
        let error = terminal_result(&event, "measure", &json!({})).unwrap_err();
        assert!(error.ends_with(":   Instrument communication failed  "));
        assert!(!error.contains("Measurement is out of range"));
    }
    #[test]
    fn scopes_terminal_failure_falls_back_to_state_and_exit_code() {
        for result in [
            Value::Null,
            json!({}),
            json!({"valid":false}),
            json!({"valid":false,"reason":null}),
            json!({"valid":false,"reason":""}),
            json!({"valid":false,"reason":" \t\n "}),
            json!({"valid":false,"reason":42}),
            json!({"valid":true,"reason":"Not an invalid measurement"}),
            json!({"reason":"Missing validity"}),
            json!({"valid":"false","reason":"Malformed validity"}),
        ] {
            let event = json!({"event":"job_finished","state":"failed","ok":false,
                "exit_code":3,"error":null,"result":result});
            assert_eq!(
                terminal_result(&event, "measure", &json!({})).unwrap_err(),
                "Scopes measure ended with \"failed\" (exit code 3)"
            );
        }
    }

    #[test]
    fn scopes_single_wait_fixed_arguments_and_deadline_inputs() {
        assert_eq!(validate_single_wait_arguments(&json!({})).unwrap(), 5000);
        assert_eq!(
            validate_single_wait_arguments(&json!({
                "trigger_timeout_ms": 12000, "trigger_poll_interval_ms": 500
            }))
            .unwrap(),
            12000
        );
        for invalid in [
            json!({"trigger_timeout_ms": 0}),
            json!({"trigger_timeout_ms": -1}),
            json!({"trigger_timeout_ms": 1.5}),
            json!({"trigger_timeout_ms": "5000"}),
            json!({"trigger_poll_interval_ms": 0}),
            json!({"trigger_poll_interval_ms": 6000}),
            json!({"force_trigger_on_timeout": false}),
            json!({"other": true}),
        ] {
            assert!(
                validate_single_wait_arguments(&invalid).is_err(),
                "{invalid}"
            );
        }
    }

    #[test]
    fn scopes_single_wait_only_confirmed_trigger_timeout_succeeds() {
        let result = json!({
            "operation":"single-wait", "outcome":"timeout", "timed_out":true,
            "forced":false, "force_on_timeout":false, "capture_allowed":false,
            "error":null, "system_error":{"code":0,"is_error":false},
            "poll_count":3, "elapsed_ms":5000.0
        });
        let event = json!({
            "event":"job_finished", "state":"failed", "ok":false,
            "exit_code":1,
            "error":{"category":"execution","code":"job_failed",
                     "message":"job failed","details":{}},
            "result":result
        });
        assert_eq!(
            terminal_result(&event, "single-wait", &json!({})).unwrap(),
            event["result"]
        );
        let mut tek = event.clone();
        tek["result"]
            .as_object_mut()
            .unwrap()
            .remove("system_error");
        tek["result"]["post_command_status"] = json!({"value":0,"raw":"0"});
        assert_eq!(
            terminal_result(&tek, "single-wait", &json!({})).unwrap(),
            tek["result"]
        );
        let mut invalid = event.clone();
        for (path, replacement) in [
            ("state", json!("cancelled")),
            ("ok", json!(true)),
            ("exit_code", json!(3)),
            (
                "error",
                json!({"category":"execution","code":"job_failed","message":"failed",
                              "details":{"domain_error":{"message":"instrument error"}}}),
            ),
            ("result", json!({"outcome":"timeout"})),
        ] {
            invalid[path] = replacement;
            assert!(
                terminal_result(&invalid, "single-wait", &json!({})).is_err(),
                "{path}: {invalid}"
            );
            invalid = event.clone();
        }
        for (path, replacement) in [
            ("outcome", json!("unknown")),
            ("timed_out", json!(false)),
            ("forced", json!(true)),
            ("force_on_timeout", json!(true)),
            ("capture_allowed", json!(true)),
            ("error", json!("instrument error")),
            ("system_error", json!(null)),
            ("system_error", json!({"code":-222,"is_error":true})),
        ] {
            invalid["result"][path] = replacement;
            assert!(
                terminal_result(&invalid, "single-wait", &json!({})).is_err(),
                "{path}: {invalid}"
            );
            invalid = event.clone();
        }
        let mut conflicting = event.clone();
        conflicting["result"]["post_command_status"] = json!({"raw":"0","value":0});
        conflicting["result"]["system_error"] = json!({"code":-222,"is_error":true});
        assert!(terminal_result(&conflicting, "single-wait", &json!({})).is_err());
        conflicting["result"]["system_error"] = json!({"code":0,"is_error":false});
        conflicting["result"]["post_command_status"]["is_error"] = json!(true);
        assert!(terminal_result(&conflicting, "single-wait", &json!({})).is_err());
        assert!(terminal_result(&event, "measure", &json!({})).is_err());
        let mut natural = event;
        natural["state"] = json!("succeeded");
        natural["ok"] = json!(true);
        natural["exit_code"] = json!(0);
        natural["error"] = Value::Null;
        natural["result"]["outcome"] = json!("natural");
        natural["result"]["timed_out"] = json!(false);
        natural["result"]["capture_allowed"] = json!(true);
        assert_eq!(
            terminal_result(&natural, "single-wait", &json!({})).unwrap(),
            natural["result"]
        );
    }
    #[test]
    fn scopes_terminal_empty_or_missing_error_message_falls_back() {
        for error in [
            Value::Null,
            json!({}),
            json!({"message":""}),
            json!({"message":" \t\n "}),
            json!({"message":null}),
            json!({"message":42}),
            json!("malformed error"),
        ] {
            let mut event = json!({"event":"job_finished","state":"failed","ok":false,
                "exit_code":3,"error":error,
                "result":{"valid":false,"reason":"Worker measurement reason"}});
            assert!(
                terminal_result(&event, "measure", &json!({}))
                    .unwrap_err()
                    .ends_with(": Worker measurement reason")
            );
            event.as_object_mut().unwrap().remove("result");
            assert_eq!(
                terminal_result(&event, "measure", &json!({})).unwrap_err(),
                "Scopes measure ended with \"failed\" (exit code 3)"
            );
        }
        assert_eq!(
            terminal_result(
                &json!({"event":"job_finished","state":"failed"}),
                "measure",
                &json!({})
            )
            .unwrap_err(),
            "Scopes measure ended with \"failed\""
        );
        assert_eq!(
            terminal_result(&json!({"event":"job_finished"}), "measure", &json!({})).unwrap_err(),
            "Scopes measure ended with \"unknown\""
        );
    }
    #[test]
    fn scopes_terminal_succeeded_preserves_result() {
        let event = json!({"event":"job_finished","state":"succeeded","ok":true,
            "exit_code":0,"error":null,"result":{"valid":true,"reason":null,"channel":1,
                "item":"vpp","value":2.5,"unit":"V","future":{"retained":true}}});
        assert_eq!(
            terminal_result(&event, "measure", &json!({})).unwrap(),
            event["result"]
        );
    }
    #[test]
    fn scopes_terminal_cancelled_does_not_use_measure_reason() {
        for state in ["cancelled", "running"] {
            let mut event = json!({"event":"job_finished","state":state,"ok":false,
                "exit_code":3,"error":null,
                "result":{"valid":false,"reason":"Inapplicable measurement reason"}});
            let error = terminal_result(&event, "measure", &json!({})).unwrap_err();
            assert!(error.contains(state));
            assert!(error.contains("exit code 3"));
            assert!(!error.contains("Inapplicable measurement reason"));
            assert!(!error.contains("null"));
            event["error"] = json!({"message":"Worker stopped the job"});
            assert!(
                terminal_result(&event, "measure", &json!({}))
                    .unwrap_err()
                    .ends_with(": Worker stopped the job")
            );
        }
    }
    #[test]
    fn scopes_terminal_non_measure_failure_does_not_use_measure_reason() {
        let mut event = json!({"event":"job_finished","state":"failed","ok":false,
            "exit_code":3,"error":null,
            "result":{"valid":false,"reason":"Inapplicable measurement reason"}});
        assert_eq!(
            terminal_result(&event, "channel-scale", &json!({})).unwrap_err(),
            "Scopes channel-scale ended with \"failed\" (exit code 3)"
        );
        event["error"] = json!({"message":"Unsupported scale"});
        assert!(
            terminal_result(&event, "channel-scale", &json!({}))
                .unwrap_err()
                .ends_with(": Unsupported scale")
        );
    }
    #[test]
    fn scopes_terminal_success_conditions_and_structured_result_are_required() {
        let event = json!({"event":"job_finished","state":"succeeded","ok":true,
            "exit_code":0,"error":null,"result":{}});
        for (field, value) in [
            ("state", json!("failed")),
            ("ok", json!(false)),
            ("exit_code", json!(3)),
            ("error", json!({"message":"Worker error"})),
            ("result", Value::Null),
        ] {
            let mut invalid = event.clone();
            invalid[field] = value;
            assert!(terminal_result(&invalid, "measure", &json!({})).is_err());
            invalid.as_object_mut().unwrap().remove(field);
            if field == "error" {
                assert!(terminal_result(&invalid, "measure", &json!({})).is_ok());
            } else {
                assert!(terminal_result(&invalid, "measure", &json!({})).is_err());
            }
        }
        // Result validity remains data, not an additional success condition.
        let mut event = event;
        event["result"] = json!({"valid":false,"reason":"Worker supplied result"});
        assert_eq!(
            terminal_result(&event, "measure", &json!({})).unwrap(),
            event["result"]
        );
    }
    #[test]
    fn scopes_terminal_failure_and_missing_files_are_rejected() {
        for state in ["failed", "cancelled", "running"] {
            assert!(
                terminal_result(
                    &json!({"state":state,"ok":false,"exit_code":3,"error":{"message":"failed"}}),
                    "measure",
                    &json!({})
                )
                .is_err()
            );
        }
        assert!(
            terminal_result(
                &json!({"state":"succeeded","ok":true,"exit_code":0,"result":{},"files":[]}),
                "capture",
                &json!({"csv":"missing.csv","meta":"missing.json"})
            )
            .is_err()
        );
    }
    #[test]
    fn scopes_file_arguments_are_absolute_unique_and_local() {
        let folder = std::env::temp_dir().join(format!(
            "scopes-output-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut a = json!({"channel":[1],"points":1000});
        prepare_file_arguments("capture", &mut a, Some(&folder)).unwrap();
        fs::write(a["csv"].as_str().unwrap(), "existing").unwrap();
        let mut b = json!({});
        prepare_file_arguments("capture", &mut b, Some(&folder)).unwrap();
        assert_ne!(a["csv"], b["csv"]);
        assert_eq!(
            fs::read_to_string(a["csv"].as_str().unwrap()).unwrap(),
            "existing"
        );
        assert!(Path::new(a["csv"].as_str().unwrap()).is_absolute());
        for (arguments, extension) in [
            (json!({"format":"png"}), "png"),
            (json!({"format":"bmp"}), "bmp"),
            (json!({"format":"bmp8bit"}), "bmp"),
            (json!({"format":"jpeg"}), "jpeg"),
            (json!({}), "png"),
        ] {
            let mut prepared = arguments.clone();
            prepare_file_arguments("screenshot", &mut prepared, Some(&folder)).unwrap();
            assert_eq!(
                Path::new(prepared["output"].as_str().unwrap())
                    .extension()
                    .unwrap(),
                extension
            );
            assert_eq!(prepared.get("format"), arguments.get("format"));
        }
        assert!(
            prepare_file_arguments("screenshot", &mut json!({"format":"gif"}), Some(&folder))
                .unwrap_err()
                .contains("unsupported screenshot format")
        );
        assert!(
            prepare_file_arguments(
                "screenshot",
                &mut json!({"query_hardcopy":true}),
                Some(&folder)
            )
            .is_err()
        );
        fs::remove_dir_all(folder).unwrap();
        let default = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .join("data");
        let existed = default.exists();
        let mut screenshot = json!({"format":"png"});
        prepare_file_arguments("screenshot", &mut screenshot, None).unwrap();
        assert_eq!(
            Path::new(screenshot["output"].as_str().unwrap())
                .parent()
                .unwrap(),
            default
        );
        if !existed {
            fs::remove_dir(default).unwrap();
        }
    }
}
