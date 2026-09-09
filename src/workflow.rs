use std::{
    collections::{BTreeMap, HashSet},
    error::Error,
    fmt,
};

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

/// A validated identifier for a workflow variable.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct VariableId(String);

impl VariableId {
    /// Creates a variable ID from a lowercase kebab-case string.
    pub fn new(value: impl AsRef<str>) -> Result<Self, InvalidVariableId> {
        let value = value.as_ref();

        if is_valid_identifier(value) {
            Ok(Self(value.to_owned()))
        } else {
            Err(InvalidVariableId)
        }
    }

    /// Returns the variable ID as a string slice.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for VariableId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// The supplied value is not a valid variable ID.
#[derive(Debug)]
pub struct InvalidVariableId;

impl fmt::Display for InvalidVariableId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("variable ID must match [a-z0-9]+(-[a-z0-9]+)*")
    }
}

impl Error for InvalidVariableId {}

/// A reference to a value produced by a workflow step.
#[derive(Clone, Debug, PartialEq)]
pub struct StepOutputReference {
    step_id: StepId,
    pointer: String,
}

impl StepOutputReference {
    /// Creates a step output reference using JSON Pointer semantics.
    pub fn new(step_id: StepId, pointer: impl Into<String>) -> Self {
        Self {
            step_id,
            pointer: pointer.into(),
        }
    }

    /// Returns the referenced step ID.
    pub fn step_id(&self) -> &StepId {
        &self.step_id
    }

    /// Returns the JSON Pointer into the step output.
    pub fn pointer(&self) -> &str {
        &self.pointer
    }
}

/// A workflow input value and its source.
#[derive(Clone, Debug, PartialEq)]
pub enum InputValue {
    Literal(Value),
    Variable(VariableId),
    StepOutput(StepOutputReference),
    Expression(Expression),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Expression {
    left: ExpressionOperand,
    operator: ExpressionOperator,
    right: ExpressionOperand,
}

impl Expression {
    pub fn new(
        left: ExpressionOperand,
        operator: ExpressionOperator,
        right: ExpressionOperand,
    ) -> Self {
        Self {
            left,
            operator,
            right,
        }
    }

    pub fn left(&self) -> &ExpressionOperand {
        &self.left
    }

    pub fn operator(&self) -> ExpressionOperator {
        self.operator
    }

    pub fn right(&self) -> &ExpressionOperand {
        &self.right
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum ExpressionOperand {
    Literal(Value),
    Variable(VariableId),
    StepOutput(StepOutputReference),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExpressionOperator {
    Add,
    Subtract,
    Multiply,
    Divide,
    GreaterThan,
    GreaterThanOrEqual,
    LessThan,
    LessThanOrEqual,
}

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
    SetVariable {
        variable: VariableId,
        value: InputValue,
    },
    Output {
        value: InputValue,
    },
    Wait {
        duration_ms: u64,
    },
    ToolAction {
        tool: ToolId,
        action: ActionId,
        arguments: Value,
        /// Top-level inputs resolved at runtime, overriding literal arguments.
        bindings: BTreeMap<String, InputValue>,
    },
}

/// An ordered, linear collection of workflow steps.
#[derive(Clone, Debug, PartialEq)]
pub struct Workflow {
    steps: Vec<Step>,
}

impl Workflow {
    /// Creates a workflow with unique IDs and references only to earlier steps.
    pub fn new(steps: Vec<Step>) -> Result<Self, WorkflowError> {
        let mut seen = HashSet::new();

        for step in &steps {
            if seen.contains(step.id()) {
                return Err(WorkflowError::DuplicateStepId(step.id().clone()));
            }
            let validate_reference = |reference: &StepOutputReference| {
                if !seen.contains(reference.step_id()) {
                    return Err(WorkflowError::InvalidStepOutputReference {
                        step_id: step.id().clone(),
                        target: reference.step_id().clone(),
                    });
                }
                Ok(())
            };
            let validate_input = |input: &InputValue| {
                match input {
                    InputValue::StepOutput(reference) => validate_reference(reference)?,
                    InputValue::Expression(expression) => {
                        for operand in [expression.left(), expression.right()] {
                            if let ExpressionOperand::StepOutput(reference) = operand {
                                validate_reference(reference)?;
                            }
                        }
                    }
                    InputValue::Literal(_) | InputValue::Variable(_) => {}
                }
                Ok(())
            };
            match step.kind() {
                StepKind::SetVariable { value, .. } | StepKind::Output { value } => {
                    validate_input(value)?;
                }
                StepKind::ToolAction { bindings, .. } => {
                    for value in bindings.values() {
                        validate_input(value)?;
                    }
                }
                StepKind::Wait { .. } => {}
            }
            seen.insert(step.id());
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
    InvalidStepOutputReference { step_id: StepId, target: StepId },
}

impl fmt::Display for WorkflowError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidStepOutputReference { step_id, target } => write!(
                formatter,
                "step {step_id} references step {target}, but {target} is not an earlier step"
            ),
            Self::DuplicateStepId(step_id) => {
                write!(formatter, "duplicate workflow step ID {step_id}")
            }
        }
    }
}

impl Error for WorkflowError {}

/// The result of executing a single workflow step.
#[derive(Clone, Debug, PartialEq)]
pub struct StepResult {
    step_id: StepId,
    outcome: StepOutcome,
}

impl StepResult {
    /// Creates a step result.
    pub fn new(step_id: StepId, outcome: StepOutcome) -> Self {
        Self { step_id, outcome }
    }

    /// Returns the step ID associated with this result.
    pub fn step_id(&self) -> &StepId {
        &self.step_id
    }

    /// Returns the execution outcome.
    pub fn outcome(&self) -> &StepOutcome {
        &self.outcome
    }
}

/// The execution outcome of a workflow step.
#[derive(Clone, Debug, PartialEq)]
pub enum StepOutcome {
    Succeeded { output: Value },
    Failed { message: String },
    Cancelled,
}

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

    use super::{
        ActionId, Expression, ExpressionOperand, ExpressionOperator, InputValue, Step, StepId,
        StepKind, StepOutcome, StepOutputReference, StepResult, VariableId, Workflow,
        WorkflowError,
    };
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
                    bindings: Default::default(),
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
                bindings: Default::default(),
            }
        );
    }

    #[test]
    fn step_output_references_must_target_earlier_steps() {
        for target in ["current", "future", "missing"] {
            let value = InputValue::StepOutput(StepOutputReference::new(
                StepId::new(target).unwrap(),
                "/value",
            ));
            for kind in [
                StepKind::SetVariable {
                    variable: VariableId::new("x").unwrap(),
                    value: value.clone(),
                },
                StepKind::Output {
                    value: value.clone(),
                },
                StepKind::ToolAction {
                    tool: ToolId::powers(),
                    action: ActionId::new("set-voltage").unwrap(),
                    arguments: json!({}),
                    bindings: [("voltage".to_owned(), value.clone())].into(),
                },
            ] {
                let error = Workflow::new(vec![
                    Step::new(StepId::new("current").unwrap(), kind),
                    Step::new(
                        StepId::new("future").unwrap(),
                        StepKind::Wait { duration_ms: 0 },
                    ),
                ])
                .unwrap_err();
                assert_eq!(
                    error.to_string(),
                    format!(
                        "step current references step {target}, but {target} is not an earlier step"
                    )
                );
                assert!(matches!(error, WorkflowError::InvalidStepOutputReference {
                    step_id, target: referenced
                } if step_id.as_str() == "current" && referenced.as_str() == target));
            }
        }
    }

    #[test]
    fn empty_workflow_is_allowed() {
        let workflow = Workflow::new(Vec::new()).unwrap();

        assert!(workflow.steps().is_empty());
    }

    #[test]
    fn expression_step_output_references_must_target_earlier_steps() {
        let reference = ExpressionOperand::StepOutput(StepOutputReference::new(
            StepId::new("future").unwrap(),
            "/value",
        ));
        let literal = ExpressionOperand::Literal(json!(2));
        for (left, right) in [(reference.clone(), literal.clone()), (literal, reference)] {
            let current = Step::new(
                StepId::new("current").unwrap(),
                StepKind::Output {
                    value: InputValue::Expression(Expression::new(
                        left,
                        ExpressionOperator::Multiply,
                        right,
                    )),
                },
            );
            let future = Step::new(
                StepId::new("future").unwrap(),
                StepKind::Wait { duration_ms: 0 },
            );
            let error = Workflow::new(vec![current.clone(), future.clone()]).unwrap_err();
            assert!(matches!(error, WorkflowError::InvalidStepOutputReference {
                step_id, target
            } if step_id.as_str() == "current" && target.as_str() == "future"));
            assert!(Workflow::new(vec![future, current]).is_ok());
        }
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

    #[test]
    fn variable_id_validation_matches_existing_identifier_rule() {
        for value in ["x", "voltage", "target-voltage", "value1"] {
            assert!(VariableId::new(value).is_ok(), "{value:?} should be valid");
        }

        for value in [
            "",
            "X",
            "target_voltage",
            "-target",
            "target-",
            "target--voltage",
        ] {
            assert!(
                VariableId::new(value).is_err(),
                "{value:?} should be invalid"
            );
        }
    }

    #[test]
    fn input_value_variants_preserve_data() {
        let literal = json!({ "value": 5.0 });
        let variable_id = VariableId::new("target-voltage").unwrap();
        let step_id = StepId::new("meter-read-1").unwrap();
        let reference = StepOutputReference::new(step_id.clone(), "/data/samples/0/value");

        let values = [
            InputValue::Literal(literal.clone()),
            InputValue::Variable(variable_id.clone()),
            InputValue::StepOutput(reference.clone()),
        ];

        assert_eq!(values[0], InputValue::Literal(literal));
        assert_eq!(values[1], InputValue::Variable(variable_id));
        assert_eq!(values[2], InputValue::StepOutput(reference));

        if let InputValue::StepOutput(output_reference) = &values[2] {
            assert_eq!(output_reference.step_id(), &step_id);
            assert_eq!(output_reference.pointer(), "/data/samples/0/value");
        } else {
            panic!("expected a step output reference");
        }
    }

    #[test]
    fn arithmetic_expression_preserves_operands_and_operator() {
        let left = ExpressionOperand::Variable(VariableId::new("x").unwrap());
        let right = ExpressionOperand::Literal(json!(2));
        let expression = Expression::new(left.clone(), ExpressionOperator::Multiply, right.clone());

        assert_eq!(expression.left(), &left);
        assert_eq!(expression.operator(), ExpressionOperator::Multiply);
        assert_eq!(expression.right(), &right);
        assert!(matches!(
            InputValue::Expression(expression),
            InputValue::Expression(_)
        ));
    }

    #[test]
    fn comparison_expression_preserves_operands_and_operator() {
        let left = ExpressionOperand::StepOutput(StepOutputReference::new(
            StepId::new("measurement").unwrap(),
            "/value",
        ));
        let right = ExpressionOperand::Variable(VariableId::new("threshold").unwrap());
        let expression =
            Expression::new(left.clone(), ExpressionOperator::GreaterThan, right.clone());

        assert_eq!(expression.left(), &left);
        assert_eq!(expression.operator(), ExpressionOperator::GreaterThan);
        assert_eq!(expression.right(), &right);
    }

    #[test]
    fn step_result_succeeded_preserves_output() {
        let step_id = StepId::new("meter-read-1").unwrap();
        let output = json!({ "value": 3.3012, "unit": "V" });
        let result = StepResult::new(
            step_id.clone(),
            StepOutcome::Succeeded {
                output: output.clone(),
            },
        );

        assert_eq!(result.step_id(), &step_id);
        assert_eq!(
            result.outcome(),
            &StepOutcome::Succeeded {
                output: output.clone()
            }
        );
        assert_eq!(
            result,
            StepResult::new(step_id, StepOutcome::Succeeded { output })
        );
    }

    #[test]
    fn step_result_failed_and_cancelled() {
        let failed = StepResult::new(
            StepId::new("meter-read-1").unwrap(),
            StepOutcome::Failed {
                message: "instrument timeout".to_owned(),
            },
        );
        assert_eq!(failed.step_id().as_str(), "meter-read-1");
        assert_eq!(
            failed.outcome(),
            &StepOutcome::Failed {
                message: "instrument timeout".to_owned()
            }
        );

        let cancelled = StepResult::new(StepId::new("wait-1").unwrap(), StepOutcome::Cancelled);
        assert_eq!(cancelled.outcome(), &StepOutcome::Cancelled);
    }
}
