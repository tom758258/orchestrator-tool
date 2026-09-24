use std::{
    collections::{BTreeMap, HashMap, HashSet},
    io::{self, Write},
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicU64, Ordering},
    },
};

use orchestrator_tool::{
    template::Template,
    workflow::{ForIteration, ResultRow, StepExecution, StepOutcome, WhileIteration},
};
use serde::Serialize;
use serde_json::{Map, Value};

const PREVIEW_BYTES: usize = 2_048;
const PREVIEW_STRING_CHARS: usize = 512;
const CHART_SERIES_MAX_ROWS: usize = 25_000;

#[derive(Clone, Debug, Serialize)]
pub struct ForIterationDto {
    pub for_step_id: String,
    pub iteration_index: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct WhileIterationDto {
    pub while_step_id: String,
    pub iteration_index: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct WorkflowOutputDto {
    pub name: String,
    pub value: Value,
}

#[derive(Clone, Debug, Serialize)]
pub struct ResultRowDto {
    pub page: String,
    pub outputs: Vec<WorkflowOutputDto>,
    pub for_iteration: Option<ForIterationDto>,
    pub while_iteration: Option<WhileIterationDto>,
}

#[derive(Clone, Debug, Serialize)]
pub struct CompactExecutionDto {
    pub step_id: String,
    pub status: String,
    pub output: Option<Value>,
    pub output_omitted: bool,
    pub message: Option<String>,
    pub for_iteration: Option<ForIterationDto>,
    pub while_iteration: Option<WhileIterationDto>,
}

#[derive(Clone, Debug, Serialize)]
pub struct StepSummaryDto {
    pub step_id: String,
    pub status: String,
    pub has_occurrence: bool,
    pub any_failed: bool,
    pub all_succeeded: bool,
    pub any_cancelled: bool,
    pub output: Option<Value>,
    pub output_omitted: bool,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct NumericSummaryDto {
    pub name: String,
    pub count: usize,
    pub min: f64,
    pub max: f64,
    pub avg: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct PageMetadataDto {
    pub name: String,
    pub output_names: Vec<String>,
    pub row_count: usize,
    pub revision: u64,
    pub iteration_rows: bool,
    pub numeric_outputs: Vec<String>,
    pub summaries: Vec<NumericSummaryDto>,
}

#[derive(Clone, Debug, Serialize)]
pub struct RunMetadataDto {
    pub run_id: u64,
    pub status: String,
    pub error: Option<String>,
    pub manual_exportable: bool,
    pub execution_count: usize,
    pub execution_revision: u64,
    pub latest_execution: Option<CompactExecutionDto>,
    pub pages: Vec<PageMetadataDto>,
    pub step_summaries: Vec<StepSummaryDto>,
}

#[derive(Serialize)]
pub struct PageRowsDto {
    pub run_id: u64,
    pub page: String,
    pub revision: u64,
    pub total_rows: usize,
    pub offset: usize,
    pub rows: Vec<ResultRowDto>,
}

#[derive(Serialize)]
pub struct ExecutionRowsDto {
    pub run_id: u64,
    pub total_executions: usize,
    pub offset: usize,
    pub executions: Vec<CompactExecutionDto>,
}

#[derive(Serialize)]
pub struct ChartSeriesDto {
    pub run_id: u64,
    pub page: String,
    pub start_row: usize,
    pub row_count: usize,
    pub series: BTreeMap<String, Vec<f64>>,
}

#[derive(Serialize)]
pub struct HistogramBinDto {
    pub start: f64,
    pub end: f64,
    pub count: usize,
}

#[derive(Serialize)]
pub struct HistogramDto {
    pub run_id: u64,
    pub page: String,
    pub output: String,
    pub sample_count: usize,
    pub bins: Vec<HistogramBinDto>,
}

#[derive(Serialize)]
pub struct BoxPlotItemDto {
    pub output: String,
    pub count: usize,
    pub lower_whisker: f64,
    pub q1: f64,
    pub median: f64,
    pub q3: f64,
    pub upper_whisker: f64,
    pub outliers: Vec<f64>,
}

#[derive(Serialize)]
pub struct BoxPlotDto {
    pub run_id: u64,
    pub page: String,
    pub items: Vec<BoxPlotItemDto>,
}

#[derive(Clone, Default)]
pub struct StoredRuns {
    next_run_id: Arc<AtomicU64>,
    current: Arc<Mutex<Option<Arc<RwLock<StoredRun>>>>>,
}

impl StoredRuns {
    pub fn begin(&self, template: Template) -> Arc<RwLock<StoredRun>> {
        let run_id = self.next_run_id.fetch_add(1, Ordering::Relaxed) + 1;
        let run = Arc::new(RwLock::new(StoredRun::new(run_id, template)));
        *self.current.lock().unwrap() = Some(run.clone());
        run
    }

    #[cfg(test)]
    pub fn get(&self, run_id: u64) -> Result<Arc<RwLock<StoredRun>>, String> {
        self.current_handle(run_id)
    }

    fn current_handle(&self, run_id: u64) -> Result<Arc<RwLock<StoredRun>>, String> {
        let run = self
            .current
            .lock()
            .unwrap()
            .as_ref()
            .cloned()
            .ok_or_else(|| "There is no stored workflow run".to_owned())?;
        if run.read().unwrap().run_id != run_id {
            return Err(format!("Workflow run {run_id} is no longer current"));
        }
        Ok(run)
    }

    pub fn with_current<T>(
        &self,
        run_id: u64,
        query: impl FnOnce(&StoredRun) -> T,
    ) -> Result<T, String> {
        let run = self.current_handle(run_id)?;
        let result = {
            let guard = run.read().unwrap();
            query(&guard)
        };
        let still_current = self
            .current
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, &run));
        if !still_current {
            return Err(format!("Workflow run {run_id} is no longer current"));
        }
        Ok(result)
    }

    pub fn clear_current(&self) {
        *self.current.lock().unwrap() = None;
    }

    pub fn clear(&self, run_id: u64) -> Result<(), String> {
        let mut current = self.current.lock().unwrap();
        let Some(run) = current.as_ref() else {
            return Ok(());
        };
        if run.read().unwrap().run_id != run_id {
            return Err(format!("Workflow run {run_id} is no longer current"));
        }
        *current = None;
        Ok(())
    }
}

pub struct StoredRun {
    pub run_id: u64,
    pub template: Template,
    status: RunStatus,
    executions: Vec<CompactExecutionDto>,
    execution_revision: u64,
    all_executions_succeeded: bool,
    root_steps_completed: HashSet<String>,
    step_summaries: BTreeMap<String, StepSummary>,
    pages: BTreeMap<String, StoredPage>,
}

enum RunStatus {
    Running,
    Succeeded,
    Failed(String),
}

struct StepSummary {
    any_failed: bool,
    all_succeeded: bool,
    any_cancelled: bool,
    latest: CompactExecutionDto,
}

struct StoredPage {
    output_names: Vec<String>,
    rows: Vec<ResultRow>,
    revision: u64,
    iteration_rows: bool,
    numeric_eligible: HashMap<String, bool>,
    summaries: BTreeMap<String, NumericAccumulator>,
}

struct NumericAccumulator {
    count: usize,
    min: f64,
    max: f64,
    avg: f64,
}

impl StoredRun {
    fn new(run_id: u64, template: Template) -> Self {
        let mut pages = BTreeMap::new();
        for page in template.workflow().output_pages() {
            pages.insert(
                page.name().to_owned(),
                StoredPage::new(page.headers().to_vec()),
            );
        }
        if pages.is_empty() {
            pages.insert("Results".to_owned(), StoredPage::new(Vec::new()));
        }
        Self {
            run_id,
            template,
            status: RunStatus::Running,
            executions: Vec::new(),
            execution_revision: 0,
            all_executions_succeeded: true,
            root_steps_completed: HashSet::new(),
            step_summaries: BTreeMap::new(),
            pages,
        }
    }

    pub fn append_event(&mut self, event: &orchestrator_tool::workflow::WorkflowRunEvent) {
        match event {
            orchestrator_tool::workflow::WorkflowRunEvent::StepCompleted(execution) => {
                self.append_execution(execution)
            }
            orchestrator_tool::workflow::WorkflowRunEvent::ResultRowCommitted(row) => {
                if let Some(page) = self.pages.get_mut(row.page()) {
                    page.append(row.clone());
                }
            }
        }
    }

    fn append_execution(&mut self, execution: &StepExecution) {
        let compact = compact_execution(execution);
        let succeeded = compact.status == "succeeded";
        let failed = compact.status == "failed";
        let cancelled = compact.status == "cancelled";
        self.all_executions_succeeded &= succeeded;
        if compact.for_iteration.is_none() && compact.while_iteration.is_none() {
            self.root_steps_completed.insert(compact.step_id.clone());
        }
        self.step_summaries
            .entry(compact.step_id.clone())
            .and_modify(|summary| {
                summary.any_failed |= failed;
                summary.all_succeeded &= succeeded;
                summary.any_cancelled |= cancelled;
                summary.latest = compact.clone();
            })
            .or_insert_with(|| StepSummary {
                any_failed: failed,
                all_succeeded: succeeded,
                any_cancelled: cancelled,
                latest: compact.clone(),
            });
        self.executions.push(compact);
        self.execution_revision += 1;
    }

    pub fn succeed(&mut self) {
        self.status = RunStatus::Succeeded;
    }

    pub fn fail(&mut self, message: impl Into<String>) {
        let message = message.into();
        self.status = RunStatus::Failed(bounded_text(&message));
    }

    pub fn succeeded(&self) -> bool {
        matches!(self.status, RunStatus::Succeeded)
    }

    pub fn completed_successfully(&self) -> bool {
        self.all_executions_succeeded
            && self
                .template
                .workflow()
                .steps()
                .iter()
                .all(|step| self.root_steps_completed.contains(step.id().as_str()))
    }

    pub fn manual_exportable(&self) -> bool {
        self.succeeded() && self.completed_successfully()
    }

    pub fn metadata(&self) -> RunMetadataDto {
        let (status, error) = match &self.status {
            RunStatus::Running => ("running", None),
            RunStatus::Succeeded => ("succeeded", None),
            RunStatus::Failed(message) => ("failed", Some(message.clone())),
        };
        RunMetadataDto {
            run_id: self.run_id,
            status: status.to_owned(),
            error,
            manual_exportable: self.manual_exportable(),
            execution_count: self.executions.len(),
            execution_revision: self.execution_revision,
            latest_execution: self.executions.last().cloned(),
            pages: self
                .pages
                .iter()
                .map(|(name, page)| page.metadata(name))
                .collect(),
            step_summaries: self
                .step_summaries
                .iter()
                .map(|(step_id, summary)| summary.dto(step_id))
                .collect(),
        }
    }

    pub fn page_rows(
        &self,
        page: &str,
        offset: usize,
        limit: usize,
    ) -> Result<PageRowsDto, String> {
        let page_data = self
            .pages
            .get(page)
            .ok_or_else(|| format!("Unknown Output Page {page:?}"))?;
        let total = page_data.rows.len();
        let revision = page_data.revision;
        let limit = limit.min(1_000);
        let end = total.saturating_sub(offset);
        let start = end.saturating_sub(limit);
        let rows = page_data.rows[start..end]
            .iter()
            .rev()
            .map(result_row_dto)
            .collect();
        Ok(PageRowsDto {
            run_id: self.run_id,
            page: page.to_owned(),
            revision,
            total_rows: total,
            offset,
            rows,
        })
    }

    pub fn executions(&self, offset: usize, limit: usize) -> ExecutionRowsDto {
        ExecutionRowsDto {
            run_id: self.run_id,
            total_executions: self.executions.len(),
            offset,
            executions: {
                let total = self.executions.len();
                let end = total.saturating_sub(offset);
                let start = end.saturating_sub(limit.min(1_000));
                self.executions[start..end].iter().rev().cloned().collect()
            },
        }
    }

    pub fn chart_series(
        &self,
        page: &str,
        outputs: &[String],
        start_row: usize,
        limit: usize,
    ) -> Result<ChartSeriesDto, String> {
        let page_data = self
            .pages
            .get(page)
            .ok_or_else(|| format!("Unknown Output Page {page:?}"))?;
        if start_row > page_data.rows.len() {
            return Err("Chart start row exceeds the current row count".to_owned());
        }
        if limit == 0 {
            return Err("Chart series limit must be greater than zero".to_owned());
        }
        let end_row = start_row
            .saturating_add(limit.min(CHART_SERIES_MAX_ROWS))
            .min(page_data.rows.len());
        let mut series = BTreeMap::new();
        for name in outputs {
            if !page_data
                .numeric_eligible
                .get(name)
                .copied()
                .unwrap_or(false)
                || page_data.rows.is_empty()
            {
                return Err(format!(
                    "Output {name:?} is not numeric for every committed row"
                ));
            }
            let values = page_data.rows[start_row..end_row]
                .iter()
                .map(|row| {
                    row.outputs()
                        .iter()
                        .find(|output| output.name() == name)
                        .and_then(|output| output.value().as_f64())
                        .expect("numeric eligibility maintained while appending")
                })
                .collect();
            series.insert(name.clone(), values);
        }
        Ok(ChartSeriesDto {
            run_id: self.run_id,
            page: page.to_owned(),
            start_row,
            row_count: page_data.rows.len(),
            series,
        })
    }

    pub fn histogram(
        &self,
        page: &str,
        output: &str,
        mode: &str,
        value: Option<f64>,
    ) -> Result<HistogramDto, String> {
        let page_data = self
            .pages
            .get(page)
            .ok_or_else(|| format!("Unknown Output Page {page:?}"))?;
        let values = page_data.numeric_values(output)?;
        let min = values.iter().copied().fold(f64::INFINITY, f64::min);
        let max = values.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        if !(max - min).is_finite() {
            return Err("Histogram data range is too large".to_owned());
        }
        let count = match mode {
            "auto" if value.is_none() => {
                ((values.len() as f64).log2() + 1.0).ceil().min(200.0) as usize
            }
            "count"
                if value.is_some_and(|v| {
                    v.is_finite() && v.fract() == 0.0 && (1.0..=200.0).contains(&v)
                }) =>
            {
                value.unwrap() as usize
            }
            "width" if value.is_some_and(|v| v.is_finite() && v > 0.0) => {
                let bins = ((max - min) / value.unwrap()).ceil().max(1.0);
                if !bins.is_finite() || bins > 200.0 {
                    return Err("Histogram width would produce more than 200 bins".to_owned());
                }
                bins as usize
            }
            _ => return Err("Invalid histogram bin setting".to_owned()),
        };
        let count = if min == max { 1 } else { count };
        let width = if mode == "width" {
            value.unwrap_or(0.0)
        } else {
            (max - min) / count as f64
        };
        let mut bins = (0..count)
            .map(|index| HistogramBinDto {
                start: min + index as f64 * width,
                end: if index + 1 == count {
                    max
                } else {
                    min + (index + 1) as f64 * width
                },
                count: 0,
            })
            .collect::<Vec<_>>();
        for sample in &values {
            let index = if min == max {
                0
            } else {
                (((sample - min) / width).floor() as usize).min(count - 1)
            };
            bins[index].count += 1;
        }
        Ok(HistogramDto {
            run_id: self.run_id,
            page: page.to_owned(),
            output: output.to_owned(),
            sample_count: values.len(),
            bins,
        })
    }

    pub fn box_plot(&self, page: &str, outputs: &[String]) -> Result<BoxPlotDto, String> {
        let page_data = self
            .pages
            .get(page)
            .ok_or_else(|| format!("Unknown Output Page {page:?}"))?;
        let mut items = Vec::with_capacity(outputs.len());
        for output in outputs {
            let mut values = page_data.numeric_values(output)?;
            values.sort_by(f64::total_cmp);
            let q1 = percentile(&values, 0.25);
            let median = percentile(&values, 0.5);
            let q3 = percentile(&values, 0.75);
            let iqr = q3 - q1;
            let lower_fence = q1 - 1.5 * iqr;
            let upper_fence = q3 + 1.5 * iqr;
            let inliers = values
                .iter()
                .copied()
                .filter(|v| *v >= lower_fence && *v <= upper_fence)
                .collect::<Vec<_>>();
            let outliers = values
                .iter()
                .copied()
                .filter(|v| *v < lower_fence || *v > upper_fence)
                .collect();
            items.push(BoxPlotItemDto {
                output: output.clone(),
                count: values.len(),
                lower_whisker: *inliers.first().unwrap(),
                q1,
                median,
                q3,
                upper_whisker: *inliers.last().unwrap(),
                outliers,
            });
        }
        Ok(BoxPlotDto {
            run_id: self.run_id,
            page: page.to_owned(),
            items,
        })
    }

    pub fn page(
        &self,
        name: &str,
    ) -> Option<(&orchestrator_tool::workflow::OutputPage, &[ResultRow])> {
        let definition = self
            .template
            .workflow()
            .output_pages()
            .iter()
            .find(|page| page.name() == name)?;
        Some((definition, &self.pages.get(name)?.rows))
    }

    pub fn pages(
        &self,
    ) -> impl Iterator<Item = (&orchestrator_tool::workflow::OutputPage, &[ResultRow])> {
        self.template
            .workflow()
            .output_pages()
            .iter()
            .filter_map(|definition| {
                self.pages
                    .get(definition.name())
                    .map(|page| (definition, page.rows.as_slice()))
            })
    }
}

impl StoredPage {
    fn numeric_values(&self, name: &str) -> Result<Vec<f64>, String> {
        if self.rows.is_empty() || self.numeric_eligible.get(name) != Some(&true) {
            return Err(format!(
                "Output {name:?} is not numeric for every committed row"
            ));
        }
        Ok(self
            .rows
            .iter()
            .map(|row| {
                row.outputs()
                    .iter()
                    .find(|output| output.name() == name)
                    .and_then(|output| output.value().as_f64())
                    .expect("numeric eligibility maintained while appending")
            })
            .collect())
    }
    fn new(output_names: Vec<String>) -> Self {
        let numeric_eligible = output_names
            .iter()
            .cloned()
            .map(|name| (name, true))
            .collect();
        Self {
            output_names,
            rows: Vec::new(),
            revision: 0,
            iteration_rows: false,
            numeric_eligible,
            summaries: BTreeMap::new(),
        }
    }

    fn append(&mut self, row: ResultRow) {
        self.iteration_rows |= row.for_iteration().is_some() || row.while_iteration().is_some();
        for name in &self.output_names {
            let value = row
                .outputs()
                .iter()
                .find(|output| output.name() == name)
                .and_then(|output| output.value().as_f64())
                .filter(|value| value.is_finite());
            if value.is_none() {
                self.numeric_eligible.insert(name.clone(), false);
            }
        }
        for output in row.outputs() {
            if let Some(value) = output.value().as_f64().filter(|value| value.is_finite()) {
                self.summaries
                    .entry(output.name().to_owned())
                    .and_modify(|summary| summary.append(value))
                    .or_insert_with(|| NumericAccumulator::new(value));
            }
        }
        self.rows.push(row);
        self.revision += 1;
    }

    fn metadata(&self, name: &str) -> PageMetadataDto {
        PageMetadataDto {
            name: name.to_owned(),
            output_names: self.output_names.clone(),
            row_count: self.rows.len(),
            revision: self.revision,
            iteration_rows: self.iteration_rows,
            numeric_outputs: if self.rows.is_empty() {
                Vec::new()
            } else {
                self.output_names
                    .iter()
                    .filter(|name| self.numeric_eligible.get(*name) == Some(&true))
                    .cloned()
                    .collect()
            },
            summaries: self
                .output_names
                .iter()
                .filter_map(|name| self.summaries.get(name).map(|summary| summary.dto(name)))
                .collect(),
        }
    }
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    let position = (sorted.len() - 1) as f64 * p;
    let lower = position.floor() as usize;
    let upper = position.ceil() as usize;
    sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower as f64)
}

impl NumericAccumulator {
    fn new(value: f64) -> Self {
        Self {
            count: 1,
            min: value,
            max: value,
            avg: value,
        }
    }
    fn append(&mut self, value: f64) {
        self.count += 1;
        self.min = self.min.min(value);
        self.max = self.max.max(value);
        self.avg += (value - self.avg) / self.count as f64;
    }
    fn dto(&self, name: &str) -> NumericSummaryDto {
        NumericSummaryDto {
            name: name.to_owned(),
            count: self.count,
            min: self.min,
            max: self.max,
            avg: self.avg,
        }
    }
}

impl StepSummary {
    fn dto(&self, step_id: &str) -> StepSummaryDto {
        let status = if self.any_failed {
            "failed"
        } else if self.all_succeeded {
            "succeeded"
        } else {
            "cancelled"
        };
        StepSummaryDto {
            step_id: step_id.to_owned(),
            status: status.to_owned(),
            has_occurrence: true,
            any_failed: self.any_failed,
            all_succeeded: self.all_succeeded,
            any_cancelled: self.any_cancelled,
            output: self.latest.output.clone(),
            output_omitted: self.latest.output_omitted,
            message: self.latest.message.clone(),
        }
    }
}

fn compact_execution(execution: &StepExecution) -> CompactExecutionDto {
    let (status, output, output_omitted, message) = match execution.outcome() {
        StepOutcome::Succeeded { output } => {
            let (preview, omitted) = bounded_preview(output);
            ("succeeded", preview, omitted, None)
        }
        StepOutcome::Failed { message } => ("failed", None, false, Some(bounded_text(message))),
        StepOutcome::Cancelled => ("cancelled", None, false, None),
    };
    CompactExecutionDto {
        step_id: execution.step_id().as_str().to_owned(),
        status: status.to_owned(),
        output,
        output_omitted,
        message,
        for_iteration: execution.for_iteration().map(for_iteration_dto),
        while_iteration: execution.while_iteration().map(while_iteration_dto),
    }
}

fn bounded_text(text: &str) -> String {
    bounded_string(text).0
}

fn bounded_string(text: &str) -> (String, bool) {
    let mut chars = text.chars();
    let preview = chars.by_ref().take(PREVIEW_STRING_CHARS).collect();
    let omitted = chars.next().is_some();
    if omitted {
        (preview, true)
    } else {
        (text.to_owned(), false)
    }
}

fn bounded_preview(value: &Value) -> (Option<Value>, bool) {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => (Some(value.clone()), false),
        Value::String(text) => {
            let (preview, omitted) = bounded_string(text);
            (Some(Value::String(preview)), omitted)
        }
        Value::Object(object) => {
            if let (Some(value), Some(unit)) = (object.get("value"), object.get("unit"))
                && value.is_number()
                && unit.is_string()
            {
                let mut preview = Map::new();
                preview.insert("value".to_owned(), value.clone());
                let unit = unit.as_str().expect("unit is a string");
                let (unit, unit_omitted) = bounded_string(unit);
                preview.insert("unit".to_owned(), Value::String(unit));
                return (
                    Some(Value::Object(preview)),
                    unit_omitted || object.len() > 2,
                );
            }
            if value_fits_preview(value) {
                (Some(value.clone()), false)
            } else {
                (None, true)
            }
        }
        Value::Array(_) => {
            if value_fits_preview(value) {
                (Some(value.clone()), false)
            } else {
                (None, true)
            }
        }
    }
}

struct PreviewBudget {
    remaining: usize,
}

impl Write for PreviewBudget {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.remaining {
            self.remaining = 0;
            return Err(io::Error::other("preview budget exceeded"));
        }
        self.remaining -= bytes.len();
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn value_fits_preview(value: &Value) -> bool {
    let mut budget = PreviewBudget {
        remaining: PREVIEW_BYTES,
    };
    serde_json::to_writer(&mut budget, value).is_ok()
}

fn for_iteration_dto(iteration: &ForIteration) -> ForIterationDto {
    ForIterationDto {
        for_step_id: iteration.for_step_id().as_str().to_owned(),
        iteration_index: iteration.iteration_index(),
    }
}

fn while_iteration_dto(iteration: &WhileIteration) -> WhileIterationDto {
    WhileIterationDto {
        while_step_id: iteration.while_step_id().as_str().to_owned(),
        iteration_index: iteration.iteration_index(),
    }
}

fn result_row_dto(row: &ResultRow) -> ResultRowDto {
    ResultRowDto {
        page: row.page().to_owned(),
        outputs: row
            .outputs()
            .iter()
            .map(|output| WorkflowOutputDto {
                name: output.name().to_owned(),
                value: output.value().clone(),
            })
            .collect(),
        for_iteration: row.for_iteration().map(for_iteration_dto),
        while_iteration: row.while_iteration().map(while_iteration_dto),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use orchestrator_tool::run::{ExecutionMode, run_workflow_streaming_with_loop_stop};
    use orchestrator_tool::workflow::{ResultRow, StepId, StepResult, WorkflowOutput};

    fn template() -> Template {
        Template::from_json_str(
            &serde_json::json!({
                "schema_version": 1,
                "name": "stored",
                "tool_instances": [],
                "workflow": { "steps": [{
                    "type": "output", "id": "out", "name": "Voltage", "page": "Results",
                    "value": { "source": "literal", "value": 1 }
                }] }
            })
            .to_string(),
        )
        .unwrap()
    }

    fn row(value: Value) -> ResultRow {
        ResultRow::new(vec![WorkflowOutput::new("Voltage".to_owned(), value)], None)
            .with_page("Results")
    }

    #[test]
    fn large_execution_output_is_omitted_but_meter_preview_is_kept() {
        let large = StepExecution::new(
            StepResult::new(
                StepId::new("large").unwrap(),
                StepOutcome::Succeeded {
                    output: Value::Array((0..2_000).map(Value::from).collect()),
                },
            ),
            None,
        );
        let compact = compact_execution(&large);
        assert!(compact.output_omitted);
        assert!(compact.output.is_none());

        let meter = StepExecution::new(
            StepResult::new(
                StepId::new("meter").unwrap(),
                StepOutcome::Succeeded {
                    output: serde_json::json!({"value": 1.25, "unit": "V", "raw": [1, 2, 3]}),
                },
            ),
            None,
        );
        assert_eq!(
            compact_execution(&meter).output,
            Some(serde_json::json!({"value": 1.25, "unit": "V"}))
        );

        let huge_unit = "U".repeat(PREVIEW_STRING_CHARS + 1_000);
        let meter = StepExecution::new(
            StepResult::new(
                StepId::new("meter-long-unit").unwrap(),
                StepOutcome::Succeeded {
                    output: serde_json::json!({"value": 1.25, "unit": huge_unit}),
                },
            ),
            None,
        );
        let compact = compact_execution(&meter);
        assert!(compact.output_omitted);
        assert_eq!(
            compact
                .output
                .as_ref()
                .and_then(|output| output.get("unit"))
                .and_then(Value::as_str)
                .unwrap()
                .chars()
                .count(),
            PREVIEW_STRING_CHARS
        );
    }

    #[test]
    fn page_metadata_updates_numeric_state_and_summary_incrementally() {
        let mut page = StoredPage::new(vec!["Voltage".to_owned(), "Label".to_owned()]);
        page.append(
            ResultRow::new(
                vec![
                    WorkflowOutput::new("Voltage".to_owned(), Value::from(2.0)),
                    WorkflowOutput::new("Label".to_owned(), Value::from("a")),
                ],
                None,
            )
            .with_page("Page"),
        );
        page.append(
            ResultRow::new(
                vec![
                    WorkflowOutput::new("Voltage".to_owned(), Value::from(4.0)),
                    WorkflowOutput::new("Label".to_owned(), Value::from(3.0)),
                ],
                None,
            )
            .with_page("Page"),
        );
        let metadata = page.metadata("Page");
        assert_eq!(metadata.numeric_outputs, vec!["Voltage"]);
        assert_eq!(
            metadata
                .summaries
                .iter()
                .find(|summary| summary.name == "Voltage")
                .unwrap()
                .avg,
            3.0
        );
    }

    #[test]
    fn lifecycle_windows_chart_tail_and_stale_ids_share_one_stored_run() {
        let runs = StoredRuns::default();
        let first = runs.begin(template());
        let first_id = first.read().unwrap().run_id;
        {
            let mut run = first.write().unwrap();
            for value in 1..=5 {
                run.append_event(
                    &orchestrator_tool::workflow::WorkflowRunEvent::ResultRowCommitted(row(
                        Value::from(value),
                    )),
                );
            }
            let execution = StepExecution::new(
                StepResult::new(
                    StepId::new("out").unwrap(),
                    StepOutcome::Succeeded {
                        output: Value::from(5),
                    },
                ),
                None,
            );
            run.append_event(
                &orchestrator_tool::workflow::WorkflowRunEvent::StepCompleted(execution),
            );
            run.fail("later failure");
        }
        let run = runs.get(first_id).unwrap();
        let run = run.read().unwrap();
        let window = run.page_rows("Results", 1, 2).unwrap();
        assert_eq!(window.total_rows, 5);
        assert_eq!(
            window
                .rows
                .iter()
                .map(|row| row.outputs[0].value.as_i64().unwrap())
                .collect::<Vec<_>>(),
            vec![4, 3]
        );
        let bootstrap = run
            .chart_series("Results", &["Voltage".to_owned()], 0, 2)
            .unwrap();
        assert_eq!(bootstrap.series["Voltage"], vec![1.0, 2.0]);
        assert_eq!(bootstrap.row_count, 5);
        let middle = run
            .chart_series("Results", &["Voltage".to_owned()], 2, 2)
            .unwrap();
        assert_eq!(middle.series["Voltage"], vec![3.0, 4.0]);
        let tail = run
            .chart_series("Results", &["Voltage".to_owned()], 4, 2)
            .unwrap();
        assert_eq!(tail.series["Voltage"], vec![5.0]);
        assert!(
            run.chart_series("Results", &["Voltage".to_owned()], 0, 0)
                .is_err()
        );
        assert_eq!(run.executions(0, 200).executions.len(), 1);
        assert_eq!(run.metadata().status, "failed");
        assert_eq!(run.metadata().pages[0].row_count, 5);
        drop(run);

        let second = runs.begin(template());
        let second_id = second.read().unwrap().run_id;
        assert!(second_id > first_id);
        assert!(runs.get(first_id).is_err());
        runs.clear(second_id).unwrap();
        assert!(runs.get(second_id).is_err());
    }

    #[test]
    fn histogram_counts_committed_rows_and_rejects_invalid_bins() {
        let mut run = StoredRun::new(1, template());
        for value in [1, 2, 3, 4] {
            run.append_event(
                &orchestrator_tool::workflow::WorkflowRunEvent::ResultRowCommitted(row(
                    Value::from(value),
                )),
            );
        }
        run.fail("later failure");
        let result = run
            .histogram("Results", "Voltage", "count", Some(2.0))
            .unwrap();
        assert_eq!(result.bins.len(), 2);
        assert_eq!(result.bins.iter().map(|bin| bin.count).sum::<usize>(), 4);
        assert_eq!(result.bins[1].count, 2);
        assert!(
            run.histogram("Results", "Voltage", "count", Some(0.0))
                .is_err()
        );
        assert!(
            run.histogram("Results", "Voltage", "width", Some(0.001))
                .is_err()
        );
        assert!(run.histogram("Missing", "Voltage", "auto", None).is_err());
        assert!(run.histogram("Results", "Missing", "auto", None).is_err());

        let mut constant = StoredRun::new(2, template());
        for _ in 0..3 {
            constant.append_event(
                &orchestrator_tool::workflow::WorkflowRunEvent::ResultRowCommitted(row(
                    Value::from(7),
                )),
            );
        }
        let bins = constant
            .histogram("Results", "Voltage", "count", Some(20.0))
            .unwrap()
            .bins;
        assert_eq!(bins.len(), 1);
        assert_eq!(bins[0].count, 3);
    }

    #[test]
    fn box_plot_uses_linear_percentiles_and_tukey_whiskers() {
        let mut run = StoredRun::new(1, template());
        for value in [1, 2, 3, 4, 5, 100] {
            run.append_event(
                &orchestrator_tool::workflow::WorkflowRunEvent::ResultRowCommitted(row(
                    Value::from(value),
                )),
            );
        }
        let result = run.box_plot("Results", &["Voltage".to_owned()]).unwrap();
        let item = &result.items[0];
        assert_eq!(
            (
                item.lower_whisker,
                item.q1,
                item.median,
                item.q3,
                item.upper_whisker
            ),
            (1.0, 2.25, 3.5, 4.75, 5.0)
        );
        assert_eq!(item.outliers, vec![100.0]);

        let mut multi = StoredRun::new(2, template());
        multi.pages.insert(
            "Results".to_owned(),
            StoredPage::new(vec!["Voltage".to_owned(), "Current".to_owned()]),
        );
        multi.append_event(
            &orchestrator_tool::workflow::WorkflowRunEvent::ResultRowCommitted(
                ResultRow::new(
                    vec![
                        WorkflowOutput::new("Voltage".to_owned(), Value::from(1)),
                        WorkflowOutput::new("Current".to_owned(), Value::from(2)),
                    ],
                    None,
                )
                .with_page("Results"),
            ),
        );
        let items = multi
            .box_plot("Results", &["Current".to_owned(), "Voltage".to_owned()])
            .unwrap()
            .items;
        assert_eq!(
            items
                .iter()
                .map(|item| item.output.as_str())
                .collect::<Vec<_>>(),
            vec!["Current", "Voltage"]
        );
    }

    #[test]
    fn query_rejects_a_run_replaced_during_query_work() {
        let runs = StoredRuns::default();
        let first = runs.begin(template());
        let first_id = first.read().unwrap().run_id;
        let result = runs.with_current(first_id, |run| {
            assert_eq!(run.run_id, first_id);
            runs.begin(template());
            run.run_id
        });
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("no longer current"));
    }

    #[test]
    fn streaming_core_events_populate_stored_run_without_returning_full_result() {
        let template = template();
        let runs = StoredRuns::default();
        let stored = runs.begin(template.clone());
        let summary = run_workflow_streaming_with_loop_stop(
            &template,
            ExecutionMode::Simulate,
            &Default::default(),
            std::time::Duration::from_secs(5),
            std::time::Duration::from_secs(5),
            std::time::Duration::from_secs(5),
            |event| stored.write().unwrap().append_event(&event),
            |_| false,
        )
        .unwrap();
        assert!(summary.succeeded());
        stored.write().unwrap().succeed();

        let run = stored.read().unwrap();
        let metadata = run.metadata();
        assert_eq!(metadata.status, "succeeded");
        assert_eq!(metadata.execution_count, 1);
        assert_eq!(metadata.pages[0].row_count, 1);
        assert_eq!(run.page_rows("Results", 0, 1).unwrap().rows.len(), 1);
    }

    #[test]
    fn a_later_non_numeric_cell_revokes_chart_eligibility_without_losing_summary() {
        let runs = StoredRuns::default();
        let run = runs.begin(template());
        let mut run = run.write().unwrap();
        run.append_event(
            &orchestrator_tool::workflow::WorkflowRunEvent::ResultRowCommitted(row(Value::from(
                2.0,
            ))),
        );
        run.append_event(
            &orchestrator_tool::workflow::WorkflowRunEvent::ResultRowCommitted(row(Value::from(
                "bad",
            ))),
        );
        let metadata = run.metadata();
        assert!(metadata.pages[0].numeric_outputs.is_empty());
        assert_eq!(metadata.pages[0].summaries[0].count, 1);
        assert!(
            run.chart_series("Results", &["Voltage".to_owned()], 0, 1)
                .is_err()
        );
    }
    #[test]
    fn page_summary_order_follows_declared_outputs() {
        let mut page = StoredPage::new(vec!["Zeta".to_owned(), "Alpha".to_owned()]);
        page.append(
            ResultRow::new(
                vec![
                    WorkflowOutput::new("Zeta".to_owned(), Value::from(2.0)),
                    WorkflowOutput::new("Alpha".to_owned(), Value::from(1.0)),
                ],
                None,
            )
            .with_page("Page"),
        );
        assert_eq!(
            page.metadata("Page")
                .summaries
                .iter()
                .map(|summary| summary.name.as_str())
                .collect::<Vec<_>>(),
            vec!["Zeta", "Alpha"]
        );
    }

    #[test]
    fn clear_current_drops_the_previous_run_without_retaining_it() {
        let runs = StoredRuns::default();
        let run = runs.begin(template());
        let run_id = run.read().unwrap().run_id;
        runs.clear_current();
        assert!(runs.get(run_id).is_err());
    }

    #[test]
    fn deep_windows_slice_directly_and_keep_latest_first_order() {
        let runs = StoredRuns::default();
        let run = runs.begin(template());
        {
            let mut run = run.write().unwrap();
            for value in 1..=2_000 {
                run.append_event(
                    &orchestrator_tool::workflow::WorkflowRunEvent::ResultRowCommitted(row(
                        Value::from(value),
                    )),
                );
            }
            for value in 1..=2_000 {
                run.executions.push(CompactExecutionDto {
                    step_id: format!("step-{value}"),
                    status: "succeeded".to_owned(),
                    output: None,
                    output_omitted: false,
                    message: None,
                    for_iteration: None,
                    while_iteration: None,
                });
            }
        }
        let run = run.read().unwrap();
        let rows = run.page_rows("Results", 1_500, 3).unwrap();
        assert_eq!(
            rows.rows
                .iter()
                .map(|row| row.outputs[0].value.as_i64().unwrap())
                .collect::<Vec<_>>(),
            vec![500, 499, 498]
        );
        let executions = run.executions(1_500, 3);
        assert_eq!(
            executions
                .executions
                .iter()
                .map(|execution| execution.step_id.as_str())
                .collect::<Vec<_>>(),
            vec!["step-500", "step-499", "step-498"]
        );
    }

    #[test]
    fn page_rows_responses_carry_a_coherent_revision_snapshot() {
        let runs = StoredRuns::default();
        let run = runs.begin(template());
        run.write().unwrap().append_event(
            &orchestrator_tool::workflow::WorkflowRunEvent::ResultRowCommitted(row(Value::from(
                1.0,
            ))),
        );
        let first = run.read().unwrap().page_rows("Results", 0, 10).unwrap();
        assert_eq!(first.revision, 1);
        assert_eq!(first.total_rows, 1);
        assert_eq!(first.rows.len(), 1);
        run.write().unwrap().append_event(
            &orchestrator_tool::workflow::WorkflowRunEvent::ResultRowCommitted(row(Value::from(
                2.0,
            ))),
        );
        let second = run.read().unwrap().page_rows("Results", 0, 10).unwrap();
        assert_eq!(second.revision, 2);
        assert_eq!(second.total_rows, 2);
        assert_eq!(second.rows.len(), 2);
    }
}
