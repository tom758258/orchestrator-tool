use std::{collections::HashMap, io::Cursor, time::Duration};

use calamine::{Data, Reader, Xlsx};
use orchestrator_tool::{
    template::Template,
    workflow::{ResultRow, WorkflowOutput},
    workflow_export::{page_csv, page_datasets, pages_xlsx},
};
use serde_json::{Value, json};

fn dataset(values: &[Value]) -> (Template, Vec<ResultRow>) {
    let steps: Vec<_> = values
        .iter()
        .enumerate()
        .map(|(index, value)| {
            json!({"type":"output", "id":format!("cell-{index}"),
            "name":format!("cell-{index}"), "page":"Values",
            "value":{"source":"literal", "value":value}})
        })
        .collect();
    let template = Template::from_json_str(
        &json!({
            "schema_version":1, "name":"Cell types", "tool_instances":[],
            "workflow":{"steps":steps}
        })
        .to_string(),
    )
    .unwrap();
    let outputs = values
        .iter()
        .enumerate()
        .map(|(index, value)| WorkflowOutput::new(format!("cell-{index}"), value.clone()))
        .collect();
    (
        template,
        vec![ResultRow::new(outputs, None).with_page("Values")],
    )
}

#[test]
fn xlsx_preserves_json_cell_types_without_changing_rows_or_csv() {
    let values = vec![
        json!(12.5),
        json!("12.5"),
        json!(true),
        Value::Null,
        json!([1, true]),
        json!({"value":5}),
        json!("=1+1"),
        json!(false),
        json!("001"),
        Value::Null,
    ];
    let (template, rows) = dataset(&values);
    let original_rows = rows.clone();
    let datasets = page_datasets(template.workflow(), &rows, Some("Values")).unwrap();
    let csv_before = page_csv(&datasets[0]).unwrap();
    assert_eq!(csv_before, b"cell-0,cell-1,cell-2,cell-3,cell-4,cell-5,cell-6,cell-7,cell-8,cell-9\n12.5,12.5,true,,\"[1,true]\",\"{\"\"value\"\":5}\",=1+1,false,001,\n");
    let mut workbook = Xlsx::new(Cursor::new(pages_xlsx(&datasets).unwrap())).unwrap();
    let range = workbook.worksheet_range("Values").unwrap();
    let expected = [
        Data::Float(12.5),
        Data::String("12.5".into()),
        Data::Bool(true),
        Data::Empty,
        Data::String("[1,true]".into()),
        Data::String(r#"{"value":5}"#.into()),
        Data::String("=1+1".into()),
        Data::Bool(false),
        Data::String("001".into()),
        Data::Empty,
    ];
    for (column, expected) in expected.iter().enumerate() {
        assert_eq!(
            range.get_value((0, column as u32)),
            Some(&Data::String(format!("cell-{column}")))
        );
        assert_eq!(range.get_value((1, column as u32)), Some(expected));
    }
    assert_eq!(rows, original_rows);
    assert_eq!(page_csv(&datasets[0]).unwrap(), csv_before);
}

#[test]
fn xlsx_numbers_keep_safe_precision_and_preserve_unsafe_json_text() {
    let cases = [
        ("0", true),
        ("-42", true),
        ("0.1", true),
        ("5.0012", true),
        ("999999999999999", true),
        ("-999999999999999", true),
        ("1000000000000000", true),
        ("1000000000000000000", true),
        ("0.123456789012345", true),
        ("0.000000000123456789012345", true),
        ("1.23456789012345e100", true),
        ("1e-300", true),
        ("2.2251e-308", true),
        ("-2.2251e-308", true),
        ("9.99999999999999e307", true),
        ("-9.99999999999999e307", true),
        ("2.22509e-308", false),
        ("-2.22509e-308", false),
        ("1e308", false),
        ("-1e308", false),
        ("1000000000000001", false),
        ("-1000000000000001", false),
        ("1000000000000001.0", true),
        ("9007199254740991", false),
        ("9007199254740992", false),
        ("9007199254740993", false),
        ("18446744073709551615", false),
        ("-9223372036854775808", false),
        ("1234567890123450000", false),
        ("0.1234567890123456", true),
        ("10.600000000000001", true),
        ("-10.600000000000001", true),
        ("1.234567890123456e100", true),
        ("1e-308", false),
        ("5e-324", false),
    ];
    let values: Vec<Value> = cases
        .iter()
        .map(|(text, _)| serde_json::from_str(text).unwrap())
        .collect();
    let (template, rows) = dataset(&values);
    let datasets = page_datasets(template.workflow(), &rows, None).unwrap();
    let mut workbook = Xlsx::new(Cursor::new(pages_xlsx(&datasets).unwrap())).unwrap();
    let range = workbook.worksheet_range("Values").unwrap();
    for (column, ((text, safe), value)) in cases.iter().zip(&values).enumerate() {
        let expected = if *safe {
            Data::Float(value.as_f64().unwrap())
        } else {
            Data::String(value.to_string())
        };
        assert_eq!(
            range.get_value((1, column as u32)),
            Some(&expected),
            "{text}"
        );
    }
    let csv = page_csv(&datasets[0]).unwrap();
    let mut reader = csv::Reader::from_reader(csv.as_slice());
    let record = reader.records().next().unwrap().unwrap();
    assert_eq!(
        record.iter().collect::<Vec<_>>(),
        values.iter().map(Value::to_string).collect::<Vec<_>>()
    );
}

#[test]
fn xlsx_exports_all_accumulated_float_rows_as_numbers_without_rounding() {
    let template = Template::from_json_str(
        &json!({
            "schema_version": 1, "name": "Float accumulation", "tool_instances": [],
            "workflow": { "steps": [
                { "type": "set-variable", "id": "init", "variable": "y",
                  "value": { "source": "literal", "value": 10 } },
                { "type": "for", "id": "repeat", "variable": "i",
                  "range": { "start": "1", "stop": "20", "step": "1" }, "steps": [
                    { "type": "set-variable", "id": "add", "variable": "y", "value": {
                        "source": "expression", "left": { "source": "variable", "variable": "y" },
                        "operator": "add", "right": { "source": "literal", "value": 0.3 } } },
                    { "type": "output", "id": "out", "name": "y", "page": "Values",
                      "value": { "source": "variable", "variable": "y" } }
                  ] }
            ] }
        })
        .to_string(),
    )
    .unwrap();
    let run = orchestrator_tool::executor::execute_workflow(
        &template,
        &HashMap::new(),
        orchestrator_tool::run::ExecutionMode::Simulate,
        Duration::from_secs(1),
    )
    .unwrap();
    let rows = run.result_rows();
    assert_eq!(rows.len(), 20);
    let original_rows = rows.to_vec();
    let datasets = page_datasets(template.workflow(), rows, None).unwrap();
    let csv_before = page_csv(&datasets[0]).unwrap();
    let mut workbook = Xlsx::new(Cursor::new(pages_xlsx(&datasets).unwrap())).unwrap();
    let range = workbook.worksheet_range("Values").unwrap();
    let mut expected = 10.0;
    for (index, row) in rows.iter().enumerate() {
        expected += 0.3;
        let original = row.outputs()[0].value().as_f64().unwrap();
        assert_eq!(original, expected);
        let Some(Data::Float(exported)) = range.get_value(((index + 1) as u32, 0)) else {
            panic!("Row {index} must be an Excel Number");
        };
        assert!((exported - original).abs() <= original.abs() * f64::EPSILON);
    }
    assert_eq!(rows, original_rows);
    assert_eq!(page_csv(&datasets[0]).unwrap(), csv_before);
    assert!(
        String::from_utf8(csv_before)
            .unwrap()
            .contains("10.600000000000001")
    );
}
