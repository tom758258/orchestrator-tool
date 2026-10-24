//! Tool-specific adapters built on the Common Worker protocol.

pub mod meters;
pub mod powers;
pub mod scopes;

/// Current domain adapter requirements, separate from the Common v3 parser.
/// A new Tool registers its own thin adapter; no Common parser branch changes.
pub fn validate_existing_worker_integration(
    tool: &crate::tool::ToolId,
    manifest: &crate::manifest::ToolManifest,
) -> Result<(), String> {
    let (model, binding, async_jobs) = match tool.as_str() {
        "meters" => ("run_bound", "startup", false),
        "powers" => ("multi_job", "per_command", true),
        "scopes" => ("multi_job", "startup", true),
        other => return Err(format!("no existing domain adapter for {other}")),
    };
    if manifest.execution_model() != Some(model) || manifest.context_binding() != Some(binding) {
        return Err(format!(
            "{} execution model or context binding incompatible",
            tool
        ));
    }
    if async_jobs && manifest.feature("common.async_jobs").is_none() {
        return Err(format!("{} requires common.async_jobs version 1", tool));
    }
    if tool.as_str() == "meters"
        && manifest
            .command_kind("software_trigger")
            .is_some_and(|kind| kind != "control")
    {
        return Err("Meters software_trigger must be a control command".into());
    }
    Ok(())
}

/// Validate the selected Tool executable before managed Worker startup.
pub fn probe_existing_worker_integration(
    executable: &std::path::Path,
    tool: &crate::tool::ToolId,
) -> Result<crate::manifest::ToolManifest, String> {
    let probe = crate::manifest_probe::probe_manifest(executable, tool)
        .map_err(|error| format!("{tool} Manifest preflight failed: {error}"))?;
    let manifest = probe.manifest();
    if manifest.worker_compatibility() != crate::manifest::WorkerCompatibility::Compatible {
        return Err(format!("{tool} Worker protocol is incompatible"));
    }
    validate_existing_worker_integration(tool, manifest)?;
    Ok(manifest.clone())
}

#[cfg(test)]
mod tests {
    use super::{meters, powers, probe_existing_worker_integration};
    use crate::tool::ToolId;
    use serde_json::{Value, json};
    use std::{
        fs,
        path::{Path, PathBuf},
        time::{Duration, SystemTime, UNIX_EPOCH},
    };

    fn fake_executable(dir: &Path, name: &str, manifest: &Value, marker: &Path) -> PathBuf {
        #[cfg(windows)]
        {
            let path = dir.join(format!("{name}.cmd"));
            fs::write(
                &path,
                format!(
                    "@echo off\r\nif \"%1\"==\"manifest\" (\r\n echo {manifest}\r\n exit /b 0\r\n)\r\necho started>\"{}\"\r\nexit /b 1\r\n",
                    marker.display()
                ),
            )
            .unwrap();
            path
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = dir.join(name);
            fs::write(
                &path,
                format!(
                    "#!/bin/sh\nif [ \"$1\" = manifest ]; then printf '%s\\n' '{manifest}'; exit 0; fi\nprintf started > '{}'\nexit 1\n",
                    marker.display()
                ),
            )
            .unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            path
        }
    }

    #[test]
    fn smoke_preflight_rejects_incompatible_executables_without_starting_workers() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "orchestrator-v3-smoke-preflight-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir(&dir).unwrap();
        let valid = json!({
            "event":"tool_manifest", "schema_version":2, "tool_id":"powers",
            "tool_version":"1.0", "worker_protocol":{
                "compatibility_policy":"v3-only", "schema_versions":[3]
            },
            "execution":{"model":"multi_job", "context_binding":"per_command"},
            "features":{"common.async_jobs":{"contract_version":1}}
        });
        let valid_marker = dir.join("valid-started");
        let valid_exe = fake_executable(&dir, "valid-powers", &valid, &valid_marker);
        assert!(probe_existing_worker_integration(&valid_exe, &ToolId::powers()).is_ok());
        assert!(!valid_marker.exists());

        let mut v2 = valid.clone();
        v2["worker_protocol"] = json!({
            "compatibility_policy":"v2-only", "schema_versions":[2]
        });
        let mut missing_async = valid.clone();
        missing_async["features"] = json!({});
        let mut wrong_tool = valid.clone();
        wrong_tool["tool_id"] = json!("meters");
        let mut wrong_meters_binding = valid;
        wrong_meters_binding["tool_id"] = json!("meters");
        wrong_meters_binding["execution"] = json!({
            "model":"run_bound", "context_binding":"per_command"
        });
        wrong_meters_binding["features"] = json!({});

        for (name, tool, manifest) in [
            ("v2-powers", "powers", v2),
            ("missing-async-powers", "powers", missing_async),
            ("wrong-tool-powers", "powers", wrong_tool),
            ("wrong-binding-meters", "meters", wrong_meters_binding),
        ] {
            let marker = dir.join(format!("{name}-started"));
            let exe = fake_executable(&dir, name, &manifest, &marker);
            let result = if tool == "powers" {
                powers::run_worker_smoke(
                    &exe,
                    Duration::from_secs(2),
                    Duration::from_secs(2),
                    Duration::from_secs(2),
                )
                .map_err(|error| error.to_string())
            } else {
                meters::run_worker_smoke(
                    &exe,
                    Duration::from_secs(2),
                    Duration::from_secs(2),
                    Duration::from_secs(2),
                )
                .map_err(|error| error.to_string())
            };
            assert!(result.is_err(), "{name} must fail before Worker startup");
            assert!(!marker.exists(), "{name} unexpectedly started a Worker");
        }
        fs::remove_dir_all(dir).unwrap();
    }
}
