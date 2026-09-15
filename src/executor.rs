use std::{
    collections::{BTreeMap, HashMap},
    error::Error,
    fmt, thread,
    time::Duration,
};

use rust_decimal::Decimal;
use serde_json::Value;

use crate::{
    data_context::DataContext,
    run::ExecutionMode,
    template::Template,
    tool::ToolId,
    tool_instance::ToolInstanceId,
    worker::WorkerSession,
    workflow::{
        ForIteration, InputValue, ResultRow, Step, StepExecution, StepId, StepKind, StepOutcome,
        StepResult, WhileIteration, WorkflowOutput, WorkflowRunEvent, WorkflowRunResult,
    },
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

/// Executes root steps and loop bodies sequentially with fail-fast semantics.
///
/// `sessions` must contain already-started `WorkerSession` references for
/// referenced Powers and Meters instances. The executor does not start or shut down workers.
pub fn execute_workflow(
    template: &Template,
    sessions: &HashMap<ToolInstanceId, &WorkerSession>,
    execution_mode: ExecutionMode,
    action_timeout: Duration,
) -> Result<WorkflowRunResult, WorkflowExecutionError> {
    execute_workflow_with_events(template, sessions, execution_mode, action_timeout, |_| {})
}

/// Observes completed executions and committed rows synchronously.
/// Observer panics that unwind are ignored so execution and safety cleanup can continue.
pub fn execute_workflow_with_events(
    template: &Template,
    sessions: &HashMap<ToolInstanceId, &WorkerSession>,
    execution_mode: ExecutionMode,
    action_timeout: Duration,
    on_event: impl FnMut(WorkflowRunEvent),
) -> Result<WorkflowRunResult, WorkflowExecutionError> {
    execute_workflow_with_loop_stop(
        template,
        sessions,
        execution_mode,
        action_timeout,
        on_event,
        |_| false,
    )
}

/// Checks graceful loop stop only after a successful body and its row commit.
pub fn execute_workflow_with_loop_stop(
    template: &Template,
    sessions: &HashMap<ToolInstanceId, &WorkerSession>,
    execution_mode: ExecutionMode,
    action_timeout: Duration,
    mut on_event: impl FnMut(WorkflowRunEvent),
    mut should_stop_after_iteration: impl FnMut(&StepId) -> bool,
) -> Result<WorkflowRunResult, WorkflowExecutionError> {
    let workflow = template.workflow();
    if workflow.steps().is_empty() {
        return Err(WorkflowExecutionError::EmptyWorkflow);
    }

    let mut data_context = DataContext::new();
    let mut root_results = Vec::new();
    let mut step_executions = Vec::new();
    let mut result_rows = Vec::new();
    let mut completed_successfully = true;
    let has_body_output = workflow.steps().iter().any(|step| {
        matches!(step.kind(), StepKind::For { body, .. } | StepKind::While { body, .. }
            if body.iter().any(|step| matches!(step.kind(), StepKind::Output { .. })))
    });

    for step in workflow.steps() {
        let outcome = if let StepKind::For {
            variable,
            range,
            body,
        } = step.kind()
        {
            let previous_value = data_context.variable(variable).cloned();
            let produces_rows = body
                .iter()
                .any(|step| matches!(step.kind(), StepKind::Output { .. }));
            // Keep every exit inside this closure so the loop binding is always restored below.
            let outcome = (|| {
                for iteration_index in 0..range.iteration_count() {
                    clear_body_step_outputs(body, &mut data_context);
                    let value = match range.value_at(iteration_index) {
                        Some(value) => match decimal_to_json_value(value) {
                            Ok(value) => value,
                            Err(message) => return StepOutcome::Failed { message },
                        },
                        None => {
                            return StepOutcome::Failed {
                                message: format!(
                                    "For range has no value at iteration {iteration_index}"
                                ),
                            };
                        }
                    };
                    data_context.set_variable(variable.clone(), value);
                    let occurrence = ForIteration::new(step.id().clone(), iteration_index);
                    let mut staged_outputs = Vec::new();
                    for body_step in body {
                        let outcome = execute_non_loop_step(
                            body_step,
                            template,
                            &mut data_context,
                            sessions,
                            execution_mode,
                            action_timeout,
                        );
                        if let StepOutcome::Succeeded { output } = &outcome {
                            data_context.set_step_output(body_step.id().clone(), output.clone());
                            if let StepKind::Output { name, .. } = body_step.kind() {
                                staged_outputs
                                    .push(WorkflowOutput::new(name.clone(), output.clone()));
                            }
                        }
                        let failure = match &outcome {
                            StepOutcome::Failed { message } => {
                                Some(format!("body step {} failed: {message}", body_step.id()))
                            }
                            _ => None,
                        };
                        step_executions.push(StepExecution::new(
                            StepResult::new(body_step.id().clone(), outcome),
                            Some(occurrence.clone()),
                        ));
                        notify_progress(
                            &mut on_event,
                            WorkflowRunEvent::StepCompleted(
                                step_executions.last().unwrap().clone(),
                            ),
                        );
                        if let Some(message) = failure {
                            return StepOutcome::Failed { message };
                        }
                    }
                    if produces_rows {
                        result_rows.push(ResultRow::new(staged_outputs, Some(occurrence)));
                        notify_progress(
                            &mut on_event,
                            WorkflowRunEvent::ResultRowCommitted(
                                result_rows.last().unwrap().clone(),
                            ),
                        );
                    }
                    if should_stop_after_iteration(step.id()) {
                        break;
                    }
                }
                StepOutcome::Succeeded {
                    output: Value::Null,
                }
            })();
            clear_body_step_outputs(body, &mut data_context);
            if let Some(value) = previous_value {
                data_context.set_variable(variable.clone(), value);
            } else {
                data_context.remove_variable(variable);
            }
            outcome
        } else if let StepKind::While {
            condition,
            max_iterations,
            body,
        } = step.kind()
        {
            let produces_rows = body
                .iter()
                .any(|step| matches!(step.kind(), StepKind::Output { .. }));
            let outcome = (|| {
                let mut iteration_index = 0;
                loop {
                    match data_context.resolve(&InputValue::Expression(condition.clone())) {
                        Ok(Value::Bool(false)) => {
                            return StepOutcome::Succeeded {
                                output: Value::Null,
                            };
                        }
                        Ok(Value::Bool(true)) => {}
                        Ok(_) => {
                            return StepOutcome::Failed {
                                message: "While condition must resolve to a boolean".to_owned(),
                            };
                        }
                        Err(error) => {
                            return StepOutcome::Failed {
                                message: error.to_string(),
                            };
                        }
                    }
                    if max_iterations.is_some_and(|limit| iteration_index >= limit) {
                        return StepOutcome::Failed {
                            message: "While reached max_iterations while condition is still true"
                                .to_owned(),
                        };
                    }
                    clear_body_step_outputs(body, &mut data_context);
                    let occurrence = WhileIteration::new(step.id().clone(), iteration_index);
                    let mut staged_outputs = Vec::new();
                    for body_step in body {
                        let outcome = execute_non_loop_step(
                            body_step,
                            template,
                            &mut data_context,
                            sessions,
                            execution_mode,
                            action_timeout,
                        );
                        if let StepOutcome::Succeeded { output } = &outcome {
                            data_context.set_step_output(body_step.id().clone(), output.clone());
                            if let StepKind::Output { name, .. } = body_step.kind() {
                                staged_outputs
                                    .push(WorkflowOutput::new(name.clone(), output.clone()));
                            }
                        }
                        let failure = match &outcome {
                            StepOutcome::Failed { message } => {
                                Some(format!("body step {} failed: {message}", body_step.id()))
                            }
                            _ => None,
                        };
                        step_executions.push(StepExecution::in_while(
                            StepResult::new(body_step.id().clone(), outcome),
                            occurrence.clone(),
                        ));
                        notify_progress(
                            &mut on_event,
                            WorkflowRunEvent::StepCompleted(
                                step_executions.last().unwrap().clone(),
                            ),
                        );
                        if let Some(message) = failure {
                            return StepOutcome::Failed { message };
                        }
                    }
                    if produces_rows {
                        result_rows.push(ResultRow::in_while(staged_outputs, occurrence));
                        notify_progress(
                            &mut on_event,
                            WorkflowRunEvent::ResultRowCommitted(
                                result_rows.last().unwrap().clone(),
                            ),
                        );
                    }
                    if should_stop_after_iteration(step.id()) {
                        return StepOutcome::Succeeded {
                            output: Value::Null,
                        };
                    }
                    iteration_index += 1;
                }
            })();
            clear_body_step_outputs(body, &mut data_context);
            outcome
        } else {
            execute_non_loop_step(
                step,
                template,
                &mut data_context,
                sessions,
                execution_mode,
                action_timeout,
            )
        };

        if let StepOutcome::Succeeded { output } = &outcome {
            data_context.set_step_output(step.id().clone(), output.clone());
        }
        let is_failed = matches!(outcome, StepOutcome::Failed { .. });
        let result = StepResult::new(step.id().clone(), outcome);
        step_executions.push(StepExecution::new(result.clone(), None));
        notify_progress(
            &mut on_event,
            WorkflowRunEvent::StepCompleted(step_executions.last().unwrap().clone()),
        );
        root_results.push(result);
        if is_failed {
            completed_successfully = false;
            break;
        }
    }

    if completed_successfully && !has_body_output {
        result_rows.push(ResultRow::new(
            workflow
                .project_outputs(&root_results)
                .expect("all validated workflow steps succeeded"),
            None,
        ));
        notify_progress(
            &mut on_event,
            WorkflowRunEvent::ResultRowCommitted(result_rows.last().unwrap().clone()),
        );
    }
    Ok(WorkflowRunResult::new(step_executions, result_rows))
}

fn notify_progress(on_event: &mut impl FnMut(WorkflowRunEvent), event: WorkflowRunEvent) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| on_event(event)));
}

// This is the sole boundary from exact range decimals to JSON runtime numbers.
fn decimal_to_json_value(value: Decimal) -> Result<Value, String> {
    value
        .to_string()
        .parse::<serde_json::Number>()
        .map(Value::Number)
        .map_err(|error| format!("cannot convert For value {value} to a JSON number: {error}"))
}

fn clear_body_step_outputs(body: &[Step], data_context: &mut DataContext) {
    for step in body {
        data_context.remove_step_output(step.id());
    }
}

fn execute_non_loop_step(
    step: &Step,
    template: &Template,
    data_context: &mut DataContext,
    sessions: &HashMap<ToolInstanceId, &WorkerSession>,
    execution_mode: ExecutionMode,
    action_timeout: Duration,
) -> StepOutcome {
    match step.kind() {
        StepKind::Assert { condition, message } => {
            match data_context.resolve(&InputValue::Expression(condition.clone())) {
                Ok(output) if output == Value::Bool(true) => StepOutcome::Succeeded { output },
                Ok(_) => StepOutcome::Failed {
                    message: if message.trim().is_empty() {
                        "Assertion failed.".to_owned()
                    } else {
                        message.clone()
                    },
                },
                Err(error) => StepOutcome::Failed {
                    message: error.to_string(),
                },
            }
        }
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
            target,
            action,
            arguments,
            bindings,
        } => match resolve_tool_arguments(arguments, bindings, data_context) {
            Ok(arguments) => dispatch_tool_action(
                template,
                target,
                action,
                &arguments,
                sessions,
                execution_mode,
                action_timeout,
            ),
            Err(message) => StepOutcome::Failed { message },
        },
        StepKind::For { .. } | StepKind::While { .. } => StepOutcome::Failed {
            message: "nested loop execution is not supported".to_owned(),
        },
    }
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
    template: &Template,
    target: &ToolInstanceId,
    action: &crate::workflow::ActionId,
    arguments: &Value,
    sessions: &HashMap<ToolInstanceId, &WorkerSession>,
    execution_mode: ExecutionMode,
    timeout: Duration,
) -> StepOutcome {
    let Some(instance) = template
        .tool_instances()
        .iter()
        .find(|instance| &instance.id == target)
    else {
        return StepOutcome::Failed {
            message: format!("unknown tool instance target {target}"),
        };
    };
    let tool = &instance.tool;
    let is_powers = tool == &ToolId::powers();
    let is_meters = tool == &ToolId::meters();

    if !is_powers && !is_meters {
        return StepOutcome::Failed {
            message: format!("unsupported tool {tool}"),
        };
    }

    let Some(session) = sessions.get(target) else {
        return StepOutcome::Failed {
            message: format!("missing WorkerSession for instance {target}"),
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

    use super::{WorkflowExecutionError, execute_workflow, execute_workflow_with_events};
    use crate::{
        run::ExecutionMode,
        tool_instance::ToolInstanceId,
        workflow::{
            ActionId, Expression, ExpressionOperand, ExpressionOperator, InputValue, Step, StepId,
            StepKind, StepOutcome, StepOutputReference, VariableId, Workflow, WorkflowRunEvent,
        },
    };

    fn graceful_stop_run(is_while: bool, fail_body: bool) {
        use std::cell::RefCell;
        let body = json!([
            { "type": "output", "id": "out", "name": "value",
              "value": { "source": "literal", "value": 42 } },
            { "type": "assert", "id": "body-last",
              "left": { "source": "literal", "value": if fail_body { 2 } else { 0 } },
              "operator": "less-than", "right": { "source": "literal", "value": 1 },
              "message": "body failed" }
        ]);
        let loop_step = if is_while {
            json!({ "type": "while", "id": "loop", "max_iterations": 1,
                "left": { "source": "literal", "value": 1 }, "operator": "greater-than-or-equal",
                "right": { "source": "literal", "value": 1 }, "steps": body })
        } else {
            json!({ "type": "for", "id": "loop", "variable": "x",
                "range": { "start": "1", "stop": "3", "step": "1" }, "steps": body })
        };
        let template = crate::template::Template::from_json_str(
            &json!({
                "schema_version": 1, "name": "Stop", "tool_instances": [],
                "workflow": { "steps": [loop_step,
                    { "type": "wait", "id": "root-later", "duration_ms": 0 },
                    { "type": "for", "id": "later-loop", "variable": "y",
                      "range": { "start": "1", "stop": "2", "step": "1" }, "steps": [
                        { "type": "wait", "id": "later-body", "duration_ms": 0 }
                      ] }
                ] }
            })
            .to_string(),
        )
        .unwrap();
        let target = RefCell::new(None);
        let events = RefCell::new(Vec::new());
        let run = super::execute_workflow_with_loop_stop(
            &template,
            &HashMap::new(),
            ExecutionMode::Simulate,
            Duration::from_secs(1),
            |event| {
                if matches!(&event, WorkflowRunEvent::StepCompleted(execution)
                    if execution.step_id().as_str() == "out")
                {
                    *target.borrow_mut() = Some("loop".to_owned());
                }
                events.borrow_mut().push(event);
            },
            |id| {
                if target.borrow().as_deref() != Some(id.as_str()) {
                    return false;
                }
                assert!(matches!(
                    events.borrow().last(),
                    Some(WorkflowRunEvent::ResultRowCommitted(_))
                ));
                target.borrow_mut().take();
                true
            },
        )
        .unwrap();
        let executions = run.step_executions();
        assert_eq!(executions[0].step_id().as_str(), "out");
        assert_eq!(executions[1].step_id().as_str(), "body-last");
        assert_eq!(executions[2].step_id().as_str(), "loop");
        if fail_body {
            assert_eq!(executions.len(), 3);
            assert!(run.result_rows().is_empty());
            assert!(matches!(
                executions[2].outcome(),
                StepOutcome::Failed { .. }
            ));
            assert_eq!(target.borrow().as_deref(), Some("loop"));
        } else {
            assert_eq!(run.result_rows().len(), 1);
            assert!(
                executions
                    .iter()
                    .all(|execution| matches!(execution.outcome(), StepOutcome::Succeeded { .. }))
            );
            assert_eq!(executions[3].step_id().as_str(), "root-later");
            assert_eq!(
                executions
                    .iter()
                    .filter(|execution| execution.step_id().as_str() == "later-body")
                    .count(),
                2
            );
            assert!(target.borrow().is_none());
        }
    }

    #[test]
    fn for_graceful_stop_commits_iteration_and_continues_root_steps() {
        graceful_stop_run(false, false);
    }

    #[test]
    fn while_graceful_stop_at_limit_commits_iteration_and_continues_root_steps() {
        graceful_stop_run(true, false);
    }

    #[test]
    fn graceful_stop_does_not_hide_body_failure_or_commit_partial_row() {
        graceful_stop_run(false, true);
        graceful_stop_run(true, true);
    }

    #[test]
    fn successful_flat_run_commits_one_ordered_root_row() {
        let variable = VariableId::new("x").unwrap();
        let workflow = Workflow::new(vec![
            Step::new(
                StepId::new("set-x").unwrap(),
                StepKind::SetVariable {
                    variable: variable.clone(),
                    value: InputValue::Literal(json!(5)),
                },
            ),
            Step::new(
                StepId::new("out-a").unwrap(),
                StepKind::Output {
                    name: "A".to_owned(),
                    value: InputValue::Variable(variable),
                },
            ),
            Step::new(
                StepId::new("out-b").unwrap(),
                StepKind::Output {
                    name: "B".to_owned(),
                    value: InputValue::Literal(json!(true)),
                },
            ),
        ])
        .unwrap();
        let mut events = Vec::new();
        let run = execute_workflow_with_events(
            &test_template(&workflow),
            &HashMap::new(),
            ExecutionMode::Simulate,
            Duration::from_secs(5),
            |event| events.push(event),
        )
        .unwrap();
        assert_eq!(run.step_executions().len(), 3);
        assert!(
            run.step_executions()
                .iter()
                .all(|execution| execution.for_iteration().is_none())
        );
        assert_eq!(run.result_rows().len(), 1);
        let row = &run.result_rows()[0];
        assert!(row.for_iteration().is_none());
        assert_eq!(
            row.outputs()
                .iter()
                .map(|output| (output.name(), output.value()))
                .collect::<Vec<_>>(),
            vec![("A", &json!(5)), ("B", &json!(true))]
        );
        let expected = run
            .step_executions()
            .iter()
            .cloned()
            .map(WorkflowRunEvent::StepCompleted)
            .chain(
                run.result_rows()
                    .iter()
                    .cloned()
                    .map(WorkflowRunEvent::ResultRowCommitted),
            )
            .collect::<Vec<_>>();
        assert_eq!(events, expected);
    }

    #[test]
    fn for_executes_all_iterations_with_stable_ids_and_completion_order() {
        let workflow = Workflow::new(vec![
            Step::new(
                StepId::new("sweep").unwrap(),
                StepKind::For {
                    variable: VariableId::new("x").unwrap(),
                    range: crate::workflow::NumericRange::new(1.into(), 3.into(), 1.into())
                        .unwrap(),
                    body: vec![Step::new(
                        StepId::new("body").unwrap(),
                        StepKind::Wait { duration_ms: 0 },
                    )],
                },
            ),
            Step::new(
                StepId::new("later").unwrap(),
                StepKind::Wait { duration_ms: 0 },
            ),
        ])
        .unwrap();
        let mut events = Vec::new();
        let run = execute_workflow_with_events(
            &test_template(&workflow),
            &HashMap::new(),
            ExecutionMode::Simulate,
            Duration::from_secs(5),
            |event| events.push(event),
        )
        .unwrap();
        let executions = run.step_executions();
        assert_eq!(executions.len(), 5);
        for (index, execution) in executions[..3].iter().enumerate() {
            assert_eq!(execution.step_id().as_str(), "body");
            let occurrence = execution.for_iteration().unwrap();
            assert_eq!(occurrence.for_step_id().as_str(), "sweep");
            assert_eq!(occurrence.iteration_index(), index);
            assert_eq!(
                execution.outcome(),
                &StepOutcome::Succeeded {
                    output: json!(null)
                }
            );
        }
        assert_eq!(executions[3].step_id().as_str(), "sweep");
        assert!(executions[3].for_iteration().is_none());
        assert_eq!(
            executions[3].outcome(),
            &StepOutcome::Succeeded {
                output: json!(null)
            }
        );
        assert_eq!(executions[4].step_id().as_str(), "later");
        assert!(executions[4].for_iteration().is_none());
        assert_eq!(run.result_rows().len(), 1);
        assert!(run.result_rows()[0].outputs().is_empty());
        assert!(run.result_rows()[0].for_iteration().is_none());
        let expected = run
            .step_executions()
            .iter()
            .cloned()
            .map(WorkflowRunEvent::StepCompleted)
            .chain(
                run.result_rows()
                    .iter()
                    .cloned()
                    .map(WorkflowRunEvent::ResultRowCommitted),
            )
            .collect::<Vec<_>>();
        assert_eq!(events, expected);
    }

    #[test]
    fn for_restores_loop_variable_and_preserves_run_wide_mutations_in_root_row() {
        let template = crate::template::Template::from_json_str(&json!({
            "schema_version": 1, "name": "For scope", "tool_instances": [],
            "workflow": { "steps": [
                { "type": "set-variable", "id": "set-x", "variable": "x",
                  "value": { "source": "literal", "value": 99 } },
                { "type": "set-variable", "id": "set-count", "variable": "count",
                  "value": { "source": "literal", "value": 0 } },
                { "type": "for", "id": "sweep", "variable": "x",
                  "range": { "start": "1", "stop": "3", "step": "1" }, "steps": [
                    { "type": "set-variable", "id": "increment", "variable": "count",
                      "value": { "source": "expression",
                        "left": { "source": "variable", "variable": "count" },
                        "operator": "add", "right": { "source": "literal", "value": 1 } } },
                    { "type": "assert", "id": "check-count",
                        "left": { "source": "variable", "variable": "count" },
                        "operator": "greater-than-or-equal",
                        "right": { "source": "variable", "variable": "x" }, "message": "Count must persist." }
                  ] },
                { "type": "output", "id": "out-x", "name": "x",
                  "value": { "source": "variable", "variable": "x" } },
                { "type": "output", "id": "out-count", "name": "count",
                  "value": { "source": "variable", "variable": "count" } },
                { "type": "set-variable", "id": "read-for", "variable": "aggregate",
                  "value": { "source": "step-output", "step_id": "sweep", "pointer": "" } }
            ] }
        }).to_string()).unwrap();
        let run = execute_workflow(
            &template,
            &HashMap::new(),
            ExecutionMode::Simulate,
            Duration::from_secs(5),
        )
        .unwrap();
        assert!(
            run.step_executions()
                .iter()
                .all(|execution| matches!(execution.outcome(), StepOutcome::Succeeded { .. }))
        );
        assert_eq!(
            run.step_executions().last().unwrap().outcome(),
            &StepOutcome::Succeeded {
                output: json!(null)
            }
        );
        assert_eq!(run.result_rows().len(), 1);
        let row = &run.result_rows()[0];
        assert!(row.for_iteration().is_none());
        assert_eq!(
            row.outputs()
                .iter()
                .map(|output| (output.name(), output.value()))
                .collect::<Vec<_>>(),
            vec![("x", &json!(99)), ("count", &json!(3.0))]
        );
    }

    #[test]
    fn for_binds_exact_decimal_values_and_commits_ordered_iteration_rows() {
        let template = crate::template::Template::from_json_str(&json!({
            "schema_version": 1, "name": "Decimal sweep", "tool_instances": [],
            "workflow": { "steps": [
                { "type": "set-variable", "id": "before", "variable": "baseline",
                  "value": { "source": "literal", "value": 42 } },
                { "type": "for", "id": "sweep", "variable": "voltage",
                  "range": { "start": "0", "stop": "0.3", "step": "0.1" }, "steps": [
                    { "type": "output", "id": "voltage-out", "name": "voltage",
                      "value": { "source": "variable", "variable": "voltage" } },
                    { "type": "output", "id": "sibling-out", "name": "sibling",
                      "value": { "source": "step-output", "step_id": "voltage-out", "pointer": "" } },
                    { "type": "output", "id": "root-out", "name": "baseline",
                      "value": { "source": "step-output", "step_id": "before", "pointer": "" } }
                  ] }
            ] }
        }).to_string()).unwrap();
        let run = execute_workflow(
            &template,
            &HashMap::new(),
            ExecutionMode::Simulate,
            Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(run.result_rows().len(), 4);
        for (index, (row, expected)) in run
            .result_rows()
            .iter()
            .zip([0.0, 0.1, 0.2, 0.3])
            .enumerate()
        {
            let occurrence = row.for_iteration().unwrap();
            assert_eq!(occurrence.for_step_id().as_str(), "sweep");
            assert_eq!(occurrence.iteration_index(), index);
            assert_eq!(
                row.outputs()
                    .iter()
                    .map(|output| output.name())
                    .collect::<Vec<_>>(),
                ["voltage", "sibling", "baseline"]
            );
            assert!(row.outputs()[0].value().is_number());
            assert_eq!(row.outputs()[0].value().as_f64(), Some(expected));
            assert_eq!(row.outputs()[1].value(), row.outputs()[0].value());
            assert_eq!(row.outputs()[2].value(), &json!(42));
        }
    }

    #[test]
    fn failed_for_iteration_discards_only_current_staged_row_and_stops_execution() {
        let template = crate::template::Template::from_json_str(
            &json!({
                "schema_version": 1, "name": "Failed sweep", "tool_instances": [],
                "workflow": { "steps": [
                    { "type": "for", "id": "sweep", "variable": "x",
                      "range": { "start": "1", "stop": "3", "step": "1" }, "steps": [
                        { "type": "output", "id": "out-x", "name": "x",
                          "value": { "source": "variable", "variable": "x" } },
                        { "type": "assert", "id": "check-x",
                            "left": { "source": "variable", "variable": "x" },
                            "operator": "less-than", "right": { "source": "literal", "value": 2 },
                          "message": "x must be below 2." },
                        { "type": "wait", "id": "body-later", "duration_ms": 0 }
                      ] },
                    { "type": "wait", "id": "root-later", "duration_ms": 0 }
                ] }
            })
            .to_string(),
        )
        .unwrap();
        let mut events = Vec::new();
        let run = execute_workflow_with_events(
            &template,
            &HashMap::new(),
            ExecutionMode::Simulate,
            Duration::from_secs(5),
            |event| events.push(event),
        )
        .unwrap();
        assert_eq!(run.result_rows().len(), 1);
        let row = &run.result_rows()[0];
        assert_eq!(row.outputs()[0].value(), &json!(1));
        assert_eq!(row.for_iteration().unwrap().for_step_id().as_str(), "sweep");
        assert_eq!(row.for_iteration().unwrap().iteration_index(), 0);
        let executions = run.step_executions();
        assert_eq!(
            executions
                .iter()
                .map(|execution| execution.step_id().as_str())
                .collect::<Vec<_>>(),
            [
                "out-x",
                "check-x",
                "body-later",
                "out-x",
                "check-x",
                "sweep"
            ]
        );
        assert_eq!(
            executions[3].outcome(),
            &StepOutcome::Succeeded { output: json!(2) }
        );
        assert_eq!(
            executions[4]
                .for_iteration()
                .unwrap()
                .for_step_id()
                .as_str(),
            "sweep"
        );
        assert_eq!(executions[4].for_iteration().unwrap().iteration_index(), 1);
        assert_eq!(
            executions[4].outcome(),
            &StepOutcome::Failed {
                message: "x must be below 2.".to_owned()
            }
        );
        assert!(executions[5].for_iteration().is_none());
        assert!(
            matches!(executions[5].outcome(), StepOutcome::Failed { message }
            if message.contains("check-x") && message.contains("x must be below 2."))
        );
        assert_eq!(
            events,
            vec![
                WorkflowRunEvent::StepCompleted(executions[0].clone()),
                WorkflowRunEvent::StepCompleted(executions[1].clone()),
                WorkflowRunEvent::StepCompleted(executions[2].clone()),
                WorkflowRunEvent::ResultRowCommitted(row.clone()),
                WorkflowRunEvent::StepCompleted(executions[3].clone()),
                WorkflowRunEvent::StepCompleted(executions[4].clone()),
                WorkflowRunEvent::StepCompleted(executions[5].clone()),
            ]
        );
    }

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
                        target: ToolInstanceId::new("powers-1").unwrap(),
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
            let run = execute_workflow(
                &test_template(&workflow),
                &HashMap::new(),
                ExecutionMode::Simulate,
                Duration::from_secs(5),
            )
            .unwrap();
            let results = run.step_executions();
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
        let run = execute_workflow(
            &test_template(&workflow),
            &HashMap::new(),
            ExecutionMode::Simulate,
            Duration::from_secs(5),
        )
        .unwrap();
        let results = run.step_executions();
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
        let run = execute_workflow(
            &test_template(&workflow),
            &HashMap::new(),
            ExecutionMode::Simulate,
            Duration::from_secs(5),
        )
        .unwrap();
        let results = run.step_executions();
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
        let run = execute_workflow(
            &test_template(&workflow),
            &HashMap::new(),
            ExecutionMode::Simulate,
            Duration::from_secs(5),
        )
        .unwrap();
        let results = run.step_executions();

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
        let run = execute_workflow(
            &test_template(&workflow),
            &HashMap::new(),
            ExecutionMode::Simulate,
            Duration::from_secs(5),
        )
        .unwrap();
        let results = run.step_executions();
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
    fn assert_success_stores_true_and_continues_in_both_modes() {
        let assertion_id = StepId::new("assert-1").unwrap();
        let template = crate::template::Template::new(
            "Assert".to_owned(),
            vec![],
            Workflow::new(vec![
                Step::new(
                    assertion_id.clone(),
                    StepKind::Assert {
                        condition: Expression::new(
                            ExpressionOperand::Literal(json!(0)),
                            ExpressionOperator::GreaterThanOrEqual,
                            ExpressionOperand::Literal(json!(0)),
                        ),
                        message: "Assertion failed.".to_owned(),
                    },
                ),
                Step::new(
                    StepId::new("output-1").unwrap(),
                    StepKind::Output {
                        name: "assert-result".to_owned(),
                        value: InputValue::StepOutput(StepOutputReference::new(assertion_id, "")),
                    },
                ),
            ])
            .unwrap(),
        )
        .unwrap();
        for mode in [ExecutionMode::Simulate, ExecutionMode::Live] {
            let run =
                execute_workflow(&template, &HashMap::new(), mode, Duration::from_secs(5)).unwrap();
            let results = run.step_executions();
            assert_eq!(results.len(), 2);
            for result in results {
                assert_eq!(
                    result.outcome(),
                    &StepOutcome::Succeeded {
                        output: json!(true)
                    }
                );
            }
        }
    }

    #[test]
    fn assert_false_uses_message_and_stops_later_steps() {
        for (message, expected) in [
            ("Voltage is below minimum.", "Voltage is below minimum."),
            ("", "Assertion failed."),
            ("  ", "Assertion failed."),
        ] {
            let workflow = Workflow::new(vec![
                Step::new(
                    StepId::new("assert-1").unwrap(),
                    StepKind::Assert {
                        condition: Expression::new(
                            ExpressionOperand::Literal(json!(4.8)),
                            ExpressionOperator::GreaterThanOrEqual,
                            ExpressionOperand::Literal(json!(4.9)),
                        ),
                        message: message.to_owned(),
                    },
                ),
                Step::new(
                    StepId::new("later").unwrap(),
                    StepKind::Wait { duration_ms: 0 },
                ),
            ])
            .unwrap();
            let run = execute_workflow(
                &test_template(&workflow),
                &HashMap::new(),
                ExecutionMode::Simulate,
                Duration::from_secs(5),
            )
            .unwrap();
            let results = run.step_executions();
            assert_eq!(results.len(), 1);
            assert_eq!(results[0].step_id().as_str(), "assert-1");
            assert!(run.result_rows().is_empty());
            assert_eq!(
                results[0].outcome(),
                &StepOutcome::Failed {
                    message: expected.to_owned()
                }
            );
        }
    }

    #[test]
    fn assert_resolution_errors_fail_without_running_later_steps() {
        for (left, expected) in [
            (
                ExpressionOperand::Variable(VariableId::new("missing").unwrap()),
                "missing variable missing",
            ),
            (
                ExpressionOperand::StepOutput(StepOutputReference::new(
                    StepId::new("prior").unwrap(),
                    "/absent",
                )),
                "missing step output target for step prior at JSON Pointer \"/absent\"",
            ),
            (
                ExpressionOperand::Literal(json!("5")),
                "expression operand must be a JSON number",
            ),
        ] {
            let workflow = Workflow::new(vec![
                Step::new(
                    StepId::new("prior").unwrap(),
                    StepKind::Wait { duration_ms: 0 },
                ),
                Step::new(
                    StepId::new("assert-1").unwrap(),
                    StepKind::Assert {
                        condition: Expression::new(
                            left,
                            ExpressionOperator::GreaterThan,
                            ExpressionOperand::Literal(json!(0)),
                        ),
                        message: "Do not hide the resolve error.".to_owned(),
                    },
                ),
                Step::new(
                    StepId::new("later").unwrap(),
                    StepKind::Wait { duration_ms: 0 },
                ),
            ])
            .unwrap();
            let run = execute_workflow(
                &test_template(&workflow),
                &HashMap::new(),
                ExecutionMode::Simulate,
                Duration::from_secs(5),
            )
            .unwrap();
            let results = run.step_executions();
            assert_eq!(results.len(), 2);
            assert_eq!(results[1].step_id().as_str(), "assert-1");
            assert_eq!(
                results[1].outcome(),
                &StepOutcome::Failed {
                    message: expected.to_owned()
                }
            );
        }
    }

    #[test]
    fn empty_workflow_is_rejected_for_execution() {
        let workflow = Workflow::new(Vec::new()).unwrap();
        let sessions = HashMap::new();
        let error = execute_workflow(
            &test_template(&workflow),
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
                    target: ToolInstanceId::new("powers-1").unwrap(),
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
        let run = execute_workflow(
            &test_template(&workflow),
            &sessions,
            ExecutionMode::Simulate,
            Duration::from_secs(5),
        )
        .unwrap();
        let results = run.step_executions();

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

    fn test_template(workflow: &Workflow) -> crate::template::Template {
        crate::template::Template::new(
            "Test".to_owned(),
            vec![crate::tool_instance::ToolInstance {
                id: crate::tool_instance::ToolInstanceId::new("powers-1").unwrap(),
                tool: crate::tool::ToolId::powers(),
                setup: Default::default(),
            }],
            workflow.clone(),
        )
        .unwrap()
    }
}
