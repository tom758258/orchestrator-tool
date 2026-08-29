use std::{
    env,
    ffi::{OsStr, OsString},
    io::{self, BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    thread,
    time::{Duration, Instant},
};

use orchestrator_tool::{
    worker::{WorkerLaunchSpec, WorkerShutdownError, WorkerStartError, start_worker},
    worker_http::{WorkerClient, WorkerHttpError},
};
use serde_json::json;

const FIXTURE_ARGUMENT: &str = "--worker-fixture";

fn main() {
    let mut arguments = env::args_os();
    let _ = arguments.next();

    if arguments.next().as_deref() == Some(OsStr::new(FIXTURE_ARGUMENT)) {
        let scenario = arguments
            .next()
            .expect("Worker fixture scenario is required");
        run_fixture(&scenario);
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
