use super::*;

pub(super) fn run_scopes_fixture(scenario: &str) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let run_id = "scopes-fixture";
    let edge_readback = scenario.starts_with("scopes-readback-");
    let setup_mismatch = scenario == "scopes-setup-readback-mismatch";
    let mut jobs = 0;
    let mut status_reads = 0;
    let model = match scenario {
        "scopes-wrong-model" => "unknown",
        "scopes-readback-tds2024b" => "tektronix-tds2024b",
        "scopes-readback-tbs1052b" => "tektronix-tbs1052b",
        _ => "keysight-dsox4024a",
    };
    print_json_line(
        &json!({"schema_version":3,"event":"ready","run_id":run_id,
        "status_url":format!("{base}/status"),"command_url":format!("{base}/command"),
        "stop_url":format!("{base}/stop")})
        .to_string(),
    );
    loop {
        let request = accept_request(&listener);
        match request.path.as_str() {
            "/status" => {
                status_reads += 1;
                let reported_model =
                    if scenario == "scopes-readback-changed-model" && status_reads > 1 {
                        "tektronix-tds2024b"
                    } else {
                        model
                    };
                write_response(request.stream, 200, &json!({"schema_version":3,
                    "service":"scopes-tool","run_id":run_id,"status":"ready","fatal_error":null,
                    "mode":if scenario == "scopes-dynamic-failed" {"live"} else {"simulate"},
                    "model":reported_model,
                    "resource":if scenario == "scopes-dynamic-failed" {json!("USB::SCOPE")} else {json!(null)}}).to_string());
            }
            "/command" => {
                assert_ne!(
                    scenario, "scopes-readback-changed-model",
                    "Set must not run with an unverified identity"
                );
                jobs += 1;
                let worker_job_id = format!("job-{jobs}");
                let command: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
                let query = command["arguments"]["query"] == true;
                assert_eq!(command["schema_version"], 3);
                assert!(command.get("context").is_none());
                if scenario == "scopes-dynamic-failed" {
                    assert_eq!(command["command"], "measure");
                    assert_eq!(command["arguments"]["channel"], 99);
                }
                if scenario == "scopes-setup-failed" || setup_mismatch {
                    assert_eq!(command["command"], "channel-invert");
                    if setup_mismatch && jobs == 2 {
                        assert_eq!(command["arguments"], json!({"channel":2,"query":true}));
                    } else {
                        assert_eq!(jobs, 1);
                        assert_eq!(command["arguments"], json!({"channel":2,"on":true}));
                    }
                }
                if edge_readback {
                    assert_eq!(command["command"], "trigger-edge");
                    match jobs {
                        1 => assert_eq!(
                            command["arguments"],
                            json!({"source_channel":1,"level":1.0,"slope":"positive"})
                        ),
                        2 => assert_eq!(command["arguments"], json!({"query":true})),
                        _ => panic!("unexpected Scopes setting job"),
                    }
                }
                if scenario.starts_with("scopes-measure-") {
                    assert_eq!(command["command"], "measure");
                    assert_eq!(command["arguments"], json!({"channel":1,"item":"vpp"}));
                }
                if scenario.starts_with("scopes-single-wait-") {
                    assert_eq!(command["command"], "single-wait");
                    assert_eq!(
                        command["arguments"],
                        json!({"trigger_timeout_ms":3000,"trigger_poll_interval_ms":100})
                    );
                }
                if scenario == "scopes-rejected" {
                    write_response(request.stream, 429, &json!({"schema_version":3,"status":"rejected",
                        "command":command["command"],"job_id":command["job_id"],"reason":"queue_full"}).to_string());
                    continue;
                }
                write_response(request.stream, 202, &json!({"schema_version":3,"status":"accepted",
                    "command":command["command"],"job_id":if scenario == "scopes-admission-mismatch" {json!("other-job")} else {command["job_id"].clone()},"worker_job_id":worker_job_id}).to_string());
                if scenario == "scopes-timeout" || (query && scenario == "scopes-readback-timeout")
                {
                    continue;
                }
                thread::sleep(Duration::from_millis(50));
                let single_wait = scenario.starts_with("scopes-single-wait-");
                let measure = scenario.starts_with("scopes-measure-");
                let measure_invalid = measure && scenario != "scopes-measure-valid";
                let instrument_error = scenario.ends_with("-instrument-error");
                let failed = single_wait
                    || measure_invalid
                    || (query && scenario == "scopes-readback-query-failed")
                    || matches!(
                        scenario,
                        "scopes-failed" | "scopes-setup-failed" | "scopes-dynamic-failed"
                    );
                let cancelled = scenario == "scopes-cancelled";
                let result = if single_wait {
                    json!({
                        "operation":"single-wait", "outcome":"timeout",
                        "timed_out":true, "forced":false,
                        "force_on_timeout":false, "capture_allowed":false,
                        "error":null, "system_error":{
                            "code":if instrument_error {-222} else {0},
                            "is_error":instrument_error
                        }
                    })
                } else if measure {
                    json!({
                        "item":"vpp","channel":1,"unit":"V",
                        "value":if measure_invalid {json!(null)} else {json!(3.3)},
                        "valid":!measure_invalid,
                        "raw_value":if measure_invalid {"9.9E+37"} else {"3.3"},
                        "reason":if measure_invalid {json!("invalid measurement sentinel")} else {json!(null)},
                        "system_error":{"code":if instrument_error {-222} else {0},
                                        "is_error":instrument_error}
                    })
                } else if edge_readback {
                    if query && scenario == "scopes-readback-missing" {
                        json!({"operation":"query","source_channel":1,"slope":"positive"})
                    } else if query && scenario != "scopes-readback-wrong-operation" {
                        json!({"operation":"query","source_channel":1,"level_volts":1.04,"slope":"positive"})
                    } else {
                        json!({"operation":"set","source_channel":1,"level_volts":1.0,"slope":"positive","commands":["set trigger"]})
                    }
                } else if setup_mismatch {
                    json!({"operation":if query {"query"} else {"set"}, "channel":2,"invert":!query})
                } else {
                    json!({"value":3.3,"unit":"V"})
                };
                let error = if single_wait || measure_invalid {
                    json!({"category":"execution","code":"job_failed",
                        "message":"job failed","details":{}})
                } else if failed || cancelled {
                    json!({"message":"fixture failure"})
                } else {
                    json!(null)
                };
                print_json_line(&json!({"schema_version":3,"event":"job_finished","run_id":if scenario == "scopes-event-mismatch" {"other-run"} else {run_id},
                    "command":command["command"],"job_id":command["job_id"],
                    "worker_job_id":if scenario == "scopes-mismatch" {"wrong-job"} else {&worker_job_id},
                    "state":if cancelled {"cancelled"} else if failed {"failed"} else {"succeeded"},
                    "ok":!failed && !cancelled,
                    "exit_code":if single_wait || measure_invalid {1} else if failed || cancelled {3} else {0},
                    "error":error, "result":result,"files":[]}).to_string());
            }
            "/stop" => {
                write_response(request.stream, 200, r#"{"ok":true}"#);
                return;
            }
            other => panic!("unexpected Scopes request {other}"),
        }
    }
}

pub(super) fn scopes_worker_protocol_cases() {
    use orchestrator_tool::adapters::scopes;
    for scenario in [
        "scopes-success",
        "scopes-rejected",
        "scopes-failed",
        "scopes-cancelled",
        "scopes-mismatch",
        "scopes-timeout",
        "scopes-wrong-model",
        "scopes-admission-mismatch",
        "scopes-event-mismatch",
    ] {
        let spec = fixture_spec(scenario);
        let session = start_worker(&spec, Duration::from_secs(5)).unwrap();
        if scenario == "scopes-success" {
            assert!(
                scopes::validate_session(
                    &session,
                    ExecutionMode::Live,
                    &spec,
                    Duration::from_secs(2)
                )
                .unwrap_err()
                .contains("canonical model ID is missing")
            );
        }
        let identity = scopes::validate_session(
            &session,
            ExecutionMode::Simulate,
            &spec,
            Duration::from_secs(2),
        );
        if scenario == "scopes-wrong-model" {
            assert!(identity.is_err());
        } else {
            identity.unwrap();
            let started = Instant::now();
            let outcome = scopes::run_action(
                &session,
                &ActionId::new("measure").unwrap(),
                &json!({"channel":1,"item":"vpp"}),
                None,
                Duration::from_millis(300),
            );
            if scenario == "scopes-success" {
                assert_eq!(outcome.unwrap()["value"], 3.3);
                assert!(started.elapsed() >= Duration::from_millis(50));
            } else {
                let error = outcome.unwrap_err();
                if scenario == "scopes-rejected" {
                    assert!(error.contains("queue_full"), "{error}");
                }
            }
        }
        let shutdown = session.shutdown(Duration::from_secs(2));
        if scenario == "scopes-mismatch" {
            assert!(
                shutdown.is_err(),
                "conflicting Job identity must not pass Worker shutdown"
            );
        } else {
            assert!(shutdown.unwrap().success(), "scenario: {scenario}");
        }
    }
}

pub(super) fn scopes_single_wait_timeout_branches_and_instrument_error_fails() {
    let template = Template::from_json_str(
        &json!({
            "name":"Scope timeout branch",
            "tool_instances":[{"id":"scope","tool":"scopes","setup":{}}],
            "workflow":{"interaction":{"enabled":false,"max_active_command_status":4096,"buffer":{"enabled":false,"mode":"fifo","overflow_policy":"fail-run"}},
                "steps":[
                    {"type":"tool-action","id":"trigger","target":"scope",
                     "action":"single-wait","arguments":{
                         "trigger_timeout_ms":3000,"trigger_poll_interval_ms":100
                     }},
                    {"type":"if","id":"choose",
                     "left":{"source":"step-output","step_id":"trigger","pointer":"/timed_out"},
                     "operator":"equal","right":{"source":"literal","value":true},
                     "then_steps":[{"type":"wait","id":"timeout-path","duration_ms":0}],
                     "else_steps":[{"type":"wait","id":"natural-path","duration_ms":0}]}
                ]}
        })
        .to_string(),
    )
    .unwrap();
    for (scenario, clean) in [
        ("scopes-single-wait-timeout", true),
        ("scopes-single-wait-instrument-error", false),
    ] {
        let run = run_simulated_workflow(
            &template,
            &HashMap::from([(
                ToolInstanceId::new("scope").unwrap(),
                fixture_spec(scenario),
            )]),
            Duration::from_secs(5),
            Duration::from_millis(5),
            Duration::from_secs(2),
        )
        .unwrap();
        let executions = run.step_executions();
        if clean {
            assert!(matches!(
                executions[0].outcome(),
                StepOutcome::Succeeded { output }
                    if output["outcome"] == "timeout" && output["timed_out"] == true
            ));
            assert!(
                executions
                    .iter()
                    .any(|step| step.step_id().as_str() == "timeout-path")
            );
            assert!(
                !executions
                    .iter()
                    .any(|step| step.step_id().as_str() == "natural-path")
            );
            assert!(
                executions
                    .iter()
                    .all(|step| matches!(step.outcome(), StepOutcome::Succeeded { .. }))
            );
        } else {
            assert!(matches!(
                executions[0].outcome(),
                StepOutcome::Failed { .. }
            ));
            assert!(
                !executions
                    .iter()
                    .any(|step| step.step_id().as_str() == "choose")
            );
            assert!(
                !executions
                    .iter()
                    .any(|step| step.step_id().as_str() == "timeout-path")
            );
        }
    }
}

pub(super) fn scopes_measure_invalid_branches_only_when_confirmed() {
    let template = Template::from_json_str(
        &json!({
            "name":"Scope Measure validity branch",
            "tool_instances":[{"id":"scope","tool":"scopes","setup":{}}],
            "workflow":{"interaction":{"enabled":false,"max_active_command_status":4096,"buffer":{"enabled":false,"mode":"fifo","overflow_policy":"fail-run"}},
                "steps":[
                    {"type":"tool-action","id":"reading","target":"scope",
                     "action":"measure","arguments":{"channel":1,"item":"vpp"}},
                    {"type":"if","id":"choose",
                     "left":{"source":"step-output","step_id":"reading","pointer":"/valid"},
                     "operator":"equal","right":{"source":"literal","value":false},
                     "then_steps":[{"type":"wait","id":"invalid-path","duration_ms":0}],
                     "else_steps":[{"type":"wait","id":"valid-path","duration_ms":0}]}
                ]}
        })
        .to_string(),
    )
    .unwrap();

    for (scenario, expected_valid) in [
        ("scopes-measure-valid", Some(true)),
        ("scopes-measure-invalid", Some(false)),
        ("scopes-measure-instrument-error", None),
    ] {
        let run = run_simulated_workflow(
            &template,
            &HashMap::from([(
                ToolInstanceId::new("scope").unwrap(),
                fixture_spec(scenario),
            )]),
            Duration::from_secs(5),
            Duration::from_secs(3),
            Duration::from_secs(2),
        )
        .unwrap();
        let executions = run.step_executions();
        if let Some(valid) = expected_valid {
            assert!(matches!(
                executions[0].outcome(),
                StepOutcome::Succeeded { output }
                    if output["valid"] == valid
                       && output["value"].is_null() == !valid
            ));
            let chosen = if valid { "valid-path" } else { "invalid-path" };
            let skipped = if valid { "invalid-path" } else { "valid-path" };
            assert!(
                executions
                    .iter()
                    .any(|step| step.step_id().as_str() == chosen)
            );
            assert!(
                !executions
                    .iter()
                    .any(|step| step.step_id().as_str() == skipped)
            );
        } else {
            assert!(matches!(
                executions[0].outcome(),
                StepOutcome::Failed { .. }
            ));
            for branch in ["choose", "valid-path", "invalid-path"] {
                assert!(
                    !executions
                        .iter()
                        .any(|step| step.step_id().as_str() == branch)
                );
            }
        }
    }
}

pub(super) fn scopes_setup_failure_stops_workflow() {
    let template = Template::from_json_str(&json!({"name":"Setup failure",
        "tool_instances":[{"id":"scope","tool":"scopes","setup":{"channels":[{"channel":2,"invert":true}]}}],
        "workflow":{"interaction":{"enabled":false,"max_active_command_status":4096,"buffer":{"enabled":false,"mode":"fifo","overflow_policy":"fail-run"}},"steps":[{"type":"tool-action","id":"read","target":"scope","action":"measure",
            "arguments":{"channel":2,"item":"vpp"}}]}}).to_string()).unwrap();
    for (scenario, detail) in [
        ("scopes-setup-failed", "fixture failure"),
        (
            "scopes-setup-readback-mismatch",
            "readback mismatch for invert",
        ),
    ] {
        let error = run_simulated_workflow(
            &template,
            &HashMap::from([(
                ToolInstanceId::new("scope").unwrap(),
                fixture_spec(scenario),
            )]),
            Duration::from_secs(5),
            Duration::from_secs(2),
            Duration::from_secs(2),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("scope Scopes Setup failed"), "{error}");
        assert!(
            error.contains("channel 2") && error.contains(detail),
            "{error}"
        );
    }
}

pub(super) fn scopes_workflow_setting_readback_controls_step_outcome() {
    let template = Template::from_json_str(&json!({"name":"Edge Trigger readback",
        "tool_instances":[{"id":"scope","tool":"scopes","setup":{}}],
        "workflow":{"interaction":{"enabled":false,"max_active_command_status":4096,"buffer":{"enabled":false,"mode":"fifo","overflow_policy":"fail-run"}},"steps":[
            {"type":"set-variable","id":"level-value","variable":"level","value":{"source":"literal","value":1.0}},
            {"type":"tool-action","id":"trigger","target":"scope","action":"trigger-edge",
                "arguments":{"source_channel":1,"slope":"positive"},
                "bindings":{"level":{"source":"variable","variable":"level"}}},
            {"type":"wait","id":"after-trigger","duration_ms":0}
        ]}}).to_string()).unwrap();
    for (scenario, model, failure) in [
        ("scopes-readback-tds2024b", "tektronix-tds2024b", None),
        ("scopes-readback-tbs1052b", "tektronix-tbs1052b", None),
        (
            "scopes-readback-mismatch",
            "keysight-dsox4024a",
            Some("mismatch for level_volts: expected 1.0, got 1.04 (tolerance 1e-3)"),
        ),
        (
            "scopes-readback-changed-model",
            "keysight-dsox4024a",
            Some("Worker identity changed after startup"),
        ),
        (
            "scopes-readback-wrong-operation",
            "keysight-dsox4024a",
            Some("readback expected operation \"query\", got \"set\""),
        ),
        (
            "scopes-readback-missing",
            "keysight-dsox4024a",
            Some("readback is missing level_volts"),
        ),
        (
            "scopes-readback-query-failed",
            "keysight-dsox4024a",
            Some("fixture failure"),
        ),
        (
            "scopes-readback-timeout",
            "keysight-dsox4024a",
            Some("no terminal"),
        ),
    ] {
        let spec = WorkerLaunchSpec::new(
            env::current_exe().unwrap(),
            [FIXTURE_ARGUMENT, scenario, "--model", model],
        )
        .with_manifest(fixture_manifest(scenario));
        let run = run_simulated_workflow(
            &template,
            &HashMap::from([(ToolInstanceId::new("scope").unwrap(), spec)]),
            Duration::from_secs(5),
            Duration::from_secs(1),
            Duration::from_secs(2),
        )
        .unwrap();
        let steps = run.step_executions();
        assert_eq!(steps[1].step_id().as_str(), "trigger");
        if let Some(detail) = failure {
            assert!(
                matches!(steps[1].outcome(), StepOutcome::Failed { message } if message.contains("readback") && message.contains(detail)),
                "{scenario}: {:?}",
                steps[1].outcome()
            );
            assert_eq!(steps.len(), 2);
        } else {
            assert!(
                matches!(steps[1].outcome(), StepOutcome::Succeeded { output }
                if output == &json!({"operation":"set","source_channel":1,"level_volts":1.0,"slope":"positive","commands":["set trigger"]}))
            );
            assert_eq!(steps[2].step_id().as_str(), "after-trigger");
        }
    }
}
