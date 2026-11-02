//! Serial RX-only Background adapter. The serial-tool owns the COM session.
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
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
