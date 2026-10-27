use std::io::Cursor;

use calamine::{Data, Reader, Xlsx};
use orchestrator_tool::{
    output_time::timestamp_millis,
    template::Template,
    workflow::{ResultRow, WorkflowOutput},
    workflow_csv::ResultRowsCsvWriter,
    workflow_export::{page_csv, page_datasets, pages_xlsx},
};
use serde_json::{Value, json};

fn time_template() -> Value {
    let mut steps = Vec::new();
    for format in [
        "seconds",
        "minutes-seconds",
        "hours-minutes-seconds",
        "days-decimal",
    ] {
        steps.push(json!({"type":"output", "id":format, "name":format, "page":"Time",
            "value":{"source":"elapsed-time"}, "time_format":{"kind":"elapsed-time", "format":format}}));
    }
    for (index, (date, offset)) in [(true, true), (true, false), (false, true), (false, false)]
        .into_iter()
        .enumerate()
    {
        steps.push(json!({"type":"output", "id":format!("stamp-{index}"), "name":format!("stamp-{index}"), "page":"Time",
            "value":{"source":"timestamp"}, "time_format":{"kind":"timestamp", "include_date":date, "include_utc_offset":offset}}));
    }
    json!({"schema_version":2, "name":"Time formats", "tool_instances":[], "workflow":{"steps":steps}})
}

#[test]
fn output_time_template_v1_round_trip_and_validation() {
    let wire = time_template();
    let template = Template::from_json_str(&wire.to_string()).unwrap();
    let saved = template.to_json_string().unwrap();
    assert_eq!(serde_json::from_str::<Value>(&saved).unwrap(), wire);
    assert_eq!(Template::from_json_str(&saved).unwrap(), template);
    assert_eq!(
        template.workflow().output_pages()[0].time_formats().len(),
        8
    );
    for index in 0..8 {
        let mut invalid = wire.clone();
        invalid["workflow"]["steps"][index]
            .as_object_mut()
            .unwrap()
            .remove("time_format");
        assert!(Template::from_json_str(&invalid.to_string()).is_err());
        let mut invalid = wire.clone();
        invalid["workflow"]["steps"][index]["value"] = json!({"source":"literal", "value":1});
        assert!(Template::from_json_str(&invalid.to_string()).is_err());
        invalid["workflow"]["steps"][index]
            .as_object_mut()
            .unwrap()
            .remove("time_format");
        assert!(Template::from_json_str(&invalid.to_string()).is_ok());
    }
    for invalid_format in [
        json!({"kind":"elapsed-time", "format":"general"}),
        json!({"kind":"timestamp", "include_date":true, "include_utc_offset":true}),
        json!({"kind":"elapsed-time", "format":"seconds", "include_date":false}),
    ] {
        let mut invalid = wire.clone();
        invalid["workflow"]["steps"][0]["time_format"] = invalid_format;
        assert!(Template::from_json_str(&invalid.to_string()).is_err());
    }
}

#[test]
fn output_time_xlsx_numeric_cells_and_raw_csv_across_midnight() {
    let template = Template::from_json_str(&time_template().to_string()).unwrap();
    let stamps = [
        "2026-10-12T23:59:59.900+08:00",
        "2026-10-13T00:00:00.100+08:00",
    ];
    let rows: Vec<_> = stamps
        .iter()
        .enumerate()
        .map(|(index, stamp)| {
            ResultRow::new(
                template.workflow().output_pages()[0]
                    .headers()
                    .iter()
                    .enumerate()
                    .map(|(column, name)| {
                        WorkflowOutput::new(
                            name.clone(),
                            if column < 4 {
                                json!(90061.123 + index as f64 * 0.2)
                            } else {
                                json!(stamp)
                            },
                        )
                    })
                    .collect(),
                None,
            )
            .with_page("Time")
        })
        .collect();
    let original = rows.clone();
    let datasets = page_datasets(template.workflow(), &rows, None).unwrap();
    let bytes = pages_xlsx(&datasets).unwrap();
    // Optional artifact for inspecting the real ZIP/XML without adding a ZIP dependency.
    if let Some(path) = std::env::var_os("TIME_FORMAT_XLSX_PATH") {
        std::fs::write(path, &bytes).unwrap();
    }
    let mut workbook = Xlsx::new(Cursor::new(bytes)).unwrap();
    let range = workbook.worksheet_range("Time").unwrap();
    let numeric = |row, column| match range.get_value((row, column)).unwrap() {
        Data::Float(value) => *value,
        Data::DateTime(value) => value.as_f64(),
        value => panic!("Expected numeric time cell, got {value:?}"),
    };
    for column in 0..4 {
        let divisor = if column == 0 { 1.0 } else { 86400.0 };
        assert!((numeric(1, column) - 90061.123 / divisor).abs() < 1e-10);
        assert!(((numeric(2, column) - numeric(1, column)) * divisor - 0.2).abs() < 1e-8);
    }
    for column in 4..8 {
        let expected = 46307.0 + 86399.9 / 86400.0;
        assert!((numeric(1, column) - expected).abs() < 1e-10);
        assert!((numeric(2, column) - (46308.0 + 0.1 / 86400.0)).abs() < 1e-10);
        assert!(((numeric(2, column) - numeric(1, column)) * 86400.0 - 0.2).abs() < 1e-6);
    }
    assert_eq!(
        timestamp_millis(&json!(stamps[1])).unwrap() - timestamp_millis(&json!(stamps[0])).unwrap(),
        200.0
    );
    let csv = page_csv(&datasets[0]).unwrap();
    let mut reader = csv::Reader::from_reader(csv.as_slice());
    for (index, record) in reader.records().enumerate() {
        let record = record.unwrap();
        for column in 0..4 {
            assert_eq!(
                record[column].parse::<f64>().unwrap(),
                90061.123 + index as f64 * 0.2
            );
        }
        for column in 4..8 {
            assert_eq!(&record[column], stamps[index]);
        }
    }
    let mut streamed = Vec::new();
    let mut writer =
        ResultRowsCsvWriter::new(&mut streamed, datasets[0].page.headers().to_vec()).unwrap();
    for row in &rows {
        writer.write_row(row).unwrap();
    }
    drop(writer);
    assert_eq!(streamed, csv);
    assert_eq!(rows, original);
}
