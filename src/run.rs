use std::{collections::HashMap, error::Error, fmt, process::ExitStatus, time::Duration};

use crate::{
    adapters::powers::{PowersActionError, safe_off_all},
    executor::{
        WorkflowExecutionError, execute_workflow_streaming_with_loop_stop,
        execute_workflow_with_loop_stop,
    },
    template::Template,
    tool::ToolId,
    tool_instance::ToolInstanceId,
    worker::{
        WorkerLaunchSpec, WorkerSession, WorkerShutdownError, WorkerStartError, start_worker,
    },
    workflow::{StepId, StepOutcome, WorkflowRunEvent, WorkflowRunResult, WorkflowRunSummary},
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
) -> Result<WorkflowRunResult, WorkflowRunError> {
    run_workflow_with_events(
        template,
        execution_mode,
        launch_specs,
        startup_timeout,
        action_timeout,
        shutdown_timeout,
        |_| {},
    )
}

/// Observes workflow execution while preserving Worker cleanup and shutdown handling.
pub fn run_workflow_with_events(
    template: &Template,
    execution_mode: ExecutionMode,
    launch_specs: &HashMap<ToolInstanceId, WorkerLaunchSpec>,
    startup_timeout: Duration,
    action_timeout: Duration,
    shutdown_timeout: Duration,
    on_event: impl FnMut(WorkflowRunEvent),
) -> Result<WorkflowRunResult, WorkflowRunError> {
    run_workflow_with_loop_stop(
        template,
        execution_mode,
        launch_specs,
        startup_timeout,
        action_timeout,
        shutdown_timeout,
        on_event,
        |_| false,
    )
}

/// Runs with graceful loop stopping while preserving Worker cleanup and shutdown.
#[allow(clippy::too_many_arguments)]
pub fn run_workflow_with_loop_stop(
    template: &Template,
    execution_mode: ExecutionMode,
    launch_specs: &HashMap<ToolInstanceId, WorkerLaunchSpec>,
    startup_timeout: Duration,
    action_timeout: Duration,
    shutdown_timeout: Duration,
    on_event: impl FnMut(WorkflowRunEvent),
    should_stop_after_iteration: impl FnMut(&StepId) -> bool,
) -> Result<WorkflowRunResult, WorkflowRunError> {
    match run_workflow_internal(
        template,
        execution_mode,
        launch_specs,
        startup_timeout,
        action_timeout,
        shutdown_timeout,
        on_event,
        should_stop_after_iteration,
        true,
    )? {
        RunCompletion::Full(result) => Ok(result),
        RunCompletion::Streaming(_) => unreachable!(),
    }
}

/// Runs with graceful loop stopping while the caller retains results from events.
#[allow(clippy::too_many_arguments)]
pub fn run_workflow_streaming_with_loop_stop(
    template: &Template,
    execution_mode: ExecutionMode,
    launch_specs: &HashMap<ToolInstanceId, WorkerLaunchSpec>,
    startup_timeout: Duration,
    action_timeout: Duration,
    shutdown_timeout: Duration,
    on_event: impl FnMut(WorkflowRunEvent),
    should_stop_after_iteration: impl FnMut(&StepId) -> bool,
) -> Result<WorkflowRunSummary, WorkflowRunError> {
    match run_workflow_internal(
        template,
        execution_mode,
        launch_specs,
        startup_timeout,
        action_timeout,
        shutdown_timeout,
        on_event,
        should_stop_after_iteration,
        false,
    )? {
        RunCompletion::Streaming(summary) => Ok(summary),
        RunCompletion::Full(_) => unreachable!(),
    }
}

enum RunCompletion {
    Full(WorkflowRunResult),
    Streaming(WorkflowRunSummary),
}

impl RunCompletion {
    fn failure(&self) -> Option<String> {
        match self {
            Self::Streaming(summary) => summary.failure().map(str::to_owned),
            Self::Full(result) => result
                .step_executions()
                .iter()
                .find_map(step_execution_failure),
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn run_workflow_internal(
    template: &Template,
    execution_mode: ExecutionMode,
    launch_specs: &HashMap<ToolInstanceId, WorkerLaunchSpec>,
    startup_timeout: Duration,
    action_timeout: Duration,
    shutdown_timeout: Duration,
    mut on_event: impl FnMut(WorkflowRunEvent),
    mut should_stop_after_iteration: impl FnMut(&StepId) -> bool,
    retain_results: bool,
) -> Result<RunCompletion, WorkflowRunError> {
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
                    Some((instance, source)) => WorkflowRunError::SafetyCleanup {
                        instance,
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
    let execution = if retain_results {
        execute_workflow_with_loop_stop(
            template,
            &session_refs,
            execution_mode,
            action_timeout,
            &mut on_event,
            &mut should_stop_after_iteration,
        )
        .map(RunCompletion::Full)
    } else {
        execute_workflow_streaming_with_loop_stop(
            template,
            &session_refs,
            execution_mode,
            action_timeout,
            &mut on_event,
            &mut should_stop_after_iteration,
        )
        .map(RunCompletion::Streaming)
    };
    drop(session_refs);

    let cleanup = cleanup_powers(template, &sessions, execution_mode, action_timeout);
    let shutdown_error = shutdown_workers(sessions, shutdown_timeout);
    if let Some((instance, source)) = cleanup {
        let prior_failure = match &execution {
            Err(error) => Some(error.to_string()),
            Ok(results) => results.failure(),
        }
        .or_else(|| shutdown_error.as_ref().map(ToString::to_string));
        return Err(WorkflowRunError::SafetyCleanup {
            instance,
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

fn step_execution_failure(result: &crate::workflow::StepExecution) -> Option<String> {
    match result.outcome() {
        StepOutcome::Failed { message } => Some(match result.for_iteration() {
            Some(iteration) => format!(
                "step {} (For {} iteration {}) failed: {message}",
                result.step_id(),
                iteration.for_step_id(),
                iteration.iteration_index(),
            ),
            None => match result.while_iteration() {
                Some(iteration) => format!(
                    "step {} (While {} iteration {}) failed: {message}",
                    result.step_id(),
                    iteration.while_step_id(),
                    iteration.iteration_index()
                ),
                None => format!("step {} failed: {message}", result.step_id()),
            },
        }),
        _ => None,
    }
}

/// Runs a workflow while managing its referenced supported simulate Workers.
pub fn run_simulated_workflow(
    template: &Template,
    launch_specs: &HashMap<ToolInstanceId, WorkerLaunchSpec>,
    startup_timeout: Duration,
    action_timeout: Duration,
    shutdown_timeout: Duration,
) -> Result<WorkflowRunResult, WorkflowRunError> {
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
) -> Option<(ToolInstanceId, PowersActionError)> {
    if execution_mode != ExecutionMode::Live {
        return None;
    }
    let mut first_error = None;
    for (id, session) in sessions {
        if template
            .tool_instances()
            .iter()
            .any(|instance| &instance.id == id && instance.tool == ToolId::powers())
            && let Err(error) = safe_off_all(session, timeout)
            && first_error.is_none()
        {
            first_error = Some((id.clone(), error));
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
        instance: ToolInstanceId,
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
                instance,
                prior_failure,
                source,
            } => {
                if let Some(prior) = prior_failure {
                    write!(formatter, "{prior}; ")?;
                }
                write!(
                    formatter,
                    "{instance} Power safety cleanup failed: {source}"
                )
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

        let run = run_workflow(
            &test_template(&workflow),
            ExecutionMode::Simulate,
            &HashMap::new(),
            Duration::from_secs(5),
            Duration::from_secs(5),
            Duration::from_secs(5),
        )
        .unwrap();
        let results = run.step_executions();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].step_id().as_str(), "wait-1");
        assert_eq!(run.result_rows().len(), 1);
        assert!(run.result_rows()[0].outputs().is_empty());
        assert!(run.result_rows()[0].for_iteration().is_none());
        assert!(matches!(
            results[0].outcome(),
            StepOutcome::Succeeded { .. }
        ));
    }

    #[test]
    fn observer_panic_does_not_interrupt_workerless_run() {
        let workflow = Workflow::new(vec![
            Step::new(
                StepId::new("first").unwrap(),
                StepKind::Wait { duration_ms: 0 },
            ),
            Step::new(
                StepId::new("later").unwrap(),
                StepKind::Wait { duration_ms: 0 },
            ),
        ])
        .unwrap();
        let template = test_template(&workflow);
        let expected = run_workflow(
            &template,
            ExecutionMode::Simulate,
            &HashMap::new(),
            Duration::from_secs(5),
            Duration::from_secs(5),
            Duration::from_secs(5),
        )
        .unwrap();
        let mut observed = 0;
        let actual = super::run_workflow_with_events(
            &template,
            ExecutionMode::Simulate,
            &HashMap::new(),
            Duration::from_secs(5),
            Duration::from_secs(5),
            Duration::from_secs(5),
            |_| {
                observed += 1;
                panic!("observer unavailable");
            },
        )
        .unwrap();
        assert_eq!(actual, expected);
        assert_eq!(observed, 3);
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
