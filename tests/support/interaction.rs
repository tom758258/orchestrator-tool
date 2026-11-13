//! Real process/HTTP/JSONL boundaries; the opt-in path uses the actual Meters CLI in SIM.
use super::*;
use orchestrator_tool::{
    background::BackgroundStore,
    run::{RunOptions, WorkflowStop, run_workflow_streaming_controlled},
};
use serde_json::Value;
use std::sync::Arc;

pub fn fixture(scenario: &str) {
    let arguments: Vec<_> = env::args_os().collect();
    let marker = |flag: &str| {
        arguments
            .windows(2)
            .find(|args| args[0] == flag)
            .map(|args| &args[1])
    };
    if let Some(path) = marker("--launch-marker") {
        fs::write(path, b"started").unwrap();
    }
    // Hold only the command response, leaving the stop endpoint responsive.
    let delayed = matches!(
        scenario,
        "stop-before-ack" | "failure-before-ack" | "timeout-before-ack" | "result-before-ack"
    );
    let mut held_response: Option<(Instant, TestRequest, String)> = None;
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let emit = |mut value: Value| {
        value["schema_version"] = json!(3);
        value["timestamp_utc"] = json!(FIXTURE_UTC);
        value["run_id"] = json!("interaction-run");
        println!("{value}");
        io::stdout().flush().unwrap();
    };
    emit(
        json!({"event":"ready","features":{"common.streaming":{"contract_version":1,"lifecycles":["run_bound"]}},
        "stream":{"lifecycle":"run_bound"},"status_url":format!("{base}/status"),"command_url":format!("{base}/command"),"stop_url":format!("{base}/stop")}),
    );
    let status = |state| {
        emit(
            json!({"event":"status","worker_state":"running","fatal_error":null,"stream":{"lifecycle":"run_bound","state":state}}),
        )
    };
    status("waiting");
    let started = Instant::now();
    let mut active = false;
    let mut pending: Option<(Instant, Value)> = None;
    let mut captured = 0;
    let mut stopped = false;
    let limit = if matches!(scenario, "loop" | "skip-result") {
        3
    } else if scenario == "slot-busy" {
        2
    } else {
        1
    };
    while captured < limit || held_response.is_some() {
        if !active && started.elapsed() >= Duration::from_millis(30) {
            active = true;
            status("active");
        }
        if let Ok((stream, _)) = listener.accept() {
            let mut request = read_request(stream);
            let stop = request.path == "/stop";
            let body: Value = serde_json::from_slice(&request.body).unwrap_or(json!({}));
            let rejected = !stop && scenario == "rejected";
            if !stop {
                if let Some(path) = marker("--command-marker") {
                    fs::write(path, b"received").unwrap();
                }
                assert!(active);
                assert!(
                    pending.is_none(),
                    "Orchestrator must not queue an overlapping trigger"
                );
                assert_eq!(body["command"], "software_trigger");
                assert!(body["arguments"]["metadata"]["orchestrator_command_id"].is_string());
                if !rejected {
                    pending = Some((
                        Instant::now() + Duration::from_millis(100),
                        body["arguments"]["metadata"].clone(),
                    ));
                }
            }
            let mut reply = json!({"schema_version":3,"run_id":"interaction-run","status":if rejected {"rejected"} else {"accepted"},"error":null});
            if !stop {
                reply["command"] = body["command"].clone();
                reply["job_id"] = body["job_id"].clone();
                reply["kind"] = json!("control");
                reply["worker_job_id"] = json!(null);
                if rejected {
                    reply["error"] = json!({"category":"admission","code":"queue_full","message":"busy","details":{}});
                }
                if matches!(scenario, "unknown" | "quarantine") {
                    reply["job_id"] = json!("wrong-id");
                }
            }
            let text = reply.to_string();
            let response = format!(
                "HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                if stop && scenario == "quarantine" {
                    "500 Internal Server Error"
                } else if rejected {
                    "429 Too Many Requests"
                } else {
                    "202 Accepted"
                },
                text.len(),
                text
            );
            if delayed && !stop {
                let delay = if scenario == "result-before-ack" {
                    Duration::from_millis(300)
                } else {
                    Duration::from_secs(5)
                };
                held_response = Some((Instant::now() + delay, request, response));
            } else {
                request.stream.write_all(response.as_bytes()).unwrap();
            }
            if stop {
                stopped = true;
                break;
            }
        }
        if held_response
            .as_ref()
            .is_some_and(|(at, _, _)| Instant::now() >= *at)
        {
            let (_, mut request, response) = held_response.take().unwrap();
            let _ = request.stream.write_all(response.as_bytes());
        }
        if pending
            .as_ref()
            .is_some_and(|(at, _)| Instant::now() >= *at)
            && !matches!(
                scenario,
                "timeout"
                    | "stop-run-end"
                    | "stop-before-ack"
                    | "timeout-before-ack"
                    | "quarantine"
            )
        {
            let (_, mut metadata) = pending.take().unwrap();
            if matches!(scenario, "async-failure" | "failure-before-ack") {
                emit(
                    json!({"event":"status","worker_state":"failed","fatal_error":{"category":"execution","code":"measurement_failed","message":"measurement failed","details":{}},"stream":{"lifecycle":"run_bound","state":"active"}}),
                );
            } else {
                captured += 1;
                if scenario == "mismatch" {
                    metadata["orchestrator_command_id"] = json!("999999");
                }
                emit(
                    json!({"event":"sample","captured":captured,"value":captured as f64,"unit":"V","status":"ok","trigger_metadata":metadata}),
                );
            }
        }
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "fixture must be stopped"
        );
        thread::sleep(Duration::from_millis(1));
    }
    status("ended");
    emit(
        json!({"event":"summary","ok":true,"exit_code":0,"fatal_error":null,"captured":captured,"errors":0,
        "overflow_detected":null,"overflow_monitoring":"off","final_drain_complete":null,"data_integrity":"unknown",
        "trigger_count_infinite":false,"expected_readings":null,"stop_reason":if stopped {"stop_requested"} else {"max_samples_reached"}}),
    );
}

fn operation(id: &str, operation: Value) -> Value {
    json!({"type":"bg-interaction","id":id,"background_id":"background-1","operation":operation})
}
fn send(wait: bool) -> Value {
    operation(
        "send",
        json!({"kind":"command","command":"software-trigger","wait_for_completion":wait}),
    )
}
fn get() -> Value {
    operation(
        "get",
        json!({"kind":"get-command-result","source_step":"send"}),
    )
}

pub fn contract(real: bool) {
    let scenarios: &[&str] = if real {
        &["loop", "wait-completion", "run-end", "off"]
    } else {
        &[
            "loop",
            "skip-result",
            "wait-next",
            "wait-completion",
            "run-end",
            "off",
            "missing-source",
            "slot-busy",
            "async-failure",
            "mismatch",
            "rejected",
            "unknown",
            "timeout",
            "stop",
            "stop-run-end",
            "result-before-ack",
            "stop-before-ack",
            "failure-before-ack",
            "timeout-before-ack",
            "quarantine",
            "quarantined-command",
            "quarantined-timer",
            "quarantined-foreground",
        ]
    };
    for &scenario in scenarios {
        let mut steps = vec![
            json!({"type":"background","id":"on","background_id":"background-1","action":"worker-on","capture":false}),
        ];
        match scenario {
            "loop" | "skip-result" => {
                let body = if scenario == "loop" {
                    json!([
                        send(false),
                        get(),
                        operation("latest", json!({"kind":"get-latest"}))
                    ])
                } else {
                    json!([send(true), {"type":"if","id":"branch","left":{"source":"literal","value":0},"operator":"equal","right":{"source":"literal","value":1},"then_steps":[get()],"else_steps":[]}])
                };
                steps.push(json!({"type":"for","id":"loop","variable":"i","range":{"start":"0","stop":"2","step":"1"},"steps":body}));
            }
            "missing-source" => {
                steps.push(json!({"type":"if","id":"branch","left":{"source":"literal","value":0},"operator":"equal","right":{"source":"literal","value":1},"then_steps":[send(false)],"else_steps":[]}));
                steps.push(get());
            }
            "slot-busy" => {
                steps.push(send(true));
                let mut second = send(false);
                second["id"] = json!("second");
                steps.push(second);
                steps.push(get());
                steps.push(operation(
                    "second-get",
                    json!({"kind":"get-command-result","source_step":"second"}),
                ));
            }
            _ => {
                steps.push(send(matches!(
                    scenario,
                    "wait-completion" | "result-before-ack"
                )));
                if scenario == "wait-next" {
                    steps.push(operation("next", json!({"kind":"wait-next"})));
                }
                if matches!(
                    scenario,
                    "wait-completion" | "mismatch" | "result-before-ack"
                ) {
                    steps.push(get());
                }
                if matches!(scenario, "async-failure" | "stop") {
                    steps.push(json!({"type":"wait","id":"foreground","duration_ms":2000}));
                }
                if scenario == "off" {
                    steps.push(json!({"type":"background","id":"off","background_id":"background-1","action":"worker-off","capture":false}));
                }
            }
        }
        if matches!(
            scenario,
            "stop-before-ack" | "failure-before-ack" | "timeout-before-ack"
        ) {
            steps[1]["timeout_ms"] = json!(if scenario == "timeout-before-ack" {
                100
            } else {
                10000
            });
        }
        let setup = MetersSetup {
            trigger_mode: MetersTriggerMode::Software,
            ..Default::default()
        };
        let mut wire = json!({"name":"Interaction contract","tool_instances":[{"id":"meters-bg","tool":"meters","setup":setup}],
            "backgrounds":[{"id":"background-1","tool_instance_id":"meters-bg","limit_count":if matches!(scenario,"loop"|"skip-result") {3} else if scenario == "slot-busy" {2} else {1},"command_trigger":true}],
            "workflow":{"interaction":{"enabled":true,"max_active_command_status":2},"steps":steps}});
        if scenario == "quarantined-timer" {
            wire["backgrounds"][0]["command_trigger"] = json!(false);
            wire["backgrounds"][0]["timer_interval_ms"] = json!(1000);
            wire["workflow"]["steps"] = json!([steps[0]]);
        } else if scenario == "quarantined-foreground" {
            wire.as_object_mut().unwrap().remove("backgrounds");
            wire["workflow"]["steps"] = json!([{"type":"tool-action","id":"measure","target":"meters-bg","action":"measure","arguments":{}}]);
        }
        let template = Template::from_json_str(&wire.to_string()).unwrap();
        let launch_marker =
            env::temp_dir().join(format!("interaction-launch-{}-{scenario}", process::id()));
        let command_marker =
            env::temp_dir().join(format!("interaction-command-{}-{scenario}", process::id()));
        let _ = fs::remove_file(&launch_marker);
        let _ = fs::remove_file(&command_marker);
        let specs = if real {
            let executable =
                env::var_os("ORCHESTRATOR_TEST_METERS_EXECUTABLE").expect("Supply real Meters CLI");
            let mut config = orchestrator_tool::config::Config::default();
            config.set_executable_path(&ToolId::meters(), Path::new(&executable));
            orchestrator_tool::run_preparation::prepare_worker_launch_specs_with_simulation(
                &template,
                ExecutionMode::Simulate,
                Path::new("."),
                &config,
                &HashMap::new(),
            )
            .unwrap()
        } else {
            let mut manifest = fixture_manifest_json("meters-smoke");
            manifest["commands"]["software_trigger"] = json!({"kind":"control"});
            let mut arguments = vec![
                OsString::from("--interaction-fixture"),
                OsString::from(scenario),
                OsString::from("--launch-marker"),
                launch_marker.clone().into_os_string(),
                OsString::from("--command-marker"),
                command_marker.clone().into_os_string(),
            ];
            if scenario.starts_with("quarantin") {
                arguments.extend([
                    OsString::from("--resource"),
                    OsString::from("interaction-quarantined-resource"),
                ]);
            }
            HashMap::from([(
                ToolInstanceId::new("meters-bg").unwrap(),
                WorkerLaunchSpec::new(env::current_exe().unwrap(), arguments).with_manifest(
                    parse_manifest(&manifest.to_string(), &ToolId::meters()).unwrap(),
                ),
            )])
        };
        let store = Arc::new(Mutex::new(BackgroundStore::default()));
        let stop = WorkflowStop::default();
        let mut completed = Vec::new();
        let mut stop_request = None;
        let started = Instant::now();
        let result = run_workflow_streaming_controlled(
            &template,
            ExecutionMode::Simulate,
            &specs,
            Duration::from_secs(5),
            Duration::from_secs(2),
            if real {
                Duration::from_secs(5)
            } else {
                Duration::from_millis(500)
            },
            None,
            RunOptions {
                backgrounds: store.clone(),
                workflow_stop: stop.clone(),
                ..Default::default()
            },
            |event| {
                if let WorkflowRunEvent::StepCompleted(step) = event {
                    if scenario == "stop-before-ack" && step.step_id().as_str() == "on" {
                        let stop = stop.clone();
                        let marker = command_marker.clone();
                        stop_request = Some(thread::spawn(move || {
                            let deadline = Instant::now() + Duration::from_secs(5);
                            while !marker.exists() {
                                assert!(Instant::now() < deadline, "command was never received");
                                thread::sleep(Duration::from_millis(5));
                            }
                            let requested = Instant::now();
                            stop.request();
                            requested
                        }));
                    }
                    if scenario == "stop" && step.step_id().as_str() == "send" {
                        stop.request();
                    }
                    if scenario == "stop-run-end" && step.step_id().as_str() == "send" {
                        let stop = stop.clone();
                        stop_request = Some(thread::spawn(move || {
                            thread::sleep(Duration::from_millis(30));
                            stop.request();
                            Instant::now()
                        }));
                    }
                    completed.push(step);
                }
            },
            |_| false,
        );
        if let Some(request) = stop_request {
            let requested = request.join().unwrap();
            if scenario == "stop-before-ack" {
                assert!(
                    requested.elapsed() < Duration::from_secs(3),
                    "Stop must not wait for the 5-second ACK"
                );
            }
        }
        let error = match scenario {
            "missing-source" => Some("did not execute"),
            "slot-busy" => Some("Result Slot is busy"),
            "async-failure" | "failure-before-ack" => Some("measurement failed"),
            "mismatch" => Some("Command ID mismatch"),
            "rejected" => Some("rejected"),
            "unknown" | "quarantine" | "timeout-before-ack" => Some("Dispatch Outcome Unknown"),
            "quarantined-command" | "quarantined-timer" | "quarantined-foreground" => {
                Some("reuse blocked")
            }
            "timeout" => Some("Timed out"),
            _ => None,
        };
        if let Some(expected) = error {
            let actual = match result {
                Err(error) => error.to_string(),
                Ok(summary) => summary.failure().expect("Run must fail").to_owned(),
            };
            assert!(actual.contains(expected), "{scenario}: {actual}");
            if scenario == "async-failure" {
                assert!(completed.iter().any(|s| s.step_id().as_str() == "send"
                    && matches!(s.outcome(), StepOutcome::Succeeded { .. })));
                assert!(
                    started.elapsed() < Duration::from_secs(2),
                    "failure must interrupt foreground wait"
                );
            }
            if scenario == "failure-before-ack" {
                assert!(
                    started.elapsed() < Duration::from_secs(3),
                    "failure must interrupt ACK admission"
                );
            }
            if scenario.starts_with("quarantined-") {
                assert!(
                    !launch_marker.exists(),
                    "quarantined resource must not launch any Worker"
                );
            }
        } else if matches!(scenario, "stop" | "stop-run-end" | "stop-before-ack") {
            assert!(result.as_ref().is_ok_and(|r| r.stopped()), "{result:?}");
        } else {
            assert!(
                result.as_ref().is_ok_and(|r| r.succeeded()),
                "{scenario} real={real}: {result:?}"
            );
            for step in completed.iter().filter(|s| s.step_id().as_str() == "send") {
                assert!(
                    matches!(step.outcome(), StepOutcome::Succeeded { output } if output.is_null()),
                    "BG Command IDs stay internal; Get resolves by source Step"
                );
            }
            let values: Vec<_> = completed
                .iter()
                .filter(|s| s.step_id().as_str() == "get")
                .map(|s| match s.outcome() {
                    StepOutcome::Succeeded { output } => {
                        assert!(output["trigger_metadata"]["orchestrator_command_id"].is_string());
                        output["captured"].as_u64().unwrap()
                    }
                    other => panic!("{other:?}"),
                })
                .collect();
            if scenario == "loop" {
                assert_eq!(values, vec![1, 2, 3]);
            }
            if matches!(scenario, "wait-completion" | "result-before-ack") {
                assert_eq!(values, vec![1]);
            }
            if scenario == "wait-next" {
                assert!(completed.iter().any(|s| s.step_id().as_str() == "next" && matches!(s.outcome(), StepOutcome::Succeeded {output} if output["captured"] == 1)));
            }
            assert!(
                store.lock().unwrap().metadata().is_empty(),
                "Capture remains OFF"
            );
        }
        let _ = fs::remove_file(&launch_marker);
        let _ = fs::remove_file(&command_marker);
        println!(
            "FG/BG {scenario} ({}): passed",
            if real {
                "actual Meters SIM"
            } else {
                "fake Worker"
            }
        );
    }
}
