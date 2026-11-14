use orchestrator_tool::{
    interaction::{CommandState as C, InteractionCore, ResultState},
    meters_setup::{MetersSetup, MetersTriggerMode},
    template::Template,
};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Barrier},
    thread,
    time::{Duration, Instant},
};

fn core(capacity: usize) -> (InteractionCore, u64) {
    let core = InteractionCore::new(capacity).unwrap();
    let generation = core.worker_on("a").unwrap();
    (core, generation)
}

#[test]
fn interaction_reserves_run_capacity_atomically_across_backgrounds() {
    let (core, _) = core(1);
    core.worker_on("b").unwrap();
    let gate = Arc::new(Barrier::new(3));
    let threads: Vec<_> = ["a", "b"]
        .into_iter()
        .map(|bg| {
            let core = core.clone();
            let gate = gate.clone();
            thread::spawn(move || {
                gate.wait();
                core.reserve(bg, false)
            })
        })
        .collect();
    gate.wait();
    let ids: Vec<_> = threads
        .into_iter()
        .filter_map(|t| t.join().unwrap().ok())
        .collect();
    assert_eq!(ids.len(), 1);
    assert_eq!(core.snapshot().commands.len(), 1);
    core.rejected(ids[0]);
    assert!(core.reserve("b", false).is_ok());
}

#[test]
fn interaction_result_needs_completion_and_ready_in_either_order() {
    for ready_first in [false, true] {
        let (core, generation) = core(2);
        let id = core.reserve("a", true).unwrap();
        core.observe(id, generation, C::Accepted, None);
        core.finish_dispatch(id);
        if ready_first {
            core.result(id, generation, Ok(json!({"value": 42})));
        } else {
            core.observe(id, generation, C::Completed, None);
        }
        assert_eq!(core.take_result(id).unwrap(), None);
        assert!(core.reserve("a", true).is_err());
        if ready_first {
            core.observe(id, generation, C::Completed, None);
        } else {
            core.result(id, generation, Ok(json!({"value": 42})));
        }
        assert_eq!(core.take_result(id).unwrap(), Some(json!({"value":42})));
        assert!(core.snapshot().commands.is_empty());
        assert!(core.reserve("a", true).is_ok());
    }
    let (core, generation) = core(2);
    let id = core.reserve("a", true).unwrap();
    core.observe(id, generation, C::Accepted, None);
    core.finish_dispatch(id);
    core.result(id, generation, Ok(json!({"value": 42})));
    core.observe(id, generation, C::Failed, Some("measurement failed".into()));
    assert_eq!(core.take_result(id).unwrap_err(), "measurement failed");
    assert!(core.snapshot().failure.is_some());
    assert!(
        core.reserve("a", true).is_ok(),
        "terminal failure releases the result slot"
    );
    core.result(id, generation, Ok(json!({"value": 99})));
    assert_eq!(core.take_result(id).unwrap_err(), "measurement failed");
}

#[test]
fn interaction_release_preserves_pending_identity_and_unread_result_errors() {
    let (core, generation) = core(2);
    let a = core.reserve("a", true).unwrap();
    core.observe(a, generation, C::Completed, None);
    core.finish_dispatch(a);
    core.release_interest(a);
    assert!(core.reserve("a", true).is_err());
    core.result(a, generation, Ok(json!("a")));
    let b = core.reserve("a", true).unwrap();
    core.result(a, generation, Ok(json!("late duplicate a")));
    assert!(matches!(
        core.command(b).unwrap().result,
        ResultState::Pending
    ));
    core.observe(b, generation, C::Completed, None);
    core.finish_dispatch(b);
    core.result(b, generation, Err("result unavailable".into()));
    assert_eq!(core.take_result(b).unwrap_err(), "result unavailable");
    assert!(
        core.snapshot().failure.is_none(),
        "result failure alone is not a Run failure"
    );
    assert!(
        core.reserve("a", true).is_ok(),
        "terminal result error releases slot"
    );
    core.release_interest(b);
    assert!(core.command(b).is_err());
}

#[test]
fn interaction_unknown_and_failure_survive_late_or_merged_notifications() {
    let (core, generation) = core(2);
    let id = core.reserve("a", false).unwrap();
    let revision = core.snapshot().revision;
    core.observe(
        id,
        generation,
        C::DispatchOutcomeUnknown,
        Some("ACK missing".into()),
    );
    core.observe(id, generation, C::Accepted, None);
    core.wait_for_change(revision, Instant::now() + Duration::from_secs(10));
    assert!(core.snapshot().failure.unwrap().contains("ACK missing"));
    assert!(core.reserve("a", false).is_err());
    core.observe(id, generation, C::Completed, None);
    core.observe(id, generation, C::Failed, Some("contradictory".into()));
    assert_eq!(core.command(id).unwrap().state, C::Completed);
    core.finish_dispatch(id);
    assert!(core.snapshot().failure.is_some());
    core.worker_off("a", generation, false);
    assert!(core.worker_on("a").is_err());
}

#[test]
fn interaction_latest_and_atomic_next_preserve_invalid_first_event_and_lifecycle() {
    let (core, generation) = core(2);
    let next = core.next("a").unwrap(); // Source need not be Active yet.
    core.data("a", generation, Err("invalid first event".into()));
    core.data("a", generation, Ok(json!({"native":true})));
    assert_eq!(next.poll().unwrap_err(), "invalid first event");
    assert_eq!(core.latest("a").unwrap(), json!({"native":true}));
    core.data("a", generation, Err("invalid newest event".into()));
    assert_eq!(core.latest("a").unwrap_err(), "invalid newest event");
    core.source_ended("a", generation);
    assert!(core.next("a").is_err());
    assert_eq!(core.latest("a").unwrap_err(), "invalid newest event");
    let id = core.reserve("a", true);
    assert!(id.is_err());
    core.worker_off("a", generation, true);
    assert!(core.latest("a").is_err());
    let new_generation = core.worker_on("a").unwrap();
    assert_ne!(new_generation, generation);
    core.data("a", generation, Ok(json!("old")));
    assert!(core.latest("a").is_err());
    assert!(next.poll().is_err());
}

#[test]
fn interaction_completed_unreferenced_statuses_do_not_accumulate() {
    let (core, generation) = core(1);
    for _ in 0..10_000 {
        let id = core.reserve("a", false).unwrap();
        core.observe(id, generation, C::Accepted, None);
        core.finish_dispatch(id);
        core.observe(id, generation, C::Completed, None);
    }
    assert!(core.snapshot().commands.is_empty());
}

#[test]
#[ignore = "specialized million-command Core retention check; not a real Worker throughput benchmark"]
fn interaction_million_completed_commands_stay_bounded() {
    let (core, generation) = core(1);
    for _ in 0..1_000_000 {
        let id = core.reserve("a", false).unwrap();
        core.finish_dispatch(id);
        core.observe(id, generation, C::Completed, None);
    }
    assert!(core.snapshot().commands.is_empty());
}

fn template_wire() -> Value {
    let setup = MetersSetup {
        trigger_mode: MetersTriggerMode::Software,
        ..Default::default()
    };
    json!({"name":"Interaction", "tool_instances":[{"id":"meter","tool":"meters","setup":setup}],
    "backgrounds":[{"id":"a","tool_instance_id":"meter","limit_count":2,"command_trigger":true}],
    "workflow":{"interaction":{"enabled":true,"max_active_command_status":4096},"steps":[
        {"type":"bg-interaction","id":"send","background_id":"a","operation":{"kind":"command","command":"software-trigger","wait_for_completion":false}},
        {"type":"bg-interaction","id":"get","background_id":"a","operation":{"kind":"get-command-result","source_step":"send"}}
    ]}})
}

#[test]
fn interaction_template_round_trip_and_rejects_old_or_unsupported_contracts() {
    let wire = template_wire();
    let template = Template::from_json_str(&wire.to_string()).unwrap();
    let saved = template.to_json_string().unwrap();
    assert_eq!(template, Template::from_json_str(&saved).unwrap());
    for case in [
        "old",
        "disabled",
        "zero",
        "overflow",
        "fraction",
        "source",
        "background",
        "timeout",
        "capability",
        "timer",
    ] {
        let mut bad = wire.clone();
        match case {
            "old" => {
                bad["workflow"]
                    .as_object_mut()
                    .unwrap()
                    .remove("interaction");
            }
            "disabled" => bad["workflow"]["interaction"]["enabled"] = json!(false),
            "zero" => bad["workflow"]["interaction"]["max_active_command_status"] = json!(0),
            "overflow" => {
                bad["workflow"]["interaction"]["max_active_command_status"] = json!(65537)
            }
            "fraction" => bad["workflow"]["interaction"]["max_active_command_status"] = json!(1.5),
            "source" => bad["workflow"]["steps"][1]["operation"]["source_step"] = json!("missing"),
            "background" => bad["workflow"]["steps"][1]["background_id"] = json!("missing"),
            "timeout" => bad["workflow"]["steps"][0]["timeout_ms"] = json!(0),
            "capability" => {
                bad["tool_instances"][0]["setup"]["trigger_mode"] = json!("software-custom")
            }
            "timer" => bad["backgrounds"][0]["timer_interval_ms"] = json!(10),
            _ => unreachable!(),
        }
        assert!(Template::from_json_str(&bad.to_string()).is_err(), "{case}");
    }
    let mut escaped = wire.clone();
    let send = escaped["workflow"]["steps"][0].clone();
    escaped["workflow"]["steps"][0] = json!({"type":"for","id":"loop","variable":"i", "range":{"start":"0","stop":"2","step":"1"},"steps":[send]});
    assert!(Template::from_json_str(&escaped.to_string()).is_err());
}

#[test]
fn serial_commands_reuse_fg_arguments_bindings_and_template_scope() {
    let mut wire = template_wire();
    wire["tool_instances"] =
        json!([{"id":"serial","tool":"serial","setup":{"transport":"serial","baud":115200}}]);
    wire["backgrounds"] = json!([{"id":"a","tool_instance_id":"serial","limit_count":null}]);
    let op = json!({"kind":"command","command":"serial-send","wait_for_completion":true,
        "arguments":{"tx_format":"hex-byte","tx_value":257},
        "bindings":{"tx_value":{"source":"expression","left":{"source":"literal","value":257.8},"operator":"trunc"}}});
    wire["workflow"]["steps"][0]["operation"] = op.clone();
    let template = Template::from_json_str(&wire.to_string()).unwrap();
    let saved: Value = serde_json::from_str(&template.to_json_string().unwrap()).unwrap();
    assert_eq!(saved["workflow"]["steps"][0]["operation"], op);
    assert_eq!(
        Template::from_json_str(&saved.to_string()).unwrap(),
        template
    );
    for bad in [
        json!({"arguments":{"tx_format":"hex-byte","tx_value":1.5}}),
        json!({"arguments":{"tx_format":"text","tx_value":4}}),
        json!({"arguments":{"tx_format":"raw-hex","tx_value":"00ff"}}),
        json!({"bindings":{"path":{"source":"literal","value":"/file"}}}),
        json!({"bindings":{"tx_value":{"source":"variable","variable":"missing"}}}),
        json!({"bindings":{"tx_value":{"source":"step-output","step_id":"get","pointer":"/result/tx_bytes"}}}),
        json!({"arguments":null}),
        json!({"command":"serial-query"}),
        json!({"command":"software-trigger"}),
    ] {
        let mut invalid = wire.clone();
        if bad.get("arguments").is_some() {
            invalid["workflow"]["steps"][0]["operation"]
                .as_object_mut()
                .unwrap()
                .remove("bindings");
        }
        for (key, value) in bad.as_object().unwrap() {
            invalid["workflow"]["steps"][0]["operation"][key] = value.clone();
        }
        assert!(
            Template::from_json_str(&invalid.to_string()).is_err(),
            "{bad}"
        );
    }
    let mut file = wire.clone();
    file["workflow"]["steps"][0]["operation"] = json!({"kind":"command","command":"serial-send-file","wait_for_completion":false,"arguments":{"path":"/missing/file"}});
    let nested = file["workflow"]["steps"].clone();
    file["workflow"]["steps"] = json!([{"type":"for","id":"loop","variable":"i","range":{"start":"0","stop":"1","step":"1"},"steps":nested}]);
    let template = Template::from_json_str(&file.to_string()).unwrap();
    assert_eq!(
        orchestrator_tool::adapters::serial::send_file_path_errors(&template).len(),
        1
    );
    let error = orchestrator_tool::run::run_workflow(
        &template,
        orchestrator_tool::run::ExecutionMode::Simulate,
        &Default::default(),
        Duration::from_millis(10),
        Duration::from_millis(10),
        Duration::from_millis(10),
    )
    .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("Serial Send File preflight failed")
    );
    file["workflow"]["steps"][0]["steps"][0]["operation"]["bindings"] =
        json!({"path":{"source":"literal","value":"/another"}});
    assert!(Template::from_json_str(&file.to_string()).is_err());
    let mut meters = template_wire();
    meters["workflow"]["steps"][0]["operation"]["arguments"] = json!({});
    assert!(Template::from_json_str(&meters.to_string()).is_err());
    meters["workflow"]["steps"][0]["operation"] = op;
    assert!(Template::from_json_str(&meters.to_string()).is_err());
}
