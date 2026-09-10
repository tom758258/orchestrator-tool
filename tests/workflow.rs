use std::{collections::HashMap, time::Duration};

use orchestrator_tool::{
    run::run_simulated_workflow,
    template::Template,
    tool::ToolId,
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
            "instrument_setup": {"meters": null},
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
    let results = run_simulated_workflow(
        template.workflow(),
        &HashMap::new(),
        Duration::from_secs(5),
        Duration::from_secs(5),
        Duration::from_secs(5),
    )
    .unwrap();

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
                tool: ToolId::powers(),
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
                tool: ToolId::meters(),
                action: ActionId::new("measure").unwrap(),
                arguments: json!({}),
                bindings: Default::default(),
            },
        ),
    ])
    .unwrap();

    let template = Template::new(
        "Workflow Integration".to_owned(),
        serde_json::from_value(json!({"meters": {
            "measurement": "voltage-dc", "range_mode": "auto", "manual_range": null,
            "nplc": 1.0, "auto_zero": "on", "dcv_input_impedance": null,
            "current_terminal": null
        }}))
        .unwrap(),
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
    let mut results = run_simulated_workflow(
        workflow,
        &HashMap::new(),
        Duration::from_secs(5),
        Duration::from_secs(5),
        Duration::from_secs(5),
    )
    .unwrap();
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
    let results = run_simulated_workflow(
        &workflow,
        &HashMap::new(),
        Duration::from_secs(5),
        Duration::from_secs(5),
        Duration::from_secs(5),
    )
    .unwrap();
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
