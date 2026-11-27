use super::*;

pub(super) fn run_meters_worker_fixture() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let run_id = "meters-smoke-run";
    print_json_line(
        &json!({
            "event": "ready",
            "schema_version": 3,
            "run_id": run_id,
            "status_url": format!("{base_url}/status"),
            "command_url": format!("{base_url}/command"),
            "stop_url": format!("{base_url}/stop"),
        })
        .to_string(),
    );

    let request = accept_request(&listener);
    assert_eq!(
        (request.method.as_str(), request.path.as_str()),
        ("GET", "/status")
    );
    write_response(
        request.stream,
        200,
        &json!({
            "schema_version": 3,
            "service": "keysight-meter",
            "run_id": run_id,
            "status": "running",
            "captured": 0,
            "fatal_error": null
        })
        .to_string(),
    );

    let request = accept_request(&listener);
    assert_eq!(
        (request.method.as_str(), request.path.as_str()),
        ("POST", "/command")
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&request.body).unwrap(),
        json!({
            "schema_version": 3,
            "command": "software_trigger",
            "job_id": "orchestrator-meter-smoke"
        })
    );
    write_response(
        request.stream,
        202,
        r#"{"schema_version":3,"status":"accepted","command":"software_trigger","job_id":"orchestrator-meter-smoke"}"#,
    );

    let request = accept_request(&listener);
    assert_eq!(
        (request.method.as_str(), request.path.as_str()),
        ("GET", "/status")
    );
    write_response(
        request.stream,
        200,
        &json!({
            "schema_version": 3,
            "service": "keysight-meter",
            "run_id": run_id,
            "status": "running",
            "captured": 1,
            "fatal_error": null
        })
        .to_string(),
    );

    let request = accept_request(&listener);
    assert_eq!(
        (request.method.as_str(), request.path.as_str()),
        ("POST", "/stop")
    );
    write_response(request.stream, 202, "");
}

pub(super) fn run_meters_runtime_fixture(
    measurements: usize,
    max_samples: usize,
    value: serde_json::Value,
) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let run_id = format!("meters-runtime-run-{}", process::id());
    print_json_line(
        &json!({
            "event": "ready",
            "schema_version": 3,
            "run_id": run_id,
            "status_url": format!("{base_url}/status"),
            "command_url": format!("{base_url}/command"),
            "stop_url": format!("{base_url}/stop"),
        })
        .to_string(),
    );

    for sequence in 1..=measurements {
        let request = accept_request(&listener);
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/command");
        let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
        assert_eq!(body["schema_version"], 3);
        assert_eq!(body["command"], "software_trigger");
        assert_eq!(body["arguments"], json!({}));
        assert!(
            body.get("context").is_none(),
            "meters runtime must not send context"
        );
        assert!(
            body["job_id"].as_str().is_some_and(|id| !id.is_empty()),
            "Common v3 requires unique non-empty client job_id"
        );
        assert!(
            body.get("metadata").is_none(),
            "meters runtime must not send metadata"
        );
        write_response(
            request.stream,
            202,
            r#"{"schema_version":3,"status":"accepted","command":"software_trigger","job_id":null}"#,
        );

        // Emit a non-matching event first, then the matching sample.
        print_json_line(
            &json!({
                "event": "heartbeat",
                "run_id": run_id,
                "status": "running"
            })
            .to_string(),
        );
        print_json_line(
            &json!({
                "event": "sample",
                "run_id": run_id,
                "value": value,
                "sequence": sequence,
                "unit": "V"
            })
            .to_string(),
        );

        if sequence >= max_samples {
            fixture_summary();
            return;
        }
    }

    let request = accept_request(&listener);
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, "/stop");
    write_response(request.stream, 200, r#"{"ok":true}"#);
    fixture_summary();
}

pub(super) fn run_meters_single_runtime_fixture(exit_delay: Option<Duration>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let run_id = format!("meters-single-runtime-run-{}", process::id());
    print_json_line(
        &json!({
            "event": "ready", "schema_version": 3, "run_id": run_id,
            "status_url": format!("{base_url}/status"),
            "command_url": format!("{base_url}/command"),
            "stop_url": format!("{base_url}/stop")
        })
        .to_string(),
    );
    let request = accept_request(&listener);
    assert_eq!(
        (request.method.as_str(), request.path.as_str()),
        ("POST", "/command")
    );
    write_response(
        request.stream,
        202,
        r#"{"schema_version":3,"status":"accepted","command":"software_trigger","job_id":null}"#,
    );
    if let Some(exit_delay) = exit_delay {
        // Make the samples visible only after the HTTP endpoint is closed.
        let stdout = io::stdout();
        let mut output = io::BufWriter::new(stdout.lock());
        for (sequence, value) in [0.055].into_iter().enumerate() {
            writeln!(
                output,
                "{}",
                fixture_event_json(
                    &json!({
                        "event": "sample", "run_id": run_id, "value": value,
                        "sequence": sequence + 1, "unit": "V"
                    })
                    .to_string()
                )
            )
            .unwrap();
        }
        drop(listener);
        output.flush().unwrap();
        drop(output);
        thread::sleep(exit_delay);
    } else {
        for (sequence, value) in [0.055].into_iter().enumerate() {
            print_json_line(
                &json!({
                    "event": "sample", "run_id": run_id, "value": value,
                    "sequence": sequence + 1, "unit": "V"
                })
                .to_string(),
            );
        }
        let request = accept_request(&listener);
        assert_eq!(
            (request.method.as_str(), request.path.as_str()),
            ("POST", "/stop")
        );
        write_response(request.stream, 200, r#"{"ok":true}"#);
    }
}

pub(super) fn run_meters_reject_non_single_fixture() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let run_id = format!("meters-reject-non-single-run-{}", process::id());
    print_json_line(
        &json!({
            "event": "ready", "schema_version": 3, "run_id": run_id,
            "status_url": format!("{base_url}/status"),
            "command_url": format!("{base_url}/command"),
            "stop_url": format!("{base_url}/stop")
        })
        .to_string(),
    );

    let request = accept_request(&listener);
    assert_eq!(
        (request.method.as_str(), request.path.as_str()),
        ("POST", "/stop"),
        "rejected foreground mode must not send software_trigger"
    );
    write_response(request.stream, 200, r#"{"ok":true}"#);
}

pub(super) fn meters_worker_smoke_captures_sample_and_shuts_down() {
    run_meters_worker_smoke(
        env::current_exe().unwrap(),
        Duration::from_secs(5),
        Duration::from_secs(5),
        Duration::from_secs(5),
    )
    .unwrap();
}

pub(super) fn meters_runtime_measure_returns_sample() {
    let session = start_worker(
        &fixture_spec("meters-runtime-measure"),
        Duration::from_secs(5),
    )
    .unwrap();
    let action = ActionId::new("measure").unwrap();
    let result = run_meters_action(&session, &action, &json!({}), Duration::from_secs(5)).unwrap();
    assert_eq!(result["event"], "sample");
    assert_eq!(result["run_id"], session.ready().run_id());
    assert_eq!(result["value"], 3.3);
    assert!(session.shutdown(Duration::from_secs(5)).unwrap().success());
}

pub(super) fn meters_runtime_rejects_non_single_modes() {
    for mode in [
        MetersTriggerMode::SoftwareCustom,
        MetersTriggerMode::ImmediateCustom,
        MetersTriggerMode::ExternalCustom,
        MetersTriggerMode::Immediate,
        MetersTriggerMode::External,
    ] {
        let session = start_worker(
            &fixture_spec("meters-runtime-reject-non-single"),
            Duration::from_secs(5),
        )
        .unwrap();
        let setup = MetersSetup {
            trigger_mode: mode,
            ..Default::default()
        };
        assert!(
            run_meters_action_with_setup(
                &session,
                &ActionId::new("measure").unwrap(),
                &json!({}),
                &setup,
                Duration::from_secs(1)
            )
            .unwrap_err()
            .to_string()
            .contains("requires Single")
        );
        assert!(session.shutdown(Duration::from_secs(5)).unwrap().success());
    }
}

pub(super) fn meters_single_auto_exit_completes_workflow() {
    let template = single_meter_template(json!([
        { "type": "tool-action", "id": "measure", "target": "meters-1",
          "action": "measure", "arguments": {} },
        { "type": "output", "id": "value", "name": "value", "page": "Batch",
          "value": { "source": "step-output", "step_id": "measure", "pointer": "/value" } },
        { "type": "wait", "id": "allow-worker-exit", "duration_ms": 200 }
    ]));
    let run = run_simulated_workflow(
        &template,
        &HashMap::from([(
            ToolInstanceId::new("meters-1").unwrap(),
            fixture_spec("meters-runtime-single-auto-exit"),
        )]),
        Duration::from_secs(5),
        Duration::from_secs(5),
        Duration::from_secs(5),
    )
    .unwrap();

    assert_eq!(run.result_rows().len(), 1);
    assert_eq!(run.result_rows()[0].outputs()[0].value(), &json!(0.055));
}

pub(super) fn meters_single_shutdown_waits_for_exit_after_stop_failure() {
    let template = single_meter_template(json!([
        { "type": "tool-action", "id": "measure", "target": "meters-1",
          "action": "measure", "arguments": {} },
        { "type": "output", "id": "value", "name": "value", "page": "Batch",
          "value": { "source": "step-output", "step_id": "measure", "pointer": "/value" } }
    ]));
    let run = run_simulated_workflow(
        &template,
        &HashMap::from([(
            ToolInstanceId::new("meters-1").unwrap(),
            fixture_spec("meters-runtime-single-delayed-auto-exit"),
        )]),
        Duration::from_secs(5),
        Duration::from_secs(5),
        Duration::from_secs(5),
    )
    .unwrap();

    assert_eq!(run.result_rows().len(), 1);
}

fn single_meter_template(steps: serde_json::Value) -> Template {
    Template::from_json_str(
        &json!({"name": "Single meter", "tool_instances": [{
        "id": "meters-1", "tool": "meters", "setup": MetersSetup::default()
    }], "workflow": {"interaction":{"enabled":false,"max_active_command_status":4096,"buffer":{"enabled":false,"mode":"fifo","overflow_policy":"fail-run"}}, "steps": steps }})
        .to_string(),
    )
    .unwrap()
}

pub(super) fn meters_single_outputs_preserve_staging() {
    let measure = json!({
        "type": "tool-action", "id": "measure", "target": "meters-1",
        "action": "measure", "arguments": {}
    });
    let template = single_meter_template(json!([
        measure,
        { "type": "output", "id": "scalar", "name": "power", "page": "Batch",
          "value": { "source": "literal", "value": 3.0 } },
        { "type": "output", "id": "value", "name": "value", "page": "Batch",
          "value": { "source": "step-output", "step_id": "measure", "pointer": "/value" } },
        { "type": "output", "id": "millivolts", "name": "millivolts", "page": "Batch",
          "value": { "source": "expression",
            "left": { "source": "step-output", "step_id": "measure", "pointer": "/value" },
            "operator": "multiply", "right": { "source": "literal", "value": 1000 } } },
        { "type": "output", "id": "other", "name": "temperature", "page": "Scalar",
          "value": { "source": "literal", "value": 25 } }
    ]));
    let mut events = Vec::new();
    let run = run_workflow_with_events(
        &template,
        ExecutionMode::Simulate,
        &HashMap::from([(
            ToolInstanceId::new("meters-1").unwrap(),
            fixture_spec("meters-runtime-single"),
        )]),
        Duration::from_secs(5),
        Duration::from_secs(5),
        Duration::from_secs(5),
        |event| events.push(event),
    )
    .unwrap();
    let batch = run
        .result_rows()
        .iter()
        .filter(|row| row.page() == "Batch")
        .collect::<Vec<_>>();
    assert_eq!(batch.len(), 1);
    for (index, expected) in [0.055].into_iter().enumerate() {
        assert_eq!(batch[index].outputs()[0].value(), &json!(3.0));
        assert_eq!(batch[index].outputs()[1].value(), &json!(expected));
        assert_eq!(batch[index].outputs()[2].value(), &json!(expected * 1000.0));
    }
    assert_eq!(
        run.result_rows()
            .iter()
            .filter(|row| row.page() == "Scalar")
            .count(),
        1
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event, WorkflowRunEvent::ResultRowCommitted(row) if row.page() == "Batch"))
            .count(),
        1
    );

    let failed = single_meter_template(json!([
        { "type": "tool-action", "id": "measure", "target": "meters-1",
          "action": "measure", "arguments": {} },
        { "type": "output", "id": "value", "name": "value", "page": "Batch",
          "value": { "source": "step-output", "step_id": "measure", "pointer": "/value" } },
        { "type": "assert", "id": "failure", "left": { "source": "literal", "value": 0 },
          "operator": "greater-than", "right": { "source": "literal", "value": 1 },
          "message": "later failure" }
    ]));
    let run = run_simulated_workflow(
        &failed,
        &HashMap::from([(
            ToolInstanceId::new("meters-1").unwrap(),
            fixture_spec("meters-runtime-single"),
        )]),
        Duration::from_secs(5),
        Duration::from_secs(5),
        Duration::from_secs(5),
    )
    .unwrap();
    assert!(run.result_rows().is_empty());

    let error = Template::from_json_str(
        &json!({
            "name": "Two batches", "tool_instances": [{
                "id": "meters-1", "tool": "meters", "setup": {
                    "measurement": "voltage-dc", "range_mode": "auto",
                    "manual_range": null, "nplc": 1.0, "auto_zero": "on",
                    "dcv_input_impedance": null, "current_terminal": null,
                    "trigger_mode": "software-custom", "sample_count": 3,
                    "buffer_drain_size": null, "allow_buffer_overflow_risk": false
                }
            }],
            "workflow": {"interaction":{"enabled":false,"max_active_command_status":4096,"buffer":{"enabled":false,"mode":"fifo","overflow_policy":"fail-run"}}, "steps": [
                { "type": "tool-action", "id": "measure-a", "target": "meters-1", "action": "measure", "arguments": {} },
                { "type": "output", "id": "out-a", "name": "a", "page": "Batch",
                  "value": { "source": "step-output", "step_id": "measure-a", "pointer": "/value" } },
                { "type": "tool-action", "id": "measure-b", "target": "meters-1", "action": "measure", "arguments": {} },
                { "type": "output", "id": "out-b", "name": "b", "page": "Batch",
                  "value": { "source": "step-output", "step_id": "measure-b", "pointer": "/value" } }
            ] }
        })
        .to_string(),
    )
    .unwrap_err();
    assert!(error.to_string().contains("requires Single"));

    let error = Template::from_json_str(
        &json!({
            "name": "Batch used by Assert", "tool_instances": [{
                "id": "meters-1", "tool": "meters", "setup": {
                    "measurement": "voltage-dc", "range_mode": "auto",
                    "manual_range": null, "nplc": 1.0, "auto_zero": "on",
                    "dcv_input_impedance": null, "current_terminal": null,
                    "trigger_mode": "software-custom", "sample_count": 3
                }
            }],
            "workflow": {"interaction":{"enabled":false,"max_active_command_status":4096,"buffer":{"enabled":false,"mode":"fifo","overflow_policy":"fail-run"}}, "steps": [
                { "type": "tool-action", "id": "measure", "target": "meters-1", "action": "measure", "arguments": {} },
                { "type": "assert", "id": "assert-batch",
                  "left": { "source": "step-output", "step_id": "measure", "pointer": "/value" },
                  "operator": "greater-than", "right": { "source": "literal", "value": 0 },
                  "message": "batch assert" }
            ] }
        })
        .to_string(),
    )
    .unwrap_err();
    assert!(error.to_string().contains("requires Single"), "{error}");
}

pub(super) fn three_meter_measurements_shutdown_normally() {
    let workflow = Workflow::new(
        (1..=3)
            .map(|sequence| {
                Step::new(
                    StepId::new(format!("read-{sequence}")).unwrap(),
                    StepKind::ToolAction {
                        target: ToolInstanceId::new("meters-1").unwrap(),
                        action: ActionId::new("measure").unwrap(),
                        arguments: json!({}),
                        bindings: Default::default(),
                    },
                )
            })
            .collect(),
    )
    .unwrap();
    let spec = orchestrator_tool::adapters::meters::simulate_worker_launch_spec(
        env::current_exe().unwrap(),
        Some(4),
        &MetersSetup {
            measurement: MetersMeasurement::VoltageDc,
            range_mode: RangeMode::Auto,
            manual_range: None,
            nplc: 1.0,
            auto_zero: AutoZero::On,
            dcv_input_impedance: None,
            current_terminal: None,
            ..MetersSetup::default()
        },
    );
    let run = run_simulated_workflow(
        &test_template(&workflow),
        &HashMap::from([(
            ToolInstanceId::new("meters-1").unwrap(),
            spec.with_manifest(fixture_manifest("meters-runtime")),
        )]),
        Duration::from_secs(5),
        Duration::from_secs(5),
        Duration::from_secs(5),
    )
    .unwrap();
    let results = run.step_executions();
    assert_eq!(results.len(), 3);
    for (index, result) in results.iter().enumerate() {
        assert_eq!(result.step_id().as_str(), format!("read-{}", index + 1));
        let StepOutcome::Succeeded { output } = result.outcome() else {
            panic!("measurement failed: {:?}", result.outcome());
        };
        assert_eq!(output["sequence"], index + 1);
    }
}

pub(super) fn two_meters_use_distinct_sessions() {
    let mut instances =
        test_template(&Workflow::new(vec![]).unwrap()).tool_instances()[1..].to_vec();
    let mut second = instances[0].clone();
    second.id = ToolInstanceId::new("meters-2").unwrap();
    instances.push(second);
    let workflow = Workflow::new(
        instances
            .iter()
            .map(|instance| {
                Step::new(
                    StepId::new(instance.id.as_str()).unwrap(),
                    StepKind::ToolAction {
                        target: instance.id.clone(),
                        action: ActionId::new("measure").unwrap(),
                        arguments: json!({}),
                        bindings: Default::default(),
                    },
                )
            })
            .collect(),
    )
    .unwrap();
    let template = Template::new("Two Meters".to_owned(), instances, workflow).unwrap();
    let specs = template
        .tool_instances()
        .iter()
        .map(|instance| (instance.id.clone(), fixture_spec("meters-runtime-measure")))
        .collect();
    let run = run_simulated_workflow(
        &template,
        &specs,
        Duration::from_secs(5),
        Duration::from_secs(5),
        Duration::from_secs(5),
    )
    .unwrap();
    let results = run.step_executions();
    let outputs: Vec<_> = results
        .iter()
        .map(|result| match result.outcome() {
            StepOutcome::Succeeded { output } => output,
            outcome => panic!("{outcome:?}"),
        })
        .collect();
    assert_eq!(outputs.len(), 2);
    assert_ne!(outputs[0]["run_id"], outputs[1]["run_id"]);
}
