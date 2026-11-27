use std::path::{Path, PathBuf};

use orchestrator_tool::{
    config::{Config, ConfigError, ResourceIdentity, VisaBackend},
    discovery::built_in_tool_definitions,
    tool::ToolId,
    tool_instance::ToolInstanceId,
};
use tauri::{AppHandle, Manager};

const DESKTOP_CONFIG_FILENAME: &str = "orchestrator.toml";

/// Returns the persisted Desktop configuration file path.
fn desktop_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("could not determine application config directory: {error}"))?;

    Ok(dir.join(DESKTOP_CONFIG_FILENAME))
}

/// Loads the persisted Desktop configuration.
///
/// A missing file leaves tools unconfigured; any other load failure is
/// reported instead of being silently ignored.
pub(super) fn load_desktop_config(app: &AppHandle) -> Result<Config, String> {
    let path = desktop_config_path(app)?;

    load_desktop_config_from_path(&path)
}

fn load_desktop_config_from_path(path: &Path) -> Result<Config, String> {
    match Config::load(path) {
        Ok(config) => Ok(config),
        Err(ConfigError::Read { source, .. }) if source.kind() == std::io::ErrorKind::NotFound => {
            Ok(Config::default())
        }
        Err(error) => Err(error.to_string()),
    }
}

/// Validates a caller-supplied tool ID against the built-in registry.
pub(super) fn resolve_built_in_tool_id(raw_tool_id: &str) -> Result<ToolId, String> {
    let tool_id = ToolId::new(raw_tool_id)
        .map_err(|error| format!("invalid tool ID {raw_tool_id:?}: {error}"))?;

    if built_in_tool_definitions()
        .iter()
        .any(|definition| definition.id() == &tool_id)
    {
        Ok(tool_id)
    } else {
        Err(format!("unknown tool ID {raw_tool_id:?}"))
    }
}

fn set_desktop_tool_executable(
    config_path: &Path,
    tool_id: &ToolId,
    executable_path: &Path,
) -> Result<(), String> {
    let executable_path =
        std::path::absolute(executable_path).map_err(|error| error.to_string())?;
    let probe = orchestrator_tool::manifest_probe::probe_manifest(&executable_path, tool_id)
        .map_err(|error| error.to_string())?;
    if probe.manifest().worker_compatibility()
        != orchestrator_tool::manifest::WorkerCompatibility::Compatible
    {
        return Err(format!("{tool_id} Worker protocol is incompatible"));
    }
    let mut config = load_desktop_config_from_path(config_path)?;
    config.set_executable_path(tool_id, executable_path);
    config.save(config_path).map_err(|error| error.to_string())
}

fn reset_desktop_tool_executable(config_path: &Path, tool_id: &ToolId) -> Result<(), String> {
    let mut config = load_desktop_config_from_path(config_path)?;
    config.remove_executable_path(tool_id);
    config.save(config_path).map_err(|error| error.to_string())
}

#[tauri::command]
pub(super) async fn set_tool_executable(
    app: AppHandle,
    tool_id: String,
    path: String,
) -> Result<(), String> {
    let tool_id = resolve_built_in_tool_id(&tool_id)?;
    let config_path = desktop_config_path(&app)?;

    tauri::async_runtime::spawn_blocking(move || {
        set_desktop_tool_executable(&config_path, &tool_id, Path::new(&path))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(super) fn reset_tool_executable(app: AppHandle, tool_id: String) -> Result<(), String> {
    let tool_id = resolve_built_in_tool_id(&tool_id)?;
    let config_path = desktop_config_path(&app)?;

    reset_desktop_tool_executable(&config_path, &tool_id)
}

fn edit_desktop_live_resource(
    config_path: &Path,
    raw_instance_id: &str,
    resource: Option<&str>,
    identity: Option<ResourceIdentity>,
    backend: Option<VisaBackend>,
) -> Result<(), String> {
    let instance_id = ToolInstanceId::new(raw_instance_id).map_err(|error| error.to_string())?;
    if resource.is_some_and(|value| value.trim().is_empty()) {
        return Err(format!("{instance_id} live resource must not be blank"));
    }
    let mut config = load_desktop_config_from_path(config_path)?;
    if let Some(backend) = backend {
        config.set_live_backend(&instance_id, backend);
    }
    match resource {
        Some(value) => config.set_live_resource_with_identity(&instance_id, value, identity),
        None => {
            config.remove_live_resource(&instance_id);
        }
    }
    config.save(config_path).map_err(|error| error.to_string())
}

#[tauri::command]
pub(super) fn get_live_resources(
    app: AppHandle,
) -> Result<std::collections::BTreeMap<String, String>, String> {
    Ok(load_desktop_config(&app)?.live_resources().clone())
}

#[tauri::command]
pub(super) fn get_live_backends(
    app: AppHandle,
) -> Result<std::collections::BTreeMap<String, VisaBackend>, String> {
    Ok(load_desktop_config(&app)?.live_backends().clone())
}

#[tauri::command]
pub(super) fn get_live_resource_identities(
    app: AppHandle,
) -> Result<std::collections::BTreeMap<String, ResourceIdentity>, String> {
    Ok(load_desktop_config(&app)?
        .live_resource_identities()
        .clone())
}

#[tauri::command]
pub(super) fn set_live_resource(
    app: AppHandle,
    instance_id: String,
    resource: String,
    identity: Option<ResourceIdentity>,
    backend: VisaBackend,
) -> Result<(), String> {
    edit_desktop_live_resource(
        &desktop_config_path(&app)?,
        &instance_id,
        Some(&resource),
        identity,
        Some(backend),
    )
}

#[tauri::command]
pub(super) fn remove_live_resource(app: AppHandle, instance_id: String) -> Result<(), String> {
    edit_desktop_live_resource(&desktop_config_path(&app)?, &instance_id, None, None, None)
}

#[cfg(test)]
mod tests {
    use super::{
        load_desktop_config_from_path, reset_desktop_tool_executable, resolve_built_in_tool_id,
        set_desktop_tool_executable,
    };
    use crate::unique_test_dir;
    use orchestrator_tool::config::VisaBackend;
    use orchestrator_tool::tool::ToolId;
    use orchestrator_tool::tool_instance::ToolInstanceId;

    #[test]
    fn desktop_live_resources_preserve_exact_values_and_reject_blank_edits() {
        let dir = unique_test_dir("orchestrator-live-resource-test");
        let path = dir.join("orchestrator.toml");
        let powers = " USB0::Power Serial::INSTR ";
        let meters = " TCPIP0::MeterHost::inst0::INSTR ";
        super::edit_desktop_live_resource(
            &path,
            "powers-1",
            Some(powers),
            None,
            Some(VisaBackend::Py),
        )
        .unwrap();
        super::edit_desktop_live_resource(
            &path,
            "meters-1",
            Some(meters),
            None,
            Some(VisaBackend::System),
        )
        .unwrap();
        let loaded = load_desktop_config_from_path(&path).unwrap();
        assert_eq!(
            loaded.live_resource(&ToolInstanceId::new("powers-1").unwrap()),
            Some(powers)
        );
        assert_eq!(
            loaded.live_resource(&ToolInstanceId::new("meters-1").unwrap()),
            Some(meters)
        );
        for resource in ["", " ", "\t\r\n"] {
            assert!(
                super::edit_desktop_live_resource(
                    &path,
                    "powers-1",
                    Some(resource),
                    None,
                    Some(VisaBackend::System)
                )
                .is_err()
            );
        }
        assert_eq!(load_desktop_config_from_path(&path).unwrap(), loaded);
        assert_eq!(
            loaded.live_backend(&ToolInstanceId::new("powers-1").unwrap()),
            VisaBackend::Py
        );
        super::edit_desktop_live_resource(&path, "powers-1", None, None, None).unwrap();
        assert_eq!(
            load_desktop_config_from_path(&path)
                .unwrap()
                .live_resource(&ToolInstanceId::new("powers-1").unwrap()),
            None
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn manifest_fixture(
        dir: &std::path::Path,
        tool: &str,
        worker_version: u32,
    ) -> std::path::PathBuf {
        let is_meters = tool == "meters";
        let manifest = serde_json::json!({
            "event": "tool_manifest", "schema_version": 2, "tool_id": tool,
            "tool_version": "1.0.0", "worker_protocol": {
                "schema_versions": [worker_version], "compatibility_policy": "v3-only"
            },
            "execution":{"model": if is_meters {"run_bound"} else {"multi_job"},
                "context_binding": if is_meters {"startup"} else {"per_command"}},
            "features": if is_meters {
                serde_json::json!({})
            } else {
                serde_json::json!({"common.async_jobs":{"contract_version":1}})
            }
        });
        #[cfg(windows)]
        {
            let path = dir.join(format!("{tool}-{worker_version}.cmd"));
            std::fs::write(&path, format!("@echo off\r\necho {manifest}\r\n")).unwrap();
            path
        }
        #[cfg(not(windows))]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = dir.join(format!("{tool}-{worker_version}"));
            std::fs::write(&path, format!("#!/bin/sh\nprintf '%s\\n' '{manifest}'\n")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        }
    }

    #[test]
    fn desktop_tool_config_set_load_reset_round_trip() {
        let dir = unique_test_dir("orchestrator-tool-desktop-config-test");
        let config_path = dir.join("orchestrator.toml");
        let meters_exe = manifest_fixture(&dir, "meters", 3);
        let powers_exe = manifest_fixture(&dir, "powers", 3);
        assert_eq!(
            load_desktop_config_from_path(&config_path)
                .unwrap()
                .executable_path(&ToolId::meters()),
            None
        );
        set_desktop_tool_executable(&config_path, &ToolId::meters(), &meters_exe).unwrap();
        set_desktop_tool_executable(&config_path, &ToolId::powers(), &powers_exe).unwrap();
        let config = load_desktop_config_from_path(&config_path).unwrap();
        assert_eq!(
            config.executable_path(&ToolId::meters()),
            Some(meters_exe.as_path())
        );
        assert_eq!(
            config.executable_path(&ToolId::powers()),
            Some(powers_exe.as_path())
        );
        let saved = std::fs::read(&config_path).unwrap();
        for rejected in [
            dir.join("missing.exe"),
            powers_exe.clone(),
            manifest_fixture(&dir, "meters", 99),
        ] {
            assert!(
                set_desktop_tool_executable(&config_path, &ToolId::meters(), &rejected).is_err()
            );
            assert_eq!(std::fs::read(&config_path).unwrap(), saved);
        }
        reset_desktop_tool_executable(&config_path, &ToolId::meters()).unwrap();
        let config = load_desktop_config_from_path(&config_path).unwrap();
        assert_eq!(config.executable_path(&ToolId::meters()), None);
        assert_eq!(
            config.executable_path(&ToolId::powers()),
            Some(powers_exe.as_path())
        );
        assert_eq!(
            resolve_built_in_tool_id("meters").unwrap(),
            ToolId::meters()
        );
        assert!(resolve_built_in_tool_id("foobar").is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
