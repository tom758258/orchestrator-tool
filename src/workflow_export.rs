//! Page export helpers for committed ResultRows; Desktop CSV may stream rows directly.

use crate::{
    workflow::{OutputPage, ResultRow, Workflow},
    workflow_csv::{ResultRowsCsvWriter, export_cell},
};

pub struct PageDataset<'a> {
    pub page: &'a OutputPage,
    pub rows: Vec<&'a ResultRow>,
}

/// Selects committed rows in chronological order and validates their declared columns.
pub fn page_datasets<'a>(
    workflow: &'a Workflow,
    rows: &'a [ResultRow],
    selected: Option<&str>,
) -> Result<Vec<PageDataset<'a>>, String> {
    if let Some(name) = selected
        && !workflow
            .output_pages()
            .iter()
            .any(|page| page.name() == name)
    {
        return Err(format!("Unknown Output Page {name:?}"));
    }
    for row in rows {
        let page = workflow
            .output_pages()
            .iter()
            .find(|page| page.name() == row.page());
        if page.is_none() && row.outputs().is_empty() && workflow.output_pages().is_empty() {
            continue;
        }
        let page = page.ok_or_else(|| format!("Unknown row Page {:?}", row.page()))?;
        if !row
            .outputs()
            .iter()
            .map(|output| output.name())
            .eq(page.headers().iter().map(String::as_str))
        {
            return Err(format!("Row columns do not match Page {:?}", page.name()));
        }
        let loop_id = row
            .for_iteration()
            .map(|i| i.for_step_id())
            .or_else(|| row.while_iteration().map(|i| i.while_step_id()));
        if loop_id != page.row_scope().last() {
            return Err(format!("Row scope does not match Page {:?}", page.name()));
        }
    }
    Ok(workflow
        .output_pages()
        .iter()
        .filter(|page| selected.is_none_or(|name| name == page.name()))
        .map(|page| PageDataset {
            page,
            rows: rows
                .iter()
                .filter(|row| row.page() == page.name())
                .collect(),
        })
        .collect())
}

pub fn page_csv(dataset: &PageDataset<'_>) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    write_page_csv(dataset, &mut bytes)?;
    Ok(bytes)
}

/// Writes one Page directly to the provided destination.
pub fn write_page_csv(
    dataset: &PageDataset<'_>,
    destination: impl std::io::Write,
) -> Result<(), String> {
    write_page_csv_rows(dataset.page, dataset.rows.iter().copied(), destination)
}

/// Writes a Page's rows directly without constructing a second row-reference collection.
pub fn write_page_csv_rows<'a>(
    page: &OutputPage,
    rows: impl IntoIterator<Item = &'a ResultRow>,
    destination: impl std::io::Write,
) -> Result<(), String> {
    let mut writer = ResultRowsCsvWriter::new(destination, page.headers().to_vec())
        .map_err(|error| error.to_string())?;
    for row in rows {
        writer.write_row(row).map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Preserves JSON cell types, protecting integer precision and Excel's numeric range.
pub fn pages_xlsx(datasets: &[PageDataset<'_>]) -> Result<Vec<u8>, String> {
    if datasets.is_empty() {
        return Err("No Output Pages available for export".to_owned());
    }
    let mut workbook = rust_xlsxwriter::Workbook::new();
    for dataset in datasets {
        let worksheet = workbook.add_worksheet();
        worksheet
            .set_name(dataset.page.name())
            .map_err(|e| e.to_string())?;
        let formats: Vec<_> = dataset
            .page
            .time_formats()
            .iter()
            .map(|format| {
                format.map(|format| {
                    rust_xlsxwriter::Format::new().set_num_format(format.excel_number_format())
                })
            })
            .collect();
        for (column, name) in dataset.page.headers().iter().enumerate() {
            if dataset.page.time_formats()[column].is_some() {
                worksheet
                    .set_column_width(u16::try_from(column).map_err(|e| e.to_string())?, 36)
                    .map_err(|e| e.to_string())?;
            }
            worksheet
                .write_string(0, u16::try_from(column).map_err(|e| e.to_string())?, name)
                .map_err(|e| e.to_string())?;
        }
        for (index, row) in dataset.rows.iter().enumerate() {
            for (column, output) in row.outputs().iter().enumerate() {
                if let Some(time_format) = dataset.page.time_formats()[column] {
                    worksheet
                        .write_number_with_format(
                            u32::try_from(index + 1).map_err(|e| e.to_string())?,
                            u16::try_from(column).map_err(|e| e.to_string())?,
                            time_format.excel_value(output.value())?,
                            formats[column].as_ref().unwrap(),
                        )
                        .map_err(|e| e.to_string())?;
                    continue;
                }
                let row = u32::try_from(index + 1).map_err(|e| e.to_string())?;
                let column = u16::try_from(column).map_err(|e| e.to_string())?;
                let result = match output.value() {
                    serde_json::Value::Number(number) => match excel_number(number) {
                        Some(value) => worksheet.write_number(row, column, value),
                        None => worksheet.write_string(row, column, number.to_string()),
                    },
                    serde_json::Value::Bool(value) => worksheet.write_boolean(row, column, *value),
                    serde_json::Value::Null => continue,
                    value => worksheet.write_string(row, column, export_cell(value)),
                };
                result.map_err(|e| e.to_string())?;
            }
        }
    }
    workbook.save_to_buffer().map_err(|e| e.to_string())
}

// Compare decimal values independently of decimal-point placement and exponent notation.
fn decimal_parts(text: &str) -> (String, i32) {
    let (mantissa, exponent) = text.split_once(['e', 'E']).unwrap_or((text, "0"));
    let exponent: i32 = exponent.parse().expect("JSON number exponent");
    let fractional_digits = mantissa
        .split_once('.')
        .map_or(0, |(_, fraction)| fraction.len());
    let digits: String = mantissa.chars().filter(|c| c.is_ascii_digit()).collect();
    let digits = digits.trim_start_matches('0');
    if digits.is_empty() {
        return ("0".to_owned(), 0);
    }
    let significant = digits.trim_end_matches('0');
    let exponent = exponent - fractional_digits as i32 + (digits.len() - significant.len()) as i32;
    let sign = if mantissa.starts_with('-') { "-" } else { "" };
    (format!("{sign}{significant}"), exponent)
}

pub(crate) fn excel_number(number: &serde_json::Number) -> Option<f64> {
    let value = number.as_f64()?;
    // Excel does not support subnormal numbers, infinities, or NaN.
    if !value.is_finite() || (value != 0.0 && !value.is_normal()) {
        return None;
    }
    if value != 0.0 && !(2.2251e-308..=9.99999999999999e307).contains(&value.abs()) {
        return None;
    }
    // Accept ordinary floats at Excel's native precision without rounding the source value.
    if number.is_f64() {
        return Some(value);
    }
    let original = decimal_parts(&number.to_string());
    if original.0.trim_start_matches('-').len() > 15
        || original != decimal_parts(&value.to_string())
    {
        return None;
    }
    // A shortest decimal round trip alone does not prove a large integer is exact.
    if number
        .as_i64()
        .is_some_and(|integer| value as i128 != i128::from(integer))
        || number
            .as_u64()
            .is_some_and(|integer| value as i128 != i128::from(integer))
    {
        return None;
    }
    Some(value)
}
