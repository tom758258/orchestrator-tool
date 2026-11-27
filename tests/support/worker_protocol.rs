use super::*;

pub(super) fn run_http_fixture(scenario: &str) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    print_json_line(
        &json!({
            "event": "ready",
            "schema_version": 3,
            "run_id": format!("{scenario}-run"),
            "status_url": format!("{base_url}/status"),
            "command_url": format!("{base_url}/command"),
            "stop_url": format!("{base_url}/stop"),
        })
        .to_string(),
    );

    match scenario {
        "http-round-trip" => {
            let request = accept_request(&listener);
            assert_eq!(request.method, "GET");
            assert_eq!(request.path, "/status");
            write_response(request.stream, 200, r#"{"state":"idle"}"#);

            let request = accept_request(&listener);
            assert_eq!(request.method, "POST");
            assert_eq!(request.path, "/command");
            assert!(
                request
                    .content_type
                    .as_deref()
                    .is_some_and(|value| value.starts_with("application/json"))
            );
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&request.body).unwrap(),
                json!({"action": "measure", "value": 7})
            );
            write_response(request.stream, 202, r#"{"accepted":true}"#);

            let request = accept_request(&listener);
            assert_eq!(request.method, "POST");
            assert_eq!(request.path, "/stop");
            assert!(request.body.is_empty());
            write_response(request.stream, 200, r#"{"ok":true}"#);
        }
        "http-non-2xx" => {
            let request = accept_request(&listener);
            assert_eq!(request.method, "GET");
            assert_eq!(request.path, "/status");
            write_response(request.stream, 503, r#"{"error":"unavailable"}"#);
            thread::sleep(Duration::from_secs(30));
        }
        "shutdown-graceful" => {
            let request = accept_request(&listener);
            assert_eq!(request.method, "POST");
            assert_eq!(request.path, "/stop");
            write_response(request.stream, 202, "");
        }
        "shutdown-timeout" => {
            let request = accept_request(&listener);
            assert_eq!(request.method, "POST");
            assert_eq!(request.path, "/stop");
            write_response(request.stream, 202, "");
            thread::sleep(Duration::from_secs(30));
        }
        _ => unreachable!(),
    }
}

pub(super) fn run_job_unconfirmed_fixture(scenario: &str) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let run_id = "job-unconfirmed-run";
    print_json_line(
        &json!({"event":"ready","schema_version":3,"run_id":run_id,
            "status_url":format!("{base}/status"),
            "command_url":format!("{base}/command"),
            "stop_url":format!("{base}/stop")})
        .to_string(),
    );
    let request = accept_request(&listener);
    assert_eq!(request.path, "/command");
    write_response(
        request.stream,
        202,
        r#"{"status":"accepted","worker_job_id":"worker-1"}"#,
    );
    match scenario {
        "job-unconfirmed-summary" => print_json_line(
            &json!({"event":"summary","run_id":run_id,"ok":true,
                "exit_code":0,"fatal_error":null})
            .to_string(),
        ),
        "job-unconfirmed-fatal" => print_json_line(
            &json!({"event":"error","run_id":run_id,"scope":"worker",
                "fatal":true,"error":{"category":"worker","code":"worker_failed",
                    "message":"Worker failed","details":{}}})
            .to_string(),
        ),
        "job-unconfirmed-status" => print_json_line(
            &json!({"event":"status","run_id":run_id,
                "worker_state":"failed",
                "fatal_error":{"category":"worker","code":"worker_failed",
                    "message":"Worker failed","details":{}}})
            .to_string(),
        ),
        _ => panic!("unknown unconfirmed Job fixture {scenario}"),
    }
    loop {
        let request = accept_request(&listener);
        match request.path.as_str() {
            "/status" => write_response(
                request.stream,
                200,
                r#"{"worker_state":"running","fatal_error":null}"#,
            ),
            "/stop" => {
                write_response(request.stream, 200, r#"{"ok":true}"#);
                break;
            }
            other => panic!("unexpected unconfirmed Job request {other}"),
        }
    }
}

pub(super) fn opted_in_stream_readiness_preserves_samples_and_rejects_failure() {
    for scenario in [
        "meters-stream-active",
        "meters-stream-stale-status",
        "meters-stream-ended",
        "meters-stream-fatal",
    ] {
        let session = start_worker(&fixture_spec(scenario), Duration::from_secs(3)).unwrap();
        thread::sleep(Duration::from_millis(30));
        let readiness = session.wait_for_stream_active(Duration::from_secs(3));
        if matches!(
            scenario,
            "meters-stream-active" | "meters-stream-stale-status"
        ) {
            readiness.unwrap();
            let mut sample = None;
            for _ in 0..4 {
                let event = session.recv_event(Duration::from_secs(2)).unwrap();
                if event["event"] == "sample" {
                    sample = Some(event);
                    break;
                }
            }
            assert_eq!(sample.unwrap()["value"], json!(12.3));
        } else {
            assert!(
                readiness.is_err(),
                "{scenario} must not release source readiness"
            );
        }
        let shutdown = session.shutdown(Duration::from_secs(3));
        if scenario == "meters-stream-fatal" {
            assert!(shutdown.is_err(), "fatal evidence must fail shutdown");
        } else {
            assert!(shutdown.unwrap().success());
        }
    }
}

pub(super) fn async_job_without_terminal_is_unconfirmed() {
    for scenario in [
        "job-unconfirmed-summary",
        "job-unconfirmed-fatal",
        "job-unconfirmed-status",
    ] {
        let session = start_worker(&fixture_spec(scenario), Duration::from_secs(3)).unwrap();
        let outcome = session.run_async_job(
            "read",
            &json!({}),
            Some(json!({"mode":"simulate"})),
            "client-unconfirmed",
            Duration::from_secs(3),
        );
        assert!(outcome.is_err(), "{scenario} must not confirm a Job");
        {
            let tracker = session.job_tracker().lock().unwrap();
            let job = tracker.job("client-unconfirmed").unwrap();
            assert!(job.terminal().is_none());
            assert!(
                job.unconfirmed().is_some(),
                "{scenario} must retain Unconfirmed"
            );
        }
        let _ = session.shutdown(Duration::from_secs(3));
    }
}

pub(super) fn common_v3_accepts_additional_tool_without_parser_branch() {
    let session = start_worker(
        &fixture_spec("conformance-extra-tool"),
        Duration::from_secs(5),
    )
    .unwrap();
    let result = session
        .run_async_job(
            "do-work",
            &json!({}),
            None,
            "client-extra-1",
            Duration::from_secs(3),
        )
        .unwrap();
    assert_eq!(result["result"]["answer"], 42);
    assert!(session.shutdown(Duration::from_secs(5)).unwrap().success());
}

pub(super) fn valid_ready_starts_worker_session() {
    let session = start_worker(&fixture_spec("valid-ready"), Duration::from_secs(5)).unwrap();

    assert_ne!(session.process_id(), 0);
    assert_eq!(session.ready().schema_version(), 3);
    assert_eq!(session.ready().run_id(), "run-123");
    assert_eq!(session.ready().status_url(), "http://127.0.0.1/status");
    assert_eq!(session.ready().command_url(), "http://127.0.0.1/command");
    assert_eq!(session.ready().stop_url(), "http://127.0.0.1/stop");
}

pub(super) fn invalid_ready_protocol_is_rejected() {
    for scenario in ["malformed-json", "unsupported-schema"] {
        let error = start_worker(&fixture_spec(scenario), Duration::from_secs(5))
            .err()
            .expect("invalid ready should fail startup");

        assert!(
            matches!(
                (scenario, error),
                ("malformed-json", WorkerStartError::InvalidReady(_))
                    | ("unsupported-schema", WorkerStartError::InvalidContract(_))
            ),
            "unexpected error for {scenario}"
        );
    }
}

pub(super) fn worker_exit_before_ready_returns_early() {
    let start = Instant::now();
    let error = start_worker(&fixture_spec("exit-before-ready"), Duration::from_secs(5))
        .err()
        .expect("Worker exit before ready should fail startup");

    let WorkerStartError::ExitedBeforeReady { status, diagnostic } = &error else {
        panic!("unexpected startup error: {error:?}");
    };
    assert!(status.success());
    assert_eq!(*diagnostic, None);
    assert_eq!(
        error.to_string(),
        format!("Worker exited before ready with {status}")
    );
    assert!(
        start.elapsed() < Duration::from_secs(2),
        "early exit should not wait for the startup timeout"
    );
}

pub(super) fn worker_exit_before_ready_surfaces_stderr_diagnostic() {
    let error = start_worker(
        &fixture_spec("exit-before-ready-with-stderr"),
        Duration::from_secs(5),
    )
    .err()
    .expect("Worker exit with stderr should fail startup");

    let WorkerStartError::ExitedBeforeReady { status, diagnostic } = &error else {
        panic!("unexpected startup error: {error:?}");
    };
    assert_eq!(status.code(), Some(2));
    assert_eq!(
        diagnostic.as_deref(),
        Some("fixture startup validation failed")
    );
    let message = error.to_string();
    assert!(
        message.contains("Worker exited before ready"),
        "message missing exit context: {message:?}"
    );
    assert!(
        message.contains(&status.to_string()),
        "message missing exit status: {message:?}"
    );
    assert!(
        message.contains("fixture startup validation failed"),
        "message missing stderr diagnostic: {message:?}"
    );
}

pub(super) fn worker_exit_before_ready_prefers_structured_stdout_diagnostic() {
    let error = start_worker(
        &fixture_spec("exit-before-ready-with-stdout-error"),
        Duration::from_secs(5),
    )
    .err()
    .expect("Worker exit with stdout error should fail startup");

    let WorkerStartError::ExitedBeforeReady { status, diagnostic } = &error else {
        panic!("unexpected startup error: {error:?}");
    };
    assert_eq!(status.code(), Some(2));
    assert_eq!(
        diagnostic.as_deref(),
        Some("fixture structured startup validation failed")
    );
    let message = error.to_string();
    assert!(
        message.contains("Worker exited before ready"),
        "message missing exit context: {message:?}"
    );
    assert!(
        message.contains(&status.to_string()),
        "message missing exit status: {message:?}"
    );
    assert!(
        message.contains("fixture structured startup validation failed"),
        "message missing structured diagnostic: {message:?}"
    );
    assert!(
        !message.contains("fixture stderr fallback"),
        "structured diagnostic should win over stderr: {message:?}"
    );
}

pub(super) fn startup_timeout_terminates_worker() {
    let timeout = Duration::from_millis(100);
    let start = Instant::now();
    let error = start_worker(&fixture_spec("no-ready"), timeout)
        .err()
        .expect("Worker without ready should time out");

    assert!(matches!(error, WorkerStartError::StartupTimeout(value) if value == timeout));
    assert!(
        start.elapsed() < Duration::from_secs(5),
        "startup timeout cleanup should not hang"
    );
}

pub(super) fn common_worker_http_round_trip() {
    let session = start_worker(&fixture_spec("http-round-trip"), Duration::from_secs(5)).unwrap();
    let client = WorkerClient::new(session.ready());

    assert_eq!(client.status().unwrap()["worker_state"], "running");
    assert_eq!(
        client
            .command(&json!({"action": "measure", "value": 7}))
            .unwrap(),
        json!({"accepted": true})
    );
    assert_eq!(client.stop().unwrap().unwrap()["status"], "accepted");
}

pub(super) fn non_2xx_http_response_is_rejected() {
    let session = start_worker(&fixture_spec("http-non-2xx"), Duration::from_secs(5)).unwrap();
    let error = WorkerClient::new(session.ready()).status().unwrap_err();

    assert!(matches!(error, WorkerHttpError::Non2xx(503)));
}

pub(super) fn graceful_shutdown_reaps_worker() {
    let session = start_worker(&fixture_spec("shutdown-graceful"), Duration::from_secs(5)).unwrap();

    assert!(session.shutdown(Duration::from_secs(5)).unwrap().success());
}

pub(super) fn shutdown_timeout_forces_cleanup() {
    let session = start_worker(&fixture_spec("shutdown-timeout"), Duration::from_secs(5)).unwrap();
    let timeout = Duration::from_millis(100);
    let start = Instant::now();
    let error = session.shutdown(timeout).unwrap_err();

    assert!(matches!(error, WorkerShutdownError::GracefulTimeout(value) if value == timeout));
    assert!(
        start.elapsed() < Duration::from_secs(5),
        "forced shutdown cleanup should not hang"
    );
}

pub(super) fn runtime_events_are_available_after_ready() {
    let session = start_worker(
        &fixture_spec("ready-with-runtime-events"),
        Duration::from_secs(5),
    )
    .unwrap();

    let sample = session
        .recv_event(Duration::from_secs(2))
        .expect("first runtime event should be sample");
    assert_eq!(sample["event"], "sample");
    assert_eq!(sample["seq"], 1);

    let summary = session
        .recv_event(Duration::from_secs(2))
        .expect("second runtime event should be summary");
    assert_eq!(summary["event"], "summary");
    assert_eq!(summary["count"], 1);
    assert_eq!(summary["ok"], true);

    assert!(session.shutdown(Duration::from_secs(5)).unwrap().success());
}

pub(super) fn runtime_event_receive_times_out_when_no_event() {
    let session = start_worker(&fixture_spec("ready-no-events"), Duration::from_secs(5)).unwrap();
    let timeout = Duration::from_millis(200);
    let error = session.recv_event(timeout).unwrap_err();

    assert!(
        matches!(error, orchestrator_tool::worker::WorkerEventError::Timeout(value) if value == timeout),
        "unexpected error: {error:?}"
    );

    assert!(session.shutdown(Duration::from_secs(5)).unwrap().success());
}
