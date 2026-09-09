use std::{
    collections::{BTreeMap, HashMap},
    error::Error,
    fmt, thread,
    time::Duration,
};

use serde_json::Value;

use crate::{
    data_context::DataContext,
    run::ExecutionMode,
    tool::ToolId,
    worker::WorkerSession,
    workflow::{InputValue, StepKind, StepOutcome, StepResult, Workflow},
};

/// Errors that prevent a workflow from starting execution.
#[derive(Debug)]
pub enum WorkflowExecutionError {
    EmptyWorkflow,
}

impl fmt::Display for WorkflowExecutionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyWorkflow => write!(formatter, "workflow is empty"),
        }
    }
}

impl Error for WorkflowExecutionError {}

/// Executes a linear workflow sequentially with fail-fast semantics.
///
/// `sessions` must contain already-started `WorkerSession` references for
/// `powers` and `meters`. The executor does not start or shut down workers.
pub fn execute_workflow(
    workflow: &Workflow,
    sessions: &HashMap<ToolId, &WorkerSession>,
    execution_mode: ExecutionMode,
    action_timeout: Duration,
) -> Result<Vec<StepResult>, WorkflowExecutionError> {
    if workflow.steps().is_empty() {
        return Err(WorkflowExecutionError::EmptyWorkflow);
    }

    let mut data_context = DataContext::new();
    let mut results = Vec::new();

    for step in workflow.steps() {
        let outcome = match step.kind() {
            StepKind::SetVariable { variable, value } => match data_context.resolve(value) {
                Ok(output) => {
                    data_context.set_variable(variable.clone(), output.clone());
                    StepOutcome::Succeeded { output }
                }
                Err(error) => StepOutcome::Failed {
                    message: error.to_string(),
                },
            },
            StepKind::Output { value, .. } => match data_context.resolve(value) {
                Ok(output) => StepOutcome::Succeeded { output },
                Err(error) => StepOutcome::Failed {
                    message: error.to_string(),
                },
            },
            StepKind::Wait { duration_ms } => {
                if *duration_ms > 0 {
                    thread::sleep(Duration::from_millis(*duration_ms));
                }
                StepOutcome::Succeeded {
                    output: Value::Null,
                }
            }
            StepKind::ToolAction {
                tool,
                action,
                arguments,
                bindings,
            } => match resolve_tool_arguments(arguments, bindings, &data_context) {
                Ok(arguments) => dispatch_tool_action(
                    tool,
                    action,
                    &arguments,
                    sessions,
                    execution_mode,
                    action_timeout,
                ),
                Err(message) => StepOutcome::Failed { message },
            },
        };

        if let StepOutcome::Succeeded { output } = &outcome {
            data_context.set_step_output(step.id().clone(), output.clone());
        }

        let is_failed = matches!(outcome, StepOutcome::Failed { .. });
        results.push(StepResult::new(step.id().clone(), outcome));
        if is_failed {
            break;
        }
    }

    Ok(results)
}

fn resolve_tool_arguments(
    arguments: &Value,
    bindings: &BTreeMap<String, InputValue>,
    data_context: &DataContext,
) -> Result<Value, String> {
    let mut arguments = arguments.clone();
    if !bindings.is_empty() {
        let object = arguments
            .as_object_mut()
            .ok_or("tool action arguments must be a JSON object when bindings are present")?;
        for (key, input) in bindings {
            let value = data_context
                .resolve(input)
                .map_err(|error| error.to_string())?;
            object.insert(key.clone(), value);
        }
    }
    Ok(arguments)
}

fn dispatch_tool_action(
    tool: &ToolId,
    action: &crate::workflow::ActionId,
    arguments: &Value,
    sessions: &HashMap<ToolId, &WorkerSession>,
    execution_mode: ExecutionMode,
    timeout: Duration,
) -> StepOutcome {
    let is_powers = tool == &ToolId::powers();
    let is_meters = tool == &ToolId::meters();

    if !is_powers && !is_meters {
        return StepOutcome::Failed {
            message: format!("unsupported tool {tool}"),
        };
    }

    let Some(session) = sessions.get(tool) else {
        return StepOutcome::Failed {
            message: format!("missing WorkerSession for tool {tool}"),
        };
    };

    if is_powers {
        match crate::adapters::powers::run_action(
            session,
            action,
            arguments,
            execution_mode,
            timeout,
        ) {
            Ok(output) => StepOutcome::Succeeded { output },
            Err(error) => StepOutcome::Failed {
                message: error.to_string(),
            },
        }
    } else {
        match crate::adapters::meters::run_action(session, action, arguments, timeout) {
            Ok(output) => StepOutcome::Succeeded { output },
            Err(error) => StepOutcome::Failed {
                message: error.to_string(),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, time::Duration};

    use serde_json::json;

    use super::{WorkflowExecutionError, execute_workflow};
    use crate::{
        run::ExecutionMode,
        tool::ToolId,
        workflow::{
            ActionId, Expression, ExpressionOperand, ExpressionOperator, InputValue, Step, StepId,
            StepKind, StepOutcome, StepOutputReference, VariableId, Workflow,
        },
    };

    #[test]
    fn bindings_override_literal_arguments_using_runtime_data() {
        let mut context = crate::data_context::DataContext::new();
        let variable = VariableId::new("x").unwrap();
        let step_id = StepId::new("meter-read-1").unwrap();
        context.set_variable(variable.clone(), json!(5.0));
        context.set_step_output(step_id.clone(), json!({ "value": 3.3 }));
        let arguments = json!({ "channel": 1, "voltage": 0 });
        let mut bindings = [("voltage".to_owned(), InputValue::Variable(variable.clone()))].into();
        assert_eq!(
            super::resolve_tool_arguments(&arguments, &bindings, &context).unwrap(),
            json!({ "channel": 1, "voltage": 5.0 })
        );
        bindings.insert(
            "measured".to_owned(),
            InputValue::StepOutput(StepOutputReference::new(step_id, "/value")),
        );
        assert_eq!(
            super::resolve_tool_arguments(&arguments, &bindings, &context).unwrap(),
            json!({ "channel": 1, "voltage": 5.0, "measured": 3.3 })
        );
        assert_eq!(arguments, json!({ "channel": 1, "voltage": 0 }));
        bindings.insert(
            "voltage".to_owned(),
            InputValue::Expression(Expression::new(
                ExpressionOperand::Variable(variable),
                ExpressionOperator::Multiply,
                ExpressionOperand::Literal(json!(2)),
            )),
        );
        assert_eq!(
            super::resolve_tool_arguments(&arguments, &bindings, &context).unwrap(),
            json!({ "channel": 1, "voltage": 10.0, "measured": 3.3 })
        );
        assert_eq!(
            super::resolve_tool_arguments(&json!([1]), &Default::default(), &context).unwrap(),
            json!([1])
        );
    }

    #[test]
    fn binding_failures_stop_execution_before_dispatch() {
        for (arguments, expected) in [
            (json!({ "voltage": 0 }), "missing variable missing"),
            (
                json!([]),
                "tool action arguments must be a JSON object when bindings are present",
            ),
        ] {
            let workflow = Workflow::new(vec![
                Step::new(
                    StepId::new("power-set-1").unwrap(),
                    StepKind::ToolAction {
                        tool: ToolId::powers(),
                        action: ActionId::new("set-voltage").unwrap(),
                        arguments,
                        bindings: [(
                            "voltage".to_owned(),
                            InputValue::Variable(VariableId::new("missing").unwrap()),
                        )]
                        .into(),
                    },
                ),
                Step::new(
                    StepId::new("later").unwrap(),
                    StepKind::Output {
                        name: "output-1".to_owned(),
                        value: InputValue::Literal(json!(5.0)),
                    },
                ),
            ])
            .unwrap();
            let results = execute_workflow(
                &workflow,
                &HashMap::new(),
                ExecutionMode::Simulate,
                Duration::from_secs(5),
            )
            .unwrap();
            assert_eq!(results.len(), 1);
            assert_eq!(results[0].step_id().as_str(), "power-set-1");
            assert_eq!(
                results[0].outcome(),
                &StepOutcome::Failed {
                    message: expected.to_owned()
                }
            );
        }
    }

    #[test]
    fn variable_is_available_to_later_output() {
        let variable = VariableId::new("x").unwrap();
        let workflow = Workflow::new(vec![
            Step::new(
                StepId::new("set-x").unwrap(),
                StepKind::SetVariable {
                    variable: variable.clone(),
                    value: InputValue::Literal(json!(5.0)),
                },
            ),
            Step::new(
                StepId::new("output-x").unwrap(),
                StepKind::Output {
                    name: "output-2".to_owned(),
                    value: InputValue::Variable(variable),
                },
            ),
        ])
        .unwrap();
        let results = execute_workflow(
            &workflow,
            &HashMap::new(),
            ExecutionMode::Simulate,
            Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(results.len(), 2);
        for result in results {
            assert_eq!(
                result.outcome(),
                &StepOutcome::Succeeded { output: json!(5.0) }
            );
        }
    }

    #[test]
    fn successful_step_output_is_available_to_later_output() {
        let step_id = StepId::new("set-x").unwrap();
        let workflow = Workflow::new(vec![
            Step::new(
                step_id.clone(),
                StepKind::SetVariable {
                    variable: VariableId::new("x").unwrap(),
                    value: InputValue::Literal(json!(5.0)),
                },
            ),
            Step::new(
                StepId::new("output-x").unwrap(),
                StepKind::Output {
                    name: "output-3".to_owned(),
                    value: InputValue::StepOutput(StepOutputReference::new(step_id, "")),
                },
            ),
        ])
        .unwrap();
        let results = execute_workflow(
            &workflow,
            &HashMap::new(),
            ExecutionMode::Simulate,
            Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(results.len(), 2);
        for result in results {
            assert_eq!(
                result.outcome(),
                &StepOutcome::Succeeded { output: json!(5.0) }
            );
        }
    }

    #[test]
    fn expressions_use_sequential_variable_results() {
        let variable = VariableId::new("x").unwrap();
        let doubled = VariableId::new("doubled").unwrap();
        let workflow = Workflow::new(vec![
            Step::new(
                StepId::new("set-x").unwrap(),
                StepKind::SetVariable {
                    variable: variable.clone(),
                    value: InputValue::Literal(json!(5.0)),
                },
            ),
            Step::new(
                StepId::new("set-doubled").unwrap(),
                StepKind::SetVariable {
                    variable: doubled.clone(),
                    value: InputValue::Expression(Expression::new(
                        ExpressionOperand::Variable(variable),
                        ExpressionOperator::Multiply,
                        ExpressionOperand::Literal(json!(2)),
                    )),
                },
            ),
            Step::new(
                StepId::new("output-result").unwrap(),
                StepKind::Output {
                    name: "output-4".to_owned(),
                    value: InputValue::Expression(Expression::new(
                        ExpressionOperand::Variable(doubled),
                        ExpressionOperator::Add,
                        ExpressionOperand::Literal(json!(1)),
                    )),
                },
            ),
        ])
        .unwrap();
        let results = execute_workflow(
            &workflow,
            &HashMap::new(),
            ExecutionMode::Simulate,
            Duration::from_secs(5),
        )
        .unwrap();

        assert_eq!(results.len(), 3);
        for (result, (step_id, expected)) in results.iter().zip([
            ("set-x", 5.0),
            ("set-doubled", 10.0),
            ("output-result", 11.0),
        ]) {
            assert_eq!(result.step_id().as_str(), step_id);
            assert_eq!(
                result.outcome(),
                &StepOutcome::Succeeded {
                    output: json!(expected)
                }
            );
        }
    }

    #[test]
    fn resolution_failure_stops_later_steps() {
        let workflow = Workflow::new(vec![
            Step::new(
                StepId::new("missing-output").unwrap(),
                StepKind::Output {
                    name: "output-5".to_owned(),
                    value: InputValue::Variable(VariableId::new("missing").unwrap()),
                },
            ),
            Step::new(
                StepId::new("later-output").unwrap(),
                StepKind::Output {
                    name: "output-6".to_owned(),
                    value: InputValue::Literal(json!(5.0)),
                },
            ),
        ])
        .unwrap();
        let results = execute_workflow(
            &workflow,
            &HashMap::new(),
            ExecutionMode::Simulate,
            Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].step_id().as_str(), "missing-output");
        assert_eq!(
            results[0].outcome(),
            &StepOutcome::Failed {
                message: "missing variable missing".to_owned()
            }
        );
    }

    #[test]
    fn empty_workflow_is_rejected_for_execution() {
        let workflow = Workflow::new(Vec::new()).unwrap();
        let sessions = HashMap::new();
        let error = execute_workflow(
            &workflow,
            &sessions,
            ExecutionMode::Simulate,
            Duration::from_secs(5),
        )
        .unwrap_err();
        assert!(matches!(error, WorkflowExecutionError::EmptyWorkflow));
    }

    #[test]
    fn executor_preserves_order_and_stops_after_failed_step() {
        let workflow = Workflow::new(vec![
            Step::new(
                StepId::new("wait-1").unwrap(),
                StepKind::Wait { duration_ms: 0 },
            ),
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
                StepId::new("wait-2").unwrap(),
                StepKind::Wait { duration_ms: 0 },
            ),
        ])
        .unwrap();

        let sessions = HashMap::new();
        let results = execute_workflow(
            &workflow,
            &sessions,
            ExecutionMode::Simulate,
            Duration::from_secs(5),
        )
        .unwrap();

        assert_eq!(results.len(), 2);
        assert_eq!(results[0].step_id().as_str(), "wait-1");
        assert_eq!(
            results[0].outcome(),
            &StepOutcome::Succeeded {
                output: serde_json::Value::Null
            }
        );
        assert_eq!(results[1].step_id().as_str(), "power-set-1");
        assert!(
            matches!(results[1].outcome(), StepOutcome::Failed { message } if message.contains("powers") || message.contains("session"))
        );
        // wait-2 must not have executed
        assert!(!results.iter().any(|r| r.step_id().as_str() == "wait-2"));
    }
}
