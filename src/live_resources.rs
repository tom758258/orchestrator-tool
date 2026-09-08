//! On-demand resource discovery through the supported external tools.

use std::{path::Path, time::Duration};

use serde_json::Value;

use crate::{
    config::Config,
    discovery::{ExecutableStatus, built_in_tool_definitions},
    inspection::inspect_tool,
    manifest::WorkerCompatibility,
    manifest_probe::probe_manifest,
    process::{CaptureError, run_output_with_timeout},
    tool::ToolId,
};

/// Lists live resources without changing configuration or selecting a resource.
pub fn list_live_resources(
    application_dir: &Path,
    config: &Config,
    tool: &ToolId,
) -> Result<Vec<String>, String> {
    resource_field(tool)?;
    let definition = built_in_tool_definitions()
        .into_iter()
        .find(|definition| definition.id() == tool)
        .expect("supported discovery tool is built in");
    let inspection = inspect_tool(application_dir, config, &definition)
        .map_err(|error| format!("{tool} executable inspection failed: {error}"))?;
    let executable = inspection.resolved().path();
    match inspection.status() {
        ExecutableStatus::Available => {}
        status => {
            let reason = match status {
                ExecutableStatus::Missing => "missing",
                _ => "not a file",
            };
            return Err(format!(
                "{tool} executable is {reason}: {}",
                executable.display()
            ));
        }
    }
    let probe = probe_manifest(executable, tool)
        .map_err(|error| format!("{tool} manifest probe failed: {error}"))?;
    if probe.manifest().worker_compatibility() != WorkerCompatibility::Compatible {
        return Err(format!("{tool} Worker protocol is incompatible"));
    }
    let output = run_output_with_timeout(
        executable,
        ["list-resources", "--live-only", "--json"],
        Duration::from_secs(60),
    )
    .map_err(|error| match error {
        CaptureError::Io(error) => format!("{tool} resource discovery failed: {error}"),
        CaptureError::Timeout => format!("{tool} resource discovery timed out after 60 seconds"),
    })?;
    if !output.status.success() {
        return Err(format!(
            "{tool} resource discovery failed with {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    parse_resources(tool, &output.stdout)
}

fn resource_field(tool: &ToolId) -> Result<&'static str, String> {
    match tool.as_str() {
        "meters" => Ok("resource"),
        "powers" => Ok("name"),
        _ => Err(format!("{tool} live resource discovery is not supported")),
    }
}

fn parse_resources(tool: &ToolId, stdout: &[u8]) -> Result<Vec<String>, String> {
    let field = resource_field(tool)?;
    let response: Value = serde_json::from_slice(stdout)
        .map_err(|error| format!("{tool} resource discovery returned invalid JSON: {error}"))?;
    let unexpected =
        || format!("{tool} resource discovery returned an unexpected list-resources success shape");
    if response["schema_version"].as_u64() != Some(2) {
        return Err(unexpected());
    }
    // Meters uses a discovery event; Powers uses its CLI success envelope.
    let resources = if tool == &ToolId::meters() {
        if response["event"] != "list-resources"
            || response["live_only"] != true
            || response["verify"] != true
        {
            return Err(unexpected());
        }
        &response["resources"]
    } else {
        if response["ok"] != true
            || response["status"] != "ok"
            || response["command"]["name"] != "list-resources"
        {
            return Err(unexpected());
        }
        &response["data"]["resources"]
    };
    resources
        .as_array()
        .ok_or_else(unexpected)?
        .iter()
        .enumerate()
        .map(|(index, row)| {
            row[field]
                .as_str()
                .filter(|value| !value.trim().is_empty())
                .map(str::to_owned)
                .ok_or_else(|| {
                    format!(
                        "{tool} resource discovery item {index} has no non-empty {field} string"
                    )
                })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn response(tool: &ToolId) -> Value {
        if tool == &ToolId::meters() {
            json!({"schema_version": 2, "event": "list-resources", "verify": true,
                "live_only": true, "resources": [{"resource": " USB0::Meter Serial::INSTR ",
                "live": true, "status": "live", "detail": "meter"}], "diagnostic_hints": []})
        } else {
            json!({"schema_version": 2, "ok": true, "status": "ok",
                "command": {"name": "list-resources"}, "data": {"resources": [
                {"name": " USB0::Power Serial::INSTR ", "reachable": true}], "count": 1},
                "warnings": [], "error": null})
        }
    }

    #[test]
    fn tool_contracts_preserve_exact_addresses_and_accept_additive_fields() {
        for (tool, expected) in [
            (ToolId::meters(), " USB0::Meter Serial::INSTR "),
            (ToolId::powers(), " USB0::Power Serial::INSTR "),
        ] {
            let mut value = response(&tool);
            value["future_field"] = json!({"anything": true});
            assert_eq!(
                parse_resources(&tool, value.to_string().as_bytes()).unwrap(),
                [expected]
            );
            let rows = if tool == ToolId::meters() {
                &mut value["resources"]
            } else {
                &mut value["data"]["resources"]
            };
            *rows = json!([]);
            assert!(
                parse_resources(&tool, value.to_string().as_bytes())
                    .unwrap()
                    .is_empty()
            );
        }
    }

    #[test]
    fn malformed_and_unexpected_responses_are_rejected() {
        for tool in [ToolId::meters(), ToolId::powers()] {
            for bytes in [b"not json".as_slice(), b"{}", b"[]"] {
                assert!(parse_resources(&tool, bytes).is_err());
            }
            for invalid in [
                Value::Null,
                json!({}),
                json!([{}]),
                json!([{"resource": "", "name": " \t"}]),
            ] {
                let mut value = response(&tool);
                if tool == ToolId::meters() {
                    value["resources"] = invalid;
                } else {
                    value["data"]["resources"] = invalid;
                }
                assert!(parse_resources(&tool, value.to_string().as_bytes()).is_err());
            }
            for (field, invalid) in [
                ("schema_version", json!(2.0)),
                ("schema_version", json!(1)),
                (
                    if tool == ToolId::meters() {
                        "event"
                    } else {
                        "ok"
                    },
                    json!(false),
                ),
            ] {
                let mut value = response(&tool);
                value[field] = invalid;
                assert!(parse_resources(&tool, value.to_string().as_bytes()).is_err());
            }
        }
    }

    #[test]
    fn unsupported_tools_are_rejected_before_inspection() {
        for tool in [
            ToolId::scopes(),
            ToolId::wavegen(),
            ToolId::new("unknown").unwrap(),
        ] {
            assert!(
                list_live_resources(Path::new("unused"), &Config::default(), &tool)
                    .unwrap_err()
                    .contains("not supported")
            );
        }
    }
}
