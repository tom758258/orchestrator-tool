use std::{
    collections::HashMap,
    env,
    ffi::{OsStr, OsString},
    fs,
    io::{self, BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    process, thread,
    time::{Duration, Instant},
};

use orchestrator_tool::{
    adapters::{
        meters::{run_action as run_meters_action, run_worker_smoke as run_meters_worker_smoke},
        powers::{
            PowersSmokeError, run_action as run_powers_action,
            run_worker_smoke as run_powers_worker_smoke,
        },
    },
    instrument_setup::{AutoZero, MetersMeasurement, MetersSetup, RangeMode},
    run::{ExecutionMode, WorkflowRunError, run_simulated_workflow, run_workflow},
    template::Template,
    tool::ToolId,
    worker::{WorkerLaunchSpec, WorkerShutdownError, WorkerStartError, start_worker},
    worker_http::{WorkerClient, WorkerHttpError},
    workflow::{ActionId, Step, StepId, StepKind, StepOutcome, Workflow},
    workflow_csv::serialize_workflow_outputs_csv,
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
const METERS_WORKER_ARGUMENTS: [&str; 21] = [
    "start-trigger-record",
    "--resource",
    "SIM::34461A",
    "--simulate",
    "--trigger-mode",
    "software",
    "--max-samples",
    "2",
    "--status-format",
    "jsonl",
    "--sw-trigger-port",
    "0",
    "--no-csv",
    "--measurement",
    "voltage-dc",
    "--auto-range",
    "on",
    "--nplc",
    "1",
    "--auto-zero",
    "on",
];
const POWERS_FIXTURE_SCENARIO_ENV: &str = "ORCHESTRATOR_TEST_POWERS_SCENARIO";
const CLEANUP_MARKER_ENV: &str = "ORCHESTRATOR_TEST_CLEANUP_MARKER";

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

    if arguments.first().map(OsString::as_os_str) == Some(OsStr::new("start-trigger-record")) {
        let bound = arguments
            .windows(2)
            .find(|pair| pair[0] == "--max-samples")
            .unwrap()[1]
            .to_str()
            .unwrap()
            .parse()
            .unwrap();
        run_meters_runtime_fixture(3, bound, json!(3.3));
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
    powers_runtime_action_succeeds();
    meters_runtime_measure_returns_sample();
    powers_and_meters_workflow_executes_end_to_end();
    simulated_measurement_dataflow_exports_csv();
    three_meter_measurements_shutdown_normally();
    partial_startup_failure_shuts_down_started_worker();
    live_workflow_cleanup_lifecycle();
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
        "partial-startup-cleanup" => {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let base_url = format!("http://{}", listener.local_addr().unwrap());
            print_json_line(
                &json!({
                    "event": "ready",
                    "schema_version": 2,
                    "run_id": "partial-startup-cleanup-run",
                    "status_url": format!("{base_url}/status"),
                    "command_url": format!("{base_url}/command"),
                    "stop_url": format!("{base_url}/stop")
                })
                .to_string(),
            );
            let request = accept_request(&listener);
            assert_eq!(
                (request.method.as_str(), request.path.as_str()),
                ("POST", "/stop")
            );
            let marker = env::var_os(CLEANUP_MARKER_ENV).expect("cleanup marker path is required");
            fs::write(marker, "stopped").unwrap();
            write_response(request.stream, 200, r#"{"ok":true}"#);
        }
        "http-round-trip" | "http-non-2xx" | "shutdown-graceful" | "shutdown-timeout" => {
            run_http_fixture(scenario.to_str().unwrap())
        }
        "powers-runtime-success" => run_powers_runtime_fixture(),
        "powers-workflow-runtime" => run_powers_workflow_fixture("simulate"),
        "live-success"
        | "live-step-failure"
        | "live-cleanup-failure"
        | "live-both-failed"
        | "live-startup-failure" => run_powers_workflow_fixture(scenario.to_str().unwrap()),
        "meters-runtime-measure" => run_meters_runtime_fixture(1, 2, json!(3.3)),
        "meters-csv-measure" => run_meters_runtime_fixture(1, 2, json!(5)),
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

fn run_powers_runtime_fixture() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let run_id = "powers-runtime-run";
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

    // Expect runtime powers command.
    let request = accept_request(&listener);
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, "/command");
    let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
    assert_eq!(body["schema_version"], 2);
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
            r#"{{"schema_version":2,"status":"accepted","command":"{command}","worker_job_id":"job-runtime-001"}}"#
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
            "schema_version": 2,
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
            "schema_version": 2,
            "service": "powers-tool",
            "run_id": run_id,
            "status": "ready",
            "fatal_error": null,
            "active_job": null,
            "last_job": {
                "worker_job_id": "job-runtime-001",
                "status": "succeeded",
                "result": { "channel": 1, "voltage": 5.0 }
            }
        })
        .to_string(),
    );

    let request = accept_request(&listener);
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, "/stop");
    write_response(request.stream, 200, r#"{"ok":true}"#);
}

fn run_powers_workflow_fixture(scenario: &str) {
    let live = scenario != "simulate";
    let step_failed = matches!(scenario, "live-step-failure" | "live-both-failed");
    let cleanup_failed = matches!(scenario, "live-cleanup-failure" | "live-both-failed");
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let run_id = "powers-workflow-runtime-run";
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

    let mut commands = vec![
        (
            "set",
            json!({ "channel": 1, "voltage": 5.0 }),
            "job-workflow-001",
        ),
        ("output-on", json!({ "channel": 1 }), "job-workflow-002"),
        ("output-off", json!({ "channel": 1 }), "job-workflow-003"),
    ];
    if step_failed {
        commands.truncate(2);
    }
    if scenario == "live-startup-failure" {
        commands.clear();
    }
    if live {
        commands.push(("safe-off", json!({ "channel": "all" }), "job-cleanup"));
    }
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
                "schema_version": 2,
                "command": command,
                "arguments": arguments,
                "context": context
            })
        );
        if live {
            record_live_event(command);
        }
        write_response(
            request.stream,
            202,
            &json!({
                "schema_version": 2,
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
        write_response(
            request.stream,
            200,
            &json!({
                "schema_version": 2,
                "service": "powers-tool",
                "run_id": run_id,
                "status": "ready",
                "fatal_error": null,
                "active_job": null,
                "last_job": {
                    "worker_job_id": worker_job_id,
                    "status": if (step_failed && command == "output-on") || (cleanup_failed && command == "safe-off") { "failed" } else { "succeeded" },
                    "error": { "message": if command == "safe-off" { "fixture cleanup failure" } else { "fixture action failure" } },
                    "result": { "ok": true }
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
    if live {
        record_live_event("stop");
    }
    write_response(request.stream, 200, r#"{"ok":true}"#);
}

fn run_meters_runtime_fixture(measurements: usize, max_samples: usize, value: serde_json::Value) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let run_id = "meters-runtime-run";
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

    for sequence in 1..=measurements {
        let request = accept_request(&listener);
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/command");
        let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
        assert_eq!(body["schema_version"], 2);
        assert_eq!(body["command"], "software_trigger");
        assert_eq!(body["arguments"], json!({}));
        assert!(
            body.get("context").is_none(),
            "meters runtime must not send context"
        );
        assert!(
            body.get("job_id").is_none(),
            "meters runtime must omit job_id"
        );
        assert!(
            body.get("metadata").is_none(),
            "meters runtime must not send metadata"
        );
        write_response(
            request.stream,
            202,
            r#"{"schema_version":2,"status":"accepted","command":"software_trigger","job_id":null}"#,
        );

        // Emit a non-matching event first, then the matching sample.
        print_json_line(
            &json!({
                "event": "heartbeat",
                "run_id": run_id,
                "status": "running"
            })
            .to_string(),
        );
        print_json_line(
            &json!({
                "event": "sample",
                "run_id": run_id,
                "value": value,
                "sequence": sequence,
                "unit": "V"
            })
            .to_string(),
        );

        if sequence >= max_samples {
            return;
        }
    }

    let request = accept_request(&listener);
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, "/stop");
    write_response(request.stream, 200, r#"{"ok":true}"#);
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

fn powers_runtime_action_succeeds() {
    let session = start_worker(
        &fixture_spec("powers-runtime-success"),
        Duration::from_secs(5),
    )
    .unwrap();
    let action = ActionId::new("set-voltage").unwrap();
    let result = run_powers_action(
        &session,
        &action,
        &json!({ "channel": 1, "voltage": 5.0 }),
        ExecutionMode::Simulate,
        Duration::from_secs(5),
    )
    .unwrap();
    assert_eq!(result, json!({ "channel": 1, "voltage": 5.0 }));
    assert!(session.shutdown(Duration::from_secs(5)).unwrap().success());
}

fn meters_runtime_measure_returns_sample() {
    let session = start_worker(
        &fixture_spec("meters-runtime-measure"),
        Duration::from_secs(5),
    )
    .unwrap();
    let action = ActionId::new("measure").unwrap();
    let result = run_meters_action(&session, &action, &json!({}), Duration::from_secs(5)).unwrap();
    assert_eq!(result["event"], "sample");
    assert_eq!(result["run_id"], session.ready().run_id());
    assert_eq!(result["value"], 3.3);
    assert!(session.shutdown(Duration::from_secs(5)).unwrap().success());
}

fn powers_and_meters_workflow_executes_end_to_end() {
    let workflow = Workflow::new(vec![
        Step::new(
            StepId::new("power-set-1").unwrap(),
            StepKind::ToolAction {
                tool: ToolId::powers(),
                action: ActionId::new("set-voltage").unwrap(),
                arguments: json!({ "channel": 1, "voltage": 5.0 }),
                bindings: Default::default(),
            },
        ),
        Step::new(
            StepId::new("power-on-1").unwrap(),
            StepKind::ToolAction {
                tool: ToolId::powers(),
                action: ActionId::new("output-on").unwrap(),
                arguments: json!({ "channel": 1 }),
                bindings: Default::default(),
            },
        ),
        Step::new(
            StepId::new("wait-1").unwrap(),
            StepKind::Wait { duration_ms: 1 },
        ),
        Step::new(
            StepId::new("meter-read-1").unwrap(),
            StepKind::ToolAction {
                tool: ToolId::meters(),
                action: ActionId::new("measure").unwrap(),
                arguments: json!({}),
                bindings: Default::default(),
            },
        ),
        Step::new(
            StepId::new("power-off-1").unwrap(),
            StepKind::ToolAction {
                tool: ToolId::powers(),
                action: ActionId::new("output-off").unwrap(),
                arguments: json!({ "channel": 1 }),
                bindings: Default::default(),
            },
        ),
    ])
    .unwrap();
    let launch_specs = HashMap::from([
        (ToolId::powers(), fixture_spec("powers-workflow-runtime")),
        (ToolId::meters(), fixture_spec("meters-runtime-measure")),
    ]);

    let results = run_simulated_workflow(
        &workflow,
        &launch_specs,
        Duration::from_secs(5),
        Duration::from_secs(5),
        Duration::from_secs(5),
    )
    .unwrap();

    assert!(workflow.project_outputs(&results).unwrap().is_empty());
    assert_eq!(results.len(), 5);
    assert_eq!(
        results
            .iter()
            .map(|result| result.step_id().as_str())
            .collect::<Vec<_>>(),
        [
            "power-set-1",
            "power-on-1",
            "wait-1",
            "meter-read-1",
            "power-off-1"
        ]
    );
    assert!(
        results
            .iter()
            .all(|result| matches!(result.outcome(), StepOutcome::Succeeded { .. }))
    );
    let StepOutcome::Succeeded { output } = results[3].outcome() else {
        unreachable!("meter-read-1 outcome was already checked as succeeded");
    };
    assert_eq!(output["event"], "sample");
    assert_eq!(output["value"], 3.3);
    assert_eq!(output["unit"], "V");
}

fn simulated_measurement_dataflow_exports_csv() {
    let template = Template::from_json_str(
        &json!({
            "schema_version": 1,
            "instrument_setup": {"meters": null},
            "name": "Measurement CSV",
            "workflow": { "steps": [
                {
                    "type": "set-variable", "id": "set-threshold", "variable": "threshold",
                    "value": { "source": "literal", "value": 3 }
                },
                {
                    "type": "tool-action", "id": "meter-read-1", "tool": "meters",
                    "action": "measure", "arguments": {}
                },
                {
                    "type": "output", "id": "output-voltage", "name": "voltage",
                    "value": { "source": "step-output", "step_id": "meter-read-1", "pointer": "/value" }
                },
                {
                    "type": "output", "id": "output-passed", "name": "passed",
                    "value": {
                        "source": "expression",
                        "left": { "source": "step-output", "step_id": "meter-read-1", "pointer": "/value" },
                        "operator": "greater-than",
                        "right": { "source": "variable", "variable": "threshold" }
                    }
                }
            ] }
        })
        .to_string(),
    )
    .unwrap();
    let definition_before_run = template.to_json_string().unwrap();
    let results = run_simulated_workflow(
        template.workflow(),
        &HashMap::from([(ToolId::meters(), fixture_spec("meters-csv-measure"))]),
        Duration::from_secs(5),
        Duration::from_secs(5),
        Duration::from_secs(5),
    )
    .unwrap();

    assert_eq!(results.len(), 4);
    assert_eq!(results[1].step_id().as_str(), "meter-read-1");
    let StepOutcome::Succeeded { output } = results[1].outcome() else {
        panic!("measurement failed: {:?}", results[1].outcome());
    };
    assert_eq!(output["value"], 5);
    let outputs = template.workflow().project_outputs(&results).unwrap();
    assert_eq!(
        serialize_workflow_outputs_csv(&outputs).unwrap(),
        "voltage,passed\n5,true\n"
    );

    let saved = template.to_json_string().unwrap();
    assert_eq!(saved, definition_before_run);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&saved).unwrap()["schema_version"],
        1
    );
    assert_eq!(Template::from_json_str(&saved).unwrap(), template);
}

fn three_meter_measurements_shutdown_normally() {
    let workflow = Workflow::new(
        (1..=3)
            .map(|sequence| {
                Step::new(
                    StepId::new(format!("read-{sequence}")).unwrap(),
                    StepKind::ToolAction {
                        tool: ToolId::meters(),
                        action: ActionId::new("measure").unwrap(),
                        arguments: json!({}),
                        bindings: Default::default(),
                    },
                )
            })
            .collect(),
    )
    .unwrap();
    let spec = orchestrator_tool::adapters::meters::simulate_worker_launch_spec(
        env::current_exe().unwrap(),
        4,
        &MetersSetup {
            measurement: MetersMeasurement::VoltageDc,
            range_mode: RangeMode::Auto,
            manual_range: None,
            nplc: 1.0,
            auto_zero: AutoZero::On,
            dcv_input_impedance: None,
            current_terminal: None,
        },
    );
    let results = run_simulated_workflow(
        &workflow,
        &HashMap::from([(ToolId::meters(), spec)]),
        Duration::from_secs(5),
        Duration::from_secs(5),
        Duration::from_secs(5),
    )
    .unwrap();
    assert_eq!(results.len(), 3);
    for (index, result) in results.iter().enumerate() {
        assert_eq!(result.step_id().as_str(), format!("read-{}", index + 1));
        let StepOutcome::Succeeded { output } = result.outcome() else {
            panic!("measurement failed: {:?}", result.outcome());
        };
        assert_eq!(output["sequence"], index + 1);
    }
}

fn partial_startup_failure_shuts_down_started_worker() {
    let marker = env::temp_dir().join(format!(
        "orchestrator-tool-partial-startup-cleanup-{}",
        process::id()
    ));
    if let Err(error) = fs::remove_file(&marker) {
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
    }
    // SAFETY: this harness runs scenarios sequentially, and fixture children
    // inherit the variable before it is removed after lifecycle cleanup.
    unsafe { env::set_var(CLEANUP_MARKER_ENV, &marker) };

    let workflow = Workflow::new(vec![
        Step::new(
            StepId::new("power-set-1").unwrap(),
            StepKind::ToolAction {
                tool: ToolId::powers(),
                action: ActionId::new("set-voltage").unwrap(),
                arguments: json!({ "channel": 1, "voltage": 5.0 }),
                bindings: Default::default(),
            },
        ),
        Step::new(
            StepId::new("meter-read-1").unwrap(),
            StepKind::ToolAction {
                tool: ToolId::meters(),
                action: ActionId::new("measure").unwrap(),
                arguments: json!({}),
                bindings: Default::default(),
            },
        ),
    ])
    .unwrap();
    let launch_specs = HashMap::from([
        (ToolId::powers(), fixture_spec("partial-startup-cleanup")),
        (ToolId::meters(), fixture_spec("exit-before-ready")),
    ]);

    let result = run_simulated_workflow(
        &workflow,
        &launch_specs,
        Duration::from_secs(5),
        Duration::from_secs(5),
        Duration::from_secs(5),
    );
    // SAFETY: all fixture children have exited before the lifecycle call returns.
    unsafe { env::remove_var(CLEANUP_MARKER_ENV) };
    let marker_contents = fs::read_to_string(&marker).unwrap();
    fs::remove_file(&marker).unwrap();

    assert!(matches!(
        result,
        Err(WorkflowRunError::WorkerStartup {
            tool,
            source: WorkerStartError::ExitedBeforeReady(status),
        }) if tool == ToolId::meters() && status.success()
    ));
    assert_eq!(marker_contents, "stopped");
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

fn record_live_event(event: &str) {
    let marker = env::var_os(CLEANUP_MARKER_ENV).expect("cleanup marker required");
    let mut file = fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(marker)
        .unwrap();
    writeln!(file, "{event}").unwrap();
}

fn live_workflow_cleanup_lifecycle() {
    for scenario in [
        "live-success",
        "live-step-failure",
        "live-cleanup-failure",
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
                    tool: ToolId::powers(),
                    action: ActionId::new("set-voltage").unwrap(),
                    arguments: json!({ "channel": 1, "voltage": 5.0 }),
                    bindings: Default::default(),
                },
            ),
            Step::new(
                StepId::new("on-1").unwrap(),
                StepKind::ToolAction {
                    tool: ToolId::powers(),
                    action: ActionId::new("output-on").unwrap(),
                    arguments: json!({ "channel": 1 }),
                    bindings: Default::default(),
                },
            ),
            Step::new(
                StepId::new("off-1").unwrap(),
                StepKind::ToolAction {
                    tool: ToolId::powers(),
                    action: ActionId::new("output-off").unwrap(),
                    arguments: json!({ "channel": 1 }),
                    bindings: Default::default(),
                },
            ),
        ];
        let mut specs = HashMap::from([(ToolId::powers(), fixture_spec(scenario))]);
        if scenario == "live-startup-failure" {
            steps.push(Step::new(
                StepId::new("measure-1").unwrap(),
                StepKind::ToolAction {
                    tool: ToolId::meters(),
                    action: ActionId::new("measure").unwrap(),
                    arguments: json!({}),
                    bindings: Default::default(),
                },
            ));
            specs.insert(ToolId::meters(), fixture_spec("exit-before-ready"));
        }
        let workflow = Workflow::new(steps).unwrap();
        let result = run_workflow(
            &workflow,
            ExecutionMode::Live,
            &specs,
            Duration::from_secs(5),
            Duration::from_secs(5),
            Duration::from_secs(5),
        );
        // SAFETY: lifecycle has reaped all child sessions.
        unsafe { env::remove_var(CLEANUP_MARKER_ENV) };
        let events = fs::read_to_string(&marker).unwrap();
        fs::remove_file(&marker).unwrap();
        match scenario {
            "live-success" => {
                let results = result.unwrap();
                assert_eq!(results.len(), 3);
                assert!(
                    results
                        .iter()
                        .all(|r| matches!(r.outcome(), StepOutcome::Succeeded { .. }))
                );
                assert_eq!(events, "set\noutput-on\noutput-off\nsafe-off\nstop\n");
            }
            "live-step-failure" => {
                let results = result.unwrap();
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
                assert!(
                    message.contains("Power safety cleanup failed")
                        && message.contains("fixture cleanup failure"),
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
}
