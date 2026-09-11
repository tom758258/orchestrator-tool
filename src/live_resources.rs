//! On-demand resource discovery through the supported external tools.

use std::{path::Path, time::Duration};

use serde::Serialize;
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

/// Discovery-time resource address and device presentation metadata.
#[derive(Debug, Serialize)]
pub struct LiveResourceCandidate {
    pub resource: String,
    pub manufacturer: Option<String>,
    pub model: Option<String>,
    pub serial: Option<String>,
    pub identity: Option<String>,
}

/// Lists live resources without changing configuration or selecting a resource.
pub fn list_live_resources(
    application_dir: &Path,
    config: &Config,
    tool: &ToolId,
) -> Result<Vec<LiveResourceCandidate>, String> {
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
        if tool == &ToolId::powers() {
            let detail = powers_error_detail(&output.stdout).or_else(|| {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
                (!stderr.is_empty()).then_some(stderr)
            });
            return Err(match detail {
                Some(detail) => format!("{tool} resource discovery failed: {detail}"),
                None => format!("{tool} resource discovery failed with {}", output.status),
            });
        }
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

fn parse_resources(tool: &ToolId, stdout: &[u8]) -> Result<Vec<LiveResourceCandidate>, String> {
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
            let resource = row[field]
                .as_str()
                .filter(|value| !value.trim().is_empty())
                .map(str::to_owned)
                .ok_or_else(|| {
                    format!(
                        "{tool} resource discovery item {index} has no non-empty {field} string"
                    )
                })?;
            let mut candidate = LiveResourceCandidate {
                resource,
                manufacturer: None,
                model: None,
                serial: None,
                identity: None,
            };
            if tool == &ToolId::meters() {
                candidate.identity = row["detail"].as_str().map(str::to_owned);
                parse_meters_identity(&mut candidate);
            } else {
                let idn = &row["idn"];
                candidate.manufacturer = idn["manufacturer"].as_str().map(str::to_owned);
                candidate.model = idn["model"].as_str().map(str::to_owned);
                candidate.serial = idn["serial"].as_str().map(str::to_owned);
                candidate.identity = idn["raw"].as_str().map(str::to_owned);
            }
            Ok(candidate)
        })
        .collect()
}

fn parse_meters_identity(candidate: &mut LiveResourceCandidate) {
    let Some(identity) = candidate.identity.as_deref() else {
        return;
    };
    let fields: Vec<_> = identity.split(',').map(str::trim).collect();
    if let [manufacturer, model, serial, _firmware] = fields.as_slice()
        && !manufacturer.is_empty()
        && !model.is_empty()
    {
        candidate.manufacturer = Some((*manufacturer).to_owned());
        candidate.model = Some((*model).to_owned());
        candidate.serial = (!serial.is_empty()).then(|| (*serial).to_owned());
    }
}

fn powers_error_detail(stdout: &[u8]) -> Option<String> {
    let response: Value = serde_json::from_slice(stdout).ok()?;
    if response["schema_version"].as_u64() != Some(2)
        || response["ok"] != false
        || response["status"] != "error"
        || response["command"]["name"] != "list-resources"
    {
        return None;
    }
    let code = response["error"]["code"].as_str()?.trim();
    let message = response["error"]["message"].as_str()?.trim();
    if code.is_empty() || message.is_empty() {
        return None;
    }
    Some(format!("{code}: {message}"))
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
                parse_resources(&tool, value.to_string().as_bytes()).unwrap()[0].resource,
                expected
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
    fn powers_preserves_identity_without_supported_model_metadata() {
        let mut value = response(&ToolId::powers());
        value["data"]["resources"] = json!([{
            "name": "USB0::POWER::INSTR", "reachable": true,
            "vendor_id": null, "model_id": null,
            "idn": {"manufacturer": "KEYSIGHT", "model": "E36312A",
                "serial": "MY123", "raw": "KEYSIGHT,E36312A,MY123,1.0",
                "firmware": "1.0", "future_field": true}
        }]);
        let candidates = parse_resources(&ToolId::powers(), value.to_string().as_bytes()).unwrap();
        assert_eq!(candidates.len(), 1);
        let candidate = &candidates[0];
        assert_eq!(candidate.resource, "USB0::POWER::INSTR");
        assert_eq!(candidate.manufacturer.as_deref(), Some("KEYSIGHT"));
        assert_eq!(candidate.model.as_deref(), Some("E36312A"));
        assert_eq!(candidate.serial.as_deref(), Some("MY123"));
        assert_eq!(
            candidate.identity.as_deref(),
            Some("KEYSIGHT,E36312A,MY123,1.0")
        );

        value["data"]["resources"][0]["idn"] = Value::Null;
        let candidates = parse_resources(&ToolId::powers(), value.to_string().as_bytes()).unwrap();
        assert_eq!(candidates[0].resource, "USB0::POWER::INSTR");
        assert!(candidates[0].manufacturer.is_none());
        assert!(candidates[0].model.is_none());
        assert!(candidates[0].serial.is_none());
        assert!(candidates[0].identity.is_none());
    }

    #[test]
    fn meters_parses_trimmed_identity_and_optional_serial() {
        for (identity, serial) in [
            ("Keysight Technologies,34461A,MY456,1.0", Some("MY456")),
            (
                " Keysight Technologies , 34461A , MY456 , 1.0 ",
                Some("MY456"),
            ),
            ("Keysight Technologies,34461A,,1.0", None),
        ] {
            let mut value = response(&ToolId::meters());
            value["resources"][0]["resource"] = json!("USB0::METER::INSTR");
            value["resources"][0]["detail"] = json!(identity);
            let candidates =
                parse_resources(&ToolId::meters(), value.to_string().as_bytes()).unwrap();
            let candidate = &candidates[0];
            assert_eq!(candidate.resource, "USB0::METER::INSTR");
            assert_eq!(
                candidate.manufacturer.as_deref(),
                Some("Keysight Technologies")
            );
            assert_eq!(candidate.model.as_deref(), Some("34461A"));
            assert_eq!(candidate.serial.as_deref(), serial);
            assert_eq!(candidate.identity.as_deref(), Some(identity));
        }
    }

    #[test]
    fn malformed_meters_identity_preserves_resource_and_raw_detail() {
        for identity in [
            "unexpected identity",
            "",
            ",34461A,MY456,1.0",
            "Keysight, ,MY456,1.0",
            "Keysight,34461A",
            "A,B,C,D,E",
        ] {
            let mut value = response(&ToolId::meters());
            value["resources"][0]["detail"] = json!(identity);
            let candidates =
                parse_resources(&ToolId::meters(), value.to_string().as_bytes()).unwrap();
            let candidate = &candidates[0];
            assert_eq!(candidate.resource, " USB0::Meter Serial::INSTR ");
            assert_eq!(candidate.identity.as_deref(), Some(identity));
            assert!(candidate.manufacturer.is_none());
            assert!(candidate.model.is_none());
            assert!(candidate.serial.is_none());
        }
    }

    #[test]
    fn powers_structured_error_extracts_code_and_message() {
        let mut value = json!({"schema_version": 2, "ok": false, "status": "error",
            "command": {"name": "list-resources"}, "data": null,
            "error": {"type": "connection", "code": "resource_list_failed",
                "message": "Could not list VISA resources: backend unavailable", "retryable": true},
            "future_field": true});
        assert_eq!(
            powers_error_detail(value.to_string().as_bytes()).as_deref(),
            Some("resource_list_failed: Could not list VISA resources: backend unavailable")
        );
        for invalid in [Value::Null, json!(" "), json!(42)] {
            value["error"]["message"] = invalid;
            assert!(powers_error_detail(value.to_string().as_bytes()).is_none());
        }
        for bytes in [b"not json".as_slice(), b"{}", b""] {
            assert!(powers_error_detail(bytes).is_none());
        }
        assert!(powers_error_detail(response(&ToolId::powers()).to_string().as_bytes()).is_none());
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
