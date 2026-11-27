use orchestrator_tool::{
    config::VisaBackend,
    discovery::{ExecutableStatus, built_in_tool_definitions, current_application_dir},
    run::ExecutionMode,
    tool::ToolId,
    tool_instance::ToolInstanceId,
    worker::WorkerLaunchSpec,
};
use serde::Serialize;
use tauri::{AppHandle, Manager};

use super::{
    ActiveRun, PowersWorkerConfig, RUN_ACTION_TIMEOUT, RUN_SHUTDOWN_TIMEOUT, RUN_STARTUP_TIMEOUT,
};
use crate::desktop_config::load_desktop_config;

fn powers_worker_spec(
    app: &AppHandle,
    instance_id: &str,
    execution_mode: ExecutionMode,
) -> Result<(WorkerLaunchSpec, VisaBackend), String> {
    let instance_id = ToolInstanceId::new(instance_id).map_err(|error| error.to_string())?;
    let application_dir = current_application_dir().map_err(|error| error.to_string())?;
    let config = load_desktop_config(app)?;
    let definition = built_in_tool_definitions()
        .into_iter()
        .find(|definition| definition.id() == &ToolId::powers())
        .expect("powers is built in");
    let inspection =
        orchestrator_tool::inspection::inspect_tool(&application_dir, &config, &definition)
            .map_err(|error| format!("powers executable inspection failed: {error}"))?;
    if inspection.status() != ExecutableStatus::Available {
        return Err("powers executable is unavailable".to_owned());
    }
    let executable = inspection
        .resolved()
        .path()
        .expect("available executable has a path");
    let spec = match execution_mode {
        ExecutionMode::Simulate => {
            orchestrator_tool::adapters::powers::simulate_worker_launch_spec(executable)
        }
        ExecutionMode::Live => {
            let resource = config
                .live_resources()
                .get(instance_id.as_str())
                .filter(|resource| !resource.trim().is_empty())
                .ok_or_else(|| format!("{instance_id} saved Live Resource is not configured"))?;
            orchestrator_tool::adapters::powers::live_worker_launch_spec(executable, resource)
        }
    };
    let manifest = orchestrator_tool::adapters::probe_existing_worker_integration(
        spec.executable(),
        &ToolId::powers(),
    )?;
    Ok((
        spec.with_manifest(manifest),
        if execution_mode == ExecutionMode::Live {
            config.live_backend(&instance_id)
        } else {
            VisaBackend::System
        },
    ))
}

fn finish_manual_powers_operation<T>(
    operation: Result<T, String>,
    shutdown: Result<std::process::ExitStatus, orchestrator_tool::worker::WorkerShutdownError>,
) -> Result<T, String> {
    match (operation, shutdown) {
        (Ok(value), Ok(status)) if status.success() => Ok(value),
        (Ok(_), Ok(status)) => Err(format!("Powers Worker exited with {status}")),
        (Ok(_), Err(error)) => Err(format!("Powers Worker shutdown failed: {error}")),
        (Err(error), Ok(_)) => Err(error),
        (Err(error), Err(shutdown)) => Err(format!(
            "{error}; Powers Worker shutdown also failed: {shutdown}"
        )),
    }
}

#[tauri::command]
pub(super) async fn refresh_powers_status(
    app: AppHandle,
    state: tauri::State<'_, ActiveRun>,
    instance_id: String,
    execution_mode: ExecutionMode,
) -> Result<orchestrator_tool::adapters::powers::PowersProtectionStatus, String> {
    state.register_manual()?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let (mut spec, backend) = powers_worker_spec(&app, &instance_id, execution_mode)?;
        let _worker_config = if execution_mode == ExecutionMode::Live && backend == VisaBackend::Py
        {
            let dir = app
                .path()
                .app_cache_dir()
                .map_err(|error| error.to_string())?;
            Some(PowersWorkerConfig::prepare(
                &dir, &mut spec, backend, false,
            )?)
        } else {
            None
        };
        let session = orchestrator_tool::worker::start_worker(&spec, RUN_STARTUP_TIMEOUT)
            .map_err(|error| format!("Powers Worker startup failed: {error}"))?;
        let operation = orchestrator_tool::adapters::powers::normalized_protection_status_all(
            &session,
            execution_mode,
            RUN_ACTION_TIMEOUT,
        )
        .map_err(|error| error.to_string());
        let shutdown = session.shutdown(RUN_SHUTDOWN_TIMEOUT);
        finish_manual_powers_operation(operation, shutdown)
    })
    .await
    .map_err(|error| error.to_string());
    state.clear();
    result?
}

#[derive(Serialize)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub(super) enum PowersClearResult {
    Simulate {
        outcome: &'static str,
        plan: serde_json::Value,
    },
    Live {
        outcome: &'static str,
        status: orchestrator_tool::adapters::powers::PowersProtectionStatus,
    },
}

#[tauri::command]
pub(super) async fn clear_powers_protection(
    app: AppHandle,
    state: tauri::State<'_, ActiveRun>,
    instance_id: String,
    channel: u32,
    execution_mode: ExecutionMode,
) -> Result<PowersClearResult, String> {
    if channel == 0 {
        return Err("Clear Protection channel must be a positive integer".to_owned());
    }
    state.register_manual()?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let (mut spec, backend) = powers_worker_spec(&app, &instance_id, execution_mode)?;
        let _authorization = if execution_mode == ExecutionMode::Live {
            let dir = app
                .path()
                .app_cache_dir()
                .map_err(|error| error.to_string())?;
            Some(PowersWorkerConfig::prepare(&dir, &mut spec, backend, true)?)
        } else {
            None
        };
        let session = orchestrator_tool::worker::start_worker(&spec, RUN_STARTUP_TIMEOUT)
            .map_err(|error| format!("Powers Worker startup failed: {error}"))?;
        let operation = (|| {
            orchestrator_tool::adapters::powers::safe_off_all(
                &session,
                execution_mode,
                RUN_ACTION_TIMEOUT,
            )
            .map_err(|error| format!("Safe-Off All failed: {error}"))?;
            let clear_result = orchestrator_tool::adapters::powers::clear_protection(
                &session,
                channel,
                execution_mode,
                RUN_ACTION_TIMEOUT,
            )
            .map_err(|error| error.to_string())?;
            match execution_mode {
                ExecutionMode::Simulate => Ok(PowersClearResult::Simulate {
                    outcome: "planned",
                    plan: clear_result,
                }),
                ExecutionMode::Live => {
                    orchestrator_tool::adapters::powers::normalized_protection_status_all(
                        &session,
                        execution_mode,
                        RUN_ACTION_TIMEOUT,
                    )
                    .map(|status| PowersClearResult::Live {
                        outcome: "completed",
                        status,
                    })
                    .map_err(|error| error.to_string())
                }
            }
        })();
        let shutdown = session.shutdown(RUN_SHUTDOWN_TIMEOUT);
        finish_manual_powers_operation(operation, shutdown)
    })
    .await
    .map_err(|error| error.to_string());
    state.clear();
    result?
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    #[test]
    fn powers_clear_result_distinguishes_planned_simulation_from_completed_live() {
        let simulated = serde_json::to_value(super::PowersClearResult::Simulate {
            outcome: "planned",
            plan: json!({"execution":{"hardware_touched":false},"data":{"plan":[]}}),
        })
        .unwrap();
        assert_eq!(simulated["mode"], "simulate");
        assert_eq!(simulated["outcome"], "planned");
        assert_eq!(simulated["plan"]["execution"]["hardware_touched"], false);

        let live = serde_json::to_value(super::PowersClearResult::Live {
            outcome: "completed",
            status: orchestrator_tool::adapters::powers::PowersProtectionStatus {
                protection_tripped: false,
                over_voltage_tripped: false,
                over_current_tripped: false,
                channels: Vec::new(),
            },
        })
        .unwrap();
        assert_eq!(live["mode"], "live");
        assert_eq!(live["outcome"], "completed");
    }
}
