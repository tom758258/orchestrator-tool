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
            MetersActionError, run_action as run_meters_action,
            run_action_with_setup as run_meters_action_with_setup,
            run_worker_smoke as run_meters_worker_smoke,
        },
        powers::{
            PowersSmokeError, clear_protection, normalized_protection_status_all,
            run_action as run_powers_action, run_worker_smoke as run_powers_worker_smoke,
            safe_off_all,
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

#[derive(Default)]
struct FixtureV3 {
    run_id: String,
    features: serde_json::Value,
    urls: serde_json::Value,
    current_path: String,
    current_body: serde_json::Value,
    jobs: HashMap<String, (String, String)>,
    ready_seen: bool,
    summary_seen: bool,
}

fn fixture_context() -> &'static Mutex<FixtureV3> {
    static STATE: OnceLock<Mutex<FixtureV3>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(FixtureV3::default()))
}

fn fake_error(value: serde_json::Value) -> serde_json::Value {
    if value.is_null() {
        return value;
    }
    if value.get("category").is_some() && value.get("details").is_some() {
        return value;
    }
    json!({"category":"execution",
        "code":value["code"].as_str().unwrap_or("fixture_failed"),
        "message":value["message"].as_str().unwrap_or("fixture failure"),
        "details":{}})
}

fn fixture_event_json(line: &str) -> String {
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(line) else {
        return line.to_owned();
    };
    if !value.is_object()
        || (value["event"] == "ready"
            && value["timestamp_utc"].is_string()
            && value["features"].is_object())
    {
        return line.to_owned();
    }
    let mut state = fixture_context().lock().unwrap();
    if value["event"] == "ready" {
        state.ready_seen = true;
        state.run_id = value["run_id"].as_str().unwrap_or("fixture-run").to_owned();
        state.urls = json!({"status_url":value["status_url"],
            "command_url":value["command_url"],"stop_url":value["stop_url"]});
        state.features = if state.run_id.contains("meter") || state.run_id == "run-123" {
            json!({})
        } else {
            json!({"common.async_jobs":{"contract_version":1}})
        };
        value["features"] = state.features.clone();
    }
    if value["event"] == "status" {
        let state_str = value
            .get("worker_state")
            .and_then(serde_json::Value::as_str)
            .or_else(|| value.get("status").and_then(serde_json::Value::as_str))
            .unwrap_or("running");
        value["worker_state"] = json!(if state_str == "error" {
            "failed"
        } else if matches!(state_str, "starting" | "running" | "stopping") {
            state_str
        } else {
            "running"
        });
        if value.get("fatal_error").is_none() {
            value["fatal_error"] = json!(null);
        }
        if state.features.get("common.async_jobs").is_some() {
            if value.get("active_job").is_none() {
                value["active_job"] = json!(null);
            }
            if value.get("last_job").is_none() {
                value["last_job"] = json!(null);
            }
        }
    }
    if value["event"] == "summary" {
        state.summary_seen = true;
    }
    value["schema_version"] = json!(3);
    value["timestamp_utc"] = json!(FIXTURE_UTC);
    if value.get("run_id").is_none() && state.ready_seen {
        value["run_id"] = json!(state.run_id);
    }
    if value["event"] == "summary" {
        value["ok"] = value.get("ok").cloned().unwrap_or(json!(true));
        value["fatal_error"] = value.get("fatal_error").cloned().unwrap_or(json!(null));
        value["exit_code"] = value.get("exit_code").cloned().unwrap_or(json!(0));
    }
    if value["event"] == "error" {
        if value.get("scope").is_none() {
            value["scope"] = json!("worker");
        }
        if value.get("fatal").is_none() {
            value["fatal"] = json!(true);
        }
        let detail = value
            .get("error")
            .cloned()
            .unwrap_or_else(|| json!({"code":"startup_error","message":value["message"]}));
        value["error"] = fake_error(detail);
    }
    if value["event"] == "job_finished" {
        let worker_id = value["worker_job_id"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        if value.get("job_id").is_none() {
            if let Some((client, _)) = state.jobs.get(&worker_id) {
                value["job_id"] = json!(client);
            } else {
                value["job_id"] = json!(null);
            }
        }
        if value.get("command").is_none()
            && let Some((_, command)) = state.jobs.get(&worker_id)
        {
            value["command"] = json!(command);
        }
        if value.get("result").is_none() {
            value["result"] = json!(null);
        }
        let error = value.get("error").cloned().unwrap_or(json!(null));
        value["error"] = fake_error(error);
    }
    value.to_string()
}

fn fixture_summary() {
    let should_emit = {
        let state = fixture_context().lock().unwrap();
        state.ready_seen && !state.summary_seen
    };
    if should_emit {
        print_json_line(r#"{"event":"summary","ok":true,"fatal_error":null,"exit_code":0}"#);
    }
}

fn fixture_status(value: &mut serde_json::Value, state: &FixtureV3) {
    value["schema_version"] = json!(3);
    value["timestamp_utc"] = json!(FIXTURE_UTC);
    value["run_id"] = json!(state.run_id);
    for key in ["status_url", "command_url", "stop_url"] {
        value[key] = state.urls[key].clone();
    }
    value["features"] = state.features.clone();
    let failed = value["status"] == "error" || value["worker_state"] == "failed";
    value["worker_state"] = json!(if failed { "failed" } else { "running" });
    if value.get("fatal_error").is_none() {
        value["fatal_error"] = json!(null);
    } else if !value["fatal_error"].is_null() {
        value["fatal_error"] = fake_error(value["fatal_error"].clone());
    }
    if value["fatal_error"].is_null() && failed {
        value["fatal_error"] = json!({"category":"worker",
            "code":"fixture_failure","message":"fixture failed","details":{}});
    }
    if state.features.get("common.async_jobs").is_some() {
        if value.get("active_job").is_none() {
            value["active_job"] = json!(null);
        }
        if value.get("last_job").is_none() {
            value["last_job"] = json!(null);
        }
        for name in ["active_job", "last_job"] {
            if value[name].is_null() {
                continue;
            }
            let job_id = value[name]["worker_job_id"]
                .as_str()
                .unwrap_or("unknown-job")
                .to_owned();
            let old = value[name]
                .get("status")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned);
            if let Some(old) = old {
                let mapped = if old == "accepted" { "queued" } else { &old };
                value[name]["state"] = json!(mapped);
            }
            let current_state = value[name]["state"]
                .as_str()
                .unwrap_or("running")
                .to_owned();
            value[name]["timestamp_utc"] = json!(FIXTURE_UTC);
            if let Some((client, command)) = state.jobs.get(&job_id) {
                value[name]["job_id"] = json!(client);
                value[name]["command"] = json!(command);
            } else {
                value[name]["job_id"] = json!(null);
                value[name]["command"] = json!("fixture-other-job");
            }
            if matches!(current_state.as_str(), "succeeded" | "failed" | "cancelled") {
                value[name]["ok"] = json!(current_state == "succeeded");
                if value[name].get("result").is_none() {
                    value[name]["result"] = json!(null);
                }
                value[name]["error"] = if current_state == "failed" {
                    fake_error(
                        value[name]
                            .get("error")
                            .cloned()
                            .unwrap_or(json!({"message":"fixture job failed"})),
                    )
                } else {
                    json!(null)
                };
            }
        }
    }
}

fn fixture_http_json(status_code: u16, body: &str) -> String {
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(body) else {
        if body.trim().is_empty() {
            return if status_code == 200 || status_code == 202 {
                let state = fixture_context().lock().unwrap();
                json!({"schema_version":3,"run_id":state.run_id,
                    "status":"accepted","error":null})
                .to_string()
            } else {
                body.to_owned()
            };
        }
        return body.to_owned();
    };
    let mut state = fixture_context().lock().unwrap();
    if !value.is_object() {
        return body.to_owned();
    }
    let current_path = state.current_path.clone();
    match current_path.as_str() {
        "/status" if status_code == 200 => fixture_status(&mut value, &state),
        "/stop" if status_code == 200 || status_code == 202 => {
            value = json!({"schema_version":3,"run_id":state.run_id,
                "status":"accepted","error":null});
        }
        "/command" if status_code == 202 && state.current_body.get("command").is_some() => {
            let request = state.current_body.clone();
            let command = request["command"]
                .as_str()
                .unwrap_or("fixture-command")
                .to_owned();
            let client = value
                .get("job_id")
                .and_then(serde_json::Value::as_str)
                .or_else(|| request["job_id"].as_str())
                .unwrap_or("fixture-client")
                .to_owned();
            let worker = value["worker_job_id"].as_str().unwrap_or("").to_owned();
            let kind = if command == "software_trigger" {
                "control"
            } else {
                "async_job"
            };
            if kind == "async_job" && !worker.is_empty() {
                state
                    .jobs
                    .insert(worker.clone(), (client.clone(), command.clone()));
            }
            value = json!({"schema_version":3,"run_id":state.run_id,
                "status":"accepted","error":null,"command":command,"job_id":client,
                "kind":kind,"worker_job_id":if kind == "control" {
                    json!(null)
                } else { json!(worker) }});
        }
        "/command" if matches!(status_code, 400 | 409 | 429 | 500) => {
            value["schema_version"] = json!(3);
            value["run_id"] = json!(state.run_id);
            value["command"] = state.current_body["command"].clone();
            value["job_id"] = state.current_body["job_id"].clone();
            value["kind"] = json!("async_job");
            value["worker_job_id"] = json!(null);
            value["error"] = json!({"category":"admission","code":"queue_full",
                "message":"queue_full","details":{}});
        }
        _ => {}
    }
    value.to_string()
}

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
        .is_some_and(|arg| arg == "--background-fixture")
    {
        background_fixture(arguments[1].to_str().unwrap());
        return;
    }
    if arguments
        .first()
        .is_some_and(|arg| arg == "--background-tests")
    {
        background_capture_and_termination_contract();
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
        scopes_setup_failure_stops_workflow();
        powers_and_meters_workflow_executes_end_to_end();
        powers_protection_setup_lifecycle();
        partial_startup_failure_shuts_down_started_worker();
        invalid_ready_protocol_is_rejected();
        non_2xx_http_response_is_rejected();
        println!("Scopes protocol/setup and directly affected regression checks passed (7 groups)");
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
    background_capture_and_termination_contract();
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
    opted_in_stream_readiness_preserves_samples_and_rejects_failure();
    async_job_without_terminal_is_unconfirmed();
    powers_operation_failure_preserves_nonzero_worker_exit();
    powers_terminal_failure_preserves_diagnostic_detail();
    meters_worker_smoke_captures_sample_and_shuts_down();
    powers_runtime_action_succeeds();
    powers_set_voltage_step_outputs_reach_result_row();
    powers_set_output_binding_reaches_worker();
    powers_protection_status_asserts_untripped_result();
    manual_powers_status_reads_and_shuts_down();
    manual_powers_clear_safe_offs_clears_rereads_and_shuts_down();
    manual_powers_clear_stops_after_safe_off_failure();
    manual_powers_clear_returns_unresolved_trip_without_retry();
    simulated_manual_powers_status_uses_simulation_context();
    simulated_manual_powers_clear_returns_plan_without_reread();
    meters_runtime_measure_returns_sample();
    meters_runtime_custom_measure_drains_the_complete_batch();
    meters_runtime_custom_measure_uses_sample_inactivity_timeout();
    meters_runtime_passive_custom_modes_preserve_batches();
    meters_runtime_passive_custom_waits_for_samples();
    meters_runtime_passive_custom_times_out_without_samples();
    meters_immediate_custom_auto_exit_completes_workflow();
    meters_custom_auto_exit_completes_workflow();
    meters_custom_shutdown_waits_for_exit_after_stop_failure();
    meters_custom_outputs_expand_rows_and_preserve_staging();
    scopes_worker_protocol_cases();
    scopes_setup_failure_stops_workflow();
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

fn background_fixture(scenario: &str) {
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
    let mut count = 0;
    loop {
        count += 1;
        emit(
            json!({"event":"sample","captured":count,"value":count as f64,"unit":"V","status":"ok"}),
        );
        if scenario != "rolling" && count == 6 {
            break;
        }
        if let Ok((mut stream, _)) = listener.accept() {
            let mut bytes = [0; 4096];
            let _ = stream.read(&mut bytes);
            let body = json!({"schema_version":3,"run_id":"background-run","status":"accepted","error":null}).to_string();
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
            // A final sample after Stop must still reach an active Capture.
            count += 1;
            emit(
                json!({"event":"sample","captured":count,"value":count as f64,"unit":"V","status":"ok"}),
            );
            break;
        }
        thread::sleep(Duration::from_millis(5));
    }
    if scenario != "missing-ended" {
        emit(
            json!({"event":"status","worker_state":"stopping","fatal_error":null,"stream":{"lifecycle":"run_bound","state":"ended"}}),
        );
    }
    if scenario != "missing-summary" {
        emit(
            json!({"event":"summary","ok":true,"exit_code":0,"fatal_error":null,"captured":if scenario == "bad-count" {count+1} else {count},
        "errors":0,"overflow_detected":null,"overflow_monitoring":"off","final_drain_complete":true,
        "data_integrity":match scenario {"missing-quality" => json!(null), "unknown-quality" => json!("unknown"), _ => json!("no_loss_detected")}}),
        );
    }
}

fn background_template(steps: serde_json::Value) -> Template {
    let setup = MetersSetup {
        trigger_mode: MetersTriggerMode::ImmediateCustom,
        ..MetersSetup::default()
    };
    Template::from_json_str(&json!({"schema_version":2,"name":"Background contract", "tool_instances":[
        {"id":"meters-bg","tool":"meters","setup":setup}],"backgrounds":[{"id":"background-1","tool_instance_id":"meters-bg","live_monitor":true,"trigger_count":6}],
        "workflow":{"steps":steps}}).to_string()).unwrap()
}

fn background_capture_and_termination_contract() {
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
        let mut configs = background_template(json!([])).backgrounds().to_vec();
        let mut second = configs[0].clone();
        second.id = "background-2".into();
        second.tool_instance_id = ToolInstanceId::new("meters-bg-2").unwrap();
        second.live_monitor = false;
        configs.push(second);
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
            &configs,
            &specs,
            store.clone(),
            failure.clone(),
            None,
            Duration::from_secs(2),
            Duration::from_secs(2),
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
            {"type":"tool-action","id":"set","target":"powers-1","action":"set-voltage","arguments":{"channel":1,"voltage":5.0}},
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
                    }
                }),
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

fn real_meters_background_and_unlimited_simulation() {
    use orchestrator_tool::{
        background::BackgroundStore,
        run::{RunOptions, run_workflow_streaming_controlled},
        run_preparation::prepare_worker_launch_specs_with_simulation,
    };
    use std::sync::Arc;
    let executable = std::path::PathBuf::from(
        env::var_os("ORCHESTRATOR_TEST_METERS_EXECUTABLE").expect("Supply real Meters CLI"),
    );
    let mut config = orchestrator_tool::config::Config::default();
    config.set_executable_path(&ToolId::meters(), &executable);
    for infinite in [false, true] {
        let mut wire: serde_json::Value = serde_json::from_str(&background_template(json!([
            {"type":"background","id":"on","background_id":"background-1","action":"worker-on","capture":true},
            {"type":"wait","id":"wait","duration_ms":100},
            {"type":"background","id":"off","background_id":"background-1","action":"worker-off","capture":true}
        ])).to_json_string().unwrap()).unwrap();
        if infinite {
            wire["backgrounds"][0]["trigger_count"] = json!(null);
            wire["tool_instances"][0]["setup"]["allow_buffer_overflow_risk"] = json!(true);
        }
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
                ..Default::default()
            },
            |_| {},
            |_| false,
        );
        assert!(
            result.as_ref().is_ok_and(|r| r.succeeded()),
            "infinite={infinite}: {result:?}"
        );
        let data = store.lock().unwrap();
        assert!(data.metadata()[0].row_count > 0);
        assert_eq!(data.metadata()[0].status, "completed");
        println!(
            "Real Meters Immediate Custom infinite={infinite}: {} samples, {}",
            data.metadata()[0].row_count,
            data.metadata()[0].quality
        );
    }
    // A source bound is a launch parameter: it never turns the While into a finite loop.
    let setup = MetersSetup::default();
    let template=Template::from_json_str(&json!({"schema_version":2,"name":"Unlimited SIM", "tool_instances":[{"id":"meters-1","tool":"meters","setup":setup}],
        "workflow":{"steps":[{"type":"while","id":"loop","left":{"source":"literal","value":true},"operator":"equal","right":{"source":"literal","value":true},"max_iterations":null,
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

fn real_powers_simulated_workflow_uses_common_tracker() {
    let executable = std::path::PathBuf::from(
        env::var_os("ORCHESTRATOR_TEST_POWERS_EXE")
            .expect("Real Powers SIM executable must be explicitly supplied"),
    );
    let instance = ToolInstanceId::new("powers-real").unwrap();
    let workflow = Workflow::new(vec![
        Step::new(
            StepId::new("set-voltage").unwrap(),
            StepKind::ToolAction {
                target: instance.clone(),
                action: ActionId::new("set-voltage").unwrap(),
                arguments: json!({"channel":1,"voltage":2.5}),
                bindings: Default::default(),
            },
        ),
        Step::new(
            StepId::new("output-off").unwrap(),
            StepKind::ToolAction {
                target: instance.clone(),
                action: ActionId::new("output-off").unwrap(),
                arguments: json!({"channel":1}),
                bindings: Default::default(),
            },
        ),
    ])
    .unwrap();
    let template = Template::new(
        "Powers Common v3 real SIM".to_owned(),
        vec![ToolInstance {
            display_name: None,
            id: instance.clone(),
            tool: ToolId::powers(),
            setup: ToolSetup::Powers(orchestrator_tool::powers_setup::PowersSetup::default()),
        }],
        workflow,
    )
    .unwrap();
    let launch_specs = HashMap::from([(
        instance,
        orchestrator_tool::adapters::powers::simulate_worker_launch_spec(executable),
    )]);
    let run = run_simulated_workflow(
        &template,
        &launch_specs,
        Duration::from_secs(10),
        Duration::from_secs(10),
        Duration::from_secs(10),
    )
    .unwrap();
    let executions = run.step_executions();
    assert_eq!(executions.len(), 2);
    assert!(
        executions
            .iter()
            .all(|step| matches!(step.outcome(), StepOutcome::Succeeded { .. }))
    );
}

fn run_powers_worker_fixture() {
    let scenario = env::var(POWERS_FIXTURE_SCENARIO_ENV).unwrap_or_else(|_| "success".to_owned());
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let run_id = "powers-smoke-run";
    print_json_line(
        &json!({
            "event": "ready",
            "schema_version": 3,
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
            "schema_version": 3,
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
            "schema_version": 3,
            "command": "read-status",
            "arguments": { "channel": "all" },
            "context": {
                "mode": "simulate",
                "planning_model_id": "keysight-e36312a"
            },
            "job_id": serde_json::from_slice::<serde_json::Value>(&request.body).unwrap()["job_id"]
        })
    );
    write_response(
        request.stream,
        202,
        r#"{"schema_version":3,"status":"accepted","command":"read-status","worker_job_id":"job-current"}"#,
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
                "schema_version": 3,
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

fn run_manual_powers_fixture(scenario: &str) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let run_id = "manual-powers";
    print_json_line(
        &json!({
            "event": "ready",
            "schema_version": 3,
            "run_id": run_id,
            "status_url": format!("{base_url}/status"),
            "command_url": format!("{base_url}/command"),
            "stop_url": format!("{base_url}/stop"),
        })
        .to_string(),
    );

    let unresolved = scenario == "manual-clear-unresolved";
    let simulated = scenario.starts_with("manual-sim-");
    let commands: Vec<(&str, serde_json::Value)> = match scenario {
        "manual-status" => vec![(
            "protection-status",
            json!({"channel":"all","confirm_output":true}),
        )],
        "manual-clear" | "manual-clear-unresolved" => vec![
            ("safe-off", json!({"channel":"all","confirm_output":true})),
            (
                "clear-protection",
                json!({"channel":2,"confirm_output":true}),
            ),
            (
                "protection-status",
                json!({"channel":"all","confirm_output":true}),
            ),
        ],
        "manual-safe-off-failure" => {
            vec![("safe-off", json!({"channel":"all","confirm_output":true}))]
        }
        "manual-sim-status" => vec![("protection-status", json!({"channel":"all"}))],
        "manual-sim-clear" => vec![
            ("safe-off", json!({"channel":"all"})),
            ("clear-protection", json!({"channel":2})),
        ],
        _ => panic!("unknown manual Powers fixture scenario"),
    };

    for (index, (command, arguments)) in commands.into_iter().enumerate() {
        let request = accept_request(&listener);
        assert_eq!(
            (request.method.as_str(), request.path.as_str()),
            ("POST", "/command")
        );
        let body = serde_json::from_slice::<serde_json::Value>(&request.body).unwrap();
        assert_eq!(body["schema_version"], 3);
        assert_eq!(body["command"], command);
        assert_eq!(body["arguments"], arguments);
        assert_eq!(
            body["context"],
            if simulated {
                json!({"mode":"simulate","planning_model_id":"keysight-e36312a"})
            } else {
                json!({"mode":"live"})
            }
        );
        let job_id = format!("manual-job-{index}");
        write_response(
            request.stream,
            202,
            &json!({
                "schema_version":3,
                "status":"accepted",
                "command":command,
                "worker_job_id":job_id
            })
            .to_string(),
        );

        let request = accept_request(&listener);
        assert_eq!(
            (request.method.as_str(), request.path.as_str()),
            ("GET", "/status")
        );
        let failed = scenario == "manual-safe-off-failure";
        let result = if command == "protection-status" {
            json!({"data":{
                "protection":{"over_voltage_tripped":unresolved,"over_current_tripped":false},
                "protection_by_channel":[
                    {"channel":1,"protection":{"over_voltage_tripped":false,"over_current_tripped":false}},
                    {"channel":2,"protection":{"over_voltage_tripped":unresolved,"over_current_tripped":false}}
                ],
                "outputs":[{"channel":1,"enabled":false},{"channel":2,"enabled":false}]
            }})
        } else if simulated && command == "clear-protection" {
            json!({
                "request":{"command":"clear-protection","arguments":{"channel":2}},
                "execution":{"hardware_touched":false},
                "data":{"plan":{"steps":["safe-off","clear-protection"],"channel":2}}
            })
        } else {
            json!({"ok":true})
        };
        write_response(
            request.stream,
            200,
            &json!({
                "schema_version":3,
                "service":"powers-tool",
                "run_id":run_id,
                "status":"ready",
                "fatal_error":null,
                "last_job": if failed {
                    json!({"worker_job_id":job_id,"status":"failed",
                        "error":{"code":"safe_off_failed","message":"simulated Safe-Off failure"}})
                } else {
                    json!({"worker_job_id":job_id,"status":"succeeded","result":result})
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
    write_response(request.stream, 200, r#"{"ok":true}"#);
}

fn run_meters_worker_fixture() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let run_id = "meters-smoke-run";
    print_json_line(
        &json!({
            "event": "ready",
            "schema_version": 3,
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
            "schema_version": 3,
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
            "schema_version": 3,
            "command": "software_trigger",
            "job_id": "orchestrator-meter-smoke"
        })
    );
    write_response(
        request.stream,
        202,
        r#"{"schema_version":3,"status":"accepted","command":"software_trigger","job_id":"orchestrator-meter-smoke"}"#,
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
            "schema_version": 3,
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
        "powers-runtime-success" => run_powers_runtime_fixture(),
        "powers-workflow-runtime" => run_powers_workflow_fixture("simulate"),
        "powers-workflow-set-output" => run_powers_workflow_fixture("simulate-set-output"),
        "powers-workflow-protection-status" => {
            run_powers_workflow_fixture("simulate-protection-status")
        }
        "simulate-step-failure"
        | "simulate-protection-success"
        | "simulate-protection-trip"
        | "simulate-protection-set-failure"
        | "live-success"
        | "live-assert-failure"
        | "live-step-failure"
        | "live-cleanup-failure"
        | "live-both-failed"
        | "live-startup-failure"
        | "live-protection-success"
        | "live-protection-trip"
        | "live-protection-set-failure"
        | "live-protection-set-and-cleanup-failure"
        | "live-multi-cleanup-failure" => run_powers_workflow_fixture(scenario.to_str().unwrap()),
        "meters-runtime-measure" => run_meters_runtime_fixture(1, 2, json!(3.3)),
        "meters-runtime-custom" => run_meters_custom_runtime_fixture(Duration::ZERO, None),
        "meters-runtime-custom-auto-exit" => {
            run_meters_custom_runtime_fixture(Duration::ZERO, Some(Duration::ZERO))
        }
        "meters-runtime-custom-delayed-auto-exit" => {
            run_meters_custom_runtime_fixture(Duration::ZERO, Some(Duration::from_millis(250)))
        }
        "meters-runtime-custom-slow" => {
            run_meters_custom_runtime_fixture(Duration::from_millis(400), None)
        }
        "meters-runtime-passive-custom-4" => {
            run_meters_passive_custom_runtime_fixture(Duration::ZERO, &[1.0, 2.0, 3.0, 4.0], false)
        }
        "meters-runtime-passive-custom-delayed-3" => run_meters_passive_custom_runtime_fixture(
            Duration::from_millis(200),
            &[0.101, 0.102, 0.103],
            false,
        ),
        "meters-runtime-passive-custom-empty" => {
            run_meters_passive_custom_runtime_fixture(Duration::ZERO, &[], false)
        }
        "meters-runtime-passive-custom-auto-exit-3" => {
            run_meters_passive_custom_runtime_fixture(Duration::ZERO, &[0.201, 0.202, 0.203], true)
        }
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

fn run_powers_runtime_fixture() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let run_id = "powers-runtime-run";
    print_json_line(
        &json!({
            "event": "ready",
            "schema_version": 3,
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
    assert_eq!(body["schema_version"], 3);
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
            r#"{{"schema_version":3,"status":"accepted","command":"{command}","worker_job_id":"job-runtime-001"}}"#
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
            "schema_version": 3,
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
            "schema_version": 3,
            "service": "powers-tool",
            "run_id": run_id,
            "status": "ready",
            "fatal_error": null,
            "active_job": null,
            "last_job": {
                "worker_job_id": "job-runtime-001",
                "status": "succeeded",
                "result": {
                    "request": {
                        "command": "set",
                        "arguments": { "channel": 1, "voltage": 5.0 }
                    }
                }
            }
        })
        .to_string(),
    );

    let mut request = accept_request(&listener);
    if request.path == "/command" {
        assert_eq!(request.method, "POST");
        let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
        assert_eq!(body["command"], "safe-off");
        assert_eq!(body["arguments"], json!({"channel":"all"}));
        assert_eq!(
            body["context"],
            json!({"mode":"simulate","planning_model_id":"keysight-e36312a"})
        );
        write_response(
            request.stream,
            202,
            r#"{"schema_version":3,"status":"accepted","command":"safe-off","worker_job_id":"job-cleanup"}"#,
        );
        request = accept_request(&listener);
        assert_eq!(request.method, "GET");
        assert_eq!(request.path, "/status");
        write_response(
            request.stream,
            200,
            &json!({
                "schema_version":3,"service":"powers-tool","run_id":run_id,
                "status":"ready","fatal_error":null,
                "last_job":{"worker_job_id":"job-cleanup","status":"succeeded","result":{"ok":true}}
            })
            .to_string(),
        );
        request = accept_request(&listener);
    }
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, "/stop");
    write_response(request.stream, 200, r#"{"ok":true}"#);
}

fn run_powers_workflow_fixture(scenario: &str) {
    let live = !scenario.starts_with("simulate");
    let protection_scenario = matches!(
        scenario,
        "simulate-protection-success"
            | "simulate-protection-trip"
            | "simulate-protection-set-failure"
            | "live-protection-success"
            | "live-protection-trip"
            | "live-protection-set-failure"
            | "live-protection-set-and-cleanup-failure"
    );
    let step_failed = matches!(
        scenario,
        "simulate-step-failure" | "live-step-failure" | "live-both-failed"
    );
    let cleanup_failed = matches!(
        scenario,
        "live-cleanup-failure"
            | "live-both-failed"
            | "live-multi-cleanup-failure"
            | "live-protection-set-and-cleanup-failure"
    );
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let run_id = "powers-workflow-runtime-run";
    print_json_line(
        &json!({
            "event": "ready",
            "schema_version": 3,
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
    if scenario == "simulate-set-output" {
        commands[0].1 = json!({ "channel": 1, "voltage": 5.0, "current": 0.2 });
    }
    if scenario == "simulate-protection-status" {
        commands = vec![(
            "protection-status",
            json!({ "channel": "all" }),
            "job-protection",
        )];
    }
    if step_failed || scenario == "live-assert-failure" {
        commands.truncate(2);
    }
    if matches!(
        scenario,
        "live-startup-failure" | "live-multi-cleanup-failure"
    ) {
        commands.clear();
    }
    if protection_scenario {
        let failed_before_workflow = !scenario.ends_with("protection-success");
        if failed_before_workflow {
            commands.clear();
        }
        let mut setup_commands = vec![
            ("safe-off", json!({"channel":"all"}), "job-pre-safe-off"),
            (
                "protection-status",
                json!({"channel":"all"}),
                "job-pre-status",
            ),
        ];
        if !scenario.ends_with("protection-trip") {
            setup_commands.push((
                "protection-set",
                json!({"channel":1,"ovp_voltage":5.5,"ocp":"on"}),
                "job-pre-set",
            ));
        }
        setup_commands.extend(commands);
        commands = setup_commands;
    }
    commands.push(("safe-off", json!({ "channel": "all" }), "job-cleanup"));
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
                "schema_version": 3,
                "command": command,
                "arguments": arguments,
                "context": context,
                "job_id": serde_json::from_slice::<serde_json::Value>(&request.body).unwrap()["job_id"].clone()
            })
        );
        record_event_if_requested(command);
        write_response(
            request.stream,
            202,
            &json!({
                "schema_version": 3,
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
                "schema_version": 3,
                "service": "powers-tool",
                "run_id": run_id,
                "status": "ready",
                "fatal_error": null,
                "active_job": null,
                "last_job": {
                    "worker_job_id": worker_job_id,
                    "status": if (step_failed && command == "output-on") || (cleanup_failed && worker_job_id == "job-cleanup")
                        || (matches!(scenario, "simulate-protection-set-failure" | "live-protection-set-failure" | "live-protection-set-and-cleanup-failure")
                            && command == "protection-set") { "failed" } else { "succeeded" },
                    "error": { "message": if command == "safe-off" { "fixture cleanup failure" } else { "fixture action failure" } },
                    "result": if command == "protection-status" {
                        json!({
                            "request": { "command": "protection-status" },
                            "data": { "protection": { "over_voltage_tripped": scenario.ends_with("protection-trip"), "over_current_tripped": false } },
                            "metadata": { "source": "fixture" }
                        })
                    } else { json!({ "ok": true }) }
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
    record_event_if_requested("stop");
    write_response(request.stream, 200, r#"{"ok":true}"#);
}

fn run_meters_runtime_fixture(measurements: usize, max_samples: usize, value: serde_json::Value) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let run_id = format!("meters-runtime-run-{}", process::id());
    print_json_line(
        &json!({
            "event": "ready",
            "schema_version": 3,
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
        assert_eq!(body["schema_version"], 3);
        assert_eq!(body["command"], "software_trigger");
        assert_eq!(body["arguments"], json!({}));
        assert!(
            body.get("context").is_none(),
            "meters runtime must not send context"
        );
        assert!(
            body["job_id"].as_str().is_some_and(|id| !id.is_empty()),
            "Common v3 requires unique non-empty client job_id"
        );
        assert!(
            body.get("metadata").is_none(),
            "meters runtime must not send metadata"
        );
        write_response(
            request.stream,
            202,
            r#"{"schema_version":3,"status":"accepted","command":"software_trigger","job_id":null}"#,
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
            fixture_summary();
            return;
        }
    }

    let request = accept_request(&listener);
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, "/stop");
    write_response(request.stream, 200, r#"{"ok":true}"#);
    fixture_summary();
}

fn run_meters_custom_runtime_fixture(sample_delay: Duration, exit_delay: Option<Duration>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let run_id = format!("meters-custom-runtime-run-{}", process::id());
    print_json_line(
        &json!({
            "event": "ready", "schema_version": 3, "run_id": run_id,
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
    write_response(
        request.stream,
        202,
        r#"{"schema_version":3,"status":"accepted","command":"software_trigger","job_id":null}"#,
    );
    if let Some(exit_delay) = exit_delay {
        // Make the samples visible only after the HTTP endpoint is closed.
        let stdout = io::stdout();
        let mut output = io::BufWriter::new(stdout.lock());
        for (sequence, value) in [0.055, 0.056, 0.057].into_iter().enumerate() {
            thread::sleep(sample_delay);
            writeln!(
                output,
                "{}",
                fixture_event_json(
                    &json!({
                        "event": "sample", "run_id": run_id, "value": value,
                        "sequence": sequence + 1, "unit": "V"
                    })
                    .to_string()
                )
            )
            .unwrap();
        }
        drop(listener);
        output.flush().unwrap();
        drop(output);
        thread::sleep(exit_delay);
    } else {
        for (sequence, value) in [0.055, 0.056, 0.057].into_iter().enumerate() {
            thread::sleep(sample_delay);
            print_json_line(
                &json!({
                    "event": "sample", "run_id": run_id, "value": value,
                    "sequence": sequence + 1, "unit": "V"
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
}

fn run_meters_passive_custom_runtime_fixture(
    initial_delay: Duration,
    values: &[f64],
    auto_exit: bool,
) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let run_id = format!("meters-passive-custom-run-{}", process::id());
    print_json_line(
        &json!({
            "event": "ready", "schema_version": 3, "run_id": run_id,
            "status_url": format!("{base_url}/status"),
            "command_url": format!("{base_url}/command"),
            "stop_url": format!("{base_url}/stop")
        })
        .to_string(),
    );

    thread::sleep(initial_delay);
    for (sequence, value) in values.iter().enumerate() {
        print_json_line(
            &json!({
                "event": "sample", "run_id": run_id, "value": value,
                "sequence": sequence + 1, "unit": "V"
            })
            .to_string(),
        );
    }

    if auto_exit {
        drop(listener);
        return;
    }

    let request = accept_request(&listener);
    assert_eq!(
        (request.method.as_str(), request.path.as_str()),
        ("POST", "/stop"),
        "passive Custom Measure must not send software_trigger"
    );
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

    {
        let mut state = fixture_context().lock().unwrap();
        state.current_path = path.clone();
        state.current_body = serde_json::from_slice(&body).unwrap_or(json!({}));
    }
    TestRequest {
        stream,
        method,
        path,
        content_type,
        body,
    }
}

fn write_response(mut stream: TcpStream, status: u16, body: &str) {
    let converted = fixture_http_json(status, body);
    let body = converted.as_str();
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        429 => "Too Many Requests",
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
    let converted = fixture_event_json(line);
    writeln!(stdout, "{converted}").unwrap();
    stdout.flush().unwrap();
}

fn fixture_manifest_json(scenario: &str) -> serde_json::Value {
    let name = if scenario.starts_with("meters-") {
        "meters"
    } else if scenario.starts_with("scopes-") {
        "scopes"
    } else if scenario == "conformance-extra-tool" {
        "auxiliary"
    } else {
        "powers"
    };
    let (model, binding, features) = match name {
        "meters" => (
            "run_bound",
            "startup",
            json!({"common.streaming":{"contract_version":1,"lifecycles":["run_bound"]}}),
        ),
        "scopes" | "auxiliary" => (
            "multi_job",
            "startup",
            json!({"common.async_jobs":{"contract_version":1}}),
        ),
        _ => (
            "multi_job",
            "per_command",
            json!({"common.async_jobs":{"contract_version":1}}),
        ),
    };
    json!({
        "event":"tool_manifest","schema_version":2,"tool_id":name,
        "tool_version":"fixture","worker_protocol":{
            "compatibility_policy":"v3-only","schema_versions":[3]},
        "execution":{"model":model,"context_binding":binding},
        "features":features
    })
}

fn fixture_manifest(scenario: &str) -> ToolManifest {
    let document = fixture_manifest_json(scenario);
    let expected = ToolId::new(document["tool_id"].as_str().unwrap()).unwrap();
    parse_manifest(&document.to_string(), &expected).unwrap()
}

fn fixture_spec(scenario: &str) -> WorkerLaunchSpec {
    WorkerLaunchSpec::new(
        env::current_exe().unwrap(),
        [OsString::from(FIXTURE_ARGUMENT), OsString::from(scenario)],
    )
    .with_manifest(fixture_manifest(scenario))
}

fn run_extra_v3_tool_fixture() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    print_json_line(
        &json!({"schema_version":3,"event":"ready",
        "timestamp_utc":FIXTURE_UTC,"run_id":"extra-tool-run",
        "features":{"common.async_jobs":{"contract_version":1}},
        "status_url":format!("{base}/status"),
        "command_url":format!("{base}/command"),
        "stop_url":format!("{base}/stop")})
        .to_string(),
    );
    // Explicitly new Tool identity, but no production Common parser changes.
    {
        let mut context = fixture_context().lock().unwrap();
        context.ready_seen = true;
        context.run_id = "extra-tool-run".into();
        context.urls = json!({"status_url":format!("{base}/status"),
            "command_url":format!("{base}/command"),
            "stop_url":format!("{base}/stop")});
        context.features = json!({"common.async_jobs":{"contract_version":1}});
    }
    let request = accept_request(&listener);
    assert_eq!(request.path, "/command");
    let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
    assert_eq!(body["command"], "do-work");
    write_response(
        request.stream,
        202,
        &json!({
            "schema_version":3,"run_id":"extra-tool-run",
            "status":"accepted","command":"do-work","kind":"async_job",
            "job_id":body["job_id"],"worker_job_id":"extra-w1","error":null
        })
        .to_string(),
    );
    print_json_line(
        &json!({"schema_version":3,"event":"job_finished",
            "run_id":"extra-tool-run","timestamp_utc":FIXTURE_UTC,
            "worker_job_id":"extra-w1","job_id":body["job_id"],"command":"do-work",
            "state":"succeeded","ok":true,"result":{"answer":42},"error":null
        })
        .to_string(),
    );
    // The orchestrator may poll read-only status before observing JSONL.
    // Both a complete terminal snapshot and the terminal event are valid.
    loop {
        let request = accept_request(&listener);
        match request.path.as_str() {
            "/status" => write_response(
                request.stream,
                200,
                &json!({
                    "schema_version":3,
                    "timestamp_utc":FIXTURE_UTC,
                    "run_id":"extra-tool-run",
                    "worker_state":"running",
                    "fatal_error":null,
                    "features":{"common.async_jobs":{"contract_version":1}},
                    "status_url":format!("{base}/status"),
                    "command_url":format!("{base}/command"),
                    "stop_url":format!("{base}/stop"),
                    "active_job":null,
                    "last_job":{
                        "timestamp_utc":FIXTURE_UTC,
                        "worker_job_id":"extra-w1",
                        "job_id":body["job_id"],
                        "command":"do-work",
                        "state":"succeeded",
                        "ok":true,
                        "result":{"answer":42},
                        "error":null
                    }
                })
                .to_string(),
            ),
            "/stop" => {
                write_response(request.stream, 200, r#"{"ok":true}"#);
                break;
            }
            other => panic!("unexpected additional v3 HTTP path: {other}"),
        }
    }
}

fn run_stream_readiness_fixture(scenario: &str) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let run_id = format!("{scenario}-run");
    let features = json!({"common.streaming":{"contract_version":1,"lifecycles":["run_bound"]}});
    {
        let mut state = fixture_context().lock().unwrap();
        state.ready_seen = true;
        state.run_id = run_id.clone();
        state.features = features.clone();
        state.urls = json!({"status_url":format!("{base}/status"),
            "command_url":format!("{base}/command"),
            "stop_url":format!("{base}/stop")});
    }
    print_json_line(
        &json!({"event":"ready","schema_version":3,"timestamp_utc":FIXTURE_UTC,
            "run_id":run_id,"features":features,
            "status_url":format!("{base}/status"),
            "command_url":format!("{base}/command"),
            "stop_url":format!("{base}/stop"),
            "stream":{"lifecycle":"run_bound"}})
        .to_string(),
    );
    let state = if scenario == "meters-stream-ended" {
        "ended"
    } else {
        "active"
    };
    print_json_line(
        &json!({"event":"status","run_id":run_id,
            "worker_state":"running","fatal_error":null,
            "stream":{"lifecycle":"run_bound","state":state}})
        .to_string(),
    );
    match scenario {
        "meters-stream-active" | "meters-stream-stale-status" => print_json_line(
            &json!({"event":"sample","run_id":run_id,"value":12.3,"unit":"V"}).to_string(),
        ),
        "meters-stream-fatal" => print_json_line(
            &json!({"event":"error","run_id":run_id,"scope":"worker","fatal":true,
                "error":{"category":"worker","code":"source_failed",
                    "message":"source failed","details":{}}})
            .to_string(),
        ),
        "meters-stream-ended" => {}
        _ => panic!("unknown stream fixture {scenario}"),
    }
    let http_state = if scenario == "meters-stream-stale-status" {
        "waiting"
    } else {
        "active"
    };
    loop {
        let request = accept_request(&listener);
        match request.path.as_str() {
            "/status" => write_response(
                request.stream,
                200,
                &json!({"worker_state":"running","fatal_error":null,
                    "stream":{"lifecycle":"run_bound","state":http_state}})
                .to_string(),
            ),
            "/stop" => {
                write_response(request.stream, 200, r#"{"ok":true}"#);
                break;
            }
            other => panic!("unexpected stream readiness request {other}"),
        }
    }
}

fn run_job_unconfirmed_fixture(scenario: &str) {
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

fn opted_in_stream_readiness_preserves_samples_and_rejects_failure() {
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

fn async_job_without_terminal_is_unconfirmed() {
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

fn run_scopes_fixture(scenario: &str) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let run_id = "scopes-fixture";
    print_json_line(
        &json!({"schema_version":3,"event":"ready","run_id":run_id,
        "status_url":format!("{base}/status"),"command_url":format!("{base}/command"),
        "stop_url":format!("{base}/stop")})
        .to_string(),
    );
    loop {
        let request = accept_request(&listener);
        match request.path.as_str() {
            "/status" => write_response(request.stream, 200, &json!({"schema_version":3,
                "service":"scopes-tool","run_id":run_id,"status":"ready","fatal_error":null,
                "mode":if scenario == "scopes-dynamic-failed" {"live"} else {"simulate"},
                "model":if scenario == "scopes-wrong-model" {"unknown"} else {"keysight-dsox4024a"},
                "resource":if scenario == "scopes-dynamic-failed" {json!("USB::SCOPE")} else {json!(null)}}).to_string()),
            "/command" => {
                let command: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
                assert_eq!(command["schema_version"], 3);
                assert!(command.get("context").is_none());
                if scenario == "scopes-dynamic-failed" {
                    assert_eq!(command["command"], "measure");
                    assert_eq!(command["arguments"]["channel"], 99);
                }
                if scenario == "scopes-setup-failed" {
                    assert_eq!(command["command"], "channel-invert");
                    assert_eq!(command["arguments"], json!({"channel":2,"on":true}));
                }
                if scenario == "scopes-rejected" {
                    write_response(request.stream, 429, &json!({"schema_version":3,"status":"rejected",
                        "command":command["command"],"job_id":command["job_id"],"reason":"queue_full"}).to_string());
                    continue;
                }
                write_response(request.stream, 202, &json!({"schema_version":3,"status":"accepted",
                    "command":command["command"],"job_id":if scenario == "scopes-admission-mismatch" {json!("other-job")} else {command["job_id"].clone()},"worker_job_id":"job-1"}).to_string());
                if scenario == "scopes-timeout" { continue; }
                thread::sleep(Duration::from_millis(50));
                let failed = matches!(scenario, "scopes-failed" | "scopes-setup-failed" | "scopes-dynamic-failed");
                let cancelled = scenario == "scopes-cancelled";
                print_json_line(&json!({"schema_version":3,"event":"job_finished","run_id":if scenario == "scopes-event-mismatch" {"other-run"} else {run_id},
                    "command":command["command"],"job_id":command["job_id"],
                    "worker_job_id":if scenario == "scopes-mismatch" {"wrong-job"} else {"job-1"},
                    "state":if cancelled {"cancelled"} else if failed {"failed"} else {"succeeded"},
                    "ok":!failed && !cancelled,"exit_code":if failed || cancelled {3} else {0},
                    "error":if failed || cancelled {json!({"message":"fixture failure"})} else {json!(null)},
                    "result":{"value":3.3,"unit":"V"},"files":[]}).to_string());
            }
            "/stop" => { write_response(request.stream, 200, r#"{"ok":true}"#); return; }
            other => panic!("unexpected Scopes request {other}"),
        }
    }
}

fn common_v3_accepts_additional_tool_without_parser_branch() {
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

fn scopes_worker_protocol_cases() {
    use orchestrator_tool::adapters::scopes;
    for scenario in [
        "scopes-success",
        "scopes-rejected",
        "scopes-failed",
        "scopes-cancelled",
        "scopes-mismatch",
        "scopes-timeout",
        "scopes-wrong-model",
        "scopes-admission-mismatch",
        "scopes-event-mismatch",
    ] {
        let spec = fixture_spec(scenario);
        let session = start_worker(&spec, Duration::from_secs(5)).unwrap();
        if scenario == "scopes-success" {
            assert!(
                scopes::validate_session(
                    &session,
                    ExecutionMode::Live,
                    &spec,
                    Duration::from_secs(2)
                )
                .unwrap_err()
                .contains("canonical model ID is missing")
            );
        }
        let identity = scopes::validate_session(
            &session,
            ExecutionMode::Simulate,
            &spec,
            Duration::from_secs(2),
        );
        if scenario == "scopes-wrong-model" {
            assert!(identity.is_err());
        } else {
            identity.unwrap();
            let started = Instant::now();
            let outcome = scopes::run_action(
                &session,
                &ActionId::new("measure").unwrap(),
                &json!({"channel":1,"item":"vpp"}),
                None,
                Duration::from_millis(300),
            );
            if scenario == "scopes-success" {
                assert_eq!(outcome.unwrap()["value"], 3.3);
                assert!(started.elapsed() >= Duration::from_millis(50));
            } else {
                let error = outcome.unwrap_err();
                if scenario == "scopes-rejected" {
                    assert!(error.contains("queue_full"), "{error}");
                }
            }
        }
        let shutdown = session.shutdown(Duration::from_secs(2));
        if scenario == "scopes-mismatch" {
            assert!(
                shutdown.is_err(),
                "conflicting Job identity must not pass Worker shutdown"
            );
        } else {
            assert!(shutdown.unwrap().success(), "scenario: {scenario}");
        }
    }
}

fn scopes_setup_failure_stops_workflow() {
    let template = Template::from_json_str(&json!({"schema_version":2,"name":"Setup failure",
        "tool_instances":[{"id":"scope","tool":"scopes","setup":{"channels":[{"channel":2,"invert":true}]}}],
        "workflow":{"steps":[{"type":"tool-action","id":"read","target":"scope","action":"measure",
            "arguments":{"channel":2,"item":"vpp"}}]}}).to_string()).unwrap();
    let error = run_simulated_workflow(
        &template,
        &HashMap::from([(
            ToolInstanceId::new("scope").unwrap(),
            fixture_spec("scopes-setup-failed"),
        )]),
        Duration::from_secs(5),
        Duration::from_secs(2),
        Duration::from_secs(2),
    )
    .unwrap_err()
    .to_string();
    assert!(error.contains("scope Scopes Setup failed"), "{error}");
    assert!(error.contains("channel 2"), "{error}");
}

fn live_preflight_dynamic_worker_failure_retains_powers_cleanup() {
    let template = Template::from_json_str(&json!({"schema_version":2,"name":"Dynamic Worker failure",
        "tool_instances":[{"id":"power","tool":"powers","setup":{}},{"id":"scope","tool":"scopes","setup":{}}],
        "workflow":{"steps":[
            {"type":"set-variable","id":"channel","variable":"channel","value":{"source":"literal","value":99}},
            {"type":"tool-action","id":"set","target":"power","action":"set-voltage","arguments":{"channel":1,"voltage":5.0}},
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

fn valid_ready_starts_worker_session() {
    let session = start_worker(&fixture_spec("valid-ready"), Duration::from_secs(5)).unwrap();

    assert_ne!(session.process_id(), 0);
    assert_eq!(session.ready().schema_version(), 3);
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
                    | ("unsupported-schema", WorkerStartError::InvalidContract(_))
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

fn worker_exit_before_ready_surfaces_stderr_diagnostic() {
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

fn worker_exit_before_ready_prefers_structured_stdout_diagnostic() {
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

    assert_eq!(client.status().unwrap()["worker_state"], "running");
    assert_eq!(
        client
            .command(&json!({"action": "measure", "value": 7}))
            .unwrap(),
        json!({"accepted": true})
    );
    assert_eq!(client.stop().unwrap().unwrap()["status"], "accepted");
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
    assert_eq!(
        result,
        json!({
            "request": {
                "command": "set",
                "arguments": { "channel": 1, "voltage": 5.0 }
            }
        })
    );
    assert!(session.shutdown(Duration::from_secs(5)).unwrap().success());
}

fn powers_set_voltage_step_outputs_reach_result_row() {
    let set_voltage_step_id = StepId::new("power-set-1").unwrap();
    let workflow = Workflow::new(vec![
        Step::new(
            set_voltage_step_id.clone(),
            StepKind::ToolAction {
                target: ToolInstanceId::new("powers-1").unwrap(),
                action: ActionId::new("set-voltage").unwrap(),
                arguments: json!({ "channel": 1, "voltage": 5.0 }),
                bindings: Default::default(),
            },
        ),
        Step::new(
            StepId::new("output-voltage").unwrap(),
            StepKind::Output {
                name: "voltage".to_owned(),
                value: InputValue::StepOutput(StepOutputReference::new(
                    set_voltage_step_id.clone(),
                    "/request/arguments/voltage",
                )),
            },
        ),
        Step::new(
            StepId::new("output-channel").unwrap(),
            StepKind::Output {
                name: "channel".to_owned(),
                value: InputValue::StepOutput(StepOutputReference::new(
                    set_voltage_step_id,
                    "/request/arguments/channel",
                )),
            },
        ),
    ])
    .unwrap();
    let run = run_simulated_workflow(
        &test_template(&workflow),
        &HashMap::from([(
            ToolInstanceId::new("powers-1").unwrap(),
            fixture_spec("powers-runtime-success"),
        )]),
        Duration::from_secs(5),
        Duration::from_secs(5),
        Duration::from_secs(5),
    )
    .unwrap();

    assert_eq!(run.result_rows().len(), 1);
    assert_eq!(
        run.result_rows()[0]
            .outputs()
            .iter()
            .map(|output| (output.name(), output.value()))
            .collect::<Vec<_>>(),
        [("voltage", &json!(5.0)), ("channel", &json!(1))]
    );
}

fn powers_set_output_binding_reaches_worker() {
    let template = Template::from_json_str(
        &json!({
            "schema_version": 2,
            "name": "Power set output",
            "tool_instances": [{ "id": "powers-1", "tool": "powers", "setup": {} }],
            "workflow": { "steps": [
                { "type": "set-variable", "id": "set-limit", "variable": "limit",
                  "value": { "source": "literal", "value": 0.2 } },
                { "type": "tool-action", "id": "power-set", "target": "powers-1",
                  "action": "set-output", "arguments": { "channel": 1, "voltage": 5.0 },
                  "bindings": { "current": { "source": "variable", "variable": "limit" } } },
                { "type": "tool-action", "id": "power-on", "target": "powers-1",
                  "action": "output-on", "arguments": { "channel": 1 } },
                { "type": "tool-action", "id": "power-off", "target": "powers-1",
                  "action": "output-off", "arguments": { "channel": 1 } }
            ] }
        })
        .to_string(),
    )
    .unwrap();
    let saved = template.to_json_string().unwrap();
    assert_eq!(Template::from_json_str(&saved).unwrap(), template);
    let run = run_simulated_workflow(
        &template,
        &HashMap::from([(
            ToolInstanceId::new("powers-1").unwrap(),
            fixture_spec("powers-workflow-set-output"),
        )]),
        Duration::from_secs(5),
        Duration::from_secs(5),
        Duration::from_secs(5),
    )
    .unwrap();
    assert!(
        run.step_executions()
            .iter()
            .all(|execution| matches!(execution.result().outcome(), StepOutcome::Succeeded { .. }))
    );
}

fn manual_powers_status_reads_and_shuts_down() {
    let session = start_worker(&fixture_spec("manual-status"), Duration::from_secs(2)).unwrap();
    let status =
        normalized_protection_status_all(&session, ExecutionMode::Live, Duration::from_secs(2))
            .unwrap();
    assert!(!status.protection_tripped);
    assert_eq!(status.channels.len(), 2);
    assert!(session.shutdown(Duration::from_secs(2)).unwrap().success());
}

fn manual_powers_clear_safe_offs_clears_rereads_and_shuts_down() {
    let session = start_worker(&fixture_spec("manual-clear"), Duration::from_secs(2)).unwrap();
    safe_off_all(&session, ExecutionMode::Live, Duration::from_secs(2)).unwrap();
    clear_protection(&session, 2, ExecutionMode::Live, Duration::from_secs(2)).unwrap();
    let status =
        normalized_protection_status_all(&session, ExecutionMode::Live, Duration::from_secs(2))
            .unwrap();
    assert!(!status.protection_tripped);
    assert!(
        status
            .channels
            .iter()
            .all(|channel| !channel.output_enabled)
    );
    assert!(session.shutdown(Duration::from_secs(2)).unwrap().success());
}

fn manual_powers_clear_stops_after_safe_off_failure() {
    let session = start_worker(
        &fixture_spec("manual-safe-off-failure"),
        Duration::from_secs(2),
    )
    .unwrap();
    let error = safe_off_all(&session, ExecutionMode::Live, Duration::from_secs(2)).unwrap_err();
    assert!(error.to_string().contains("simulated Safe-Off failure"));
    assert!(session.shutdown(Duration::from_secs(2)).unwrap().success());
}

fn manual_powers_clear_returns_unresolved_trip_without_retry() {
    let session = start_worker(
        &fixture_spec("manual-clear-unresolved"),
        Duration::from_secs(2),
    )
    .unwrap();
    safe_off_all(&session, ExecutionMode::Live, Duration::from_secs(2)).unwrap();
    clear_protection(&session, 2, ExecutionMode::Live, Duration::from_secs(2)).unwrap();
    let status =
        normalized_protection_status_all(&session, ExecutionMode::Live, Duration::from_secs(2))
            .unwrap();
    let channel = status
        .channels
        .iter()
        .find(|channel| channel.channel == 2)
        .unwrap();
    assert!(channel.over_voltage_tripped);
    assert!(status.protection_tripped);
    assert!(session.shutdown(Duration::from_secs(2)).unwrap().success());
}

fn simulated_manual_powers_status_uses_simulation_context() {
    let session = start_worker(&fixture_spec("manual-sim-status"), Duration::from_secs(2)).unwrap();
    let status =
        normalized_protection_status_all(&session, ExecutionMode::Simulate, Duration::from_secs(2))
            .unwrap();
    assert!(!status.protection_tripped);
    assert_eq!(status.channels.len(), 2);
    assert!(session.shutdown(Duration::from_secs(2)).unwrap().success());
}

fn simulated_manual_powers_clear_returns_plan_without_reread() {
    let session = start_worker(&fixture_spec("manual-sim-clear"), Duration::from_secs(2)).unwrap();
    safe_off_all(&session, ExecutionMode::Simulate, Duration::from_secs(2)).unwrap();
    let result =
        clear_protection(&session, 2, ExecutionMode::Simulate, Duration::from_secs(2)).unwrap();
    assert_eq!(result["execution"]["hardware_touched"], false);
    assert_eq!(result["data"]["plan"]["channel"], 2);
    assert!(session.shutdown(Duration::from_secs(2)).unwrap().success());
}

fn powers_protection_status_asserts_untripped_result() {
    let template = Template::from_json_str(&json!({
        "schema_version": 2,
        "name": "Power Protection Status",
        "tool_instances": [{ "id": "powers-1", "tool": "powers", "setup": {} }],
        "workflow": { "steps": [
            { "type": "tool-action", "id": "protection-1", "target": "powers-1",
              "action": "protection-status", "arguments": { "channel": "all" } },
            { "type": "assert", "id": "assert-1",
              "left": { "source": "step-output", "step_id": "protection-1", "pointer": "/protection_tripped" },
              "operator": "equal", "right": { "source": "literal", "value": false },
              "message": "Power protection tripped" },
            { "type": "wait", "id": "later-1", "duration_ms": 0 }
        ] }
    }).to_string()).unwrap();
    let run = run_simulated_workflow(
        &template,
        &HashMap::from([(
            ToolInstanceId::new("powers-1").unwrap(),
            fixture_spec("powers-workflow-protection-status"),
        )]),
        Duration::from_secs(5),
        Duration::from_secs(5),
        Duration::from_secs(5),
    )
    .unwrap();
    let executions = run.step_executions();
    assert_eq!(executions.len(), 3);
    for execution in executions {
        assert!(matches!(
            execution.result().outcome(),
            StepOutcome::Succeeded { .. }
        ));
    }
    let StepOutcome::Succeeded { output } = executions[0].result().outcome() else {
        unreachable!()
    };
    assert_eq!(output["protection_tripped"], false);
    assert_eq!(output["request"]["command"], "protection-status");
    assert_eq!(output["metadata"]["source"], "fixture");
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

fn meters_runtime_custom_measure_drains_the_complete_batch() {
    let session = start_worker(
        &fixture_spec("meters-runtime-custom"),
        Duration::from_secs(5),
    )
    .unwrap();
    let setup = MetersSetup {
        trigger_mode: MetersTriggerMode::SoftwareCustom,
        sample_count: 3,
        ..MetersSetup::default()
    };
    let result = run_meters_action_with_setup(
        &session,
        &ActionId::new("measure").unwrap(),
        &json!({}),
        &setup,
        Duration::from_secs(5),
    )
    .unwrap();
    assert_eq!(result.as_array().unwrap().len(), 3);
    assert_eq!(result[2]["value"], 0.057);
    assert!(session.shutdown(Duration::from_secs(5)).unwrap().success());
}

fn meters_runtime_custom_measure_uses_sample_inactivity_timeout() {
    let session = start_worker(
        &fixture_spec("meters-runtime-custom-slow"),
        Duration::from_secs(5),
    )
    .unwrap();
    let setup = MetersSetup {
        trigger_mode: MetersTriggerMode::SoftwareCustom,
        sample_count: 3,
        ..MetersSetup::default()
    };
    let timeout = Duration::from_millis(700);
    let start = Instant::now();
    let result = run_meters_action_with_setup(
        &session,
        &ActionId::new("measure").unwrap(),
        &json!({}),
        &setup,
        timeout,
    )
    .unwrap();

    assert_eq!(result.as_array().unwrap().len(), 3);
    assert!(
        start.elapsed() > timeout,
        "batch should take longer than one timeout window"
    );
    assert!(session.shutdown(Duration::from_secs(5)).unwrap().success());
}

fn meters_runtime_passive_custom_modes_preserve_batches() {
    for trigger_mode in [
        MetersTriggerMode::ImmediateCustom,
        MetersTriggerMode::ExternalCustom,
    ] {
        let session = start_worker(
            &fixture_spec("meters-runtime-passive-custom-4"),
            Duration::from_secs(5),
        )
        .unwrap();
        let setup = MetersSetup {
            trigger_mode,
            sample_count: 2,
            ..MetersSetup::default()
        };

        let first = run_meters_action_with_setup(
            &session,
            &ActionId::new("measure").unwrap(),
            &json!({}),
            &setup,
            Duration::from_secs(2),
        )
        .unwrap();
        let second = run_meters_action_with_setup(
            &session,
            &ActionId::new("measure").unwrap(),
            &json!({}),
            &setup,
            Duration::from_secs(2),
        )
        .unwrap();

        assert_eq!(
            first
                .as_array()
                .unwrap()
                .iter()
                .map(|sample| sample["value"].as_f64().unwrap())
                .collect::<Vec<_>>(),
            vec![1.0, 2.0]
        );
        assert_eq!(
            second
                .as_array()
                .unwrap()
                .iter()
                .map(|sample| sample["value"].as_f64().unwrap())
                .collect::<Vec<_>>(),
            vec![3.0, 4.0]
        );
        assert!(session.shutdown(Duration::from_secs(5)).unwrap().success());
    }
}

fn meters_runtime_passive_custom_waits_for_samples() {
    let session = start_worker(
        &fixture_spec("meters-runtime-passive-custom-delayed-3"),
        Duration::from_secs(5),
    )
    .unwrap();
    let setup = MetersSetup {
        trigger_mode: MetersTriggerMode::ExternalCustom,
        sample_count: 3,
        ..MetersSetup::default()
    };

    let start = Instant::now();
    let result = run_meters_action_with_setup(
        &session,
        &ActionId::new("measure").unwrap(),
        &json!({}),
        &setup,
        Duration::from_secs(1),
    )
    .unwrap();

    assert!(start.elapsed() >= Duration::from_millis(150));
    assert_eq!(result.as_array().unwrap().len(), 3);
    assert_eq!(result[2]["value"], 0.103);
    assert!(session.shutdown(Duration::from_secs(5)).unwrap().success());
}

fn meters_runtime_passive_custom_times_out_without_samples() {
    let session = start_worker(
        &fixture_spec("meters-runtime-passive-custom-empty"),
        Duration::from_secs(5),
    )
    .unwrap();
    let setup = MetersSetup {
        trigger_mode: MetersTriggerMode::ExternalCustom,
        sample_count: 1,
        ..MetersSetup::default()
    };

    let error = run_meters_action_with_setup(
        &session,
        &ActionId::new("measure").unwrap(),
        &json!({}),
        &setup,
        Duration::from_millis(200),
    )
    .unwrap_err();
    assert!(matches!(error, MetersActionError::Timeout(_)));
    assert!(session.shutdown(Duration::from_secs(5)).unwrap().success());
}

fn meters_immediate_custom_auto_exit_completes_workflow() {
    let template = custom_meter_template_with_mode(
        json!([
            { "type": "tool-action", "id": "measure", "target": "meters-1",
              "action": "measure", "arguments": {} },
            { "type": "output", "id": "value", "name": "value", "page": "Batch",
              "value": { "source": "step-output", "step_id": "measure", "pointer": "/value" } }
        ]),
        "immediate-custom",
    );
    let run = run_simulated_workflow(
        &template,
        &HashMap::from([(
            ToolInstanceId::new("meters-1").unwrap(),
            fixture_spec("meters-runtime-passive-custom-auto-exit-3"),
        )]),
        Duration::from_secs(5),
        Duration::from_secs(5),
        Duration::from_secs(5),
    )
    .unwrap();

    assert_eq!(run.result_rows().len(), 3);
    assert_eq!(run.result_rows()[0].outputs()[0].value(), &json!(0.201));
    assert_eq!(run.result_rows()[2].outputs()[0].value(), &json!(0.203));
}

fn meters_custom_auto_exit_completes_workflow() {
    let template = custom_meter_template(json!([
        { "type": "tool-action", "id": "measure", "target": "meters-1",
          "action": "measure", "arguments": {} },
        { "type": "output", "id": "value", "name": "value", "page": "Batch",
          "value": { "source": "step-output", "step_id": "measure", "pointer": "/value" } },
        { "type": "wait", "id": "allow-worker-exit", "duration_ms": 200 }
    ]));
    let run = run_simulated_workflow(
        &template,
        &HashMap::from([(
            ToolInstanceId::new("meters-1").unwrap(),
            fixture_spec("meters-runtime-custom-auto-exit"),
        )]),
        Duration::from_secs(5),
        Duration::from_secs(5),
        Duration::from_secs(5),
    )
    .unwrap();

    assert_eq!(run.result_rows().len(), 3);
    assert_eq!(run.result_rows()[2].outputs()[0].value(), &json!(0.057));
}

fn meters_custom_shutdown_waits_for_exit_after_stop_failure() {
    let template = custom_meter_template(json!([
        { "type": "tool-action", "id": "measure", "target": "meters-1",
          "action": "measure", "arguments": {} },
        { "type": "output", "id": "value", "name": "value", "page": "Batch",
          "value": { "source": "step-output", "step_id": "measure", "pointer": "/value" } }
    ]));
    let run = run_simulated_workflow(
        &template,
        &HashMap::from([(
            ToolInstanceId::new("meters-1").unwrap(),
            fixture_spec("meters-runtime-custom-delayed-auto-exit"),
        )]),
        Duration::from_secs(5),
        Duration::from_secs(5),
        Duration::from_secs(5),
    )
    .unwrap();

    assert_eq!(run.result_rows().len(), 3);
}

fn custom_meter_template(steps: serde_json::Value) -> Template {
    custom_meter_template_with_mode(steps, "software-custom")
}

fn custom_meter_template_with_mode(steps: serde_json::Value, trigger_mode: &str) -> Template {
    Template::from_json_str(
        &json!({
            "schema_version": 2, "name": "Custom meter", "tool_instances": [{
                "id": "meters-1", "tool": "meters", "setup": {
                    "measurement": "voltage-dc", "range_mode": "auto",
                    "manual_range": null, "nplc": 1.0, "auto_zero": "on",
                    "dcv_input_impedance": null, "current_terminal": null,
                    "trigger_mode": trigger_mode, "sample_count": 3,
                    "buffer_drain_size": null, "allow_buffer_overflow_risk": false
                }
            }], "workflow": { "steps": steps }
        })
        .to_string(),
    )
    .unwrap()
}

fn meters_custom_outputs_expand_rows_and_preserve_staging() {
    let measure = json!({
        "type": "tool-action", "id": "measure", "target": "meters-1",
        "action": "measure", "arguments": {}
    });
    let template = custom_meter_template(json!([
        measure,
        { "type": "output", "id": "scalar", "name": "power", "page": "Batch",
          "value": { "source": "literal", "value": 3.0 } },
        { "type": "output", "id": "value", "name": "value", "page": "Batch",
          "value": { "source": "step-output", "step_id": "measure", "pointer": "/value" } },
        { "type": "output", "id": "millivolts", "name": "millivolts", "page": "Batch",
          "value": { "source": "expression",
            "left": { "source": "step-output", "step_id": "measure", "pointer": "/value" },
            "operator": "multiply", "right": { "source": "literal", "value": 1000 } } },
        { "type": "output", "id": "other", "name": "temperature", "page": "Scalar",
          "value": { "source": "literal", "value": 25 } }
    ]));
    let mut events = Vec::new();
    let run = run_workflow_with_events(
        &template,
        ExecutionMode::Simulate,
        &HashMap::from([(
            ToolInstanceId::new("meters-1").unwrap(),
            fixture_spec("meters-runtime-custom"),
        )]),
        Duration::from_secs(5),
        Duration::from_secs(5),
        Duration::from_secs(5),
        |event| events.push(event),
    )
    .unwrap();
    let batch = run
        .result_rows()
        .iter()
        .filter(|row| row.page() == "Batch")
        .collect::<Vec<_>>();
    assert_eq!(batch.len(), 3);
    for (index, expected) in [0.055, 0.056, 0.057].into_iter().enumerate() {
        assert_eq!(batch[index].outputs()[0].value(), &json!(3.0));
        assert_eq!(batch[index].outputs()[1].value(), &json!(expected));
        assert_eq!(batch[index].outputs()[2].value(), &json!(expected * 1000.0));
    }
    assert_eq!(
        run.result_rows()
            .iter()
            .filter(|row| row.page() == "Scalar")
            .count(),
        1
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event, WorkflowRunEvent::ResultRowCommitted(row) if row.page() == "Batch"))
            .count(),
        3
    );

    let failed = custom_meter_template(json!([
        { "type": "tool-action", "id": "measure", "target": "meters-1",
          "action": "measure", "arguments": {} },
        { "type": "output", "id": "value", "name": "value", "page": "Batch",
          "value": { "source": "step-output", "step_id": "measure", "pointer": "/value" } },
        { "type": "assert", "id": "failure", "left": { "source": "literal", "value": 0 },
          "operator": "greater-than", "right": { "source": "literal", "value": 1 },
          "message": "later failure" }
    ]));
    let run = run_simulated_workflow(
        &failed,
        &HashMap::from([(
            ToolInstanceId::new("meters-1").unwrap(),
            fixture_spec("meters-runtime-custom"),
        )]),
        Duration::from_secs(5),
        Duration::from_secs(5),
        Duration::from_secs(5),
    )
    .unwrap();
    assert!(run.result_rows().is_empty());

    let error = Template::from_json_str(
        &json!({
            "schema_version": 2, "name": "Two batches", "tool_instances": [{
                "id": "meters-1", "tool": "meters", "setup": {
                    "measurement": "voltage-dc", "range_mode": "auto",
                    "manual_range": null, "nplc": 1.0, "auto_zero": "on",
                    "dcv_input_impedance": null, "current_terminal": null,
                    "trigger_mode": "software-custom", "sample_count": 3,
                    "buffer_drain_size": null, "allow_buffer_overflow_risk": false
                }
            }],
            "workflow": { "steps": [
                { "type": "tool-action", "id": "measure-a", "target": "meters-1", "action": "measure", "arguments": {} },
                { "type": "output", "id": "out-a", "name": "a", "page": "Batch",
                  "value": { "source": "step-output", "step_id": "measure-a", "pointer": "/value" } },
                { "type": "tool-action", "id": "measure-b", "target": "meters-1", "action": "measure", "arguments": {} },
                { "type": "output", "id": "out-b", "name": "b", "page": "Batch",
                  "value": { "source": "step-output", "step_id": "measure-b", "pointer": "/value" } }
            ] }
        })
        .to_string(),
    )
    .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("more than one independent batch source")
    );

    let error = Template::from_json_str(
        &json!({
            "schema_version": 2, "name": "Batch used by Assert", "tool_instances": [{
                "id": "meters-1", "tool": "meters", "setup": {
                    "measurement": "voltage-dc", "range_mode": "auto",
                    "manual_range": null, "nplc": 1.0, "auto_zero": "on",
                    "dcv_input_impedance": null, "current_terminal": null,
                    "trigger_mode": "software-custom", "sample_count": 3
                }
            }],
            "workflow": { "steps": [
                { "type": "tool-action", "id": "measure", "target": "meters-1", "action": "measure", "arguments": {} },
                { "type": "assert", "id": "assert-batch",
                  "left": { "source": "step-output", "step_id": "measure", "pointer": "/value" },
                  "operator": "greater-than", "right": { "source": "literal", "value": 0 },
                  "message": "batch assert" }
            ] }
        })
        .to_string(),
    )
    .unwrap_err();
    assert!(
        error.to_string().contains("supported only by Output steps"),
        "{error}"
    );
}

fn powers_and_meters_workflow_executes_end_to_end() {
    let workflow = Workflow::new(vec![
        Step::new(
            StepId::new("power-set-1").unwrap(),
            StepKind::ToolAction {
                target: ToolInstanceId::new("powers-1").unwrap(),
                action: ActionId::new("set-voltage").unwrap(),
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
            "schema_version": 2,
            "tool_instances": [{"id": "meters-1", "tool": "meters", "setup": {
                "measurement": "voltage-dc", "range_mode": "auto", "manual_range": null,
                "nplc": 1.0, "auto_zero": "on", "dcv_input_impedance": null,
                "current_terminal": null
            }}, {"id": "powers-1", "tool": "powers", "setup": {}}],
            "name": "Measurement CSV",
            "workflow": { "steps": [
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
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&saved).unwrap()["schema_version"],
        2
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
                        target: ToolInstanceId::new("meters-1").unwrap(),
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
        Some(4),
        &MetersSetup {
            measurement: MetersMeasurement::VoltageDc,
            range_mode: RangeMode::Auto,
            manual_range: None,
            nplc: 1.0,
            auto_zero: AutoZero::On,
            dcv_input_impedance: None,
            current_terminal: None,
            ..MetersSetup::default()
        },
    );
    let run = run_simulated_workflow(
        &test_template(&workflow),
        &HashMap::from([(
            ToolInstanceId::new("meters-1").unwrap(),
            spec.with_manifest(fixture_manifest("meters-runtime")),
        )]),
        Duration::from_secs(5),
        Duration::from_secs(5),
        Duration::from_secs(5),
    )
    .unwrap();
    let results = run.step_executions();
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
                target: ToolInstanceId::new("powers-1").unwrap(),
                action: ActionId::new("set-voltage").unwrap(),
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

fn record_event_if_requested(event: &str) {
    let Some(marker) = env::var_os(CLEANUP_MARKER_ENV) else {
        return;
    };
    let mut file = fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(marker)
        .unwrap();
    writeln!(file, "{event}").unwrap();
}

fn powers_protection_setup_lifecycle() {
    let template = Template::from_json_str(
        &json!({
            "schema_version": 2, "name": "Protection setup fixture",
            "tool_instances": [{"id":"powers-1","tool":"powers","setup":{"protection":{"channels":[
                {"channel":1,"ovp_voltage":5.5,"ocp":"on"}]}}}],
            "workflow":{"steps":[
                {"type":"tool-action","id":"set-1","target":"powers-1","action":"set-voltage",
                    "arguments":{"channel":1,"voltage":5.0}},
                {"type":"tool-action","id":"on-1","target":"powers-1","action":"output-on",
                    "arguments":{"channel":1}},
                {"type":"tool-action","id":"off-1","target":"powers-1","action":"output-off",
                    "arguments":{"channel":1}}
            ]}
        })
        .to_string(),
    )
    .unwrap();
    for (scenario, mode, expected) in [
        (
            "live-protection-success",
            ExecutionMode::Live,
            "safe-off\nprotection-status\nprotection-set\nset\noutput-on\noutput-off\nsafe-off\nstop\n",
        ),
        (
            "live-protection-trip",
            ExecutionMode::Live,
            "safe-off\nprotection-status\nsafe-off\nstop\n",
        ),
        (
            "live-protection-set-failure",
            ExecutionMode::Live,
            "safe-off\nprotection-status\nprotection-set\nsafe-off\nstop\n",
        ),
        (
            "live-protection-set-and-cleanup-failure",
            ExecutionMode::Live,
            "safe-off\nprotection-status\nprotection-set\nsafe-off\nstop\n",
        ),
        (
            "simulate-protection-success",
            ExecutionMode::Simulate,
            "safe-off\nprotection-status\nprotection-set\nset\noutput-on\noutput-off\nsafe-off\nstop\n",
        ),
        (
            "simulate-protection-trip",
            ExecutionMode::Simulate,
            "safe-off\nprotection-status\nsafe-off\nstop\n",
        ),
        (
            "simulate-protection-set-failure",
            ExecutionMode::Simulate,
            "safe-off\nprotection-status\nprotection-set\nsafe-off\nstop\n",
        ),
    ] {
        let marker = env::temp_dir().join(format!(
            "orchestrator-protection-{}-{scenario}",
            process::id()
        ));
        let _ = fs::remove_file(&marker);
        // SAFETY: fixture scenarios run sequentially and their sessions finish before removal.
        unsafe { env::set_var(CLEANUP_MARKER_ENV, &marker) };
        let specs = HashMap::from([(
            ToolInstanceId::new("powers-1").unwrap(),
            fixture_spec(scenario),
        )]);
        let result = run_workflow(
            &template,
            mode,
            &specs,
            Duration::from_secs(5),
            Duration::from_secs(5),
            Duration::from_secs(5),
        );
        unsafe { env::remove_var(CLEANUP_MARKER_ENV) };
        assert_eq!(fs::read_to_string(&marker).unwrap(), expected);
        fs::remove_file(&marker).unwrap();
        match scenario {
            "live-protection-success" | "simulate-protection-success" => {
                assert_eq!(result.unwrap().step_executions().len(), 3);
            }
            "live-protection-trip" | "simulate-protection-trip" => assert!(
                result
                    .unwrap_err()
                    .to_string()
                    .contains("Protection is already tripped and must be cleared before running.")
            ),
            "live-protection-set-failure" | "simulate-protection-set-failure" => assert!(
                result
                    .unwrap_err()
                    .to_string()
                    .contains("Protection Set failed")
            ),
            "live-protection-set-and-cleanup-failure" => {
                let message = result.unwrap_err().to_string();
                assert!(
                    message.contains("Protection Set failed") && message.contains("cleanup failed"),
                    "{message}"
                );
            }
            _ => unreachable!(),
        }
    }
}

fn live_workflow_cleanup_lifecycle() {
    for scenario in [
        "simulate-step-failure",
        "live-success",
        "live-assert-failure",
        "live-for-failure",
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
                    target: ToolInstanceId::new("powers-1").unwrap(),
                    action: ActionId::new("set-voltage").unwrap(),
                    arguments: json!({ "channel": 1, "voltage": 5.0 }),
                    bindings: Default::default(),
                },
            ),
            Step::new(
                StepId::new("on-1").unwrap(),
                StepKind::ToolAction {
                    target: ToolInstanceId::new("powers-1").unwrap(),
                    action: ActionId::new("output-on").unwrap(),
                    arguments: json!({ "channel": 1 }),
                    bindings: Default::default(),
                },
            ),
            Step::new(
                StepId::new("off-1").unwrap(),
                StepKind::ToolAction {
                    target: ToolInstanceId::new("powers-1").unwrap(),
                    action: ActionId::new("output-off").unwrap(),
                    arguments: json!({ "channel": 1 }),
                    bindings: Default::default(),
                },
            ),
        ];
        let mut specs = HashMap::from([(
            ToolInstanceId::new("powers-1").unwrap(),
            fixture_spec(if scenario == "live-for-failure" {
                "live-assert-failure"
            } else {
                scenario
            }),
        )]);
        if matches!(scenario, "live-assert-failure" | "live-for-failure") {
            steps.insert(
                2,
                Step::new(
                    StepId::new("measure-1").unwrap(),
                    StepKind::ToolAction {
                        target: ToolInstanceId::new("meters-1").unwrap(),
                        action: ActionId::new("measure").unwrap(),
                        arguments: json!({}),
                        bindings: Default::default(),
                    },
                ),
            );
            steps.insert(
                3,
                Step::new(
                    StepId::new("assert-1").unwrap(),
                    StepKind::Assert {
                        condition: Expression::new(
                            ExpressionOperand::StepOutput(StepOutputReference::new(
                                StepId::new("measure-1").unwrap(),
                                "/value",
                            )),
                            ExpressionOperator::GreaterThanOrEqual,
                            ExpressionOperand::Literal(json!(4.9)),
                        ),
                        message: "Voltage is below minimum.".to_owned(),
                    },
                ),
            );
            specs.insert(
                ToolInstanceId::new("meters-1").unwrap(),
                fixture_spec("meters-runtime-measure"),
            );
        }
        if scenario == "live-for-failure" {
            let mut body = steps.drain(2..4).collect::<Vec<_>>();
            body.push(Step::new(
                StepId::new("body-later").unwrap(),
                StepKind::Wait { duration_ms: 0 },
            ));
            steps.insert(
                2,
                Step::new(
                    StepId::new("sweep").unwrap(),
                    StepKind::For {
                        variable: VariableId::new("x").unwrap(),
                        range: NumericRange::new(1.into(), 3.into(), 1.into()).unwrap(),
                        body,
                    },
                ),
            );
        }
        if scenario == "live-startup-failure" {
            steps.push(Step::new(
                StepId::new("measure-1").unwrap(),
                StepKind::ToolAction {
                    target: ToolInstanceId::new("meters-1").unwrap(),
                    action: ActionId::new("measure").unwrap(),
                    arguments: json!({}),
                    bindings: Default::default(),
                },
            ));
            specs.insert(
                ToolInstanceId::new("meters-1").unwrap(),
                fixture_spec("exit-before-ready"),
            );
        }
        let workflow = Workflow::new(steps).unwrap();
        let result = run_workflow(
            &test_template(&workflow),
            if scenario.starts_with("simulate") {
                ExecutionMode::Simulate
            } else {
                ExecutionMode::Live
            },
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
                let run = result.unwrap();
                let results = run.step_executions();
                assert_eq!(results.len(), 3);
                assert!(
                    results
                        .iter()
                        .all(|r| matches!(r.outcome(), StepOutcome::Succeeded { .. }))
                );
                assert_eq!(events, "set\noutput-on\noutput-off\nsafe-off\nstop\n");
            }
            "live-assert-failure" | "live-for-failure" => {
                let run = result.unwrap();
                let results = run.step_executions();
                assert_eq!(
                    results.len(),
                    if scenario == "live-for-failure" { 5 } else { 4 }
                );
                if scenario == "live-for-failure" {
                    let occurrence = results[3].for_iteration().unwrap();
                    assert_eq!(occurrence.for_step_id().as_str(), "sweep");
                    assert_eq!(occurrence.iteration_index(), 0);
                    assert_eq!(results[4].step_id().as_str(), "sweep");
                    assert!(results[4].for_iteration().is_none());
                    assert!(
                        matches!(results[4].outcome(), StepOutcome::Failed { message }
                        if message.contains("assert-1") && message.contains("Voltage is below minimum."))
                    );
                    assert!(run.result_rows().is_empty());
                }
                assert!(
                    results[..3]
                        .iter()
                        .all(|r| matches!(r.outcome(), StepOutcome::Succeeded { .. }))
                );
                assert_eq!(results[3].step_id().as_str(), "assert-1");
                assert_eq!(
                    results[3].outcome(),
                    &StepOutcome::Failed {
                        message: "Voltage is below minimum.".to_owned(),
                    }
                );
                assert_eq!(events, "set\noutput-on\nsafe-off\nstop\n");
            }
            "simulate-step-failure" | "live-step-failure" => {
                let run = result.unwrap();
                let results = run.step_executions();
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

fn multiple_powers_cleanup_attempts_every_session() {
    let marker = env::temp_dir().join(format!("orchestrator-multiple-powers-{}", process::id()));
    let _ = fs::remove_file(&marker);
    // SAFETY: fixtures run sequentially and child sessions are reaped before removal.
    unsafe { env::set_var(CLEANUP_MARKER_ENV, &marker) };
    let workflow = Workflow::new(
        vec!["powers-1", "powers-2"]
            .into_iter()
            .map(|id| {
                Step::new(
                    StepId::new(id).unwrap(),
                    StepKind::ToolAction {
                        target: ToolInstanceId::new(id).unwrap(),
                        action: ActionId::new("unsupported").unwrap(),
                        arguments: json!({"channel": 1}),
                        bindings: Default::default(),
                    },
                )
            })
            .collect(),
    )
    .unwrap();
    let instances = ["powers-1", "powers-2"]
        .into_iter()
        .map(|id| ToolInstance {
            display_name: None,
            id: ToolInstanceId::new(id).unwrap(),
            tool: orchestrator_tool::tool::ToolId::powers(),
            setup: ToolSetup::Powers(orchestrator_tool::powers_setup::PowersSetup::default()),
        })
        .collect();
    let template = Template::new("Two Powers".to_owned(), instances, workflow).unwrap();
    // An unsupported action fails before dispatch; cleanup must still reach both workers.
    let specs = template
        .tool_instances()
        .iter()
        .map(|instance| {
            (
                instance.id.clone(),
                fixture_spec("live-multi-cleanup-failure"),
            )
        })
        .collect();
    let result = run_workflow(
        &template,
        ExecutionMode::Live,
        &specs,
        Duration::from_secs(5),
        Duration::from_secs(5),
        Duration::from_secs(5),
    );
    // SAFETY: all child sessions have been reaped.
    unsafe { env::remove_var(CLEANUP_MARKER_ENV) };
    let events = fs::read_to_string(&marker).unwrap();
    fs::remove_file(marker).unwrap();
    let error = result.unwrap_err();
    assert!(matches!(
        &error,
        WorkflowRunError::SafetyCleanup { instance, .. }
            if instance == &ToolInstanceId::new("powers-1").unwrap()
    ));
    let message = error.to_string();
    assert!(
        message.contains("powers-1 Power safety cleanup failed"),
        "{message}"
    );
    assert_eq!(
        events.lines().filter(|event| *event == "safe-off").count(),
        2,
        "{events}"
    );
    assert_eq!(
        events.lines().filter(|event| *event == "stop").count(),
        2,
        "{events}"
    );
}

fn two_meters_use_distinct_sessions() {
    let mut instances =
        test_template(&Workflow::new(vec![]).unwrap()).tool_instances()[1..].to_vec();
    let mut second = instances[0].clone();
    second.id = ToolInstanceId::new("meters-2").unwrap();
    instances.push(second);
    let workflow = Workflow::new(
        instances
            .iter()
            .map(|instance| {
                Step::new(
                    StepId::new(instance.id.as_str()).unwrap(),
                    StepKind::ToolAction {
                        target: instance.id.clone(),
                        action: ActionId::new("measure").unwrap(),
                        arguments: json!({}),
                        bindings: Default::default(),
                    },
                )
            })
            .collect(),
    )
    .unwrap();
    let template = Template::new("Two Meters".to_owned(), instances, workflow).unwrap();
    let specs = template
        .tool_instances()
        .iter()
        .map(|instance| (instance.id.clone(), fixture_spec("meters-runtime-measure")))
        .collect();
    let run = run_simulated_workflow(
        &template,
        &specs,
        Duration::from_secs(5),
        Duration::from_secs(5),
        Duration::from_secs(5),
    )
    .unwrap();
    let results = run.step_executions();
    let outputs: Vec<_> = results
        .iter()
        .map(|result| match result.outcome() {
            StepOutcome::Succeeded { output } => output,
            outcome => panic!("{outcome:?}"),
        })
        .collect();
    assert_eq!(outputs.len(), 2);
    assert_ne!(outputs[0]["run_id"], outputs[1]["run_id"]);
}
