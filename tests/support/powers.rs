use super::*;

pub(super) fn real_powers_simulated_workflow_uses_common_tracker() {
    let executable = std::path::PathBuf::from(
        env::var_os("ORCHESTRATOR_TEST_POWERS_EXE")
            .expect("Real Powers SIM executable must be explicitly supplied"),
    );
    let instance = ToolInstanceId::new("powers-real").unwrap();
    let workflow = Workflow::new(vec![
        Step::new(
            StepId::new("set-output").unwrap(),
            StepKind::ToolAction {
                target: instance.clone(),
                action: ActionId::new("set-output").unwrap(),
                arguments: json!({"channel":1,"voltage":2.5}),
                bindings: Default::default(),
            },
        ),
        Step::new(
            StepId::new("output-off").unwrap(),
            StepKind::ToolAction {
                target: instance.clone(),
                action: ActionId::new("output-off").unwrap(),
                arguments: json!({"channel":1}),
                bindings: Default::default(),
            },
        ),
    ])
    .unwrap();
    let template = Template::new(
        "Powers Common v3 real SIM".to_owned(),
        vec![ToolInstance {
            display_name: None,
            id: instance.clone(),
            tool: ToolId::powers(),
            setup: ToolSetup::Powers(orchestrator_tool::powers_setup::PowersSetup::default()),
        }],
        workflow,
    )
    .unwrap();
    let launch_specs = HashMap::from([(
        instance,
        orchestrator_tool::adapters::powers::simulate_worker_launch_spec(executable),
    )]);
    let run = run_simulated_workflow(
        &template,
        &launch_specs,
        Duration::from_secs(10),
        Duration::from_secs(10),
        Duration::from_secs(10),
    )
    .unwrap();
    let executions = run.step_executions();
    assert_eq!(executions.len(), 2);
    assert!(
        executions
            .iter()
            .all(|step| matches!(step.outcome(), StepOutcome::Succeeded { .. }))
    );
}

pub(super) fn run_powers_worker_fixture() {
    let scenario = env::var(POWERS_FIXTURE_SCENARIO_ENV).unwrap_or_else(|_| "success".to_owned());
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let run_id = "powers-smoke-run";
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
            "service": "powers-tool",
            "run_id": run_id,
            "status": if scenario == "fatal-nonzero" { "error" } else { "ready" },
            "fatal_error": if scenario == "fatal-nonzero" {
                Some(json!({
                    "code": "worker_fault",
                    "message": "simulated fatal failure"
                }))
            } else {
                None
            },
            "last_job": null
        })
        .to_string(),
    );

    if scenario == "fatal-nonzero" {
        let request = accept_request(&listener);
        assert_eq!(
            (request.method.as_str(), request.path.as_str()),
            ("POST", "/stop")
        );
        write_response(request.stream, 200, r#"{"ok":true}"#);
        process::exit(7);
    }

    let request = accept_request(&listener);
    assert_eq!(
        (request.method.as_str(), request.path.as_str()),
        ("POST", "/command")
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&request.body).unwrap(),
        json!({
            "schema_version": 3,
            "command": "read-status",
            "arguments": { "channel": "all" },
            "context": {
                "mode": "simulate",
                "planning_model_id": "keysight-e36312a"
            },
            "job_id": serde_json::from_slice::<serde_json::Value>(&request.body).unwrap()["job_id"]
        })
    );
    write_response(
        request.stream,
        202,
        r#"{"schema_version":3,"status":"accepted","command":"read-status","worker_job_id":"job-current"}"#,
    );

    let jobs = if scenario == "terminal-failure" {
        vec![json!({
            "worker_job_id": "job-current",
            "status": "failed",
            "error": {
                "code": "connection_failed",
                "message": "simulated diagnostic failure"
            }
        })]
    } else {
        vec![
            json!({
                "worker_job_id": "job-previous",
                "status": "succeeded",
                "result": { "ok": true }
            }),
            json!({
                "worker_job_id": "job-current",
                "status": "succeeded",
                "result": { "ok": true }
            }),
        ]
    };

    for last_job in jobs {
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
                "service": "powers-tool",
                "run_id": run_id,
                "status": "ready",
                "fatal_error": null,
                "last_job": last_job
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

pub(super) fn run_manual_powers_fixture(scenario: &str) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let run_id = "manual-powers";
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

    let unresolved = scenario == "manual-clear-unresolved";
    let simulated = scenario.starts_with("manual-sim-");
    let commands: Vec<(&str, serde_json::Value)> = match scenario {
        "manual-status" => vec![(
            "protection-status",
            json!({"channel":"all","confirm_output":true}),
        )],
        "manual-clear" | "manual-clear-unresolved" => vec![
            ("safe-off", json!({"channel":"all","confirm_output":true})),
            (
                "clear-protection",
                json!({"channel":2,"confirm_output":true}),
            ),
            (
                "protection-status",
                json!({"channel":"all","confirm_output":true}),
            ),
        ],
        "manual-safe-off-failure" => {
            vec![("safe-off", json!({"channel":"all","confirm_output":true}))]
        }
        "manual-sim-status" => vec![("protection-status", json!({"channel":"all"}))],
        "manual-sim-clear" => vec![
            ("safe-off", json!({"channel":"all"})),
            ("clear-protection", json!({"channel":2})),
        ],
        _ => panic!("unknown manual Powers fixture scenario"),
    };

    for (index, (command, arguments)) in commands.into_iter().enumerate() {
        let request = accept_request(&listener);
        assert_eq!(
            (request.method.as_str(), request.path.as_str()),
            ("POST", "/command")
        );
        let body = serde_json::from_slice::<serde_json::Value>(&request.body).unwrap();
        assert_eq!(body["schema_version"], 3);
        assert_eq!(body["command"], command);
        assert_eq!(body["arguments"], arguments);
        assert_eq!(
            body["context"],
            if simulated {
                json!({"mode":"simulate","planning_model_id":"keysight-e36312a"})
            } else {
                json!({"mode":"live"})
            }
        );
        let job_id = format!("manual-job-{index}");
        write_response(
            request.stream,
            202,
            &json!({
                "schema_version":3,
                "status":"accepted",
                "command":command,
                "worker_job_id":job_id
            })
            .to_string(),
        );

        let request = accept_request(&listener);
        assert_eq!(
            (request.method.as_str(), request.path.as_str()),
            ("GET", "/status")
        );
        let failed = scenario == "manual-safe-off-failure";
        let result = if command == "protection-status" {
            json!({"data":{
                "protection":{"over_voltage_tripped":unresolved,"over_current_tripped":false},
                "protection_by_channel":[
                    {"channel":1,"protection":{"over_voltage_tripped":false,"over_current_tripped":false}},
                    {"channel":2,"protection":{"over_voltage_tripped":unresolved,"over_current_tripped":false}}
                ],
                "outputs":[{"channel":1,"enabled":false},{"channel":2,"enabled":false}]
            }})
        } else if command == "safe-off" && !simulated {
            json!({
                "execution":{"mode":"live","dry_run":false,"hardware_touched":true},
                "data":fixture_safe_off_readback(Some(true), json!([]))
            })
        } else if simulated && command == "clear-protection" {
            json!({
                "request":{"command":"clear-protection","arguments":{"channel":2}},
                "execution":{"hardware_touched":false},
                "data":{"plan":{"steps":["safe-off","clear-protection"],"channel":2}}
            })
        } else {
            json!({"ok":true})
        };
        write_response(
            request.stream,
            200,
            &json!({
                "schema_version":3,
                "service":"powers-tool",
                "run_id":run_id,
                "status":"ready",
                "fatal_error":null,
                "last_job": if failed {
                    json!({"worker_job_id":job_id,"status":"failed",
                        "error":{"code":"safe_off_failed","message":"simulated Safe-Off failure"}})
                } else {
                    json!({"worker_job_id":job_id,"status":"succeeded","result":result})
                }
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

pub(super) fn run_powers_runtime_fixture() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let run_id = "powers-runtime-run";
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

    // Expect runtime powers command.
    let request = accept_request(&listener);
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, "/command");
    let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
    assert_eq!(body["schema_version"], 3);
    let command = body["command"].as_str().unwrap().to_owned();
    assert!(matches!(
        command.as_str(),
        "set" | "output-on" | "output-off"
    ));
    assert_eq!(
        body["context"],
        json!({
            "mode": "simulate",
            "planning_model_id": "keysight-e36312a"
        })
    );
    // Validate channel present.
    assert!(body["arguments"]["channel"].is_number());
    if command == "set" {
        assert!(body["arguments"]["voltage"].is_number());
    }
    // No extra argument fields beyond expected.
    let args = body["arguments"].as_object().unwrap();
    let expected_keys: Vec<&str> = if command == "set" {
        vec!["channel", "voltage"]
    } else {
        vec!["channel"]
    };
    assert_eq!(args.len(), expected_keys.len());
    for key in expected_keys {
        assert!(args.contains_key(key));
    }
    write_response(
        request.stream,
        202,
        &format!(
            r#"{{"schema_version":3,"status":"accepted","command":"{command}","worker_job_id":"job-runtime-001"}}"#
        ),
    );

    // First poll: job still running (busy + active_job), proves adapter continues polling.
    let request = accept_request(&listener);
    assert_eq!(request.method, "GET");
    assert_eq!(request.path, "/status");
    write_response(
        request.stream,
        200,
        &json!({
            "schema_version": 3,
            "service": "powers-tool",
            "run_id": run_id,
            "status": "busy",
            "fatal_error": null,
            "active_job": {
                "worker_job_id": "job-runtime-001",
                "status": "running"
            },
            "last_job": null
        })
        .to_string(),
    );

    // Second poll: terminal succeeded last_job.
    let request = accept_request(&listener);
    assert_eq!(request.method, "GET");
    assert_eq!(request.path, "/status");
    write_response(
        request.stream,
        200,
        &json!({
            "schema_version": 3,
            "service": "powers-tool",
            "run_id": run_id,
            "status": "ready",
            "fatal_error": null,
            "active_job": null,
            "last_job": {
                "worker_job_id": "job-runtime-001",
                "status": "succeeded",
                "result": {
                    "request": {
                        "command": "set",
                        "arguments": { "channel": 1, "voltage": 5.0 }
                    }
                }
            }
        })
        .to_string(),
    );

    let mut request = accept_request(&listener);
    if request.path == "/command" {
        assert_eq!(request.method, "POST");
        let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
        assert_eq!(body["command"], "safe-off");
        assert_eq!(body["arguments"], json!({"channel":"all"}));
        assert_eq!(
            body["context"],
            json!({"mode":"simulate","planning_model_id":"keysight-e36312a"})
        );
        write_response(
            request.stream,
            202,
            r#"{"schema_version":3,"status":"accepted","command":"safe-off","worker_job_id":"job-cleanup"}"#,
        );
        request = accept_request(&listener);
        assert_eq!(request.method, "GET");
        assert_eq!(request.path, "/status");
        write_response(
            request.stream,
            200,
            &json!({
                "schema_version":3,"service":"powers-tool","run_id":run_id,
                "status":"ready","fatal_error":null,
                "last_job":{"worker_job_id":"job-cleanup","status":"succeeded","result":{"ok":true}}
            })
            .to_string(),
        );
        request = accept_request(&listener);
    }
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, "/stop");
    write_response(request.stream, 200, r#"{"ok":true}"#);
}

fn fixture_safe_off_readback(
    confirmed: Option<bool>,
    errors: serde_json::Value,
) -> serde_json::Value {
    json!({
        "output_off_confirmed": confirmed,
        "outputs":[{"channel":1,"enabled":confirmed == Some(false)}],
        "instrument_errors":errors
    })
}

pub(super) fn run_powers_workflow_fixture(scenario: &str) {
    let live = !scenario.starts_with("simulate");
    let protection_scenario = matches!(
        scenario,
        "simulate-protection-success"
            | "simulate-protection-trip"
            | "simulate-protection-set-failure"
            | "live-protection-success"
            | "live-protection-trip"
            | "live-protection-set-failure"
            | "live-protection-set-and-cleanup-failure"
    );
    let step_failed = matches!(
        scenario,
        "simulate-step-failure"
            | "live-step-failure"
            | "live-both-failed"
            | "live-stop-step-failure"
    );
    let cleanup_failed = matches!(
        scenario,
        "live-cleanup-failure"
            | "live-queue-failure"
            | "live-readback-failure"
            | "live-stop-cleanup-failure"
            | "live-both-failed"
            | "live-multi-cleanup-failure"
            | "live-protection-set-and-cleanup-failure"
    );
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let run_id = "powers-workflow-runtime-run";
    if scenario == "live-stop-startup" {
        record_event_if_requested("starting");
        thread::sleep(Duration::from_millis(100));
    }
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

    let mut commands = vec![
        (
            "set",
            json!({ "channel": 1, "voltage": 5.0 }),
            "job-workflow-001",
        ),
        ("output-on", json!({ "channel": 1 }), "job-workflow-002"),
        ("output-off", json!({ "channel": 1 }), "job-workflow-003"),
    ];
    if scenario == "simulate-set-output" {
        commands[0].1 = json!({ "channel": 1, "voltage": 5.0, "current": 0.2 });
    }
    if scenario == "simulate-measure" {
        commands = vec![("measure", json!({ "channel": 2 }), "job-measure")];
    }
    if scenario == "simulate-protection-status" {
        commands = vec![(
            "protection-status",
            json!({ "channel": "all" }),
            "job-protection",
        )];
    }
    if step_failed || scenario == "live-assert-failure" || scenario.starts_with("live-stop-") {
        commands.truncate(2);
    }
    if matches!(
        scenario,
        "live-startup-failure" | "live-multi-cleanup-failure" | "live-stop-startup"
    ) {
        commands.clear();
    }
    if protection_scenario {
        let failed_before_workflow = !scenario.ends_with("protection-success");
        if failed_before_workflow {
            commands.clear();
        }
        let mut setup_commands = vec![
            ("safe-off", json!({"channel":"all"}), "job-pre-safe-off"),
            (
                "protection-status",
                json!({"channel":"all"}),
                "job-pre-status",
            ),
        ];
        if !scenario.ends_with("protection-trip") {
            setup_commands.push((
                "protection-set",
                json!({"channel":1,"ovp_voltage":5.5,"ocp":"on"}),
                "job-pre-set",
            ));
        }
        setup_commands.extend(commands);
        commands = setup_commands;
    }
    commands.push(("safe-off", json!({ "channel": "all" }), "job-cleanup"));
    for (command, mut arguments, worker_job_id) in commands {
        let context = if live {
            arguments["confirm_output"] = json!(true);
            json!({ "mode": "live" })
        } else {
            json!({ "mode": "simulate", "planning_model_id": "keysight-e36312a" })
        };
        let request = accept_request(&listener);
        assert_eq!(
            (request.method.as_str(), request.path.as_str()),
            ("POST", "/command")
        );
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&request.body).unwrap(),
            json!({
                "schema_version": 3,
                "command": command,
                "arguments": arguments,
                "context": context,
                "job_id": serde_json::from_slice::<serde_json::Value>(&request.body).unwrap()["job_id"].clone()
            })
        );
        record_event_if_requested(command);
        if scenario.starts_with("live-stop-") && command == "output-on" {
            thread::sleep(Duration::from_millis(100));
        }
        write_response(
            request.stream,
            202,
            &json!({
                "schema_version": 3,
                "status": "accepted",
                "command": command,
                "worker_job_id": worker_job_id
            })
            .to_string(),
        );

        let request = accept_request(&listener);
        assert_eq!(
            (request.method.as_str(), request.path.as_str()),
            ("GET", "/status")
        );
        let cleanup_failed = cleanup_failed && worker_job_id == "job-cleanup";
        let error = if cleanup_failed {
            let (confirmed, errors) = match scenario {
                "live-queue-failure" => (Some(true), json!(null)),
                "live-readback-failure" => (None, json!(null)),
                _ => (Some(false), json!(["-222,\"Data out of range\""])),
            };
            json!({"category":"execution","code":"safe_off_failed","message":"fixture cleanup failure",
                "details":{"partial_result":fixture_safe_off_readback(confirmed, errors)}})
        } else {
            json!({"message":"fixture action failure"})
        };
        write_response(
            request.stream,
            200,
            &json!({
                "schema_version": 3,
                "service": "powers-tool",
                "run_id": run_id,
                "status": "ready",
                "fatal_error": null,
                "active_job": null,
                "last_job": {
                    "worker_job_id": worker_job_id,
                    "status": if (step_failed && command == "output-on") || cleanup_failed
                        || (matches!(scenario, "simulate-protection-set-failure" | "live-protection-set-failure" | "live-protection-set-and-cleanup-failure")
                            && command == "protection-set") { "failed" } else { "succeeded" },
                    "error": error,
                    "result": if command == "measure" {
                        json!({
                            "request": { "command": "measure", "arguments": { "channel": 2 } },
                            "data": { "channel": 2, "measurements": { "voltage": 5.002, "current": 0.125 } },
                            "metadata": { "source": "fixture" }
                        })
                    } else if command == "protection-status" {
                        json!({
                            "request": { "command": "protection-status" },
                            "data": { "protection": { "over_voltage_tripped": scenario.ends_with("protection-trip"), "over_current_tripped": false } },
                            "metadata": { "source": "fixture" }
                        })
                    } else if command == "safe-off" && live && scenario != "live-legacy-safe-off" {
                        let simulated = scenario == "live-simulated-safe-off";
                        let errors = if matches!(scenario, "live-success" | "live-step-failure") {
                            json!(["-222,\"Data out of range\""])
                        } else {
                            json!([])
                        };
                        let data = if cleanup_failed { json!(null) } else { fixture_safe_off_readback(Some(true), errors) };
                        if scenario == "live-safe-off-without-execution" {
                            json!({"data":data})
                        } else {
                            json!({
                                "execution":{"mode":if simulated {"simulate"} else {"live"},
                                    "dry_run":simulated,"hardware_touched":!simulated},
                                "data":data
                            })
                        }
                    } else { json!({ "ok": true }) }
                }
            })
            .to_string(),
        );
    }

    let request = accept_request(&listener);
    assert_eq!(
        (request.method.as_str(), request.path.as_str()),
        ("POST", "/stop")
    );
    record_event_if_requested("stop");
    write_response(request.stream, 200, r#"{"ok":true}"#);
}

pub(super) fn powers_worker_smoke_correlates_terminal_job() {
    run_powers_fixture_scenario("success").unwrap();
}

pub(super) fn powers_operation_failure_preserves_nonzero_worker_exit() {
    let error = run_powers_fixture_scenario("fatal-nonzero").unwrap_err();
    let message = error.to_string();

    assert!(matches!(
        error,
        PowersSmokeError::OperationAndWorkerExit { status, .. } if !status.success()
    ));
    assert!(message.contains("worker_fault"), "error: {message}");
    assert!(
        message.contains("simulated fatal failure"),
        "error: {message}"
    );
}

pub(super) fn powers_terminal_failure_preserves_diagnostic_detail() {
    let error = run_powers_fixture_scenario("terminal-failure").unwrap_err();
    let message = error.to_string();

    assert!(matches!(
        error,
        PowersSmokeError::TerminalFailure {
            ref status,
            ref detail,
        } if status == "failed"
            && detail.as_deref() == Some("connection_failed: simulated diagnostic failure")
    ));
    assert!(message.contains("connection_failed"), "error: {message}");
    assert!(
        message.contains("simulated diagnostic failure"),
        "error: {message}"
    );
}

pub(super) fn powers_runtime_action_succeeds() {
    let session = start_worker(
        &fixture_spec("powers-runtime-success"),
        Duration::from_secs(5),
    )
    .unwrap();
    let action = ActionId::new("set-output").unwrap();
    let result = run_powers_action(
        &session,
        &action,
        &json!({ "channel": 1, "voltage": 5.0 }),
        ExecutionMode::Simulate,
        Duration::from_secs(5),
    )
    .unwrap();
    assert_eq!(
        result,
        json!({
            "request": {
                "command": "set",
                "arguments": { "channel": 1, "voltage": 5.0 }
            }
        })
    );
    assert!(session.shutdown(Duration::from_secs(5)).unwrap().success());
}

pub(super) fn powers_set_output_step_outputs_reach_result_row() {
    let set_voltage_step_id = StepId::new("power-set-1").unwrap();
    let workflow = Workflow::new(vec![
        Step::new(
            set_voltage_step_id.clone(),
            StepKind::ToolAction {
                target: ToolInstanceId::new("powers-1").unwrap(),
                action: ActionId::new("set-output").unwrap(),
                arguments: json!({ "channel": 1, "voltage": 5.0 }),
                bindings: Default::default(),
            },
        ),
        Step::new(
            StepId::new("output-voltage").unwrap(),
            StepKind::Output {
                name: "voltage".to_owned(),
                value: InputValue::StepOutput(StepOutputReference::new(
                    set_voltage_step_id.clone(),
                    "/request/arguments/voltage",
                )),
            },
        ),
        Step::new(
            StepId::new("output-channel").unwrap(),
            StepKind::Output {
                name: "channel".to_owned(),
                value: InputValue::StepOutput(StepOutputReference::new(
                    set_voltage_step_id,
                    "/request/arguments/channel",
                )),
            },
        ),
    ])
    .unwrap();
    let run = run_simulated_workflow(
        &test_template(&workflow),
        &HashMap::from([(
            ToolInstanceId::new("powers-1").unwrap(),
            fixture_spec("powers-runtime-success"),
        )]),
        Duration::from_secs(5),
        Duration::from_secs(5),
        Duration::from_secs(5),
    )
    .unwrap();

    assert_eq!(run.result_rows().len(), 1);
    assert_eq!(
        run.result_rows()[0]
            .outputs()
            .iter()
            .map(|output| (output.name(), output.value()))
            .collect::<Vec<_>>(),
        [("voltage", &json!(5.0)), ("channel", &json!(1))]
    );
}

pub(super) fn powers_measure_voltage_and_current_reach_result_row() {
    let template = Template::from_json_str(
        &json!({
            "name": "Power Measure",
            "tool_instances": [{ "id": "powers-1", "tool": "powers", "setup": {} }],
            "workflow": {"interaction":{"enabled":false,"max_active_command_status":4096,"buffer":{"enabled":false,"mode":"fifo","overflow_policy":"fail-run"}}, "steps": [
                { "type": "tool-action", "id": "measure-1", "target": "powers-1",
                  "action": "measure", "arguments": { "channel": 2 } },
                { "type": "output", "id": "voltage-out", "name": "Voltage", "page": "Results",
                  "value": { "source": "step-output", "step_id": "measure-1",
                             "pointer": "/data/measurements/voltage" } },
                { "type": "output", "id": "current-out", "name": "Current", "page": "Results",
                  "value": { "source": "step-output", "step_id": "measure-1",
                             "pointer": "/data/measurements/current" } },
                { "type": "assert", "id": "current-safe",
                  "left": { "source": "step-output", "step_id": "measure-1",
                            "pointer": "/data/measurements/current" },
                  "operator": "less-than", "right": { "source": "literal", "value": 0.5 },
                  "message": "Current limit exceeded" }
            ] }
        })
        .to_string(),
    )
    .unwrap();
    assert_eq!(
        Template::from_json_str(&template.to_json_string().unwrap()).unwrap(),
        template
    );
    let run = run_simulated_workflow(
        &template,
        &HashMap::from([(
            ToolInstanceId::new("powers-1").unwrap(),
            fixture_spec("powers-workflow-measure"),
        )]),
        Duration::from_secs(5),
        Duration::from_secs(5),
        Duration::from_secs(5),
    )
    .unwrap();
    assert!(
        run.step_executions()
            .iter()
            .all(|execution| matches!(execution.result().outcome(), StepOutcome::Succeeded { .. }))
    );
    assert_eq!(run.result_rows().len(), 1);
    assert_eq!(
        run.result_rows()[0]
            .outputs()
            .iter()
            .map(|output| (output.name(), output.value()))
            .collect::<Vec<_>>(),
        [("Voltage", &json!(5.002)), ("Current", &json!(0.125))]
    );
}

pub(super) fn powers_set_output_binding_reaches_worker() {
    let template = Template::from_json_str(
        &json!({
            "name": "Power set output",
            "tool_instances": [{ "id": "powers-1", "tool": "powers", "setup": {} }],
            "workflow": {"interaction":{"enabled":false,"max_active_command_status":4096,"buffer":{"enabled":false,"mode":"fifo","overflow_policy":"fail-run"}}, "steps": [
                { "type": "set-variable", "id": "set-limit", "variable": "limit",
                  "value": { "source": "literal", "value": 0.2 } },
                { "type": "tool-action", "id": "power-set", "target": "powers-1",
                  "action": "set-output", "arguments": { "channel": 1, "voltage": 5.0 },
                  "bindings": { "current": { "source": "variable", "variable": "limit" } } },
                { "type": "tool-action", "id": "power-on", "target": "powers-1",
                  "action": "output-on", "arguments": { "channel": 1 } },
                { "type": "tool-action", "id": "power-off", "target": "powers-1",
                  "action": "output-off", "arguments": { "channel": 1 } }
            ] }
        })
        .to_string(),
    )
    .unwrap();
    let saved = template.to_json_string().unwrap();
    assert_eq!(Template::from_json_str(&saved).unwrap(), template);
    let run = run_simulated_workflow(
        &template,
        &HashMap::from([(
            ToolInstanceId::new("powers-1").unwrap(),
            fixture_spec("powers-workflow-set-output"),
        )]),
        Duration::from_secs(5),
        Duration::from_secs(5),
        Duration::from_secs(5),
    )
    .unwrap();
    assert!(
        run.step_executions()
            .iter()
            .all(|execution| matches!(execution.result().outcome(), StepOutcome::Succeeded { .. }))
    );
}

pub(super) fn manual_powers_status_reads_and_shuts_down() {
    let session = start_worker(&fixture_spec("manual-status"), Duration::from_secs(2)).unwrap();
    let status =
        normalized_protection_status_all(&session, ExecutionMode::Live, Duration::from_secs(2))
            .unwrap();
    assert!(!status.protection_tripped);
    assert_eq!(status.channels.len(), 2);
    assert!(session.shutdown(Duration::from_secs(2)).unwrap().success());
}

pub(super) fn manual_powers_clear_safe_offs_clears_rereads_and_shuts_down() {
    let session = start_worker(&fixture_spec("manual-clear"), Duration::from_secs(2)).unwrap();
    safe_off_all(&session, ExecutionMode::Live, Duration::from_secs(2)).unwrap();
    clear_protection(&session, 2, ExecutionMode::Live, Duration::from_secs(2)).unwrap();
    let status =
        normalized_protection_status_all(&session, ExecutionMode::Live, Duration::from_secs(2))
            .unwrap();
    assert!(!status.protection_tripped);
    assert!(
        status
            .channels
            .iter()
            .all(|channel| !channel.output_enabled)
    );
    assert!(session.shutdown(Duration::from_secs(2)).unwrap().success());
}

pub(super) fn manual_powers_clear_stops_after_safe_off_failure() {
    let session = start_worker(
        &fixture_spec("manual-safe-off-failure"),
        Duration::from_secs(2),
    )
    .unwrap();
    let error = safe_off_all(&session, ExecutionMode::Live, Duration::from_secs(2)).unwrap_err();
    assert!(error.to_string().contains("simulated Safe-Off failure"));
    assert!(session.shutdown(Duration::from_secs(2)).unwrap().success());
}

pub(super) fn manual_powers_clear_returns_unresolved_trip_without_retry() {
    let session = start_worker(
        &fixture_spec("manual-clear-unresolved"),
        Duration::from_secs(2),
    )
    .unwrap();
    safe_off_all(&session, ExecutionMode::Live, Duration::from_secs(2)).unwrap();
    clear_protection(&session, 2, ExecutionMode::Live, Duration::from_secs(2)).unwrap();
    let status =
        normalized_protection_status_all(&session, ExecutionMode::Live, Duration::from_secs(2))
            .unwrap();
    let channel = status
        .channels
        .iter()
        .find(|channel| channel.channel == 2)
        .unwrap();
    assert!(channel.over_voltage_tripped);
    assert!(status.protection_tripped);
    assert!(session.shutdown(Duration::from_secs(2)).unwrap().success());
}

pub(super) fn simulated_manual_powers_status_uses_simulation_context() {
    let session = start_worker(&fixture_spec("manual-sim-status"), Duration::from_secs(2)).unwrap();
    let status =
        normalized_protection_status_all(&session, ExecutionMode::Simulate, Duration::from_secs(2))
            .unwrap();
    assert!(!status.protection_tripped);
    assert_eq!(status.channels.len(), 2);
    assert!(session.shutdown(Duration::from_secs(2)).unwrap().success());
}

pub(super) fn simulated_manual_powers_clear_returns_plan_without_reread() {
    let session = start_worker(&fixture_spec("manual-sim-clear"), Duration::from_secs(2)).unwrap();
    safe_off_all(&session, ExecutionMode::Simulate, Duration::from_secs(2)).unwrap();
    let result =
        clear_protection(&session, 2, ExecutionMode::Simulate, Duration::from_secs(2)).unwrap();
    assert_eq!(result["execution"]["hardware_touched"], false);
    assert_eq!(result["data"]["plan"]["channel"], 2);
    assert!(session.shutdown(Duration::from_secs(2)).unwrap().success());
}

pub(super) fn powers_protection_status_asserts_untripped_result() {
    let template = Template::from_json_str(&json!({
        "name": "Power Protection Status",
        "tool_instances": [{ "id": "powers-1", "tool": "powers", "setup": {} }],
        "workflow": {"interaction":{"enabled":false,"max_active_command_status":4096,"buffer":{"enabled":false,"mode":"fifo","overflow_policy":"fail-run"}}, "steps": [
            { "type": "tool-action", "id": "protection-1", "target": "powers-1",
              "action": "protection-status", "arguments": { "channel": "all" } },
            { "type": "assert", "id": "assert-1",
              "left": { "source": "step-output", "step_id": "protection-1", "pointer": "/protection_tripped" },
              "operator": "equal", "right": { "source": "literal", "value": false },
              "message": "Power protection tripped" },
            { "type": "wait", "id": "later-1", "duration_ms": 0 }
        ] }
    }).to_string()).unwrap();
    let run = run_simulated_workflow(
        &template,
        &HashMap::from([(
            ToolInstanceId::new("powers-1").unwrap(),
            fixture_spec("powers-workflow-protection-status"),
        )]),
        Duration::from_secs(5),
        Duration::from_secs(5),
        Duration::from_secs(5),
    )
    .unwrap();
    let executions = run.step_executions();
    assert_eq!(executions.len(), 3);
    for execution in executions {
        assert!(matches!(
            execution.result().outcome(),
            StepOutcome::Succeeded { .. }
        ));
    }
    let StepOutcome::Succeeded { output } = executions[0].result().outcome() else {
        unreachable!()
    };
    assert_eq!(output["protection_tripped"], false);
    assert_eq!(output["request"]["command"], "protection-status");
    assert_eq!(output["metadata"]["source"], "fixture");
}

fn run_powers_fixture_scenario(scenario: &str) -> Result<(), PowersSmokeError> {
    // SAFETY: this harness runs scenarios sequentially and changes the variable only
    // while no fixture child or stdout reader thread is alive.
    unsafe { env::set_var(POWERS_FIXTURE_SCENARIO_ENV, scenario) };
    let result = run_powers_worker_smoke(
        env::current_exe().unwrap(),
        Duration::from_secs(5),
        Duration::from_secs(5),
        Duration::from_secs(5),
    );
    // SAFETY: the Worker session has completed cleanup before this mutation.
    unsafe { env::remove_var(POWERS_FIXTURE_SCENARIO_ENV) };
    result
}

fn record_event_if_requested(event: &str) {
    let Some(marker) = env::var_os(CLEANUP_MARKER_ENV) else {
        return;
    };
    let mut file = fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(marker)
        .unwrap();
    writeln!(file, "{event}").unwrap();
}

pub(super) fn powers_protection_setup_lifecycle() {
    let template = Template::from_json_str(
        &json!({
            "name": "Protection setup fixture",
            "tool_instances": [{"id":"powers-1","tool":"powers","setup":{"protection":{"channels":[
                {"channel":1,"ovp_voltage":5.5,"ocp":"on"}]}}}],
            "workflow":{"interaction":{"enabled":false,"max_active_command_status":4096,"buffer":{"enabled":false,"mode":"fifo","overflow_policy":"fail-run"}},"steps":[
                {"type":"tool-action","id":"set-1","target":"powers-1","action":"set-output",
                    "arguments":{"channel":1,"voltage":5.0}},
                {"type":"tool-action","id":"on-1","target":"powers-1","action":"output-on",
                    "arguments":{"channel":1}},
                {"type":"tool-action","id":"off-1","target":"powers-1","action":"output-off",
                    "arguments":{"channel":1}}
            ]}
        })
        .to_string(),
    )
    .unwrap();
    for (scenario, mode, expected) in [
        (
            "live-protection-success",
            ExecutionMode::Live,
            "safe-off\nprotection-status\nprotection-set\nset\noutput-on\noutput-off\nsafe-off\nstop\n",
        ),
        (
            "live-protection-trip",
            ExecutionMode::Live,
            "safe-off\nprotection-status\nsafe-off\nstop\n",
        ),
        (
            "live-protection-set-failure",
            ExecutionMode::Live,
            "safe-off\nprotection-status\nprotection-set\nsafe-off\nstop\n",
        ),
        (
            "live-protection-set-and-cleanup-failure",
            ExecutionMode::Live,
            "safe-off\nprotection-status\nprotection-set\nsafe-off\nstop\n",
        ),
        (
            "simulate-protection-success",
            ExecutionMode::Simulate,
            "safe-off\nprotection-status\nprotection-set\nset\noutput-on\noutput-off\nsafe-off\nstop\n",
        ),
        (
            "simulate-protection-trip",
            ExecutionMode::Simulate,
            "safe-off\nprotection-status\nsafe-off\nstop\n",
        ),
        (
            "simulate-protection-set-failure",
            ExecutionMode::Simulate,
            "safe-off\nprotection-status\nprotection-set\nsafe-off\nstop\n",
        ),
    ] {
        let marker = env::temp_dir().join(format!(
            "orchestrator-protection-{}-{scenario}",
            process::id()
        ));
        let _ = fs::remove_file(&marker);
        // SAFETY: fixture scenarios run sequentially and their sessions finish before removal.
        unsafe { env::set_var(CLEANUP_MARKER_ENV, &marker) };
        let specs = HashMap::from([(
            ToolInstanceId::new("powers-1").unwrap(),
            fixture_spec(scenario),
        )]);
        let result = run_workflow(
            &template,
            mode,
            &specs,
            Duration::from_secs(5),
            Duration::from_secs(5),
            Duration::from_secs(5),
        );
        unsafe { env::remove_var(CLEANUP_MARKER_ENV) };
        assert_eq!(fs::read_to_string(&marker).unwrap(), expected);
        fs::remove_file(&marker).unwrap();
        match scenario {
            "live-protection-success" | "simulate-protection-success" => {
                assert_eq!(result.unwrap().step_executions().len(), 3);
            }
            "live-protection-trip" | "simulate-protection-trip" => assert!(
                result
                    .unwrap_err()
                    .to_string()
                    .contains("Protection is already tripped and must be cleared before running.")
            ),
            "live-protection-set-failure" | "simulate-protection-set-failure" => assert!(
                result
                    .unwrap_err()
                    .to_string()
                    .contains("Protection Set failed")
            ),
            "live-protection-set-and-cleanup-failure" => {
                let message = result.unwrap_err().to_string();
                assert!(
                    message.contains("Protection Set failed") && message.contains("cleanup failed"),
                    "{message}"
                );
            }
            _ => unreachable!(),
        }
    }
}

pub(super) fn live_workflow_cleanup_lifecycle() {
    for scenario in [
        "simulate-step-failure",
        "live-success",
        "live-assert-failure",
        "live-for-failure",
        "live-step-failure",
        "live-cleanup-failure",
        "live-queue-failure",
        "live-readback-failure",
        "live-legacy-safe-off",
        "live-simulated-safe-off",
        "live-safe-off-without-execution",
        "live-both-failed",
        "live-startup-failure",
    ] {
        let marker = env::temp_dir().join(format!(
            "orchestrator-live-cleanup-{}-{scenario}",
            process::id()
        ));
        let _ = fs::remove_file(&marker);
        // SAFETY: fixtures run sequentially and all child sessions are reaped before removal.
        unsafe { env::set_var(CLEANUP_MARKER_ENV, &marker) };
        let mut steps = vec![
            Step::new(
                StepId::new("set-1").unwrap(),
                StepKind::ToolAction {
                    target: ToolInstanceId::new("powers-1").unwrap(),
                    action: ActionId::new("set-output").unwrap(),
                    arguments: json!({ "channel": 1, "voltage": 5.0 }),
                    bindings: Default::default(),
                },
            ),
            Step::new(
                StepId::new("on-1").unwrap(),
                StepKind::ToolAction {
                    target: ToolInstanceId::new("powers-1").unwrap(),
                    action: ActionId::new("output-on").unwrap(),
                    arguments: json!({ "channel": 1 }),
                    bindings: Default::default(),
                },
            ),
            Step::new(
                StepId::new("off-1").unwrap(),
                StepKind::ToolAction {
                    target: ToolInstanceId::new("powers-1").unwrap(),
                    action: ActionId::new("output-off").unwrap(),
                    arguments: json!({ "channel": 1 }),
                    bindings: Default::default(),
                },
            ),
        ];
        let mut specs = HashMap::from([(
            ToolInstanceId::new("powers-1").unwrap(),
            fixture_spec(if scenario == "live-for-failure" {
                "live-assert-failure"
            } else {
                scenario
            }),
        )]);
        if matches!(scenario, "live-assert-failure" | "live-for-failure") {
            steps.insert(
                2,
                Step::new(
                    StepId::new("measure-1").unwrap(),
                    StepKind::ToolAction {
                        target: ToolInstanceId::new("meters-1").unwrap(),
                        action: ActionId::new("measure").unwrap(),
                        arguments: json!({}),
                        bindings: Default::default(),
                    },
                ),
            );
            steps.insert(
                3,
                Step::new(
                    StepId::new("assert-1").unwrap(),
                    StepKind::Assert {
                        condition: Expression::new(
                            ExpressionOperand::StepOutput(StepOutputReference::new(
                                StepId::new("measure-1").unwrap(),
                                "/value",
                            )),
                            ExpressionOperator::GreaterThanOrEqual,
                            ExpressionOperand::Literal(json!(4.9)),
                        ),
                        message: "Voltage is below minimum.".to_owned(),
                    },
                ),
            );
            specs.insert(
                ToolInstanceId::new("meters-1").unwrap(),
                fixture_spec("meters-runtime-measure"),
            );
        }
        if scenario == "live-for-failure" {
            let mut body = steps.drain(2..4).collect::<Vec<_>>();
            body.push(Step::new(
                StepId::new("body-later").unwrap(),
                StepKind::Wait { duration_ms: 0 },
            ));
            steps.insert(
                2,
                Step::new(
                    StepId::new("sweep").unwrap(),
                    StepKind::For {
                        variable: VariableId::new("x").unwrap(),
                        range: NumericRange::new(1.into(), 3.into(), 1.into()).unwrap(),
                        body,
                    },
                ),
            );
        }
        if scenario == "live-startup-failure" {
            steps.push(Step::new(
                StepId::new("measure-1").unwrap(),
                StepKind::ToolAction {
                    target: ToolInstanceId::new("meters-1").unwrap(),
                    action: ActionId::new("measure").unwrap(),
                    arguments: json!({}),
                    bindings: Default::default(),
                },
            ));
            specs.insert(
                ToolInstanceId::new("meters-1").unwrap(),
                fixture_spec("exit-before-ready"),
            );
        }
        let workflow = Workflow::new(steps).unwrap();
        let mut cleanup = Vec::new();
        let result = run_workflow_with_events(
            &test_template(&workflow),
            if scenario.starts_with("simulate") {
                ExecutionMode::Simulate
            } else {
                ExecutionMode::Live
            },
            &specs,
            Duration::from_secs(5),
            Duration::from_secs(5),
            Duration::from_secs(5),
            |event| {
                if let WorkflowRunEvent::PowersCleanup {
                    instance,
                    result,
                    failure,
                } = event
                {
                    assert_eq!(instance.as_str(), "powers-1");
                    cleanup.push((result, failure));
                }
            },
        );
        let [(off, cleanup_failure)] = cleanup.as_slice() else {
            panic!("{cleanup:?}");
        };
        match scenario {
            "live-success" | "live-step-failure" => {
                let Some(PowersSafeOffResult::Live(readback)) = off else {
                    panic!("{off:?}");
                };
                assert_eq!(readback.output_off_confirmed, Some(true));
                assert_eq!(
                    readback.instrument_errors,
                    Some(vec!["-222,\"Data out of range\"".into()])
                );
                assert!(cleanup_failure.is_none());
            }
            "simulate-step-failure" => assert_eq!(*off, Some(PowersSafeOffResult::Simulated)),
            "live-cleanup-failure"
            | "live-both-failed"
            | "live-readback-failure"
            | "live-queue-failure" => {
                let Some(PowersSafeOffResult::Live(readback)) = off else {
                    panic!("{off:?}");
                };
                let confirmed = match scenario {
                    "live-queue-failure" => Some(true),
                    "live-readback-failure" => None,
                    _ => Some(false),
                };
                assert_eq!(readback.output_off_confirmed, confirmed);
                if confirmed != Some(false) {
                    assert!(readback.instrument_errors.is_none());
                }
                assert!(cleanup_failure.is_some());
            }
            "live-legacy-safe-off"
            | "live-simulated-safe-off"
            | "live-safe-off-without-execution" => {
                assert!(off.is_none(), "{scenario}: {off:?}");
                assert!(cleanup_failure.is_some());
            }
            _ => {}
        }
        // SAFETY: lifecycle has reaped all child sessions.
        unsafe { env::remove_var(CLEANUP_MARKER_ENV) };
        let events = fs::read_to_string(&marker).unwrap();
        fs::remove_file(&marker).unwrap();
        match scenario {
            "live-success" => {
                let run = result.unwrap();
                let results = run.step_executions();
                assert_eq!(results.len(), 3);
                assert!(
                    results
                        .iter()
                        .all(|r| matches!(r.outcome(), StepOutcome::Succeeded { .. }))
                );
                assert_eq!(events, "set\noutput-on\noutput-off\nsafe-off\nstop\n");
            }
            "live-assert-failure" | "live-for-failure" => {
                let run = result.unwrap();
                let results = run.step_executions();
                assert_eq!(
                    results.len(),
                    if scenario == "live-for-failure" { 5 } else { 4 }
                );
                if scenario == "live-for-failure" {
                    let occurrence = results[3].for_iteration().unwrap();
                    assert_eq!(occurrence.for_step_id().as_str(), "sweep");
                    assert_eq!(occurrence.iteration_index(), 0);
                    assert_eq!(results[4].step_id().as_str(), "sweep");
                    assert!(results[4].for_iteration().is_none());
                    assert!(
                        matches!(results[4].outcome(), StepOutcome::Failed { message }
                        if message.contains("assert-1") && message.contains("Voltage is below minimum."))
                    );
                    assert!(run.result_rows().is_empty());
                }
                assert!(
                    results[..3]
                        .iter()
                        .all(|r| matches!(r.outcome(), StepOutcome::Succeeded { .. }))
                );
                assert_eq!(results[3].step_id().as_str(), "assert-1");
                assert_eq!(
                    results[3].outcome(),
                    &StepOutcome::Failed {
                        message: "Voltage is below minimum.".to_owned(),
                    }
                );
                assert_eq!(events, "set\noutput-on\nsafe-off\nstop\n");
            }
            "simulate-step-failure" | "live-step-failure" => {
                let run = result.unwrap();
                let results = run.step_executions();
                assert_eq!(results.len(), 2);
                assert!(
                    matches!(results[1].outcome(), StepOutcome::Failed { message } if message.contains("fixture action failure"))
                );
                assert_eq!(events, "set\noutput-on\nsafe-off\nstop\n");
            }
            "live-startup-failure" => {
                assert!(matches!(
                    result,
                    Err(WorkflowRunError::WorkerStartup { .. })
                ));
                assert_eq!(events, "safe-off\nstop\n");
            }
            _ => {
                let error = result.unwrap_err();
                assert!(matches!(error, WorkflowRunError::SafetyCleanup { .. }));
                let message = error.to_string();
                let classification = match scenario {
                    "live-queue-failure" => "Error Queue",
                    "live-readback-failure"
                    | "live-legacy-safe-off"
                    | "live-simulated-safe-off"
                    | "live-safe-off-without-execution" => "OFF could not be confirmed",
                    _ => "still ON",
                };
                assert!(
                    message.contains("Power safety cleanup failed")
                        && message.contains(classification),
                    "{message}"
                );
                if scenario == "live-both-failed" {
                    assert!(
                        message.contains("on-1") && message.contains("fixture action failure"),
                        "{message}"
                    );
                }
                assert!(events.ends_with("safe-off\nstop\n"), "{events}");
            }
        }
    }
    // Stop during an in-flight action/startup must await its result and still perform safety cleanup.
    for scenario in [
        "live-stop-success",
        "live-stop-step-failure",
        "live-stop-cleanup-failure",
        "live-stop-startup",
    ] {
        use orchestrator_tool::run::{RunOptions, WorkflowStop, run_workflow_streaming_controlled};
        let marker = env::temp_dir().join(format!("orchestrator-{}-{scenario}", process::id()));
        let _ = fs::remove_file(&marker);
        // SAFETY: all cases and child sessions in this harness run sequentially.
        unsafe {
            env::set_var(CLEANUP_MARKER_ENV, &marker);
        }
        let template = Template::from_json_str(&json!({"name":"Stop cleanup",
            "tool_instances":[{"id":"powers-1","tool":"powers","setup":{}}], "workflow":{"interaction":{"enabled":false,"max_active_command_status":4096,"buffer":{"enabled":false,"mode":"fifo","overflow_policy":"fail-run"}},"steps":[
                {"type":"tool-action","id":"set","target":"powers-1","action":"set-output","arguments":{"channel":1,"voltage":5.0}},
                {"type":"tool-action","id":"on","target":"powers-1","action":"output-on","arguments":{"channel":1}},
                {"type":"wait","id":"after","duration_ms":0}
            ]}}).to_string()).unwrap();
        let stop = WorkflowStop::default();
        let requester = {
            let stop = stop.clone();
            let marker = marker.clone();
            thread::spawn(move || {
                let deadline = std::time::Instant::now() + Duration::from_secs(3);
                let expected = if scenario == "live-stop-startup" {
                    "starting"
                } else {
                    "output-on"
                };
                while !fs::read_to_string(&marker)
                    .unwrap_or_default()
                    .contains(expected)
                {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "fixture never reached {expected}"
                    );
                    thread::sleep(Duration::from_millis(2));
                }
                stop.request();
            })
        };
        let mut steps = Vec::new();
        let result = run_workflow_streaming_controlled(
            &template,
            ExecutionMode::Live,
            &HashMap::from([(
                ToolInstanceId::new("powers-1").unwrap(),
                fixture_spec(scenario),
            )]),
            Duration::from_secs(3),
            Duration::from_secs(3),
            Duration::from_secs(3),
            None,
            RunOptions {
                workflow_stop: stop,
                ..Default::default()
            },
            |event| {
                if let orchestrator_tool::workflow::WorkflowRunEvent::StepCompleted(step) = event {
                    steps.push(step);
                }
            },
            |_| false,
        );
        requester.join().unwrap();
        // SAFETY: the run has reaped its child process.
        unsafe {
            env::remove_var(CLEANUP_MARKER_ENV);
        }
        let events = fs::read_to_string(&marker).unwrap();
        fs::remove_file(marker).unwrap();
        assert!(!steps.iter().any(|s| s.step_id().as_str() == "after"));
        if scenario == "live-stop-startup" {
            assert!(steps.is_empty());
            assert_eq!(events, "starting\nsafe-off\nstop\n");
        } else {
            assert_eq!(steps.len(), 2);
            assert_eq!(events, "set\noutput-on\nsafe-off\nstop\n");
        }
        match scenario {
            "live-stop-step-failure" => {
                let summary = result.unwrap();
                assert!(!summary.stopped());
                assert!(
                    summary
                        .failure()
                        .unwrap()
                        .contains("fixture action failure")
                );
            }
            "live-stop-cleanup-failure" => assert!(
                result
                    .unwrap_err()
                    .to_string()
                    .contains("fixture cleanup failure")
            ),
            _ => assert!(result.unwrap().stopped()),
        }
    }
}

pub(super) fn multiple_powers_cleanup_attempts_every_session() {
    let marker = env::temp_dir().join(format!("orchestrator-multiple-powers-{}", process::id()));
    let _ = fs::remove_file(&marker);
    // SAFETY: fixtures run sequentially and child sessions are reaped before removal.
    unsafe { env::set_var(CLEANUP_MARKER_ENV, &marker) };
    let workflow = Workflow::new(
        vec!["powers-1", "powers-2"]
            .into_iter()
            .map(|id| {
                Step::new(
                    StepId::new(id).unwrap(),
                    StepKind::ToolAction {
                        target: ToolInstanceId::new(id).unwrap(),
                        action: ActionId::new("unsupported").unwrap(),
                        arguments: json!({"channel": 1}),
                        bindings: Default::default(),
                    },
                )
            })
            .collect(),
    )
    .unwrap();
    let instances = ["powers-1", "powers-2"]
        .into_iter()
        .map(|id| ToolInstance {
            display_name: None,
            id: ToolInstanceId::new(id).unwrap(),
            tool: orchestrator_tool::tool::ToolId::powers(),
            setup: ToolSetup::Powers(orchestrator_tool::powers_setup::PowersSetup::default()),
        })
        .collect();
    let template = Template::new("Two Powers".to_owned(), instances, workflow).unwrap();
    // An unsupported action fails before dispatch; cleanup must still reach both workers.
    let specs = template
        .tool_instances()
        .iter()
        .map(|instance| {
            (
                instance.id.clone(),
                fixture_spec("live-multi-cleanup-failure"),
            )
        })
        .collect();
    let result = run_workflow(
        &template,
        ExecutionMode::Live,
        &specs,
        Duration::from_secs(5),
        Duration::from_secs(5),
        Duration::from_secs(5),
    );
    // SAFETY: all child sessions have been reaped.
    unsafe { env::remove_var(CLEANUP_MARKER_ENV) };
    let events = fs::read_to_string(&marker).unwrap();
    fs::remove_file(marker).unwrap();
    let error = result.unwrap_err();
    assert!(matches!(
        &error,
        WorkflowRunError::SafetyCleanup { instance, .. }
            if instance == &ToolInstanceId::new("powers-1").unwrap()
    ));
    let message = error.to_string();
    assert!(
        message.contains("powers-1 Power safety cleanup failed"),
        "{message}"
    );
    assert_eq!(
        events.lines().filter(|event| *event == "safe-off").count(),
        2,
        "{events}"
    );
    assert_eq!(
        events.lines().filter(|event| *event == "stop").count(),
        2,
        "{events}"
    );
}
