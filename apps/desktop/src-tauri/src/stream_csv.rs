use std::{
    fs::{self, File, OpenOptions},
    io,
    path::{Path, PathBuf},
};

use orchestrator_tool::{
    template::Template,
    workflow::{OutputPage, WorkflowRunEvent},
    workflow_csv::ResultRowsCsvWriter,
};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
pub struct StreamCsvOptions {
    pub output_folder: Option<String>,
    pub timestamp: String,
    #[serde(default)]
    pub page: Option<String>,
    #[serde(default)]
    pub destination_path: Option<String>,
    #[serde(default)]
    pub all_pages: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct StreamCsvStatus {
    pub path: String,
    pub rows: usize,
    pub error: Option<String>,
    pub finished: bool,
    pub workflow_succeeded: bool,
}

struct PageWriter {
    page: String,
    writer: ResultRowsCsvWriter<File>,
}

fn create_unique_csv(folder: &Path, stem: &str) -> io::Result<(PathBuf, File)> {
    fs::create_dir_all(folder)?;
    for suffix in 1_u64.. {
        let name = if suffix == 1 {
            format!("{stem}.csv")
        } else {
            format!("{stem}-{suffix}.csv")
        };
        let path = folder.join(name);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    unreachable!()
}

fn prepare_all_pages_with(
    folder: &Path,
    stem: &str,
    pages: &[OutputPage],
    mut create_writer: impl FnMut(&Path, &OutputPage) -> Result<PageWriter, String>,
) -> Result<(PathBuf, Vec<PageWriter>), String> {
    fs::create_dir_all(folder).map_err(|error| error.to_string())?;
    let mut suffix = 1;
    let path = loop {
        let candidate = folder.join(if suffix == 1 {
            stem.to_owned()
        } else {
            format!("{stem}-{suffix}")
        });
        match fs::create_dir(&candidate) {
            Ok(()) => break candidate,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => suffix += 1,
            Err(error) => return Err(error.to_string()),
        }
    };
    let mut writers = Vec::new();
    for page in pages {
        match create_writer(&path, page) {
            Ok(writer) => writers.push(writer),
            Err(error) => {
                drop(writers);
                let _ = fs::remove_dir_all(&path);
                return Err(error);
            }
        }
    }
    Ok((path, writers))
}

fn create_page_writer(path: &Path, page: &OutputPage) -> Result<PageWriter, String> {
    let file = File::create(path.join(format!("{}.csv", page.name())))
        .map_err(|error| error.to_string())?;
    let writer = ResultRowsCsvWriter::new(file, page.headers().to_vec())
        .map_err(|error| error.to_string())?;
    Ok(PageWriter {
        page: page.name().to_owned(),
        writer,
    })
}

fn prepare(
    template: &Template,
    options: &StreamCsvOptions,
    application_dir: &Path,
) -> Result<(Vec<PageWriter>, StreamCsvStatus), String> {
    let pages = template.workflow().output_pages();
    if pages.is_empty() {
        return Err("Streaming CSV requires at least one Output.".to_owned());
    }
    let selected = options.page.as_deref().unwrap_or(pages[0].name());
    if !options.all_pages && !pages.iter().any(|page| page.name() == selected) {
        return Err("Unknown streaming Output Page".to_owned());
    }
    let timestamp = &options.timestamp;
    if timestamp.len() != 19
        || !timestamp.bytes().enumerate().all(|(i, byte)| {
            if [4, 7, 10, 13, 16].contains(&i) {
                byte == b'-'
            } else {
                byte.is_ascii_digit()
            }
        })
    {
        return Err("Invalid streaming CSV timestamp.".to_owned());
    }
    let name: String = template
        .name()
        .chars()
        .map(|ch| {
            if ch.is_control() || r#"<>:"/\|?*"#.contains(ch) || ch.is_whitespace() {
                '-'
            } else {
                ch
            }
        })
        .take(100)
        .collect();
    let name = name.trim_matches(['.', '-', ' ']);
    let name = if name.is_empty() { "workflow" } else { name };
    let folder = application_dir.join(options.output_folder.as_deref().unwrap_or("data"));
    let folder = std::path::absolute(&folder).map_err(|error| error.to_string())?;
    let stem = format!("{timestamp}_{name}");
    let mut writers;
    let path;
    if options.all_pages {
        (path, writers) = prepare_all_pages_with(&folder, &stem, pages, create_page_writer)?;
    } else {
        writers = Vec::new();
        let page = pages.iter().find(|page| page.name() == selected).unwrap();
        let (file_path, file) = if let Some(destination) = &options.destination_path {
            let destination = PathBuf::from(destination);
            let file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&destination)
                .map_err(|e| format!("Could not create streaming CSV: {e}"))?;
            (destination, file)
        } else {
            create_unique_csv(&folder, &stem)
                .map_err(|e| format!("Could not create streaming CSV: {e}"))?
        };
        path = file_path;
        let writer = ResultRowsCsvWriter::new(file, page.headers().to_vec()).map_err(|error| {
            let _ = fs::remove_file(&path);
            format!("Could not initialize streaming CSV: {error}")
        })?;
        writers.push(PageWriter {
            page: selected.to_owned(),
            writer,
        });
    }
    Ok((
        writers,
        StreamCsvStatus {
            path: path.display().to_string(),
            rows: 0,
            error: None,
            finished: false,
            workflow_succeeded: false,
        },
    ))
}

/// Opens and flushes the header before invoking any workflow execution.
pub fn run_streaming_with_stream<T>(
    template: &Template,
    options: Option<&StreamCsvOptions>,
    application_dir: &Path,
    on_status: impl FnMut(StreamCsvStatus),
    on_event: impl FnMut(WorkflowRunEvent),
    run: impl FnOnce(&mut dyn FnMut(WorkflowRunEvent)) -> Result<T, String>,
    is_successful: impl FnOnce(&T) -> bool,
) -> Result<T, String> {
    run_with_stream_completion(
        template,
        options,
        application_dir,
        on_status,
        on_event,
        run,
        is_successful,
    )
}

fn run_with_stream_completion<T>(
    template: &Template,
    options: Option<&StreamCsvOptions>,
    application_dir: &Path,
    mut on_status: impl FnMut(StreamCsvStatus),
    mut on_event: impl FnMut(WorkflowRunEvent),
    run: impl FnOnce(&mut dyn FnMut(WorkflowRunEvent)) -> Result<T, String>,
    is_successful: impl FnOnce(&T) -> bool,
) -> Result<T, String> {
    let mut stream = options
        .map(|options| prepare(template, options, application_dir))
        .transpose()?;
    if let Some((_, status)) = &stream {
        on_status(status.clone());
    }
    let result = run(&mut |event| {
        if let Some((writers, status)) = &mut stream
            && status.error.is_none()
            && let WorkflowRunEvent::ResultRowCommitted(row) = &event
            && let Some(writer) = writers.iter_mut().find(|writer| writer.page == row.page())
        {
            match writer.writer.write_row(row) {
                Ok(()) => status.rows += 1,
                Err(error) => {
                    status.error = Some(error.to_string());
                    on_status(status.clone());
                }
            }
        }
        on_event(event);
    });
    if let Some((_, mut status)) = stream {
        status.finished = true;
        status.workflow_succeeded = result.as_ref().is_ok_and(is_successful);
        on_status(status);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use orchestrator_tool::workflow::{ResultRow, WorkflowOutput};
    use serde_json::json;

    fn template() -> Template {
        Template::from_json_str(
            &json!({
                "schema_version": 1, "name": "test/name", "tool_instances": [],
                "workflow": { "steps": [{
                    "type": "output", "id": "out", "name": "value", "page": "Results",
                    "value": { "source": "literal", "value": 1 }
                }] }
            })
            .to_string(),
        )
        .unwrap()
    }

    fn options() -> StreamCsvOptions {
        StreamCsvOptions {
            output_folder: None,
            page: None,
            destination_path: None,
            all_pages: false,
            timestamp: "2026-09-15-11-22-33".into(),
        }
    }

    fn run_test_stream(
        template: &Template,
        options: Option<&StreamCsvOptions>,
        application_dir: &Path,
        on_status: impl FnMut(StreamCsvStatus),
        on_event: impl FnMut(WorkflowRunEvent),
        run: impl FnOnce(&mut dyn FnMut(WorkflowRunEvent)) -> Result<bool, String>,
    ) -> Result<bool, String> {
        run_streaming_with_stream(
            template,
            options,
            application_dir,
            on_status,
            on_event,
            run,
            |succeeded| *succeeded,
        )
    }

    fn row(name: &str) -> WorkflowRunEvent {
        WorkflowRunEvent::ResultRowCommitted(ResultRow::new(
            vec![WorkflowOutput::new(name.into(), json!(1))],
            None,
        ))
    }

    #[test]
    fn selected_and_all_pages_route_and_flush_only_their_rows() {
        let template = Template::from_json_str(&json!({
            "schema_version": 1, "name": "pages", "tool_instances": [],
            "workflow": {"steps": [
                {"type":"output", "id":"a", "name":"a", "page":"Outer", "value":{"source":"literal", "value":1}},
                {"type":"output", "id":"b", "name":"b", "page":"Inner", "value":{"source":"literal", "value":2}}
            ]}
        }).to_string()).unwrap();
        for all_pages in [false, true] {
            let dir = crate::tests::unique_test_dir("stream-pages");
            let mut options = options();
            options.all_pages = all_pages;
            options.page = Some("Inner".into());
            let path = dir.join("data/2026-09-15-11-22-33_pages");
            let selected = path.with_extension("csv");
            let mut statuses = Vec::new();
            let result = run_test_stream(
                &template,
                Some(&options),
                &dir,
                |status| statuses.push(status),
                |_| {},
                |emit| {
                    for (page, name, value) in
                        [("Inner", "b", 2), ("Outer", "a", 1), ("Inner", "b", 3)]
                    {
                        emit(WorkflowRunEvent::ResultRowCommitted(
                            ResultRow::new(
                                vec![WorkflowOutput::new(name.into(), json!(value))],
                                None,
                            )
                            .with_page(page),
                        ));
                    }
                    let inner = if all_pages {
                        path.join("Inner.csv")
                    } else {
                        selected.clone()
                    };
                    assert_eq!(fs::read_to_string(inner).unwrap(), "b\n2\n3\n");
                    if all_pages {
                        assert_eq!(
                            fs::read_to_string(path.join("Outer.csv")).unwrap(),
                            "a\n1\n"
                        );
                    }
                    Err("later failure".into())
                },
            );
            assert!(result.is_err());
            let status = statuses.last().unwrap();
            assert!(status.finished && !status.workflow_succeeded);
            assert_eq!(status.rows, if all_pages { 3 } else { 2 });
            fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn collision_uses_next_suffix_without_overwriting() {
        let dir = crate::tests::unique_test_dir("stream-collision");
        fs::write(dir.join("name.csv"), "first").unwrap();
        fs::write(dir.join("name-2.csv"), "second").unwrap();
        let (path, file) = create_unique_csv(&dir, "name").unwrap();
        assert_eq!(path, dir.join("name-3.csv"));
        assert_eq!(fs::read_to_string(dir.join("name.csv")).unwrap(), "first");
        assert_eq!(
            fs::read_to_string(dir.join("name-2.csv")).unwrap(),
            "second"
        );
        drop(file);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn file_creation_failure_prevents_execution() {
        let dir = crate::tests::unique_test_dir("stream-start-failure");
        fs::write(dir.join("data"), "blocks folder creation").unwrap();
        let mut started = false;
        let result = run_test_stream(
            &template(),
            Some(&options()),
            &dir,
            |_| {},
            |_| {},
            |_| {
                started = true;
                Ok(true)
            },
        );
        assert!(
            result
                .unwrap_err()
                .contains("Could not create streaming CSV")
        );
        assert!(!started);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn all_pages_prepare_failure_removes_partial_run_folder_before_execution() {
        let template = Template::from_json_str(
            &json!({
                "schema_version": 1, "name": "pages", "tool_instances": [],
                "workflow": { "steps": [
                    { "type": "output", "id": "one", "name": "one", "page": "One",
                      "value": { "source": "literal", "value": 1 } },
                    { "type": "output", "id": "two", "name": "two", "page": "Two",
                      "value": { "source": "literal", "value": 2 } }
                ] }
            })
            .to_string(),
        )
        .unwrap();
        let dir = crate::tests::unique_test_dir("stream-all-prepare-failure");
        let folder = dir.join("data");
        let run_folder = folder.join("run");
        let mut started = false;
        let result = prepare_all_pages_with(
            &folder,
            "run",
            template.workflow().output_pages(),
            |path, page| {
                if page.name() == "Two" {
                    return Err("injected header initialization failure".to_owned());
                }
                create_page_writer(path, page)
            },
        )
        .map(|prepared| {
            drop(prepared);
            started = true;
        });

        assert_eq!(
            result.unwrap_err(),
            "injected header initialization failure"
        );
        assert!(!started);
        assert!(!run_folder.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn committed_row_is_flushed_before_failure_and_preserved() {
        let dir = crate::tests::unique_test_dir("stream-partial");
        let path = dir.join("data/2026-09-15-11-22-33_test-name.csv");
        let mut statuses = Vec::new();
        let result = run_test_stream(
            &template(),
            Some(&options()),
            &dir,
            |status| statuses.push(status),
            |_| {},
            |emit| {
                assert_eq!(fs::read_to_string(&path).unwrap(), "value\n");
                emit(row("value"));
                assert_eq!(fs::read_to_string(&path).unwrap(), "value\n1\n");
                Err("workflow failed".into())
            },
        );
        assert_eq!(result.unwrap_err(), "workflow failed");
        assert_eq!(fs::read_to_string(path).unwrap(), "value\n1\n");
        let status = statuses.last().unwrap();
        assert!(status.finished);
        assert!(!status.workflow_succeeded);
        assert_eq!(status.rows, 1);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_completion_preserves_committed_row() {
        let dir = crate::tests::unique_test_dir("stream-failed-result");
        let path = dir.join("data/2026-09-15-11-22-33_test-name.csv");
        let mut statuses = Vec::new();
        let result = run_test_stream(
            &template(),
            Some(&options()),
            &dir,
            |status| statuses.push(status),
            |_| {},
            |emit| {
                emit(row("value"));
                Ok(false)
            },
        )
        .unwrap();
        assert!(!result);
        assert_eq!(fs::read_to_string(path).unwrap(), "value\n1\n");
        let status = statuses.last().unwrap();
        assert!(status.finished);
        assert!(!status.workflow_succeeded);
        assert_eq!(status.rows, 1);
        assert_eq!(status.error, None);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn streaming_error_stops_attempts_but_preserves_execution_result() {
        let dir = crate::tests::unique_test_dir("stream-error");
        let mut statuses = Vec::new();
        let mut received = 0;
        let result = run_test_stream(
            &template(),
            Some(&options()),
            &dir,
            |status| statuses.push(status),
            |_| received += 1,
            |emit| {
                emit(row("wrong"));
                emit(row("value"));
                Ok(true)
            },
        );
        assert!(result.is_ok());
        assert_eq!(received, 2);
        let status = statuses.last().unwrap();
        assert!(status.error.is_some());
        assert_eq!(status.rows, 0);
        assert_eq!(fs::read_to_string(&status.path).unwrap(), "value\n");
        fs::remove_dir_all(dir).unwrap();
    }
}
