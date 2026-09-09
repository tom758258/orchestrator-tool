use std::{collections::HashMap, error::Error, fmt};

use serde_json::Value;

use crate::workflow::{InputValue, StepId, VariableId};

/// Runtime values for one workflow run, never persisted in templates or config.
#[derive(Debug, Default)]
pub struct DataContext {
    variables: HashMap<VariableId, Value>,
    step_outputs: HashMap<StepId, Value>,
}

impl DataContext {
    /// Creates an empty runtime context.
    pub fn new() -> Self {
        Self::default()
    }

    /// Stores a variable, replacing any previous value for the same ID.
    pub fn set_variable(&mut self, variable_id: VariableId, value: Value) {
        self.variables.insert(variable_id, value);
    }

    /// Returns a stored variable value, if present.
    pub fn variable(&self, variable_id: &VariableId) -> Option<&Value> {
        self.variables.get(variable_id)
    }

    /// Stores a step output, replacing any previous output for the same ID.
    pub fn set_step_output(&mut self, step_id: StepId, output: Value) {
        self.step_outputs.insert(step_id, output);
    }

    /// Returns the complete stored step output, if present.
    pub fn step_output(&self, step_id: &StepId) -> Option<&Value> {
        self.step_outputs.get(step_id)
    }

    /// Resolves an input to an owned value without changing the input or context.
    /// An empty JSON Pointer selects the complete step output.
    pub fn resolve(&self, input: &InputValue) -> Result<Value, ResolveError> {
        match input {
            InputValue::Expression(_) => Err(ResolveError::UnsupportedExpression),
            InputValue::Literal(value) => Ok(value.clone()),
            InputValue::Variable(variable_id) => self
                .variable(variable_id)
                .cloned()
                .ok_or_else(|| ResolveError::MissingVariable(variable_id.clone())),
            InputValue::StepOutput(reference) => {
                let output = self
                    .step_output(reference.step_id())
                    .ok_or_else(|| ResolveError::MissingStepOutput(reference.step_id().clone()))?;
                output.pointer(reference.pointer()).cloned().ok_or_else(|| {
                    ResolveError::MissingStepOutputPath {
                        step_id: reference.step_id().clone(),
                        pointer: reference.pointer().to_owned(),
                    }
                })
            }
        }
    }
}

/// Missing runtime data encountered while resolving an input.
#[derive(Debug)]
pub enum ResolveError {
    UnsupportedExpression,
    MissingVariable(VariableId),
    MissingStepOutput(StepId),
    MissingStepOutputPath { step_id: StepId, pointer: String },
}

impl fmt::Display for ResolveError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedExpression => {
                formatter.write_str("expression resolution is not supported")
            }
            Self::MissingVariable(variable_id) => {
                write!(formatter, "missing variable {variable_id}")
            }
            Self::MissingStepOutput(step_id) => {
                write!(formatter, "missing step output for step {step_id}")
            }
            Self::MissingStepOutputPath { step_id, pointer } => {
                write!(
                    formatter,
                    "missing step output target for step {step_id} at JSON Pointer {pointer:?}"
                )
            }
        }
    }
}

impl Error for ResolveError {}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{DataContext, ResolveError};
    use crate::workflow::{
        Expression, ExpressionOperand, ExpressionOperator, InputValue, StepId, StepOutputReference,
        VariableId,
    };

    #[test]
    fn expression_resolution_is_explicitly_unsupported() {
        let input = InputValue::Expression(Expression::new(
            ExpressionOperand::Variable(VariableId::new("x").unwrap()),
            ExpressionOperator::Multiply,
            ExpressionOperand::Literal(json!(2)),
        ));
        let error = DataContext::new().resolve(&input).unwrap_err();

        assert!(matches!(error, ResolveError::UnsupportedExpression));
        assert_eq!(error.to_string(), "expression resolution is not supported");
    }

    #[test]
    fn literal_resolves_without_changing_input() {
        let context = DataContext::new();
        let input = InputValue::Literal(json!({ "value": 5.0 }));
        let mut resolved = context.resolve(&input).unwrap();

        assert_eq!(resolved, json!({ "value": 5.0 }));
        resolved["value"] = json!(10.0);
        assert_eq!(input, InputValue::Literal(json!({ "value": 5.0 })));
    }

    #[test]
    fn variable_resolves_to_latest_stored_value() {
        let mut context = DataContext::default();
        let variable_id = VariableId::new("x").unwrap();
        assert_eq!(context.variable(&variable_id), None);
        context.set_variable(variable_id.clone(), json!(1.0));
        context.set_variable(variable_id.clone(), json!(5.0));

        assert_eq!(context.variable(&variable_id), Some(&json!(5.0)));
        assert_eq!(
            context.resolve(&InputValue::Variable(variable_id)).unwrap(),
            json!(5.0)
        );
    }

    #[test]
    fn step_output_resolves_json_pointer_and_complete_document() {
        let mut context = DataContext::new();
        let step_id = StepId::new("meter-read-1").unwrap();
        let output = json!({ "value": 3.3012, "unit": "V" });
        assert_eq!(context.step_output(&step_id), None);
        context.set_step_output(step_id.clone(), output.clone());

        assert_eq!(context.step_output(&step_id), Some(&output));
        assert_eq!(
            context
                .resolve(&InputValue::StepOutput(StepOutputReference::new(
                    step_id.clone(),
                    "/value",
                )))
                .unwrap(),
            json!(3.3012)
        );
        assert_eq!(
            context
                .resolve(&InputValue::StepOutput(StepOutputReference::new(
                    step_id, ""
                )))
                .unwrap(),
            output
        );
    }

    #[test]
    fn missing_variable_returns_explicit_error() {
        let variable_id = VariableId::new("x").unwrap();
        let error = DataContext::new()
            .resolve(&InputValue::Variable(variable_id.clone()))
            .unwrap_err();

        assert!(error.to_string().contains("x"));
        assert!(matches!(error, ResolveError::MissingVariable(id) if id == variable_id));
    }

    #[test]
    fn missing_step_output_returns_explicit_error() {
        let step_id = StepId::new("meter-read-1").unwrap();
        let error = DataContext::new()
            .resolve(&InputValue::StepOutput(StepOutputReference::new(
                step_id.clone(),
                "/value",
            )))
            .unwrap_err();

        assert!(error.to_string().contains("meter-read-1"));
        assert!(matches!(error, ResolveError::MissingStepOutput(id) if id == step_id));
    }

    #[test]
    fn missing_pointer_target_returns_explicit_error() {
        let mut context = DataContext::new();
        let step_id = StepId::new("meter-read-1").unwrap();
        context.set_step_output(step_id.clone(), json!({ "unit": "V" }));
        let error = context
            .resolve(&InputValue::StepOutput(StepOutputReference::new(
                step_id.clone(),
                "/value",
            )))
            .unwrap_err();

        let message = error.to_string();
        assert!(message.contains("meter-read-1"));
        assert!(message.contains("/value"));
        assert!(matches!(
            error,
            ResolveError::MissingStepOutputPath { step_id: id, pointer }
                if id == step_id && pointer == "/value"
        ));
    }
}
