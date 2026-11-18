//! Serial streaming RX/TX and ordinary Foreground adapter. Serial Tool owns the transport session.
use crate::{
    run::ExecutionMode,
    serial_setup::{SerialSetup, SerialTransport, parse_tcp_endpoint},
    worker::WorkerLaunchSpec,
};
use serde_json::Value;
use std::{ffi::OsString, path::Path};

pub fn background_worker_launch_spec(
    executable: &Path,
    mode: ExecutionMode,
    port: Option<&str>,
    setup: &SerialSetup,
) -> Result<WorkerLaunchSpec, String> {
    serial_worker_launch_spec(executable, mode, port, setup, true)
}

fn serial_worker_launch_spec(
    executable: &Path,
    mode: ExecutionMode,
    port: Option<&str>,
    setup: &SerialSetup,
    streaming: bool,
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
    if setup.transport == SerialTransport::Tcp {
        args.extend(["--transport".into(), "tcp".into()]);
    }
    if mode == ExecutionMode::Live {
        let resource = port
            .filter(|p| !p.trim().is_empty())
            .ok_or("Serial Live Resource is required")?;
        match setup.transport {
            SerialTransport::Serial => {
                if parse_tcp_endpoint(resource).is_ok() {
                    return Err("Serial UART requires a COM Port, not a TCP endpoint".into());
                }
                args.extend(["--port".into(), resource.into()]);
            }
            SerialTransport::Tcp => {
                let (host, port) = parse_tcp_endpoint(resource)?;
                args.extend([
                    "--host".into(),
                    host.into(),
                    "--tcp-port".into(),
                    port.to_string().into(),
                ]);
            }
        }
    } else {
        let profile = if streaming {
            "periodic-rx-v1"
        } else {
            "loopback-v1"
        };
        args.extend(["--simulation-profile-id".into(), profile.into()]);
    }
    match setup.transport {
        SerialTransport::Serial => {
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
        }
        SerialTransport::Tcp => {
            args.extend([
                "--connect-timeout-ms".into(),
                setup.connect_timeout_ms.to_string().into(),
                "--io-timeout-ms".into(),
                setup.io_timeout_ms.to_string().into(),
            ]);
        }
    }
    args.extend(["--control-port".into(), "0".into()]);
    if streaming {
        args.push("--streaming".into());
    }
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
    serial_worker_launch_spec(executable, mode, port, setup, false)
}

fn hex_byte(value: &Value) -> Result<String, String> {
    const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
    let number = value
        .as_number()
        .ok_or("Hex Byte requires a non-negative integer number")?;
    let low_byte = if let Some(integer) = number.as_u64() {
        if integer > MAX_SAFE_INTEGER {
            return Err("Hex Byte requires an exact non-negative integer".into());
        }
        (integer & 0xff) as u8
    } else if let Some(real) = number.as_f64() {
        if !real.is_finite() || real < 0.0 || real.fract() != 0.0 || real > MAX_SAFE_INTEGER as f64
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
        "receive" => &[
            "max_bytes",
            "fail_on_read_timeout",
            "receive_mode",
            "delimiter_format",
            "delimiter_value",
            "expected_bytes",
            "idle_gap_ms",
            "enable_rx_text",
        ],
        "query" => &[
            "tx_format",
            "tx_value",
            "delimiter_format",
            "delimiter_value",
            "max_bytes",
            "fail_on_read_timeout",
            "receive_mode",
            "expected_bytes",
            "idle_gap_ms",
            "enable_rx_text",
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
    for key in ["fail_on_read_timeout", "enable_rx_text"] {
        if obj.get(key).is_some_and(|value| !value.is_boolean()) {
            return Err(format!("{key} must be a Boolean"));
        }
    }
    let rx_mode = if matches!(action, "receive" | "query") {
        let default = if action == "receive" { "single" } else { "delimiter" };
        let mode = match obj.get("receive_mode") {
            None => default,
            Some(value) => value
                .as_str()
                .ok_or("receive_mode must be a String")?,
        };
        if !matches!(mode, "single" | "delimiter" | "fixed" | "idle")
            || (action == "query" && mode == "single")
        {
            return Err("Unsupported Serial receive mode".into());
        }
        mode
    } else {
        ""
    };
    if matches!(action, "send" | "query") {
        let format = obj
            .get("tx_format")
            .and_then(Value::as_str)
            .ok_or("Missing Serial TX mode")?;
        if !matches!(format, "text" | "hex-byte") {
            return Err("Invalid Serial TX mode".into());
        }
        if let Some(input) = bindings.get("tx_value") {
            use crate::workflow::{ExpressionOperand, InputValue};
            match input {
                InputValue::Literal(value) => {
                    encode_tx(format, value)?;
                }
                InputValue::Expression(expression) if format == "hex-byte" => {
                    if expression.operator().is_comparison() {
                        return Err("Hex Byte Calculation must use a numeric operator".into());
                    }
                    for operand in
                        std::iter::once(expression.left()).chain(expression.right_operand())
                    {
                        if let ExpressionOperand::Literal(value) = operand
                            && !value.is_number()
                        {
                            return Err(
                                "Hex Byte Calculation literal operands must be numeric".into()
                            );
                        }
                    }
                }
                InputValue::Timestamp if format == "hex-byte" => {
                    return Err("Hex Byte requires a numeric source".into());
                }
                _ => {}
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
    if matches!(action, "receive" | "query") {
        if rx_mode == "fixed" {
            let expected = obj
                .get("expected_bytes")
                .and_then(Value::as_u64)
                .ok_or("Expected RX Bytes is required and must be a positive integer")?;
            if !(1..=1_048_576).contains(&expected) {
                return Err("Expected RX Bytes must be 1..=1048576".into());
            }
        } else {
            let max = obj
                .get("max_bytes")
                .map(Value::as_u64)
                .unwrap_or(Some(1024))
                .ok_or("max_bytes must be an integer")?;
            if !(1..=1_048_576).contains(&max) {
                return Err("max_bytes must be 1..=1048576".into());
            }
            if rx_mode == "delimiter" {
                let format = obj
                    .get("delimiter_format")
                    .and_then(Value::as_str)
                    .ok_or("Missing delimiter mode")?;
                let value = obj
                    .get("delimiter_value")
                    .and_then(Value::as_str)
                    .ok_or("Missing delimiter value")?;
                let bytes = delimiter_bytes(format, value)?;
                if bytes.is_empty() || bytes.len() > max as usize {
                    return Err("Delimiter must contain 1..=max_bytes bytes".into());
                }
            }
            if rx_mode == "idle" {
                let gap = obj
                    .get("idle_gap_ms")
                    .and_then(Value::as_u64)
                    .filter(|gap| *gap > 0 && *gap <= u32::MAX as u64)
                    .ok_or("Idle Gap (ms) is required and must be a positive integer")?;
                let _ = gap;
            }
        }
    }
    Ok(())
}

/// Returns file errors without changing Template contents. Includes nested loop bodies.
pub fn send_file_path_errors(template: &crate::template::Template) -> Vec<String> {
    fn check_path(step: &crate::workflow::Step, arguments: &Value, errors: &mut Vec<String>) {
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
    fn check(
        steps: &[crate::workflow::Step],
        instances: &[crate::tool_instance::ToolInstance],
        errors: &mut Vec<String>,
    ) {
        for step in steps {
            match step.kind() {
                crate::workflow::StepKind::For { body, .. }
                | crate::workflow::StepKind::While { body, .. } => check(body, instances, errors),
                crate::workflow::StepKind::If {
                    then_steps,
                    else_steps,
                    ..
                } => {
                    check(then_steps, instances, errors);
                    check(else_steps, instances, errors);
                }
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
                    check_path(step, arguments, errors);
                }
                crate::workflow::StepKind::Interaction {
                    operation:
                        crate::interaction::InteractionOperation::Command {
                            command: crate::interaction::BackgroundCommand::SerialSendFile,
                            arguments: Some(arguments),
                            ..
                        },
                    ..
                } => check_path(step, arguments, errors),
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

/// Shared FG/BG validation and native argument encoding, before any TX.
pub(crate) fn worker_arguments(action: &str, arguments: &Value) -> Result<Value, String> {
    validate_action(action, arguments, &Default::default())?;
    let mut worker_args = serde_json::Map::new();
    match action {
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
    if matches!(action, "receive" | "query") {
        let mode = arguments
            .get("receive_mode")
            .and_then(Value::as_str)
            .unwrap_or(if action == "receive" { "single" } else { "delimiter" });
        if arguments.get("receive_mode").is_some() {
            worker_args.insert("receive_mode".into(), Value::String(mode.into()));
        }
        match mode {
            "delimiter" => {
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
            "fixed" => {
                worker_args.insert("expected_bytes".into(), arguments["expected_bytes"].clone());
            }
            "idle" => {
                worker_args.insert("idle_gap_ms".into(), arguments["idle_gap_ms"].clone());
            }
            "single" => {}
            _ => return Err("Unsupported Serial receive mode".into()),
        }
        if mode != "fixed"
            && let Some(value) = arguments.get("max_bytes")
        {
            worker_args.insert("max_bytes".into(), value.clone());
        }
    }
    Ok(Value::Object(worker_args))
}

/// Serial settings are bound at Worker startup.
pub fn run_action(
    session: &crate::worker::WorkerSession,
    action: &crate::workflow::ActionId,
    arguments: &Value,
    timeout: std::time::Duration,
) -> Result<Value, String> {
    let worker_args = worker_arguments(action.as_str(), arguments)?;
    static NEXT_JOB: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let id = format!(
        "orchestrator-serial-{}-{}",
        std::process::id(),
        NEXT_JOB.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let terminal = session.run_async_job(action.as_str(), &worker_args, None, &id, timeout)?;
    workflow_result(action.as_str(), arguments, &terminal)
}

fn decode_rx_text(hex: &str) -> Result<Value, String> {
    if !hex.len().is_multiple_of(2) || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Invalid Serial RX hex for UTF-8 decoding".into());
    }
    let bytes: Vec<u8> = hex
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16)
                .expect("validated hex pair")
        })
        .collect();
    Ok(String::from_utf8(bytes).map(Value::String).unwrap_or(Value::Null))
}

/// Only confirmed ordinary read timeouts can become successful Workflow Steps.
/// The Serial Worker still reports the native job as failed.
fn workflow_result(action: &str, arguments: &Value, terminal: &Value) -> Result<Value, String> {
    let read_action = matches!(action, "receive" | "query");
    if terminal["state"] == "succeeded"
        && terminal["ok"] == true
        && terminal["error"].is_null()
        && terminal["result"].is_object()
    {
        let mut result = terminal["result"].clone();
        if read_action {
            result["outcome"] = Value::String("completed".into());
            result["timed_out"] = Value::Bool(false);
            if arguments["enable_rx_text"] == true {
                let rx_text = decode_rx_text(
                    result["rx_hex"].as_str().ok_or("Serial RX hex is missing")?
                )?;
                result["rx_text"] = rx_text;
            }
        }
        return Ok(result);
    }

    let error = &terminal["error"];
    if read_action
        && arguments
            .get("fail_on_read_timeout")
            .and_then(Value::as_bool)
            != Some(true)
        && terminal["state"] == "failed"
        && terminal["ok"] == false
        && terminal["result"].is_null()
        && error["category"] == "execution"
        && matches!(error["code"].as_str(), Some("serial_error" | "tcp_error"))
        && error["details"]["reason"] == "read_timeout"
    {
        let hex = terminal["partial_hex"]
            .as_str()
            .ok_or("Serial Read Timeout missing partial_hex")?;
        let bytes = terminal["partial_bytes"]
            .as_u64()
            .ok_or("Serial Read Timeout missing partial_bytes")?;
        if !hex.len().is_multiple_of(2)
            || !hex.bytes().all(|byte| byte.is_ascii_hexdigit())
            || (hex.len() / 2) as u64 != bytes
        {
            return Err("Serial Read Timeout partial RX length or hex is invalid".into());
        }
        let mut result = serde_json::json!({
            "outcome": "timeout",
            "timed_out": true,
            "partial_rx_hex": hex,
            "partial_rx_bytes": bytes,
        });
        if arguments["enable_rx_text"] == true {
            result["partial_rx_text"] = decode_rx_text(hex)?;
        }
        return Ok(result);
    }
    Err(format!(
        "Serial {} failed: {}",
        action,
        error["message"]
            .as_str()
            .unwrap_or("unconfirmed Job failure")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn timeout_terminal(hex: &str, bytes: u64) -> Value {
        json!({
            "state": "failed",
            "ok": false,
            "result": null,
            "error": {
                "category": "execution",
                "code": "serial_error",
                "message": "read timed out",
                "details": {"reason": "read_timeout"},
            },
            "partial_hex": hex,
            "partial_bytes": bytes,
        })
    }

    #[test]
    fn timeout_result_converts_only_confirmed_serial_read_timeout() {
        let terminal = timeout_terminal("524541", 3);
        assert_eq!(
            workflow_result("query", &json!({}), &terminal).unwrap(),
            json!({
                "outcome": "timeout",
                "timed_out": true,
                "partial_rx_hex": "524541",
                "partial_rx_bytes": 3,
            })
        );
        assert!(
            workflow_result("query", &json!({"fail_on_read_timeout": true}), &terminal).is_err()
        );
        let mut empty = timeout_terminal("", 0);
        empty["error"]["code"] = json!("tcp_error");
        assert_eq!(
            workflow_result("receive", &json!({}), &empty).unwrap(),
            json!({
                "outcome": "timeout",
                "timed_out": true,
                "partial_rx_hex": "",
                "partial_rx_bytes": 0,
            })
        );

        let mut wrong = terminal.clone();
        wrong["error"]["details"] = json!({});
        wrong["error"]["message"] = json!("read_timeout");
        assert!(workflow_result("query", &json!({}), &wrong).is_err());
        wrong["error"]["code"] = json!("read_limit_exceeded");
        wrong["error"]["details"] = json!({"reason": "read_timeout"});
        assert!(workflow_result("query", &json!({}), &wrong).is_err());

        let mut invalid = terminal.clone();
        invalid["partial_bytes"] = json!(2);
        assert!(workflow_result("query", &json!({}), &invalid).is_err());
        invalid["partial_bytes"] = json!(3);
        invalid["partial_hex"] = json!("G25441");
        assert!(workflow_result("query", &json!({}), &invalid).is_err());

        let mut unconfirmed = terminal;
        unconfirmed["state"] = json!("running");
        assert!(workflow_result("query", &json!({}), &unconfirmed).is_err());
    }

    #[test]
    fn converted_partial_rx_flows_to_variable_and_string_assert_expression() {
        use crate::{
            data_context::DataContext,
            workflow::{
                Expression, ExpressionOperand, ExpressionOperator, InputValue, StepId,
                StepOutputReference, VariableId,
            },
        };

        let mut context = DataContext::new();
        let step_id = StepId::new("query-one").unwrap();
        context.set_step_output(
            step_id.clone(),
            workflow_result("query", &json!({}), &timeout_terminal("524541", 3)).unwrap(),
        );
        let partial = context
            .resolve(&InputValue::StepOutput(StepOutputReference::new(
                step_id.clone(),
                "/partial_rx_hex",
            )))
            .unwrap();
        assert_eq!(partial, json!("524541"));
        let variable = VariableId::new("mcu-response").unwrap();
        context.set_variable(variable.clone(), partial);
        let compare = InputValue::Expression(Expression::new(
            ExpressionOperand::Variable(variable),
            ExpressionOperator::Equal,
            ExpressionOperand::Literal(json!("524541")),
        ));
        assert_eq!(context.resolve(&compare).unwrap(), json!(true));
        assert_eq!(
            context
                .resolve(&InputValue::StepOutput(StepOutputReference::new(
                    step_id,
                    "/timed_out",
                )))
                .unwrap(),
            json!(true)
        );
    }

    #[test]
    fn normal_serial_result_preserves_native_rx_and_query_fields() {
        let terminal = json!({
            "state": "succeeded",
            "ok": true,
            "error": null,
            "result": {"rx_hex": "4849", "rx_bytes": 2, "tx_bytes": 1},
        });
        assert_eq!(
            workflow_result("query", &json!({}), &terminal).unwrap(),
            json!({
                "outcome": "completed",
                "timed_out": false,
                "rx_hex": "4849",
                "rx_bytes": 2,
                "tx_bytes": 1,
            })
        );
        assert_eq!(
            workflow_result("send", &json!({}), &terminal).unwrap(),
            terminal["result"]
        );
    }

    #[test]
    fn optional_utf8_rx_preserves_raw_bytes_and_decodes_partial_timeouts() {
        let completed = json!({
            "state": "succeeded",
            "ok": true,
            "error": null,
            "result": {"rx_hex": "4f4be5a5bd0d0a", "rx_bytes": 7},
        });
        let args = json!({"enable_rx_text": true});
        let result = workflow_result("receive", &args, &completed).unwrap();
        assert_eq!(result["rx_text"], "OK好\r\n");
        assert_eq!(result["rx_bytes"], 7);
        assert_eq!(result["rx_hex"], "4f4be5a5bd0d0a");
        assert!(workflow_result("receive", &json!({}), &completed).unwrap()
            .get("rx_text").is_none());

        let mut invalid = completed;
        invalid["result"]["rx_hex"] = json!("00ffa5");
        invalid["result"]["rx_bytes"] = json!(3);
        assert_eq!(workflow_result("query", &args, &invalid).unwrap()["rx_text"], Value::Null);
        let timeout = workflow_result("query", &args, &timeout_terminal("424f4f5420524541", 8))
            .unwrap();
        assert_eq!(timeout["partial_rx_text"], "BOOT REA");
        assert_eq!(timeout["partial_rx_bytes"], 8);
        assert_eq!(workflow_result("receive", &args, &timeout_terminal("ff", 1)).unwrap()
            ["partial_rx_text"], Value::Null);
        assert!(workflow_result(
            "query",
            &json!({"enable_rx_text": true, "fail_on_read_timeout": true}),
            &timeout_terminal("42", 1)
        ).is_err());
    }

    #[test]
    fn rx_modes_validate_required_fields_and_forward_only_active_arguments() {
        let delimiter = json!({
            "receive_mode": "delimiter",
            "delimiter_format": "text",
            "delimiter_value": "\\r\\n",
            "max_bytes": 64,
            "enable_rx_text": true,
        });
        assert_eq!(
            worker_arguments("receive", &delimiter).unwrap(),
            json!({"receive_mode": "delimiter", "delimiter_hex": "0d0a", "max_bytes": 64})
        );
        let fixed = json!({
            "tx_format": "text",
            "tx_value": "GO",
            "receive_mode": "fixed",
            "expected_bytes": 4,
            "max_bytes": 999,
            "delimiter_format": "text",
            "delimiter_value": "",
        });
        assert_eq!(
            worker_arguments("query", &fixed).unwrap(),
            json!({"tx_hex": "474f", "receive_mode": "fixed", "expected_bytes": 4})
        );
        let idle = json!({"receive_mode": "idle", "idle_gap_ms": 20, "max_bytes": 32});
        assert_eq!(
            worker_arguments("receive", &idle).unwrap(),
            json!({"receive_mode": "idle", "idle_gap_ms": 20, "max_bytes": 32})
        );
        for bad in [
            json!({"receive_mode": "fixed"}),
            json!({"receive_mode": "fixed", "expected_bytes": 0}),
            json!({"receive_mode": "fixed", "expected_bytes": 1.5}),
            json!({"receive_mode": "idle"}),
            json!({"receive_mode": "idle", "idle_gap_ms": 0}),
            json!({"receive_mode": "unknown"}),
            json!({"enable_rx_text": "true"}),
        ] {
            assert!(validate_action("receive", &bad, &Default::default()).is_err(), "{bad}");
        }
        assert!(validate_action(
            "query",
            &json!({"tx_format": "text", "tx_value": "GO", "receive_mode": "single"}),
            &Default::default(),
        ).is_err());
        assert_eq!(worker_arguments("receive", &json!({"max_bytes": 128})).unwrap(),
            json!({"max_bytes": 128}));
    }

    #[test]
    fn fail_on_read_timeout_is_validated_and_never_forwarded_to_worker() {
        let mut args = json!({"max_bytes": 32, "fail_on_read_timeout": false});
        assert_eq!(
            worker_arguments("receive", &args).unwrap(),
            json!({"max_bytes": 32})
        );
        args["fail_on_read_timeout"] = json!(true);
        assert_eq!(
            worker_arguments("receive", &args).unwrap(),
            json!({"max_bytes": 32})
        );
        args["fail_on_read_timeout"] = json!("false");
        assert!(validate_action("receive", &args, &Default::default()).is_err());
        assert!(
            validate_action(
                "send",
                &json!({"tx_format": "text", "tx_value": "OK", "fail_on_read_timeout": false}),
                &Default::default(),
            )
            .is_err()
        );
    }

    #[test]
    fn serial_timeout_setting_round_trips_and_missing_flag_uses_new_default() {
        for setting in [None, Some(false), Some(true)] {
            let mut arguments = json!({"max_bytes": 32});
            if let Some(value) = setting {
                arguments["fail_on_read_timeout"] = json!(value);
            }
            let wire = json!({
                "name": "Serial read",
                "tool_instances": [{
                    "id": "serial-one",
                    "tool": "serial",
                    "setup": {"transport": "serial", "baud": 115200}
                }],
                "workflow": {
                    "interaction": {"enabled": false, "max_active_command_status": 4096},
                    "steps": [{
                        "type": "tool-action",
                        "id": "serial-read",
                        "target": "serial-one",
                        "action": "receive",
                        "arguments": arguments,
                    }]
                }
            });
            let parsed = crate::template::Template::from_json_str(&wire.to_string()).unwrap();
            let saved: Value = serde_json::from_str(&parsed.to_json_string().unwrap()).unwrap();
            let stored = &saved["workflow"]["steps"][0]["arguments"];
            assert_eq!(stored["fail_on_read_timeout"].as_bool(), setting);
            assert_eq!(
                workflow_result("receive", stored, &timeout_terminal("", 0)).is_err(),
                setting == Some(true)
            );
        }
    }

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
            (json!(9_007_199_254_740_991_u64), "ff"),
        ] {
            assert_eq!(encode_tx("hex-byte", &input).unwrap(), expected);
        }
        for value in [
            json!(-10),
            json!(1.5),
            json!("123"),
            json!(true),
            json!(9_007_199_254_740_992_u64),
            json!(9_007_199_254_740_993_u64),
            json!(9_007_199_254_740_992.0),
        ] {
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
            "name": "Serial File",
            "tool_instances": [{ "id": "serial-1", "tool": "serial",
                "setup": {"transport":"serial","baud": 115200} }],
            "workflow": {"interaction":{"enabled":false,"max_active_command_status":4096},"steps": [
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
                .any(|p| p[0] == "--simulation-profile-id" && p[1] == "periodic-rx-v1")
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
    fn tcp_launch_uses_only_tcp_options_for_foreground_and_background() {
        let setup = SerialSetup {
            transport: SerialTransport::Tcp,
            connect_timeout_ms: 4500,
            io_timeout_ms: 1250,
            ..Default::default()
        };
        let executable = std::path::Path::new("serial-tool");
        let live = foreground_worker_launch_spec(
            executable,
            ExecutionMode::Live,
            Some("device.local:5025"),
            &setup,
        )
        .unwrap();
        let sim = background_worker_launch_spec(executable, ExecutionMode::Simulate, None, &setup)
            .unwrap();
        let args = |spec: &WorkerLaunchSpec| {
            spec.arguments()
                .iter()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        };
        let live = args(&live);
        let sim = args(&sim);
        for flag in [
            "--baud",
            "--port",
            "--data-bits",
            "--parity",
            "--stop-bits",
            "--flow-control",
            "--timeout-ms",
        ] {
            assert!(!live.contains(&flag.to_owned()));
            assert!(!sim.contains(&flag.to_owned()));
        }
        for pair in [
            ["--transport", "tcp"],
            ["--host", "device.local"],
            ["--tcp-port", "5025"],
            ["--connect-timeout-ms", "4500"],
            ["--io-timeout-ms", "1250"],
        ] {
            assert!(
                live.windows(2)
                    .any(|args| args[0] == pair[0] && args[1] == pair[1])
            );
        }
        assert!(!sim.iter().any(|arg| arg == "--host" || arg == "--tcp-port"));
        assert!(sim.contains(&"--streaming".to_owned()));
        assert!(
            sim.windows(2).any(|args| {
                args[0] == "--simulation-profile-id" && args[1] == "periodic-rx-v1"
            })
        );
        assert!(
            foreground_worker_launch_spec(executable, ExecutionMode::Live, Some("COM4"), &setup)
                .is_err()
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
