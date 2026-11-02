//! Manual exports borrow bounded windows from the authoritative memory store.
use crate::serial_text::{SerialDataFormat, SerialTextDecoder, raw_bytes, serial_cells};
use crate::{
    background::{
        ScopesExportMode, SharedBackgroundStore, sample_cells, sample_columns, serial_columns,
        unique_file,
    },
    workflow::{ResultRow, WorkflowOutput},
    workflow_csv::{ResultRowsCsvWriter, export_cell},
};
use serde::{Deserialize, Serialize};
use std::{
    io::Write,
    path::{Path, PathBuf},
};

pub const DEFAULT_XLSX_ROWS: usize = 300_000;
pub const EXCEL_DATA_ROWS: usize = 1_048_575;

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BackgroundExportFormat {
    Csv,
    Xlsx,
    Bin,
}

pub fn export_datasets(
    store: &SharedBackgroundStore,
    dataset_ids: &[String],
    folder: &Path,
    format: BackgroundExportFormat,
    rows_per_file: usize,
) -> Result<Vec<PathBuf>, String> {
    export_datasets_with_scopes_mode(
        store,
        dataset_ids,
        folder,
        format,
        rows_per_file,
        ScopesExportMode::ValuesOnly,
    )
}

pub fn export_datasets_with_scopes_mode(
    store: &SharedBackgroundStore,
    dataset_ids: &[String],
    folder: &Path,
    format: BackgroundExportFormat,
    rows_per_file: usize,
    scopes_mode: ScopesExportMode,
) -> Result<Vec<PathBuf>, String> {
    export_datasets_with_serial_format(
        store,
        dataset_ids,
        folder,
        format,
        rows_per_file,
        scopes_mode,
        SerialDataFormat::Hex,
    )
}

pub fn export_datasets_with_serial_format(
    store: &SharedBackgroundStore,
    dataset_ids: &[String],
    folder: &Path,
    format: BackgroundExportFormat,
    rows_per_file: usize,
    scopes_mode: ScopesExportMode,
    serial_mode: SerialDataFormat,
) -> Result<Vec<PathBuf>, String> {
    if matches!(format, BackgroundExportFormat::Bin) {
        // Validate all selections before creating any files.
        for id in dataset_ids {
            let data = store.lock().unwrap_or_else(|e| e.into_inner());
            let meta = &data.dataset(id)?.metadata;
            if meta.tool_kind != "serial" {
                return Err("BIN export is only supported for Serial RX datasets".into());
            }
            if meta.status == "recording" {
                return Err("Switch Capture OFF before manual export".into());
            }
        }
    }
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
        let columns = if metadata.tool_kind == "serial" {
            serial_columns()
        } else {
            sample_columns(&metadata.fields, scopes_mode)
        };
        let mut serial_decoder = SerialTextDecoder::default();
        if columns.len() > 16_384 {
            return Err("Scopes Background exceeds XLSX column limit".into());
        }
        let chunks = match format {
            BackgroundExportFormat::Csv | BackgroundExportFormat::Bin => 1,
            BackgroundExportFormat::Xlsx => metadata.row_count.max(1).div_ceil(rows_per_file),
        };
        for part in 0..chunks {
            let (start, end) = match format {
                BackgroundExportFormat::Csv | BackgroundExportFormat::Bin => {
                    (0, metadata.row_count)
                }
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
                    BackgroundExportFormat::Bin => "bin",
                },
            )?;
            match format {
                BackgroundExportFormat::Csv => {
                    let mut writer = ResultRowsCsvWriter::new(file, columns.clone())
                        .map_err(|e| e.to_string())?;
                    for offset in (start..end).step_by(1_000) {
                        for sample in store.lock().unwrap_or_else(|e| e.into_inner()).rows(
                            id,
                            offset,
                            (end - offset).min(1_000),
                        )? {
                            let cells = if metadata.tool_kind == "serial" {
                                serial_cells(&sample, serial_mode, &mut serial_decoder)?
                            } else {
                                sample_cells(&sample, &metadata.fields, scopes_mode)
                            };
                            let row = ResultRow::new(
                                columns
                                    .iter()
                                    .cloned()
                                    .zip(cells)
                                    .map(|(name, value)| WorkflowOutput::new(name, value))
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
                    for (column, name) in columns.iter().enumerate() {
                        sheet
                            .write_string(0, column as u16, name)
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
                            let cells = if metadata.tool_kind == "serial" {
                                serial_cells(sample, serial_mode, &mut serial_decoder)?
                            } else {
                                sample_cells(sample, &metadata.fields, scopes_mode)
                            };
                            for (column, value) in cells.iter().enumerate() {
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
                BackgroundExportFormat::Bin => {
                    let mut file = file;
                    for offset in (start..end).step_by(1_000) {
                        for sample in store.lock().unwrap_or_else(|e| e.into_inner()).rows(
                            id,
                            offset,
                            (end - offset).min(1_000),
                        )? {
                            let bytes = raw_bytes(
                                sample["rx_hex"].as_str().ok_or("Missing Serial RX hex")?,
                            )?;
                            file.write_all(&bytes).map_err(|e| e.to_string())?;
                        }
                    }
                    file.flush().map_err(|e| e.to_string())?;
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
    fn serial_bin_and_csv_preserve_event_rows_and_raw_bytes() {
        let folder = std::env::temp_dir().join(format!(
            "orchestrator-serial-export-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&folder).unwrap();
        let store = Arc::new(Mutex::new(BackgroundStore::default()));
        let events = [("00ff", 2), ("0d", 1), ("0a68", 2)];
        store.lock().unwrap().datasets.push(Dataset {
            metadata: DatasetMetadata {
                id: "serial-capture".into(),
                background_id: "background-1".into(),
                worker_run_id: "run".into(),
                started_ms: 0,
                finished_ms: Some(1),
                status: "completed".into(),
                quality: "unknown".into(),
                row_count: events.len(),
                tool_kind: "serial".into(),
                rx_bytes: 5,
                fields: Vec::new(),
                field_stats: Default::default(),
                min: None,
                max: None,
                avg: None,
                csv_path: None,
                error: None,
            },
            samples: events
                .iter()
                .enumerate()
                .map(|(i, (hex, bytes))| {
                    json!({"timestamp_utc":"2026-11-02T00:00:00Z",
                    "elapsed_s":i as f64, "captured":i+1,
                    "rx_hex":hex, "rx_bytes":bytes})
                })
                .collect(),
        });
        let ids = vec!["serial-capture".to_owned()];
        let bin = export_datasets(
            &store,
            &ids,
            &folder,
            BackgroundExportFormat::Bin,
            DEFAULT_XLSX_ROWS,
        )
        .unwrap();
        assert_eq!(std::fs::read(&bin[0]).unwrap(), [0, 255, 13, 10, 104]);
        let csv = export_datasets(
            &store,
            &ids,
            &folder,
            BackgroundExportFormat::Csv,
            DEFAULT_XLSX_ROWS,
        )
        .unwrap();
        let mut reader = csv::Reader::from_path(&csv[0]).unwrap();
        let rows = reader.records().map(|r| r.unwrap()).collect::<Vec<_>>();
        assert_eq!(rows.len(), 3);
        assert_eq!(&rows[0][3], "00 FF");
        assert_eq!(&rows[2][3], "0A 68");
        let xlsx = export_datasets(
            &store,
            &ids,
            &folder,
            BackgroundExportFormat::Xlsx,
            DEFAULT_XLSX_ROWS,
        )
        .unwrap();
        let mut book: Xlsx<_> = calamine::open_workbook(&xlsx[0]).unwrap();
        let sheet = book.worksheet_range("Sheet1").unwrap();
        assert_eq!(sheet.height(), 4);
        assert_eq!(sheet.get((1, 3)), Some(&Data::String("00 FF".into())));

        let text_csv = export_datasets_with_serial_format(
            &store,
            &ids,
            &folder,
            BackgroundExportFormat::Csv,
            DEFAULT_XLSX_ROWS,
            ScopesExportMode::ValuesOnly,
            SerialDataFormat::Text,
        )
        .unwrap();
        let mut reader = csv::Reader::from_path(&text_csv[0]).unwrap();
        let text_rows = reader.records().map(|row| row.unwrap()).collect::<Vec<_>>();
        assert_eq!(&text_rows[0][3], "\\u{0}�");
        assert_eq!(&text_rows[1][3], "\\r");
        assert_eq!(&text_rows[2][3], "\\nh");
        // All selected datasets must be valid for BIN before creating any file.
        {
            let mut data = store.lock().unwrap();
            let mut other = data.datasets[0].metadata.clone();
            other.id = "meters-capture".into();
            other.tool_kind = "meters".into();
            data.datasets.push(Dataset {
                metadata: other,
                samples: Vec::new(),
            });
        }
        let invalid_ids = vec!["serial-capture".to_owned(), "meters-capture".to_owned()];
        assert!(
            export_datasets(
                &store,
                &invalid_ids,
                &folder,
                BackgroundExportFormat::Bin,
                DEFAULT_XLSX_ROWS,
            )
            .unwrap_err()
            .contains("only supported")
        );
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    #[ignore = "large manual export contract; run explicitly without instruments"]
    fn large_xlsx_splits_at_default_and_preserves_all_rows() {
        let count = DEFAULT_XLSX_ROWS + 1;
        let store = Arc::new(Mutex::new(BackgroundStore::default()));
        store.lock().unwrap().datasets.push(Dataset {
            metadata:DatasetMetadata {id:"background-1-capture-1".into(),background_id:"background-1".into(),worker_run_id:"worker".into(),
                started_ms:0,finished_ms:Some(1),status:"completed".into(),quality:"no_loss_detected".into(),row_count:count,tool_kind:"meters".into(),rx_bytes:0,fields:Vec::new(),field_stats:Default::default(),
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
