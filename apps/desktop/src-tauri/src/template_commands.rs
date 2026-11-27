use orchestrator_tool::template::{Template, TemplateError};
use orchestrator_tool::workflow::Workflow;
use serde::Serialize;

#[tauri::command]
pub(super) fn create_workflow_draft() -> Result<String, String> {
    let workflow = Workflow::new(Vec::new()).map_err(|error| error.to_string())?;
    Template::new("Untitled".to_owned(), Default::default(), workflow)
        .and_then(|template| template.to_json_string())
        .map_err(|error| error.to_string())
}

#[derive(Debug, Serialize)]
pub(super) struct DraftValidationError {
    message: String,
    step_id: Option<String>,
}

impl From<TemplateError> for DraftValidationError {
    fn from(error: TemplateError) -> Self {
        let step_id = match &error {
            TemplateError::Workflow(error) => error.step_id().map(ToString::to_string),
            _ => None,
        };
        Self {
            message: error.to_string(),
            step_id,
        }
    }
}

#[tauri::command]
pub(super) fn validate_workflow_draft(
    template_json: String,
) -> Result<String, DraftValidationError> {
    Template::from_json_str(&template_json)
        .and_then(|template| template.to_json_string())
        .map_err(DraftValidationError::from)
}

#[tauri::command]
pub(super) fn save_workflow_template(
    path: String,
    template_json: String,
) -> Result<String, String> {
    let template = Template::from_json_str(&template_json).map_err(|error| error.to_string())?;
    template
        .save_to_file(&path)
        .map_err(|error| error.to_string())?;
    template.to_json_string().map_err(|error| error.to_string())
}

#[tauri::command]
pub(super) fn check_serial_send_files(template_json: String) -> Result<Vec<String>, String> {
    let template = Template::from_json_str(&template_json).map_err(|error| error.to_string())?;
    Ok(orchestrator_tool::adapters::serial::send_file_path_errors(
        &template,
    ))
}

#[tauri::command]
pub(super) fn load_workflow_template(path: String) -> Result<String, String> {
    let template = Template::load_from_file(&path).map_err(|error| error.to_string())?;
    template.to_json_string().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        create_workflow_draft, load_workflow_template, save_workflow_template,
        validate_workflow_draft,
    };
    use crate::unique_test_dir;
    use orchestrator_tool::template::Template;
    use serde_json::json;

    #[test]
    fn create_and_validate_workflow_drafts_use_current_schema() {
        let json = create_workflow_draft().unwrap();
        let template = Template::from_json_str(&json).unwrap();
        assert_eq!(template.name(), "Untitled");
        assert!(template.workflow().steps().is_empty());
        let wire: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(
            wire["workflow"]["interaction"],
            json!({"enabled":false,"max_active_command_status":4096,"buffer":{"enabled":false,"mode":"fifo","overflow_policy":"fail-run"}})
        );
        let invalid = r#"{
            "tool_instances": [],
            "name": "Invalid",
            "workflow": {"interaction":{"enabled":false,"max_active_command_status":4096,"buffer":{"enabled":false,"mode":"fifo","overflow_policy":"fail-run"}}, "steps": [
                { "type": "wait", "id": "Wait-1", "duration_ms": 1 }
            ] }
        }"#;
        let error = validate_workflow_draft(invalid.to_owned()).unwrap_err();
        assert!(error.message.contains("invalid step ID"));
        assert!(error.step_id.is_none());
        let invalid_reference = r#"{
            "name": "Invalid reference", "tool_instances": [],
            "workflow": {"interaction":{"enabled":false,"max_active_command_status":4096,"buffer":{"enabled":false,"mode":"fifo","overflow_policy":"fail-run"}}, "steps": [
                { "type": "output", "id": "out", "name": "Value", "page": "Results",
                  "value": { "source": "variable", "variable": "missing" } }
            ] }
        }"#;
        let error = validate_workflow_draft(invalid_reference.to_owned()).unwrap_err();
        assert_eq!(error.step_id.as_deref(), Some("out"));
        let wire = serde_json::to_value(error).unwrap();
        assert_eq!(wire["step_id"], "out");
        assert!(wire["message"].as_str().unwrap().contains("missing"));
    }

    #[test]
    fn save_and_load_workflow_template_round_trip() {
        let dir = unique_test_dir("orchestrator-template-round-trip");
        let path = dir.join("template.json");
        let template_json = r#"{
            "tool_instances": [],
            "name": "Round Trip",
            "workflow": {"interaction":{"enabled":true,"max_active_command_status":12,"buffer":{"enabled":false,"mode":"fifo","overflow_policy":"fail-run"}}, "steps": [
                {
                    "type": "output", "id": "voltage", "name": "Voltage", "page": "Results",
                    "value": { "source": "literal", "value": 3.3 }
                }
            ] },
            "output_views": { "charts": [{
                "page": "Results",
                "title": "Voltage",
                "outputs": ["Voltage"],
                "type": "line",
                "scatter_x_output": null,
                "scatter": { "display": "markers", "marker_size": 4.0, "line_width": 2.0 },
                "line": { "series": {} },
                "marker_styles": {},
                "series_colors": {},
                "show_legend": true,
                "legend_position": "top",
                "image_background": "light",
                "show_all_raw_data": false,
                "zoom": { "enabled": false, "show_slider": true },
                "x_axis": {
                    "title": "Iteration", "min": null, "max": null, "interval": null,
                    "show_labels": true, "show_ticks": true, "show_major_grid": false
                },
                "y_axis": {
                    "title": "Voltage", "min": null, "max": null, "interval": null,
                    "show_labels": true, "show_ticks": true, "show_major_grid": true
                },
                "combo": {
                    "series": {},
                    "right_axis": {
                        "title": "", "min": null, "max": null, "interval": null,
                        "show_labels": true, "show_ticks": true, "show_major_grid": false
                    }
                },
                "histogram": {
                    "mode": "auto", "value": null, "show_normal_curve": false,
                    "mean": null, "std_dev": null
                },
                "box_plot": { "show_outliers": true }
            }] }
        }"#;
        let saved =
            save_workflow_template(path.display().to_string(), template_json.to_owned()).unwrap();
        let loaded = load_workflow_template(path.display().to_string()).unwrap();
        assert!(saved.contains("\"output_views\""));
        assert_eq!(saved, loaded);
        let wire: serde_json::Value = serde_json::from_str(&loaded).unwrap();
        assert_eq!(
            wire["workflow"]["interaction"],
            json!({"enabled":true,"max_active_command_status":12,"buffer":{"enabled":false,"mode":"fifo","overflow_policy":"fail-run"}})
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
