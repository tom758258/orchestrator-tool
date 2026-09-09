use std::{collections::HashMap, error::Error, fmt, process::ExitStatus, time::Duration};

use crate::{
    adapters::powers::{PowersActionError, safe_off_all},
    executor::{WorkflowExecutionError, execute_workflow},
    tool::ToolId,
    worker::{
        WorkerLaunchSpec, WorkerSession, WorkerShutdownError, WorkerStartError, start_worker,
    },
    workflow::{StepKind, StepOutcome, StepResult, Workflow},
};

/// Runtime execution mode for a workflow run.
///
/// The mode is chosen by the caller at run time. It is never persisted in a
/// workflow, template, or configuration file.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExecutionMode {
    Simulate,
    Live,
}

impl fmt::Display for ExecutionMode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Simulate => formatter.write_str("simulate"),
            Self::Live => formatter.write_str("live"),
        }
    }
}

/// Runs a workflow while managing its referenced supported Workers.
pub fn run_workflow(
    workflow: &Workflow,
    execution_mode: ExecutionMode,
    launch_specs: &HashMap<ToolId, WorkerLaunchSpec>,
    startup_timeout: Duration,
    action_timeout: Duration,
    shutdown_timeout: Duration,
) -> Result<Vec<StepResult>, WorkflowRunError> {
    let referenced_tools = referenced_supported_tools(workflow);
    let referenced_specs = referenced_tools
        .into_iter()
        .map(|tool| {
            let spec = launch_specs
                .get(&tool)
                .ok_or_else(|| WorkflowRunError::MissingLaunchSpec { tool: tool.clone() })?;
            Ok((tool, spec))
        })
        .collect::<Result<Vec<_>, WorkflowRunError>>()?;

    let mut sessions = Vec::with_capacity(referenced_specs.len());
    for (tool, spec) in referenced_specs {
        match start_worker(spec, startup_timeout) {
            Ok(session) => sessions.push((tool, session)),
            Err(source) => {
                let cleanup = cleanup_power(&sessions, execution_mode, action_timeout);
                let _ = shutdown_workers(sessions, shutdown_timeout);
                let startup = WorkflowRunError::WorkerStartup { tool, source };
                return Err(match cleanup {
                    Some(source) => WorkflowRunError::SafetyCleanup {
                        prior_failure: Some(startup.to_string()),
                        source,
                    },
                    None => startup,
                });
            }
        }
    }

    let session_refs: HashMap<ToolId, &WorkerSession> = sessions
        .iter()
        .map(|(tool, session)| (tool.clone(), session))
        .collect();
    let execution = execute_workflow(workflow, &session_refs, execution_mode, action_timeout);
    drop(session_refs);

    let cleanup = cleanup_power(&sessions, execution_mode, action_timeout);
    let shutdown_error = shutdown_workers(sessions, shutdown_timeout);
    if let Some(source) = cleanup {
        let prior_failure = match &execution {
            Err(error) => Some(error.to_string()),
            Ok(results) => results.iter().find_map(|result| match result.outcome() {
                StepOutcome::Failed { message } => {
                    Some(format!("step {} failed: {message}", result.step_id()))
                }
                _ => None,
            }),
        }
        .or_else(|| shutdown_error.as_ref().map(ToString::to_string));
        return Err(WorkflowRunError::SafetyCleanup {
            prior_failure,
            source,
        });
    }
    match (execution, shutdown_error) {
        (Err(error), _) => Err(WorkflowRunError::WorkflowExecution(error)),
        (Ok(_), Some(error)) => Err(error),
        (Ok(results), None) => Ok(results),
    }
}

/// Runs a workflow while managing its referenced supported simulate Workers.
pub fn run_simulated_workflow(
    workflow: &Workflow,
    launch_specs: &HashMap<ToolId, WorkerLaunchSpec>,
    startup_timeout: Duration,
    action_timeout: Duration,
    shutdown_timeout: Duration,
) -> Result<Vec<StepResult>, WorkflowRunError> {
    run_workflow(
        workflow,
        ExecutionMode::Simulate,
        launch_specs,
        startup_timeout,
        action_timeout,
        shutdown_timeout,
    )
}

fn referenced_supported_tools(workflow: &Workflow) -> Vec<ToolId> {
    let mut tools = Vec::new();

    for step in workflow.steps() {
        let StepKind::ToolAction { tool, .. } = step.kind() else {
            continue;
        };
        if (tool == &ToolId::powers() || tool == &ToolId::meters()) && !tools.contains(tool) {
            tools.push(tool.clone());
        }
    }

    tools
}

fn cleanup_power(
    sessions: &[(ToolId, WorkerSession)],
    execution_mode: ExecutionMode,
    timeout: Duration,
) -> Option<PowersActionError> {
    if execution_mode != ExecutionMode::Live {
        return None;
    }
    sessions
        .iter()
        .find(|(tool, _)| tool == &ToolId::powers())
        .and_then(|(_, session)| safe_off_all(session, timeout).err())
}

fn shutdown_workers(
    sessions: Vec<(ToolId, WorkerSession)>,
    shutdown_timeout: Duration,
) -> Option<WorkflowRunError> {
    let mut first_error = None;

    for (tool, session) in sessions {
        let error = match session.shutdown(shutdown_timeout) {
            Ok(status) if status.success() => None,
            Ok(status) => Some(WorkflowRunError::WorkerExit { tool, status }),
            Err(source) => Some(WorkflowRunError::WorkerShutdown { tool, source }),
        };
        if first_error.is_none() {
            first_error = error;
        }
    }

    first_error
}

/// Errors produced while managing a workflow run.
#[derive(Debug)]
pub enum WorkflowRunError {
    SafetyCleanup {
        prior_failure: Option<String>,
        source: PowersActionError,
    },
    MissingLaunchSpec {
        tool: ToolId,
    },
    WorkerStartup {
        tool: ToolId,
        source: WorkerStartError,
    },
    WorkflowExecution(WorkflowExecutionError),
    WorkerShutdown {
        tool: ToolId,
        source: WorkerShutdownError,
    },
    WorkerExit {
        tool: ToolId,
        status: ExitStatus,
    },
}

impl fmt::Display for WorkflowRunError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SafetyCleanup {
                prior_failure,
                source,
            } => {
                if let Some(prior) = prior_failure {
                    write!(formatter, "{prior}; ")?;
                }
                write!(formatter, "Power safety cleanup failed: {source}")
            }
            Self::MissingLaunchSpec { tool } => {
                write!(formatter, "missing Worker launch spec for tool {tool}")
            }
            Self::WorkerStartup { tool, source } => {
                write!(formatter, "{tool} Worker startup failed: {source}")
            }
            Self::WorkflowExecution(error) => {
                write!(formatter, "workflow execution failed: {error}")
            }
            Self::WorkerShutdown { tool, source } => {
                write!(formatter, "{tool} Worker shutdown failed: {source}")
            }
            Self::WorkerExit { tool, status } => {
                write!(formatter, "{tool} Worker exited with {status}")
            }
        }
    }
}

impl Error for WorkflowRunError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::WorkerStartup { source, .. } => Some(source),
            Self::WorkflowExecution(source) => Some(source),
            Self::WorkerShutdown { source, .. } => Some(source),
            Self::SafetyCleanup { source, .. } => Some(source),
            Self::MissingLaunchSpec { .. } | Self::WorkerExit { .. } => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, time::Duration};

    use super::{ExecutionMode, WorkflowRunError, run_workflow};
    use crate::{
        tool::ToolId,
        workflow::{ActionId, Step, StepId, StepKind, StepOutcome, Workflow},
    };

    #[test]
    fn simulate_mode_runs_workerless_workflow() {
        let workflow = Workflow::new(vec![Step::new(
            StepId::new("wait-1").unwrap(),
            StepKind::Wait { duration_ms: 0 },
        )])
        .unwrap();

        let results = run_workflow(
            &workflow,
            ExecutionMode::Simulate,
            &HashMap::new(),
            Duration::from_secs(5),
            Duration::from_secs(5),
            Duration::from_secs(5),
        )
        .unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].step_id().as_str(), "wait-1");
        assert!(matches!(
            results[0].outcome(),
            StepOutcome::Succeeded { .. }
        ));
    }

    #[test]
    fn live_mode_requires_referenced_launch_specs() {
        let workflow = Workflow::new(vec![Step::new(
            StepId::new("power-set-1").unwrap(),
            StepKind::ToolAction {
                tool: ToolId::powers(),
                action: ActionId::new("set-voltage").unwrap(),
                arguments: serde_json::json!({ "channel": 1, "voltage": 5.0 }),
                bindings: Default::default(),
            },
        )])
        .unwrap();

        let error = run_workflow(
            &workflow,
            ExecutionMode::Live,
            &HashMap::new(),
            Duration::from_secs(5),
            Duration::from_secs(5),
            Duration::from_secs(5),
        )
        .unwrap_err();

        assert!(matches!(error, WorkflowRunError::MissingLaunchSpec { .. }));
        assert!(error.to_string().contains("missing Worker launch spec"));
    }
}
