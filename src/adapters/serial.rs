//! Serial Background RX and ordinary Foreground adapter. The serial-tool owns the COM session.
use crate::{run::ExecutionMode, serial_setup::SerialSetup, worker::WorkerLaunchSpec};
use serde_json::Value;
use std::{ffi::OsString, path::Path};

pub fn background_worker_launch_spec(
    executable: &Path,
    mode: ExecutionMode,
    port: Option<&str>,
    setup: &SerialSetup,
) -> Result<WorkerLaunchSpec, String> {
    setup.validate()?;
    let mut args: Vec<OsString> = vec!["worker".into(), "--mode".into()];
    args.push(
        match mode {
            ExecutionMode::Simulate => "simulate",
            ExecutionMode::Live => "live",
        }
        .into(),
    );
    if mode == ExecutionMode::Live {
        let port = port
            .filter(|p| !p.trim().is_empty())
            .ok_or("Serial Live COM Port is required")?;
        args.extend(["--port".into(), port.into()]);
    } else {
        args.extend(["--simulation-profile-id".into(), "loopback-v1".into()]);
    }
    for (flag, value) in [
        ("--baud", setup.baud.to_string()),
        ("--data-bits", setup.data_bits.to_string()),
        ("--parity", setup.parity.clone()),
        ("--stop-bits", setup.stop_bits.to_string()),
        ("--flow-control", setup.flow_control.clone()),
        ("--timeout-ms", setup.timeout_ms.to_string()),
    ] {
        args.extend([flag.into(), value.into()]);
    }
    args.extend(["--control-port".into(), "0".into(), "--streaming".into()]);
    Ok(WorkerLaunchSpec::new(executable, args))
}

pub fn validate_rx(event: &Value) -> Result<usize, String> {
    if event["event"] != "rx" || event["schema_version"] != 3 {
        return Err("Invalid Serial RX event schema".into());
    }
    let hex = event["rx_hex"].as_str().ok_or("Serial RX hex is missing")?;
    if !hex.len().is_multiple_of(2) || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Invalid Serial RX hex".into());
    }
    let size = hex.len() / 2;
    if event["rx_bytes"].as_u64() != Some(size as u64) {
        return Err("Serial RX byte count mismatch".into());
    }
    let timestamp = event["timestamp_utc"]
        .as_str()
        .ok_or("Serial RX timestamp is missing")?;
    chrono::DateTime::parse_from_rfc3339(timestamp)
        .map_err(|_| "Invalid Serial RX timestamp".to_owned())?;
    Ok(size)
}

pub fn validate_stop_summary(summary: &Value, exit_success: bool) -> Result<(), String> {
    if !exit_success
        || summary["event"] != "summary"
        || summary["ok"] != true
        || summary["exit_code"] != 0
        || !summary["fatal_error"].is_null()
    {
        return Err("Serial Background Worker failed during shutdown".into());
    }
    Ok(())
}

/** Ordinary multi-job Serial worker, sharing the Background startup settings without RX streaming. */
pub fn foreground_worker_launch_spec(
    executable: &Path,
    mode: ExecutionMode,
    port: Option<&str>,
    setup: &SerialSetup,
) -> Result<WorkerLaunchSpec, String> {
    setup.validate()?;
    let mut args = background_worker_launch_spec(executable, mode, port, setup)?
        .arguments()
        .to_vec();
    if args
        .last()
        .is_some_and(|last| last.to_string_lossy() == "--streaming")
    {
        args.pop();
    }
    Ok(WorkerLaunchSpec::new(executable, args))
}

fn hex_byte(value: &Value) -> Result<String, String> {
    let number = value
        .as_number()
        .ok_or("Hex Byte requires a non-negative integer number")?;
    let low_byte = if let Some(integer) = number.as_u64() {
        (integer & 0xff) as u8
    } else if let Some(real) = number.as_f64() {
        if !real.is_finite() || real < 0.0 || real.fract() != 0.0 || real > 9_007_199_254_740_991.0
        {
            return Err("Hex Byte requires an exact non-negative integer".into());
        }
        (real as u64 & 0xff) as u8
    } else {
        return Err("Hex Byte requires a non-negative integer".into());
    };
    Ok(format!("{low_byte:02x}"))
}

fn encode_tx(format: &str, value: &Value) -> Result<String, String> {
    match format {
        "hex-byte" => hex_byte(value),
        "text" => {
            let text = value.as_str().ok_or("Text TX requires a string")?;
            if text.is_empty() {
                return Err("Serial TX cannot be empty".into());
            }
            Ok(text
                .as_bytes()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect())
        }
        _ => Err("TX mode must be text or hex-byte".into()),
    }
}

fn delimiter_bytes(format: &str, text: &str) -> Result<Vec<u8>, String> {
    match format {
        "text" => {
            let mut decoded = String::new();
            let mut chars = text.chars();
            while let Some(c) = chars.next() {
                if c == '\\' {
                    match chars.next() {
                        Some('r') => decoded.push('\r'),
                        Some('n') => decoded.push('\n'),
                        Some('\\') => decoded.push('\\'),
                        _ => {
                            return Err("Delimiter supports only \\r, \\n, and \\\\ escapes".into());
                        }
                    }
                } else {
                    decoded.push(c);
                }
            }
            Ok(decoded.into_bytes())
        }
        "hex" => {
            let digits: String = text.chars().filter(|c| !c.is_ascii_whitespace()).collect();
            if !digits.len().is_multiple_of(2) || !digits.bytes().all(|c| c.is_ascii_hexdigit()) {
                return Err("Delimiter must contain pairs of hexadecimal digits".into());
            }
            digits
                .as_bytes()
                .as_chunks::<2>()
                .0
                .iter()
                .map(|pair| {
                    u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16)
                        .map_err(|_| "Invalid Hex delimiter".to_owned())
                })
                .collect()
        }
        _ => Err("Delimiter mode must be text or hex".into()),
    }
}

/// Checks Serial-specific Template arguments before runtime bindings are resolved.
/// File availability is deliberately checked separately from Template validity.
pub fn validate_action(
    action: &str,
    arguments: &Value,
    bindings: &std::collections::BTreeMap<String, crate::workflow::InputValue>,
) -> Result<(), String> {
    let obj = arguments
        .as_object()
        .ok_or("Serial action arguments must be an object")?;
    let keys: &[&str] = match action {
        "send" => &["tx_format", "tx_value"],
        "send-file" => &["path"],
        "receive" => &["max_bytes"],
        "query" => &[
            "tx_format",
            "tx_value",
            "delimiter_format",
            "delimiter_value",
            "max_bytes",
        ],
        _ => return Err(format!("Unsupported Serial Foreground action {action}")),
    };
    for key in obj.keys() {
        if !keys.contains(&key.as_str()) {
            return Err(format!("Unsupported Serial argument {key}"));
        }
    }
    for key in bindings.keys() {
        if key != "tx_value" || !matches!(action, "send" | "query") {
            return Err(format!("Unsupported Serial binding {key}"));
        }
    }
    if matches!(action, "send" | "query") {
        let format = obj
            .get("tx_format")
            .and_then(Value::as_str)
            .ok_or("Missing Serial TX mode")?;
        if !matches!(format, "text" | "hex-byte") {
            return Err("Invalid Serial TX mode".into());
        }
        if let Some(input) = bindings.get("tx_value") {
            if let crate::workflow::InputValue::Literal(value) = input {
                encode_tx(format, value)?;
            }
        } else {
            let value = obj.get("tx_value").ok_or("Missing Serial TX value")?;
            encode_tx(format, value)?;
        }
    }
    if action == "send-file" {
        let path = obj
            .get("path")
            .and_then(Value::as_str)
            .ok_or("Missing Send File path")?;
        let _ = path; // Path is validated by the separate non-destructive file preflight.
    }
    let max = obj
        .get("max_bytes")
        .map(|v| v.as_u64())
        .unwrap_or(Some(1024))
        .ok_or("max_bytes must be an integer")?;
    if !(1..=1_048_576).contains(&max) {
        return Err("max_bytes must be 1..=1048576".into());
    }
    if action == "query" {
        let mode = obj
            .get("delimiter_format")
            .and_then(Value::as_str)
            .ok_or("Missing delimiter mode")?;
        let text = obj
            .get("delimiter_value")
            .and_then(Value::as_str)
            .ok_or("Missing delimiter value")?;
        let bytes = delimiter_bytes(mode, text)?;
        if bytes.is_empty() || bytes.len() > max as usize {
            return Err("Delimiter must contain 1..=max_bytes bytes".into());
        }
    }
    Ok(())
}

/// Returns file errors without changing Template contents. Includes nested loop bodies.
pub fn send_file_path_errors(template: &crate::template::Template) -> Vec<String> {
    fn check(
        steps: &[crate::workflow::Step],
        instances: &[crate::tool_instance::ToolInstance],
        errors: &mut Vec<String>,
    ) {
        for step in steps {
            match step.kind() {
                crate::workflow::StepKind::For { body, .. }
                | crate::workflow::StepKind::While { body, .. } => check(body, instances, errors),
                crate::workflow::StepKind::ToolAction {
                    target,
                    action,
                    arguments,
                    ..
                } if action.as_str() == "send-file"
                    && instances
                        .iter()
                        .any(|i| &i.id == target && i.tool == crate::tool::ToolId::serial()) =>
                {
                    let value = arguments.get("path").and_then(Value::as_str).unwrap_or("");
                    let path = Path::new(value);
                    let reason = if !path.is_absolute() || value.starts_with("\\\\") {
                        Some("path must be an absolute local file".to_owned())
                    } else {
                        match std::fs::metadata(path) {
                            Ok(meta) if !meta.is_file() || meta.len() == 0 => {
                                Some("file must exist, be regular and nonempty".to_owned())
                            }
                            Ok(_) => std::fs::File::open(path).err().map(|e| e.to_string()),
                            Err(e) => Some(e.to_string()),
                        }
                    };
                    if let Some(reason) = reason {
                        errors.push(format!("Step {}: {value}: {reason}", step.id()));
                    }
                }
                _ => {}
            }
        }
    }
    let mut errors = Vec::new();
    check(
        template.workflow().steps(),
        template.tool_instances(),
        &mut errors,
    );
    errors
}

/// No custom Job Tracker or request context: Serial settings are bound at Worker startup.
pub fn run_action(
    session: &crate::worker::WorkerSession,
    action: &crate::workflow::ActionId,
    arguments: &Value,
    timeout: std::time::Duration,
) -> Result<Value, String> {
    validate_action(action.as_str(), arguments, &Default::default())?;
    let mut worker_args = serde_json::Map::new();
    match action.as_str() {
        "send" | "query" => {
            let mode = arguments["tx_format"].as_str().ok_or("Missing TX mode")?;
            worker_args.insert(
                "tx_hex".into(),
                Value::String(encode_tx(mode, &arguments["tx_value"])?),
            );
        }
        "send-file" => {
            worker_args.insert("path".into(), arguments["path"].clone());
        }
        "receive" => {}
        _ => return Err("Unsupported Serial Foreground command".into()),
    }
    if action.as_str() == "query" {
        let bytes = delimiter_bytes(
            arguments["delimiter_format"]
                .as_str()
                .ok_or("Missing delimiter mode")?,
            arguments["delimiter_value"]
                .as_str()
                .ok_or("Missing delimiter value")?,
        )?;
        worker_args.insert(
            "delimiter_hex".into(),
            Value::String(bytes.iter().map(|byte| format!("{byte:02x}")).collect()),
        );
    }
    if matches!(action.as_str(), "receive" | "query")
        && let Some(value) = arguments.get("max_bytes")
    {
        worker_args.insert("max_bytes".into(), value.clone());
    }
    static NEXT_JOB: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let id = format!(
        "orchestrator-serial-{}-{}",
        std::process::id(),
        NEXT_JOB.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let terminal = session.run_async_job(
        action.as_str(),
        &Value::Object(worker_args),
        None,
        &id,
        timeout,
    )?;
    if terminal["state"] == "succeeded"
        && terminal["ok"] == true
        && terminal["error"].is_null()
        && terminal["result"].is_object()
    {
        Ok(terminal["result"].clone())
    } else {
        Err(format!(
            "Serial {} failed: {}",
            action,
            terminal["error"]["message"]
                .as_str()
                .unwrap_or("unconfirmed Job failure")
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn foreground_launch_is_ordinary_worker() {
        let setup = SerialSetup::default();
        let spec = foreground_worker_launch_spec(
            std::path::Path::new("serial-tool"),
            ExecutionMode::Simulate,
            None,
            &setup,
        )
        .unwrap();
        let args = spec.arguments();
        assert!(!args.iter().any(|arg| arg == "--streaming"));
        assert!(
            args.windows(2)
                .any(|pair| pair[0] == "--simulation-profile-id" && pair[1] == "loopback-v1")
        );
    }

    #[test]
    fn foreground_byte_encoding_and_types() {
        for (input, expected) in [
            (json!(0), "00"),
            (json!(255), "ff"),
            (json!(256), "00"),
            (json!(257), "01"),
            (json!(4660), "34"),
            (json!(3.0), "03"),
        ] {
            assert_eq!(encode_tx("hex-byte", &input).unwrap(), expected);
        }
        for value in [json!(-10), json!(1.5), json!("123"), json!(true)] {
            assert!(encode_tx("hex-byte", &value).is_err());
        }
        assert_eq!(encode_tx("text", &json!("HELLO")).unwrap(), "48454c4c4f");
        assert_eq!(encode_tx("text", &json!("你好")).unwrap(), "e4bda0e5a5bd");
        assert!(encode_tx("text", &json!(123)).is_err());
    }

    #[test]
    fn query_delimiter_is_independent_of_hex_byte() {
        assert_eq!(delimiter_bytes("text", r"\r\n").unwrap(), vec![13, 10]);
        assert_eq!(delimiter_bytes("hex", "0D 0A").unwrap(), vec![13, 10]);
        assert!(delimiter_bytes("hex", "0D 0").is_err());
        assert!(validate_action("run-sequence", &json!({}), &Default::default()).is_err());
        assert!(
            validate_action(
                "query",
                &json!({
                    "tx_format": "hex-byte", "tx_value": 257,
                    "delimiter_format": "hex", "delimiter_value": "0D 0A",
                    "max_bytes": 1,
                }),
                &Default::default()
            )
            .is_err()
        );
    }

    #[test]
    fn send_file_preflight_checks_nested_steps_without_rewriting_template() {
        let path = std::env::temp_dir().join(format!(
            "orchestrator-serial-preflight-{}",
            std::process::id()
        ));
        let source = serde_json::json!({
            "schema_version": 2, "name": "Serial File",
            "tool_instances": [{ "id": "serial-1", "tool": "serial",
                "setup": {"baud": 115200} }],
            "workflow": {"steps": [
                {"type": "for", "id": "loop", "variable": "n",
                 "range": {"start": "1", "stop": "1", "step": "1"},
                 "steps": [{"type": "tool-action", "id": "send-file",
                     "target": "serial-1", "action": "send-file",
                     "arguments": {"path": path.to_string_lossy()}}]}
            ]}
        });
        let template = crate::template::Template::from_json_str(&source.to_string()).unwrap();
        assert_eq!(send_file_path_errors(&template).len(), 1);
        let error = crate::run::run_workflow(
            &template,
            ExecutionMode::Simulate,
            &Default::default(),
            std::time::Duration::from_millis(10),
            std::time::Duration::from_millis(10),
            std::time::Duration::from_millis(10),
        )
        .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("Serial Send File preflight failed")
        );
        std::fs::write(&path, [0x01, 0x02]).unwrap();
        assert!(send_file_path_errors(&template).is_empty());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn background_startup_matches_serial_worker_contract() {
        let setup = SerialSetup::default();
        let executable = std::path::Path::new("serial-tool.exe");
        let sim = background_worker_launch_spec(executable, ExecutionMode::Simulate, None, &setup)
            .unwrap();
        let live =
            background_worker_launch_spec(executable, ExecutionMode::Live, Some("COM4"), &setup)
                .unwrap();
        let as_args = |spec: &WorkerLaunchSpec| {
            spec.arguments()
                .iter()
                .map(|part| part.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        };
        let sim = as_args(&sim);
        let live = as_args(&live);
        assert!(
            sim.windows(2)
                .any(|p| p[0] == "--simulation-profile-id" && p[1] == "loopback-v1")
        );
        assert!(!sim.iter().any(|p| p == "--port"));
        assert!(live.windows(2).any(|p| p[0] == "--port" && p[1] == "COM4"));
        assert!(!live.iter().any(|p| p == "--simulation-profile-id"));
        assert!(sim.contains(&"--streaming".to_owned()));
        assert!(live.contains(&"--streaming".to_owned()));
        assert!(
            background_worker_launch_spec(executable, ExecutionMode::Live, None, &setup).is_err()
        );
    }

    #[test]
    fn validate_serial_rx_bytes_not_sample_numbers() {
        assert_eq!(
            validate_rx(&json!({"event":"rx","schema_version":3,
            "timestamp_utc":"2026-11-02T10:00:00Z","rx_hex":"00ff0d0a","rx_bytes":4})),
            Ok(4)
        );
        assert!(
            validate_rx(&json!({"event":"rx","schema_version":3,
            "timestamp_utc":"2026-11-02T10:00:00Z","rx_hex":"0","rx_bytes":1}))
            .is_err()
        );
        assert!(
            validate_rx(&json!({"event":"rx","schema_version":3,
            "timestamp_utc":"2026-11-02T10:00:00Z","rx_hex":"aabbcc","rx_bytes":2}))
            .is_err()
        );
    }
}
