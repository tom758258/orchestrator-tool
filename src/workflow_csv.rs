//! CSV serialization of projected outputs from a single workflow run.

use std::{error::Error, fmt, string::FromUtf8Error};

use serde_json::Value;

use crate::workflow::WorkflowOutput;

/// Writes a header and one data record in input order, or nothing for empty input.
/// Strings retain their contents, null becomes empty, and other values use compact JSON.
pub fn serialize_workflow_outputs_csv(
    outputs: &[WorkflowOutput],
) -> Result<String, CsvSerializationError> {
    if outputs.is_empty() {
        return Ok(String::new());
    }

    let mut writer = csv::Writer::from_writer(Vec::new());
    writer
        .write_record(outputs.iter().map(WorkflowOutput::name))
        .map_err(CsvSerializationError::Csv)?;
    writer
        .write_record(outputs.iter().map(|output| match output.value() {
            Value::String(value) => value.clone(),
            Value::Null => String::new(),
            value => value.to_string(),
        }))
        .map_err(CsvSerializationError::Csv)?;
    let bytes = writer
        .into_inner()
        .map_err(|error| CsvSerializationError::Csv(error.into_error().into()))?;
    String::from_utf8(bytes).map_err(CsvSerializationError::Utf8)
}

/// Errors while serializing CSV into a UTF-8 string.
#[derive(Debug)]
pub enum CsvSerializationError {
    Csv(csv::Error),
    Utf8(FromUtf8Error),
}

impl fmt::Display for CsvSerializationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Csv(source) => write!(formatter, "CSV serialization error: {source}"),
            Self::Utf8(source) => write!(formatter, "CSV UTF-8 conversion error: {source}"),
        }
    }
}

impl Error for CsvSerializationError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Csv(source) => Some(source),
            Self::Utf8(source) => Some(source),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::workflow::{InputValue, Step, StepId, StepKind, StepOutcome, StepResult, Workflow};

    fn outputs(cells: &[(&str, Value)]) -> Vec<WorkflowOutput> {
        let mut steps = Vec::new();
        let mut results = Vec::new();
        for (index, (name, value)) in cells.iter().enumerate() {
            let id = StepId::new(format!("output-{index}")).unwrap();
            steps.push(Step::new(
                id.clone(),
                StepKind::Output {
                    name: (*name).to_owned(),
                    value: InputValue::Literal(value.clone()),
                },
            ));
            results.push(StepResult::new(
                id,
                StepOutcome::Succeeded {
                    output: value.clone(),
                },
            ));
        }
        Workflow::new(steps)
            .unwrap()
            .project_outputs(&results)
            .unwrap()
    }

    #[test]
    fn ordered_single_run_serialization() {
        let outputs = outputs(&[
            ("voltage", json!(5.0012)),
            ("passed", json!(true)),
            ("label", json!("sample")),
        ]);
        assert_eq!(
            serialize_workflow_outputs_csv(&outputs).unwrap(),
            "voltage,passed,label\n5.0012,true,sample\n"
        );
    }

    #[test]
    fn csv_escaping_and_json_values() {
        let outputs = outputs(&[
            ("label,\"quoted\"\nline", json!("sample,\"quoted\"\nline")),
            ("null", Value::Null),
            ("array", json!([1, true])),
            ("object", json!({ "value": 5 })),
        ]);
        assert_eq!(
            serialize_workflow_outputs_csv(&outputs).unwrap(),
            "\"label,\"\"quoted\"\"\nline\",null,array,object\n\"sample,\"\"quoted\"\"\nline\",,\"[1,true]\",\"{\"\"value\"\":5}\"\n"
        );
    }

    #[test]
    fn empty_input_produces_empty_content() {
        assert_eq!(serialize_workflow_outputs_csv(&[]).unwrap(), "");
    }
}
