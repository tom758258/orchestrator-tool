use std::{
    fs::{self, File, OpenOptions},
    io,
    path::{Path, PathBuf},
};

use orchestrator_tool::{
    template::Template,
    workflow::{Step, StepKind, WorkflowRunEvent, WorkflowRunResult},
    workflow_csv::ResultRowsCsvWriter,
};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
pub struct StreamCsvOptions {
    pub output_folder: Option<String>,
    pub timestamp: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct StreamCsvStatus {
    pub path: String,
    pub rows: usize,
    pub error: Option<String>,
    pub finished: bool,
    pub workflow_succeeded: bool,
}

fn output_names(steps: &[Step], names: &mut Vec<String>) {
    for step in steps {
        match step.kind() {
            StepKind::Output { name, .. } => names.push(name.clone()),
            StepKind::For { body, .. } | StepKind::While { body, .. } => output_names(body, names),
            _ => {}
        }
    }
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

fn prepare(
    template: &Template,
    options: &StreamCsvOptions,
    application_dir: &Path,
) -> Result<(ResultRowsCsvWriter<File>, StreamCsvStatus), String> {
    let mut names = Vec::new();
    output_names(template.workflow().steps(), &mut names);
    if names.is_empty() {
        return Err("Streaming CSV requires at least one Output.".to_owned());
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
    let (path, file) =
        create_unique_csv(&folder, &format!("{timestamp}_{name}")).map_err(|error| {
            format!(
                "Could not create streaming CSV in {}: {error}",
                folder.display()
            )
        })?;
    let writer = ResultRowsCsvWriter::new(file, names).map_err(|error| {
        let _ = fs::remove_file(&path);
        format!(
            "Could not initialize streaming CSV {}: {error}",
            path.display()
        )
    })?;
    Ok((
        writer,
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
pub fn run_with_stream(
    template: &Template,
    options: Option<&StreamCsvOptions>,
    application_dir: &Path,
    mut on_status: impl FnMut(StreamCsvStatus),
    mut on_event: impl FnMut(WorkflowRunEvent),
    run: impl FnOnce(&mut dyn FnMut(WorkflowRunEvent)) -> Result<WorkflowRunResult, String>,
) -> Result<WorkflowRunResult, String> {
    let mut stream = options
        .map(|options| prepare(template, options, application_dir))
        .transpose()?;
    if let Some((_, status)) = &stream {
        on_status(status.clone());
    }
    let result = run(&mut |event| {
        if let Some((writer, status)) = &mut stream
            && status.error.is_none()
            && let WorkflowRunEvent::ResultRowCommitted(row) = &event
        {
            match writer.write_row(row) {
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
        status.workflow_succeeded = result.as_ref().is_ok_and(|run| {
            crate::validate_completed_successful_run(template.workflow(), run.step_executions())
                .is_ok()
        });
        on_status(status);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use orchestrator_tool::workflow::{
        ResultRow, StepExecution, StepId, StepOutcome, StepResult, WorkflowOutput,
    };
    use serde_json::json;

    fn template() -> Template {
        Template::from_json_str(
            &json!({
                "schema_version": 1, "name": "test/name", "tool_instances": [],
                "workflow": { "steps": [{
                    "type": "output", "id": "out", "name": "value",
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
            timestamp: "2026-09-15-11-22-33".into(),
        }
    }

    fn row(name: &str) -> WorkflowRunEvent {
        WorkflowRunEvent::ResultRowCommitted(ResultRow::new(
            vec![WorkflowOutput::new(name.into(), json!(1))],
            None,
        ))
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
        let result = run_with_stream(
            &template(),
            Some(&options()),
            &dir,
            |_| {},
            |_| {},
            |_| {
                started = true;
                Ok(WorkflowRunResult::new(vec![], vec![]))
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
    fn committed_row_is_flushed_before_failure_and_preserved() {
        let dir = crate::tests::unique_test_dir("stream-partial");
        let path = dir.join("data/2026-09-15-11-22-33_test-name.csv");
        let mut statuses = Vec::new();
        let result = run_with_stream(
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
    fn failed_workflow_result_preserves_committed_row() {
        let dir = crate::tests::unique_test_dir("stream-failed-result");
        let path = dir.join("data/2026-09-15-11-22-33_test-name.csv");
        let mut statuses = Vec::new();
        let committed = ResultRow::new(vec![WorkflowOutput::new("value".into(), json!(1))], None);
        let failed = StepExecution::new(
            StepResult::new(
                StepId::new("out").unwrap(),
                StepOutcome::Failed {
                    message: "workflow step failed".into(),
                },
            ),
            None,
        );
        let result = run_with_stream(
            &template(),
            Some(&options()),
            &dir,
            |status| statuses.push(status),
            |_| {},
            |emit| {
                assert_eq!(fs::read_to_string(&path).unwrap(), "value\n");
                emit(WorkflowRunEvent::ResultRowCommitted(committed.clone()));
                Ok(WorkflowRunResult::new(
                    vec![failed.clone()],
                    vec![committed.clone()],
                ))
            },
        )
        .unwrap();
        assert_eq!(result.step_executions(), &[failed]);
        assert_eq!(result.result_rows(), &[committed]);
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
        let result = run_with_stream(
            &template(),
            Some(&options()),
            &dir,
            |status| statuses.push(status),
            |_| received += 1,
            |emit| {
                emit(row("wrong"));
                emit(row("value"));
                Ok(WorkflowRunResult::new(vec![], vec![]))
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
