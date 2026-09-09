use std::{collections::BTreeMap, error::Error, fmt, fs, io, path::Path};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    tool::{InvalidToolId, ToolId},
    workflow::{
        ActionId, Expression, ExpressionOperand, ExpressionOperator, InputValue, InvalidActionId,
        InvalidStepId, InvalidVariableId, Step, StepId, StepKind, StepOutputReference, VariableId,
        Workflow, WorkflowError,
    },
};

/// Current template file format version.
pub const TEMPLATE_SCHEMA_VERSION: u32 = 1;

/// A persisted workflow template.
#[derive(Clone, Debug, PartialEq)]
pub struct Template {
    name: String,
    workflow: Workflow,
}

impl Template {
    /// Creates a template.
    pub fn new(name: String, workflow: Workflow) -> Self {
        Self { name, workflow }
    }

    /// Returns the template name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Returns the workflow.
    pub fn workflow(&self) -> &Workflow {
        &self.workflow
    }

    /// Serializes the template to pretty JSON.
    pub fn to_json_string(&self) -> Result<String, TemplateError> {
        let wire = TemplateWire::from_template(self);
        serde_json::to_string_pretty(&wire).map_err(TemplateError::Json)
    }

    /// Deserializes a template from JSON text.
    pub fn from_json_str(json: &str) -> Result<Self, TemplateError> {
        let version_wire: TemplateVersionWire =
            serde_json::from_str(json).map_err(TemplateError::Json)?;

        if version_wire.schema_version != TEMPLATE_SCHEMA_VERSION {
            return Err(TemplateError::UnsupportedSchemaVersion {
                expected: TEMPLATE_SCHEMA_VERSION,
                found: version_wire.schema_version,
            });
        }

        let wire: TemplateWire = serde_json::from_str(json).map_err(TemplateError::Json)?;
        let workflow = workflow_from_wire(wire.workflow)?;
        Ok(Self {
            name: wire.name,
            workflow,
        })
    }

    /// Saves the template to a file as pretty JSON.
    pub fn save_to_file(&self, path: impl AsRef<Path>) -> Result<(), TemplateError> {
        let path = path.as_ref();
        let json = self.to_json_string()?;
        fs::write(path, json).map_err(|source| TemplateError::Io {
            path: path.to_path_buf(),
            source,
        })
    }

    /// Loads a template from a file.
    pub fn load_from_file(path: impl AsRef<Path>) -> Result<Self, TemplateError> {
        let path = path.as_ref();
        let contents = fs::read_to_string(path).map_err(|source| TemplateError::Io {
            path: path.to_path_buf(),
            source,
        })?;
        Self::from_json_str(&contents)
    }
}

#[derive(Debug)]
pub enum TemplateError {
    InvalidVariableId {
        value: String,
        source: InvalidVariableId,
    },
    Io {
        path: std::path::PathBuf,
        source: io::Error,
    },
    Json(serde_json::Error),
    UnsupportedSchemaVersion {
        expected: u32,
        found: u32,
    },
    InvalidStepId {
        value: String,
        source: InvalidStepId,
    },
    InvalidActionId {
        value: String,
        source: InvalidActionId,
    },
    InvalidToolId {
        value: String,
        source: InvalidToolId,
    },
    Workflow(WorkflowError),
}

impl fmt::Display for TemplateError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidVariableId { value, source } => {
                write!(formatter, "invalid variable ID {value:?}: {source}")
            }
            Self::Io { path, source } => {
                write!(
                    formatter,
                    "template I/O error for {}: {source}",
                    path.display()
                )
            }
            Self::Json(source) => write!(formatter, "template JSON error: {source}"),
            Self::UnsupportedSchemaVersion { expected, found } => write!(
                formatter,
                "unsupported template schema version {found}, expected {expected}"
            ),
            Self::InvalidStepId { value, source } => {
                write!(formatter, "invalid step ID {value:?}: {source}")
            }
            Self::InvalidActionId { value, source } => {
                write!(formatter, "invalid action ID {value:?}: {source}")
            }
            Self::InvalidToolId { value, source } => {
                write!(formatter, "invalid tool ID {value:?}: {source}")
            }
            Self::Workflow(source) => write!(formatter, "template workflow error: {source}"),
        }
    }
}

impl Error for TemplateError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::InvalidVariableId { source, .. } => Some(source),
            Self::Io { source, .. } => Some(source),
            Self::Json(source) => Some(source),
            Self::UnsupportedSchemaVersion { .. } => None,
            Self::InvalidStepId { source, .. } => Some(source),
            Self::InvalidActionId { source, .. } => Some(source),
            Self::InvalidToolId { source, .. } => Some(source),
            Self::Workflow(source) => Some(source),
        }
    }
}

#[derive(Deserialize)]
struct TemplateVersionWire {
    schema_version: u32,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct TemplateWire {
    schema_version: u32,
    name: String,
    workflow: WorkflowWire,
}

impl TemplateWire {
    fn from_template(template: &Template) -> Self {
        Self {
            schema_version: TEMPLATE_SCHEMA_VERSION,
            name: template.name.clone(),
            workflow: WorkflowWire::from_workflow(template.workflow()),
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkflowWire {
    steps: Vec<StepWire>,
}

impl WorkflowWire {
    fn from_workflow(workflow: &Workflow) -> Self {
        Self {
            steps: workflow.steps().iter().map(StepWire::from_step).collect(),
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
enum StepWire {
    SetVariable {
        id: String,
        variable: String,
        value: InputValueWire,
    },
    Output {
        id: String,
        value: InputValueWire,
    },
    Wait {
        id: String,
        duration_ms: u64,
    },
    ToolAction {
        id: String,
        tool: String,
        action: String,
        arguments: Value,
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        bindings: BTreeMap<String, InputValueWire>,
    },
}

impl StepWire {
    fn from_step(step: &Step) -> Self {
        match step.kind() {
            StepKind::SetVariable { variable, value } => Self::SetVariable {
                id: step.id().as_str().to_owned(),
                variable: variable.as_str().to_owned(),
                value: InputValueWire::from_input(value),
            },
            StepKind::Output { value } => Self::Output {
                id: step.id().as_str().to_owned(),
                value: InputValueWire::from_input(value),
            },
            StepKind::Wait { duration_ms } => Self::Wait {
                id: step.id().as_str().to_owned(),
                duration_ms: *duration_ms,
            },
            StepKind::ToolAction {
                tool,
                action,
                arguments,
                bindings,
            } => Self::ToolAction {
                id: step.id().as_str().to_owned(),
                tool: tool.as_str().to_owned(),
                action: action.as_str().to_owned(),
                arguments: arguments.clone(),
                bindings: bindings
                    .iter()
                    .map(|(key, input)| (key.clone(), InputValueWire::from_input(input)))
                    .collect(),
            },
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "source", rename_all = "kebab-case", deny_unknown_fields)]
enum InputValueWire {
    Literal {
        value: Value,
    },
    Variable {
        variable: String,
    },
    StepOutput {
        step_id: String,
        pointer: String,
    },
    Expression {
        left: ExpressionOperandWire,
        operator: ExpressionOperator,
        right: ExpressionOperandWire,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "source", rename_all = "kebab-case", deny_unknown_fields)]
enum ExpressionOperandWire {
    Literal { value: Value },
    Variable { variable: String },
    StepOutput { step_id: String, pointer: String },
}

impl ExpressionOperandWire {
    fn from_operand(operand: &ExpressionOperand) -> Self {
        match operand {
            ExpressionOperand::Literal(value) => Self::Literal {
                value: value.clone(),
            },
            ExpressionOperand::Variable(variable) => Self::Variable {
                variable: variable.as_str().to_owned(),
            },
            ExpressionOperand::StepOutput(reference) => Self::StepOutput {
                step_id: reference.step_id().as_str().to_owned(),
                pointer: reference.pointer().to_owned(),
            },
        }
    }
}

fn operand_from_wire(wire: ExpressionOperandWire) -> Result<ExpressionOperand, TemplateError> {
    match wire {
        ExpressionOperandWire::Literal { value } => Ok(ExpressionOperand::Literal(value)),
        ExpressionOperandWire::Variable { variable } => {
            let variable =
                VariableId::new(&variable).map_err(|source| TemplateError::InvalidVariableId {
                    value: variable,
                    source,
                })?;
            Ok(ExpressionOperand::Variable(variable))
        }
        ExpressionOperandWire::StepOutput { step_id, pointer } => {
            let step_id = StepId::new(&step_id).map_err(|source| TemplateError::InvalidStepId {
                value: step_id,
                source,
            })?;
            Ok(ExpressionOperand::StepOutput(StepOutputReference::new(
                step_id, pointer,
            )))
        }
    }
}

impl InputValueWire {
    fn from_input(input: &InputValue) -> Self {
        match input {
            InputValue::Expression(expression) => Self::Expression {
                left: ExpressionOperandWire::from_operand(expression.left()),
                operator: expression.operator(),
                right: ExpressionOperandWire::from_operand(expression.right()),
            },
            InputValue::Literal(value) => Self::Literal {
                value: value.clone(),
            },
            InputValue::Variable(variable) => Self::Variable {
                variable: variable.as_str().to_owned(),
            },
            InputValue::StepOutput(reference) => Self::StepOutput {
                step_id: reference.step_id().as_str().to_owned(),
                pointer: reference.pointer().to_owned(),
            },
        }
    }
}

fn input_from_wire(wire: InputValueWire) -> Result<InputValue, TemplateError> {
    match wire {
        InputValueWire::Expression {
            left,
            operator,
            right,
        } => Ok(InputValue::Expression(Expression::new(
            operand_from_wire(left)?,
            operator,
            operand_from_wire(right)?,
        ))),
        InputValueWire::Literal { value } => Ok(InputValue::Literal(value)),
        InputValueWire::Variable { variable } => {
            let variable =
                VariableId::new(&variable).map_err(|source| TemplateError::InvalidVariableId {
                    value: variable,
                    source,
                })?;
            Ok(InputValue::Variable(variable))
        }
        InputValueWire::StepOutput { step_id, pointer } => {
            let step_id = StepId::new(&step_id).map_err(|source| TemplateError::InvalidStepId {
                value: step_id,
                source,
            })?;
            Ok(InputValue::StepOutput(StepOutputReference::new(
                step_id, pointer,
            )))
        }
    }
}

fn workflow_from_wire(wire: WorkflowWire) -> Result<Workflow, TemplateError> {
    let mut steps = Vec::with_capacity(wire.steps.len());

    for step_wire in wire.steps {
        let step = step_from_wire(step_wire)?;
        steps.push(step);
    }

    Workflow::new(steps).map_err(TemplateError::Workflow)
}

fn step_from_wire(wire: StepWire) -> Result<Step, TemplateError> {
    match wire {
        StepWire::SetVariable {
            id,
            variable,
            value,
        } => {
            let step_id = StepId::new(&id)
                .map_err(|source| TemplateError::InvalidStepId { value: id, source })?;
            let variable =
                VariableId::new(&variable).map_err(|source| TemplateError::InvalidVariableId {
                    value: variable,
                    source,
                })?;
            Ok(Step::new(
                step_id,
                StepKind::SetVariable {
                    variable,
                    value: input_from_wire(value)?,
                },
            ))
        }
        StepWire::Output { id, value } => {
            let step_id = StepId::new(&id)
                .map_err(|source| TemplateError::InvalidStepId { value: id, source })?;
            Ok(Step::new(
                step_id,
                StepKind::Output {
                    value: input_from_wire(value)?,
                },
            ))
        }
        StepWire::Wait { id, duration_ms } => {
            let step_id = StepId::new(&id)
                .map_err(|source| TemplateError::InvalidStepId { value: id, source })?;
            Ok(Step::new(step_id, StepKind::Wait { duration_ms }))
        }
        StepWire::ToolAction {
            id,
            tool,
            action,
            arguments,
            bindings,
        } => {
            let step_id = StepId::new(&id)
                .map_err(|source| TemplateError::InvalidStepId { value: id, source })?;
            let tool_id = ToolId::new(&tool).map_err(|source| TemplateError::InvalidToolId {
                value: tool,
                source,
            })?;
            let action_id =
                ActionId::new(&action).map_err(|source| TemplateError::InvalidActionId {
                    value: action,
                    source,
                })?;
            Ok(Step::new(
                step_id,
                StepKind::ToolAction {
                    tool: tool_id,
                    action: action_id,
                    arguments,
                    bindings: bindings
                        .into_iter()
                        .map(|(key, input)| Ok((key, input_from_wire(input)?)))
                        .collect::<Result<_, TemplateError>>()?,
                },
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
        process,
        sync::atomic::{AtomicU64, Ordering},
    };

    use serde_json::{Value, json};

    use super::{TEMPLATE_SCHEMA_VERSION, Template, TemplateError};
    use crate::{
        tool::ToolId,
        workflow::{
            ActionId, Expression, ExpressionOperand, ExpressionOperator, InputValue, Step, StepId,
            StepKind, StepOutputReference, VariableId, Workflow,
        },
    };

    static NEXT_TEST_DIR: AtomicU64 = AtomicU64::new(0);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let sequence = NEXT_TEST_DIR.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "orchestrator-tool-template-test-{}-{sequence}",
                process::id()
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn sample_template() -> Template {
        let workflow = Workflow::new(vec![
            Step::new(
                StepId::new("power-set-1").unwrap(),
                StepKind::ToolAction {
                    tool: ToolId::powers(),
                    action: ActionId::new("set-voltage").unwrap(),
                    arguments: json!({ "channel": 1, "voltage": 5.0 }),
                    bindings: Default::default(),
                },
            ),
            Step::new(
                StepId::new("wait-1").unwrap(),
                StepKind::Wait { duration_ms: 500 },
            ),
            Step::new(
                StepId::new("meter-read-1").unwrap(),
                StepKind::ToolAction {
                    tool: ToolId::meters(),
                    action: ActionId::new("measure").unwrap(),
                    arguments: json!({}),
                    bindings: Default::default(),
                },
            ),
        ])
        .unwrap();
        Template::new("Power and Meter Test".to_owned(), workflow)
    }

    #[test]
    fn template_json_round_trip_preserves_domain_and_wire_shape() {
        let original = sample_template();
        let json = original.to_json_string().unwrap();

        let value: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["schema_version"], TEMPLATE_SCHEMA_VERSION);
        assert_eq!(value["name"], "Power and Meter Test");
        assert_eq!(value["workflow"]["steps"][0]["type"], "tool-action");
        assert_eq!(value["workflow"]["steps"][0]["id"], "power-set-1");
        assert!(value["workflow"]["steps"][0].get("bindings").is_none());
        assert!(value["workflow"]["steps"][2].get("bindings").is_none());
        assert_eq!(value["workflow"]["steps"][1]["type"], "wait");
        assert_eq!(value["workflow"]["steps"][1]["duration_ms"], 500);
        assert_eq!(value["workflow"]["steps"][2]["type"], "tool-action");

        let restored = Template::from_json_str(&json).unwrap();
        assert_eq!(restored, original);
        assert_eq!(restored.name(), original.name());
        assert_eq!(
            restored.workflow().steps()[0].kind(),
            original.workflow().steps()[0].kind()
        );
        assert_eq!(
            restored.workflow().steps()[1].kind(),
            original.workflow().steps()[1].kind()
        );
        assert_eq!(
            restored.workflow().steps()[2].kind(),
            original.workflow().steps()[2].kind()
        );
    }

    #[test]
    fn tool_action_bindings_round_trip() {
        let original = Template::new(
            "Bound voltage".to_owned(),
            Workflow::new(vec![Step::new(
                StepId::new("power-set-1").unwrap(),
                StepKind::ToolAction {
                    tool: ToolId::powers(),
                    action: ActionId::new("set-voltage").unwrap(),
                    arguments: json!({ "channel": 1, "voltage": 0 }),
                    bindings: [(
                        "voltage".to_owned(),
                        InputValue::Variable(VariableId::new("x").unwrap()),
                    )]
                    .into(),
                },
            )])
            .unwrap(),
        );
        let json = original.to_json_string().unwrap();
        let value: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["schema_version"], 1);
        let binding = &value["workflow"]["steps"][0]["bindings"]["voltage"];
        assert_eq!(binding["source"], "variable");
        assert_eq!(binding["variable"], "x");
        assert_eq!(Template::from_json_str(&json).unwrap(), original);
    }

    #[test]
    fn template_file_round_trip() {
        let test_dir = TestDir::new();
        let path = test_dir.path().join("template.json");
        let original = sample_template();

        original.save_to_file(&path).unwrap();
        let loaded = Template::load_from_file(&path).unwrap();

        assert_eq!(loaded, original);
    }

    #[test]
    fn unsupported_schema_version_is_rejected() {
        let json = json!({
            "schema_version": 99,
            "future_field": true,
            "workflow_v99": { "nodes": [] }
        })
        .to_string();

        let error = Template::from_json_str(&json).unwrap_err();
        assert!(
            matches!(
                error,
                TemplateError::UnsupportedSchemaVersion { expected, found }
                if expected == TEMPLATE_SCHEMA_VERSION && found == 99
            ),
            "unexpected error: {error:?}"
        );
    }

    #[test]
    fn duplicate_step_id_is_rejected_from_json() {
        let json = json!({
            "schema_version": 1,
            "name": "Dup",
            "workflow": {
                "steps": [
                    { "id": "wait-1", "type": "wait", "duration_ms": 100 },
                    { "id": "wait-1", "type": "wait", "duration_ms": 200 }
                ]
            }
        })
        .to_string();

        let error = Template::from_json_str(&json).unwrap_err();
        assert!(
            matches!(error, TemplateError::Workflow(_)),
            "unexpected error: {error:?}"
        );
    }

    #[test]
    fn invalid_tool_id_is_rejected_from_json() {
        let json = json!({
            "schema_version": 1,
            "name": "Bad tool",
            "workflow": {
                "steps": [
                    {
                        "id": "power-set-1",
                        "type": "tool-action",
                        "tool": "Meters",
                        "action": "set-voltage",
                        "arguments": {}
                    }
                ]
            }
        })
        .to_string();

        let error = Template::from_json_str(&json).unwrap_err();
        assert!(
            matches!(error, TemplateError::InvalidToolId { .. }),
            "unexpected error: {error:?}"
        );
    }

    #[test]
    fn draft_empty_workflow_is_allowed() {
        let template = Template::new("Draft".to_owned(), Workflow::new(Vec::new()).unwrap());
        let json = template.to_json_string().unwrap();
        let restored = Template::from_json_str(&json).unwrap();
        assert_eq!(restored, template);
        assert!(restored.workflow().steps().is_empty());
    }

    #[test]
    fn dataflow_template_round_trip_preserves_domain_and_wire_shape() {
        let variable = VariableId::new("x").unwrap();
        let step_id = StepId::new("set-x").unwrap();
        let workflow = Workflow::new(vec![
            Step::new(
                step_id.clone(),
                StepKind::SetVariable {
                    variable: variable.clone(),
                    value: InputValue::Literal(json!(5.0)),
                },
            ),
            Step::new(
                StepId::new("output-variable").unwrap(),
                StepKind::Output {
                    value: InputValue::Variable(variable),
                },
            ),
            Step::new(
                StepId::new("output-step").unwrap(),
                StepKind::Output {
                    value: InputValue::StepOutput(StepOutputReference::new(step_id, "")),
                },
            ),
        ])
        .unwrap();
        let original = Template::new("Dataflow".to_owned(), workflow);
        let json = original.to_json_string().unwrap();
        let value: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["schema_version"], 1);
        let steps = &value["workflow"]["steps"];
        assert_eq!(steps[0]["type"], "set-variable");
        assert_eq!(steps[0]["value"]["source"], "literal");
        assert_eq!(steps[1]["value"]["source"], "variable");
        assert_eq!(steps[2]["type"], "output");
        assert_eq!(steps[2]["value"]["source"], "step-output");
        assert_eq!(steps[2]["value"]["step_id"], "set-x");
        assert_eq!(steps[2]["value"]["pointer"], "");
        assert_eq!(Template::from_json_str(&json).unwrap(), original);
    }

    #[test]
    fn invalid_variable_id_is_rejected_from_json() {
        let json = json!({
            "schema_version": 1,
            "name": "Invalid variable",
            "workflow": { "steps": [{
                "type": "set-variable", "id": "set-x", "variable": "Bad_Name",
                "value": { "source": "literal", "value": 5.0 }
            }] }
        })
        .to_string();
        let error = Template::from_json_str(&json).unwrap_err();
        assert!(error.to_string().contains("invalid variable ID"));
        assert!(
            matches!(error, TemplateError::InvalidVariableId { value, .. } if value == "Bad_Name")
        );
    }

    #[test]
    fn expression_dataflow_json_and_file_round_trip() {
        let original = Template::new(
            "Double x".to_owned(),
            Workflow::new(vec![
                Step::new(
                    StepId::new("set-x").unwrap(),
                    StepKind::SetVariable {
                        variable: VariableId::new("x").unwrap(),
                        value: InputValue::Literal(json!(5)),
                    },
                ),
                Step::new(
                    StepId::new("set-doubled").unwrap(),
                    StepKind::SetVariable {
                        variable: VariableId::new("doubled").unwrap(),
                        value: InputValue::Expression(Expression::new(
                            ExpressionOperand::Variable(VariableId::new("x").unwrap()),
                            ExpressionOperator::Multiply,
                            ExpressionOperand::Literal(json!(2)),
                        )),
                    },
                ),
                Step::new(
                    StepId::new("output-doubled").unwrap(),
                    StepKind::Output {
                        value: InputValue::Variable(VariableId::new("doubled").unwrap()),
                    },
                ),
            ])
            .unwrap(),
        );
        let json = original.to_json_string().unwrap();
        let wire: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(wire["schema_version"], 1);
        assert_eq!(
            wire["workflow"]["steps"][1]["value"],
            json!({
                "source": "expression",
                "left": { "source": "variable", "variable": "x" },
                "operator": "multiply",
                "right": { "source": "literal", "value": 2 }
            })
        );
        assert_eq!(Template::from_json_str(&json).unwrap(), original);

        let test_dir = TestDir::new();
        let path = test_dir.path().join("expression.json");
        original.save_to_file(&path).unwrap();
        assert_eq!(Template::load_from_file(&path).unwrap(), original);
    }

    #[test]
    fn expression_template_round_trip_preserves_domain_and_wire_shape() {
        let cases = [
            (
                ExpressionOperand::Variable(VariableId::new("x").unwrap()),
                ExpressionOperand::Literal(json!(2)),
                json!({ "source": "variable", "variable": "x" }),
                json!({ "source": "literal", "value": 2 }),
            ),
            (
                ExpressionOperand::StepOutput(StepOutputReference::new(
                    StepId::new("measurement").unwrap(),
                    "/value",
                )),
                ExpressionOperand::Variable(VariableId::new("threshold").unwrap()),
                json!({ "source": "step-output", "step_id": "measurement", "pointer": "/value" }),
                json!({ "source": "variable", "variable": "threshold" }),
            ),
        ];
        for (operator, name) in [
            (ExpressionOperator::Add, "add"),
            (ExpressionOperator::Subtract, "subtract"),
            (ExpressionOperator::Multiply, "multiply"),
            (ExpressionOperator::Divide, "divide"),
            (ExpressionOperator::GreaterThan, "greater-than"),
            (
                ExpressionOperator::GreaterThanOrEqual,
                "greater-than-or-equal",
            ),
            (ExpressionOperator::LessThan, "less-than"),
            (ExpressionOperator::LessThanOrEqual, "less-than-or-equal"),
        ] {
            for (left, right, left_wire, right_wire) in &cases {
                let original = Template::new(
                    "Expression".to_owned(),
                    Workflow::new(vec![
                        Step::new(
                            StepId::new("measurement").unwrap(),
                            StepKind::Output {
                                value: InputValue::Literal(json!({ "value": 3 })),
                            },
                        ),
                        Step::new(
                            StepId::new("output-expression").unwrap(),
                            StepKind::Output {
                                value: InputValue::Expression(Expression::new(
                                    left.clone(),
                                    operator,
                                    right.clone(),
                                )),
                            },
                        ),
                    ])
                    .unwrap(),
                );
                let json = original.to_json_string().unwrap();
                let wire: Value = serde_json::from_str(&json).unwrap();
                assert_eq!(wire["schema_version"], 1);
                assert_eq!(
                    wire["workflow"]["steps"][1]["value"],
                    json!({
                        "source": "expression", "left": left_wire,
                        "operator": name, "right": right_wire,
                    })
                );
                assert_eq!(Template::from_json_str(&json).unwrap(), original);
            }
        }
    }
}
