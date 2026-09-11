//! Pre-run validation and per-instance Worker launch preparation.
use crate::{
    adapters::{meters, powers},
    config::Config,
    discovery::{ExecutableStatus, built_in_tool_definitions},
    inspection::inspect_tool,
    manifest::WorkerCompatibility,
    manifest_probe::probe_manifest,
    run::ExecutionMode,
    template::Template,
    tool_instance::ToolInstanceId,
    worker::WorkerLaunchSpec,
    workflow::StepKind,
};
use std::{collections::HashMap, path::Path};

/// Checks that every selected resource still matches the operator confirmation.
pub fn validate_confirmed_live_resources(
    template: &Template,
    config: &Config,
    confirmed_resources: &HashMap<String, String>,
) -> Result<(), String> {
    for instance in template.referenced_tool_instances() {
        if !matches!(instance.tool.as_str(), "powers" | "meters") {
            return Err(format!(
                "unsupported tool {} for instance {}",
                instance.tool, instance.id
            ));
        }
        let current = config.live_resource(&instance.id);
        let confirmed = confirmed_resources
            .get(instance.id.as_str())
            .map(String::as_str);
        if confirmed.is_none_or(|resource| resource.trim().is_empty())
            || current.is_none_or(|resource| resource.trim().is_empty())
            || confirmed != current
        {
            return Err(format!(
                "{} ({}) live resource changed after confirmation; confirm the live run again",
                instance.id, instance.tool
            ));
        }
    }
    Ok(())
}

pub fn prepare_worker_launch_specs(
    template: &Template,
    execution_mode: ExecutionMode,
    application_dir: &Path,
    config: &Config,
) -> Result<HashMap<ToolInstanceId, WorkerLaunchSpec>, String> {
    let definitions = built_in_tool_definitions();
    let mut launch_specs = HashMap::new();
    let instances = template.referenced_tool_instances();
    for instance in &instances {
        if !matches!(instance.tool.as_str(), "powers" | "meters") {
            return Err(format!(
                "unsupported tool {} for instance {}",
                instance.tool, instance.id
            ));
        }
    }
    if execution_mode == ExecutionMode::Live {
        for instance in &instances {
            if config
                .live_resource(&instance.id)
                .is_none_or(|resource| resource.trim().is_empty())
            {
                return Err(format!(
                    "{} ({}) live resource is not configured",
                    instance.id, instance.tool
                ));
            }
        }
    }

    for instance in instances {
        let tool = &instance.tool;
        // Reserve capacity until orchestrator shutdown, separately for each instance.
        let meters_max_samples = template
            .workflow()
            .steps()
            .iter()
            .filter(|step| {
                matches!(step.kind(), StepKind::ToolAction { target, action, .. }
                if target == &instance.id && action.as_str() == "measure")
            })
            .count()
            + 1;
        let definition = definitions
            .iter()
            .find(|definition| definition.id() == tool)
            .expect("supported workflow tool must be built in");
        let inspection = inspect_tool(application_dir, config, definition)
            .map_err(|error| format!("{tool} executable inspection failed: {error}"))?;

        match inspection.status() {
            ExecutableStatus::Available => {}
            ExecutableStatus::Missing => {
                return Err(format!(
                    "{tool} executable is missing: {}",
                    inspection.resolved().path().display()
                ));
            }
            ExecutableStatus::NotFile => {
                return Err(format!(
                    "{tool} executable is not a file: {}",
                    inspection.resolved().path().display()
                ));
            }
        }

        let executable = inspection.resolved().path();
        let probe = probe_manifest(executable, tool)
            .map_err(|error| format!("{tool} manifest probe failed: {error}"))?;
        if probe.manifest().worker_compatibility() != WorkerCompatibility::Compatible {
            return Err(format!("{tool} Worker protocol is incompatible"));
        }

        let spec = match (execution_mode, tool.as_str()) {
            (ExecutionMode::Simulate, "powers") => powers::simulate_worker_launch_spec(executable),
            (ExecutionMode::Simulate, "meters") => meters::simulate_worker_launch_spec(
                executable,
                meters_max_samples,
                instance.meters_setup().expect("Meters setup was validated"),
            ),
            (ExecutionMode::Live, "powers") => powers::live_worker_launch_spec(
                executable,
                config
                    .live_resource(&instance.id)
                    .expect("live resources were validated"),
            ),
            (ExecutionMode::Live, "meters") => meters::live_worker_launch_spec(
                executable,
                config
                    .live_resource(&instance.id)
                    .expect("live resources were validated"),
                meters_max_samples,
                instance.meters_setup().expect("Meters setup was validated"),
            ),
            _ => unreachable!("referenced workflow tools are filtered"),
        };
        launch_specs.insert(instance.id.clone(), spec);
    }

    Ok(launch_specs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{template::Template, tool::ToolId, tool_instance::ToolSetup};
    use serde_json::json;
    #[test]
    fn confirmed_live_resources_require_exact_current_values() {
        let template = instance_template();
        let mut config = Config::default();
        let mut confirmed = std::collections::HashMap::new();
        for instance in template.referenced_tool_instances() {
            let resource = format!(" USB0::{}::INSTR ", instance.id);
            config.set_live_resource(&instance.id, resource.clone());
            confirmed.insert(instance.id.as_str().to_owned(), resource);
        }
        validate_confirmed_live_resources(&template, &config, &confirmed).unwrap();
        for instance in template.referenced_tool_instances() {
            for value in [None, Some(""), Some(" "), Some("USB0::Other::INSTR")] {
                let mut changed = confirmed.clone();
                match value {
                    Some(value) => {
                        changed.insert(instance.id.as_str().to_owned(), value.to_owned());
                    }
                    None => {
                        changed.remove(instance.id.as_str());
                    }
                }
                assert!(
                    validate_confirmed_live_resources(&template, &config, &changed)
                        .unwrap_err()
                        .contains(instance.id.as_str())
                );
            }
            let mut changed = config.clone();
            changed.remove_live_resource(&instance.id);
            assert!(validate_confirmed_live_resources(&template, &changed, &confirmed).is_err());
        }
    }

    #[test]
    fn meters_workflow_launch_uses_setup_and_reserves_capacity_after_three_measurements() {
        use super::{Config, ExecutionMode, prepare_worker_launch_specs};
        use std::{ffi::OsString, fs};
        let dir = unique_test_dir("orchestrator-meters-launch-test");
        let manifest = json!({
            "event": "tool_manifest", "schema_version": 2, "tool_id": "meters",
            "tool_version": "test", "worker_protocol": {
                "compatibility_policy": "exact", "schema_versions": [2]
            }
        });
        #[cfg(windows)]
        let executable = {
            let path = dir.join("meters-tool.cmd");
            fs::write(&path, format!("@echo off\r\necho {manifest}\r\n")).unwrap();
            path
        };
        #[cfg(unix)]
        let executable = {
            use std::os::unix::fs::PermissionsExt;
            let path = dir.join("meters-tool");
            fs::write(&path, format!("#!/bin/sh\nprintf '%s\\n' '{manifest}'\n")).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            path
        };
        let template = Template::from_json_str(&json!({
            "schema_version": 1, "tool_instances": [{"id": "meters-1", "tool": "meters", "setup": {
                "measurement": "voltage-dc", "range_mode": "manual", "manual_range": 10.0,
                "nplc": 1.0, "auto_zero": "once", "dcv_input_impedance": "ten-megohm",
                "current_terminal": null
            }}, {"id": "powers-1", "tool": "powers", "setup": {}}], "name": "Three measurements", "workflow": { "steps": [
                {"type": "tool-action", "id": "read-1", "target": "meters-1", "action": "measure", "arguments": {}},
                {"type": "wait", "id": "wait-1", "duration_ms": 0},
                {"type": "tool-action", "id": "read-2", "target": "meters-1", "action": "measure", "arguments": {}},
                {"type": "tool-action", "id": "other-1", "target": "meters-1", "action": "unsupported", "arguments": {}},
                {"type": "tool-action", "id": "read-3", "target": "meters-1", "action": "measure", "arguments": {}}
            ]}
        }).to_string()).unwrap();
        let resource = " USB0::Meter Serial::INSTR ";
        let mut config = Config::default();
        config.set_executable_path(&ToolId::meters(), &executable);
        config.set_live_resource(&ToolInstanceId::new("meters-1").unwrap(), resource);
        for mode in [ExecutionMode::Simulate, ExecutionMode::Live] {
            let mut setup = template.tool_instances().to_vec();
            if mode == ExecutionMode::Live {
                let meters = match &mut setup[0].setup {
                    ToolSetup::Meters(setup) => setup,
                    _ => unreachable!(),
                };
                meters.measurement = crate::meters_setup::MetersMeasurement::CurrentDc;
                meters.dcv_input_impedance = None;
                meters.current_terminal = Some(3);
            }
            let template = Template::new(
                template.name().to_owned(),
                setup,
                template.workflow().clone(),
            )
            .unwrap();
            let specs = prepare_worker_launch_specs(&template, mode, &dir, &config).unwrap();
            assert_eq!(specs.len(), 1);
            let args = specs[&ToolInstanceId::new("meters-1").unwrap()].arguments();
            let setup_args = super::meters::setup_arguments(
                template.tool_instances()[0].meters_setup().unwrap(),
            );
            assert!(args.ends_with(&setup_args));
            assert_eq!(args.iter().filter(|arg| *arg == "--measurement").count(), 1);
            assert!(
                args.windows(2)
                    .any(|pair| pair == ["--trigger-mode", "software"])
            );
            assert!(
                args.windows(2)
                    .any(|pair| pair == [OsString::from("--max-samples"), OsString::from("4")])
            );
            let expected_resource = if mode == ExecutionMode::Live {
                resource
            } else {
                "SIM::34461A"
            };
            assert!(args.windows(2).any(|pair| pair
                == [
                    OsString::from("--resource"),
                    OsString::from(expected_resource)
                ]));
            assert_eq!(
                args.contains(&OsString::from("--simulate")),
                mode == ExecutionMode::Simulate
            );
        }
        let multi = instance_template();
        let workflow =
            crate::workflow::Workflow::new(multi.workflow().steps()[..2].to_vec()).unwrap();
        let multi = Template::new(
            "Two Meters".to_owned(),
            multi.tool_instances().to_vec(),
            workflow,
        )
        .unwrap();
        config.set_live_resource(
            &ToolInstanceId::new("meters-2").unwrap(),
            "USB0::Second::INSTR",
        );
        for mode in [ExecutionMode::Simulate, ExecutionMode::Live] {
            let specs = prepare_worker_launch_specs(&multi, mode, &dir, &config).unwrap();
            assert_eq!(specs.len(), 2);
            for instance in multi.referenced_tool_instances() {
                let args = specs[&instance.id].arguments();
                assert!(args.ends_with(&super::meters::setup_arguments(
                    instance.meters_setup().unwrap()
                )));
                assert!(args.windows(2).any(|pair| pair == ["--max-samples", "2"]));
                if mode == ExecutionMode::Live {
                    let resource = config.live_resource(&instance.id).unwrap();
                    assert!(args.windows(2).any(|pair| pair == ["--resource", resource]));
                }
            }
            assert_ne!(
                specs[&ToolInstanceId::new("meters-1").unwrap()].arguments(),
                specs[&ToolInstanceId::new("meters-2").unwrap()].arguments()
            );
        }
        fs::remove_dir_all(dir).unwrap();
    }

    // Set ORCHESTRATOR_TEST_METERS_EXECUTABLE to a real meters-tool executable, then run:
    // cargo test --locked vertical_slice -- --ignored
    #[test]
    #[ignore = "requires external meters-tool; runs simulation without hardware"]
    fn dcv_simulation_vertical_slice() {
        meters_simulation_vertical_slice(
            json!({
                "measurement": "voltage-dc", "range_mode": "manual", "manual_range": 10.0,
                "nplc": 0.2, "auto_zero": "once", "dcv_input_impedance": "ten-megohm",
                "current_terminal": null
            }),
            &[
                ["--measurement", "voltage-dc"],
                ["--range", "10"],
                ["--dcv-input-impedance", "10m"],
            ],
            "V",
        );
    }

    #[test]
    #[ignore = "requires external meters-tool; runs simulation without hardware"]
    fn dci_simulation_vertical_slice() {
        meters_simulation_vertical_slice(
            json!({
                "measurement": "current-dc", "range_mode": "manual", "manual_range": 0.1,
                "nplc": 0.2, "auto_zero": "once", "dcv_input_impedance": null,
                "current_terminal": 3
            }),
            &[
                ["--measurement", "current-dc"],
                ["--range", "0.1"],
                ["--current-terminal", "3"],
            ],
            "A",
        );
    }

    fn meters_simulation_vertical_slice(
        setup: serde_json::Value,
        expected_arguments: &[[&str; 2]],
        expected_unit: &str,
    ) {
        let executable = std::env::var_os("ORCHESTRATOR_TEST_METERS_EXECUTABLE")
            .expect("set ORCHESTRATOR_TEST_METERS_EXECUTABLE to a real meters-tool executable");
        let executable = std::fs::canonicalize(executable).unwrap();
        let template = Template::from_json_str(
            &json!({
                "schema_version": 1, "name": "Meters simulation vertical slice",
                "tool_instances": [{"id": "meters-1", "tool": "meters", "setup": setup}, {"id": "powers-1", "tool": "powers", "setup": {}}],
                "workflow": {"steps": [
                    {"type": "tool-action", "id": "measure", "target": "meters-1",
                     "action": "measure", "arguments": {}}
                ]}
            })
            .to_string(),
        )
        .unwrap();
        let mut config = super::Config::default();
        config.set_executable_path(&ToolId::meters(), &executable);
        let specs = super::prepare_worker_launch_specs(
            &template,
            super::ExecutionMode::Simulate,
            executable.parent().unwrap(),
            &config,
        )
        .unwrap();
        let args = specs[&ToolInstanceId::new("meters-1").unwrap()].arguments();
        assert!(args.iter().any(|arg| arg == "--simulate"));
        for expected in expected_arguments.iter().chain(
            [
                ["--auto-range", "off"],
                ["--nplc", "0.2"],
                ["--auto-zero", "once"],
                ["--trigger-mode", "software"],
            ]
            .iter(),
        ) {
            assert!(
                args.windows(2).any(|pair| pair == *expected),
                "missing {expected:?}: {args:?}"
            );
        }
        let results = crate::run::run_simulated_workflow(
            &template,
            &specs,
            std::time::Duration::from_secs(10),
            std::time::Duration::from_secs(10),
            std::time::Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].step_id().as_str(), "measure");
        let crate::workflow::StepOutcome::Succeeded { output } = results[0].outcome() else {
            panic!("Meter Measure failed: {:?}", results[0]);
        };
        assert_eq!(output["event"], "sample");
        assert_eq!(output["unit"], expected_unit);
        assert!(output["value"].as_f64().is_some());
    }

    #[test]
    fn preparation_without_meters_does_not_require_setup() {
        let template = Template::from_json_str(
            &json!({
                "schema_version": 1, "name": "Wait only", "tool_instances": [],
                "workflow": {"steps": [{"type": "wait", "id": "wait-1", "duration_ms": 0}]}
            })
            .to_string(),
        )
        .unwrap();
        assert!(Template::from_json_str(&template.to_json_string().unwrap()).is_ok());
        for mode in [super::ExecutionMode::Simulate, super::ExecutionMode::Live] {
            let specs = super::prepare_worker_launch_specs(
                &template,
                mode,
                std::path::Path::new("unused"),
                &super::Config::default(),
            )
            .unwrap();
            assert!(specs.is_empty());
        }
    }

    #[test]
    fn live_preparation_requires_resources_before_executable_probing() {
        let template = instance_template();
        for resource in [None, Some(""), Some(" ")] {
            let mut config = Config::default();
            for instance in template.referenced_tool_instances() {
                if let Some(value) = resource {
                    config.set_live_resource(&instance.id, value);
                }
            }
            let error = prepare_worker_launch_specs(
                &template,
                ExecutionMode::Live,
                std::path::Path::new("unused"),
                &config,
            )
            .unwrap_err();
            assert!(
                error.contains("live resource") && error.contains("not configured"),
                "{error}"
            );
        }
    }

    fn instance_template() -> Template {
        Template::from_json_str(&json!({
            "schema_version": 1, "name": "Instances",
            "tool_instances": [
                {"id": "meters-1", "tool": "meters", "setup": {
                    "measurement": "voltage-dc", "range_mode": "auto", "nplc": 1,
                    "auto_zero": "on", "manual_range": null, "dcv_input_impedance": null, "current_terminal": null
                }},
                {"id": "meters-2", "tool": "meters", "setup": {
                    "measurement": "current-dc", "range_mode": "manual", "nplc": 0.2,
                    "auto_zero": "once", "manual_range": 0.1, "dcv_input_impedance": null, "current_terminal": 3
                }},
                {"id": "powers-1", "tool": "powers", "setup": {}}
            ],
            "workflow": {"steps": [
                {"type": "tool-action", "id": "read-1", "target": "meters-1", "action": "measure", "arguments": {}},
                {"type": "tool-action", "id": "read-2", "target": "meters-2", "action": "measure", "arguments": {}},
                {"type": "tool-action", "id": "power-1", "target": "powers-1", "action": "output-off", "arguments": {"channel": 1}}
            ]}
        }).to_string()).unwrap()
    }
    fn unique_test_dir(prefix: &str) -> std::path::PathBuf {
        use std::{
            process,
            sync::atomic::{AtomicU64, Ordering},
            time::{SystemTime, UNIX_EPOCH},
        };

        static NEXT_ID: AtomicU64 = AtomicU64::new(0);

        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis();
        let dir = std::env::temp_dir().join(format!("{prefix}-{}-{timestamp}-{id}", process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}
