use orchestrator_tool::{
    adapters::scopes,
    config::{Config, ResourceIdentity},
    run::{ExecutionMode, run_workflow_streaming_with_loop_stop_and_scopes_output},
    run_preparation::{prepare_worker_launch_specs, validate_confirmed_live_resources},
    template::Template,
    tool::ToolId,
    tool_instance::ToolInstanceId,
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    env, fs,
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

fn sample(name: &str) -> Template {
    Template::from_json_str(
        &fs::read_to_string(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/scopes")
                .join(name),
        )
        .unwrap(),
    )
    .unwrap()
}

#[test]
fn scopes_samples_and_setup_round_trip_in_v1() {
    for name in [
        "setup-measure.json",
        "dynamic-settings.json",
        "capture-screenshot.json",
        "mixed-meters.json",
    ] {
        let template = sample(name);
        let saved = template.to_json_string().unwrap();
        assert_eq!(Template::from_json_str(&saved).unwrap(), template);
        let wire: Value = serde_json::from_str(&saved).unwrap();
        assert_eq!(wire["schema_version"], 1);
        for local in ["model_id", "resource", "executable", "output_folder"] {
            assert!(!saved.contains(local));
        }
    }
    let mut files: Value =
        serde_json::from_str(&sample("capture-screenshot.json").to_json_string().unwrap()).unwrap();
    for key in ["csv", "meta", "plot", "output", "query_hardcopy"] {
        files["workflow"]["steps"][0]["steps"][0]["arguments"][key] = json!("local-path");
        assert!(
            Template::from_json_str(&files.to_string())
                .unwrap_err()
                .to_string()
                .contains("cannot be saved in a Template")
        );
        files["workflow"]["steps"][0]["steps"][0]["arguments"]
            .as_object_mut()
            .unwrap()
            .remove(key);
    }
    let mut wire: Value =
        serde_json::from_str(&sample("setup-measure.json").to_json_string().unwrap()).unwrap();
    for bad in [
        json!({"resource":"local"}),
        json!({"acquisition":{"acquisition_type":"normal","average_count":16}}),
        json!({"channels":[{"channel":1,"probe_ratio":-1}]}),
    ] {
        wire["tool_instances"][0]["setup"] = bad;
        assert!(Template::from_json_str(&wire.to_string()).is_err());
    }
}

#[test]
fn scopes_live_preflight_and_launch_preserve_opaque_identity() {
    let template = sample("dynamic-settings.json");
    let id = ToolInstanceId::new("scope").unwrap();
    let mut config = Config::default();
    assert!(
        prepare_worker_launch_specs(
            &template,
            ExecutionMode::Live,
            &env::current_dir().unwrap(),
            &config
        )
        .unwrap_err()
        .contains("resource is not configured")
    );
    let resource = "opaque::vendor/DEVICE::Exact Case";
    config.set_live_resource(&id, resource);
    assert!(
        prepare_worker_launch_specs(
            &template,
            ExecutionMode::Live,
            &env::current_dir().unwrap(),
            &config
        )
        .unwrap_err()
        .contains("canonical model ID is missing")
    );
    config.set_live_resource_with_identity(
        &id,
        resource,
        Some(ResourceIdentity {
            model_id: Some("unknown-model".into()),
            ..Default::default()
        }),
    );
    assert!(
        validate_confirmed_live_resources(
            &template,
            &config,
            &HashMap::from([("scope".into(), "changed".into())])
        )
        .is_err()
    );
    validate_confirmed_live_resources(
        &template,
        &config,
        &HashMap::from([("scope".into(), resource.into())]),
    )
    .unwrap();
    let spec = scopes::live_worker_launch_spec("scopes.exe", resource, "unknown-model");
    let args = spec.arguments();
    assert!(
        args.windows(2)
            .any(|pair| pair[0] == "--resource" && pair[1] == resource)
    );
    assert!(
        args.windows(2)
            .any(|pair| pair[0] == "--model" && pair[1] == "unknown-model")
    );
    let mut wire: Value = serde_json::from_str(&template.to_json_string().unwrap()).unwrap();
    wire["tool_instances"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"second","tool":"scopes","setup":{}}));
    wire["workflow"]["steps"].as_array_mut().unwrap().push(json!({"type":"tool-action","id":"second-read","target":"second","action":"measure","arguments":{"channel":1,"item":"vpp"}}));
    config.set_live_resource(&ToolInstanceId::new("second").unwrap(), resource);
    let duplicate = Template::from_json_str(&wire.to_string()).unwrap();
    assert!(
        prepare_worker_launch_specs(
            &duplicate,
            ExecutionMode::Live,
            &env::current_dir().unwrap(),
            &config
        )
        .unwrap_err()
        .contains("assigned to both")
    );
}

#[test]
#[ignore = "Requires explicitly supplied Scopes and Meters simulation executables"]
fn scopes_real_simulation_vertical_slices() {
    let exe =
        PathBuf::from(env::var_os("ORCHESTRATOR_TEST_SCOPES_EXE").expect("Scopes EXE required"));
    let meters =
        PathBuf::from(env::var_os("ORCHESTRATOR_TEST_METERS_EXE").expect("Meters EXE required"));
    let mut config = Config::default();
    config.set_executable_path(&ToolId::scopes(), &exe);
    config.set_executable_path(&ToolId::meters(), &meters);
    let caps = scopes::get_capabilities_for_mode(
        &env::current_dir().unwrap(),
        &config,
        ExecutionMode::Simulate,
        None,
    )
    .unwrap();
    assert_eq!(caps.model_id, "keysight-dsox4024a");
    assert_eq!(caps.analog_channels, 4);
    let tek = scopes::get_capabilities_for_mode(
        &env::current_dir().unwrap(),
        &config,
        ExecutionMode::Live,
        Some("tektronix-tds2024b"),
    )
    .unwrap();
    assert_eq!(tek.average_counts, Some(vec![4, 16, 64, 128]));
    assert!(
        scopes::get_capabilities_for_mode(
            &env::current_dir().unwrap(),
            &config,
            ExecutionMode::Live,
            Some("unknown-model")
        )
        .unwrap_err()
        .contains("Unsupported physical oscilloscope model ID: unknown-model")
    );
    let folder = env::temp_dir().join(format!(
        "orchestrator-scopes-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    for name in [
        "setup-measure.json",
        "dynamic-settings.json",
        "capture-screenshot.json",
        "mixed-meters.json",
        "capture-screenshot.json",
    ] {
        let mut template = sample(name);
        if name == "dynamic-settings.json" {
            let mut wire: Value =
                serde_json::from_str(&template.to_json_string().unwrap()).unwrap();
            wire["workflow"]["steps"].as_array_mut().unwrap().extend([
                json!({"type":"set-variable","id":"init-loop","variable":"count","value":{"source":"literal","value":0}}),
                json!({"type":"while","id":"measure-loop","max_iterations":2,
                    "left":{"source":"variable","variable":"count"},"operator":"less-than","right":{"source":"literal","value":2},
                    "steps":[{"type":"tool-action","id":"loop-read","target":"scope","action":"measure","arguments":{"channel":2,"item":"frequency"}},
                        {"type":"output","id":"loop-out","page":"Loop Results","name":"Frequency","value":{"source":"step-output","step_id":"loop-read","pointer":"/value"}},
                        {"type":"set-variable","id":"increment","variable":"count","value":{"source":"expression","left":{"source":"variable","variable":"count"},"operator":"add","right":{"source":"literal","value":1}}}]})
            ]);
            template = Template::from_json_str(&wire.to_string()).unwrap();
        }
        let before = template.to_json_string().unwrap();
        let specs = prepare_worker_launch_specs(
            &template,
            ExecutionMode::Simulate,
            &env::current_dir().unwrap(),
            &config,
        )
        .unwrap();
        let summary = run_workflow_streaming_with_loop_stop_and_scopes_output(
            &template,
            ExecutionMode::Simulate,
            &specs,
            Duration::from_secs(10),
            Duration::from_secs(10),
            Duration::from_secs(5),
            Some(&folder),
            |_| {},
            |_| false,
        )
        .unwrap();
        assert!(summary.succeeded(), "{name}: {:?}", summary.failure());
        assert_eq!(template.to_json_string().unwrap(), before);
    }
    let files: Vec<_> = fs::read_dir(&folder)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    assert_eq!(files.len(), 12); // Two runs × two iterations × CSV, metadata, screenshot.
    assert_eq!(
        files
            .iter()
            .filter(|path| path.extension().is_some_and(|ext| ext == "png"))
            .count(),
        4
    );
    assert!(
        files
            .iter()
            .all(|path| path.is_absolute() && fs::metadata(path).unwrap().len() > 0)
    );
    for path in &files {
        let bytes = fs::read(path).unwrap();
        if path.extension().is_some_and(|ext| ext == "png") {
            assert!(bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
        }
        if path.extension().is_some_and(|ext| ext == "json") {
            assert!(serde_json::from_slice::<Value>(&bytes).unwrap().is_object());
        }
    }
    let blocked = folder.join("blocked");
    fs::write(&blocked, "existing").unwrap();
    let template = sample("capture-screenshot.json");
    let specs = prepare_worker_launch_specs(
        &template,
        ExecutionMode::Simulate,
        &env::current_dir().unwrap(),
        &config,
    )
    .unwrap();
    let failed = run_workflow_streaming_with_loop_stop_and_scopes_output(
        &template,
        ExecutionMode::Simulate,
        &specs,
        Duration::from_secs(10),
        Duration::from_secs(10),
        Duration::from_secs(5),
        Some(&blocked),
        |_| {},
        |_| false,
    )
    .unwrap();
    assert!(!failed.succeeded());
    assert!(
        failed
            .failure()
            .unwrap()
            .contains("could not create Scopes File Output folder")
    );
    assert_eq!(fs::read_to_string(blocked).unwrap(), "existing");
    fs::remove_dir_all(folder).unwrap();
}
