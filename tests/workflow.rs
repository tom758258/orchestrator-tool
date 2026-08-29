use orchestrator_tool::{
    template::Template,
    tool::ToolId,
    workflow::{ActionId, Step, StepId, StepKind, StepOutcome, StepResult, Workflow},
};
use serde_json::json;

#[test]
fn workflow_template_step_result_integration() {
    let workflow = Workflow::new(vec![
        Step::new(
            StepId::new("power-set-1").unwrap(),
            StepKind::ToolAction {
                tool: ToolId::powers(),
                action: ActionId::new("set-voltage").unwrap(),
                arguments: json!({ "channel": 1, "voltage": 5.0 }),
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
            },
        ),
    ])
    .unwrap();

    let template = Template::new("P9-D Integration".to_owned(), workflow);
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
