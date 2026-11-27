use super::*;

/// A small RX-only fixture: real WorkerSession and BackgroundManager paths,
/// without a physical port or an extra Serial protocol abstraction.
pub(super) fn serial_background_fixture(scenario: &str) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let emit = |mut event: serde_json::Value| {
        event["schema_version"] = json!(3);
        event["timestamp_utc"] = json!(FIXTURE_UTC);
        event["run_id"] = json!("serial-run");
        println!("{event}");
        io::stdout().flush().unwrap();
    };
    emit(json!({
        "event":"ready","features":{
            "common.async_jobs":{"contract_version":1},
            "common.streaming":{"contract_version":1,"lifecycles":["run_bound"]}
        },
        "stream":{"lifecycle":"run_bound"},
        "status_url":format!("{base}/status"),
        "command_url":format!("{base}/command"),
        "stop_url":format!("{base}/stop")
    }));
    emit(
        json!({"event":"status","worker_state":"running","fatal_error":null,
        "active_job":null,"last_job":null,
        "stream":{"lifecycle":"run_bound","state":"active"}}),
    );
    let pieces = ["5a4b3d", "3c", "6874"];
    let mut count: usize = 0;
    let burst = scenario.starts_with("serial-buffer-overflow");
    let tail = scenario.contains("-tail-");
    let invalid_at = if tail {
        Some(1023)
    } else if scenario.contains("-invalid-") {
        Some(1024)
    } else {
        None
    };
    let emit_burst = || {
        for i in 0..1025 {
            let hex = if invalid_at == Some(i) {
                "invalid".to_owned()
            } else {
                format!("{:04X}", i)
            };
            emit(json!({"event":"rx","rx_hex":hex,"rx_bytes":2}));
        }
    };
    let ready_at = Instant::now();
    loop {
        if burst && !tail && count == 0 && ready_at.elapsed() >= Duration::from_millis(100) {
            emit_burst();
            count = 1025;
        } else if !burst && count < 50 {
            let hex = pieces[count % pieces.len()];
            emit(json!({
                "event":"rx",
                "rx_hex": if scenario == "serial-invalid" && count == 0 {
                    "invalid"
                } else { hex },
                "rx_bytes": hex.len() / 2
            }));
            count += 1;
        }
        if let Ok((stream, _)) = listener.accept() {
            let request = read_request(stream);
            assert_eq!(
                (request.method.as_str(), request.path.as_str()),
                ("POST", "/stop")
            );
            let body = json!({"schema_version":3,"run_id":"serial-run",
                "status":"accepted","error":null})
            .to_string();
            let mut stream = request.stream;
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(), body).unwrap();
            stream.flush().unwrap();
            drop(stream);
            if tail {
                emit_burst();
            }
            break;
        }
        thread::sleep(Duration::from_millis(15));
    }
    emit(
        json!({"event":"status","worker_state":"stopping","fatal_error":null,
        "active_job":null,"last_job":null,
        "stream":{"lifecycle":"run_bound","state":"ended"}}),
    );
    emit(
        json!({"event":"summary","ok":true,"exit_code":0,"fatal_error":null,
        "accepted":0,"succeeded":0,"failed":0}),
    );
}

pub(super) fn serial_background_rx_contract() {
    use orchestrator_tool::{
        background::BackgroundStore,
        run::{RunOptions, run_workflow_streaming_controlled},
    };
    use std::sync::Arc;

    for scenario in ["serial-ok", "serial-invalid", "serial-interaction"] {
        let capture = scenario != "serial-interaction";
        let mut wire = json!({
            "name":"Serial Background RX",
            "tool_instances":[{"id":"serial-bg","tool":"serial",
                "setup":{"transport":"serial","baud":115200}}],
            "backgrounds":[{"id":"background-1","tool_instance_id":"serial-bg",
                "live_monitor":true,"limit_count":null}],
            "workflow":{"interaction":{"enabled":!capture,"max_active_command_status":4096,"buffer":{"enabled":false,"mode":"fifo","overflow_policy":"fail-run"}},"steps":[
                {"type":"background","id":"on","background_id":"background-1",
                    "action":"worker-on","capture":capture},
                {"type":"wait","id":"collect","duration_ms":240},
                {"type":"background","id":"off","background_id":"background-1",
                    "action":"worker-off","capture":capture}
            ]}
        });
        if !capture {
            let steps = wire["workflow"]["steps"].as_array_mut().unwrap();
            steps.insert(1, json!({"type":"bg-interaction","id":"next","background_id":"background-1","operation":{"kind":"wait-next"}}));
            steps.insert(3, json!({"type":"bg-interaction","id":"latest","background_id":"background-1","operation":{"kind":"get-latest"}}));
        }
        let template = Template::from_json_str(&wire.to_string()).unwrap();
        let specs = HashMap::from([(
            ToolInstanceId::new("serial-bg").unwrap(),
            WorkerLaunchSpec::new(
                env::current_exe().unwrap(),
                ["--background-fixture", scenario],
            )
            .with_manifest(fixture_manifest("serial-smoke")),
        )]);
        let store = Arc::new(Mutex::new(BackgroundStore::default()));
        let mut received = Vec::new();
        let result = run_workflow_streaming_controlled(
            &template,
            ExecutionMode::Simulate,
            &specs,
            Duration::from_secs(3),
            Duration::from_secs(3),
            Duration::from_secs(3),
            None,
            RunOptions {
                backgrounds: store.clone(),
                ..Default::default()
            },
            |event| {
                if let WorkflowRunEvent::StepCompleted(step) = event
                    && matches!(step.step_id().as_str(), "next" | "latest")
                    && let StepOutcome::Succeeded { output } = step.outcome()
                {
                    received.push(output.clone());
                }
            },
            |_| false,
        );
        let data = store.lock().unwrap();
        if scenario == "serial-invalid" {
            assert!(result.is_err(), "invalid RX must fail the workflow");
            assert_eq!(data.metadata()[0].status, "failed");
            continue;
        }
        assert!(result.as_ref().is_ok_and(|r| r.succeeded()), "{result:?}");
        if !capture {
            assert!(data.metadata().is_empty());
            assert_eq!(received.len(), 2);
            for event in received {
                assert_eq!(event["event"], "rx");
                assert_eq!(event["run_id"], "serial-run");
                assert_eq!(
                    event["rx_hex"].as_str().unwrap().len() as u64,
                    event["rx_bytes"].as_u64().unwrap() * 2
                );
                assert!(
                    event.get("captured").is_none(),
                    "return the native RX event"
                );
            }
            println!("FG/BG Serial Latest/Next with Capture OFF (fake Worker): passed");
            continue;
        }
        let metadata = data.metadata();
        assert_eq!(metadata.len(), 1);
        assert!(metadata.iter().all(|m| m.tool_kind == "serial"
            && m.status == "completed"
            && m.quality == "unknown"
            && m.row_count > 0));
        for item in metadata {
            let rows = data.rows(&item.id, 0, 1000).unwrap();
            assert_eq!(rows.len(), item.row_count);
            assert_eq!(
                item.rx_bytes,
                rows.iter()
                    .map(|row| row["rx_bytes"].as_u64().unwrap() as usize)
                    .sum::<usize>()
            );
            // The fixture emits variable-sized RX events in a repeating order.
            // A captured row must retain one complete event, never split or merge bytes.
            let pieces = [("5a4b3d", 3_u64), ("3c", 1), ("6874", 2)];
            let positions = rows
                .iter()
                .map(|row| {
                    let hex = row["rx_hex"].as_str().expect("captured RX hex");
                    let bytes = row["rx_bytes"].as_u64().expect("captured RX byte count");
                    pieces
                        .iter()
                        .position(|(expected_hex, expected_bytes)| {
                            hex == *expected_hex && bytes == *expected_bytes
                        })
                        .expect("one complete fixture RX event per row")
                })
                .collect::<Vec<_>>();
            assert!(
                positions.len() >= 3,
                "must capture variable-length RX events"
            );
            assert!(
                positions
                    .windows(2)
                    .all(|pair| pair[1] == (pair[0] + 1) % pieces.len()),
                "captured RX events must preserve fixture order"
            );
        }
    }
}

pub(super) fn serial_buffer_contract() {
    use orchestrator_tool::{
        background::BackgroundStore,
        run::{RunOptions, run_workflow_streaming_controlled},
    };
    use std::sync::Arc;

    for scenario in [
        "serial-buffer",
        "serial-buffer-overflow-continue",
        "serial-buffer-overflow-fail",
        "serial-buffer-overflow-invalid-fail",
        "serial-buffer-overflow-invalid-continue",
        "serial-buffer-overflow-invalid-tail-fail",
    ] {
        let overflow = scenario.starts_with("serial-buffer-overflow");
        let fail = scenario.ends_with("-fail");
        let invalid = scenario.contains("-invalid-");
        let tail = scenario.contains("-tail-");
        let expect_failure = fail || invalid;
        let capture = overflow && (!fail || invalid);
        let mut steps = vec![
            json!({"type":"background","id":"on","background_id":"background-1","action":"worker-on","capture":capture}),
        ];
        if overflow {
            if expect_failure {
                // The tail fixture emits only after the Worker OFF request.
                if !tail {
                    // No Get Step is involved in discovering the asynchronous Run failure.
                    steps.push(json!({"type":"wait","id":"foreground","duration_ms":1500}));
                    steps.push(json!({"type":"set-variable","id":"after-overflow","variable":"after","value":{"source":"literal","value":true}}));
                }
            } else {
                // Observe loss without relying on a fixed burst delivery time.
                steps.extend([
                    json!({"type":"set-variable","id":"init-loss","variable":"lost","value":{"source":"literal","value":false}}),
                    json!({"type":"while","id":"poll","left":{"source":"variable","variable":"lost"},"operator":"equal","right":{"source":"literal","value":false},"max_iterations":400,"steps":[
                        {"type":"wait","id":"pause","duration_ms":10},
                        {"type":"bg-interaction","id":"status","background_id":"background-1","operation":{"kind":"get-buffer-status"}},
                        {"type":"set-variable","id":"update-loss","variable":"lost","value":{"source":"step-output","step_id":"status","pointer":"/overflowed"}}
                    ]}),
                    json!({"type":"assert","id":"assert-loss","left":{"source":"variable","variable":"lost"},"operator":"equal","right":{"source":"literal","value":true},"message":"Expected overflow"}),
                    json!({"type":"bg-interaction","id":"batch","background_id":"background-1","operation":{"kind":"get-buffer-data","read_mode":"pop","selection":{"kind":"all"}}}),
                    json!({"type":"array-process","id":"length","operation":"length","arguments":{"input":{"source":"step-output","step_id":"batch","pointer":"/data"}}}),
                ]);
            }
        } else {
            steps.extend([
                json!({"type":"bg-interaction","id":"next","background_id":"background-1","operation":{"kind":"wait-next"}}),
                json!({"type":"set-variable","id":"read-count","variable":"read-count","value":{"source":"literal","value":1}}),
                json!({"type":"bg-interaction","id":"peek","background_id":"background-1","operation":{"kind":"get-buffer-data","read_mode":"peek","selection":{"kind":"count","count":{"source":"variable","variable":"read-count"}}}}),
                json!({"type":"array-process","id":"length","operation":"length","arguments":{"input":{"source":"step-output","step_id":"peek","pointer":"/data"}}}),
                json!({"type":"bg-interaction","id":"batch","background_id":"background-1","operation":{"kind":"get-buffer-data","read_mode":"pop","selection":{"kind":"count","count":{"source":"step-output","step_id":"length","pointer":"/value"}}}}),
                json!({"type":"set-variable","id":"index","variable":"i","value":{"source":"literal","value":0}}),
                json!({"type":"array-process","id":"item","operation":"get-item","arguments":{"input":{"source":"step-output","step_id":"batch","pointer":"/data"},"index":{"source":"variable","variable":"i"}}}),
                json!({"type":"byte-process","id":"bytes","operation":{"kind":"byte-length"},"arguments":{"input":{"source":"step-output","step_id":"item","pointer":"/value/rx_hex"}}}),
                json!({"type":"assert","id":"assert-bytes","left":{"source":"step-output","step_id":"bytes","pointer":"/value"},"operator":"equal","right":{"source":"step-output","step_id":"item","pointer":"/value/rx_bytes"},"message":"Native event bytes"}),
                json!({"type":"output","id":"out","name":"Bytes","page":"Results","value":{"source":"step-output","step_id":"bytes","pointer":"/value"}}),
                json!({"type":"bg-interaction","id":"latest","background_id":"background-1","operation":{"kind":"get-latest"}}),
            ]);
        }
        steps.push(json!({"type":"background","id":"off","background_id":"background-1","action":"worker-off","capture":capture}));
        if tail {
            steps.push(json!({"type":"set-variable","id":"after-overflow","variable":"after","value":{"source":"literal","value":true}}));
        }
        let template = Template::from_json_str(&json!({
            "name":"Serial Buffer",
            "tool_instances":[{"id":"serial-bg","tool":"serial","setup":{"transport":"serial","baud":115200}}],
            "backgrounds":[{"id":"background-1","tool_instance_id":"serial-bg","live_monitor":false,"limit_count":null}],
            "workflow":{"interaction":{"enabled":true,"max_active_command_status":4096,"buffer":{
                "enabled":true,"mode":if capture && !invalid {"ring"} else {"fifo"},"overflow_policy":if fail {"fail-run"} else {"continue"}}},
                "steps":steps}
        }).to_string()).unwrap();
        let specs = HashMap::from([(
            ToolInstanceId::new("serial-bg").unwrap(),
            WorkerLaunchSpec::new(
                env::current_exe().unwrap(),
                ["--background-fixture", scenario],
            )
            .with_manifest(fixture_manifest("serial-smoke")),
        )]);
        let store = Arc::new(Mutex::new(BackgroundStore::default()));
        let mut outputs = HashMap::new();
        let result = run_workflow_streaming_controlled(
            &template,
            ExecutionMode::Simulate,
            &specs,
            Duration::from_secs(3),
            Duration::from_secs(3),
            Duration::from_secs(3),
            None,
            RunOptions {
                backgrounds: store.clone(),
                ..Default::default()
            },
            |event| {
                if let WorkflowRunEvent::StepCompleted(step) = event
                    && let StepOutcome::Succeeded { output } = step.outcome()
                {
                    outputs.insert(step.step_id().to_string(), output.clone());
                }
            },
            |_| false,
        );
        if expect_failure {
            let error = result
                .expect_err("Buffer or event failure must fail the run")
                .to_string();
            if invalid {
                assert!(
                    error.contains("Invalid Serial RX hex"),
                    "{scenario}: {error}"
                );
                assert!(
                    !error.contains("Data Buffer overflow"),
                    "{scenario}: overflow masked or replaced the event failure: {error}"
                );
                let data = store.lock().unwrap();
                let metadata = &data.metadata()[0];
                assert_eq!(metadata.status, "failed");
                assert_eq!(metadata.quality, "incomplete");
                assert!(
                    metadata
                        .error
                        .as_deref()
                        .is_some_and(|e| e.contains("Invalid Serial RX hex")),
                    "{scenario}: {:?}",
                    metadata.error
                );
                assert_eq!(metadata.row_count, 1024);
            } else {
                assert!(error.contains("Data Buffer overflow"), "{error}");
            }
            assert!(!outputs.contains_key("after-overflow"));
        } else {
            assert!(
                result.as_ref().is_ok_and(|r| r.succeeded()),
                "{scenario}: {result:?}"
            );
            if overflow {
                let batch = &outputs["batch"];
                assert_eq!(outputs["length"]["value"], 1024);
                assert_eq!(batch["status"]["dropped_count"], 1);
                assert_eq!(batch["status"]["overflowed"], true);
                assert_eq!(batch["status"]["count"], 0);
                assert_eq!(batch["data"][0]["rx_hex"], "0001");
                assert_eq!(batch["data"][1023]["rx_hex"], "0400");
                assert_eq!(store.lock().unwrap().metadata()[0].row_count, 1025);
            } else {
                assert_eq!(outputs["length"]["value"], 1);
                assert_eq!(outputs["batch"]["data"], outputs["peek"]["data"]);
                assert_eq!(outputs["item"]["value"]["event"], "rx");
                assert_eq!(outputs["latest"]["event"], "rx");
                assert!(store.lock().unwrap().metadata().is_empty());
            }
        }
    }
}

pub(super) fn run_serial_integer_fixture() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    print_json_line(
        &json!({
            "event":"ready","run_id":"serial-integer-run",
            "status_url":format!("{base}/status"),
            "command_url":format!("{base}/command"),
            "stop_url":format!("{base}/stop")
        })
        .to_string(),
    );

    let expected = [
        ("send", "03"),
        ("send", "01"),
        ("query", "02"),
        ("send", "00"),
    ];
    let mut sent = 0;
    let mut last_job = serde_json::Value::Null;
    loop {
        let request = accept_request(&listener);
        match request.path.as_str() {
            "/status" => write_response(
                request.stream,
                200,
                &json!({
                    "worker_state":"running","fatal_error":null,
                    "active_job":null,"last_job":last_job
                })
                .to_string(),
            ),
            "/command" => {
                let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
                let (expected_command, expected_hex) = expected
                    .get(sent)
                    .expect("invalid dynamic value must not reach Worker TX");
                assert_eq!(body["command"], *expected_command);
                assert_eq!(body["arguments"]["tx_hex"], *expected_hex);
                let worker_job_id = format!("serial-integer-job-{sent}");
                let result = json!({
                    "tx_hex":expected_hex,"tx_bytes":1,
                    "rx_hex":if *expected_command == "query" { "02" } else { "" },
                    "rx_bytes":if *expected_command == "query" { 1 } else { 0 },
                    "delimiter_hex":if *expected_command == "query" { "0a" } else { "" }
                });
                write_response(
                    request.stream,
                    202,
                    &json!({
                        "status":"accepted","command":expected_command,
                        "job_id":body["job_id"],"worker_job_id":worker_job_id
                    })
                    .to_string(),
                );
                last_job = json!({
                    "worker_job_id":worker_job_id,"job_id":body["job_id"],
                    "command":expected_command,"state":"succeeded",
                    "ok":true,"result":result,"error":null
                });
                print_json_line(
                    &json!({
                        "event":"job_finished","run_id":"serial-integer-run",
                        "worker_job_id":worker_job_id,"job_id":body["job_id"],
                        "command":expected_command,"state":"succeeded",
                        "ok":true,"result":result,"error":null
                    })
                    .to_string(),
                );
                sent += 1;
            }
            "/stop" => {
                assert_eq!(sent, expected.len(), "expected only valid TX jobs");
                write_response(request.stream, 200, r#"{"ok":true}"#);
                return;
            }
            other => panic!("unexpected Serial Worker request {other}"),
        }
    }
}

pub(super) fn serial_dynamic_integer_workflow_reaches_worker_without_invalid_tx() {
    let template = Template::from_json_str(
        &json!({
            "name":"Serial dynamic integer",
            "tool_instances":[{"id":"serial-1","tool":"serial","setup":{"transport":"serial","baud":115200}}],
            "workflow":{"interaction":{"enabled":false,"max_active_command_status":4096,"buffer":{"enabled":false,"mode":"fifo","overflow_policy":"fail-run"}},"steps":[
                {"type":"set-variable","id":"source","variable":"b",
                    "value":{"source":"literal","value":3.75}},
                {"type":"tool-action","id":"send-b","target":"serial-1","action":"send",
                    "arguments":{"tx_format":"hex-byte","tx_value":0},
                    "bindings":{"tx_value":{"source":"variable","variable":"b"}}},
                {"type":"output","id":"output-b","name":"original","page":"Results",
                    "value":{"source":"variable","variable":"b"}},
                {"type":"tool-action","id":"send-result","target":"serial-1","action":"send",
                    "arguments":{"tx_format":"hex-byte","tx_value":0},
                    "bindings":{"tx_value":{"source":"step-output","step_id":"send-b","pointer":"/tx_bytes"}}},
                {"type":"tool-action","id":"query-calculated","target":"serial-1","action":"query",
                    "arguments":{"tx_format":"hex-byte","tx_value":0,
                        "delimiter_format":"hex","delimiter_value":"0A","max_bytes":128},
                    "bindings":{"tx_value":{"source":"expression",
                        "left":{"source":"literal","value":5},"operator":"divide",
                        "right":{"source":"literal","value":2}}}},
                {"type":"set-variable","id":"set-large","variable":"large",
                    "value":{"source":"literal","value":256.9}},
                {"type":"tool-action","id":"send-large","target":"serial-1","action":"send",
                    "arguments":{"tx_format":"hex-byte","tx_value":0},
                    "bindings":{"tx_value":{"source":"variable","variable":"large"}}},
                {"type":"set-variable","id":"set-negative","variable":"negative",
                    "value":{"source":"literal","value":-3.75}},
                {"type":"tool-action","id":"send-invalid","target":"serial-1","action":"send",
                    "arguments":{"tx_format":"hex-byte","tx_value":0},
                    "bindings":{"tx_value":{"source":"variable","variable":"negative"}}},
                {"type":"wait","id":"not-reached","duration_ms":0}
            ]}
        })
        .to_string(),
    )
    .unwrap();
    let run = run_simulated_workflow(
        &template,
        &HashMap::from([(
            ToolInstanceId::new("serial-1").unwrap(),
            fixture_spec("serial-integer"),
        )]),
        Duration::from_secs(5),
        Duration::from_secs(5),
        Duration::from_secs(5),
    )
    .unwrap();

    // The final invalid step discards the root scope's staged Result Row,
    // but the earlier Output Step must still resolve the original decimal.
    assert!(run.result_rows().is_empty());
    assert!(run.step_executions().iter().any(|step| {
        step.step_id().as_str() == "output-b"
            && matches!(step.outcome(), StepOutcome::Succeeded { output }
                if output == &json!(3.75))
    }));
    for (id, expected) in [
        ("send-b", "03"),
        ("send-result", "01"),
        ("query-calculated", "02"),
        ("send-large", "00"),
    ] {
        assert!(
            run.step_executions().iter().any(|step| {
                step.step_id().as_str() == id
                    && matches!(step.outcome(), StepOutcome::Succeeded { output }
                        if output["tx_hex"] == expected)
            }),
            "{id} must dispatch correct TX"
        );
    }
    assert!(run.step_executions().iter().any(|step| {
        step.step_id().as_str() == "send-invalid"
            && matches!(step.outcome(), StepOutcome::Failed { message }
                if message.contains("-3.75") && message.contains("-3"))
    }));
    assert!(
        !run.step_executions()
            .iter()
            .any(|step| step.step_id().as_str() == "not-reached")
    );
}
