//! Page datasets shared by manual CSV and XLSX export.

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

/// Uses the same text conversion as CSV, without formulas or automatic type coercion.
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
        for (column, name) in dataset.page.headers().iter().enumerate() {
            worksheet
                .write_string(0, u16::try_from(column).map_err(|e| e.to_string())?, name)
                .map_err(|e| e.to_string())?;
        }
        for (index, row) in dataset.rows.iter().enumerate() {
            for (column, output) in row.outputs().iter().enumerate() {
                worksheet
                    .write_string(
                        u32::try_from(index + 1).map_err(|e| e.to_string())?,
                        u16::try_from(column).map_err(|e| e.to_string())?,
                        export_cell(output.value()),
                    )
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    workbook.save_to_buffer().map_err(|e| e.to_string())
}
