use std::{error::Error, fmt, fs, io, path::Path};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    tool::{InvalidToolId, ToolId},
    workflow::{
        ActionId, InvalidActionId, InvalidStepId, Step, StepId, StepKind, Workflow, WorkflowError,
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
        let wire: TemplateWire = serde_json::from_str(json).map_err(TemplateError::Json)?;

        if wire.schema_version != TEMPLATE_SCHEMA_VERSION {
            return Err(TemplateError::UnsupportedSchemaVersion {
                expected: TEMPLATE_SCHEMA_VERSION,
                found: wire.schema_version,
            });
        }

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
    Wait {
        id: String,
        duration_ms: u64,
    },
    ToolAction {
        id: String,
        tool: String,
        action: String,
        arguments: Value,
    },
}

impl StepWire {
    fn from_step(step: &Step) -> Self {
        match step.kind() {
            StepKind::Wait { duration_ms } => Self::Wait {
                id: step.id().as_str().to_owned(),
                duration_ms: *duration_ms,
            },
            StepKind::ToolAction {
                tool,
                action,
                arguments,
            } => Self::ToolAction {
                id: step.id().as_str().to_owned(),
                tool: tool.as_str().to_owned(),
                action: action.as_str().to_owned(),
                arguments: arguments.clone(),
            },
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
        workflow::{ActionId, Step, StepId, StepKind, Workflow},
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
            "name": "Future",
            "workflow": { "steps": [] }
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
}
