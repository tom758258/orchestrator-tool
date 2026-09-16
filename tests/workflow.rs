use std::{collections::HashMap, time::Duration};

use orchestrator_tool::{
    run::run_simulated_workflow,
    template::Template,
    tool::ToolId,
    tool_instance::{ToolInstance, ToolInstanceId, ToolSetup},
    workflow::{
        ActionId, InputValue, OutputProjectionError, Step, StepId, StepKind, StepOutcome,
        StepResult, VariableId, Workflow, WorkflowError,
    },
};
use serde_json::json;

#[test]
fn comparison_expression_flows_through_simulated_workflow() {
    let template = Template::from_json_str(
        &json!({
            "schema_version": 1,
            "tool_instances": [],
            "name": "Comparison integration",
            "workflow": { "steps": [
                {
                    "type": "set-variable", "id": "set-threshold", "variable": "threshold",
                    "value": { "source": "literal", "value": 3 }
                },
                {
                    "type": "output", "id": "measurement",
                    "value": { "source": "literal", "value": { "value": 5 } }
                },
                {
                    "type": "set-variable", "id": "set-passed", "variable": "passed",
                    "value": {
                        "source": "expression",
                        "left": { "source": "step-output", "step_id": "measurement", "pointer": "/value" },
                        "operator": "greater-than",
                        "right": { "source": "variable", "variable": "threshold" }
                    }
                },
                {
                    "type": "output", "id": "output-passed",
                    "value": { "source": "variable", "variable": "passed" }
                }
            ] }
        })
        .to_string(),
    )
    .unwrap();
    let run = run_simulated_workflow(
        &template,
        &HashMap::new(),
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

    let outputs = template.workflow().project_outputs(&results).unwrap();
    assert_eq!(
        outputs
            .iter()
            .map(|output| output.name())
            .collect::<Vec<_>>(),
        ["measurement", "output-passed"]
    );
    assert_eq!(outputs[1].value(), &json!(true));
    let saved: serde_json::Value =
        serde_json::from_str(&template.to_json_string().unwrap()).unwrap();
    assert_eq!(saved["schema_version"], 1);
    assert_eq!(saved["workflow"]["steps"][1]["name"], "measurement");
    assert_eq!(
        Template::from_json_str(&saved.to_string()).unwrap(),
        template
    );

    assert_eq!(results.len(), 4);
    for (result, (id, output)) in results.iter().zip([
        ("set-threshold", json!(3)),
        ("measurement", json!({ "value": 5 })),
        ("set-passed", json!(true)),
        ("output-passed", json!(true)),
    ]) {
        assert_eq!(result.step_id().as_str(), id);
        assert_eq!(result.outcome(), &StepOutcome::Succeeded { output });
    }
}

#[test]
fn workflow_template_step_result_integration() {
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
            StepId::new("wait-1").unwrap(),
            StepKind::Wait { duration_ms: 500 },
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

    let template = Template::new(
        "Workflow Integration".to_owned(),
        vec![
            ToolInstance {
                id: ToolInstanceId::new("powers-1").unwrap(),
                tool: ToolId::powers(),
                setup: Default::default(),
            },
            ToolInstance {
                id: ToolInstanceId::new("meters-1").unwrap(),
                tool: ToolId::meters(),
                setup: ToolSetup::Meters(
                    serde_json::from_value(json!({
                        "measurement": "voltage-dc", "range_mode": "auto", "manual_range": null,
                        "nplc": 1.0, "auto_zero": "on", "dcv_input_impedance": null,
                        "current_terminal": null
                    }))
                    .unwrap(),
                ),
            },
        ],
        workflow,
    )
    .unwrap();
    let json = template.to_json_string().unwrap();
    let restored = Template::from_json_str(&json).unwrap();

    assert_eq!(restored, template);

    let meter_step = restored
        .workflow()
        .steps()
        .iter()
        .find(|step| step.id().as_str() == "meter-read-1")
        .unwrap();

    let output = json!({ "value": 3.3012, "unit": "V" });
    let result = StepResult::new(
        meter_step.id().clone(),
        StepOutcome::Succeeded {
            output: output.clone(),
        },
    );

    assert_eq!(result.step_id(), meter_step.id());
    assert_eq!(
        result.outcome(),
        &StepOutcome::Succeeded {
            output: output.clone()
        }
    );
}

fn output_step(id: &str, name: &str, value: InputValue) -> Step {
    Step::new(
        StepId::new(id).unwrap(),
        StepKind::Output {
            name: name.to_owned(),
            value,
        },
    )
}

#[test]
fn named_outputs_project_in_workflow_order_and_ignore_other_steps() {
    let workflow = Workflow::new(vec![
        Step::new(
            StepId::new("wait").unwrap(),
            StepKind::Wait { duration_ms: 0 },
        ),
        output_step("read-voltage", "voltage", InputValue::Literal(json!(5))),
        Step::new(
            StepId::new("set-x").unwrap(),
            StepKind::SetVariable {
                variable: VariableId::new("x").unwrap(),
                value: InputValue::Literal(json!(9)),
            },
        ),
        output_step("check-passed", "passed", InputValue::Literal(json!(true))),
    ])
    .unwrap();
    let template = Template::new("Named outputs".to_owned(), Default::default(), workflow).unwrap();
    let restored = Template::from_json_str(&template.to_json_string().unwrap()).unwrap();
    assert_eq!(restored, template);
    let workflow = restored.workflow();
    let run = run_simulated_workflow(
        &template,
        &HashMap::new(),
        Duration::from_secs(5),
        Duration::from_secs(5),
        Duration::from_secs(5),
    )
    .unwrap();
    let mut results = run
        .step_executions()
        .iter()
        .map(|execution| execution.result().clone())
        .collect::<Vec<_>>();
    results.reverse();
    let outputs = workflow.project_outputs(&results).unwrap();
    assert_eq!(outputs.len(), 2);
    assert_eq!(outputs[0].name(), "voltage");
    assert_eq!(outputs[0].value(), &json!(5));
    assert_eq!(outputs[1].name(), "passed");
    assert_eq!(outputs[1].value(), &json!(true));
}

#[test]
fn invalid_and_duplicate_output_names_are_rejected() {
    for name in ["", " \t"] {
        assert!(matches!(
            Workflow::new(vec![output_step(
                "out",
                name,
                InputValue::Literal(json!(5))
            )]),
            Err(WorkflowError::InvalidOutputName(_))
        ));
    }
    assert!(matches!(Workflow::new(vec![
        output_step("first", "voltage", InputValue::Literal(json!(5))),
        output_step("second", "voltage", InputValue::Literal(json!(true))),
    ]), Err(WorkflowError::DuplicateOutputName(name)) if name == "voltage"));
}

#[test]
fn projection_rejects_missing_failed_and_cancelled_outputs() {
    let workflow = Workflow::new(vec![
        Step::new(
            StepId::new("set-x").unwrap(),
            StepKind::SetVariable {
                variable: VariableId::new("x").unwrap(),
                value: InputValue::Variable(VariableId::new("missing").unwrap()),
            },
        ),
        output_step(
            "out",
            "voltage",
            InputValue::Variable(VariableId::new("x").unwrap()),
        ),
    ])
    .unwrap();
    let run = run_simulated_workflow(
        &Template::new("Test".to_owned(), vec![], workflow.clone()).unwrap(),
        &HashMap::new(),
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
    assert_eq!(results.len(), 1);
    assert!(matches!(workflow.project_outputs(&results),
        Err(OutputProjectionError::MissingStepResult(id)) if id.as_str() == "out"));
    for outcome in [
        StepOutcome::Failed {
            message: "unresolved variable x".to_owned(),
        },
        StepOutcome::Cancelled,
    ] {
        let results = [StepResult::new(
            StepId::new("out").unwrap(),
            outcome.clone(),
        )];
        assert!(matches!(workflow.project_outputs(&results),
            Err(OutputProjectionError::UnsuccessfulStep { step_id, outcome: actual })
                if step_id.as_str() == "out" && actual == outcome));
    }
}

// Shared wire fixture also protects While template parsing and serialization.
fn while_wire(limit: usize, stop: usize) -> serde_json::Value {
    json!({
        "schema_version": 1, "name": "While counter", "tool_instances": [],
        "workflow": { "steps": [
            { "type": "set-variable", "id": "init", "variable": "x",
              "value": { "source": "literal", "value": 0 } },
            { "type": "while", "id": "repeat", "max_iterations": limit,
              "left": { "source": "variable", "variable": "x" }, "operator": "less-than",
              "right": { "source": "literal", "value": stop }, "steps": [
                { "type": "set-variable", "id": "increment", "variable": "x", "value": {
                    "source": "expression", "left": { "source": "variable", "variable": "x" },
                    "operator": "add", "right": { "source": "literal", "value": 1 } } },
                { "type": "output", "id": "out", "name": "x",
                  "value": { "source": "step-output", "step_id": "increment", "pointer": "" } }
              ] },
            { "type": "set-variable", "id": "after", "variable": "final",
              "value": { "source": "variable", "variable": "x" } }
        ] }
    })
}

fn execute_while_wire(
    wire: &serde_json::Value,
) -> (
    orchestrator_tool::workflow::WorkflowRunResult,
    Vec<orchestrator_tool::workflow::WorkflowRunEvent>,
) {
    let template = Template::from_json_str(&wire.to_string()).unwrap();
    let mut events = Vec::new();
    let result = orchestrator_tool::executor::execute_workflow_with_events(
        &template,
        &HashMap::new(),
        orchestrator_tool::run::ExecutionMode::Simulate,
        Duration::from_secs(1),
        |event| events.push(event),
    )
    .unwrap();
    (result, events)
}

#[test]
fn while_limits_round_trip_and_validate() {
    for limit in [json!(1000), json!(1), json!(null)] {
        let mut wire = while_wire(1000, 0);
        wire["workflow"]["steps"][1]["max_iterations"] = limit.clone();
        let template = Template::from_json_str(&wire.to_string()).unwrap();
        let serialized = template.to_json_string().unwrap();
        let saved: serde_json::Value = serde_json::from_str(&serialized).unwrap();
        assert_eq!(saved["workflow"]["steps"][1]["max_iterations"], limit);
        assert!(
            saved["workflow"]["steps"][1]
                .get("max_iterations")
                .is_some()
        );
        assert_eq!(Template::from_json_str(&serialized).unwrap(), template);
    }
}

#[test]
fn while_template_rejects_missing_max_iterations() {
    let mut wire = while_wire(1000, 0);
    wire["workflow"]["steps"][1]
        .as_object_mut()
        .unwrap()
        .remove("max_iterations");

    let error = Template::from_json_str(&wire.to_string()).unwrap_err();
    assert!(error.to_string().contains("max_iterations"));
}

#[test]
fn unlimited_while_false_condition_runs_no_iterations() {
    let mut wire = while_wire(1, 0);
    wire["workflow"]["steps"][1]["max_iterations"] = json!(null);
    let (run, _) = execute_while_wire(&wire);
    assert_eq!(run.step_executions().len(), 3);
    assert!(run.result_rows().is_empty());
    assert!(
        run.step_executions()
            .iter()
            .all(|execution| matches!(execution.outcome(), StepOutcome::Succeeded { .. }))
    );
}

#[test]
fn unlimited_while_stops_after_two_committed_iterations() {
    use orchestrator_tool::workflow::WorkflowRunEvent;
    use std::cell::Cell;
    let mut wire = while_wire(1, 1);
    wire["workflow"]["steps"][1]["max_iterations"] = json!(null);
    wire["workflow"]["steps"][1]["left"] = json!({ "source": "literal", "value": 0 });
    let template = Template::from_json_str(&wire.to_string()).unwrap();
    let commits = Cell::new(0);
    let mut stop_checks = 0;
    let run = orchestrator_tool::executor::execute_workflow_with_loop_stop(
        &template,
        &HashMap::new(),
        orchestrator_tool::run::ExecutionMode::Simulate,
        Duration::from_secs(1),
        |event| {
            if matches!(event, WorkflowRunEvent::ResultRowCommitted(_)) {
                commits.set(commits.get() + 1);
            }
        },
        |id| {
            assert_eq!(id.as_str(), "repeat");
            stop_checks += 1;
            assert_eq!(commits.get(), stop_checks);
            stop_checks == 2
        },
    )
    .unwrap();
    assert_eq!(stop_checks, 2);
    assert_eq!(run.result_rows().len(), 2);
    for (index, row) in run.result_rows().iter().enumerate() {
        assert_eq!(row.while_iteration().unwrap().iteration_index(), index);
        assert_eq!(row.outputs()[0].value(), &json!((index + 1) as f64));
    }
    assert!(
        run.step_executions()
            .iter()
            .all(|execution| matches!(execution.outcome(), StepOutcome::Succeeded { .. }))
    );
    assert_eq!(
        run.step_executions().last().unwrap().step_id().as_str(),
        "after"
    );
}

#[test]
fn while_commits_successful_iterations_and_orders_progress() {
    use orchestrator_tool::workflow::WorkflowRunEvent;
    let wire = while_wire(10, 3);
    let template = Template::from_json_str(&wire.to_string()).unwrap();
    assert_eq!(
        Template::from_json_str(&template.to_json_string().unwrap()).unwrap(),
        template
    );
    let (run, events) = execute_while_wire(&wire);
    assert_eq!(run.step_executions().len(), 9);
    assert_eq!(run.result_rows().len(), 3);
    assert!(
        run.step_executions()
            .iter()
            .all(|e| matches!(e.outcome(), StepOutcome::Succeeded { .. }))
    );
    for (index, row) in run.result_rows().iter().enumerate() {
        assert_eq!(row.outputs()[0].value().as_f64(), Some((index + 1) as f64));
        let iteration = row.while_iteration().unwrap();
        assert_eq!(iteration.while_step_id().as_str(), "repeat");
        assert_eq!(iteration.iteration_index(), index);
        assert!(row.for_iteration().is_none());
        for offset in 0..2 {
            let execution = &run.step_executions()[1 + index * 2 + offset];
            assert_eq!(execution.while_iteration(), Some(iteration));
            assert!(execution.for_iteration().is_none());
            assert_eq!(
                events[1 + index * 3 + offset],
                WorkflowRunEvent::StepCompleted(execution.clone())
            );
        }
        assert_eq!(
            events[3 + index * 3],
            WorkflowRunEvent::ResultRowCommitted(row.clone())
        );
    }
    let aggregate = &run.step_executions()[7];
    assert_eq!(aggregate.step_id().as_str(), "repeat");
    assert_eq!(
        aggregate.outcome(),
        &StepOutcome::Succeeded {
            output: json!(null)
        }
    );
    assert!(aggregate.for_iteration().is_none() && aggregate.while_iteration().is_none());
    assert_eq!(
        events[10],
        WorkflowRunEvent::StepCompleted(aggregate.clone())
    );
    assert_eq!(events.len(), 12);
    assert_eq!(
        run.step_executions()[8].outcome(),
        &StepOutcome::Succeeded { output: json!(3.0) }
    );
}

#[test]
fn while_precondition_and_guard_allow_exactly_the_limit() {
    let (zero, _) = execute_while_wire(&while_wire(2, 0));
    assert_eq!(zero.step_executions().len(), 3);
    assert!(zero.result_rows().is_empty());
    assert!(
        zero.step_executions()
            .iter()
            .all(|e| matches!(e.outcome(), StepOutcome::Succeeded { .. }))
    );
    let (exact, _) = execute_while_wire(&while_wire(2, 2));
    assert_eq!(exact.result_rows().len(), 2);
    assert!(
        exact
            .step_executions()
            .iter()
            .all(|e| matches!(e.outcome(), StepOutcome::Succeeded { .. }))
    );
    let (limited, _) = execute_while_wire(&while_wire(2, 3));
    assert_eq!(limited.result_rows().len(), 2);
    assert_eq!(limited.step_executions().len(), 6);
    let aggregate = limited.step_executions().last().unwrap();
    assert_eq!(aggregate.step_id().as_str(), "repeat");
    assert!(
        matches!(aggregate.outcome(), StepOutcome::Failed { message }
        if message == "While reached max_iterations while condition is still true")
    );
    let mut unresolved = while_wire(2, 3);
    unresolved["workflow"]["steps"][1]["left"]["variable"] = json!("missing");
    let (failed, _) = execute_while_wire(&unresolved);
    assert_eq!(failed.step_executions().len(), 2);
    assert!(matches!(
        failed.step_executions()[1].outcome(),
        StepOutcome::Failed { .. }
    ));
    assert!(failed.result_rows().is_empty());
}

#[test]
fn while_failure_discards_only_the_current_staged_row() {
    use orchestrator_tool::workflow::WorkflowRunEvent;
    let mut wire = while_wire(10, 3);
    wire["workflow"]["steps"][1]["max_iterations"] = json!(null);
    wire["workflow"]["steps"][1]["steps"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "type": "assert", "id": "check", "left": { "source": "variable", "variable": "x" },
            "operator": "less-than", "right": { "source": "literal", "value": 2 }, "message": "stop"
        }));
    let (run, events) = execute_while_wire(&wire);
    assert_eq!(run.result_rows().len(), 1);
    assert_eq!(run.result_rows()[0].outputs()[0].value(), &json!(1.0));
    assert_eq!(run.step_executions().len(), 8);
    assert!(matches!(
        run.step_executions()[6].outcome(),
        StepOutcome::Failed { .. }
    ));
    assert!(matches!(
        run.step_executions()[7].outcome(),
        StepOutcome::Failed { .. }
    ));
    assert_eq!(
        events
            .iter()
            .filter(|e| matches!(e, WorkflowRunEvent::ResultRowCommitted(_)))
            .count(),
        1
    );
    assert_eq!(
        events.last(),
        Some(&WorkflowRunEvent::StepCompleted(
            run.step_executions()[7].clone()
        ))
    );
}

#[test]
fn while_validation_rejects_invalid_conditions_and_guards() {
    let base = while_wire(10, 3);
    for (field, value, diagnostic) in [
        ("operator", json!("add"), "comparison operator"),
        ("max_iterations", json!(0), "positive max_iterations"),
    ] {
        let mut wire = base.clone();
        wire["workflow"]["steps"][1][field] = value;
        assert!(
            Template::from_json_str(&wire.to_string())
                .unwrap_err()
                .to_string()
                .contains(diagnostic)
        );
    }
    let for_step = json!({ "type": "for", "id": "outer", "variable": "i",
        "range": { "start": "1", "stop": "2", "step": "1" }, "steps": [] });
    // Both loop kinds accept finite nesting.
    for (mut outer, inner) in [
        (for_step.clone(), base["workflow"]["steps"][1].clone()),
        (base["workflow"]["steps"][1].clone(), for_step),
    ] {
        outer["steps"] = json!([inner]);
        let mut wire = base.clone();
        wire["workflow"]["steps"] = json!([outer]);
        assert!(Template::from_json_str(&wire.to_string()).is_ok());
    }
}

#[test]
fn unlimited_while_rejects_empty_body_but_finite_while_allows_it() {
    let mut wire = while_wire(10, 0);
    wire["workflow"]["steps"][1]["steps"] = json!([]);
    assert!(Template::from_json_str(&wire.to_string()).is_ok());

    wire["workflow"]["steps"][1]["max_iterations"] = json!(null);
    let error = Template::from_json_str(&wire.to_string())
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("While step repeat") && error.contains("empty body"),
        "{error}"
    );
}

#[test]
fn while_step_output_scope_and_row_scope_follow_loop_boundaries() {
    let base = while_wire(3, 2);
    for (pointer, target) in [
        ("/workflow/steps/1/left", "increment"),
        ("/workflow/steps/1/steps/0/value", "out"),
        ("/workflow/steps/2/value", "increment"),
    ] {
        let mut wire = base.clone();
        *wire.pointer_mut(pointer).unwrap() =
            json!({ "source": "step-output", "step_id": target, "pointer": "" });
        assert!(
            Template::from_json_str(&wire.to_string())
                .unwrap_err()
                .to_string()
                .contains("not an earlier step")
        );
    }
    let mut wire = base.clone();
    wire["workflow"]["steps"][1]["right"] =
        json!({ "source": "step-output", "step_id": "init", "pointer": "" });
    assert!(Template::from_json_str(&wire.to_string()).is_ok());
    let mut root_output = base.clone();
    root_output["workflow"]["steps"].as_array_mut().unwrap().push(json!({
        "type": "output", "id": "root-output", "name": "root", "value": { "source": "literal", "value": 1 }
    }));
    assert!(
        Template::from_json_str(&root_output.to_string())
            .unwrap_err()
            .to_string()
            .contains("loop paths")
    );
    let mut two_scopes = base.clone();
    two_scopes["workflow"]["steps"].as_array_mut().unwrap().push(json!({
        "type": "for", "id": "sweep", "variable": "i",
        "range": { "start": "1", "stop": "2", "step": "1" }, "steps": [
            { "type": "output", "id": "out-i", "name": "i", "value": { "source": "variable", "variable": "i" } }
        ]
    }));
    assert!(
        Template::from_json_str(&two_scopes.to_string())
            .unwrap_err()
            .to_string()
            .contains("loop paths")
    );
    wire = base;
    wire["workflow"]["steps"][1]["steps"]
        .as_array_mut()
        .unwrap()
        .pop();
    let (no_outputs, _) = execute_while_wire(&wire);
    assert_eq!(no_outputs.result_rows().len(), 1);
    assert!(no_outputs.result_rows()[0].while_iteration().is_none());
}
