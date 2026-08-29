use std::{
    env,
    ffi::{OsStr, OsString},
    io::{self, Write},
    thread,
    time::{Duration, Instant},
};

use orchestrator_tool::worker::{WorkerLaunchSpec, WorkerStartError, start_worker};

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
        unknown => panic!("unknown Worker fixture scenario {unknown:?}"),
    }
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
