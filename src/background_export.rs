//! Manual exports borrow bounded windows from the authoritative memory store.
use crate::{
    background::{SAMPLE_COLUMNS, SharedBackgroundStore, unique_file},
    workflow::{ResultRow, WorkflowOutput},
    workflow_csv::{ResultRowsCsvWriter, export_cell},
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const DEFAULT_XLSX_ROWS: usize = 300_000;
pub const EXCEL_DATA_ROWS: usize = 1_048_575;

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BackgroundExportFormat {
    Csv,
    Xlsx,
}

pub fn export_datasets(
    store: &SharedBackgroundStore,
    dataset_ids: &[String],
    folder: &Path,
    format: BackgroundExportFormat,
    rows_per_file: usize,
) -> Result<Vec<PathBuf>, String> {
    if matches!(format, BackgroundExportFormat::Xlsx)
        && (rows_per_file == 0 || rows_per_file > EXCEL_DATA_ROWS)
    {
        return Err(format!("Rows per file must be 1..={EXCEL_DATA_ROWS}"));
    }
    let mut paths = Vec::new();
    for id in dataset_ids {
        let metadata = store
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .dataset(id)?
            .metadata
            .clone();
        if metadata.status == "recording" {
            return Err("Switch Capture OFF before manual export".into());
        }
        let chunks = match format {
            BackgroundExportFormat::Csv => 1,
            BackgroundExportFormat::Xlsx => metadata.row_count.max(1).div_ceil(rows_per_file),
        };
        for part in 0..chunks {
            let (start, end) = match format {
                BackgroundExportFormat::Csv => (0, metadata.row_count),
                BackgroundExportFormat::Xlsx => (
                    part * rows_per_file,
                    ((part + 1) * rows_per_file).min(metadata.row_count),
                ),
            };
            let (path, file) = unique_file(
                folder,
                &format!("{}-part-{}", metadata.id, part + 1),
                match format {
                    BackgroundExportFormat::Csv => "csv",
                    BackgroundExportFormat::Xlsx => "xlsx",
                },
            )?;
            match format {
                BackgroundExportFormat::Csv => {
                    let mut writer =
                        ResultRowsCsvWriter::new(file, SAMPLE_COLUMNS.map(str::to_owned).to_vec())
                            .map_err(|e| e.to_string())?;
                    for offset in (start..end).step_by(1_000) {
                        for sample in store.lock().unwrap_or_else(|e| e.into_inner()).rows(
                            id,
                            offset,
                            (end - offset).min(1_000),
                        )? {
                            let row = ResultRow::new(
                                SAMPLE_COLUMNS
                                    .iter()
                                    .map(|name| {
                                        WorkflowOutput::new((*name).into(), sample[*name].clone())
                                    })
                                    .collect(),
                                None,
                            );
                            writer.write_row(&row).map_err(|e| e.to_string())?;
                        }
                    }
                    writer.finish().map_err(|e| e.to_string())?;
                }
                BackgroundExportFormat::Xlsx => {
                    let mut workbook = rust_xlsxwriter::Workbook::new();
                    let sheet = workbook.add_worksheet_with_constant_memory();
                    for (column, name) in SAMPLE_COLUMNS.iter().enumerate() {
                        sheet
                            .write_string(0, column as u16, *name)
                            .map_err(|e| e.to_string())?;
                    }
                    for offset in (start..end).step_by(1_000) {
                        let samples = store.lock().unwrap_or_else(|e| e.into_inner()).rows(
                            id,
                            offset,
                            (end - offset).min(1_000),
                        )?;
                        for (index, sample) in samples.iter().enumerate() {
                            let row = (offset - start + index + 1) as u32;
                            for (column, name) in SAMPLE_COLUMNS.iter().enumerate() {
                                let value = &sample[*name];
                                match value {
                                    serde_json::Value::Number(number)
                                        if crate::workflow_export::excel_number(number)
                                            .is_some() =>
                                    {
                                        sheet.write_number(
                                            row,
                                            column as u16,
                                            crate::workflow_export::excel_number(number).unwrap(),
                                        )
                                    }
                                    _ => sheet.write_string(row, column as u16, export_cell(value)),
                                }
                                .map_err(|e| e.to_string())?;
                            }
                        }
                    }
                    workbook.save_to_writer(file).map_err(|e| e.to_string())?;
                }
            }
            paths.push(path);
        }
    }
    Ok(paths)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::background::{BackgroundStore, Dataset, DatasetMetadata};
    use calamine::{Data, Reader, Xlsx};
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    #[test]
    #[ignore = "large manual export contract; run explicitly without instruments"]
    fn large_xlsx_splits_at_default_and_preserves_all_rows() {
        let count = DEFAULT_XLSX_ROWS + 1;
        let store = Arc::new(Mutex::new(BackgroundStore::default()));
        store.lock().unwrap().datasets.push(Dataset {
            metadata:DatasetMetadata {id:"background-1-capture-1".into(),background_id:"background-1".into(),worker_run_id:"worker".into(),
                started_ms:0,finished_ms:Some(1),status:"completed".into(),quality:"no_loss_detected".into(),row_count:count,
                min:None,max:None,avg:None,csv_path:None,error:None},
            samples:(1..=count).map(|i| json!({"timestamp_utc":"2026-10-27T00:00:00Z","captured":i,"elapsed_s":i as f64/1000.0,"value":10.600000000000001_f64,"unit":"V"})).collect(),
        });
        {
            let data = store.lock().unwrap();
            assert_eq!(
                data.rows("background-1-capture-1", 0, usize::MAX)
                    .unwrap()
                    .len(),
                crate::background::QUERY_LIMIT
            );
            let chart = data.chart("background-1-capture-1").unwrap();
            assert_eq!(chart.len(), crate::background::CHART_POINTS);
            assert_eq!(chart[0]["captured"], 1);
            assert_eq!(chart.last().unwrap()["captured"], count);
        }
        let folder =
            std::env::temp_dir().join(format!("orchestrator-large-export-{}", std::process::id()));
        let ids = vec!["background-1-capture-1".into()];
        let paths = export_datasets(
            &store,
            &ids,
            &folder,
            BackgroundExportFormat::Xlsx,
            DEFAULT_XLSX_ROWS,
        )
        .unwrap();
        assert_eq!(paths.len(), 2);
        for (part, path) in paths.iter().enumerate() {
            let mut book: Xlsx<_> = calamine::open_workbook(path).unwrap();
            let sheet = book.worksheet_range("Sheet1").unwrap();
            assert_eq!(
                sheet.height(),
                if part == 0 { DEFAULT_XLSX_ROWS + 1 } else { 2 }
            );
            if part == 1 {
                assert_eq!(sheet.get((1, 2)), Some(&Data::Float(count as f64)));
            }
        }
        let csv = export_datasets(
            &store,
            &ids,
            &folder,
            BackgroundExportFormat::Csv,
            DEFAULT_XLSX_ROWS,
        )
        .unwrap();
        let mut reader = csv::Reader::from_path(&csv[0]).unwrap();
        let mut received = 0;
        for record in reader.records() {
            let record = record.unwrap();
            received += 1;
            assert_eq!(record[2].parse::<usize>().unwrap(), received);
            assert_eq!(&record[3], "10.600000000000001");
        }
        assert_eq!(received, count);
        let again = export_datasets(
            &store,
            &ids,
            &folder,
            BackgroundExportFormat::Csv,
            DEFAULT_XLSX_ROWS,
        )
        .unwrap();
        assert_ne!(csv, again);
        assert!(
            export_datasets(
                &store,
                &ids,
                &folder,
                BackgroundExportFormat::Xlsx,
                EXCEL_DATA_ROWS + 1
            )
            .is_err()
        );
        std::fs::remove_dir_all(folder).unwrap();
    }
}
