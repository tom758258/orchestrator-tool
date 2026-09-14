use std::{
    collections::{BTreeMap, HashSet},
    error::Error,
    fmt,
};

use serde_json::Value;

use crate::tool_instance::ToolInstanceId;

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

impl ExpressionOperator {
    pub fn is_comparison(self) -> bool {
        matches!(
            self,
            Self::GreaterThan | Self::GreaterThanOrEqual | Self::LessThan | Self::LessThanOrEqual
        )
    }
}

/// A single step in a workflow.
#[derive(Clone, Debug, PartialEq)]
pub struct Step {
    id: StepId,
    kind: StepKind,
}

#[derive(Clone, Debug, PartialEq)]
pub struct NumericRange {
    start: f64,
    stop: f64,
    step: f64,
}

impl NumericRange {
    pub fn new(start: f64, stop: f64, step: f64) -> Result<Self, NumericRangeError> {
        if !start.is_finite() || !stop.is_finite() || !step.is_finite() {
            return Err(NumericRangeError::NonFinite);
        }
        if step == 0.0 {
            return Err(NumericRangeError::ZeroStep);
        }
        if start < stop && step < 0.0 || start > stop && step > 0.0 {
            return Err(NumericRangeError::WrongDirection);
        }
        Ok(Self { start, stop, step })
    }
    pub fn start(&self) -> f64 {
        self.start
    }
    pub fn stop(&self) -> f64 {
        self.stop
    }
    pub fn step(&self) -> f64 {
        self.step
    }
    pub fn iteration_count(&self) -> usize {
        if self.start == self.stop {
            return 1;
        }
        ((self.stop - self.start) / self.step).floor() as usize + 1
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NumericRangeError {
    NonFinite,
    ZeroStep,
    WrongDirection,
}

impl fmt::Display for NumericRangeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::NonFinite => "range values must be finite",
            Self::ZeroStep => "range step must not be zero",
            Self::WrongDirection => "range step has the wrong direction",
        })
    }
}
impl Error for NumericRangeError {}

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
    Assert {
        condition: Expression,
        message: String,
    },
    SetVariable {
        variable: VariableId,
        value: InputValue,
    },
    Output {
        name: String,
        value: InputValue,
    },
    Wait {
        duration_ms: u64,
    },
    ToolAction {
        target: ToolInstanceId,
        action: ActionId,
        arguments: Value,
        /// Top-level inputs resolved at runtime, overriding literal arguments.
        bindings: BTreeMap<String, InputValue>,
    },
    For {
        variable: VariableId,
        range: NumericRange,
        body: Vec<Step>,
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
        let mut output_names = HashSet::new();
        let mut root_outputs = false;
        let mut body_outputs = false;

        #[allow(clippy::too_many_arguments)]
        fn validate_steps(
            steps: &[Step],
            seen: &mut HashSet<StepId>,
            output_names: &mut HashSet<String>,
            available: &HashSet<StepId>,
            root_outputs: &mut bool,
            body_outputs: &mut bool,
            in_for: bool,
            loop_variable: Option<&VariableId>,
        ) -> Result<(), WorkflowError> {
            let mut prior = available.clone();
            for step in steps {
                if !seen.insert(step.id().clone()) {
                    return Err(WorkflowError::DuplicateStepId(step.id().clone()));
                }
                let validate_input = |input: &InputValue| -> Result<(), WorkflowError> {
                    let check = |r: &StepOutputReference| {
                        if prior.contains(r.step_id()) {
                            Ok(())
                        } else {
                            Err(WorkflowError::InvalidStepOutputReference {
                                step_id: step.id().clone(),
                                target: r.step_id().clone(),
                            })
                        }
                    };
                    match input {
                        InputValue::StepOutput(r) => check(r),
                        InputValue::Expression(e) => {
                            for o in [e.left(), e.right()] {
                                if let ExpressionOperand::StepOutput(r) = o {
                                    check(r)?;
                                }
                            }
                            Ok(())
                        }
                        _ => Ok(()),
                    }
                };
                match step.kind() {
                    StepKind::For {
                        variable,
                        range,
                        body,
                    } => {
                        let _ = range.iteration_count();
                        if in_for {
                            return Err(WorkflowError::NestedFor(step.id().clone()));
                        }
                        validate_steps(
                            body,
                            seen,
                            output_names,
                            &prior,
                            root_outputs,
                            body_outputs,
                            true,
                            Some(variable),
                        )?;
                    }
                    StepKind::Assert { condition, .. } => {
                        if !condition.operator().is_comparison() {
                            return Err(WorkflowError::InvalidAssertOperator(step.id().clone()));
                        }
                        validate_input(&InputValue::Expression(condition.clone()))?;
                    }
                    StepKind::SetVariable { variable, value } => {
                        if loop_variable == Some(variable) {
                            return Err(WorkflowError::LoopVariableAssignment(step.id().clone()));
                        }
                        validate_input(value)?;
                    }
                    StepKind::Output { name, value } => {
                        if name.trim().is_empty() {
                            return Err(WorkflowError::InvalidOutputName(step.id().clone()));
                        }
                        if !output_names.insert(name.clone()) {
                            return Err(WorkflowError::DuplicateOutputName(name.clone()));
                        }
                        validate_input(value)?;
                        if in_for {
                            *body_outputs = true;
                        } else {
                            *root_outputs = true;
                        }
                    }
                    StepKind::ToolAction { bindings, .. } => {
                        for value in bindings.values() {
                            validate_input(value)?;
                        }
                    }
                    StepKind::Wait { .. } => {}
                }
                prior.insert(step.id().clone());
            }
            Ok(())
        }

        validate_steps(
            &steps,
            &mut seen,
            &mut output_names,
            &HashSet::new(),
            &mut root_outputs,
            &mut body_outputs,
            false,
            None,
        )?;
        if root_outputs && body_outputs {
            return Err(WorkflowError::MixedOutputPlacement);
        }

        Ok(Self { steps })
    }

    /// Projects successful Output results in workflow order.
    /// Missing, failed, or cancelled Outputs reject the entire projection.
    pub fn project_outputs(
        &self,
        results: &[StepResult],
    ) -> Result<Vec<WorkflowOutput>, OutputProjectionError> {
        let mut outputs = Vec::new();
        for step in &self.steps {
            let StepKind::Output { name, .. } = step.kind() else {
                continue;
            };
            let result = results
                .iter()
                .find(|result| result.step_id() == step.id())
                .ok_or_else(|| OutputProjectionError::MissingStepResult(step.id().clone()))?;
            match result.outcome() {
                StepOutcome::Succeeded { output } => outputs.push(WorkflowOutput {
                    name: name.clone(),
                    value: output.clone(),
                }),
                outcome => {
                    return Err(OutputProjectionError::UnsuccessfulStep {
                        step_id: step.id().clone(),
                        outcome: outcome.clone(),
                    });
                }
            }
        }
        Ok(outputs)
    }

    /// Returns the steps in execution order.
    pub fn steps(&self) -> &[Step] {
        &self.steps
    }
}

/// A named resolved value, ordered by its Output step in the workflow.
#[derive(Clone, Debug, PartialEq)]
pub struct WorkflowOutput {
    name: String,
    value: Value,
}

impl WorkflowOutput {
    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn value(&self) -> &Value {
        &self.value
    }
}

/// An Output step has no successful result to project.
#[derive(Debug)]
pub enum OutputProjectionError {
    MissingStepResult(StepId),
    UnsuccessfulStep {
        step_id: StepId,
        outcome: StepOutcome,
    },
}

impl fmt::Display for OutputProjectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingStepResult(step_id) => {
                write!(formatter, "output step {step_id} has no result")
            }
            Self::UnsuccessfulStep { step_id, outcome } => {
                write!(
                    formatter,
                    "output step {step_id} did not succeed: {outcome:?}"
                )
            }
        }
    }
}

impl Error for OutputProjectionError {}

/// Errors produced while constructing a workflow.
#[derive(Debug)]
pub enum WorkflowError {
    InvalidAssertOperator(StepId),
    DuplicateStepId(StepId),
    InvalidOutputName(StepId),
    DuplicateOutputName(String),
    InvalidStepOutputReference { step_id: StepId, target: StepId },
    NestedFor(StepId),
    LoopVariableAssignment(StepId),
    MixedOutputPlacement,
    InvalidRange(String),
}

impl fmt::Display for WorkflowError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidAssertOperator(step_id) => {
                write!(
                    formatter,
                    "assert step {step_id} requires a comparison operator"
                )
            }
            Self::InvalidOutputName(step_id) => {
                write!(formatter, "output step {step_id} name must not be blank")
            }
            Self::DuplicateOutputName(name) => {
                write!(formatter, "duplicate workflow output name {name:?}")
            }
            Self::InvalidStepOutputReference { step_id, target } => write!(
                formatter,
                "step {step_id} references step {target}, but {target} is not an earlier step"
            ),
            Self::DuplicateStepId(step_id) => {
                write!(formatter, "duplicate workflow step ID {step_id}")
            }
            Self::NestedFor(step_id) => {
                write!(formatter, "nested For is not supported at step {step_id}")
            }
            Self::LoopVariableAssignment(step_id) => write!(
                formatter,
                "step {step_id} cannot assign its For loop variable"
            ),
            Self::MixedOutputPlacement => {
                write!(formatter, "root and For-body outputs cannot be mixed")
            }
            Self::InvalidRange(message) => write!(formatter, "invalid numeric range: {message}"),
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
    use crate::tool_instance::ToolInstanceId;

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
                    target: ToolInstanceId::new("powers-1").unwrap(),
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
                target: ToolInstanceId::new("powers-1").unwrap(),
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
                    name: "output-1".to_owned(),
                    value: value.clone(),
                },
                StepKind::ToolAction {
                    target: ToolInstanceId::new("powers-1").unwrap(),
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
                    name: "output-2".to_owned(),
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
    fn assert_requires_comparison_and_earlier_step_references() {
        let prior = Step::new(
            StepId::new("measurement").unwrap(),
            StepKind::Wait { duration_ms: 0 },
        );
        let assertion = Step::new(
            StepId::new("assert-1").unwrap(),
            StepKind::Assert {
                condition: Expression::new(
                    ExpressionOperand::StepOutput(StepOutputReference::new(
                        prior.id().clone(),
                        "/value",
                    )),
                    ExpressionOperator::GreaterThanOrEqual,
                    ExpressionOperand::Variable(VariableId::new("threshold").unwrap()),
                ),
                message: "Below threshold.".to_owned(),
            },
        );
        assert!(Workflow::new(vec![prior.clone(), assertion.clone()]).is_ok());
        for steps in [vec![assertion.clone(), prior], vec![assertion]] {
            assert!(matches!(
                Workflow::new(steps),
                Err(WorkflowError::InvalidStepOutputReference { .. })
            ));
        }
        let arithmetic = Step::new(
            StepId::new("assert-1").unwrap(),
            StepKind::Assert {
                condition: Expression::new(
                    ExpressionOperand::Literal(json!(5)),
                    ExpressionOperator::Add,
                    ExpressionOperand::Literal(json!(2)),
                ),
                message: String::new(),
            },
        );
        let error = Workflow::new(vec![arithmetic]).unwrap_err();
        assert_eq!(
            error.to_string(),
            "assert step assert-1 requires a comparison operator"
        );
        assert!(matches!(error, WorkflowError::InvalidAssertOperator(_)));
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
                message: "tool timeout".to_owned(),
            },
        );
        assert_eq!(failed.step_id().as_str(), "meter-read-1");
        assert_eq!(
            failed.outcome(),
            &StepOutcome::Failed {
                message: "tool timeout".to_owned()
            }
        );

        let cancelled = StepResult::new(StepId::new("wait-1").unwrap(), StepOutcome::Cancelled);
        assert_eq!(cancelled.outcome(), &StepOutcome::Cancelled);
    }
}
