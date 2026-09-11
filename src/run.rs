use std::{collections::HashMap, error::Error, fmt, process::ExitStatus, time::Duration};

use crate::{
    adapters::powers::{PowersActionError, safe_off_all},
    executor::{WorkflowExecutionError, execute_workflow},
    template::Template,
    tool::ToolId,
    tool_instance::ToolInstanceId,
    worker::{
        WorkerLaunchSpec, WorkerSession, WorkerShutdownError, WorkerStartError, start_worker,
    },
    workflow::{StepOutcome, StepResult},
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
    template: &Template,
    execution_mode: ExecutionMode,
    launch_specs: &HashMap<ToolInstanceId, WorkerLaunchSpec>,
    startup_timeout: Duration,
    action_timeout: Duration,
    shutdown_timeout: Duration,
) -> Result<Vec<StepResult>, WorkflowRunError> {
    let referenced_instances = template
        .referenced_tool_instances()
        .into_iter()
        .filter(|instance| matches!(instance.tool.as_str(), "powers" | "meters"))
        .map(|instance| instance.id.clone())
        .collect::<Vec<_>>();
    let referenced_specs = referenced_instances
        .into_iter()
        .map(|instance| {
            let spec =
                launch_specs
                    .get(&instance)
                    .ok_or_else(|| WorkflowRunError::MissingLaunchSpec {
                        instance: instance.clone(),
                    })?;
            Ok((instance, spec))
        })
        .collect::<Result<Vec<_>, WorkflowRunError>>()?;

    let mut sessions = Vec::with_capacity(referenced_specs.len());
    for (instance, spec) in referenced_specs {
        match start_worker(spec, startup_timeout) {
            Ok(session) => sessions.push((instance, session)),
            Err(source) => {
                let cleanup = cleanup_powers(template, &sessions, execution_mode, action_timeout);
                let _ = shutdown_workers(sessions, shutdown_timeout);
                let startup = WorkflowRunError::WorkerStartup { instance, source };
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

    let session_refs: HashMap<ToolInstanceId, &WorkerSession> = sessions
        .iter()
        .map(|(instance, session)| (instance.clone(), session))
        .collect();
    let execution = execute_workflow(template, &session_refs, execution_mode, action_timeout);
    drop(session_refs);

    let cleanup = cleanup_powers(template, &sessions, execution_mode, action_timeout);
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
    template: &Template,
    launch_specs: &HashMap<ToolInstanceId, WorkerLaunchSpec>,
    startup_timeout: Duration,
    action_timeout: Duration,
    shutdown_timeout: Duration,
) -> Result<Vec<StepResult>, WorkflowRunError> {
    run_workflow(
        template,
        ExecutionMode::Simulate,
        launch_specs,
        startup_timeout,
        action_timeout,
        shutdown_timeout,
    )
}

fn cleanup_powers(
    template: &Template,
    sessions: &[(ToolInstanceId, WorkerSession)],
    execution_mode: ExecutionMode,
    timeout: Duration,
) -> Option<PowersActionError> {
    if execution_mode != ExecutionMode::Live {
        return None;
    }
    let mut first_error = None;
    for (id, session) in sessions {
        if template
            .tool_instances()
            .iter()
            .any(|instance| &instance.id == id && instance.tool == ToolId::powers())
        {
            let error = safe_off_all(session, timeout).err();
            if first_error.is_none() {
                first_error = error;
            }
        }
    }
    first_error
}

fn shutdown_workers(
    sessions: Vec<(ToolInstanceId, WorkerSession)>,
    shutdown_timeout: Duration,
) -> Option<WorkflowRunError> {
    let mut first_error = None;

    for (instance, session) in sessions {
        let error = match session.shutdown(shutdown_timeout) {
            Ok(status) if status.success() => None,
            Ok(status) => Some(WorkflowRunError::WorkerExit { instance, status }),
            Err(source) => Some(WorkflowRunError::WorkerShutdown { instance, source }),
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
        instance: ToolInstanceId,
    },
    WorkerStartup {
        instance: ToolInstanceId,
        source: WorkerStartError,
    },
    WorkflowExecution(WorkflowExecutionError),
    WorkerShutdown {
        instance: ToolInstanceId,
        source: WorkerShutdownError,
    },
    WorkerExit {
        instance: ToolInstanceId,
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
            Self::MissingLaunchSpec { instance } => {
                write!(
                    formatter,
                    "missing Worker launch spec for instance {instance}"
                )
            }
            Self::WorkerStartup { instance, source } => {
                write!(formatter, "{instance} Worker startup failed: {source}")
            }
            Self::WorkflowExecution(error) => {
                write!(formatter, "workflow execution failed: {error}")
            }
            Self::WorkerShutdown { instance, source } => {
                write!(formatter, "{instance} Worker shutdown failed: {source}")
            }
            Self::WorkerExit { instance, status } => {
                write!(formatter, "{instance} Worker exited with {status}")
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
        tool_instance::ToolInstanceId,
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
            &test_template(&workflow),
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
                target: ToolInstanceId::new("powers-1").unwrap(),
                action: ActionId::new("set-voltage").unwrap(),
                arguments: serde_json::json!({ "channel": 1, "voltage": 5.0 }),
                bindings: Default::default(),
            },
        )])
        .unwrap();

        let error = run_workflow(
            &test_template(&workflow),
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
