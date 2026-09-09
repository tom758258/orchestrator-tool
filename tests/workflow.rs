use std::{collections::HashMap, time::Duration};

use orchestrator_tool::{
    run::run_simulated_workflow,
    template::Template,
    tool::ToolId,
    workflow::{ActionId, Step, StepId, StepKind, StepOutcome, StepResult, Workflow},
};
use serde_json::json;

#[test]
fn comparison_expression_flows_through_simulated_workflow() {
    let template = Template::from_json_str(
        &json!({
            "schema_version": 1,
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

    let template = Template::new("Workflow Integration".to_owned(), workflow);
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
