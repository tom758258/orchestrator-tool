//! Common Worker v3 envelopes, local endpoints, and observation validation.
//! Domain event payloads, instrument state, and cleanup commands remain tool-owned.

use crate::manifest::ToolManifest;
use chrono::DateTime;
use serde_json::Value;
use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    str::FromStr,
};

pub const SCHEMA_VERSION: u64 = 3;

pub fn version(value: &Value) -> Result<(), String> {
    if value.get("schema_version").and_then(Value::as_u64) == Some(SCHEMA_VERSION) {
        Ok(())
    } else {
        Err("Worker schema_version requires the exact integer token 3".into())
    }
}

pub fn required_string<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| format!("missing or invalid {key}"))
}

pub fn timestamp(value: &Value) -> Result<(), String> {
    let raw = required_string(value, "timestamp_utc")?;
    let date = DateTime::parse_from_rfc3339(raw).map_err(|_| "invalid timestamp_utc")?;
    if date.offset().local_minus_utc() != 0 {
        return Err("timestamp_utc must be UTC".into());
    }
    Ok(())
}

pub fn common_error(value: &Value) -> Result<(), String> {
    let category = required_string(value, "category")?;
    if !matches!(
        category,
        "validation" | "admission" | "execution" | "worker"
    ) {
        return Err("unsupported Common Error category".into());
    }
    required_string(value, "code")?;
    required_string(value, "message")?;
    if !value.get("details").is_some_and(Value::is_object) {
        return Err("Common Error details must be an object".into());
    }
    Ok(())
}

pub fn error_or_null(value: Option<&Value>) -> Result<(), String> {
    let error = value.ok_or("missing Common Error/null field")?;
    if !error.is_null() {
        common_error(error)?;
    }
    Ok(())
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalOrigin {
    host: IpAddr,
    port: u16,
}

impl LocalOrigin {
    /// Only numeric loopback origins are accepted. No DNS, redirects or proxy.
    pub fn check(url: &str) -> Result<Self, String> {
        let uri: ureq::http::Uri = url.parse().map_err(|_| "invalid Worker HTTP URL")?;
        if uri.scheme_str() != Some("http") {
            return Err("local Worker HTTP URL must use http".into());
        }
        let authority = uri.authority().ok_or("Worker HTTP URL missing authority")?;
        if authority.as_str().contains('@') {
            return Err("Worker HTTP URL must not contain userinfo".into());
        }
        let host = authority.host();
        let numeric = host.trim_start_matches('[').trim_end_matches(']');
        let ip = IpAddr::from_str(numeric).map_err(|_| "Worker HTTP URL must use a numeric IP")?;
        if !ip.is_loopback()
            || matches!(ip, IpAddr::V4(addr) if addr == Ipv4Addr::UNSPECIFIED)
            || matches!(ip, IpAddr::V6(addr) if addr == Ipv6Addr::UNSPECIFIED)
        {
            return Err("Worker HTTP URL must use loopback".into());
        }
        let port = authority.port_u16().unwrap_or(80);
        Ok(Self { host: ip, port })
    }

    pub fn validate_same(&self, url: &str) -> Result<(), String> {
        let other = Self::check(url)?;
        if &other != self {
            return Err("Worker HTTP endpoints must have the same origin".into());
        }
        Ok(())
    }
}

/// Validate all endpoints before any of them can be used for HTTP requests.
pub fn endpoints(value: &Value) -> Result<LocalOrigin, String> {
    let origin = LocalOrigin::check(required_string(value, "status_url")?)?;
    for key in ["command_url", "stop_url"] {
        origin.validate_same(required_string(value, key)?)?;
    }
    if let Some(cancel) = value.get("cancel_url")
        && !cancel.is_null()
    {
        origin.validate_same(cancel.as_str().ok_or("invalid cancel_url")?)?;
    }
    Ok(origin)
}

pub fn ready(value: &Value, manifest: Option<&ToolManifest>) -> Result<LocalOrigin, String> {
    version(value)?;
    timestamp(value)?;
    if required_string(value, "event")? != "ready" {
        return Err("expected Worker ready event".into());
    }
    required_string(value, "run_id")?;
    let features = value
        .get("features")
        .ok_or("ready missing runtime features")?;
    if !features.is_object() {
        return Err("runtime features must be an object".into());
    }
    if let Some(manifest) = manifest {
        manifest.validate_runtime_features(features, &[])?;
    }
    adopted_fields(value)?;
    if value
        .get("stream")
        .and_then(|stream| stream.get("state"))
        .is_some()
    {
        return Err("ready must not contain stream.state".into());
    }
    endpoints(value)
}

fn adopted_fields(value: &Value) -> Result<(), String> {
    let features = value
        .get("features")
        .and_then(Value::as_object)
        .ok_or("missing runtime features")?;
    if features.contains_key("common.job_cancel") {
        required_string(value, "cancel_url")?;
    } else if value.get("cancel_url").is_some_and(|url| !url.is_null()) {
        return Err("cancel_url without runtime adoption".into());
    }
    if features.contains_key("common.streaming") {
        let stream = value.get("stream").ok_or("missing adopted stream")?;
        let lifecycle = required_string(stream, "lifecycle")?;
        let selected = features["common.streaming"]["lifecycles"]
            .as_array()
            .ok_or("missing runtime streaming lifecycle selection")?;
        if selected.len() != 1 || selected[0] != lifecycle {
            return Err("runtime streaming lifecycle mismatch".into());
        }
    } else if value.get("stream").is_some_and(|v| !v.is_null()) {
        return Err("stream snapshot without common.streaming adoption".into());
    }
    Ok(())
}

fn async_snapshot(value: &Value, terminal: bool) -> Result<(), String> {
    if value.is_null() {
        return Ok(());
    }
    if !value.is_object() {
        return Err("async job snapshot must be an object or null".into());
    }
    required_string(value, "worker_job_id")?;
    required_string(value, "command")?;
    timestamp(value)?;
    if !value
        .get("job_id")
        .is_some_and(|job| job.is_null() || job.is_string())
    {
        return Err("async job snapshot missing client job_id".into());
    }
    let state = required_string(value, "state")?;
    if terminal {
        if !matches!(state, "succeeded" | "failed" | "cancelled") {
            return Err("last_job must be a terminal snapshot".into());
        }
        let ok = value
            .get("ok")
            .and_then(Value::as_bool)
            .ok_or("terminal snapshot missing ok")?;
        value
            .get("result")
            .ok_or("terminal snapshot missing result")?;
        let error = value
            .get("error")
            .ok_or("terminal snapshot missing error")?;
        error_or_null(Some(error))?;
        if (state == "succeeded" && (!ok || !error.is_null()))
            || (state == "failed" && (ok || error.is_null()))
            || (state == "cancelled" && ok)
        {
            return Err("terminal snapshot state/ok/error mismatch".into());
        }
    } else if !matches!(state, "queued" | "running") {
        return Err("active_job must be a non-terminal snapshot".into());
    }
    Ok(())
}

/// Validate the adopted async-job snapshots in both HTTP and JSONL Status.
pub fn async_status_snapshots(value: &Value, features: &Value) -> Result<(), String> {
    if features.get("common.async_jobs").is_some() {
        let active = value
            .get("active_job")
            .ok_or("Async Worker Status missing active_job")?;
        let last = value
            .get("last_job")
            .ok_or("Async Worker Status missing last_job")?;
        async_snapshot(active, false)?;
        async_snapshot(last, true)?;
    }
    Ok(())
}

/// Source readiness for an opted-in stream cannot be inferred from active
/// if the Worker reports that it is stopping or failed.
pub fn stream_source_ready(status: &Value) -> Result<bool, String> {
    if !status.get("fatal_error").is_some_and(Value::is_null)
        || matches!(status["worker_state"].as_str(), Some("failed" | "stopping"))
    {
        return Err("Worker failed or stopped before stream source readiness".into());
    }
    let state = required_string(&status["stream"], "state")?;
    match state {
        "ended" => Err("stream ended before source readiness".into()),
        "active" => Ok(status["worker_state"] == "running"),
        "waiting" => Ok(false),
        _ => Err("invalid stream state".into()),
    }
}

pub fn status(
    value: &Value,
    run_id: &str,
    origin: &LocalOrigin,
    manifest: Option<&ToolManifest>,
    features: &Value,
    is_fallback: bool,
) -> Result<(), String> {
    version(value)?;
    timestamp(value)?;
    if required_string(value, "run_id")? != run_id {
        return Err("HTTP Status run_id mismatch".into());
    }
    let state = required_string(value, "worker_state")?;
    if !matches!(state, "starting" | "running" | "stopping" | "failed") {
        return Err("invalid worker_state".into());
    }
    error_or_null(value.get("fatal_error"))?;
    if state == "failed" && value["fatal_error"].is_null() {
        return Err("failed Worker requires fatal_error".into());
    }
    let actual_features = value
        .get("features")
        .ok_or("HTTP Status missing features")?;
    if actual_features != features {
        return Err("HTTP Status runtime feature declaration changed".into());
    }
    if let Some(manifest) = manifest {
        manifest.validate_runtime_features(actual_features, &[])?;
    }
    adopted_fields(value)?;
    let observed_origin = endpoints(value)?;
    if observed_origin != *origin {
        return Err("HTTP Status origin changed".into());
    }
    async_status_snapshots(value, features)?;
    if features.get("common.streaming").is_some() {
        // Status must retain the Ready-adopted lifecycle; it may only
        // advance the current state of that same opted-in source.
        if value["stream"]["lifecycle"] != features["common.streaming"]["lifecycles"][0] {
            return Err("Stream Status lifecycle differs from runtime adoption".into());
        }
        let state = required_string(&value["stream"], "state")?;
        if !matches!(state, "waiting" | "active" | "ended") {
            return Err("invalid stream state".into());
        }
    }
    if is_fallback && (state != "running" || !value["fatal_error"].is_null()) {
        return Err("HTTP Status fallback did not establish readiness".into());
    }
    Ok(())
}

pub fn event_envelope(value: &Value, run_id: &str) -> Result<(), String> {
    version(value)?;
    timestamp(value)?;
    if required_string(value, "run_id")? != run_id {
        return Err("Worker JSONL run_id mismatch".into());
    }
    match required_string(value, "event")? {
        "status" => {
            if value
                .get("stream")
                .is_some_and(|stream| stream.is_object() && stream.get("state").is_none())
            {
                return Err("stream Status missing stream.state".into());
            }
            let state = required_string(value, "worker_state")?;
            if !matches!(state, "starting" | "running" | "stopping" | "failed") {
                return Err("invalid JSONL worker_state".into());
            }
            error_or_null(value.get("fatal_error"))?;
            if state == "failed" && value["fatal_error"].is_null() {
                return Err("failed Worker JSONL status requires fatal_error".into());
            }
        }
        "error" => {
            let scope = required_string(value, "scope")?;
            if !matches!(scope, "request" | "job" | "worker") {
                return Err("invalid error scope".into());
            }
            let fatal = value
                .get("fatal")
                .and_then(Value::as_bool)
                .ok_or("error event missing fatal boolean")?;
            if fatal && scope != "worker" {
                return Err("non-worker fatal event".into());
            }
            common_error(
                value
                    .get("error")
                    .ok_or("error event missing Common Error")?,
            )?;
            if scope == "job" {
                required_string(value, "worker_job_id")?;
                required_string(value, "command")?;
                if !value
                    .get("job_id")
                    .is_some_and(|x| x.is_null() || x.is_string())
                {
                    return Err("job-scope error missing client job_id".into());
                }
            }
        }
        "summary" => {
            if !value.get("ok").is_some_and(Value::is_boolean)
                || !value.get("exit_code").is_some_and(Value::is_i64)
            {
                return Err("invalid Worker summary".into());
            }
            error_or_null(value.get("fatal_error"))?;
        }
        _ => {}
    }
    Ok(())
}

pub fn command_accepted(
    value: &Value,
    http_status: u16,
    run_id: &str,
    command: &str,
    job_id: &str,
    kind: &str,
) -> Result<Option<String>, String> {
    version(value)?;
    if required_string(value, "run_id")? != run_id
        || http_status != 202
        || required_string(value, "status")? != "accepted"
        || required_string(value, "command")? != command
        || required_string(value, "job_id")? != job_id
        || required_string(value, "kind")? != kind
        || !value.get("error").is_some_and(Value::is_null)
    {
        return Err("HTTP Command acceptance does not match submitted command".into());
    }
    match kind {
        "async_job" => Ok(Some(required_string(value, "worker_job_id")?.to_owned())),
        "control" if value.get("worker_job_id").is_some_and(Value::is_null) => Ok(None),
        _ => Err("unsupported accepted Command kind or worker_job_id".into()),
    }
}

/// Reject before reporting a non-accepted submission. Do not resend a
/// side-effecting request after any HTTP or protocol failure.
pub fn command_rejected(
    value: &Value,
    http_status: u16,
    run_id: &str,
    command: &str,
    job_id: &str,
) -> Result<String, String> {
    version(value)?;
    if !matches!(http_status, 400 | 409 | 429 | 500)
        || required_string(value, "run_id")? != run_id
        || value["command"] != command
        || value["job_id"] != job_id
        || !value.get("worker_job_id").is_some_and(Value::is_null)
    {
        return Err("invalid HTTP Command rejection envelope".into());
    }
    let expected_status = if matches!(http_status, 409 | 429) {
        "rejected"
    } else {
        "error"
    };
    if required_string(value, "status")? != expected_status {
        return Err("Command HTTP status and response status mismatch".into());
    }
    match value.get("kind") {
        Some(Value::String(kind)) if matches!(kind.as_str(), "control" | "async_job") => {}
        Some(Value::Null) => {}
        _ => return Err("invalid rejection kind".into()),
    }
    common_error(value.get("error").ok_or("rejection missing Common Error")?)?;
    Ok(format!(
        "{}: {}",
        required_string(&value["error"], "code")?,
        required_string(&value["error"], "message")?
    ))
}

pub fn stop_accepted(value: &Value, http_status: u16, run_id: &str) -> Result<(), String> {
    version(value)?;
    if !matches!(http_status, 200 | 202)
        || required_string(value, "run_id")? != run_id
        || required_string(value, "status")? != "accepted"
        || !value.get("error").is_some_and(Value::is_null)
    {
        return Err("invalid Worker Stop acceptance envelope".into());
    }
    Ok(())
}

pub fn stream_transition(previous: Option<&str>, next: &str) -> Result<(), String> {
    let old = match previous {
        None => {
            return if matches!(next, "waiting" | "active" | "ended") {
                Ok(())
            } else {
                Err("invalid stream state".into())
            };
        }
        Some(value) => value,
    };
    if old == next
        || matches!(
            (old, next),
            ("waiting", "active" | "ended") | ("active", "ended")
        )
    {
        Ok(())
    } else {
        Err("stream state regressed or restarted".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_numeric_loopback_same_origin() {
        let valid = json!({"status_url":"http://127.0.0.1:8765/status",
            "command_url":"http://127.0.0.1:8765/command",
            "stop_url":"http://127.0.0.1:8765/stop"});
        assert!(endpoints(&valid).is_ok());
        for invalid in [
            "http://0.0.0.0:8765/command",
            "https://127.0.0.1:8765/command",
            "http://127.0.0.2:8765/command",
            "http://127.0.0.1:8766/command",
            "http://user@127.0.0.1:8765/command",
            "http://example.com:8765/command",
        ] {
            let mut changed = valid.clone();
            changed["command_url"] = json!(invalid);
            assert!(endpoints(&changed).is_err(), "{invalid}");
        }
    }

    #[test]
    fn worker_versions_and_stop_codes() {
        for token in ["\"3\"", "true", "3.0", "3e0", "null"] {
            let raw = format!("{{\"schema_version\":{token}}}");
            let v: Value = serde_json::from_str(&raw).unwrap();
            assert!(version(&v).is_err(), "{token}");
        }
        for code in [200, 202] {
            assert!(
                stop_accepted(
                    &json!({"schema_version":3,"run_id":"r1",
                "status":"accepted","error":null}),
                    code,
                    "r1"
                )
                .is_ok()
            );
        }
        assert!(
            stop_accepted(
                &json!({"schema_version":3,"run_id":"r1",
            "status":"accepted","error":null}),
                204,
                "r1"
            )
            .is_err()
        );
    }

    #[test]
    fn stream_progress_never_moves_backwards() {
        assert!(stream_transition(None, "active").is_ok());
        assert!(stream_transition(Some("active"), "ended").is_ok());
        assert!(stream_transition(Some("ended"), "active").is_err());
        assert!(stream_transition(Some("active"), "waiting").is_err());
    }

    #[test]
    fn async_status_snapshots_must_be_complete_and_well_typed() {
        let mut status = json!({
            "schema_version":3,"timestamp_utc":"2026-10-23T10:00:00Z",
            "run_id":"run","worker_state":"running","fatal_error":null,
            "features":{"common.async_jobs":{"contract_version":1}},
            "status_url":"http://127.0.0.1:8787/status",
            "command_url":"http://127.0.0.1:8787/command",
            "stop_url":"http://127.0.0.1:8787/stop",
            "active_job":null,"last_job":null
        });
        let origin = endpoints(&status).unwrap();
        let features = status["features"].clone();
        assert!(self::status(&status, "run", &origin, None, &features, false).is_ok());
        status["active_job"] = json!({"state":"running","worker_job_id":"w1"});
        assert!(self::status(&status, "run", &origin, None, &features, false).is_err());
        status["active_job"] = Value::Null;
        status["last_job"] = json!({
            "state":"succeeded","worker_job_id":"w1","job_id":"client",
            "command":"read","timestamp_utc":"2026-10-23T10:00:00Z",
            "ok":true,"result":null
        });
        assert!(self::status(&status, "run", &origin, None, &features, false).is_err());

        // JSONL Status follows the same owning-layer snapshot contract.
        status["last_job"] = Value::Null;
        let mut event = status.clone();
        event["event"] = json!("status");
        assert!(event_envelope(&event, "run").is_ok());
        assert!(async_status_snapshots(&event, &features).is_ok());
        event.as_object_mut().unwrap().remove("active_job");
        assert!(async_status_snapshots(&event, &features).is_err());
    }

    #[test]
    fn stream_source_active_does_not_override_worker_failure() {
        let mut snapshot = json!({
            "worker_state":"running","fatal_error":null,
            "stream":{"state":"waiting"}
        });
        assert!(!stream_source_ready(&snapshot).unwrap());
        snapshot["stream"]["state"] = json!("active");
        assert!(stream_source_ready(&snapshot).unwrap());
        snapshot["worker_state"] = json!("failed");
        snapshot["fatal_error"] = json!({"category":"worker","code":"failed",
            "message":"source failure","details":{}});
        assert!(stream_source_ready(&snapshot).is_err());
        snapshot["worker_state"] = json!("stopping");
        snapshot["fatal_error"] = Value::Null;
        assert!(stream_source_ready(&snapshot).is_err());
    }

    #[test]
    fn reject_envelope_and_status_stream_invariants() {
        let denied = json!({"schema_version":3,"run_id":"r","status":"rejected",
            "command":"read","job_id":"j","kind":"async_job","worker_job_id":null,
            "error":{"category":"admission","code":"busy","message":"busy","details":{}}});
        assert_eq!(
            command_rejected(&denied, 409, "r", "read", "j").unwrap(),
            "busy: busy"
        );
        assert!(command_rejected(&denied, 202, "r", "read", "j").is_err());
        let mut malformed = denied;
        malformed["worker_job_id"] = json!("unexpected");
        assert!(command_rejected(&malformed, 409, "r", "read", "j").is_err());
    }

    #[test]
    fn error_and_summary_envelopes_fail_closed() {
        let fatal = json!({"event":"error","schema_version":3,"run_id":"r",
            "timestamp_utc":"2026-10-23T15:00:00Z",
            "scope":"request","fatal":true,
            "error":{"category":"worker","code":"broken","message":"broken","details":{}}});
        assert!(event_envelope(&fatal, "r").is_err());
        let mut fixed = fatal;
        fixed["scope"] = json!("worker");
        assert!(event_envelope(&fixed, "r").is_ok());
        fixed["error"]["details"] = json!(null);
        assert!(event_envelope(&fixed, "r").is_err());
    }
}
