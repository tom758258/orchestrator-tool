use super::*;

fn software_background_fixture(scenario: &str) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let emit = |mut value: serde_json::Value| {
        value["schema_version"] = json!(3);
        value["timestamp_utc"] = json!(FIXTURE_UTC);
        value["run_id"] = json!("timer-run");
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
    let mut pending = 0;
    let mut next_sample = Instant::now();
    let mut completed_at = None;
    let mut captured = 0;
    let mut triggers = 0;
    let batch = if scenario == "timer-simple" { 1 } else { 3 };
    let mut stopped = false;
    let stopping_case = scenario.starts_with("timer-stopping");
    let infinite = matches!(scenario, "timer-stopping" | "timer-ended");
    let mut stopping = false;
    let mut ended_at: Option<Instant> = None;
    let mut status_count = 0;
    while captured < if batch == 1 { 6 } else { 4 * batch } {
        if !active && scenario != "timer-inactive" && started.elapsed() >= Duration::from_millis(60)
        {
            active = true;
            status("active");
        }
        if let Ok((stream, _)) = listener.accept() {
            let request = read_request(stream);
            let body: serde_json::Value =
                serde_json::from_slice(&request.body).unwrap_or(json!({}));
            let stop = request.path == "/stop";
            let rejected = !stop && scenario == "timer-reject";
            if !stop {
                assert!(active, "trigger before Active");
                assert!(!stopping, "trigger after Worker reported stopping");
                assert!(ended_at.is_none(), "trigger after stream ended");
                assert_eq!(pending, 0, "overlapping trigger before complete batch");
                if let Some(at) = completed_at {
                    assert!(
                        Instant::now().duration_since(at) >= Duration::from_millis(25),
                        "interval starts before batch completion"
                    );
                }
                triggers += 1;
                pending = batch;
                next_sample = Instant::now() + Duration::from_millis(40);
            }
            let mut reply = json!({"schema_version":3,"run_id":"timer-run","status":if rejected {"rejected"} else {"accepted"},"error":null});
            if !stop {
                reply["command"] = json!("software_trigger");
                reply["job_id"] = body["job_id"].clone();
                reply["kind"] = json!("control");
                reply["worker_job_id"] = json!(null);
            }
            let text = reply.to_string();
            let mut stream = request.stream;
            write!(stream, "HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", if rejected {"429 Too Many Requests"} else {"202 Accepted"}, text.len(), text).unwrap();
            if stop {
                stopped = true;
                break;
            }
        }
        if scenario == "timer-timeout" && pending > 0 {
            status("active");
        }
        if pending > 0
            && Instant::now() >= next_sample
            && !matches!(scenario, "timer-timeout" | "timer-reject")
        {
            captured += 1;
            let mut sample = json!({"event":"sample","captured":captured,"value":captured as f64,"unit":"V","status":"ok"});
            if scenario == "timer-gap" {
                sample["captured"] = json!(captured + 1);
            }
            emit(sample);
            pending -= 1;
            if stopping_case && captured == 1 {
                stopping = true;
                emit(
                    json!({"event":"status","worker_state":"stopping","fatal_error":null,
                    "stream":{"lifecycle":"run_bound","state":"active"}}),
                );
            }
            next_sample = Instant::now() + Duration::from_millis(40);
            if pending == 0 {
                completed_at = Some(Instant::now());
                if scenario == "timer-ended" {
                    status("ended");
                    ended_at = Some(Instant::now());
                }
            }
        }
        if stopping {
            // A later active/running update must not reopen the trigger gate;
            // the rest of the already accepted batch must still be retained.
            status("active");
        }
        if ended_at.is_some_and(|at| at.elapsed() >= Duration::from_millis(100)) {
            break;
        }
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "timer fixture did not stop"
        );
        if scenario == "timer-status-stream" && captured == batch && triggers == 1 {
            // Keep the pipe busy with a bounded burst, checking HTTP between
            // writes. The second trigger must arrive before the burst ends.
            for _ in 0..32 {
                emit(
                    json!({"event":"status","worker_state":"running","fatal_error":null,
                    "stream":{"lifecycle":"run_bound","state":"active"},
                    "detail":"x".repeat(8_192)}),
                );
                status_count += 1;
            }
            assert!(
                status_count < 4_096,
                "timer waited for the status stream to stop"
            );
        } else {
            thread::sleep(Duration::from_millis(2));
        }
    }
    status("ended");
    emit(
        json!({"event":"summary","ok":true,"exit_code":0,"fatal_error":null,
        "captured":captured,"errors":0,"overflow_detected":null,"overflow_monitoring":"off",
        "final_drain_complete":null,"data_integrity":"unknown","trigger_count_infinite":infinite,
        "expected_readings": if batch == 1 || infinite {json!(null)} else {json!(12)},
        "stop_reason":if stopped {"stop_requested"} else if batch == 1 {"max_samples_reached"} else {"completed"}}),
    );
    if stopping_case || scenario == "timer-ended" {
        assert_eq!(triggers, 1);
        assert_eq!(captured, batch);
    } else if !stopped {
        assert_eq!(triggers, if batch == 1 { 6 } else { 4 });
    }
    if scenario == "timer-status-stream" {
        assert!(status_count > 0);
    }
}

pub(super) fn software_background_timer_contract() {
    use orchestrator_tool::{
        background::BackgroundStore,
        run::{RunOptions, WorkflowStop, run_workflow_streaming_controlled},
    };
    use std::sync::Arc;
    for scenario in [
        "timer-simple",
        "timer-custom",
        "timer-status-stream",
        "timer-ended",
        "timer-stopping",
        "timer-stopping-short",
        "timer-reject",
        "timer-timeout",
        "timer-inactive",
        "timer-gap",
        "timer-stop",
    ] {
        let mut wire: serde_json::Value = serde_json::from_str(&background_template(json!([
            {"type":"background","id":"on","background_id":"background-1","action":"worker-on","capture":true},
            {"type":"wait","id":"first","duration_ms":115},
            {"type":"background","id":"capture-off","background_id":"background-1","action":"capture-off"},
            {"type":"wait","id":"gap","duration_ms":180},
            {"type":"background","id":"capture-on","background_id":"background-1","action":"capture-on"},
            {"type":"wait","id":"finish","duration_ms":700},
            {"type":"background","id":"off","background_id":"background-1","action":"worker-off","capture":true}
        ])).to_json_string().unwrap()).unwrap();
        wire["tool_instances"][0]["setup"]["trigger_mode"] = json!(if scenario == "timer-simple" {
            "software"
        } else {
            "software-custom"
        });
        wire["tool_instances"][0]["setup"]["sample_count"] = json!(3);
        wire["backgrounds"][0]["limit_count"] =
            json!(if scenario == "timer-simple" { 6 } else { 4 });
        wire["backgrounds"][0]["timer_interval_ms"] = json!(25);
        if matches!(
            scenario,
            "timer-ended" | "timer-stopping" | "timer-stopping-short"
        ) {
            wire["workflow"]["steps"] = json!([
                {"type":"background","id":"on","background_id":"background-1","action":"worker-on","capture":true},
                {"type":"wait","id":"finish","duration_ms":400},
                {"type":"background","id":"off","background_id":"background-1","action":"worker-off","capture":true}
            ]);
            if scenario != "timer-stopping-short" {
                wire["backgrounds"][0]["limit_count"] = json!(null);
                wire["tool_instances"][0]["setup"]["allow_buffer_overflow_risk"] = json!(true);
            }
        }
        let template = Template::from_json_str(&wire.to_string()).unwrap();
        let specs = HashMap::from([(
            ToolInstanceId::new("meters-bg").unwrap(),
            WorkerLaunchSpec::new(
                env::current_exe().unwrap(),
                ["--background-fixture", scenario],
            )
            .with_manifest(fixture_manifest("meters-smoke")),
        )]);
        let store = Arc::new(Mutex::new(BackgroundStore::default()));
        let stop = WorkflowStop::default();
        let result = run_workflow_streaming_controlled(
            &template,
            ExecutionMode::Simulate,
            &specs,
            Duration::from_millis(300),
            Duration::from_millis(200),
            Duration::from_secs(2),
            None,
            RunOptions {
                backgrounds: store.clone(),
                workflow_stop: stop.clone(),
                ..Default::default()
            },
            |event| {
                if scenario == "timer-stop"
                    && matches!(event, WorkflowRunEvent::StepCompleted(ref step) if step.step_id().as_str() == "first")
                {
                    stop.request();
                }
            },
            |_| false,
        );
        let data = store.lock().unwrap();
        if matches!(
            scenario,
            "timer-simple" | "timer-custom" | "timer-status-stream"
        ) {
            assert!(
                result.as_ref().is_ok_and(|r| r.succeeded()),
                "{scenario}: {result:?}"
            );
            assert_eq!(data.datasets.len(), 2);
            let recorded: usize = data.metadata().iter().map(|d| d.row_count).sum();
            assert!(
                recorded < data.monitor("background-1").len(),
                "Capture OFF must not pause Timer"
            );
            assert_eq!(
                data.monitor("background-1").len(),
                if scenario == "timer-simple" { 6 } else { 12 }
            );
        } else if matches!(
            scenario,
            "timer-ended" | "timer-stopping" | "timer-stopping-short"
        ) {
            if scenario == "timer-stopping-short" {
                let error = result.unwrap_err().to_string();
                assert!(
                    error.contains("ended before the configured sample count"),
                    "{error}"
                );
                assert_eq!(data.metadata()[0].status, "failed");
            } else {
                assert!(
                    result.as_ref().is_ok_and(|r| r.succeeded()),
                    "{scenario}: {result:?}"
                );
                assert_eq!(data.workers[0].state, "off");
                assert_eq!(data.metadata()[0].status, "completed");
            }
            assert_eq!(data.metadata()[0].row_count, 3);
            assert_eq!(data.monitor("background-1").len(), 3);
        } else if scenario == "timer-stop" {
            assert!(result.as_ref().is_ok_and(|r| r.stopped()), "{result:?}");
            assert_eq!(data.metadata()[0].status, "incomplete");
            assert!(data.monitor("background-1").len() < 3);
        } else {
            assert!(result.is_err(), "{scenario}: {result:?}");
            assert!(data.workers[0].error.is_some(), "{scenario}");
        }
        println!("{scenario}: passed");
    }
}

pub(super) fn background_fixture(scenario: &str) {
    if scenario.starts_with("serial-") {
        serial_background_fixture(scenario);
        return;
    }
    if scenario.starts_with("timer-") {
        software_background_fixture(scenario);
        return;
    }
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let emit = |mut value: serde_json::Value| {
        value["schema_version"] = json!(3);
        value["timestamp_utc"] = json!(FIXTURE_UTC);
        value["run_id"] = json!("background-run");
        println!("{value}");
        io::stdout().flush().unwrap();
    };
    emit(
        json!({"event":"ready","features":{"common.streaming":{"contract_version":1,"lifecycles":["run_bound"]}},
        "stream":{"lifecycle":"run_bound"},"status_url":format!("{base}/status"),"command_url":format!("{base}/command"),"stop_url":format!("{base}/stop")}),
    );
    emit(
        json!({"event":"status","worker_state":"running","fatal_error":null,"stream":{"lifecycle":"run_bound","state":"waiting"}}),
    );
    emit(
        json!({"event":"status","worker_state":"running","fatal_error":null,"stream":{"lifecycle":"run_bound","state":"active"}}),
    );
    let controlled = scenario.starts_with("stop-");
    let monitored = controlled && scenario != "stop-finite" && scenario != "stop-infinite";
    let mut count = 0;
    loop {
        count += 1;
        emit(
            json!({"event":"sample","captured":count,"value":count as f64,"unit":"V","status":"ok"}),
        );
        if !controlled && scenario != "rolling" && count == 6 {
            break;
        }
        if let Ok((stream, _)) = listener.accept() {
            // The listener is nonblocking. Fully read the accepted request on a
            // blocking socket before responding; closing with unread request
            // bytes can reset the connection and lose Stop acceptance on Windows.
            let request = read_request(stream);
            assert_eq!(
                (request.method.as_str(), request.path.as_str()),
                ("POST", "/stop"),
                "{scenario}: unexpected Background fixture HTTP request"
            );
            let body = json!({"schema_version":3,"run_id":"background-run","status":"accepted","error":null}).to_string();
            // Do not use write_response: it rewrites run_id using the separate
            // v3 Job fixture context, which this Background fixture does not use.
            let mut stream = request.stream;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
            stream.flush().unwrap();
            drop(stream);
            // A final sample after Stop must still reach an active Capture.
            if scenario == "stop-gap" {
                count += 1;
            }
            count += 1;
            emit(
                json!({"event":"sample","captured":count,"value":count as f64,"unit":"V","status":"ok"}),
            );
            break;
        }
        thread::sleep(Duration::from_millis(5));
    }
    if !scenario.ends_with("missing-ended") {
        emit(
            json!({"event":"status","worker_state":"stopping","fatal_error":null,"stream":{"lifecycle":"run_bound","state":"ended"}}),
        );
    }
    if scenario == "stop-bad-json" {
        println!("invalid JSON");
    }
    if !scenario.ends_with("missing-summary") {
        let mut summary = json!({"event":"summary","ok":!monitored,"exit_code":if monitored {3} else {0},"fatal_error":null,
            "captured":if scenario.ends_with("bad-count") {count+1} else {count},
            "errors":0,"overflow_detected":if monitored {json!(false)} else {json!(null)},
            "overflow_monitoring":if monitored {"active"} else {"off"},"final_drain_complete":true,
            "data_integrity":match scenario {"missing-quality" => json!(null), "unknown-quality" => json!("unknown"), "stop-infinite" => json!("unknown"), _ if controlled => json!("incomplete"), _ => json!("no_loss_detected")}});
        if controlled {
            summary["stop_reason"] = json!("stop_requested");
            summary["trigger_count_infinite"] = json!(scenario == "stop-infinite");
            summary["expected_readings"] = if scenario == "stop-infinite" {
                json!(null)
            } else if scenario == "stop-multiple-samples" {
                json!(1000)
            } else if scenario == "stop-wrong-expected" {
                json!(100)
            } else {
                json!(30000)
            };
        }
        match scenario {
            "stop-overflow" => summary["overflow_detected"] = json!(true),
            "stop-drain" => summary["final_drain_complete"] = json!(false),
            "stop-fatal" => summary["fatal_error"] = json!("instrument failure"),
            _ => {}
        }
        emit(summary);
    }
    if monitored {
        process::exit(if scenario == "stop-exit" { 2 } else { 3 });
    }
}

fn background_template(steps: serde_json::Value) -> Template {
    let setup = MetersSetup {
        trigger_mode: MetersTriggerMode::ImmediateCustom,
        ..MetersSetup::default()
    };
    Template::from_json_str(&json!({"name":"Background contract", "tool_instances":[
        {"id":"meters-bg","tool":"meters","setup":setup}],"backgrounds":[{"id":"background-1","tool_instance_id":"meters-bg","live_monitor":true,"limit_count":6}],
        "workflow":{"interaction":{"enabled":false,"max_active_command_status":4096,"buffer":{"enabled":false,"mode":"fifo","overflow_policy":"fail-run"}},"steps":steps}}).to_string()).unwrap()
}

pub(super) fn background_workflow_stop_contract() {
    use orchestrator_tool::{
        background::BackgroundStore,
        run::{RunOptions, WorkflowStop, run_workflow_streaming_controlled},
        workflow::WorkflowRunEvent,
    };
    use std::sync::Arc;
    for scenario in [
        "stop-finite",
        "stop-monitored",
        "stop-multiple-samples",
        "stop-wrong-expected",
        "stop-wait",
        "stop-infinite",
        "stop-monitor-only",
        "stop-windows",
        "stop-explicit-off",
        "stop-missing-ended",
        "stop-missing-summary",
        "stop-bad-count",
        "stop-gap",
        "stop-overflow",
        "stop-drain",
        "stop-fatal",
        "stop-bad-json",
        "stop-exit",
    ] {
        let capture = scenario != "stop-monitor-only";
        let explicit_off = scenario == "stop-explicit-off";
        let mut steps = vec![
            json!({"type":"background","id":"on","background_id":"background-1","action":"worker-on","capture":capture}),
        ];
        if scenario == "stop-windows" {
            steps.extend([
                json!({"type":"background","id":"close","background_id":"background-1","action":"capture-off"}),
                json!({"type":"background","id":"reopen","background_id":"background-1","action":"capture-on"})]);
        }
        if scenario == "stop-wait" {
            steps.push(json!({"type":"wait","id":"wait","duration_ms":10000}));
        }
        steps.push(json!({"type":"background","id":"off","background_id":"background-1","action":"worker-off","capture":capture}));
        let mut wire: serde_json::Value =
            serde_json::from_str(&background_template(json!(steps)).to_json_string().unwrap())
                .unwrap();
        wire["backgrounds"][0]["limit_count"] = if scenario == "stop-infinite" {
            json!(null)
        } else {
            json!(30000)
        };
        if scenario == "stop-infinite" {
            wire["tool_instances"][0]["setup"]["allow_buffer_overflow_risk"] = json!(true);
        }
        if matches!(scenario, "stop-multiple-samples" | "stop-wrong-expected") {
            wire["backgrounds"][0]["limit_count"] = json!(100);
            wire["tool_instances"][0]["setup"]["sample_count"] = json!(10);
        }
        let template = Template::from_json_str(&wire.to_string()).unwrap();
        let specs = HashMap::from([(
            ToolInstanceId::new("meters-bg").unwrap(),
            WorkerLaunchSpec::new(
                env::current_exe().unwrap(),
                ["--background-fixture", scenario],
            )
            .with_manifest(fixture_manifest("meters-smoke")),
        )]);
        let store = Arc::new(Mutex::new(BackgroundStore::default()));
        let stop = WorkflowStop::default();
        let folder = env::temp_dir().join(format!("orchestrator-{}-{scenario}", process::id()));
        let mut completed = Vec::new();
        let mut requester = None;
        let started = Instant::now();
        let result = run_workflow_streaming_controlled(
            &template,
            ExecutionMode::Simulate,
            &specs,
            Duration::from_secs(2),
            Duration::from_secs(2),
            Duration::from_secs(2),
            None,
            RunOptions {
                backgrounds: store.clone(),
                workflow_stop: stop.clone(),
                background_csv: Some(orchestrator_tool::background::BackgroundCsvOptions {
                    output_folder: folder.clone(),
                    background_id: None,
                    scopes_format: Default::default(),
                    serial_format: Default::default(),
                }),
                ..Default::default()
            },
            |event| {
                if let WorkflowRunEvent::StepCompleted(step) = event {
                    if !explicit_off
                        && step.step_id().as_str()
                            == if scenario == "stop-windows" {
                                "reopen"
                            } else {
                                "on"
                            }
                    {
                        if scenario == "stop-wait" {
                            let stop = stop.clone();
                            let store = store.clone();
                            let initial_rows = store.lock().unwrap().metadata()[0].row_count;
                            // Start after Worker ON completes and let Capture receive more
                            // samples while the executor is in Wait, then request Stop.
                            requester = Some(thread::spawn(move || {
                                let deadline = Instant::now() + Duration::from_secs(2);
                                while store.lock().unwrap().metadata()[0].row_count
                                    < initial_rows + 5
                                {
                                    if Instant::now() >= deadline {
                                        stop.request();
                                        panic!("Background samples stopped arriving during Wait");
                                    }
                                    thread::sleep(Duration::from_millis(2));
                                }
                                stop.request();
                            }));
                        } else {
                            stop.request();
                        }
                    }
                    if step.step_id().as_str() == "wait" {
                        assert_eq!(step.outcome(), &StepOutcome::Cancelled);
                    }
                    completed.push(step.step_id().to_string());
                }
            },
            |_| false,
        );
        if let Some(requester) = requester {
            requester.join().unwrap();
            assert!(started.elapsed() < Duration::from_secs(5));
            assert_eq!(completed, ["on", "wait"]);
        }
        let valid = matches!(
            scenario,
            "stop-finite"
                | "stop-monitored"
                | "stop-multiple-samples"
                | "stop-wait"
                | "stop-infinite"
                | "stop-monitor-only"
                | "stop-windows"
        );
        let data = store.lock().unwrap();
        if valid {
            assert!(
                result.as_ref().is_ok_and(|r| r.stopped() && !r.succeeded()),
                "{scenario}: {result:?}"
            );
            assert!(!completed.iter().any(|id| id == "off"));
            assert_eq!(data.workers[0].state, "off", "{scenario}");
            if !capture {
                assert!(data.datasets.is_empty());
                assert!(!folder.exists());
                continue;
            }
            let metadata = data.metadata();
            let active = metadata.last().unwrap();
            assert_eq!(active.status, "incomplete", "{scenario}");
            assert_eq!(
                active.quality,
                if scenario == "stop-infinite" {
                    "unknown"
                } else {
                    "incomplete"
                }
            );
            assert!(active.row_count > 0 && active.row_count < 30000);
            // The final drain sample is retained in both the dataset and streamed CSV.
            let rows = data.rows(&active.id, 0, active.row_count).unwrap();
            assert_eq!(
                rows.last().unwrap()["captured"].as_u64().unwrap() as usize,
                data.monitor("background-1").len()
            );
            for item in &metadata {
                assert_eq!(
                    csv::Reader::from_path(item.csv_path.as_ref().unwrap())
                        .unwrap()
                        .records()
                        .count(),
                    item.row_count
                );
            }
            if scenario == "stop-windows" {
                assert_eq!(metadata.len(), 2);
                assert_eq!(metadata[0].status, "completed");
                assert_eq!(metadata[0].quality, "unknown");
            }
        } else {
            assert!(result.is_err(), "{scenario}: {result:?}");
            assert_eq!(
                data.metadata().last().unwrap().status,
                "failed",
                "{scenario}"
            );
        }
        drop(data);
        fs::remove_dir_all(folder).unwrap();
    }
}

pub(super) fn background_capture_and_termination_contract() {
    use orchestrator_tool::{
        background::BackgroundStore,
        run::{RunOptions, run_workflow_streaming_controlled},
    };
    use std::sync::Arc;
    let on = json!({"type":"background","id":"on","background_id":"background-1","action":"worker-on","capture":true});
    let off = json!({"type":"background","id":"off","background_id":"background-1","action":"worker-off","capture":true});
    for scenario in [
        "finite",
        "missing-ended",
        "missing-summary",
        "missing-quality",
        "bad-count",
        "rolling",
        "monitor-only",
    ] {
        let steps = if scenario == "monitor-only" {
            json!([
                {"type":"background","id":"monitor-on","background_id":"background-1","action":"worker-on","capture":false},
                {"type":"wait","id":"monitor-wait","duration_ms":150},
                {"type":"background","id":"monitor-off","background_id":"background-1","action":"worker-off","capture":false},
                {"type":"background","id":"monitor-restart","background_id":"background-1","action":"worker-on","capture":false},
                {"type":"wait","id":"monitor-wait-again","duration_ms":150},
                {"type":"background","id":"monitor-release","background_id":"background-1","action":"worker-off","capture":false}
            ])
        } else if scenario == "rolling" {
            json!([on,
            {"type":"wait","id":"wait-a","duration_ms":40},
            {"type":"background","id":"capture-off","background_id":"background-1","action":"capture-off"},
            {"type":"wait","id":"wait-gap","duration_ms":40},
            {"type":"background","id":"capture-on","background_id":"background-1","action":"capture-on"},
            {"type":"wait","id":"wait-b","duration_ms":40},off])
        } else {
            json!([on,{"type":"wait","id":"wait","duration_ms":150},off])
        };
        let template = background_template(steps);
        let template = if scenario == "rolling" {
            let mut wire: serde_json::Value =
                serde_json::from_str(&template.to_json_string().unwrap()).unwrap();
            wire["backgrounds"][0]["limit_count"] = json!(null);
            wire["tool_instances"][0]["setup"]["allow_buffer_overflow_risk"] = json!(true);
            Template::from_json_str(&wire.to_string()).unwrap()
        } else {
            template
        };
        let store = Arc::new(Mutex::new(BackgroundStore::default()));
        let csv_folder = env::temp_dir().join(format!(
            "orchestrator-bg-stream-{}-{scenario}",
            process::id()
        ));
        let specs = HashMap::from([(
            ToolInstanceId::new("meters-bg").unwrap(),
            WorkerLaunchSpec::new(
                env::current_exe().unwrap(),
                ["--background-fixture", scenario],
            )
            .with_manifest(fixture_manifest("meters-smoke")),
        )]);
        let result = run_workflow_streaming_controlled(
            &template,
            ExecutionMode::Simulate,
            &specs,
            Duration::from_secs(2),
            Duration::from_secs(2),
            Duration::from_secs(2),
            None,
            RunOptions {
                backgrounds: store.clone(),
                background_csv: Some(orchestrator_tool::background::BackgroundCsvOptions {
                    output_folder: csv_folder.clone(),
                    background_id: None,
                    scopes_format: Default::default(),
                    serial_format: Default::default(),
                }),
                ..Default::default()
            },
            |_| {},
            |_| false,
        );
        let data = store.lock().unwrap();
        if scenario == "monitor-only" {
            assert!(result.as_ref().is_ok_and(|r| r.succeeded()), "{result:?}");
            assert!(data.datasets.is_empty());
            // The second runtime replaces, rather than appends to, the monitor buffer.
            assert_eq!(data.monitor("background-1").len(), 6);
            assert!(!csv_folder.exists());
            continue;
        }
        assert!(!data.datasets.is_empty(), "{scenario}");
        if matches!(scenario, "finite" | "rolling") {
            assert!(
                result.as_ref().is_ok_and(|r| r.succeeded()),
                "{scenario}: {result:?}"
            );
            assert_eq!(
                data.datasets.len(),
                if scenario == "rolling" { 2 } else { 1 }
            );
            let metadata = data.metadata();
            assert!(
                metadata
                    .iter()
                    .all(|d| d.status == "completed" && d.quality == "no_loss_detected")
            );
            assert!(metadata.iter().all(|d| d.row_count > 0));
            for metadata in &metadata {
                let mut csv = csv::Reader::from_path(metadata.csv_path.as_ref().unwrap()).unwrap();
                assert_eq!(csv.records().count(), metadata.row_count);
            }
            assert!(
                data.monitor("background-1").len() >= metadata.iter().map(|m| m.row_count).sum()
            );
            if scenario == "finite" {
                assert_eq!(metadata[0].row_count, 6);
                assert_eq!(metadata[0].min, Some(1.0));
                assert_eq!(metadata[0].avg, Some(3.5));
            } else {
                let first = data.rows(&metadata[0].id, 0, 1000).unwrap();
                let second = data.rows(&metadata[1].id, 0, 1000).unwrap();
                assert!(
                    first.last().unwrap()["captured"].as_u64() < second[0]["captured"].as_u64()
                );
            }
            drop(data);
            let folder = env::temp_dir().join(format!(
                "orchestrator-background-export-{}-{scenario}",
                process::id()
            ));
            let ids = store
                .lock()
                .unwrap()
                .metadata()
                .iter()
                .map(|m| m.id.clone())
                .collect::<Vec<_>>();
            use orchestrator_tool::background_export::{BackgroundExportFormat, export_datasets};
            let csv =
                export_datasets(&store, &ids, &folder, BackgroundExportFormat::Csv, 4).unwrap();
            let xlsx =
                export_datasets(&store, &ids, &folder, BackgroundExportFormat::Xlsx, 4).unwrap();
            assert_eq!(csv.len(), ids.len());
            if scenario == "finite" {
                assert_eq!(fs::read_to_string(&csv[0]).unwrap().lines().count(), 7);
                assert_eq!(xlsx.len(), 2);
                use calamine::{Reader, Xlsx};
                let rows = xlsx
                    .iter()
                    .map(|path| {
                        let mut book: Xlsx<_> = calamine::open_workbook(path).unwrap();
                        book.worksheet_range("Sheet1").unwrap().height() - 1
                    })
                    .sum::<usize>();
                assert_eq!(rows, 6);
                let again =
                    export_datasets(&store, &ids, &folder, BackgroundExportFormat::Csv, 4).unwrap();
                assert_ne!(csv, again);
            }
            fs::remove_dir_all(folder).unwrap();
        } else {
            assert!(result.is_err(), "{scenario}: {result:?}");
            assert_eq!(data.metadata()[0].status, "failed");
        }
        fs::remove_dir_all(csv_folder).unwrap();
    }
    // Strict composite OFF and natural-end acknowledgements are public workflow semantics.
    for (actions, ok) in [
        (
            json!([on,{"type":"wait","id":"wait","duration_ms":150},
            {"type":"background","id":"ack","background_id":"background-1","action":"capture-off"},
            {"type":"background","id":"release","background_id":"background-1","action":"worker-off","capture":false}]),
            true,
        ),
        (
            json!([on,{"type":"background","id":"again","background_id":"background-1","action":"worker-on"}]),
            false,
        ),
        (
            json!([on,{"type":"background","id":"stop-capture","background_id":"background-1","action":"capture-off"},off]),
            false,
        ),
        (
            json!([on,{"type":"background","id":"again","background_id":"background-1","action":"capture-on"}]),
            false,
        ),
        (
            json!([on,{"type":"wait","id":"wait","duration_ms":150},
            {"type":"background","id":"ack","background_id":"background-1","action":"capture-off"},
            {"type":"background","id":"again","background_id":"background-1","action":"capture-off"}]),
            false,
        ),
        (
            json!([on,{"type":"wait","id":"wait","duration_ms":150},off,
            {"type":"background","id":"again","background_id":"background-1","action":"worker-off"}]),
            false,
        ),
        (
            json!([on,{"type":"wait","id":"wait","duration_ms":150},
            {"type":"background","id":"again","background_id":"background-1","action":"capture-on"}]),
            false,
        ),
    ] {
        let template = background_template(actions);
        let specs = HashMap::from([(
            ToolInstanceId::new("meters-bg").unwrap(),
            WorkerLaunchSpec::new(
                env::current_exe().unwrap(),
                ["--background-fixture", "finite"],
            )
            .with_manifest(fixture_manifest("meters-smoke")),
        )]);
        let result = run_simulated_workflow(
            &template,
            &specs,
            Duration::from_secs(2),
            Duration::from_secs(2),
            Duration::from_secs(2),
        );
        assert_eq!(
            result.as_ref().is_ok_and(|r| r
                .step_executions()
                .iter()
                .all(|s| matches!(s.outcome(), StepOutcome::Succeeded { .. }))),
            ok,
            "{result:?}"
        );
    }

    // Two sources must remain separate even if their worker-local Run IDs coincide.
    {
        use orchestrator_tool::background::{BackgroundAction, BackgroundManager};
        let template = background_template(json!([]));
        let mut instances = template.tool_instances().to_vec();
        let mut configs = template.backgrounds().to_vec();
        let mut second = configs[0].clone();
        second.id = "background-2".into();
        second.tool_instance_id = ToolInstanceId::new("meters-bg-2").unwrap();
        second.live_monitor = false;
        let mut second_instance = instances[0].clone();
        second_instance.id = second.tool_instance_id.clone();
        instances.push(second_instance);
        configs.push(second);
        let template = Template::new_with_backgrounds(
            "Separate background sources".into(),
            instances,
            template.workflow().clone(),
            configs.clone(),
        )
        .unwrap();
        let specs = configs
            .iter()
            .zip(["finite", "unknown-quality"])
            .map(|(config, scenario)| {
                (
                    config.tool_instance_id.clone(),
                    WorkerLaunchSpec::new(
                        env::current_exe().unwrap(),
                        ["--background-fixture", scenario],
                    )
                    .with_manifest(fixture_manifest("meters-smoke")),
                )
            })
            .collect();
        let store = Arc::new(Mutex::new(BackgroundStore::default()));
        let failure = orchestrator_tool::run_failure::RunFailure::default();
        let mut manager = BackgroundManager::new(
            &template,
            &specs,
            store.clone(),
            failure.clone(),
            None,
            Duration::from_secs(2),
            Duration::from_secs(2),
            Duration::from_secs(2),
            Default::default(),
        );
        for config in &configs {
            manager
                .action(&config.id, BackgroundAction::WorkerOn, true)
                .unwrap();
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            if store
                .lock()
                .unwrap()
                .metadata()
                .iter()
                .all(|m| m.status == "completed")
            {
                break;
            }
            failure.check().unwrap();
            assert!(
                std::time::Instant::now() < deadline,
                "captures did not finish"
            );
            thread::sleep(Duration::from_millis(5));
        }
        {
            let data = store.lock().unwrap();
            let metadata = data.metadata();
            assert_eq!(metadata.len(), 2);
            for (config, quality) in configs.iter().zip(["no_loss_detected", "unknown"]) {
                let dataset = metadata
                    .iter()
                    .find(|m| m.background_id == config.id)
                    .unwrap();
                assert_eq!(dataset.row_count, 6);
                assert_eq!(dataset.quality, quality);
                assert_eq!(data.rows(&dataset.id, 0, 10).unwrap()[0]["captured"], 1);
            }
            assert_eq!(data.monitor("background-1").len(), 6);
            assert!(data.monitor("background-2").is_empty());
        }
        manager.cleanup().unwrap();
        manager.cleanup().unwrap();
    }

    // CSV and Background failures must not bypass Powers Safe-Off.
    struct FailAfterHeader<'a> {
        bytes: &'a mut Vec<u8>,
        wrote_header: bool,
    }
    impl Write for FailAfterHeader<'_> {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if self.wrote_header {
                return Err(io::Error::other("injected Foreground CSV write failure"));
            }
            self.wrote_header = true;
            self.bytes.write(bytes)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    for (csv_failure, power_failure, workflow_failure, foreground_csv_failure) in [
        (false, false, false, false),
        (true, false, false, false),
        (false, true, false, false),
        (false, false, true, false),
        (false, false, false, true),
    ] {
        let marker = env::temp_dir().join(format!(
            "orchestrator-bg-safe-off-{}-{csv_failure}-{power_failure}",
            process::id()
        ));
        let _ = fs::remove_file(&marker);
        let invalid_folder = marker.with_extension("file");
        fs::write(&invalid_folder, "not a directory").unwrap();
        // SAFETY: this subprocess fixture harness executes all cases sequentially.
        unsafe {
            env::set_var(CLEANUP_MARKER_ENV, &marker);
        }
        let mut wire: serde_json::Value =
            serde_json::from_str(&background_template(json!([on])).to_json_string().unwrap())
                .unwrap();
        wire["workflow"]["steps"] = json!([
            {"type":"tool-action","id":"set","target":"powers-1","action":"set-output","arguments":{"channel":1,"voltage":5.0}},
            {"type":"tool-action","id":"power-on","target":"powers-1","action":"output-on","arguments":{"channel":1}},
            on,{"type":"wait","id":"wait","duration_ms":150},
            {"type":"wait","id":"after-failure","duration_ms":0}
        ]);
        wire["tool_instances"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":"powers-1","tool":"powers","setup":{}}));
        if workflow_failure {
            wire["workflow"]["steps"][3] = json!({"type":"assert","id":"original-failure",
                "left":{"source":"literal","value":0},"operator":"equal","right":{"source":"literal","value":1},"message":"Original workflow failure"});
        }
        if power_failure {
            wire["workflow"]["steps"].as_array_mut().unwrap().insert(2,json!({"type":"tool-action","id":"power-off","target":"powers-1","action":"output-off","arguments":{"channel":1}}));
        }
        if foreground_csv_failure {
            wire["backgrounds"][0]["limit_count"] = json!(null);
            wire["tool_instances"][0]["setup"]["allow_buffer_overflow_risk"] = json!(true);
            wire["workflow"]["steps"].as_array_mut().unwrap().insert(4, json!({"type":"for","id":"rows","variable":"i",
                "range":{"start":"0","stop":"2","step":"1"},"steps":[{"type":"output","id":"value","name":"value","page":"Results",
                "value":{"source":"literal","value":1}}]}));
        }
        let template = Template::from_json_str(&wire.to_string()).unwrap();
        let specs = HashMap::from([
            (
                ToolInstanceId::new("meters-bg").unwrap(),
                WorkerLaunchSpec::new(
                    env::current_exe().unwrap(),
                    [
                        "--background-fixture",
                        if foreground_csv_failure {
                            "rolling"
                        } else {
                            "missing-summary"
                        },
                    ],
                )
                .with_manifest(fixture_manifest("meters-smoke")),
            ),
            (
                ToolInstanceId::new("powers-1").unwrap(),
                fixture_spec(if power_failure {
                    "live-cleanup-failure"
                } else {
                    "live-assert-failure"
                }),
            ),
        ]);
        let store = Arc::new(Mutex::new(BackgroundStore::default()));
        let mut completed = Vec::new();
        let failure = orchestrator_tool::run_failure::RunFailure::default();
        let mut partial_csv = Vec::new();
        let mut csv_writer = orchestrator_tool::workflow_csv::ResultRowsCsvWriter::new(
            FailAfterHeader {
                bytes: &mut partial_csv,
                wrote_header: false,
            },
            vec!["value".into()],
        )
        .unwrap();
        let mut committed = Vec::new();
        let mut graceful_stop_called = false;
        let result = run_workflow_streaming_controlled(
            &template,
            ExecutionMode::Live,
            &specs,
            Duration::from_secs(2),
            Duration::from_secs(2),
            Duration::from_secs(2),
            None,
            RunOptions {
                backgrounds: store.clone(),
                failure: failure.clone(),
                background_csv: csv_failure.then(|| {
                    orchestrator_tool::background::BackgroundCsvOptions {
                        output_folder: invalid_folder.clone(),
                        background_id: None,
                        scopes_format: Default::default(),
                        serial_format: Default::default(),
                    }
                }),
                ..Default::default()
            },
            |event| {
                if let WorkflowRunEvent::StepCompleted(step) = &event {
                    completed.push(step.step_id().as_str().to_owned());
                }
                if foreground_csv_failure && let WorkflowRunEvent::ResultRowCommitted(row) = event {
                    failure.fail(format!(
                        "Foreground CSV: {}",
                        csv_writer.write_row(&row).unwrap_err()
                    ));
                    committed.push(row);
                }
            },
            |_| {
                graceful_stop_called = true;
                false
            },
        );
        // SAFETY: run cleanup reaped all fixture processes before changing the environment.
        unsafe {
            env::remove_var(CLEANUP_MARKER_ENV);
        }
        let error = result.unwrap_err().to_string();
        assert!(
            csv_failure || foreground_csv_failure || error.contains("summary"),
            "{error}"
        );
        if foreground_csv_failure {
            assert!(
                error.contains("injected Foreground CSV write failure"),
                "{error}"
            );
            assert_eq!(committed.len(), 1);
            assert!(!graceful_stop_called);
            drop(csv_writer);
            assert_eq!(partial_csv, b"value\n");
            let data = store.lock().unwrap();
            assert!(data.metadata()[0].row_count > 0);
            assert_eq!(data.workers[0].state, "off");
            assert_ne!(data.metadata()[0].status, "recording");
        }
        if workflow_failure {
            assert!(error.contains("original-failure"), "{error}");
        }
        assert!(fs::read_to_string(&marker).unwrap().contains("safe-off"));
        assert!(!completed.contains(&"after-failure".to_owned()));
        if !csv_failure && !workflow_failure && !foreground_csv_failure {
            assert_eq!(store.lock().unwrap().metadata()[0].row_count, 6);
        }
        fs::remove_file(marker).unwrap();
        fs::remove_file(invalid_folder).unwrap();
    }
}

pub(super) fn real_meters_background_and_unlimited_simulation() {
    use orchestrator_tool::{
        background::{BackgroundCsvOptions, BackgroundStore},
        run::{RunOptions, WorkflowStop, run_workflow_streaming_controlled},
        run_preparation::prepare_worker_launch_specs_with_simulation,
    };
    use std::sync::Arc;
    let executable = std::path::PathBuf::from(
        env::var_os("ORCHESTRATOR_TEST_METERS_EXECUTABLE").expect("Supply real Meters CLI"),
    );
    let mut config = orchestrator_tool::config::Config::default();
    config.set_executable_path(&ToolId::meters(), &executable);
    for mode in [
        "software",
        "immediate",
        "external",
        "software-custom",
        "immediate-custom",
        "external-custom",
    ] {
        for infinite in [false, true] {
            let mut wire: serde_json::Value = serde_json::from_str(&background_template(json!([
            {"type":"background","id":"on","background_id":"background-1","action":"worker-on","capture":true},
            {"type":"wait","id":"wait","duration_ms":if infinite && !mode.starts_with("external") {250} else {1500}},
            {"type":"background","id":"off","background_id":"background-1","action":"worker-off","capture":true}
        ])).to_json_string().unwrap()).unwrap();
            wire["tool_instances"][0]["setup"]["trigger_mode"] = json!(mode);
            wire["tool_instances"][0]["setup"]["sample_count"] = json!(3);
            wire["backgrounds"][0]["limit_count"] = json!(3);
            if mode.starts_with("software") {
                wire["backgrounds"][0]["timer_interval_ms"] = json!(20);
            }
            if mode.starts_with("external") {
                wire["tool_instances"][0]["setup"]["hw_trigger_slope"] = json!("neg");
                wire["tool_instances"][0]["setup"]["hw_trigger_delay_s"] = json!(0.001);
            }
            if infinite {
                wire["backgrounds"][0]["limit_count"] = json!(null);
                wire["tool_instances"][0]["setup"]["allow_buffer_overflow_risk"] = json!(true);
            }
            let capture_gap = mode == "software-custom" && infinite;
            if capture_gap {
                wire["workflow"]["steps"] = json!([
                    {"type":"background","id":"on","background_id":"background-1","action":"worker-on","capture":true},
                    {"type":"wait","id":"first","duration_ms":150},
                    {"type":"background","id":"pause","background_id":"background-1","action":"capture-off"},
                    {"type":"wait","id":"gap","duration_ms":150},
                    {"type":"background","id":"resume","background_id":"background-1","action":"capture-on"},
                    {"type":"wait","id":"last","duration_ms":150},
                    {"type":"background","id":"off","background_id":"background-1","action":"worker-off","capture":true}
                ]);
            }
            let csv_folder =
                env::temp_dir().join(format!("orchestrator-real-capture-{}", process::id()));
            let template = Template::from_json_str(&wire.to_string()).unwrap();
            let specs = prepare_worker_launch_specs_with_simulation(
                &template,
                ExecutionMode::Simulate,
                Path::new("."),
                &config,
                &HashMap::new(),
            )
            .unwrap();
            let store = Arc::new(Mutex::new(BackgroundStore::default()));
            let result = run_workflow_streaming_controlled(
                &template,
                ExecutionMode::Simulate,
                &specs,
                Duration::from_secs(10),
                Duration::from_secs(5),
                Duration::from_secs(5),
                None,
                RunOptions {
                    backgrounds: store.clone(),
                    background_csv: capture_gap.then(|| BackgroundCsvOptions {
                        output_folder: csv_folder.clone(),
                        background_id: None,
                        scopes_format: Default::default(),
                        serial_format: Default::default(),
                    }),
                    ..Default::default()
                },
                |_| {},
                |_| false,
            );
            assert!(
                result.as_ref().is_ok_and(|r| r.succeeded()),
                "mode={mode}, infinite={infinite}: {result:?}"
            );
            let data = store.lock().unwrap();
            assert!(data.metadata()[0].row_count > 0);
            if !infinite {
                assert_eq!(
                    data.metadata()[0].row_count,
                    if mode.ends_with("-custom") { 9 } else { 3 }
                );
            }
            assert_eq!(data.metadata()[0].status, "completed");
            if capture_gap {
                assert_eq!(data.datasets.len(), 2);
                let recorded: usize = data.metadata().iter().map(|d| d.row_count).sum();
                assert!(recorded < data.monitor("background-1").len());
                for dataset in data.metadata() {
                    assert_eq!(dataset.status, "completed");
                    let csv = std::fs::read_to_string(dataset.csv_path.unwrap()).unwrap();
                    assert_eq!(csv.lines().count(), dataset.row_count + 1);
                    assert!(dataset.row_count > 0);
                }
                fs::remove_dir_all(&csv_folder).unwrap();
                println!(
                    "Real Meters Capture OFF: monitor continues, two captures and CSV row counts agree"
                );
            }
            println!(
                "Real Meters {mode} infinite={infinite}: {} samples, {}",
                data.metadata()[0].row_count,
                data.metadata()[0].quality
            );
        }
    }
    for scenario in [
        "external",
        "external-custom",
        "simple-stop",
        "simple-worker-off",
    ] {
        let external = scenario.starts_with("external");
        let mut wire: serde_json::Value = serde_json::from_str(&background_template(json!([
            {"type":"background","id":"on","background_id":"background-1","action":"worker-on","capture":true},
            {"type":"wait","id":"wait","duration_ms":150},
            {"type":"background","id":"off","background_id":"background-1","action":"worker-off","capture":true}
        ])).to_json_string().unwrap()).unwrap();
        wire["tool_instances"][0]["setup"]["trigger_mode"] =
            json!(if external { scenario } else { "software" });
        wire["backgrounds"][0]["limit_count"] = json!(100);
        if !external {
            wire["backgrounds"][0]["timer_interval_ms"] = json!(20);
        }
        let template = Template::from_json_str(&wire.to_string()).unwrap();
        let mut specs = prepare_worker_launch_specs_with_simulation(
            &template,
            ExecutionMode::Simulate,
            Path::new("."),
            &config,
            &HashMap::new(),
        )
        .unwrap();
        if external {
            for spec in specs.values_mut() {
                let args: Vec<_> = spec
                    .arguments()
                    .iter()
                    .map(|arg| {
                        if arg == "SIM::34461A" {
                            OsString::from("SIM::34460A")
                        } else {
                            arg.clone()
                        }
                    })
                    .collect();
                *spec = WorkerLaunchSpec::new(spec.executable(), args)
                    .with_manifest(spec.manifest().unwrap().clone());
            }
        }
        let store = Arc::new(Mutex::new(BackgroundStore::default()));
        let stop = WorkflowStop::default();
        let result = run_workflow_streaming_controlled(
            &template,
            ExecutionMode::Simulate,
            &specs,
            Duration::from_secs(10),
            Duration::from_secs(5),
            Duration::from_secs(5),
            None,
            RunOptions {
                backgrounds: store.clone(),
                workflow_stop: stop.clone(),
                ..Default::default()
            },
            |event| {
                if scenario == "simple-stop"
                    && matches!(event, WorkflowRunEvent::StepCompleted(ref step) if step.step_id().as_str() == "wait")
                {
                    stop.request();
                }
            },
            |_| false,
        );
        let data = store.lock().unwrap();
        if scenario == "simple-stop" {
            assert!(result.as_ref().is_ok_and(|r| r.stopped()), "{result:?}");
            assert_eq!(data.metadata()[0].status, "incomplete");
            assert!((1..100).contains(&data.metadata()[0].row_count));
        } else {
            assert!(result.is_err(), "{scenario}: {result:?}");
            assert_eq!(data.metadata()[0].status, "failed");
            if external {
                assert!(result.unwrap_err().to_string().contains("34460"));
            }
        }
        println!("Real Meters {scenario}: rejection or partial-stop outcome verified");
    }
    // A source bound is a launch parameter: it never turns the While into a finite loop.
    let setup = MetersSetup::default();
    let template=Template::from_json_str(&json!({"name":"Unlimited SIM", "tool_instances":[{"id":"meters-1","tool":"meters","setup":setup}],
        "workflow":{"interaction":{"enabled":false,"max_active_command_status":4096,"buffer":{"enabled":false,"mode":"fifo","overflow_policy":"fail-run"}},"steps":[{"type":"while","id":"loop","left":{"source":"literal","value":true},"operator":"equal","right":{"source":"literal","value":true},"max_iterations":null,
            "steps":[{"type":"tool-action","id":"measure","target":"meters-1","action":"measure","arguments":{}}]}]}}).to_string()).unwrap();
    let specs = prepare_worker_launch_specs_with_simulation(
        &template,
        ExecutionMode::Simulate,
        Path::new("."),
        &config,
        &HashMap::from([("meters-1".into(), 3)]),
    )
    .unwrap();
    for stop_early in [true, false] {
        let measured = std::cell::Cell::new(0);
        let mut measure_failed = false;
        let run = run_workflow_streaming_controlled(
            &template,
            ExecutionMode::Simulate,
            &specs,
            Duration::from_secs(10),
            Duration::from_secs(5),
            Duration::from_secs(5),
            None,
            RunOptions::default(),
            |event| {
                if let WorkflowRunEvent::StepCompleted(step) = event
                    && step.step_id().as_str() == "measure"
                {
                    match step.outcome() {
                        StepOutcome::Succeeded { .. } => measured.set(measured.get() + 1),
                        StepOutcome::Failed { .. } => measure_failed = true,
                        _ => {}
                    }
                }
            },
            |_| stop_early && measured.get() >= 2,
        );
        assert_eq!(measured.get(), if stop_early { 2 } else { 3 });
        if stop_early {
            assert!(run.as_ref().is_ok_and(|r| r.succeeded()), "{run:?}");
        } else {
            assert!(measure_failed);
            assert!(run.is_err() || run.as_ref().is_ok_and(|r| !r.succeeded()));
        }
    }
    assert!(
        template
            .to_json_string()
            .unwrap()
            .contains("\"max_iterations\": null")
    );
    println!(
        "Real Meters Software Unlimited SIM: stopped after 2 samples; exhausted after 3 samples and failed the next Measure"
    );
}
