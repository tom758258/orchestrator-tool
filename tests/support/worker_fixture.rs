use super::*;

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

pub(super) fn fixture_event_json(line: &str) -> String {
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

pub(super) fn fixture_summary() {
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

pub(super) struct TestRequest {
    pub(super) stream: TcpStream,
    pub(super) method: String,
    pub(super) path: String,
    pub(super) content_type: Option<String>,
    pub(super) body: Vec<u8>,
}

pub(super) fn accept_request(listener: &TcpListener) -> TestRequest {
    let (stream, _) = listener.accept().unwrap();
    read_request(stream)
}

pub(super) fn read_request(stream: TcpStream) -> TestRequest {
    // Background fixtures accept from a nonblocking listener. On Windows the
    // accepted socket can also be nonblocking, but this parser reads synchronously.
    stream.set_nonblocking(false).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
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

pub(super) fn write_response(mut stream: TcpStream, status: u16, body: &str) {
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

pub(super) fn print_json_line(line: &str) {
    let stdout = io::stdout();
    let mut stdout = stdout.lock();
    let converted = fixture_event_json(line);
    writeln!(stdout, "{converted}").unwrap();
    stdout.flush().unwrap();
}

pub(super) fn fixture_manifest_json(scenario: &str) -> serde_json::Value {
    let name = if scenario.starts_with("serial-") {
        "serial"
    } else if scenario.starts_with("meters-") {
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
        "serial" => (
            "multi_job",
            "startup",
            json!({"common.async_jobs":{"contract_version":1},
                "common.streaming":{"contract_version":1,"lifecycles":["run_bound"]}}),
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
        "features":features,
        "commands":if name == "serial" {
            json!({
                "send":{"kind":"async_job"},
                "send-file":{"kind":"async_job"},
                "receive":{"kind":"async_job"},
                "query":{"kind":"async_job"},
                "run-sequence":{"kind":"async_job"}
            })
        } else {
            json!({})
        }
    })
}

pub(super) fn fixture_manifest(scenario: &str) -> ToolManifest {
    let document = fixture_manifest_json(scenario);
    let expected = ToolId::new(document["tool_id"].as_str().unwrap()).unwrap();
    parse_manifest(&document.to_string(), &expected).unwrap()
}

pub(super) fn fixture_spec(scenario: &str) -> WorkerLaunchSpec {
    WorkerLaunchSpec::new(
        env::current_exe().unwrap(),
        [OsString::from(FIXTURE_ARGUMENT), OsString::from(scenario)],
    )
    .with_manifest(fixture_manifest(scenario))
}

pub(super) fn run_extra_v3_tool_fixture() {
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

pub(super) fn run_stream_readiness_fixture(scenario: &str) {
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
