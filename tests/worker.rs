use std::{
    env,
    ffi::{OsStr, OsString},
    io::{self, BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    process, thread,
    time::{Duration, Instant},
};

use orchestrator_tool::{
    adapters::{
        meters::run_worker_smoke as run_meters_worker_smoke,
        powers::{PowersSmokeError, run_worker_smoke as run_powers_worker_smoke},
    },
    worker::{WorkerLaunchSpec, WorkerShutdownError, WorkerStartError, start_worker},
    worker_http::{WorkerClient, WorkerHttpError},
};
use serde_json::json;

const FIXTURE_ARGUMENT: &str = "--worker-fixture";
const POWERS_WORKER_ARGUMENTS: [&str; 7] = [
    "worker",
    "--mode",
    "simulate",
    "--control-port",
    "0",
    "--artifact-mode",
    "memory",
];
const METERS_WORKER_ARGUMENTS: [&str; 15] = [
    "start-trigger-record",
    "--resource",
    "SIM::34461A",
    "--simulate",
    "--measurement",
    "voltage-dc",
    "--trigger-mode",
    "software",
    "--max-samples",
    "2",
    "--status-format",
    "jsonl",
    "--sw-trigger-port",
    "0",
    "--no-csv",
];
const POWERS_FIXTURE_SCENARIO_ENV: &str = "ORCHESTRATOR_TEST_POWERS_SCENARIO";

fn main() {
    let arguments: Vec<_> = env::args_os().skip(1).collect();

    if arguments == POWERS_WORKER_ARGUMENTS.map(OsString::from) {
        run_powers_worker_fixture();
        return;
    }
    if arguments == METERS_WORKER_ARGUMENTS.map(OsString::from) {
        run_meters_worker_fixture();
        return;
    }

    if arguments.first().map(OsString::as_os_str) == Some(OsStr::new(FIXTURE_ARGUMENT)) {
        let scenario = arguments
            .get(1)
            .expect("Worker fixture scenario is required");
        run_fixture(scenario);
        return;
    }

    valid_ready_starts_worker_session();
    invalid_ready_protocol_is_rejected();
    worker_exit_before_ready_returns_early();
    startup_timeout_terminates_worker();
    common_worker_http_round_trip();
    non_2xx_http_response_is_rejected();
    graceful_shutdown_reaps_worker();
    shutdown_timeout_forces_cleanup();
    runtime_events_are_available_after_ready();
    runtime_event_receive_times_out_when_no_event();
    powers_worker_smoke_correlates_terminal_job();
    powers_operation_failure_preserves_nonzero_worker_exit();
    powers_terminal_failure_preserves_diagnostic_detail();
    meters_worker_smoke_captures_sample_and_shuts_down();
}

fn run_powers_worker_fixture() {
    let scenario = env::var(POWERS_FIXTURE_SCENARIO_ENV).unwrap_or_else(|_| "success".to_owned());
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let run_id = "powers-smoke-run";
    print_json_line(
        &json!({
            "event": "ready",
            "schema_version": 2,
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
            "schema_version": 2,
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
            "schema_version": 2,
            "command": "read-status",
            "arguments": { "channel": "all" },
            "context": {
                "mode": "simulate",
                "planning_model_id": "keysight-e36312a"
            }
        })
    );
    write_response(
        request.stream,
        202,
        r#"{"schema_version":2,"status":"accepted","command":"read-status","worker_job_id":"job-current"}"#,
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
                "schema_version": 2,
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

fn run_meters_worker_fixture() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let run_id = "meters-smoke-run";
    print_json_line(
        &json!({
            "event": "ready",
            "schema_version": 2,
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
            "schema_version": 2,
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
            "schema_version": 2,
            "command": "software_trigger",
            "job_id": "orchestrator-meter-smoke"
        })
    );
    write_response(
        request.stream,
        202,
        r#"{"schema_version":2,"status":"accepted","command":"software_trigger","job_id":"orchestrator-meter-smoke"}"#,
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
            "schema_version": 2,
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

fn run_fixture(scenario: &OsStr) {
    match scenario.to_str().expect("fixture scenario must be UTF-8") {
        "valid-ready" => {
            print_json_line("");
            print_json_line(r#"{"event":"boot","message":"starting"}"#);
            print_json_line(
                r#"{"event":"ready","schema_version":2,"run_id":"run-123","status_url":"http://127.0.0.1/status","command_url":"http://127.0.0.1/command","stop_url":"http://127.0.0.1/stop","future_optional_field":true}"#,
            );
            thread::sleep(Duration::from_secs(30));
        }
        "malformed-json" => print_json_line("{ not json }"),
        "unsupported-schema" => print_json_line(
            r#"{"event":"ready","schema_version":3,"run_id":"run-123","status_url":"status","command_url":"command","stop_url":"stop"}"#,
        ),
        "exit-before-ready" => {}
        "no-ready" => thread::sleep(Duration::from_secs(30)),
        "ready-with-runtime-events" => {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let base_url = format!("http://{}", listener.local_addr().unwrap());
            print_json_line("");
            print_json_line(r#"{"event":"boot","message":"starting"}"#);
            print_json_line(
                &json!({
                    "event": "ready",
                    "schema_version": 2,
                    "run_id": "run-123",
                    "status_url": format!("{base_url}/status"),
                    "command_url": format!("{base_url}/command"),
                    "stop_url": format!("{base_url}/stop"),
                    "future_optional_field": true
                })
                .to_string(),
            );
            print_json_line("");
            print_json_line(r#"{"event":"sample","seq":1}"#);
            print_json_line(r#"{"event":"summary","count":1}"#);
            let request = accept_request(&listener);
            assert_eq!(request.path, "/stop");
            write_response(request.stream, 200, r#"{"ok":true}"#);
        }
        "ready-no-events" => {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let base_url = format!("http://{}", listener.local_addr().unwrap());
            print_json_line(
                &json!({
                    "event": "ready",
                    "schema_version": 2,
                    "run_id": "run-123",
                    "status_url": format!("{base_url}/status"),
                    "command_url": format!("{base_url}/command"),
                    "stop_url": format!("{base_url}/stop")
                })
                .to_string(),
            );
            let request = accept_request(&listener);
            assert_eq!(request.path, "/stop");
            write_response(request.stream, 200, r#"{"ok":true}"#);
        }
        "http-round-trip" | "http-non-2xx" | "shutdown-graceful" | "shutdown-timeout" => {
            run_http_fixture(scenario.to_str().unwrap())
        }
        unknown => panic!("unknown Worker fixture scenario {unknown:?}"),
    }
}

fn run_http_fixture(scenario: &str) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    print_json_line(
        &json!({
            "event": "ready",
            "schema_version": 2,
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

struct TestRequest {
    stream: TcpStream,
    method: String,
    path: String,
    content_type: Option<String>,
    body: Vec<u8>,
}

fn accept_request(listener: &TcpListener) -> TestRequest {
    let (stream, _) = listener.accept().unwrap();
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut request_line = String::new();
    reader.read_line(&mut request_line).unwrap();
    let mut request_parts = request_line.split_ascii_whitespace();
    let method = request_parts.next().unwrap().to_owned();
    let path = request_parts.next().unwrap().to_owned();
    let mut content_length = 0;
    let mut content_type = None;

    loop {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        if line == "\r\n" || line == "\n" {
            break;
        }

        let (name, value) = line.split_once(':').unwrap();
        let value = value.trim();
        if name.eq_ignore_ascii_case("content-length") {
            content_length = value.parse().unwrap();
        } else if name.eq_ignore_ascii_case("content-type") {
            content_type = Some(value.to_owned());
        }
    }

    let mut body = vec![0; content_length];
    reader.read_exact(&mut body).unwrap();

    TestRequest {
        stream,
        method,
        path,
        content_type,
        body,
    }
}

fn write_response(mut stream: TcpStream, status: u16, body: &str) {
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        503 => "Service Unavailable",
        _ => unreachable!(),
    };
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .unwrap();
    stream.flush().unwrap();
}

fn print_json_line(line: &str) {
    let stdout = io::stdout();
    let mut stdout = stdout.lock();
    writeln!(stdout, "{line}").unwrap();
    stdout.flush().unwrap();
}

fn fixture_spec(scenario: &str) -> WorkerLaunchSpec {
    WorkerLaunchSpec::new(
        env::current_exe().unwrap(),
        [OsString::from(FIXTURE_ARGUMENT), OsString::from(scenario)],
    )
}

fn valid_ready_starts_worker_session() {
    let session = start_worker(&fixture_spec("valid-ready"), Duration::from_secs(5)).unwrap();

    assert_ne!(session.process_id(), 0);
    assert_eq!(session.ready().schema_version(), 2);
    assert_eq!(session.ready().run_id(), "run-123");
    assert_eq!(session.ready().status_url(), "http://127.0.0.1/status");
    assert_eq!(session.ready().command_url(), "http://127.0.0.1/command");
    assert_eq!(session.ready().stop_url(), "http://127.0.0.1/stop");
}

fn invalid_ready_protocol_is_rejected() {
    for scenario in ["malformed-json", "unsupported-schema"] {
        let error = start_worker(&fixture_spec(scenario), Duration::from_secs(5))
            .err()
            .expect("invalid ready should fail startup");

        assert!(
            matches!(
                (scenario, error),
                ("malformed-json", WorkerStartError::InvalidReady(_))
                    | (
                        "unsupported-schema",
                        WorkerStartError::UnsupportedSchemaVersion(3)
                    )
            ),
            "unexpected error for {scenario}"
        );
    }
}

fn worker_exit_before_ready_returns_early() {
    let start = Instant::now();
    let error = start_worker(&fixture_spec("exit-before-ready"), Duration::from_secs(5))
        .err()
        .expect("Worker exit before ready should fail startup");

    assert!(matches!(error, WorkerStartError::ExitedBeforeReady(status) if status.success()));
    assert!(
        start.elapsed() < Duration::from_secs(2),
        "early exit should not wait for the startup timeout"
    );
}

fn startup_timeout_terminates_worker() {
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

fn common_worker_http_round_trip() {
    let session = start_worker(&fixture_spec("http-round-trip"), Duration::from_secs(5)).unwrap();
    let client = WorkerClient::new(session.ready());

    assert_eq!(client.status().unwrap(), json!({"state": "idle"}));
    assert_eq!(
        client
            .command(&json!({"action": "measure", "value": 7}))
            .unwrap(),
        json!({"accepted": true})
    );
    assert_eq!(client.stop().unwrap(), Some(json!({"ok": true})));
}

fn non_2xx_http_response_is_rejected() {
    let session = start_worker(&fixture_spec("http-non-2xx"), Duration::from_secs(5)).unwrap();
    let error = WorkerClient::new(session.ready()).status().unwrap_err();

    assert!(matches!(error, WorkerHttpError::Non2xx(503)));
}

fn graceful_shutdown_reaps_worker() {
    let session = start_worker(&fixture_spec("shutdown-graceful"), Duration::from_secs(5)).unwrap();

    assert!(session.shutdown(Duration::from_secs(5)).unwrap().success());
}

fn shutdown_timeout_forces_cleanup() {
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

fn runtime_events_are_available_after_ready() {
    let session = start_worker(
        &fixture_spec("ready-with-runtime-events"),
        Duration::from_secs(5),
    )
    .unwrap();

    let sample = session
        .recv_event(Duration::from_secs(2))
        .expect("first runtime event should be sample");
    assert_eq!(sample, json!({"event":"sample","seq":1}));

    let summary = session
        .recv_event(Duration::from_secs(2))
        .expect("second runtime event should be summary");
    assert_eq!(summary, json!({"event":"summary","count":1}));

    assert!(session.shutdown(Duration::from_secs(5)).unwrap().success());
}

fn runtime_event_receive_times_out_when_no_event() {
    let session = start_worker(&fixture_spec("ready-no-events"), Duration::from_secs(5)).unwrap();
    let timeout = Duration::from_millis(200);
    let error = session.recv_event(timeout).unwrap_err();

    assert!(
        matches!(error, orchestrator_tool::worker::WorkerEventError::Timeout(value) if value == timeout),
        "unexpected error: {error:?}"
    );

    assert!(session.shutdown(Duration::from_secs(5)).unwrap().success());
}

fn powers_worker_smoke_correlates_terminal_job() {
    run_powers_fixture_scenario("success").unwrap();
}

fn meters_worker_smoke_captures_sample_and_shuts_down() {
    run_meters_worker_smoke(
        env::current_exe().unwrap(),
        Duration::from_secs(5),
        Duration::from_secs(5),
        Duration::from_secs(5),
    )
    .unwrap();
}

fn powers_operation_failure_preserves_nonzero_worker_exit() {
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

fn powers_terminal_failure_preserves_diagnostic_detail() {
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
