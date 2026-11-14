//! Serial TX admission, native results, RX sharing and process-local reuse safety.
use super::*;
use orchestrator_tool::{
    background::BackgroundStore,
    run::{RunOptions, WorkflowStop, run_workflow_streaming_controlled},
};
use serde_json::Value;
use std::sync::Arc;

pub fn fixture(scenario: &str) {
    let arguments: Vec<_> = env::args_os().collect();
    let marker = arguments
        .windows(2)
        .find(|a| a[0] == "--tx-marker")
        .map(|a| a[1].clone());
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let features = json!({"common.async_jobs":{"contract_version":1},"common.streaming":{"contract_version":1,"lifecycles":["run_bound"]}});
    let emit = |mut event: Value| {
        event["schema_version"] = json!(3);
        event["timestamp_utc"] = json!(FIXTURE_UTC);
        event["run_id"] = json!("serial-tx-run");
        println!("{event}");
        io::stdout().flush().unwrap();
    };
    let status = |last: &Value, state: &str| {
        json!({"event":"status","schema_version":3,
        "timestamp_utc":FIXTURE_UTC,"run_id":"serial-tx-run","features":features,
        "status_url":format!("{base}/status"),"command_url":format!("{base}/command"),"stop_url":format!("{base}/stop"),
        "worker_state":"running","fatal_error":null,"active_job":null,"last_job":last,
        "stream":{"lifecycle":"run_bound","state":state}})
    };
    emit(
        json!({"event":"ready","features":features,"stream":{"lifecycle":"run_bound"},
        "status_url":format!("{base}/status"),"command_url":format!("{base}/command"),"stop_url":format!("{base}/stop")}),
    );
    emit(status(&Value::Null, "active"));
    let started = Instant::now();
    let mut last = Value::Null;
    let mut pending: Option<(Instant, Value)> = None;
    let mut held: Option<(Instant, TestRequest, String)> = None;
    let mut count = 0;
    let mut next_rx = Instant::now();
    loop {
        if Instant::now() >= next_rx {
            emit(json!({"event":"rx","rx_hex":"00112233","rx_bytes":4}));
            next_rx = Instant::now() + Duration::from_millis(15);
        }
        if let Ok((stream, _)) = listener.accept() {
            let request = read_request(stream);
            let stop = request.path == "/stop";
            let mut code = "202 Accepted";
            let reply = if request.path == "/status" {
                code = "200 OK";
                status(&last, "active")
            } else if stop {
                json!({"schema_version":3,"run_id":"serial-tx-run","status":"accepted","error":null})
            } else {
                assert_eq!(request.path, "/command");
                let body: Value = serde_json::from_slice(&request.body).unwrap();
                if let Some(path) = &marker {
                    let mut log = fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(path)
                        .unwrap();
                    writeln!(log, "{body}").unwrap();
                }
                count += 1;
                let command = body["command"].as_str().unwrap();
                assert!(matches!(command, "send" | "send-file"));
                let result = if command == "send" {
                    let hex = body["arguments"]["tx_hex"].as_str().unwrap();
                    assert!(matches!(hex, "e4bda0e5a5bd" | "01"));
                    json!({"tx_hex":hex,"tx_bytes":hex.len()/2})
                } else {
                    let bytes = fs::read(body["arguments"]["path"].as_str().unwrap()).unwrap();
                    json!({"file_bytes":bytes.len(),"bytes_written":bytes.len()})
                };
                let failed = scenario == "failed";
                let error = if failed {
                    json!({"category":"execution","code":"tx_failed","message":"TX failed","details":{}})
                } else {
                    Value::Null
                };
                let worker_id = format!("serial-job-{count}");
                let terminal = json!({"event":"job_finished","schema_version":3,"run_id":"serial-tx-run","timestamp_utc":FIXTURE_UTC,
                    "command":command,"job_id":body["job_id"],"worker_job_id":if scenario == "mismatch" {"wrong-job".into()} else {worker_id.clone()},
                    "state":if failed {"failed"} else {"succeeded"},"ok":!failed,"result":result,"error":error});
                if scenario != "rejected" && scenario != "timeout-ack" && scenario != "stop-ack" {
                    pending = Some((Instant::now() + Duration::from_millis(30), terminal));
                }
                if scenario == "rejected" {
                    code = "429 Too Many Requests";
                }
                json!({"schema_version":3,"run_id":"serial-tx-run","command":command,
                    "job_id":if scenario == "unknown" {json!("wrong-client")} else {body["job_id"].clone()},
                    "kind":"async_job","worker_job_id":if scenario == "rejected" {Value::Null} else {json!(worker_id)},
                    "status":if scenario == "rejected" {"rejected"} else {"accepted"},
                    "error":if scenario == "rejected" {json!({"category":"admission","code":"busy","message":"busy","details":{}})} else {Value::Null}})
            };
            let text = reply.to_string();
            let response = format!(
                "HTTP/1.1 {code}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
                text.len()
            );
            if request.path == "/command"
                && matches!(scenario, "before-ack" | "timeout-ack" | "stop-ack")
            {
                held = Some((
                    Instant::now()
                        + if scenario == "before-ack" {
                            Duration::from_millis(150)
                        } else {
                            Duration::from_secs(5)
                        },
                    request,
                    response,
                ));
            } else {
                let mut stream = request.stream;
                stream.write_all(response.as_bytes()).unwrap();
                stream.flush().unwrap();
            }
            if stop {
                if matches!(
                    scenario,
                    "success" | "before-ack" | "run-end" | "off" | "snapshot-loop"
                ) {
                    assert!(
                        pending.is_none(),
                        "Worker OFF must wait for the finite TX terminal, not just HTTP 202"
                    );
                }
                if scenario == "off-unconfirmed" || scenario == "rx-off-unconfirmed" {
                    return;
                }
                emit(status(&last, "ended"));
                emit(
                    json!({"event":"summary","ok":true,"exit_code":0,"fatal_error":null,"accepted":count,"succeeded":count,"failed":0}),
                );
                return;
            }
        }
        if held
            .as_ref()
            .is_some_and(|(at, _, _)| Instant::now() >= *at)
        {
            let (_, mut request, response) = held.take().unwrap();
            let _ = request.stream.write_all(response.as_bytes());
        }
        if pending
            .as_ref()
            .is_some_and(|(at, _)| Instant::now() >= *at)
        {
            let (_, terminal) = pending.take().unwrap();
            last = terminal.clone();
            if matches!(scenario, "snapshot-jsonl" | "snapshot-loop") {
                emit(status(&last, "active"));
            } else if scenario != "snapshot-http" {
                emit(terminal.clone());
                if scenario == "duplicate-conflict" {
                    let mut duplicate = terminal;
                    duplicate["result"]["tx_bytes"] = json!(999);
                    emit(duplicate);
                }
            }
        }
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "Serial TX fixture was not stopped"
        );
        thread::sleep(Duration::from_millis(1));
    }
}

fn interaction(id: &str, operation: Value) -> Value {
    json!({"type":"bg-interaction","id":id,"background_id":"bg","timeout_ms":500,"operation":operation})
}
fn send(id: &str, command: &str, arguments: Value) -> Value {
    interaction(
        id,
        json!({"kind":"command","command":command,"arguments":arguments,"wait_for_completion":true}),
    )
}
fn get(id: &str, source: &str) -> Value {
    interaction(
        id,
        json!({"kind":"get-command-result","source_step":source}),
    )
}
fn wire(steps: Value) -> Value {
    json!({"name":"Serial BG TX","tool_instances":[{"id":"serial","tool":"serial","setup":{"transport":"serial","baud":115200}}],
        "backgrounds":[{"id":"bg","tool_instance_id":"serial","limit_count":null,"live_monitor":true}],
        "workflow":{"interaction":{"enabled":true,"max_active_command_status":2},"steps":steps}})
}

fn failure(
    result: Result<orchestrator_tool::workflow::WorkflowRunResult, WorkflowRunError>,
) -> Option<String> {
    match result {
        Err(error) => Some(error.to_string()),
        Ok(run) => run
            .step_executions()
            .iter()
            .find_map(|step| match step.outcome() {
                StepOutcome::Failed { message } => Some(message.clone()),
                _ => None,
            }),
    }
}

pub fn contract(real: bool) {
    let file = env::temp_dir().join(format!("serial-bg-tx-{}.bin", process::id()));
    fs::write(&file, [0, 1, 2, 255]).unwrap();
    let scenarios: &[&str] = if real {
        &["success"]
    } else {
        &[
            "success",
            "before-ack",
            "snapshot-loop",
            "run-end",
            "off",
            "snapshot-jsonl",
            "snapshot-http",
            "failed",
            "rejected",
            "unknown",
            "timeout-ack",
            "stop-ack",
            "mismatch",
            "duplicate-conflict",
            "busy",
            "invalid-dynamic",
            "off-unconfirmed",
            "rx-off-unconfirmed",
        ]
    };
    for &scenario in scenarios {
        let marker = env::temp_dir().join(format!("serial-bg-tx-{}-{scenario}.log", process::id()));
        let _ = fs::remove_file(&marker);
        let on = json!({"type":"background","id":"on","background_id":"bg","action":"worker-on","capture":true});
        let tx = send(
            "send",
            "serial-send",
            json!({"tx_format":"text","tx_value":"你好"}),
        );
        let mut steps = vec![on.clone(), tx, get("get", "send")];
        if scenario == "success" {
            let mut dynamic = send("byte", "serial-send", json!({"tx_format":"hex-byte"}));
            dynamic["operation"]["bindings"] =
                json!({"tx_value":{"source":"variable","variable":"value"}});
            steps.extend([
                json!({"type":"set-variable","id":"value","variable":"value","value":{"source":"literal","value":257.9}}),
                dynamic, get("get-byte", "byte"),
                send("file", "serial-send-file", json!({"path":file})), get("get-file", "file"),
                interaction("rx", json!({"kind":"wait-next"})),
            ]);
        } else if scenario == "busy" {
            steps.insert(
                2,
                send(
                    "second",
                    "serial-send",
                    json!({"tx_format":"text","tx_value":"你好"}),
                ),
            );
            steps.push(get("get-second", "second"));
        } else if scenario == "invalid-dynamic" {
            steps.insert(1, json!({"type":"set-variable","id":"value","variable":"value","value":{"source":"literal","value":"invalid"}}));
            steps[2]["operation"]["arguments"] = json!({"tx_format":"hex-byte"});
            steps[2]["operation"]["bindings"] =
                json!({"tx_value":{"source":"variable","variable":"value"}});
        } else if scenario == "rx-off-unconfirmed" {
            steps = vec![on.clone(), interaction("rx", json!({"kind":"wait-next"}))];
        } else if scenario == "snapshot-loop" {
            let body = json!([steps[1], {"type":"if","id":"skip","left":{"source":"literal","value":0},
                "operator":"equal","right":{"source":"literal","value":1},"then_steps":[steps[2]],"else_steps":[]}]);
            steps = vec![
                on.clone(),
                json!({"type":"for","id":"loop","variable":"i",
                "range":{"start":"0","stop":"2","step":"1"},"steps":body}),
            ];
        } else if matches!(scenario, "run-end" | "off") {
            steps.pop();
            steps[1]["operation"]["wait_for_completion"] = json!(false);
            if scenario == "off" {
                steps.push(json!({"type":"background","id":"off","background_id":"bg","action":"worker-off","capture":true}));
            }
        }
        let template = Template::from_json_str(&wire(json!(steps)).to_string()).unwrap();
        let port = format!("COM-serial-tx-{}-{scenario}", process::id());
        let specs = if real {
            let exe = env::var_os("ORCHESTRATOR_TEST_SERIAL_EXECUTABLE")
                .expect("Supply the real Serial Tool CLI");
            let mut config = orchestrator_tool::config::Config::default();
            config.set_executable_path(&ToolId::serial(), Path::new(&exe));
            orchestrator_tool::run_preparation::prepare_worker_launch_specs_with_simulation(
                &template,
                ExecutionMode::Simulate,
                Path::new("."),
                &config,
                &HashMap::new(),
            )
            .unwrap()
        } else {
            HashMap::from([(
                ToolInstanceId::new("serial").unwrap(),
                WorkerLaunchSpec::new(
                    env::current_exe().unwrap(),
                    vec![
                        OsString::from("--serial-tx-fixture"),
                        scenario.into(),
                        "--tx-marker".into(),
                        marker.clone().into_os_string(),
                        "--port".into(),
                        port.clone().into(),
                    ],
                )
                .with_manifest(fixture_manifest("serial-smoke")),
            )])
        };
        let store = Arc::new(Mutex::new(BackgroundStore::default()));
        let stop = WorkflowStop::default();
        let mut stopper = None;
        let mut outputs = HashMap::new();
        let result = run_workflow_streaming_controlled(
            &template,
            ExecutionMode::Simulate,
            &specs,
            Duration::from_secs(3),
            Duration::from_secs(2),
            Duration::from_secs(2),
            None,
            RunOptions {
                backgrounds: store.clone(),
                workflow_stop: stop.clone(),
                ..Default::default()
            },
            |event| {
                if let WorkflowRunEvent::StepCompleted(step) = event {
                    if scenario == "stop-ack" && step.step_id().as_str() == "on" {
                        let marker = marker.clone();
                        let stop = stop.clone();
                        stopper = Some(thread::spawn(move || {
                            let deadline = Instant::now() + Duration::from_secs(3);
                            while !marker.exists() {
                                assert!(Instant::now() < deadline);
                                thread::sleep(Duration::from_millis(2));
                            }
                            stop.request();
                        }));
                    }
                    if let StepOutcome::Succeeded { output } = step.outcome() {
                        outputs.insert(step.step_id().to_string(), output.clone());
                    }
                }
            },
            |_| false,
        );
        if let Some(stopper) = stopper {
            stopper.join().unwrap();
        }
        let error = match scenario {
            "snapshot-jsonl" | "snapshot-http" => Some("timed out"),
            "failed" => Some("TX failed"),
            "rejected" => Some("rejected"),
            "unknown" | "timeout-ack" => Some("Dispatch Outcome Unknown"),
            "mismatch" => Some("conflict"),
            "duplicate-conflict" => Some("Contradictory"),
            "busy" => Some("Result Slot is busy"),
            "invalid-dynamic" => Some("must be numeric"),
            "off-unconfirmed" | "rx-off-unconfirmed" => Some("summary"),
            _ => None,
        };
        if let Some(expected) = error {
            let actual = match result {
                Err(error) => error.to_string(),
                Ok(summary) => summary.failure().expect("Run must fail").to_owned(),
            };
            assert!(
                actual.to_lowercase().contains(&expected.to_lowercase()),
                "{scenario}: {actual}"
            );
        } else if scenario == "stop-ack" {
            assert!(
                result.as_ref().is_ok_and(|r| r.stopped()),
                "{scenario}: {result:?}"
            );
        } else {
            assert!(
                result.as_ref().is_ok_and(|r| r.succeeded()),
                "{scenario}: {result:?}"
            );
            assert!(outputs["send"].is_null());
            if !matches!(scenario, "snapshot-loop" | "run-end" | "off") {
                assert_eq!(outputs["get"]["event"], "job_finished");
                assert_eq!(outputs["get"]["command"], "send");
                assert_eq!(outputs["get"]["result"]["tx_bytes"], 6);
            }
            if scenario == "success" {
                assert_eq!(outputs["get-byte"]["result"]["tx_bytes"], 1);
                assert_eq!(outputs["get-file"]["result"]["bytes_written"], 4);
                assert_eq!(outputs["rx"]["event"], "rx");
                assert!(store.lock().unwrap().datasets[0].metadata.row_count > 0);
            }
        }
        if matches!(scenario, "snapshot-jsonl" | "snapshot-http") {
            assert!(
                outputs["send"].is_null(),
                "Snapshot proves Command completion"
            );
            assert!(
                !outputs.contains_key("get"),
                "Snapshot must not fabricate native result"
            );
        }
        if !real {
            let count = fs::read_to_string(&marker)
                .unwrap_or_default()
                .lines()
                .count();
            assert_eq!(
                count,
                if matches!(scenario, "success" | "snapshot-loop") {
                    3
                } else if matches!(scenario, "invalid-dynamic" | "rx-off-unconfirmed") {
                    0
                } else {
                    1
                },
                "{scenario}: TX must not retry or dispatch invalid/busy input"
            );
        }
        if matches!(
            scenario,
            "off-unconfirmed" | "rx-off-unconfirmed" | "unknown" | "failed"
        ) {
            // Same resource and different launch shape: BG and FG must share the guard.
            let retry_template = Template::from_json_str(
                &wire(json!([on, interaction("rx", json!({"kind":"wait-next"}))])).to_string(),
            )
            .unwrap();
            let spec = WorkerLaunchSpec::new(
                env::current_exe().unwrap(),
                [
                    "--serial-tx-fixture",
                    "success",
                    "--port",
                    &port.to_ascii_lowercase(),
                ],
            )
            .with_manifest(fixture_manifest("serial-smoke"));
            let retry_specs = HashMap::from([(ToolInstanceId::new("serial").unwrap(), spec)]);
            let retry = run_workflow(
                &retry_template,
                ExecutionMode::Simulate,
                &retry_specs,
                Duration::from_secs(2),
                Duration::from_secs(2),
                Duration::from_secs(2),
            );
            if scenario == "off-unconfirmed" {
                assert!(failure(retry).unwrap().contains("reuse blocked"));
                let fg = json!({"name":"FG","tool_instances":[{"id":"serial","tool":"serial","setup":{"transport":"serial","baud":115200}}],
                    "workflow":{"interaction":{"enabled":false,"max_active_command_status":2},"steps":[{"type":"tool-action","id":"tx","target":"serial","action":"send","arguments":{"tx_format":"text","tx_value":"你好"}}]}});
                let fg = Template::from_json_str(&fg.to_string()).unwrap();
                assert!(
                    failure(run_workflow(
                        &fg,
                        ExecutionMode::Simulate,
                        &retry_specs,
                        Duration::from_secs(2),
                        Duration::from_secs(2),
                        Duration::from_secs(2)
                    ))
                    .unwrap()
                    .contains("reuse blocked")
                );
            } else {
                assert!(
                    failure(retry).is_none(),
                    "{scenario}: confirmed OFF or RX-only must allow reuse"
                );
            }
        }
        println!(
            "Serial BG TX {scenario} ({}): passed",
            if real { "real Tool SIM" } else { "fake Worker" }
        );
        let _ = fs::remove_file(marker);
    }
    fs::remove_file(file).unwrap();
}
