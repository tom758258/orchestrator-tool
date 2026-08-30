use std::{collections::HashMap, error::Error, fmt, thread, time::Duration};

use serde_json::Value;

use crate::{
    tool::ToolId,
    worker::WorkerSession,
    workflow::{StepKind, StepOutcome, StepResult, Workflow},
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
    action_timeout: Duration,
) -> Result<Vec<StepResult>, WorkflowExecutionError> {
    if workflow.steps().is_empty() {
        return Err(WorkflowExecutionError::EmptyWorkflow);
    }

    let mut results = Vec::new();

    for step in workflow.steps() {
        let outcome = match step.kind() {
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
            } => dispatch_tool_action(tool, action, arguments, sessions, action_timeout),
        };

        let is_failed = matches!(outcome, StepOutcome::Failed { .. });
        results.push(StepResult::new(step.id().clone(), outcome));
        if is_failed {
            break;
        }
    }

    Ok(results)
}

fn dispatch_tool_action(
    tool: &ToolId,
    action: &crate::workflow::ActionId,
    arguments: &Value,
    sessions: &HashMap<ToolId, &WorkerSession>,
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
        match crate::adapters::powers::run_action(session, action, arguments, timeout) {
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
        tool::ToolId,
        workflow::{ActionId, Step, StepId, StepKind, StepOutcome, Workflow},
    };

    #[test]
    fn empty_workflow_is_rejected_for_execution() {
        let workflow = Workflow::new(Vec::new()).unwrap();
        let sessions = HashMap::new();
        let error = execute_workflow(&workflow, &sessions, Duration::from_secs(5)).unwrap_err();
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
                },
            ),
            Step::new(
                StepId::new("wait-2").unwrap(),
                StepKind::Wait { duration_ms: 0 },
            ),
        ])
        .unwrap();

        let sessions = HashMap::new();
        let results = execute_workflow(&workflow, &sessions, Duration::from_secs(5)).unwrap();

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
