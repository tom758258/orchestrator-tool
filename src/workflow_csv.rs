//! CSV serialization of committed workflow result rows.

use std::{error::Error, fmt, io::Write, string::FromUtf8Error};

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

    let mut bytes = Vec::new();
    let mut writer = ResultRowsCsvWriter::new(
        &mut bytes,
        first
            .outputs()
            .iter()
            .map(|output| output.name().to_owned())
            .collect(),
    )?;
    for row in rows {
        writer.write_row(row)?;
    }
    String::from_utf8(bytes).map_err(CsvSerializationError::Utf8)
}

/// Incrementally writes and flushes committed rows using the batch CSV contract.
pub struct ResultRowsCsvWriter<W: Write> {
    destination: W,
    names: Vec<String>,
    row_index: usize,
}

impl<W: Write> ResultRowsCsvWriter<W> {
    /// Writes and flushes the declared Output header before execution begins.
    pub fn new(destination: W, names: Vec<String>) -> Result<Self, CsvSerializationError> {
        let mut writer = Self {
            destination,
            names,
            row_index: 0,
        };
        if !writer.names.is_empty() {
            writer.write_record(writer.names.clone())?;
        }
        Ok(writer)
    }

    /// Validates the complete schema before writing a record, then flushes it.
    pub fn write_row(&mut self, row: &ResultRow) -> Result<(), CsvSerializationError> {
        if !row
            .outputs()
            .iter()
            .map(WorkflowOutput::name)
            .eq(self.names.iter().map(String::as_str))
        {
            return Err(CsvSerializationError::RowSchemaMismatch {
                row_index: self.row_index,
            });
        }
        if !self.names.is_empty() {
            self.write_record(row.outputs().iter().map(|output| match output.value() {
                Value::String(value) => value.clone(),
                Value::Null => String::new(),
                value => value.to_string(),
            }))?;
        }
        self.row_index += 1;
        Ok(())
    }

    fn write_record(
        &mut self,
        cells: impl IntoIterator<Item = String>,
    ) -> Result<(), CsvSerializationError> {
        let mut record = csv::Writer::from_writer(Vec::new());
        record
            .write_record(cells)
            .map_err(CsvSerializationError::Csv)?;
        let bytes = record
            .into_inner()
            .map_err(|error| CsvSerializationError::Csv(error.into_error().into()))?;
        self.destination
            .write_all(&bytes)
            .and_then(|()| self.destination.flush())
            .map_err(|error| CsvSerializationError::Csv(error.into()))
    }
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
    #[test]
    fn incremental_records_match_batch_and_flush_each_record() {
        #[derive(Default)]
        struct Sink {
            bytes: Vec<u8>,
            flushes: usize,
        }
        impl Write for Sink {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.bytes.extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                self.flushes += 1;
                Ok(())
            }
        }
        let rows = (0..2)
            .map(|index| {
                ResultRow::new(
                    outputs(&[
                        ("label", json!("quoted,\"text\"\nline")),
                        ("empty", Value::Null),
                        ("json", json!([index, true])),
                    ]),
                    Some(ForIteration::new(StepId::new("loop").unwrap(), index)),
                )
            })
            .collect::<Vec<_>>();
        let mut sink = Sink::default();
        {
            let mut writer = ResultRowsCsvWriter::new(
                &mut sink,
                vec!["label".into(), "empty".into(), "json".into()],
            )
            .unwrap();
            for row in &rows {
                writer.write_row(row).unwrap();
            }
        }
        assert_eq!(sink.flushes, 3);
        assert_eq!(
            String::from_utf8(sink.bytes).unwrap(),
            serialize_result_rows_csv(&rows).unwrap()
        );
    }

    #[test]
    fn incremental_writer_reports_mid_run_flush_failure() {
        struct Sink {
            flushes: usize,
        }
        impl Write for Sink {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                self.flushes += 1;
                if self.flushes > 1 {
                    Err(std::io::Error::other("disk unavailable"))
                } else {
                    Ok(())
                }
            }
        }
        let mut writer = ResultRowsCsvWriter::new(Sink { flushes: 0 }, vec!["a".into()]).unwrap();
        let error = writer
            .write_row(&ResultRow::new(outputs(&[("a", json!(1))]), None))
            .unwrap_err();
        assert!(error.to_string().contains("disk unavailable"));
    }

    #[test]
    fn incremental_schema_mismatch_does_not_write_a_record() {
        for cells in [
            vec![("other", json!(1)), ("b", json!(2))],
            vec![("b", json!(2)), ("a", json!(1))],
            vec![("a", json!(1))],
        ] {
            let mut bytes = Vec::new();
            {
                let mut writer =
                    ResultRowsCsvWriter::new(&mut bytes, vec!["a".into(), "b".into()]).unwrap();
                assert!(matches!(
                    writer.write_row(&ResultRow::new(outputs(&cells), None)),
                    Err(CsvSerializationError::RowSchemaMismatch { row_index: 0 })
                ));
            }
            assert_eq!(bytes, b"a,b\n");
        }
    }
}
