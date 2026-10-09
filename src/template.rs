use std::{
    collections::{BTreeMap, HashMap},
    error::Error,
    fmt, fs, io,
    path::Path,
};

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use crate::{
    meters_setup::{MetersSetup, MetersSetupError},
    powers_setup::{PowersSetup, PowersSetupError},
    tool::{InvalidToolId, ToolId},
    tool_instance::{EmptySetup, ToolInstance, ToolInstanceId, ToolSetup},
    workflow::{
        ActionId, Expression, ExpressionOperand, ExpressionOperator, InputValue, InvalidActionId,
        InvalidStepId, InvalidVariableId, MessageField, MessageFieldKind, MessageTarget,
        NumericRange, Step, StepId, StepKind, StepOutputReference, VariableId, Workflow,
        WorkflowError,
    },
};

/// Current template file format version.
pub const TEMPLATE_SCHEMA_VERSION: u32 = 1;

const MAX_SAVED_CHARTS: usize = 8;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct OutputViews {
    charts: Vec<SavedChart>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum SavedChartType {
    Line,
    Scatter,
    Column,
    Area,
    Bar,
    Combo,
    Histogram,
    Boxplot,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum ScatterDisplay {
    Markers,
    Lines,
    LinesMarkers,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum LegendPosition {
    Top,
    Bottom,
    Left,
    Right,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum ImageBackground {
    Light,
    Dark,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum MarkerShape {
    Circle,
    Square,
    Diamond,
    Triangle,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum ComboSeriesKind {
    Line,
    Column,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum ComboAxis {
    Left,
    Right,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum HistogramMode {
    Auto,
    Count,
    Width,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct AxisSettings {
    title: String,
    min: Option<f64>,
    max: Option<f64>,
    interval: Option<f64>,
    show_labels: bool,
    show_ticks: bool,
    show_major_grid: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ScatterSettings {
    display: ScatterDisplay,
    marker_size: f64,
    line_width: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct LineSeriesSettings {
    markers: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct MarkerStyleSettings {
    shape: MarkerShape,
    size: f64,
    fill_color: Option<String>,
    border_color: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ComboSeriesSettings {
    kind: ComboSeriesKind,
    axis: ComboAxis,
    markers: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ZoomSettings {
    enabled: bool,
    show_slider: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct HistogramSettings {
    mode: HistogramMode,
    value: Option<f64>,
    show_normal_curve: bool,
    mean: Option<f64>,
    std_dev: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SavedChart {
    page: String,
    title: String,
    outputs: Vec<String>,
    #[serde(rename = "type")]
    chart_type: SavedChartType,
    scatter_x_output: Option<String>,
    scatter: ScatterSettings,
    line: SavedLineSettings,
    marker_styles: BTreeMap<String, MarkerStyleSettings>,
    series_colors: BTreeMap<String, String>,
    show_legend: bool,
    legend_position: LegendPosition,
    image_background: ImageBackground,
    show_all_raw_data: bool,
    zoom: ZoomSettings,
    x_axis: AxisSettings,
    y_axis: AxisSettings,
    combo: SavedComboSettings,
    histogram: HistogramSettings,
    box_plot: SavedBoxPlotSettings,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SavedLineSettings {
    series: BTreeMap<String, LineSeriesSettings>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SavedComboSettings {
    series: BTreeMap<String, ComboSeriesSettings>,
    right_axis: AxisSettings,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SavedBoxPlotSettings {
    show_outliers: bool,
}

/// A persisted workflow template.
#[derive(Clone, Debug, PartialEq)]
pub struct Template {
    name: String,
    tool_instances: Vec<ToolInstance>,
    workflow: Workflow,
    output_views: Option<OutputViews>,
    batch_sources: HashMap<StepId, StepId>,
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
            match &instance.setup {
                ToolSetup::Meters(setup) if instance.tool == ToolId::meters() => {
                    setup
                        .validate()
                        .map_err(|source| TemplateError::MetersSetup {
                            instance: instance.id.clone(),
                            source,
                        })?
                }
                ToolSetup::Powers(setup) if instance.tool == ToolId::powers() => {
                    setup
                        .validate()
                        .map_err(|source| TemplateError::PowersSetup {
                            instance: instance.id.clone(),
                            source,
                        })?
                }
                ToolSetup::Empty(_)
                    if instance.tool != ToolId::meters() && instance.tool != ToolId::powers() => {}
                _ => {
                    return Err(TemplateError::Instance(format!(
                        "invalid setup for {} ({})",
                        instance.id, instance.tool
                    )));
                }
            }
        }
        fn validate(
            steps: &[Step],
            ids: &std::collections::HashSet<&ToolInstanceId>,
        ) -> Option<ToolInstanceId> {
            for step in steps {
                match step.kind() {
                    StepKind::ToolAction { target, .. } if !ids.contains(target) => {
                        return Some(target.clone());
                    }
                    StepKind::For { body, .. } | StepKind::While { body, .. } => {
                        if let Some(target) = validate(body, ids) {
                            return Some(target);
                        }
                    }
                    _ => {}
                }
            }
            None
        }
        if let Some(target) = validate(workflow.steps(), &ids) {
            return Err(TemplateError::Instance(format!(
                "unknown tool instance target {target}"
            )));
        }
        let batch_sources = validate_batch_sources(&workflow, &tool_instances)?;
        Ok(Self {
            name,
            tool_instances,
            workflow,
            output_views: None,
            batch_sources,
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
        fn collect<'a>(
            steps: &[Step],
            template: &'a Template,
            instances: &mut Vec<&'a ToolInstance>,
        ) {
            for step in steps {
                match step.kind() {
                    StepKind::ToolAction { target, .. } => {
                        let instance = template
                            .tool_instances
                            .iter()
                            .find(|i| &i.id == target)
                            .expect("template targets are validated");
                        if !instances.contains(&instance) {
                            instances.push(instance);
                        }
                    }
                    StepKind::For { body, .. } | StepKind::While { body, .. } => {
                        collect(body, template, instances)
                    }
                    _ => {}
                }
            }
        }
        collect(self.workflow.steps(), self, &mut instances);
        instances
    }

    /// Returns the workflow.
    pub fn workflow(&self) -> &Workflow {
        &self.workflow
    }

    pub(crate) fn batch_source_for_step(&self, step_id: &StepId) -> Option<&StepId> {
        self.batch_sources.get(step_id)
    }

    pub(crate) fn batch_size(&self, source: &StepId) -> Option<usize> {
        fn find<'a>(steps: &'a [Step], id: &StepId) -> Option<&'a Step> {
            for step in steps {
                if step.id() == id {
                    return Some(step);
                }
                if let StepKind::For { body, .. } | StepKind::While { body, .. } = step.kind()
                    && let Some(found) = find(body, id)
                {
                    return Some(found);
                }
            }
            None
        }
        let step = find(self.workflow.steps(), source)?;
        let StepKind::ToolAction { target, .. } = step.kind() else {
            return None;
        };
        self.tool_instances
            .iter()
            .find(|instance| &instance.id == target)?
            .meters_setup()
            .map(|setup| setup.sample_count)
    }

    /// Serializes the template to pretty JSON.
    pub fn to_json_string(&self) -> Result<String, TemplateError> {
        let wire = TemplateWire::from_template(self).map_err(TemplateError::Json)?;
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
                let invalid_setup = || {
                    TemplateError::Instance(format!("invalid setup for {} ({tool})", instance.id))
                };
                let setup = if tool == ToolId::meters() {
                    ToolSetup::Meters(
                        serde_json::from_value::<MetersSetup>(instance.setup)
                            .map_err(|_| invalid_setup())?,
                    )
                } else if tool == ToolId::powers() {
                    ToolSetup::Powers(
                        serde_json::from_value::<PowersSetup>(instance.setup)
                            .map_err(|_| invalid_setup())?,
                    )
                } else {
                    ToolSetup::Empty(
                        serde_json::from_value::<EmptySetup>(instance.setup)
                            .map_err(|_| invalid_setup())?,
                    )
                };
                Ok(ToolInstance {
                    id: instance.id,
                    tool,
                    setup,
                })
            })
            .collect::<Result<Vec<_>, TemplateError>>()?;
        let output_views = wire.output_views;
        validate_output_views(&workflow, output_views.as_ref())?;
        let mut template = Self::new(wire.name, instances, workflow)?;
        template.output_views = output_views;
        Ok(template)
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

fn validate_output_views(
    workflow: &Workflow,
    output_views: Option<&OutputViews>,
) -> Result<(), TemplateError> {
    let Some(output_views) = output_views else {
        return Ok(());
    };
    if output_views.charts.len() > MAX_SAVED_CHARTS {
        return Err(TemplateError::OutputViews(format!(
            "at most {MAX_SAVED_CHARTS} charts can be saved with a template"
        )));
    }

    fn validate_axis(label: &str, axis: &AxisSettings) -> Result<(), TemplateError> {
        if let (Some(min), Some(max)) = (axis.min, axis.max)
            && min >= max
        {
            return Err(TemplateError::OutputViews(format!(
                "{label} minimum must be less than maximum"
            )));
        }
        if axis.interval.is_some_and(|interval| interval <= 0.0) {
            return Err(TemplateError::OutputViews(format!(
                "{label} major unit must be greater than zero"
            )));
        }
        Ok(())
    }

    for (index, chart) in output_views.charts.iter().enumerate() {
        let number = index + 1;
        let page = workflow
            .output_pages()
            .iter()
            .find(|page| page.name() == chart.page)
            .ok_or_else(|| {
                TemplateError::OutputViews(format!(
                    "chart {number} references unknown Output Page {:?}",
                    chart.page
                ))
            })?;

        if chart.outputs.is_empty() {
            return Err(TemplateError::OutputViews(format!(
                "chart {number} requires at least one Output"
            )));
        }
        for output in &chart.outputs {
            if !page.headers().contains(output) {
                return Err(TemplateError::OutputViews(format!(
                    "chart {number} references unknown Output {output:?} on Page {:?}",
                    chart.page
                )));
            }
        }
        if chart.chart_type == SavedChartType::Scatter
            && let Some(output) = &chart.scatter_x_output
            && !page.headers().contains(output)
        {
            return Err(TemplateError::OutputViews(format!(
                "chart {number} references unknown scatter X Output {output:?} on Page {:?}",
                chart.page
            )));
        }

        match chart.chart_type {
            SavedChartType::Histogram if chart.outputs.len() != 1 => {
                return Err(TemplateError::OutputViews(format!(
                    "chart {number} Histogram requires exactly one Output"
                )));
            }
            SavedChartType::Combo if chart.outputs.len() < 2 => {
                return Err(TemplateError::OutputViews(format!(
                    "chart {number} Combo requires at least two Outputs"
                )));
            }
            _ => {}
        }

        if chart.scatter.marker_size <= 0.0 {
            return Err(TemplateError::OutputViews(format!(
                "chart {number} marker size must be greater than zero"
            )));
        }
        if chart.scatter.line_width <= 0.0 {
            return Err(TemplateError::OutputViews(format!(
                "chart {number} line width must be greater than zero"
            )));
        }
        if chart.marker_styles.values().any(|style| style.size <= 0.0) {
            return Err(TemplateError::OutputViews(format!(
                "chart {number} marker style size must be greater than zero"
            )));
        }

        validate_axis(&format!("chart {number} X Axis"), &chart.x_axis)?;
        validate_axis(&format!("chart {number} Y Axis"), &chart.y_axis)?;
        validate_axis(
            &format!("chart {number} Right Y Axis"),
            &chart.combo.right_axis,
        )?;

        if chart.chart_type == SavedChartType::Histogram {
            match chart.histogram.mode {
                HistogramMode::Auto => {}
                HistogramMode::Count => {
                    let value = chart.histogram.value.ok_or_else(|| {
                        TemplateError::OutputViews(format!(
                            "chart {number} Histogram bin count is required"
                        ))
                    })?;
                    if value.fract() != 0.0 || !(1.0..=200.0).contains(&value) {
                        return Err(TemplateError::OutputViews(format!(
                            "chart {number} Histogram bin count must be an integer from 1 to 200"
                        )));
                    }
                }
                HistogramMode::Width => {
                    if !chart.histogram.value.is_some_and(|value| value > 0.0) {
                        return Err(TemplateError::OutputViews(format!(
                            "chart {number} Histogram bin width must be greater than zero"
                        )));
                    }
                }
            }
            if chart.histogram.std_dev.is_some_and(|value| value <= 0.0) {
                return Err(TemplateError::OutputViews(format!(
                    "chart {number} normal-curve standard deviation must be greater than zero"
                )));
            }
        }
    }
    Ok(())
}

fn validate_batch_sources(
    workflow: &Workflow,
    instances: &[ToolInstance],
) -> Result<HashMap<StepId, StepId>, TemplateError> {
    fn collect_custom_measures(
        steps: &[Step],
        instances: &[ToolInstance],
        sources: &mut HashMap<StepId, StepId>,
    ) {
        for step in steps {
            match step.kind() {
                StepKind::ToolAction { target, action, .. }
                    if action.as_str() == "measure"
                        && instances.iter().any(|instance| {
                            &instance.id == target
                                && instance
                                    .meters_setup()
                                    .is_some_and(|setup| setup.trigger_mode.is_custom())
                        }) =>
                {
                    sources.insert(step.id().clone(), step.id().clone());
                }
                StepKind::For { body, .. } | StepKind::While { body, .. } => {
                    collect_custom_measures(body, instances, sources)
                }
                _ => {}
            }
        }
    }

    fn input_source(
        input: &InputValue,
        sources: &HashMap<StepId, StepId>,
    ) -> Result<Option<StepId>, String> {
        let reference_source =
            |reference: &StepOutputReference| Ok(sources.get(reference.step_id()).cloned());
        match input {
            InputValue::StepOutput(reference) => reference_source(reference),
            InputValue::Expression(expression) => {
                let operand_source = |operand: &ExpressionOperand| match operand {
                    ExpressionOperand::StepOutput(reference) => reference_source(reference),
                    _ => Ok(None),
                };
                let left = operand_source(expression.left())?;
                let right = operand_source(expression.right())?;
                match (&left, &right) {
                    (Some(left), Some(right)) if left != right => {
                        Err("an expression cannot combine two independent batch sources".to_owned())
                    }
                    _ => Ok(left.or(right)),
                }
            }
            _ => Ok(None),
        }
    }

    fn reject_batch(
        input: &InputValue,
        sources: &HashMap<StepId, StepId>,
        context: &str,
    ) -> Result<(), TemplateError> {
        if input_source(input, sources)
            .map_err(TemplateError::Instance)?
            .is_some()
        {
            return Err(TemplateError::Instance(format!(
                "batch-dependent value cannot be used by {context}; Custom Meters batches are supported only by Output steps"
            )));
        }
        Ok(())
    }

    fn validate_steps(
        steps: &[Step],
        sources: &mut HashMap<StepId, StepId>,
        page_sources: &mut HashMap<String, StepId>,
    ) -> Result<(), TemplateError> {
        for step in steps {
            match step.kind() {
                StepKind::Output { value, .. } => {
                    if let Some(source) =
                        input_source(value, sources).map_err(TemplateError::Instance)?
                    {
                        if let Some(existing) = page_sources.get(step.output_page())
                            && existing != &source
                        {
                            return Err(TemplateError::Instance(format!(
                                "Output Page {:?} depends on more than one independent batch source",
                                step.output_page()
                            )));
                        }
                        page_sources.insert(step.output_page().to_owned(), source.clone());
                        sources.insert(step.id().clone(), source);
                    }
                }
                StepKind::Assert { condition, .. } | StepKind::While { condition, .. } => {
                    reject_batch(
                        &InputValue::Expression(condition.clone()),
                        sources,
                        &format!("step {}", step.id()),
                    )?;
                    if let StepKind::While { body, .. } = step.kind() {
                        validate_steps(body, sources, page_sources)?;
                    }
                }
                StepKind::SetVariable { value, .. } => {
                    reject_batch(value, sources, &format!("step {}", step.id()))?;
                }
                StepKind::ToolAction { bindings, .. } => {
                    for input in bindings.values() {
                        reject_batch(input, sources, &format!("step {}", step.id()))?;
                    }
                }
                StepKind::For { body, .. } => validate_steps(body, sources, page_sources)?,
                StepKind::ShowMessage { fields, .. } => {
                    // Show Message renders one scalar, so batch-dependent values are rejected.
                    for field in fields {
                        if let MessageFieldKind::Output(reference) = field.kind() {
                            reject_batch(
                                &InputValue::StepOutput(reference.clone()),
                                sources,
                                &format!("step {}", step.id()),
                            )?;
                        }
                    }
                }
                StepKind::Wait { .. } => {}
            }
        }
        Ok(())
    }

    let mut sources = HashMap::new();
    collect_custom_measures(workflow.steps(), instances, &mut sources);
    let mut page_sources = HashMap::new();
    validate_steps(workflow.steps(), &mut sources, &mut page_sources)?;
    Ok(sources)
}

#[derive(Debug)]
pub enum TemplateError {
    Instance(String),
    MetersSetup {
        instance: ToolInstanceId,
        source: MetersSetupError,
    },
    PowersSetup {
        instance: ToolInstanceId,
        source: PowersSetupError,
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
    OutputViews(String),
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
            Self::OutputViews(message) => {
                write!(formatter, "template output views error: {message}")
            }
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
            Self::PowersSetup { instance, source } => {
                write!(formatter, "{instance} Powers setup error: {source}")
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
            Self::UnsupportedSchemaVersion { .. } | Self::Instance(_) | Self::OutputViews(_) => {
                None
            }
            Self::InvalidStepId { source, .. } => Some(source),
            Self::InvalidActionId { source, .. } => Some(source),
            Self::InvalidToolId { source, .. } => Some(source),
            Self::MetersSetup { source, .. } => Some(source),
            Self::PowersSetup { source, .. } => Some(source),
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    output_views: Option<OutputViews>,
}

impl TemplateWire {
    fn from_template(template: &Template) -> Result<Self, serde_json::Error> {
        Ok(Self {
            schema_version: TEMPLATE_SCHEMA_VERSION,
            name: template.name.clone(),
            tool_instances: template
                .tool_instances
                .iter()
                .map(|instance| {
                    Ok(ToolInstanceWire {
                        id: instance.id.clone(),
                        tool: instance.tool.as_str().to_owned(),
                        setup: serde_json::to_value(&instance.setup)?,
                    })
                })
                .collect::<Result<_, serde_json::Error>>()?,
            workflow: WorkflowWire::from_workflow(template.workflow()),
            output_views: template.output_views.clone(),
        })
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ToolInstanceWire {
    id: ToolInstanceId,
    tool: String,
    setup: Value,
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
    While {
        id: String,
        left: ExpressionOperandWire,
        operator: ExpressionOperator,
        right: ExpressionOperandWire,
        max_iterations: RequiredNullableUsize,
        steps: Vec<StepWire>,
    },
    Assert {
        id: String,
        left: ExpressionOperandWire,
        operator: ExpressionOperator,
        right: ExpressionOperandWire,
        message: String,
    },
    SetVariable {
        id: String,
        variable: String,
        value: InputValueWire,
    },
    Output {
        id: String,
        name: String,
        page: String,
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
    For {
        id: String,
        variable: String,
        range: NumericRangeWire,
        steps: Vec<StepWire>,
    },
    ShowMessage {
        id: String,
        target: MessageTarget,
        fields: Vec<MessageFieldWire>,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
enum MessageFieldWire {
    Text {
        text: String,
        #[serde(default)]
        newline: bool,
    },
    Output {
        step_id: String,
        #[serde(default)]
        pointer: String,
        #[serde(default)]
        newline: bool,
    },
}

impl MessageFieldWire {
    fn from_field(field: &MessageField) -> Self {
        match field.kind() {
            MessageFieldKind::Text(text) => Self::Text {
                text: text.clone(),
                newline: field.newline(),
            },
            MessageFieldKind::Output(reference) => Self::Output {
                step_id: reference.step_id().as_str().to_owned(),
                pointer: reference.pointer().to_owned(),
                newline: field.newline(),
            },
        }
    }
}

#[derive(Serialize)]
#[serde(transparent)]
struct RequiredNullableUsize(Option<usize>);

impl<'de> Deserialize<'de> for RequiredNullableUsize {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        let limit = serde_json::from_value(value).map_err(serde::de::Error::custom)?;
        Ok(Self(limit))
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct NumericRangeWire {
    start: String,
    stop: String,
    step: String,
}

impl StepWire {
    fn from_step(step: &Step) -> Self {
        match step.kind() {
            StepKind::While {
                condition,
                max_iterations,
                body,
            } => Self::While {
                id: step.id().as_str().to_owned(),
                left: ExpressionOperandWire::from_operand(condition.left()),
                operator: condition.operator(),
                right: ExpressionOperandWire::from_operand(condition.right()),
                max_iterations: RequiredNullableUsize(*max_iterations),
                steps: body.iter().map(StepWire::from_step).collect(),
            },
            StepKind::Assert { condition, message } => Self::Assert {
                id: step.id().as_str().to_owned(),
                left: ExpressionOperandWire::from_operand(condition.left()),
                operator: condition.operator(),
                right: ExpressionOperandWire::from_operand(condition.right()),
                message: message.clone(),
            },
            StepKind::SetVariable { variable, value } => Self::SetVariable {
                id: step.id().as_str().to_owned(),
                variable: variable.as_str().to_owned(),
                value: InputValueWire::from_input(value),
            },
            StepKind::Output { name, value } => Self::Output {
                name: name.clone(),
                page: step.output_page().to_owned(),
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
            StepKind::For {
                variable,
                range,
                body,
            } => Self::For {
                id: step.id().as_str().to_owned(),
                variable: variable.as_str().to_owned(),
                range: NumericRangeWire {
                    start: range.start().to_string(),
                    stop: range.stop().to_string(),
                    step: range.step().to_string(),
                },
                steps: body.iter().map(StepWire::from_step).collect(),
            },
            StepKind::ShowMessage { target, fields } => Self::ShowMessage {
                id: step.id().as_str().to_owned(),
                target: *target,
                fields: fields.iter().map(MessageFieldWire::from_field).collect(),
            },
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "source", rename_all = "kebab-case", deny_unknown_fields)]
enum InputValueWire {
    ElapsedTime,
    Timestamp,
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
            InputValue::ElapsedTime => Self::ElapsedTime,
            InputValue::Timestamp => Self::Timestamp,
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
        InputValueWire::ElapsedTime => Ok(InputValue::ElapsedTime),
        InputValueWire::Timestamp => Ok(InputValue::Timestamp),
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
        StepWire::While {
            id,
            left,
            operator,
            right,
            max_iterations,
            steps,
        } => {
            let step_id = StepId::new(&id)
                .map_err(|source| TemplateError::InvalidStepId { value: id, source })?;
            Ok(Step::new(
                step_id,
                StepKind::While {
                    condition: Expression::new(
                        operand_from_wire(left)?,
                        operator,
                        operand_from_wire(right)?,
                    ),
                    max_iterations: max_iterations.0,
                    body: steps
                        .into_iter()
                        .map(step_from_wire)
                        .collect::<Result<_, _>>()?,
                },
            ))
        }
        StepWire::Assert {
            id,
            left,
            operator,
            right,
            message,
        } => {
            let step_id = StepId::new(&id)
                .map_err(|source| TemplateError::InvalidStepId { value: id, source })?;
            Ok(Step::new(
                step_id,
                StepKind::Assert {
                    condition: Expression::new(
                        operand_from_wire(left)?,
                        operator,
                        operand_from_wire(right)?,
                    ),
                    message,
                },
            ))
        }
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
        StepWire::Output {
            id,
            name,
            page,
            value,
        } => {
            let step_id = StepId::new(&id)
                .map_err(|source| TemplateError::InvalidStepId { value: id, source })?;
            Ok(Step::new(
                step_id,
                StepKind::Output {
                    name,
                    value: input_from_wire(value)?,
                },
            )
            .with_output_page(page))
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
        StepWire::For {
            id,
            variable,
            range,
            steps,
        } => {
            let step_id = StepId::new(&id)
                .map_err(|source| TemplateError::InvalidStepId { value: id, source })?;
            let variable =
                VariableId::new(&variable).map_err(|source| TemplateError::InvalidVariableId {
                    value: variable,
                    source,
                })?;
            let parse = |field: &str, value: &str| {
                rust_decimal::Decimal::from_str_exact(value).map_err(|source| {
                    TemplateError::Workflow(WorkflowError::InvalidRange(format!(
                        "invalid range {field} decimal {value:?}: {source}"
                    )))
                })
            };
            let range = NumericRange::new(
                parse("start", &range.start)?,
                parse("stop", &range.stop)?,
                parse("step", &range.step)?,
            )
            .map_err(|source| {
                TemplateError::Workflow(WorkflowError::InvalidRange(source.to_string()))
            })?;
            let body = steps
                .into_iter()
                .map(step_from_wire)
                .collect::<Result<_, _>>()?;
            Ok(Step::new(
                step_id,
                StepKind::For {
                    variable,
                    range,
                    body,
                },
            ))
        }
        StepWire::ShowMessage { id, target, fields } => {
            let step_id = StepId::new(&id)
                .map_err(|source| TemplateError::InvalidStepId { value: id, source })?;
            let fields = fields
                .into_iter()
                .map(|field| match field {
                    MessageFieldWire::Text { text, newline } => {
                        Ok(MessageField::text(text, newline))
                    }
                    MessageFieldWire::Output {
                        step_id,
                        pointer,
                        newline,
                    } => {
                        let referenced = StepId::new(&step_id).map_err(|source| {
                            TemplateError::InvalidStepId {
                                value: step_id,
                                source,
                            }
                        })?;
                        Ok(MessageField::output(
                            StepOutputReference::new(referenced, pointer),
                            newline,
                        ))
                    }
                })
                .collect::<Result<Vec<_>, TemplateError>>()?;
            Ok(Step::new(step_id, StepKind::ShowMessage { target, fields }))
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
            RangeMode, VmCompSlope,
        },
        powers_setup::PowersSetup,
        tool::ToolId,
        tool_instance::{ToolInstance, ToolInstanceId, ToolSetup},
        workflow::{
            ActionId, Expression, ExpressionOperand, ExpressionOperator, InputValue,
            MessageFieldKind, MessageTarget, NumericRange, Step, StepId, StepKind,
            StepOutputReference, VariableId, Workflow, WorkflowError,
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
                    vm_comp_slope: Some(VmCompSlope::Pos),
                    ..MetersSetup::default()
                }),
            },
            ToolInstance {
                id: ToolInstanceId::new("powers-1").unwrap(),
                tool: ToolId::powers(),
                setup: ToolSetup::Powers(PowersSetup::default()),
            },
        ];
        Template::new("Power and Meter Test".to_owned(), meters_setup, workflow).unwrap()
    }

    fn saved_chart_wire(chart_type: &str, outputs: Vec<&str>) -> Value {
        json!({
            "page": "Results",
            "title": "Voltage Response",
            "outputs": outputs,
            "type": chart_type,
            "scatter_x_output": null,
            "scatter": {"display": "markers", "marker_size": 4.0, "line_width": 2.0},
            "line": {"series": {}},
            "marker_styles": {},
            "series_colors": {},
            "show_legend": true,
            "legend_position": "top",
            "image_background": "light",
            "show_all_raw_data": false,
            "zoom": {"enabled": false, "show_slider": true},
            "x_axis": {
                "title": "Iteration", "min": null, "max": null, "interval": null,
                "show_labels": true, "show_ticks": true, "show_major_grid": false
            },
            "y_axis": {
                "title": "Voltage (V)", "min": 0.0, "max": 5.0, "interval": 1.0,
                "show_labels": true, "show_ticks": true, "show_major_grid": true
            },
            "combo": {
                "series": {},
                "right_axis": {
                    "title": "", "min": null, "max": null, "interval": null,
                    "show_labels": true, "show_ticks": true, "show_major_grid": false
                }
            },
            "histogram": {
                "mode": "auto", "value": null, "show_normal_curve": false,
                "mean": null, "std_dev": null
            },
            "box_plot": {"show_outliers": true}
        })
    }

    fn chart_template_wire() -> Value {
        json!({
            "schema_version": 1,
            "name": "Chart Template",
            "tool_instances": [],
            "workflow": {"steps": [
                {
                    "type": "output", "id": "voltage", "name": "Voltage", "page": "Results",
                    "value": {"source": "literal", "value": 3.3}
                },
                {
                    "type": "output", "id": "current", "name": "Current", "page": "Results",
                    "value": {"source": "literal", "value": 0.1}
                }
            ]},
            "output_views": {"charts": [saved_chart_wire("line", vec!["Voltage"])]}
        })
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
                "current_terminal": null,
                "vm_comp_slope": "pos"
            })
        );
        assert_eq!(value["workflow"]["steps"][0]["type"], "tool-action");
        assert_eq!(value["workflow"]["steps"][0]["id"], "power-set-1");
        assert!(value["workflow"]["steps"][0].get("bindings").is_none());
        assert!(value["workflow"]["steps"][2].get("bindings").is_none());
        assert_eq!(value["workflow"]["steps"][1]["type"], "wait");
        assert_eq!(value["workflow"]["steps"][1]["duration_ms"], 500);
        assert_eq!(value["workflow"]["steps"][2]["type"], "tool-action");
        assert_eq!(value["tool_instances"][1]["setup"], json!({}));

        let restored = Template::from_json_str(&json).unwrap();
        assert_eq!(
            restored.tool_instances()[1].powers_setup(),
            Some(&PowersSetup::default())
        );
        assert!(restored.tool_instances()[1].meters_setup().is_none());
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
    fn output_views_are_optional_and_round_trip_when_present() {
        let plain: Value =
            serde_json::from_str(&sample_template().to_json_string().unwrap()).unwrap();
        assert!(plain.get("output_views").is_none());

        let wire = chart_template_wire();
        let template = Template::from_json_str(&wire.to_string()).unwrap();
        let serialized: Value = serde_json::from_str(&template.to_json_string().unwrap()).unwrap();
        assert_eq!(serialized["output_views"], wire["output_views"]);
        assert_eq!(
            Template::from_json_str(&serialized.to_string()).unwrap(),
            template
        );
    }

    #[test]
    fn output_views_reject_invalid_chart_references_and_constraints() {
        let mut unknown_page = chart_template_wire();
        unknown_page["output_views"]["charts"][0]["page"] = json!("Missing");
        assert!(
            Template::from_json_str(&unknown_page.to_string())
                .unwrap_err()
                .to_string()
                .contains("unknown Output Page")
        );

        let mut unknown_output = chart_template_wire();
        unknown_output["output_views"]["charts"][0]["outputs"] = json!(["Missing"]);
        assert!(
            Template::from_json_str(&unknown_output.to_string())
                .unwrap_err()
                .to_string()
                .contains("unknown Output")
        );

        let mut invalid_combo = chart_template_wire();
        invalid_combo["output_views"]["charts"][0]["type"] = json!("combo");
        assert!(
            Template::from_json_str(&invalid_combo.to_string())
                .unwrap_err()
                .to_string()
                .contains("Combo requires at least two Outputs")
        );

        let mut invalid_marker = chart_template_wire();
        invalid_marker["output_views"]["charts"][0]["scatter"]["marker_size"] = json!(0);
        assert!(
            Template::from_json_str(&invalid_marker.to_string())
                .unwrap_err()
                .to_string()
                .contains("marker size must be greater than zero")
        );

        let mut too_many = chart_template_wire();
        too_many["output_views"]["charts"] = Value::Array(
            (0..9)
                .map(|_| saved_chart_wire("line", vec!["Voltage"]))
                .collect(),
        );
        assert!(
            Template::from_json_str(&too_many.to_string())
                .unwrap_err()
                .to_string()
                .contains("at most 8 charts")
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
    fn invalid_powers_setup_identifies_the_instance() {
        let original = sample_template();
        let mut instances = original.tool_instances().to_vec();
        instances[1].setup = ToolSetup::Powers(
            serde_json::from_value(json!({
                "protection": {"channels": [{"channel": 1, "ocp": "on"},
                    {"channel": 1, "ocp": "off"}]}
            }))
            .unwrap(),
        );
        let error = Template::new(
            original.name().to_owned(),
            instances,
            original.workflow().clone(),
        )
        .unwrap_err();
        assert!(matches!(error, TemplateError::PowersSetup { instance, .. }
            if instance == ToolInstanceId::new("powers-1").unwrap()));
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
    fn setup_parsing_uses_tool_type_and_preserves_empty_shapes() {
        let mut wire: Value =
            serde_json::from_str(&sample_template().to_json_string().unwrap()).unwrap();
        for tool in ["powers", "scopes", "wavegen"] {
            wire["tool_instances"] = json!([{
                "id": "tool-1", "tool": tool, "setup": {}
            }]);
            wire["workflow"]["steps"] = json!([]);
            let parsed = Template::from_json_str(&wire.to_string()).unwrap();
            assert_eq!(
                parsed.tool_instances()[0].powers_setup().is_some(),
                tool == "powers"
            );
            let serialized: Value =
                serde_json::from_str(&parsed.to_json_string().unwrap()).unwrap();
            assert_eq!(serialized["schema_version"], 1);
            assert_eq!(serialized["tool_instances"][0]["setup"], json!({}));
            assert_eq!(
                Template::from_json_str(&serialized.to_string()).unwrap(),
                parsed
            );
        }

        let meter_wire: Value =
            serde_json::from_str(&sample_template().to_json_string().unwrap()).unwrap();
        wire["tool_instances"] = json!([{
            "id": "tool-1", "tool": "powers",
            "setup": meter_wire["tool_instances"][0]["setup"]
        }]);
        assert!(Template::from_json_str(&wire.to_string()).is_err());
        wire["tool_instances"][0]["tool"] = json!("meters");
        wire["tool_instances"][0]["setup"] = json!({});
        assert!(Template::from_json_str(&wire.to_string()).is_err());
    }

    #[test]
    fn construction_rejects_setup_tool_mismatches() {
        let original = sample_template();
        for (tool, setup) in [
            (ToolId::powers(), original.tool_instances()[0].setup.clone()),
            (ToolId::meters(), ToolSetup::Powers(PowersSetup::default())),
            (ToolId::powers(), ToolSetup::default()),
        ] {
            let instance = ToolInstance {
                id: ToolInstanceId::new("tool-1").unwrap(),
                tool,
                setup,
            };
            assert!(matches!(
                Template::new(
                    "Mismatch".to_owned(),
                    vec![instance],
                    Workflow::new(vec![]).unwrap()
                ),
                Err(TemplateError::Instance(_))
            ));
        }
    }

    #[test]
    fn tool_action_bindings_round_trip() {
        let original = Template::new(
            "Bound voltage".to_owned(),
            vec![ToolInstance {
                id: ToolInstanceId::new("powers-1").unwrap(),
                tool: ToolId::powers(),
                setup: ToolSetup::Powers(PowersSetup::default()),
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
        assert_eq!(value["workflow"]["steps"][0]["action"], "set-voltage");
        let binding = &value["workflow"]["steps"][0]["bindings"]["voltage"];
        assert_eq!(binding["source"], "variable");
        assert_eq!(binding["variable"], "x");
        assert_eq!(Template::from_json_str(&json).unwrap(), original);
    }

    #[test]
    fn assert_template_round_trip_and_operator_validation() {
        let assertion = json!({
            "type": "assert", "id": "assert-1",
            "left": { "source": "step-output", "step_id": "meter-read-1", "pointer": "/value" },
            "operator": "greater-than-or-equal",
            "right": { "source": "variable", "variable": "threshold" },
            "message": "Voltage is below minimum."
        });
        let mut wire: Value =
            serde_json::from_str(&sample_template().to_json_string().unwrap()).unwrap();
        wire["workflow"]["steps"]
            .as_array_mut()
            .unwrap()
            .push(assertion.clone());
        let template = Template::from_json_str(&wire.to_string()).unwrap();
        let serialized: Value = serde_json::from_str(&template.to_json_string().unwrap()).unwrap();
        assert_eq!(serialized["schema_version"], 1);
        assert_eq!(serialized["workflow"]["steps"][3], assertion);
        assert!(
            matches!(template.workflow().steps()[3].kind(), StepKind::Assert { condition, message }
            if condition.operator() == ExpressionOperator::GreaterThanOrEqual
                && condition.left() == &ExpressionOperand::StepOutput(StepOutputReference::new(
                    StepId::new("meter-read-1").unwrap(), "/value"))
                && condition.right() == &ExpressionOperand::Variable(VariableId::new("threshold").unwrap())
                && message == "Voltage is below minimum.")
        );
        let test_dir = TestDir::new();
        let path = test_dir.path().join("assert.json");
        template.save_to_file(&path).unwrap();
        assert_eq!(Template::load_from_file(&path).unwrap(), template);

        for (operator, expected) in [
            ("equal", ExpressionOperator::Equal),
            ("not-equal", ExpressionOperator::NotEqual),
        ] {
            wire["workflow"]["steps"][3]["operator"] = json!(operator);
            let template = Template::from_json_str(&wire.to_string()).unwrap();
            let serialized: Value =
                serde_json::from_str(&template.to_json_string().unwrap()).unwrap();
            assert_eq!(serialized["schema_version"], 1);
            assert_eq!(serialized["workflow"]["steps"][3]["operator"], operator);
            assert!(
                matches!(template.workflow().steps()[3].kind(), StepKind::Assert { condition, .. }
                if condition.operator() == expected)
            );

            let mut while_wire = wire.clone();
            while_wire["workflow"]["steps"][3] = json!({
                "type": "while", "id": "while-1",
                "left": { "source": "literal", "value": false },
                "operator": operator,
                "right": { "source": "literal", "value": false },
                "max_iterations": 1,
                "steps": []
            });
            let while_template = Template::from_json_str(&while_wire.to_string()).unwrap();
            let serialized: Value =
                serde_json::from_str(&while_template.to_json_string().unwrap()).unwrap();
            assert_eq!(serialized["schema_version"], 1);
            assert_eq!(serialized["workflow"]["steps"][3]["operator"], operator);
        }

        wire["workflow"]["steps"][3]["operator"] = json!("add");
        assert!(matches!(
            Template::from_json_str(&wire.to_string()),
            Err(TemplateError::Workflow(
                crate::workflow::WorkflowError::InvalidAssertOperator(_)
            ))
        ));
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
    fn time_input_sources_round_trip_in_schema_one() {
        for (source, expected) in [
            ("elapsed-time", InputValue::ElapsedTime),
            ("timestamp", InputValue::Timestamp),
        ] {
            let wire = json!({
                "schema_version": 1, "name": "Time inputs", "tool_instances": [],
                "workflow": { "steps": [
                    { "type": "set-variable", "id": "set-time", "variable": "time", "value": { "source": source } },
                    { "type": "output", "id": "out", "name": "time", "page": "Results", "value": { "source": source } }
                ] }
            });
            let template = Template::from_json_str(&wire.to_string()).unwrap();
            for step in template.workflow().steps() {
                match step.kind() {
                    StepKind::SetVariable { value, .. } | StepKind::Output { value, .. } => {
                        assert_eq!(value, &expected)
                    }
                    _ => panic!("unexpected step"),
                }
            }
            let saved = template.to_json_string().unwrap();
            assert_eq!(serde_json::from_str::<Value>(&saved).unwrap(), wire);
            assert_eq!(Template::from_json_str(&saved).unwrap(), template);
        }
    }

    #[test]
    fn show_message_round_trips_in_schema_one_without_storing_records() {
        let wire = json!({
            "schema_version": 1, "name": "Messages", "tool_instances": [],
            "workflow": { "steps": [
                { "type": "output", "id": "iteration", "name": "Iteration", "page": "Results",
                  "value": { "source": "literal", "value": 3000 } },
                { "type": "show-message", "id": "show-message-1", "target": "message-2",
                  "fields": [
                    { "kind": "text", "text": "Iteration: ", "newline": false },
                    { "kind": "output", "step_id": "iteration", "pointer": "", "newline": true }
                ] }
            ] }
        });
        let template = Template::from_json_str(&wire.to_string()).unwrap();

        let StepKind::ShowMessage { target, fields } = template.workflow().steps()[1].kind() else {
            panic!("expected a show-message step")
        };
        assert_eq!(*target, MessageTarget::Message2);
        assert_eq!(fields.len(), 2);
        assert!(matches!(fields[0].kind(), MessageFieldKind::Text(text) if text == "Iteration: "));
        assert!(!fields[0].newline());
        assert!(
            matches!(fields[1].kind(), MessageFieldKind::Output(reference)
            if reference.step_id().as_str() == "iteration" && reference.pointer().is_empty())
        );
        assert!(fields[1].newline());

        // The canonical save is byte-identical and reloads to an equal template.
        let saved = template.to_json_string().unwrap();
        assert_eq!(serde_json::from_str::<Value>(&saved).unwrap(), wire);
        assert_eq!(Template::from_json_str(&saved).unwrap(), template);

        // A reference to a later step is rejected by the shared validation.
        let invalid = json!({
            "schema_version": 1, "name": "Messages", "tool_instances": [],
            "workflow": { "steps": [
                { "type": "show-message", "id": "show-message-1", "target": "message-1",
                  "fields": [ { "kind": "output", "step_id": "later", "pointer": "", "newline": false } ] },
                { "type": "output", "id": "later", "name": "Later", "page": "Results",
                  "value": { "source": "literal", "value": 1 } }
            ] }
        });
        assert!(matches!(
            Template::from_json_str(&invalid.to_string()),
            Err(TemplateError::Workflow(
                WorkflowError::InvalidStepOutputReference { .. }
            ))
        ));
    }

    #[test]
    fn output_requires_name_and_page_and_round_trips_them() {
        let output = json!({
            "type": "output", "id": "out", "name": "Voltage", "page": "Measurements",
            "value": { "source": "literal", "value": 3.3 }
        });
        let template_wire = |output: Value| {
            json!({
                "schema_version": 1, "name": "Required Output fields", "tool_instances": [],
                "workflow": { "steps": [output] }
            })
        };

        let template = Template::from_json_str(&template_wire(output.clone()).to_string()).unwrap();
        let saved: Value = serde_json::from_str(&template.to_json_string().unwrap()).unwrap();
        assert_eq!(saved["workflow"]["steps"][0], output);

        for field in ["name", "page"] {
            let mut missing = output.clone();
            missing.as_object_mut().unwrap().remove(field);
            assert!(matches!(
                Template::from_json_str(&template_wire(missing).to_string()),
                Err(TemplateError::Json(_))
            ));
        }
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

    #[test]
    fn for_template_round_trip_and_recursive_tool_validation() {
        let workflow = Workflow::new(vec![Step::new(
            StepId::new("sweep").unwrap(),
            StepKind::For {
                variable: VariableId::new("voltage").unwrap(),
                range: NumericRange::new(
                    0.into(),
                    rust_decimal::Decimal::new(3, 1),
                    rust_decimal::Decimal::new(1, 1),
                )
                .unwrap(),
                body: vec![
                    Step::new(
                        StepId::new("measure").unwrap(),
                        StepKind::ToolAction {
                            target: ToolInstanceId::new("meters-1").unwrap(),
                            action: ActionId::new("measure").unwrap(),
                            arguments: json!({}),
                            bindings: [(
                                "voltage".to_owned(),
                                InputValue::Variable(VariableId::new("voltage").unwrap()),
                            )]
                            .into(),
                        },
                    ),
                    Step::new(
                        StepId::new("output").unwrap(),
                        StepKind::Output {
                            name: "voltage".to_owned(),
                            value: InputValue::Variable(VariableId::new("voltage").unwrap()),
                        },
                    ),
                ],
            },
        )])
        .unwrap();
        let instances = vec![sample_template().tool_instances()[0].clone()];
        let template = Template::new("For".to_owned(), instances, workflow).unwrap();
        let wire: Value = serde_json::from_str(&template.to_json_string().unwrap()).unwrap();
        assert_eq!(wire["schema_version"], 1);
        assert_eq!(wire["workflow"]["steps"][0]["type"], "for");
        assert_eq!(
            wire["workflow"]["steps"][0]["range"],
            json!({"start": "0", "stop": "0.3", "step": "0.1"})
        );
        let parsed = Template::from_json_str(&wire.to_string()).unwrap();
        let reparsed = Template::from_json_str(&parsed.to_json_string().unwrap()).unwrap();
        assert_eq!(parsed, reparsed);
        let StepKind::For { range, .. } = reparsed.workflow().steps()[0].kind() else {
            panic!("expected For")
        };
        assert_eq!(range.iteration_count(), 4);
        for index in 0..4 {
            assert_eq!(
                range.value_at(index),
                Some(rust_decimal::Decimal::new(index as i64, 1))
            );
        }
        assert_eq!(range.value_at(4), None);
        assert_eq!(
            Template::from_json_str(&wire.to_string()).unwrap(),
            template
        );
        assert_eq!(
            template.referenced_tool_instances()[0].id.as_str(),
            "meters-1"
        );
    }

    #[test]
    fn for_template_rejects_unknown_recursive_tool_target() {
        let mut wire: Value =
            serde_json::from_str(&sample_template().to_json_string().unwrap()).unwrap();
        wire["workflow"]["steps"] = json!([{
            "type": "for",
            "id": "sweep",
            "variable": "voltage",
            "range": {"start": "1", "stop": "2", "step": "1"},
            "steps": [{
                "type": "tool-action",
                "id": "measure",
                "target": "missing-instance",
                "action": "measure",
                "arguments": {}
            }]
        }]);

        let error = Template::from_json_str(&wire.to_string()).unwrap_err();
        assert!(error.to_string().contains("unknown tool instance target"));
        assert!(error.to_string().contains("missing-instance"));
    }

    #[test]
    fn for_template_requires_exact_decimal_strings() {
        let mut wire: Value =
            serde_json::from_str(&sample_template().to_json_string().unwrap()).unwrap();
        wire["workflow"]["steps"] = json!([{
            "type": "for", "id": "sweep", "variable": "voltage",
            "range": {"start": "0", "stop": "0.3", "step": "0.1"}, "steps": []
        }]);
        for field in ["start", "stop", "step"] {
            let original = wire["workflow"]["steps"][0]["range"][field].clone();
            for invalid in [
                json!(0.1),
                json!("invalid"),
                json!("0.00000000000000000000000000001"),
                json!("79228162514264337593543950336"),
            ] {
                wire["workflow"]["steps"][0]["range"][field] = invalid;
                assert!(Template::from_json_str(&wire.to_string()).is_err());
            }
            wire["workflow"]["steps"][0]["range"][field] = original;
        }
    }
}
