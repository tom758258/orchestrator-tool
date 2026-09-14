//! CSV serialization of committed workflow result rows.

use std::{error::Error, fmt, string::FromUtf8Error};

use serde_json::Value;

use crate::workflow::{ResultRow, WorkflowOutput};

/// Writes Output names as the header and one data record per row, excluding iteration metadata.
/// Strings retain their contents, null becomes empty, and other values use compact JSON.
pub fn serialize_result_rows_csv(rows: &[ResultRow]) -> Result<String, CsvSerializationError> {
    let Some(first) = rows.first() else {
        return Ok(String::new());
    };
    for (index, row) in rows.iter().enumerate().skip(1) {
        if !row
            .outputs()
            .iter()
            .map(WorkflowOutput::name)
            .eq(first.outputs().iter().map(WorkflowOutput::name))
        {
            return Err(CsvSerializationError::RowSchemaMismatch { row_index: index });
        }
    }
    if first.outputs().is_empty() {
        return Ok(String::new());
    }

    let mut writer = csv::Writer::from_writer(Vec::new());
    writer
        .write_record(first.outputs().iter().map(WorkflowOutput::name))
        .map_err(CsvSerializationError::Csv)?;
    for row in rows {
        writer
            .write_record(row.outputs().iter().map(|output| match output.value() {
                Value::String(value) => value.clone(),
                Value::Null => String::new(),
                value => value.to_string(),
            }))
            .map_err(CsvSerializationError::Csv)?;
    }
    let bytes = writer
        .into_inner()
        .map_err(|error| CsvSerializationError::Csv(error.into_error().into()))?;
    String::from_utf8(bytes).map_err(CsvSerializationError::Utf8)
}

/// Errors while serializing CSV into a UTF-8 string.
#[derive(Debug)]
pub enum CsvSerializationError {
    RowSchemaMismatch { row_index: usize },
    Csv(csv::Error),
    Utf8(FromUtf8Error),
}

impl fmt::Display for CsvSerializationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RowSchemaMismatch { row_index } => write!(
                formatter,
                "CSV row {row_index} has different Output names, order, or count from the first row"
            ),
            Self::Csv(source) => write!(formatter, "CSV serialization error: {source}"),
            Self::Utf8(source) => write!(formatter, "CSV UTF-8 conversion error: {source}"),
        }
    }
}

impl Error for CsvSerializationError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::RowSchemaMismatch { .. } => None,
            Self::Csv(source) => Some(source),
            Self::Utf8(source) => Some(source),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::workflow::{ForIteration, StepId};

    fn outputs(cells: &[(&str, Value)]) -> Vec<WorkflowOutput> {
        cells
            .iter()
            .map(|(name, value)| WorkflowOutput::new((*name).to_owned(), value.clone()))
            .collect()
    }

    #[test]
    fn ordered_single_run_serialization() {
        let outputs = outputs(&[
            ("voltage", json!(5.0012)),
            ("passed", json!(true)),
            ("label", json!("sample")),
        ]);
        assert_eq!(
            serialize_result_rows_csv(&[ResultRow::new(outputs, None)]).unwrap(),
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
            serialize_result_rows_csv(&[ResultRow::new(outputs, None)]).unwrap(),
            "\"label,\"\"quoted\"\"\nline\",null,array,object\n\"sample,\"\"quoted\"\"\nline\",,\"[1,true]\",\"{\"\"value\"\":5}\"\n"
        );
    }

    #[test]
    fn empty_input_produces_empty_content() {
        assert_eq!(serialize_result_rows_csv(&[]).unwrap(), "");
    }

    #[test]
    fn multiple_rows_exclude_iteration_metadata() {
        let rows = [json!(0), json!(0.1), json!(0.2)]
            .into_iter()
            .enumerate()
            .map(|(index, voltage)| {
                ResultRow::new(
                    outputs(&[("voltage", voltage), ("passed", json!(index < 2))]),
                    Some(ForIteration::new(StepId::new("sweep").unwrap(), index)),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            serialize_result_rows_csv(&rows).unwrap(),
            "voltage,passed\n0,true\n0.1,true\n0.2,false\n"
        );
    }

    #[test]
    fn rows_require_matching_output_names_order_and_count() {
        for cells in [
            vec![("other", json!(1)), ("b", json!(2))],
            vec![("b", json!(2)), ("a", json!(1))],
            vec![("a", json!(1))],
        ] {
            let rows = [
                ResultRow::new(outputs(&[("a", json!(1)), ("b", json!(2))]), None),
                ResultRow::new(outputs(&cells), None),
            ];
            assert!(matches!(
                serialize_result_rows_csv(&rows),
                Err(CsvSerializationError::RowSchemaMismatch { row_index: 1 })
            ));
        }
        assert_eq!(
            serialize_result_rows_csv(&[ResultRow::new(vec![], None)]).unwrap(),
            ""
        );
    }
}
