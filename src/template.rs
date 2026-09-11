use std::{collections::BTreeMap, error::Error, fmt, fs, io, path::Path};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    meters_setup::MetersSetupError,
    tool::{InvalidToolId, ToolId},
    tool_instance::{ToolInstance, ToolInstanceId, ToolSetup},
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
    tool_instances: Vec<ToolInstance>,
    workflow: Workflow,
}

impl Template {
    /// Creates a template.
    pub fn new(
        name: String,
        tool_instances: Vec<ToolInstance>,
        workflow: Workflow,
    ) -> Result<Self, TemplateError> {
        let mut ids = std::collections::HashSet::new();
        for instance in &tool_instances {
            if !ids.insert(&instance.id) {
                return Err(TemplateError::Instance(format!(
                    "duplicate tool instance ID {}",
                    instance.id
                )));
            }
            match (&instance.setup, instance.tool == ToolId::meters()) {
                (ToolSetup::Meters(setup), true) => {
                    setup
                        .validate()
                        .map_err(|source| TemplateError::MetersSetup {
                            instance: instance.id.clone(),
                            source,
                        })?
                }
                (ToolSetup::Empty(_), false) => {}
                _ => {
                    return Err(TemplateError::Instance(format!(
                        "invalid setup for {} ({})",
                        instance.id, instance.tool
                    )));
                }
            }
        }
        for step in workflow.steps() {
            if let StepKind::ToolAction { target, .. } = step.kind()
                && !ids.contains(target)
            {
                return Err(TemplateError::Instance(format!(
                    "unknown tool instance target {target}"
                )));
            }
        }
        Ok(Self {
            name,
            tool_instances,
            workflow,
        })
    }

    /// Returns the template name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Returns the logical tool instances.
    pub fn tool_instances(&self) -> &[ToolInstance] {
        &self.tool_instances
    }

    /// Returns referenced instances in first-use order.
    pub fn referenced_tool_instances(&self) -> Vec<&ToolInstance> {
        let mut instances = Vec::new();
        for step in self.workflow.steps() {
            if let StepKind::ToolAction { target, .. } = step.kind() {
                let instance = self
                    .tool_instances
                    .iter()
                    .find(|instance| &instance.id == target)
                    .expect("template targets are validated");
                if !instances.contains(&instance) {
                    instances.push(instance);
                }
            }
        }
        instances
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
        let instances = wire
            .tool_instances
            .into_iter()
            .map(|instance| {
                let tool =
                    ToolId::new(&instance.tool).map_err(|source| TemplateError::InvalidToolId {
                        value: instance.tool,
                        source,
                    })?;
                Ok(ToolInstance {
                    id: instance.id,
                    tool,
                    setup: instance.setup,
                })
            })
            .collect::<Result<Vec<_>, TemplateError>>()?;
        Self::new(wire.name, instances, workflow)
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
    Instance(String),
    MetersSetup {
        instance: ToolInstanceId,
        source: MetersSetupError,
    },
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
            Self::Instance(message) => formatter.write_str(message),
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
            Self::MetersSetup { instance, source } => {
                write!(formatter, "{instance} Meters setup error: {source}")
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
            Self::UnsupportedSchemaVersion { .. } | Self::Instance(_) => None,
            Self::InvalidStepId { source, .. } => Some(source),
            Self::InvalidActionId { source, .. } => Some(source),
            Self::InvalidToolId { source, .. } => Some(source),
            Self::MetersSetup { source, .. } => Some(source),
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
    tool_instances: Vec<ToolInstanceWire>,
    workflow: WorkflowWire,
}

impl TemplateWire {
    fn from_template(template: &Template) -> Self {
        Self {
            schema_version: TEMPLATE_SCHEMA_VERSION,
            name: template.name.clone(),
            tool_instances: template
                .tool_instances
                .iter()
                .map(|instance| ToolInstanceWire {
                    id: instance.id.clone(),
                    tool: instance.tool.as_str().to_owned(),
                    setup: instance.setup.clone(),
                })
                .collect(),
            workflow: WorkflowWire::from_workflow(template.workflow()),
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ToolInstanceWire {
    id: ToolInstanceId,
    tool: String,
    setup: ToolSetup,
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
        #[serde(default)]
        name: Option<String>,
        value: InputValueWire,
    },
    Wait {
        id: String,
        duration_ms: u64,
    },
    ToolAction {
        id: String,
        target: ToolInstanceId,
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
            StepKind::Output { name, value } => Self::Output {
                name: Some(name.clone()),
                id: step.id().as_str().to_owned(),
                value: InputValueWire::from_input(value),
            },
            StepKind::Wait { duration_ms } => Self::Wait {
                id: step.id().as_str().to_owned(),
                duration_ms: *duration_ms,
            },
            StepKind::ToolAction {
                target,
                action,
                arguments,
                bindings,
            } => Self::ToolAction {
                id: step.id().as_str().to_owned(),
                target: target.clone(),
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
        StepWire::Output { id, name, value } => {
            let name = name.unwrap_or_else(|| id.clone());
            let step_id = StepId::new(&id)
                .map_err(|source| TemplateError::InvalidStepId { value: id, source })?;
            Ok(Step::new(
                step_id,
                StepKind::Output {
                    name,
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
            target,
            action,
            arguments,
            bindings,
        } => {
            let step_id = StepId::new(&id)
                .map_err(|source| TemplateError::InvalidStepId { value: id, source })?;
            let action_id =
                ActionId::new(&action).map_err(|source| TemplateError::InvalidActionId {
                    value: action,
                    source,
                })?;
            Ok(Step::new(
                step_id,
                StepKind::ToolAction {
                    target,
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
        meters_setup::{
            AutoZero, DcvInputImpedance, MetersMeasurement, MetersSetup, MetersSetupError,
            RangeMode,
        },
        tool::ToolId,
        tool_instance::{ToolInstance, ToolInstanceId, ToolSetup},
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
                    target: ToolInstanceId::new("powers-1").unwrap(),
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
                    target: ToolInstanceId::new("meters-1").unwrap(),
                    action: ActionId::new("measure").unwrap(),
                    arguments: json!({}),
                    bindings: Default::default(),
                },
            ),
        ])
        .unwrap();
        let meters_setup = vec![
            ToolInstance {
                id: ToolInstanceId::new("meters-1").unwrap(),
                tool: ToolId::meters(),
                setup: ToolSetup::Meters(MetersSetup {
                    measurement: MetersMeasurement::VoltageDc,
                    range_mode: RangeMode::Manual,
                    manual_range: Some(10.0),
                    nplc: 1.0,
                    auto_zero: AutoZero::Once,
                    dcv_input_impedance: Some(DcvInputImpedance::TenMegohm),
                    current_terminal: None,
                }),
            },
            ToolInstance {
                id: ToolInstanceId::new("powers-1").unwrap(),
                tool: ToolId::powers(),
                setup: Default::default(),
            },
        ];
        Template::new("Power and Meter Test".to_owned(), meters_setup, workflow).unwrap()
    }

    #[test]
    fn template_json_round_trip_preserves_domain_and_wire_shape() {
        let original = sample_template();
        let json = original.to_json_string().unwrap();

        let value: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["schema_version"], TEMPLATE_SCHEMA_VERSION);
        assert_eq!(value["name"], "Power and Meter Test");
        assert_eq!(
            value["tool_instances"][0]["setup"],
            json!({
                "measurement": "voltage-dc",
                "range_mode": "manual",
                "manual_range": 10.0,
                "nplc": 1.0,
                "auto_zero": "once",
                "dcv_input_impedance": "ten-megohm",
                "current_terminal": null
            })
        );
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
        assert_eq!(restored.tool_instances(), original.tool_instances());
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
    fn invalid_setup_is_rejected_by_construction_and_load() {
        let original = sample_template();
        let mut setup = original.tool_instances().to_vec();
        let ToolSetup::Meters(meters) = &mut setup[0].setup else {
            unreachable!()
        };
        meters.manual_range = None;
        let error = Template::new(
            original.name().to_owned(),
            setup,
            original.workflow().clone(),
        )
        .unwrap_err();
        assert!(matches!(
            error,
            TemplateError::MetersSetup { instance, source: MetersSetupError::MissingManualRange }
                if instance == ToolInstanceId::new("meters-1").unwrap()
        ));

        let mut wire: Value = serde_json::from_str(&original.to_json_string().unwrap()).unwrap();
        wire["tool_instances"][0]["setup"]["manual_range"] = Value::Null;
        let error = Template::from_json_str(&wire.to_string()).unwrap_err();
        assert!(matches!(
            error,
            TemplateError::MetersSetup { instance, source: MetersSetupError::MissingManualRange }
                if instance == ToolInstanceId::new("meters-1").unwrap()
        ));
    }

    #[test]
    fn invalid_meters_setup_identifies_the_instance() {
        let original = sample_template();
        let mut instances = original.tool_instances().to_vec();
        let mut invalid = instances[0].clone();
        invalid.id = ToolInstanceId::new("meters-2").unwrap();
        let ToolSetup::Meters(setup) = &mut invalid.setup else {
            unreachable!()
        };
        setup.manual_range = None;

        instances.push(invalid);
        let error = Template::new(
            "Two meters".to_owned(),
            instances,
            Workflow::new(Vec::new()).unwrap(),
        )
        .unwrap_err();

        assert!(matches!(
            &error,
            TemplateError::MetersSetup {
                instance,
                source: MetersSetupError::MissingManualRange,
            } if instance.as_str() == "meters-2"
        ));
        assert!(error.to_string().contains("meters-2"));
        assert!(std::error::Error::source(&error).is_some());
    }

    #[test]
    fn meters_actions_require_setup() {
        for action in ["measure", "unsupported"] {
            let wire = json!({
                "schema_version": 1,
                "name": "Missing setup",
                "tool_instances": [{"id": "meters-1", "tool": "meters", "setup": {}}],
                "workflow": {"steps": [{
                    "type": "tool-action", "id": "read-1", "target": "meters-1",
                    "action": action, "arguments": {}
                }]}
            });
            let error = Template::from_json_str(&wire.to_string()).unwrap_err();
            assert!(matches!(error, TemplateError::Instance(_)));
            assert_eq!(error.to_string(), "invalid setup for meters-1 (meters)");
        }
    }

    #[test]
    fn tool_action_bindings_round_trip() {
        let original = Template::new(
            "Bound voltage".to_owned(),
            vec![ToolInstance {
                id: ToolInstanceId::new("powers-1").unwrap(),
                tool: ToolId::powers(),
                setup: Default::default(),
            }],
            Workflow::new(vec![Step::new(
                StepId::new("power-set-1").unwrap(),
                StepKind::ToolAction {
                    target: ToolInstanceId::new("powers-1").unwrap(),
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
        )
        .unwrap();
        let json = original.to_json_string().unwrap();
        let value: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["schema_version"], 1);
        assert_eq!(value["tool_instances"][0]["setup"], json!({}));
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
            "tool_instances": [],
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
    fn invalid_target_id_is_rejected_from_json() {
        let json = json!({
            "schema_version": 1,
            "tool_instances": [],
            "name": "Bad tool",
            "workflow": {
                "steps": [
                    {
                        "id": "power-set-1",
                        "type": "tool-action",
                        "target": "Meters-1",
                        "action": "set-voltage",
                        "arguments": {}
                    }
                ]
            }
        })
        .to_string();

        let error = Template::from_json_str(&json).unwrap_err();
        assert!(
            matches!(error, TemplateError::Json(_)),
            "unexpected error: {error:?}"
        );
    }

    #[test]
    fn draft_empty_workflow_is_allowed() {
        let template = Template::new(
            "Draft".to_owned(),
            Default::default(),
            Workflow::new(Vec::new()).unwrap(),
        )
        .unwrap();
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
                    name: "output-2".to_owned(),
                    value: InputValue::Variable(variable),
                },
            ),
            Step::new(
                StepId::new("output-step").unwrap(),
                StepKind::Output {
                    name: "output-3".to_owned(),
                    value: InputValue::StepOutput(StepOutputReference::new(step_id, "")),
                },
            ),
        ])
        .unwrap();
        let original = Template::new("Dataflow".to_owned(), Default::default(), workflow).unwrap();
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
            "tool_instances": [],
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
            Default::default(),
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
                        name: "output-4".to_owned(),
                        value: InputValue::Variable(VariableId::new("doubled").unwrap()),
                    },
                ),
            ])
            .unwrap(),
        )
        .unwrap();
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
                    Default::default(),
                    Workflow::new(vec![
                        Step::new(
                            StepId::new("measurement").unwrap(),
                            StepKind::Output {
                                name: "output-5".to_owned(),
                                value: InputValue::Literal(json!({ "value": 3 })),
                            },
                        ),
                        Step::new(
                            StepId::new("output-expression").unwrap(),
                            StepKind::Output {
                                name: "output-6".to_owned(),
                                value: InputValue::Expression(Expression::new(
                                    left.clone(),
                                    operator,
                                    right.clone(),
                                )),
                            },
                        ),
                    ])
                    .unwrap(),
                )
                .unwrap();
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

    #[test]
    fn instance_counts_round_trip_and_invalid_references_are_rejected() {
        let sample = sample_template();
        let mut meters = sample.tool_instances()[0].clone();
        meters.id = ToolInstanceId::new("meters-2").unwrap();
        let ToolSetup::Meters(setup) = &mut meters.setup else {
            unreachable!()
        };
        setup.nplc = 0.2;
        for instances in [
            vec![],
            vec![sample.tool_instances()[0].clone()],
            vec![sample.tool_instances()[0].clone(), meters],
        ] {
            let template = Template::new(
                "Instances".to_owned(),
                instances,
                Workflow::new(vec![]).unwrap(),
            )
            .unwrap();
            assert_eq!(
                Template::from_json_str(&template.to_json_string().unwrap()).unwrap(),
                template
            );
        }
        let duplicate = vec![sample.tool_instances()[0].clone(); 2];
        assert!(
            Template::new(
                "Duplicate".to_owned(),
                duplicate,
                Workflow::new(vec![]).unwrap()
            )
            .unwrap_err()
            .to_string()
            .contains("duplicate tool instance ID")
        );
        assert!(
            Template::new(
                "Missing target".to_owned(),
                vec![],
                sample.workflow().clone()
            )
            .unwrap_err()
            .to_string()
            .contains("unknown tool instance target")
        );
        let mut wire: Value = serde_json::from_str(&sample.to_json_string().unwrap()).unwrap();
        wire["tool_instances"][1]["id"] = json!("meters-1");
        assert!(
            Template::from_json_str(&wire.to_string())
                .unwrap_err()
                .to_string()
                .contains("duplicate tool instance ID")
        );
        wire["tool_instances"][1]["id"] = json!("powers-1");
        wire["workflow"]["steps"][0]["target"] = json!("absent-1");
        assert!(
            Template::from_json_str(&wire.to_string())
                .unwrap_err()
                .to_string()
                .contains("unknown tool instance target")
        );
    }
}
