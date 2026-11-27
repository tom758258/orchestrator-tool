use std::{
    collections::HashMap,
    env,
    ffi::{OsStr, OsString},
    fs,
    io::{self, BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    path::Path,
    process,
    sync::{Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};

use orchestrator_tool::{
    adapters::{
        meters::{
            run_action as run_meters_action, run_action_with_setup as run_meters_action_with_setup,
            run_worker_smoke as run_meters_worker_smoke,
        },
        powers::{
            PowersSafeOffResult, PowersSmokeError, clear_protection,
            normalized_protection_status_all, run_action as run_powers_action,
            run_worker_smoke as run_powers_worker_smoke, safe_off_all,
        },
    },
    manifest::{ToolManifest, parse_manifest},
    meters_setup::{AutoZero, MetersMeasurement, MetersSetup, MetersTriggerMode, RangeMode},
    run::{
        ExecutionMode, WorkflowRunError, run_simulated_workflow, run_workflow,
        run_workflow_with_events,
    },
    template::Template,
    tool::ToolId,
    tool_instance::{ToolInstance, ToolInstanceId, ToolSetup},
    worker::{WorkerLaunchSpec, WorkerShutdownError, WorkerStartError, start_worker},
    worker_http::{WorkerClient, WorkerHttpError},
    workflow::{
        ActionId, Expression, ExpressionOperand, ExpressionOperator, InputValue, NumericRange,
        Step, StepId, StepKind, StepOutcome, StepOutputReference, VariableId, Workflow,
        WorkflowRunEvent,
    },
    workflow_csv::serialize_result_rows_csv,
};
use serde_json::json;

const FIXTURE_UTC: &str = "2026-10-23T10:00:00Z";

#[path = "support/background.rs"]
mod background_tests;
#[path = "support/interaction.rs"]
mod interaction_tests;
#[path = "support/meters.rs"]
mod meters_tests;
#[path = "support/powers.rs"]
mod powers_tests;
#[path = "support/scopes.rs"]
mod scopes_tests;
#[path = "support/serial_rx.rs"]
mod serial_rx_tests;
#[path = "support/serial_tx.rs"]
mod serial_tx_tests;
#[path = "support/worker_fixture.rs"]
mod worker_fixture;
#[path = "support/worker_protocol.rs"]
mod worker_protocol;

use background_tests::*;
use meters_tests::*;
use powers_tests::*;
use scopes_tests::*;
use serial_rx_tests::*;
use worker_fixture::*;
use worker_protocol::*;

const FIXTURE_ARGUMENT: &str = "--worker-fixture";
const POWERS_WORKER_ARGUMENTS: [&str; 9] = [
    "worker",
    "--mode",
    "simulate",
    "--resource",
    "USB0::SIM::E36312A::INSTR",
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
    if arguments
        .first()
        .is_some_and(|arg| arg == "--serial-tx-fixture")
    {
        serial_tx_tests::fixture(arguments[1].to_str().unwrap());
        return;
    }
    if arguments
        .first()
        .is_some_and(|arg| arg == "--serial-tx-tests")
    {
        serial_tx_tests::contract(false);
        return;
    }
    if arguments
        .first()
        .is_some_and(|arg| arg == "--serial-real-tx-tests")
    {
        serial_tx_tests::contract(true);
        return;
    }
    if arguments
        .first()
        .is_some_and(|arg| arg == "--interaction-fixture")
    {
        interaction_tests::fixture(arguments[1].to_str().unwrap());
        return;
    }
    if arguments
        .first()
        .is_some_and(|arg| arg == "--interaction-tests")
    {
        interaction_tests::contract(false);
        serial_background_rx_contract();
        serial_buffer_contract();
        return;
    }
    if arguments
        .first()
        .is_some_and(|arg| arg == "--meters-real-interaction-tests")
    {
        interaction_tests::contract(true);
        return;
    }
    if arguments
        .first()
        .is_some_and(|arg| arg == "--background-fixture")
    {
        background_fixture(arguments[1].to_str().unwrap());
        return;
    }
    if arguments
        .first()
        .is_some_and(|arg| arg == "--background-tests")
    {
        software_background_timer_contract();
        background_capture_and_termination_contract();
        background_workflow_stop_contract();
        live_workflow_cleanup_lifecycle();
        multiple_powers_cleanup_attempts_every_session();
        return;
    }
    if arguments
        .first()
        .is_some_and(|arg| arg == "--meters-real-background-tests")
    {
        real_meters_background_and_unlimited_simulation();
        return;
    }

    // Diagnostic Smoke probes the very same fake executable before starting it.
    if arguments == [OsString::from("manifest"), OsString::from("--json")] {
        let scenario = if env::var_os(POWERS_FIXTURE_SCENARIO_ENV).is_some() {
            "powers-smoke"
        } else {
            "meters-smoke"
        };
        println!("{}", fixture_manifest_json(scenario));
        return;
    }

    if arguments == POWERS_WORKER_ARGUMENTS.map(OsString::from) {
        run_powers_worker_fixture();
        fixture_summary();
        return;
    }
    if arguments == METERS_WORKER_ARGUMENTS.map(OsString::from) {
        run_meters_worker_fixture();
        fixture_summary();
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
        fixture_summary();
        return;
    }

    if arguments
        .first()
        .is_some_and(|arg| arg == "--powers-real-sim-tests")
    {
        real_powers_simulated_workflow_uses_common_tracker();
        println!("Real Powers Worker v3 Workflow SIM completed");
        return;
    }

    if arguments.first().is_some_and(|arg| arg == "--scopes-tests") {
        scopes_worker_protocol_cases();
        scopes_single_wait_timeout_branches_and_instrument_error_fails();
        scopes_measure_invalid_branches_only_when_confirmed();
        scopes_setup_failure_stops_workflow();
        scopes_workflow_setting_readback_controls_step_outcome();
        powers_and_meters_workflow_executes_end_to_end();
        powers_protection_setup_lifecycle();
        partial_startup_failure_shuts_down_started_worker();
        invalid_ready_protocol_is_rejected();
        non_2xx_http_response_is_rejected();
        println!(
            "Scopes protocol/setup and directly affected regression checks passed (10 groups)"
        );
        return;
    }

    if arguments
        .first()
        .is_some_and(|arg| arg == "--powers-cleanup-tests")
    {
        live_workflow_cleanup_lifecycle();
        powers_protection_setup_lifecycle();
        manual_powers_clear_safe_offs_clears_rereads_and_shuts_down();
        manual_powers_clear_stops_after_safe_off_failure();
        manual_powers_clear_returns_unresolved_trip_without_retry();
        simulated_manual_powers_clear_returns_plan_without_reread();
        println!("Powers cleanup and directly affected checks passed");
        return;
    }

    if arguments
        .first()
        .is_some_and(|arg| arg == "--live-preflight-tests")
    {
        powers_set_output_binding_reaches_worker();
        scopes_worker_protocol_cases();
        live_workflow_cleanup_lifecycle();
        powers_protection_setup_lifecycle();
        live_preflight_dynamic_worker_failure_retains_powers_cleanup();
        println!("Live Preflight directly affected runtime regression checks passed (5 groups)");
        return;
    }

    valid_ready_starts_worker_session();
    interaction_tests::contract(false);
    serial_background_rx_contract();
    serial_buffer_contract();
    serial_tx_tests::contract(false);
    software_background_timer_contract();
    background_capture_and_termination_contract();
    background_workflow_stop_contract();
    invalid_ready_protocol_is_rejected();
    worker_exit_before_ready_returns_early();
    worker_exit_before_ready_surfaces_stderr_diagnostic();
    worker_exit_before_ready_prefers_structured_stdout_diagnostic();
    startup_timeout_terminates_worker();
    common_worker_http_round_trip();
    non_2xx_http_response_is_rejected();
    graceful_shutdown_reaps_worker();
    shutdown_timeout_forces_cleanup();
    runtime_events_are_available_after_ready();
    runtime_event_receive_times_out_when_no_event();
    powers_worker_smoke_correlates_terminal_job();
    common_v3_accepts_additional_tool_without_parser_branch();
    serial_dynamic_integer_workflow_reaches_worker_without_invalid_tx();
    opted_in_stream_readiness_preserves_samples_and_rejects_failure();
    async_job_without_terminal_is_unconfirmed();
    powers_operation_failure_preserves_nonzero_worker_exit();
    powers_terminal_failure_preserves_diagnostic_detail();
    meters_worker_smoke_captures_sample_and_shuts_down();
    powers_runtime_action_succeeds();
    powers_set_output_step_outputs_reach_result_row();
    powers_measure_voltage_and_current_reach_result_row();
    powers_set_output_binding_reaches_worker();
    powers_protection_status_asserts_untripped_result();
    manual_powers_status_reads_and_shuts_down();
    manual_powers_clear_safe_offs_clears_rereads_and_shuts_down();
    manual_powers_clear_stops_after_safe_off_failure();
    manual_powers_clear_returns_unresolved_trip_without_retry();
    simulated_manual_powers_status_uses_simulation_context();
    simulated_manual_powers_clear_returns_plan_without_reread();
    meters_runtime_measure_returns_sample();
    meters_runtime_rejects_non_single_modes();
    meters_single_auto_exit_completes_workflow();
    meters_single_shutdown_waits_for_exit_after_stop_failure();
    meters_single_outputs_preserve_staging();
    scopes_worker_protocol_cases();
    scopes_single_wait_timeout_branches_and_instrument_error_fails();
    scopes_measure_invalid_branches_only_when_confirmed();
    scopes_setup_failure_stops_workflow();
    scopes_workflow_setting_readback_controls_step_outcome();
    powers_and_meters_workflow_executes_end_to_end();
    simulated_measurement_dataflow_exports_csv();
    three_meter_measurements_shutdown_normally();
    partial_startup_failure_shuts_down_started_worker();
    live_workflow_cleanup_lifecycle();
    powers_protection_setup_lifecycle();
    multiple_powers_cleanup_attempts_every_session();
    two_meters_use_distinct_sessions();
    live_preflight_dynamic_worker_failure_retains_powers_cleanup();
}

fn run_fixture(scenario: &OsStr) {
    if let Some(name) = scenario.to_str().filter(|name| name.starts_with("scopes-")) {
        run_scopes_fixture(name);
        return;
    }
    if let Some(name) = scenario
        .to_str()
        .filter(|name| name.starts_with("meters-stream-"))
    {
        run_stream_readiness_fixture(name);
        return;
    }
    if let Some(name) = scenario
        .to_str()
        .filter(|name| name.starts_with("job-unconfirmed-"))
    {
        run_job_unconfirmed_fixture(name);
        return;
    }
    match scenario.to_str().expect("fixture scenario must be UTF-8") {
        "valid-ready" => {
            print_json_line("");
            print_json_line(r#"{"event":"boot","message":"starting"}"#);
            print_json_line(
                r#"{"event":"ready","schema_version":3,"run_id":"run-123","status_url":"http://127.0.0.1/status","command_url":"http://127.0.0.1/command","stop_url":"http://127.0.0.1/stop","future_optional_field":true}"#,
            );
            thread::sleep(Duration::from_secs(30));
        }
        "malformed-json" => print_json_line("{ not json }"),
        "unsupported-schema" => print_json_line(
            r#"{"event":"ready","schema_version":3,"run_id":"run-123","status_url":"status","command_url":"command","stop_url":"stop"}"#,
        ),
        "exit-before-ready" => {}
        "exit-before-ready-with-stderr" => {
            eprint!(" \nfixture startup validation failed\n \n");
            io::stderr().flush().unwrap();
            process::exit(2);
        }
        "exit-before-ready-with-stdout-error" => {
            print_json_line(
                r#"{"event":"error","schema_version":3,"exit_code":2,"message":"  fixture structured startup validation failed  "}"#,
            );
            io::stdout().flush().unwrap();
            eprint!("fixture stderr fallback");
            io::stderr().flush().unwrap();
            process::exit(2);
        }
        "no-ready" => thread::sleep(Duration::from_secs(30)),
        "ready-with-runtime-events" => {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let base_url = format!("http://{}", listener.local_addr().unwrap());
            print_json_line("");
            print_json_line(r#"{"event":"boot","message":"starting"}"#);
            print_json_line(
                &json!({
                    "event": "ready",
                    "schema_version": 3,
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
        "manual-status"
        | "manual-clear"
        | "manual-safe-off-failure"
        | "manual-clear-unresolved"
        | "manual-sim-status"
        | "manual-sim-clear" => run_manual_powers_fixture(scenario.to_str().unwrap()),
        "ready-no-events" => {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let base_url = format!("http://{}", listener.local_addr().unwrap());
            print_json_line(
                &json!({
                    "event": "ready",
                    "schema_version": 3,
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
                    "schema_version": 3,
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
                ("POST", "/command")
            );
            let body = serde_json::from_slice::<serde_json::Value>(&request.body).unwrap();
            assert_eq!(body["command"], "safe-off");
            assert_eq!(
                body["context"],
                json!({"mode":"simulate","planning_model_id":"keysight-e36312a"})
            );
            write_response(
                request.stream,
                202,
                r#"{"schema_version":3,"status":"accepted","command":"safe-off","worker_job_id":"partial-cleanup"}"#,
            );
            let request = accept_request(&listener);
            assert_eq!(
                (request.method.as_str(), request.path.as_str()),
                ("GET", "/status")
            );
            write_response(
                request.stream,
                200,
                r#"{"schema_version":3,"service":"powers-tool","run_id":"partial-startup-cleanup-run","status":"ready","fatal_error":null,"last_job":{"worker_job_id":"partial-cleanup","status":"succeeded","result":{"ok":true}}}"#,
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
        "conformance-extra-tool" => run_extra_v3_tool_fixture(),
        "serial-integer" => run_serial_integer_fixture(),
        "powers-runtime-success" => run_powers_runtime_fixture(),
        "powers-workflow-runtime" => run_powers_workflow_fixture("simulate"),
        "powers-workflow-set-output" => run_powers_workflow_fixture("simulate-set-output"),
        "powers-workflow-measure" => run_powers_workflow_fixture("simulate-measure"),
        "powers-workflow-protection-status" => {
            run_powers_workflow_fixture("simulate-protection-status")
        }
        "simulate-step-failure"
        | "simulate-protection-success"
        | "simulate-protection-trip"
        | "simulate-protection-set-failure"
        | "live-success"
        | "live-stop-success"
        | "live-stop-step-failure"
        | "live-stop-cleanup-failure"
        | "live-stop-startup"
        | "live-assert-failure"
        | "live-step-failure"
        | "live-cleanup-failure"
        | "live-queue-failure"
        | "live-readback-failure"
        | "live-legacy-safe-off"
        | "live-simulated-safe-off"
        | "live-safe-off-without-execution"
        | "live-both-failed"
        | "live-startup-failure"
        | "live-protection-success"
        | "live-protection-trip"
        | "live-protection-set-failure"
        | "live-protection-set-and-cleanup-failure"
        | "live-multi-cleanup-failure" => run_powers_workflow_fixture(scenario.to_str().unwrap()),
        "meters-runtime-measure" => run_meters_runtime_fixture(1, 2, json!(3.3)),
        "meters-runtime-single" => run_meters_single_runtime_fixture(None),
        "meters-runtime-single-auto-exit" => {
            run_meters_single_runtime_fixture(Some(Duration::ZERO))
        }
        "meters-runtime-single-delayed-auto-exit" => {
            run_meters_single_runtime_fixture(Some(Duration::from_millis(250)))
        }
        "meters-runtime-reject-non-single" => run_meters_reject_non_single_fixture(),

        "meters-csv-measure" => run_meters_runtime_fixture(1, 2, json!(5)),
        unknown => panic!("unknown Worker fixture scenario {unknown:?}"),
    }
}

fn live_preflight_dynamic_worker_failure_retains_powers_cleanup() {
    let template = Template::from_json_str(&json!({"name":"Dynamic Worker failure",
        "tool_instances":[{"id":"power","tool":"powers","setup":{}},{"id":"scope","tool":"scopes","setup":{}}],
        "workflow":{"interaction":{"enabled":false,"max_active_command_status":4096,"buffer":{"enabled":false,"mode":"fifo","overflow_policy":"fail-run"}},"steps":[
            {"type":"set-variable","id":"channel","variable":"channel","value":{"source":"literal","value":99}},
            {"type":"tool-action","id":"set","target":"power","action":"set-output","arguments":{"channel":1,"voltage":5.0}},
            {"type":"tool-action","id":"on","target":"power","action":"output-on","arguments":{"channel":1}},
            {"type":"tool-action","id":"measure","target":"scope","action":"measure","arguments":{"channel":1,"item":"vpp"},"bindings":{"channel":{"source":"variable","variable":"channel"}}},
            {"type":"tool-action","id":"later","target":"power","action":"output-off","arguments":{"channel":1}}
        ]}}).to_string()).unwrap();
    let marker = env::temp_dir().join(format!("orchestrator-preflight-dynamic-{}", process::id()));
    let _ = fs::remove_file(&marker);
    // SAFETY: fixture groups run sequentially and sessions finish before removal.
    unsafe { env::set_var(CLEANUP_MARKER_ENV, &marker) };
    let outcome = run_workflow(
        &template,
        ExecutionMode::Live,
        &HashMap::from([
            (
                ToolInstanceId::new("power").unwrap(),
                fixture_spec("live-assert-failure"),
            ),
            (
                ToolInstanceId::new("scope").unwrap(),
                WorkerLaunchSpec::new(
                    env::current_exe().unwrap(),
                    [
                        FIXTURE_ARGUMENT,
                        "scopes-dynamic-failed",
                        "--model",
                        "keysight-dsox4024a",
                        "--resource",
                        "USB::SCOPE",
                    ],
                )
                .with_manifest(fixture_manifest("scopes-dynamic-failed")),
            ),
        ]),
        Duration::from_secs(5),
        Duration::from_secs(5),
        Duration::from_secs(5),
    )
    .unwrap();
    unsafe { env::remove_var(CLEANUP_MARKER_ENV) };
    assert!(
        matches!(outcome.step_executions()[3].outcome(), StepOutcome::Failed { message } if message.contains("fixture failure"))
    );
    assert!(
        !outcome
            .step_executions()
            .iter()
            .any(|step| step.step_id().as_str() == "later")
    );
    assert_eq!(
        fs::read_to_string(&marker).unwrap(),
        "set\noutput-on\nsafe-off\nstop\n"
    );
    fs::remove_file(marker).unwrap();
}

fn powers_and_meters_workflow_executes_end_to_end() {
    let workflow = Workflow::new(vec![
        Step::new(
            StepId::new("power-set-1").unwrap(),
            StepKind::ToolAction {
                target: ToolInstanceId::new("powers-1").unwrap(),
                action: ActionId::new("set-output").unwrap(),
                arguments: json!({ "channel": 1, "voltage": 5.0 }),
                bindings: Default::default(),
            },
        ),
        Step::new(
            StepId::new("power-on-1").unwrap(),
            StepKind::ToolAction {
                target: ToolInstanceId::new("powers-1").unwrap(),
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
                target: ToolInstanceId::new("meters-1").unwrap(),
                action: ActionId::new("measure").unwrap(),
                arguments: json!({}),
                bindings: Default::default(),
            },
        ),
        Step::new(
            StepId::new("power-off-1").unwrap(),
            StepKind::ToolAction {
                target: ToolInstanceId::new("powers-1").unwrap(),
                action: ActionId::new("output-off").unwrap(),
                arguments: json!({ "channel": 1 }),
                bindings: Default::default(),
            },
        ),
    ])
    .unwrap();
    let launch_specs = HashMap::from([
        (
            ToolInstanceId::new("powers-1").unwrap(),
            fixture_spec("powers-workflow-runtime"),
        ),
        (
            ToolInstanceId::new("meters-1").unwrap(),
            fixture_spec("meters-runtime-measure"),
        ),
    ]);

    let run = run_simulated_workflow(
        &test_template(&workflow),
        &launch_specs,
        Duration::from_secs(5),
        Duration::from_secs(5),
        Duration::from_secs(5),
    )
    .unwrap();
    let results = run
        .step_executions()
        .iter()
        .map(|execution| execution.result().clone())
        .collect::<Vec<_>>();

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
            "tool_instances": [{"id": "meters-1", "tool": "meters", "setup": {
                "measurement": "voltage-dc", "range_mode": "auto", "manual_range": null,
                "nplc": 1.0, "auto_zero": "on", "dcv_input_impedance": null,
                "current_terminal": null
            }}, {"id": "powers-1", "tool": "powers", "setup": {}}],
            "name": "Measurement CSV",
            "workflow": {"interaction":{"enabled":false,"max_active_command_status":4096,"buffer":{"enabled":false,"mode":"fifo","overflow_policy":"fail-run"}}, "steps": [
                {
                    "type": "set-variable", "id": "set-threshold", "variable": "threshold",
                    "value": { "source": "literal", "value": 3 }
                },
                {
                    "type": "tool-action", "id": "meter-read-1", "target": "meters-1",
                    "action": "measure", "arguments": {}
                },
                {
                    "type": "output", "id": "output-voltage", "name": "voltage", "page": "Results",
                    "value": { "source": "step-output", "step_id": "meter-read-1", "pointer": "/value" }
                },
                {
                    "type": "output", "id": "output-passed", "name": "passed", "page": "Results",
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
    let run = run_simulated_workflow(
        &template,
        &HashMap::from([(
            ToolInstanceId::new("meters-1").unwrap(),
            fixture_spec("meters-csv-measure"),
        )]),
        Duration::from_secs(5),
        Duration::from_secs(5),
        Duration::from_secs(5),
    )
    .unwrap();
    let results = run
        .step_executions()
        .iter()
        .map(|execution| execution.result().clone())
        .collect::<Vec<_>>();

    assert_eq!(results.len(), 4);
    assert_eq!(results[1].step_id().as_str(), "meter-read-1");
    let StepOutcome::Succeeded { output } = results[1].outcome() else {
        panic!("measurement failed: {:?}", results[1].outcome());
    };
    assert_eq!(output["value"], 5);
    assert_eq!(
        serialize_result_rows_csv(run.result_rows()).unwrap(),
        "voltage,passed\n5,true\n"
    );

    let saved = template.to_json_string().unwrap();
    assert_eq!(saved, definition_before_run);
    let saved_wire: serde_json::Value = serde_json::from_str(&saved).unwrap();
    assert!(saved_wire.get("schema_version").is_none());
    assert_eq!(Template::from_json_str(&saved).unwrap(), template);
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
                target: ToolInstanceId::new("powers-1").unwrap(),
                action: ActionId::new("set-output").unwrap(),
                arguments: json!({ "channel": 1, "voltage": 5.0 }),
                bindings: Default::default(),
            },
        ),
        Step::new(
            StepId::new("meter-read-1").unwrap(),
            StepKind::ToolAction {
                target: ToolInstanceId::new("meters-1").unwrap(),
                action: ActionId::new("measure").unwrap(),
                arguments: json!({}),
                bindings: Default::default(),
            },
        ),
    ])
    .unwrap();
    let launch_specs = HashMap::from([
        (
            ToolInstanceId::new("powers-1").unwrap(),
            fixture_spec("partial-startup-cleanup"),
        ),
        (
            ToolInstanceId::new("meters-1").unwrap(),
            fixture_spec("exit-before-ready").with_manifest(fixture_manifest("meters-startup")),
        ),
    ]);

    let result = run_simulated_workflow(
        &test_template(&workflow),
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
            instance,
            source: WorkerStartError::ExitedBeforeReady { status, diagnostic },
        }) if instance == ToolInstanceId::new("meters-1").unwrap() && status.success() && diagnostic.is_none()
    ));
    assert_eq!(marker_contents, "stopped");
}

fn test_template(workflow: &Workflow) -> Template {
    Template::new(
        "Test".to_owned(),
        vec![
            ToolInstance {
                display_name: None,
                id: ToolInstanceId::new("powers-1").unwrap(),
                tool: orchestrator_tool::tool::ToolId::powers(),
                setup: ToolSetup::Powers(orchestrator_tool::powers_setup::PowersSetup::default()),
            },
            ToolInstance {
                display_name: None,
                id: ToolInstanceId::new("meters-1").unwrap(),
                tool: orchestrator_tool::tool::ToolId::meters(),
                setup: ToolSetup::Meters(MetersSetup {
                    measurement: MetersMeasurement::VoltageDc,
                    range_mode: RangeMode::Auto,
                    manual_range: None,
                    nplc: 1.0,
                    auto_zero: AutoZero::On,
                    dcv_input_impedance: None,
                    current_terminal: None,
                    ..MetersSetup::default()
                }),
            },
        ],
        workflow.clone(),
    )
    .unwrap()
}
