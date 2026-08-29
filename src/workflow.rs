use std::{collections::HashSet, error::Error, fmt};

use serde_json::Value;

use crate::tool::ToolId;

/// A validated, stable identifier for a workflow step.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct StepId(String);

impl StepId {
    /// Creates a step ID from a lowercase kebab-case string.
    pub fn new(value: impl AsRef<str>) -> Result<Self, InvalidStepId> {
        let value = value.as_ref();

        if is_valid_identifier(value) {
            Ok(Self(value.to_owned()))
        } else {
            Err(InvalidStepId)
        }
    }

    /// Returns the step ID as a string slice.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for StepId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// The supplied value is not a valid step ID.
#[derive(Debug)]
pub struct InvalidStepId;

impl fmt::Display for InvalidStepId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("step ID must match [a-z0-9]+(-[a-z0-9]+)*")
    }
}

impl Error for InvalidStepId {}

/// A validated identifier for a tool action.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ActionId(String);

impl ActionId {
    /// Creates an action ID from a lowercase kebab-case string.
    pub fn new(value: impl AsRef<str>) -> Result<Self, InvalidActionId> {
        let value = value.as_ref();

        if is_valid_identifier(value) {
            Ok(Self(value.to_owned()))
        } else {
            Err(InvalidActionId)
        }
    }

    /// Returns the action ID as a string slice.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ActionId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// The supplied value is not a valid action ID.
#[derive(Debug)]
pub struct InvalidActionId;

impl fmt::Display for InvalidActionId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("action ID must match [a-z0-9]+(-[a-z0-9]+)*")
    }
}

impl Error for InvalidActionId {}

/// A single step in a workflow.
#[derive(Clone, Debug, PartialEq)]
pub struct Step {
    id: StepId,
    kind: StepKind,
}

impl Step {
    /// Creates a workflow step.
    pub fn new(id: StepId, kind: StepKind) -> Self {
        Self { id, kind }
    }

    /// Returns the stable step ID.
    pub fn id(&self) -> &StepId {
        &self.id
    }

    /// Returns the step kind and its data.
    pub fn kind(&self) -> &StepKind {
        &self.kind
    }
}

/// The behavior represented by a workflow step.
#[derive(Clone, Debug, PartialEq)]
pub enum StepKind {
    Wait {
        duration_ms: u64,
    },
    ToolAction {
        tool: ToolId,
        action: ActionId,
        arguments: Value,
    },
}

/// An ordered, linear collection of workflow steps.
#[derive(Clone, Debug, PartialEq)]
pub struct Workflow {
    steps: Vec<Step>,
}

impl Workflow {
    /// Creates a workflow and rejects duplicate step IDs.
    pub fn new(steps: Vec<Step>) -> Result<Self, WorkflowError> {
        let mut seen = HashSet::new();

        for step in &steps {
            if !seen.insert(step.id()) {
                return Err(WorkflowError::DuplicateStepId(step.id().clone()));
            }
        }

        Ok(Self { steps })
    }

    /// Returns the steps in execution order.
    pub fn steps(&self) -> &[Step] {
        &self.steps
    }
}

/// Errors produced while constructing a workflow.
#[derive(Debug)]
pub enum WorkflowError {
    DuplicateStepId(StepId),
}

impl fmt::Display for WorkflowError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DuplicateStepId(step_id) => {
                write!(formatter, "duplicate workflow step ID {step_id}")
            }
        }
    }
}

impl Error for WorkflowError {}

fn is_valid_identifier(value: &str) -> bool {
    value.split('-').all(|segment| {
        !segment.is_empty()
            && segment
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{ActionId, Step, StepId, StepKind, Workflow, WorkflowError};
    use crate::tool::ToolId;

    #[test]
    fn workflow_preserves_linear_step_order() {
        let workflow = Workflow::new(vec![
            Step::new(
                StepId::new("wait-1").unwrap(),
                StepKind::Wait { duration_ms: 250 },
            ),
            Step::new(
                StepId::new("power-set-1").unwrap(),
                StepKind::ToolAction {
                    tool: ToolId::powers(),
                    action: ActionId::new("set-voltage").unwrap(),
                    arguments: json!({ "channel": 1, "voltage": 5.0 }),
                },
            ),
        ])
        .unwrap();

        assert_eq!(workflow.steps()[0].id().as_str(), "wait-1");
        assert_eq!(
            workflow.steps()[0].kind(),
            &StepKind::Wait { duration_ms: 250 }
        );
        assert_eq!(workflow.steps()[1].id().as_str(), "power-set-1");
        assert_eq!(
            workflow.steps()[1].kind(),
            &StepKind::ToolAction {
                tool: ToolId::powers(),
                action: ActionId::new("set-voltage").unwrap(),
                arguments: json!({ "channel": 1, "voltage": 5.0 }),
            }
        );
    }

    #[test]
    fn empty_workflow_is_allowed() {
        let workflow = Workflow::new(Vec::new()).unwrap();

        assert!(workflow.steps().is_empty());
    }

    #[test]
    fn duplicate_step_id_is_rejected() {
        let duplicate_id = StepId::new("wait-1").unwrap();
        let error = Workflow::new(vec![
            Step::new(duplicate_id.clone(), StepKind::Wait { duration_ms: 100 }),
            Step::new(duplicate_id.clone(), StepKind::Wait { duration_ms: 200 }),
        ])
        .unwrap_err();

        assert!(matches!(
            error,
            WorkflowError::DuplicateStepId(step_id) if step_id == duplicate_id
        ));
    }

    #[test]
    fn invalid_step_and_action_ids_are_rejected() {
        for value in ["", "Wait-1", "wait_1", "-wait", "wait-", "wait--1"] {
            assert!(StepId::new(value).is_err(), "{value:?} should be invalid");
        }

        for value in ["", "Output-On", "software_trigger"] {
            assert!(ActionId::new(value).is_err(), "{value:?} should be invalid");
        }
    }
}
