use std::{collections::HashMap, error::Error, fmt, process::ExitStatus, time::Duration};

use crate::{
    executor::{WorkflowExecutionError, execute_workflow},
    tool::ToolId,
    worker::{
        WorkerLaunchSpec, WorkerSession, WorkerShutdownError, WorkerStartError, start_worker,
    },
    workflow::{StepKind, StepResult, Workflow},
};

/// Runs a workflow while managing its referenced supported simulate Workers.
pub fn run_simulated_workflow(
    workflow: &Workflow,
    launch_specs: &HashMap<ToolId, WorkerLaunchSpec>,
    startup_timeout: Duration,
    action_timeout: Duration,
    shutdown_timeout: Duration,
) -> Result<Vec<StepResult>, SimulatedRunError> {
    let referenced_tools = referenced_supported_tools(workflow);
    let referenced_specs = referenced_tools
        .into_iter()
        .map(|tool| {
            let spec = launch_specs
                .get(&tool)
                .ok_or_else(|| SimulatedRunError::MissingLaunchSpec { tool: tool.clone() })?;
            Ok((tool, spec))
        })
        .collect::<Result<Vec<_>, SimulatedRunError>>()?;

    let mut sessions = Vec::with_capacity(referenced_specs.len());
    for (tool, spec) in referenced_specs {
        match start_worker(spec, startup_timeout) {
            Ok(session) => sessions.push((tool, session)),
            Err(source) => {
                let _ = shutdown_workers(sessions, shutdown_timeout);
                return Err(SimulatedRunError::WorkerStartup { tool, source });
            }
        }
    }

    let session_refs: HashMap<ToolId, &WorkerSession> = sessions
        .iter()
        .map(|(tool, session)| (tool.clone(), session))
        .collect();
    let execution = execute_workflow(workflow, &session_refs, action_timeout);
    drop(session_refs);

    let shutdown_error = shutdown_workers(sessions, shutdown_timeout);
    match (execution, shutdown_error) {
        (Err(error), _) => Err(SimulatedRunError::WorkflowExecution(error)),
        (Ok(_), Some(error)) => Err(error),
        (Ok(results), None) => Ok(results),
    }
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

fn shutdown_workers(
    sessions: Vec<(ToolId, WorkerSession)>,
    shutdown_timeout: Duration,
) -> Option<SimulatedRunError> {
    let mut first_error = None;

    for (tool, session) in sessions {
        let error = match session.shutdown(shutdown_timeout) {
            Ok(status) if status.success() => None,
            Ok(status) => Some(SimulatedRunError::WorkerExit { tool, status }),
            Err(source) => Some(SimulatedRunError::WorkerShutdown { tool, source }),
        };
        if first_error.is_none() {
            first_error = error;
        }
    }

    first_error
}

/// Errors produced while managing a simulated workflow run.
#[derive(Debug)]
pub enum SimulatedRunError {
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

impl fmt::Display for SimulatedRunError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingLaunchSpec { tool } => {
                write!(
                    formatter,
                    "missing simulate Worker launch spec for tool {tool}"
                )
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

impl Error for SimulatedRunError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::WorkerStartup { source, .. } => Some(source),
            Self::WorkflowExecution(source) => Some(source),
            Self::WorkerShutdown { source, .. } => Some(source),
            Self::MissingLaunchSpec { .. } | Self::WorkerExit { .. } => None,
        }
    }
}
