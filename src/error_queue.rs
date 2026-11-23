//! Manual instrument diagnostics through the external Tools' existing CLI commands.

use std::{
    path::Path,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    adapters::{powers::SIMULATION_RESOURCE, scopes},
    config::{Config, VisaBackend},
    discovery::{ExecutableStatus, built_in_tool_definitions},
    inspection::inspect_tool,
    process::{CaptureError, run_output_with_timeout},
    run::ExecutionMode,
    tool::ToolId,
    tool_instance::ToolInstanceId,
};

const MAX_READS: usize = 20;
const READ_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorQueueStatus {
    QueueEmpty,
    Drained,
    NotFullyDrained,
    Failed,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct ErrorQueueEntry {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct ErrorQueueResult {
    pub status: ErrorQueueStatus,
    pub entries: Vec<ErrorQueueEntry>,
    pub error: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Diagnostic {
    Powers,
    Meters,
    Scopes,
}

impl Diagnostic {
    fn command(self) -> &'static str {
        match self {
            Self::Powers => "error",
            Self::Meters => "read-errors",
            Self::Scopes => "check-error",
        }
    }

    fn arguments(self, live: Option<(&str, VisaBackend)>, limit: usize) -> Vec<String> {
        let mut args = vec![
            self.command().into(),
            "--json".into(),
            "--max-reads".into(),
            limit.to_string(),
        ];
        if self == Self::Scopes {
            args.push("--all".into());
        }
        if let Some((resource, backend)) = live {
            args.push(format!("--resource={resource}"));
            if backend == VisaBackend::Py {
                args.push(
                    if self == Self::Powers {
                        "--backend=@py"
                    } else {
                        "--visa-library=@py"
                    }
                    .into(),
                );
            }
        } else {
            args.push("--simulate".into());
            match self {
                Self::Powers => args.push(format!("--resource={SIMULATION_RESOURCE}")),
                Self::Meters => args.push("--model=34461A".into()),
                Self::Scopes => {}
            }
        }
        args
    }
}

/// Reads the selected instrument queue, or the Tool's hardware-free simulator.
pub fn read_and_drain_errors(
    application_dir: &Path,
    config: &Config,
    tool: &ToolId,
    instance: &ToolInstanceId,
    mode: ExecutionMode,
) -> Result<ErrorQueueResult, String> {
    let diagnostic = match tool.as_str() {
        "powers" => Diagnostic::Powers,
        "meters" => Diagnostic::Meters,
        "scopes" => Diagnostic::Scopes,
        _ => return Err(format!("{tool} does not support Read & Drain Errors")),
    };
    let live = if mode == ExecutionMode::Live {
        let resource = config
            .live_resource(instance)
            .filter(|resource| !resource.trim().is_empty())
            .ok_or_else(|| format!("{instance} saved Live Resource is not configured"))?;
        Some((resource, config.live_backend(instance)))
    } else {
        None
    };
    let definition = built_in_tool_definitions()
        .into_iter()
        .find(|definition| definition.id() == tool)
        .expect("diagnostic tool is built in");
    let inspection =
        inspect_tool(application_dir, config, &definition).map_err(|error| error.to_string())?;
    if inspection.status() != ExecutableStatus::Available {
        return Err(format!("{tool} executable is unavailable"));
    }
    let executable = inspection
        .resolved()
        .path()
        .expect("available executable has a path");
    if diagnostic == Diagnostic::Scopes {
        let model = config
            .live_resource_identities()
            .get(instance.as_str())
            .and_then(|identity| identity.model_id.as_deref());
        let capability = scopes::get_capabilities_for_mode(application_dir, config, mode, model)?;
        if !capability.check_error_supported {
            return Err(format!(
                "{} does not support Read & Drain Errors",
                capability.model_name
            ));
        }
    }

    // Powers and Scopes only report entries on completion of a CLI read. In
    // Live, commit each successful read before requesting the next entry.
    let batch_size = if live.is_some() && diagnostic != Diagnostic::Meters {
        1
    } else {
        MAX_READS
    };
    let deadline = Instant::now() + READ_TIMEOUT;
    let args = diagnostic.arguments(live, batch_size);
    Ok(drain(MAX_READS / batch_size, || {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("Error Queue read timed out".into());
        }
        let output =
            run_output_with_timeout(executable, &args, remaining).map_err(|error| match error {
                CaptureError::Io(error) => {
                    format!("Could not run {tool} Error Queue command: {error}")
                }
                CaptureError::Timeout => "Error Queue read timed out".to_owned(),
            })?;
        let response = serde_json::from_slice(&output.stdout).map_err(|error| {
            let stderr = String::from_utf8_lossy(&output.stderr);
            if stderr.trim().is_empty() {
                format!("{tool} returned invalid Error Queue JSON: {error}")
            } else {
                stderr.trim().to_owned()
            }
        })?;
        parse_reply(
            diagnostic,
            &response,
            output.status.code(),
            mode,
            batch_size,
        )
    }))
}

struct ReadReply {
    entries: Vec<ErrorQueueEntry>,
    confirmed_empty: bool,
    failure: Option<String>,
}

fn drain(
    attempt_limit: usize,
    mut read: impl FnMut() -> Result<ReadReply, String>,
) -> ErrorQueueResult {
    let mut result = ErrorQueueResult {
        status: ErrorQueueStatus::NotFullyDrained,
        entries: Vec::new(),
        error: None,
    };
    for _ in 0..attempt_limit {
        let reply = match read() {
            Ok(reply) => reply,
            Err(error) => {
                result.status = ErrorQueueStatus::Failed;
                result.error = Some(error);
                break;
            }
        };
        result.entries.extend(reply.entries);
        if let Some(error) = reply.failure {
            result.status = ErrorQueueStatus::Failed;
            result.error = Some(error);
            break;
        }
        if reply.confirmed_empty {
            result.status = if result.entries.is_empty() {
                ErrorQueueStatus::QueueEmpty
            } else {
                ErrorQueueStatus::Drained
            };
            break;
        }
    }
    result
}

fn parse_reply(
    diagnostic: Diagnostic,
    response: &Value,
    exit_code: Option<i32>,
    mode: ExecutionMode,
    limit: usize,
) -> Result<ReadReply, String> {
    let simulate = mode == ExecutionMode::Simulate;
    let mode_name = if simulate {
        "simulate"
    } else if diagnostic == Diagnostic::Scopes {
        "live"
    } else {
        "real"
    };
    let invalid = || {
        format!(
            "{} returned an unexpected Error Queue result",
            diagnostic.command()
        )
    };
    let failure = || {
        response["error"]["message"]
            .as_str()
            .or_else(|| response["message"].as_str())
            .map_or_else(invalid, str::to_owned)
    };
    let command = if diagnostic == Diagnostic::Powers {
        &response["command"]["name"]
    } else {
        &response["command"]
    };
    if response["schema_version"] != 2 || command != diagnostic.command() {
        return Err(invalid());
    }

    let (entries, confirmed_empty) = match diagnostic {
        Diagnostic::Powers => {
            if exit_code != Some(0) || response["ok"] != true {
                return Err(failure());
            }
            if response["execution"]["mode"] != mode_name
                || response["execution"]["hardware_touched"] != !simulate
            {
                return Err(invalid());
            }
            let data = &response["data"];
            let errors = data["errors"].as_array().ok_or_else(invalid)?;
            let reads = data["read_count"].as_u64().ok_or_else(invalid)?;
            let empty = reads == errors.len() as u64 + 1;
            if reads > limit as u64 || (!empty && (reads != limit as u64 || errors.len() != limit))
            {
                return Err(invalid());
            }
            let entries = errors
                .iter()
                .map(|value| {
                    let raw = value.as_str().ok_or_else(invalid)?;
                    let (code, message) = raw
                        .split_once(',')
                        .ok_or_else(|| format!("Invalid Powers Error Queue entry: {raw}"))?;
                    let code = code.trim();
                    if matches!(code.parse::<i64>(), Ok(0) | Err(_)) {
                        return Err(format!("Invalid Powers Error Queue entry: {raw}"));
                    }
                    let message = message.trim();
                    Ok(ErrorQueueEntry {
                        code: code.to_owned(),
                        message: message
                            .strip_prefix('"')
                            .and_then(|text| text.strip_suffix('"'))
                            .unwrap_or(message)
                            .to_owned(),
                    })
                })
                .collect::<Result<Vec<_>, _>>()?;
            (entries, empty)
        }
        Diagnostic::Meters => {
            if response["event"] == "error" && response["status"] == "error" {
                let partial = &response["partial_result"];
                let entries = if partial["mode"] == mode_name {
                    structured_entries(&partial["errors"]).ok_or_else(invalid)?
                } else {
                    Vec::new()
                };
                return Ok(ReadReply {
                    entries,
                    confirmed_empty: false,
                    failure: Some(failure()),
                });
            }
            if exit_code != Some(0)
                || response["event"] != "read-errors"
                || response["status"] != "ok"
                || response["mode"] != mode_name
            {
                return Err(failure());
            }
            let empty = match (
                response["termination"].as_str(),
                response["queue_cleared"].as_bool(),
            ) {
                (Some("no_error"), Some(true)) => true,
                (Some("max_reads"), Some(false)) => false,
                _ => return Err(invalid()),
            };
            (
                structured_entries(&response["errors"]).ok_or_else(invalid)?,
                empty,
            )
        }
        Diagnostic::Scopes => {
            // The CLI exits 1 for ordinary nonzero queue entries as well as
            // failures. Only the latter carry an error envelope.
            if !matches!(exit_code, Some(0 | 1))
                || !response["error"].is_null()
                || response["mode"] != mode_name
            {
                return Err(failure());
            }
            let mut entries = response["result"]["entries"]
                .as_array()
                .filter(|entries| !entries.is_empty() && entries.len() <= limit)
                .ok_or_else(invalid)?
                .as_slice();
            let empty = entries
                .last()
                .is_some_and(|entry| entry["code"] == 0 && entry["is_error"] == false);
            if empty {
                entries = &entries[..entries.len() - 1];
            } else if entries.len() != limit {
                return Err(invalid());
            }
            if entries
                .iter()
                .any(|entry| entry["code"] == 0 || entry["is_error"] != true)
            {
                return Err(invalid());
            }
            (
                entries
                    .iter()
                    .map(|entry| StructuredEntry::deserialize(entry).map(Into::into))
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|_| invalid())?,
                empty,
            )
        }
    };
    Ok(ReadReply {
        entries,
        confirmed_empty,
        failure: None,
    })
}

#[derive(Deserialize)]
struct StructuredEntry {
    code: i64,
    message: String,
}

impl From<StructuredEntry> for ErrorQueueEntry {
    fn from(entry: StructuredEntry) -> Self {
        Self {
            code: entry.code.to_string(),
            message: entry.message,
        }
    }
}

fn structured_entries(value: &Value) -> Option<Vec<ErrorQueueEntry>> {
    Vec::<StructuredEntry>::deserialize(value)
        .ok()
        .map(|entries| entries.into_iter().map(Into::into).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn scopes_distinguishes_reported_errors_from_failure_and_confirms_empty() {
        let error =
            json!({"code": -113, "message": "Undefined header, channel 1", "is_error": true});
        let zero = json!({"code": 0, "message": "No error", "is_error": false});
        for (entries, limit, exit, status) in [
            (vec![zero.clone()], 2, 0, ErrorQueueStatus::QueueEmpty),
            (vec![error.clone(), zero], 2, 1, ErrorQueueStatus::Drained),
            (vec![error.clone()], 1, 1, ErrorQueueStatus::NotFullyDrained),
            (vec![error], 2, 1, ErrorQueueStatus::Failed),
        ] {
            let response = json!({"schema_version": 2, "command": "check-error", "mode": "simulate", "error": null,
                "result": {"entries": entries}});
            let result = drain(1, || {
                parse_reply(
                    Diagnostic::Scopes,
                    &response,
                    Some(exit),
                    ExecutionMode::Simulate,
                    limit,
                )
            });
            assert_eq!(result.status, status);
            if matches!(
                status,
                ErrorQueueStatus::Drained | ErrorQueueStatus::NotFullyDrained
            ) {
                assert_eq!(
                    result.entries,
                    [ErrorQueueEntry {
                        code: "-113".into(),
                        message: "Undefined header, channel 1".into()
                    }]
                );
            }
        }
    }

    #[test]
    fn meters_preserves_partial_result_when_the_cli_fails() {
        let response = json!({"schema_version": 2,"command": "read-errors", "event": "error", "status": "error",
            "message": "Connection lost", "partial_result": {"mode": "real", "errors": [{"code": -100, "message": "Command error"}]}});
        let result = drain(1, || {
            parse_reply(
                Diagnostic::Meters,
                &response,
                Some(3),
                ExecutionMode::Live,
                MAX_READS,
            )
        });
        assert_eq!(result.status, ErrorQueueStatus::Failed);
        assert_eq!(result.error.as_deref(), Some("Connection lost"));
        assert_eq!(
            result.entries,
            [ErrorQueueEntry {
                code: "-100".into(),
                message: "Command error".into()
            }]
        );
    }

    #[cfg(unix)]
    #[test]
    fn powers_uses_saved_live_binding_and_retains_entries_before_failure() {
        use std::{
            fs,
            os::unix::fs::PermissionsExt,
            time::{SystemTime, UNIX_EPOCH},
        };

        let dir = std::env::temp_dir().join(format!(
            "orchestrator-error-queue-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&dir).unwrap();
        let tool = ToolId::powers();
        let executable = dir.join("powers-tool");
        let instance = ToolInstanceId::new("powers-1").unwrap();
        fs::write(&executable, r#"#!/bin/sh
set -eu
cd "$(dirname "$0")"
if [ "$*" = 'error --json --max-reads 1 --resource=USB::Saved Address --backend=@py' ]; then
    if [ -e first-read ]; then
        echo '{"schema_version":2,"command":{"name":"error"},"ok":false,"error":{"message":"Connection lost"}}'
        exit 3
    fi
    touch first-read
    echo '{"schema_version":2,"command":{"name":"error"},"ok":true,"execution":{"mode":"real","hardware_touched":true},"data":{"errors":["-100,\"Command error, channel 1\""],"read_count":1}}'
elif [ "$*" = 'error --json --max-reads 20 --simulate --resource=USB0::SIM::E36312A::INSTR' ]; then
    echo '{"schema_version":2,"command":{"name":"error"},"ok":true,"execution":{"mode":"simulate","hardware_touched":false},"data":{"errors":[],"read_count":1}}'
else
    echo 'Unexpected command arguments' >&2
    exit 2
fi
"#).unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let mut config = Config::default();
        config.set_executable_path(&tool, executable);
        config.set_live_backend(&instance, VisaBackend::Py);
        config.set_live_resource(&instance, "USB::Saved Address");
        let live =
            read_and_drain_errors(&dir, &config, &tool, &instance, ExecutionMode::Live).unwrap();
        let simulate =
            read_and_drain_errors(&dir, &config, &tool, &instance, ExecutionMode::Simulate)
                .unwrap();
        fs::remove_dir_all(dir).unwrap();
        assert_eq!(live.status, ErrorQueueStatus::Failed);
        assert_eq!(live.error.as_deref(), Some("Connection lost"));
        assert_eq!(
            live.entries,
            [ErrorQueueEntry {
                code: "-100".into(),
                message: "Command error, channel 1".into()
            }]
        );
        assert_eq!(simulate.status, ErrorQueueStatus::QueueEmpty);
    }
}
