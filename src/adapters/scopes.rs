//! Scopes Common Worker v2 adapter; instrument policy stays in scopes-tool.

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
        ],
    )
}

pub fn validate_session(
    session: &WorkerSession,
    mode: ExecutionMode,
    spec: &WorkerLaunchSpec,
    timeout: Duration,
) -> Result<(), String> {
    let status = crate::worker_http::WorkerClient::new(session.ready())
        .status_with_timeout(timeout)
        .map_err(|e| e.to_string())?;
    validate_status(&status, session)?;
    let argument = |flag: &str| {
        spec.arguments()
            .windows(2)
            .find(|pair| pair[0] == flag)
            .and_then(|pair| pair[1].to_str())
    };
    let model = match mode {
        ExecutionMode::Simulate => argument("--model").unwrap_or("keysight-dsox4024a"),
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
    Ok(())
}

fn validate_status(status: &Value, session: &WorkerSession) -> Result<(), String> {
    if status["schema_version"].as_u64() != Some(2)
        || status["service"] != "scopes-tool"
        || status["run_id"] != session.ready().run_id()
    {
        return Err("invalid Scopes Worker status identity".into());
    }
    if status.get("fatal_error").is_some_and(|e| !e.is_null()) || status["status"] == "error" {
        return Err(format!(
            "Scopes Worker fatal error: {}",
            status["fatal_error"]
        ));
    }
    Ok(())
}

static NEXT_JOB: AtomicU64 = AtomicU64::new(0);
fn run_command(
    session: &WorkerSession,
    command: &str,
    arguments: &Value,
    timeout: Duration,
) -> Result<Value, String> {
    let deadline = Instant::now() + timeout;
    let remaining = || {
        deadline
            .checked_duration_since(Instant::now())
            .filter(|d| !d.is_zero())
            .ok_or_else(|| format!("Scopes {command} timed out after {timeout:?}"))
    };
    let job_id = format!(
        "orchestrator-scopes-{}-{}",
        std::process::id(),
        NEXT_JOB.fetch_add(1, Ordering::Relaxed)
    );
    let request =
        json!({"schema_version":2,"command":command,"arguments":arguments,"job_id":job_id});
    let (http, accepted) = crate::worker_http::WorkerClient::new(session.ready())
        .command_with_rejection_timeout(&request, remaining()?)
        .map_err(|e| e.to_string())?;
    if http != 202
        || accepted["schema_version"].as_u64() != Some(2)
        || accepted["status"] != "accepted"
        || accepted["command"] != command
        || accepted["job_id"] != job_id
    {
        return Err(format!(
            "Scopes {command} admission failed (HTTP {http}): {accepted}"
        ));
    }
    let worker_job_id = accepted["worker_job_id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or("Scopes acceptance has no worker_job_id")?;
    loop {
        let event = session
            .recv_event(remaining()?)
            .map_err(|e| format!("Scopes {command}: {e}"))?;
        if event["schema_version"].as_u64() != Some(2)
            || event["run_id"] != session.ready().run_id()
        {
            return Err("invalid Scopes event identity".into());
        }
        if event["event"] == "summary" {
            return Err(format!(
                "Scopes Worker exited before {command} finished: {event}"
            ));
        }
        if event["event"] != "job_finished" {
            continue;
        }
        if event["worker_job_id"] != worker_job_id
            || event["job_id"] != job_id
            || event["command"] != command
        {
            return Err("Scopes job_finished correlation mismatch".into());
        }
        return terminal_result(&event, command, arguments);
    }
}

fn terminal_result(event: &Value, command: &str, arguments: &Value) -> Result<Value, String> {
    if event["state"] != "succeeded"
        || event["ok"] != true
        || event["exit_code"].as_i64() != Some(0)
        || !event["error"].is_null()
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
        run_command(session, &command, &arguments, timeout).map_err(|e| {
            format!(
                "{command}, channel {}: {e}",
                arguments
                    .get("channel")
                    .map(Value::to_string)
                    .unwrap_or_else(|| "acquisition".into())
            )
        })?;
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
    "measure",
    "capture",
    "screenshot",
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
    // Screenshot transport alone may take ten seconds, before artifact writing.
    let timeout = if matches!(command, "capture" | "screenshot") {
        timeout.max(Duration::from_secs(30))
    } else {
        timeout
    };
    run_command(session, command, &arguments, timeout)
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
            .unwrap_or("png")
        {
            "png" => "png",
            "bmp" | "bmp8bit" => "bmp",
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
    fn scopes_capabilities_preserves_unknown_information_and_checks_model() {
        let value = json!({"schema_version":2,"event":"capabilities","model":{"model_id":"test","display_name":"Test"},"capabilities":{"analog_channels":2,"acquisition_modes":["normal","average"],"average_counts":[4,16],"screenshot_formats":["bmp"],"measurement_items":["pair-only"],"direct_measurement_items":["vpp","frequency"],"trigger_edge_slopes":["positive","negative"],"capture_point_options":[1000,5000],"future":true}});
        let caps = parse_capabilities(value.to_string().as_bytes(), Some("test")).unwrap();
        assert_eq!(caps.average_counts, Some(vec![4, 16]));
        assert_eq!(caps.measurement_items, Some(vec!["pair-only".into()]));
        assert_eq!(caps.direct_measurement_items, vec!["vpp", "frequency"]);
        assert_eq!(caps.trigger_edge_slopes, vec!["positive", "negative"]);
        assert_eq!(caps.capture_point_options, vec![1000, 5000]);
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
