//! Fixed Live capability checks shared by application frontends.
use crate::{
    adapters::{powers, scopes},
    config::Config,
    run::ExecutionMode,
    template::Template,
    tool_instance::ToolInstance,
    workflow::{Step, StepKind},
};
use serde_json::Value;
use std::path::Path;

/// Returns all known incompatibilities without starting Workers or changing the template.
pub fn validate_live_preflight(
    template: &Template,
    application_dir: &Path,
    config: &Config,
) -> Vec<String> {
    let mut errors = Vec::new();
    if let Err(error) = crate::run_preparation::validate_live_resources(template, config) {
        errors.push(error);
    }
    errors.extend(validate_with_capabilities(template, |instance| {
        query_capabilities(instance, application_dir, config)
    }));
    errors
}

fn query_capabilities(
    instance: &ToolInstance,
    application_dir: &Path,
    config: &Config,
) -> Result<Capabilities, String> {
    let model = config
        .live_resource_identities()
        .get(instance.id.as_str())
        .and_then(|identity| identity.model_id.as_deref());
    match instance.tool.as_str() {
        "powers" => {
            powers::get_capabilities_for_mode(application_dir, config, ExecutionMode::Live, model)
                .map(Capabilities::Powers)
        }
        "scopes" => {
            scopes::get_capabilities_for_mode(application_dir, config, ExecutionMode::Live, model)
                .map(Capabilities::Scopes)
        }
        _ => unreachable!("only Powers and Scopes need capability checks"),
    }
}

/// Automatic capability checks deliberately do not validate workflow references,
/// loop scopes or other Template execution contracts.
pub fn validate_live_preflight_draft(
    json: &str,
    application_dir: &Path,
    config: &Config,
) -> Result<Vec<String>, String> {
    let setup = crate::template::preflight_setup(json).map_err(|error| error.to_string())?;
    let wire: Value = serde_json::from_str(json).map_err(|error| error.to_string())?;
    fn collect<'a>(steps: &'a [Value], actions: &mut Vec<&'a Value>) {
        for step in steps {
            match step["type"].as_str() {
                Some("tool-action") => actions.push(step),
                Some("for" | "while") => {
                    if let Some(body) = step["steps"].as_array() {
                        collect(body, actions);
                    }
                }
                _ => {}
            }
        }
    }
    let mut actions = Vec::new();
    if let Some(steps) = wire["workflow"]["steps"].as_array() {
        collect(steps, &mut actions);
    }
    let mut instances = Vec::new();
    for action in &actions {
        if let Some(instance) = setup
            .tool_instances()
            .iter()
            .find(|instance| Some(instance.id.as_str()) == action["target"].as_str())
            && !instances.contains(&instance)
        {
            instances.push(instance);
        }
    }
    let mut errors = Vec::new();
    if let Err(error) = crate::run_preparation::validate_live_resource_instances(&instances, config)
    {
        errors.push(error);
    }
    errors.extend(validate_instances_with_capabilities(
        &instances,
        |instance| query_capabilities(instance, application_dir, config),
        |instance, caps, check| {
            for action in &actions {
                if action["target"].as_str() != Some(instance.id.as_str()) {
                    continue;
                }
                check_action(
                    action["id"].as_str().unwrap_or(""),
                    action["action"].as_str().unwrap_or(""),
                    &action["arguments"],
                    action["bindings"]
                        .as_object()
                        .into_iter()
                        .flat_map(|bindings| bindings.keys().map(String::as_str)),
                    instance,
                    caps,
                    check,
                );
            }
        },
    ));
    Ok(errors)
}

enum Capabilities {
    Powers(powers::PowersCapabilities),
    Scopes(scopes::ScopesCapabilities),
}

fn validate_with_capabilities(
    template: &Template,
    mut query: impl FnMut(&ToolInstance) -> Result<Capabilities, String>,
) -> Vec<String> {
    validate_instances_with_capabilities(
        &template.referenced_tool_instances(),
        &mut query,
        |instance, caps, check| scan_actions(template.workflow().steps(), instance, caps, check),
    )
}

fn validate_instances_with_capabilities(
    instances: &[&ToolInstance],
    mut query: impl FnMut(&ToolInstance) -> Result<Capabilities, String>,
    mut scan: impl FnMut(&ToolInstance, &Capabilities, &mut CapabilityCheck<'_>),
) -> Vec<String> {
    let mut errors = Vec::new();
    for instance in instances {
        if !matches!(instance.tool.as_str(), "powers" | "scopes") {
            continue;
        }
        let context = format!("{} ({})", instance.tool, instance.id);
        let caps = match query(instance) {
            Ok(caps) => caps,
            Err(error) => {
                errors.push(format!("{context}: {error}"));
                continue;
            }
        };
        let mut check = CapabilityCheck {
            context: format!("{context} Setup"),
            errors: &mut errors,
        };
        match &caps {
            Capabilities::Powers(caps) => powers::validate_preflight_setup(
                instance.powers_setup().expect("validated Powers setup"),
                caps,
                &mut check,
            ),
            Capabilities::Scopes(caps) => scopes::validate_preflight_setup(
                instance.scopes_setup().expect("validated Scopes setup"),
                caps,
                &mut check,
            ),
        }
        scan(instance, &caps, &mut check);
    }
    errors
}

fn scan_actions(
    steps: &[Step],
    instance: &ToolInstance,
    caps: &Capabilities,
    check: &mut CapabilityCheck<'_>,
) {
    for step in steps {
        match step.kind() {
            StepKind::ToolAction {
                target,
                action,
                arguments,
                bindings,
            } if target == &instance.id => {
                check_action(
                    step.id().as_str(),
                    action.as_str(),
                    arguments,
                    bindings.keys().map(String::as_str),
                    instance,
                    caps,
                    check,
                );
            }
            StepKind::For { body, .. } | StepKind::While { body, .. } => {
                scan_actions(body, instance, caps, check)
            }
            _ => {}
        }
    }
}

fn check_action<'a>(
    step_id: &str,
    action: &str,
    arguments: &Value,
    bindings: impl Iterator<Item = &'a str>,
    instance: &ToolInstance,
    caps: &Capabilities,
    check: &mut CapabilityCheck<'_>,
) {
    let mut fixed = arguments.clone();
    let bindings: Vec<_> = bindings.collect();
    // Check the Adapter's effective default only when no runtime binding supplies it.
    if instance.tool.as_str() == "scopes"
        && action == "screenshot"
        && fixed.is_object()
        && !bindings.contains(&"format")
        && fixed.get("format").is_none()
    {
        fixed["format"] = Value::from(scopes::DEFAULT_SCREENSHOT_FORMAT);
    }
    if let Some(object) = fixed.as_object_mut() {
        for name in &bindings {
            object.remove(*name);
        }
    }
    check.context = format!(
        "{} ({}) Step {} [{}]",
        instance.tool, instance.id, step_id, action
    );
    match caps {
        Capabilities::Powers(caps) => {
            powers::validate_preflight_action(action, &fixed, caps, check)
        }
        Capabilities::Scopes(caps) => {
            scopes::validate_preflight_action(action, &fixed, caps, check)
        }
    }
}

pub(crate) struct CapabilityCheck<'a> {
    context: String,
    errors: &'a mut Vec<String>,
}
impl CapabilityCheck<'_> {
    pub(crate) fn invalid(&mut self, parameter: &str, reason: &str) {
        self.errors
            .push(format!("{}: {parameter} {reason}", self.context));
    }

    pub(crate) fn option(&mut self, parameter: &str, value: &Value, supported: Option<Value>) {
        match supported {
            Some(supported)
                if supported
                    .as_array()
                    .is_some_and(|values| values.contains(value)) => {}
            Some(supported) => self.errors.push(format!(
                "{}: {parameter}={value} is unsupported; supported values: {}",
                self.context,
                supported_values_summary(&supported)
            )),
            None => self.errors.push(format!(
                "{}: {parameter}={value} cannot be checked; required capability is unavailable",
                self.context
            )),
        }
    }
}

fn supported_values_summary(supported: &Value) -> String {
    const PREVIEW_ITEMS: usize = 8;
    const MAX_PREVIEW_CHARS: usize = 256;
    let Some(values) = supported.as_array() else {
        return "unavailable (expected a list)".into();
    };
    if values.len() > PREVIEW_ITEMS
        && values.iter().all(|value| value.as_u64().is_some())
        && values
            .windows(2)
            .all(|pair| pair[0].as_u64().unwrap().checked_add(1) == pair[1].as_u64())
    {
        return format!(
            "{}–{} ({} values)",
            values[0],
            values[values.len() - 1],
            values.len()
        );
    }
    let preview = serde_json::to_string(&values[..values.len().min(PREVIEW_ITEMS)]).unwrap();
    let truncated = preview.chars().count() > MAX_PREVIEW_CHARS;
    if values.len() > PREVIEW_ITEMS || truncated {
        format!(
            "{}… ({} values total)",
            preview.chars().take(MAX_PREVIEW_CHARS).collect::<String>(),
            values.len()
        )
    } else {
        preview
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn powers_caps() -> powers::PowersCapabilities {
        serde_json::from_value(json!({"model_id":"two-channel", "model_name":"Two channels", "channels":[1,2],
            "protection_features":{"ovp_voltage":false,"ocp":false,"ocp_delay":false,"ocp_delay_triggers":["setting-change"]}})).unwrap()
    }
    fn scopes_caps() -> scopes::ScopesCapabilities {
        serde_json::from_value(json!({"model_id":"two-channel", "model_name":"Two channels", "analog_channels":2,
            "acquisition_modes":["normal","average"],"average_counts":[4,16],"screenshot_formats":["png"],
            "measurement_items":null,"direct_measurement_items":["vpp"],"trigger_edge_slopes":["positive"],"capture_point_options":[1000]})).unwrap()
    }
    fn action(tool: &str, name: &str, arguments: Value) -> Value {
        json!({"type":"tool-action","id":"action","target":tool,"action":name,"arguments":arguments})
    }
    fn template(tool: &str, setup: Value, steps: Value) -> Template {
        Template::from_json_str(&json!({"schema_version":2,"name":"Preflight", "tool_instances":[{"id":tool,"tool":tool,"setup":setup}],"workflow":{"steps":steps}}).to_string()).unwrap()
    }
    fn check(template: &Template) -> Vec<String> {
        validate_with_capabilities(template, |instance| {
            Ok(match instance.tool.as_str() {
                "powers" => Capabilities::Powers(powers_caps()),
                "scopes" => Capabilities::Scopes(scopes_caps()),
                _ => unreachable!(),
            })
        })
    }

    #[test]
    fn automatic_preflight_leaves_workflow_scope_errors_to_explicit_validation() {
        for value in [
            json!({"source":"variable", "variable":"missing"}),
            json!({"source":"step-output", "step_id":"future", "pointer":""}),
        ] {
            let draft = json!({"schema_version":2,"name":"Draft", "tool_instances":[],
                "workflow":{"steps":[{"type":"output","id":"out","name":"Value","page":"Results","value":value}]}}).to_string();
            assert!(Template::from_json_str(&draft).is_err());
            assert!(
                validate_live_preflight_draft(&draft, Path::new("unused"), &Config::default())
                    .unwrap()
                    .is_empty()
            );
        }
    }

    #[test]
    fn live_preflight_fixed_actions_report_each_unsupported_parameter() {
        let cases = [
            (
                "powers",
                "set-output",
                json!({"channel":3,"voltage":1}),
                "channel",
            ),
            (
                "powers",
                "set-voltage",
                json!({"channel":3,"voltage":1}),
                "channel",
            ),
            ("powers", "output-on", json!({"channel":3}), "channel"),
            ("powers", "output-off", json!({"channel":3}), "channel"),
            (
                "powers",
                "protection-status",
                json!({"channel":3}),
                "channel",
            ),
            (
                "scopes",
                "channel-display",
                json!({"channel":4,"on":true}),
                "channel",
            ),
            (
                "scopes",
                "channel-scale",
                json!({"channel":4,"volts_per_division":1}),
                "channel",
            ),
            (
                "scopes",
                "channel-offset",
                json!({"channel":4,"volts":0}),
                "channel",
            ),
            (
                "scopes",
                "measure",
                json!({"channel":4,"item":"vpp"}),
                "channel",
            ),
            (
                "scopes",
                "trigger-edge",
                json!({"source_channel":4,"slope":"positive","level":0}),
                "source_channel",
            ),
            (
                "scopes",
                "capture",
                json!({"channel":[1,4],"points":1000}),
                "channel",
            ),
            (
                "scopes",
                "measure",
                json!({"channel":1,"item":"frequency"}),
                "item",
            ),
            (
                "scopes",
                "trigger-edge",
                json!({"source_channel":1,"slope":"negative","level":0}),
                "slope",
            ),
            (
                "scopes",
                "capture",
                json!({"channel":[1,2],"points":5000}),
                "points",
            ),
            ("scopes", "screenshot", json!({"format":"bmp"}), "format"),
        ];
        for (tool, name, mut arguments, parameter) in cases {
            let incompatible = template(
                tool,
                json!({}),
                json!([action(tool, name, arguments.clone())]),
            );
            let before = incompatible.to_json_string().unwrap();
            let errors = check(&incompatible);
            assert_eq!(errors.len(), 1, "{tool} {name}: {errors:?}");
            for text in [tool, "Step action", parameter, "supported values"] {
                assert!(errors[0].contains(text), "{errors:?}");
            }
            assert_eq!(before, incompatible.to_json_string().unwrap());
            arguments[parameter] = match parameter {
                "channel" if name == "capture" => json!([1, 2]),
                "channel" | "source_channel" => json!(1),
                "item" => json!("vpp"),
                "slope" => json!("positive"),
                "points" => json!(1000),
                "format" => json!("png"),
                _ => unreachable!(),
            };
            assert!(
                check(&template(
                    tool,
                    json!({}),
                    json!([action(tool, name, arguments)])
                ))
                .is_empty()
            );
        }
    }

    #[test]
    fn live_preflight_screenshot_checks_effective_format_without_rewriting_template() {
        for (formats, args, passes) in [
            (vec!["png"], json!({"format":"png"}), true),
            (vec!["bmp"], json!({"format":"png"}), false),
            (vec!["bmp"], json!({"format":"bmp"}), true),
            (vec!["jpeg"], json!({"format":"jpeg"}), true),
            (vec!["jpeg"], json!({"format":"png"}), false),
            (vec!["png"], json!({}), true),
            (vec!["bmp"], json!({}), false),
            (vec!["jpeg"], json!({}), false),
            (vec!["png"], json!({"format":"gif"}), false),
            (vec!["bmp8bit"], json!({"format":"bmp8bit"}), true),
        ] {
            let template = template(
                "scopes",
                json!({}),
                json!([action("scopes", "screenshot", args)]),
            );
            let before = template.to_json_string().unwrap();
            let errors = validate_with_capabilities(&template, |_| {
                let mut caps = scopes_caps();
                caps.screenshot_formats = formats.iter().map(|value| (*value).into()).collect();
                Ok(Capabilities::Scopes(caps))
            });
            assert_eq!(errors.is_empty(), passes, "{before}: {errors:?}");
            if !passes {
                assert_eq!(errors.len(), 1);
                assert!(errors[0].contains("format=") && errors[0].contains("unsupported"));
            }
            assert_eq!(before, template.to_json_string().unwrap());
        }
        // An omitted bound format is dynamic too; PNG must not be inferred for it.
        let mut bound = action("scopes", "screenshot", json!({}));
        bound["bindings"] = json!({"format":{"source":"literal","value":"jpeg"}});
        assert!(
            validate_with_capabilities(&template("scopes", json!({}), json!([bound])), |_| {
                let mut caps = scopes_caps();
                caps.screenshot_formats = vec!["jpeg".into()];
                Ok(Capabilities::Scopes(caps))
            })
            .is_empty()
        );
    }

    #[test]
    fn live_preflight_capture_fixed_channels_require_nonempty_unique_supported_values() {
        for (channels, passes, reason) in [
            (json!(1), false, "array"),
            (json!("1"), false, "array"),
            (json!(null), false, "array"),
            (json!({"value":1}), false, "array"),
            (json!(true), false, "array"),
            (json!([]), false, "at least one"),
            (json!([1, 1]), false, "duplicate"),
            (json!([1, 3]), false, "unsupported"),
            (json!([1, 2]), true, ""),
            (json!([1]), true, ""),
            (json!([2]), true, ""),
        ] {
            let template = template(
                "scopes",
                json!({}),
                json!([action(
                    "scopes",
                    "capture",
                    json!({"channel":channels,"points":1000})
                )]),
            );
            let before = template.to_json_string().unwrap();
            let errors = check(&template);
            assert_eq!(errors.is_empty(), passes, "{channels}: {errors:?}");
            if !passes {
                assert_eq!(errors.len(), 1);
                assert!(errors[0].contains("channel") && errors[0].contains(reason));
            }
            assert_eq!(before, template.to_json_string().unwrap());
        }
        let mut bound = action("scopes", "capture", json!({"channel":1,"points":1000}));
        bound["bindings"] = json!({"channel":{"source":"literal","value":[1]}});
        let template = template("scopes", json!({}), json!([bound]));
        let before = template.to_json_string().unwrap();
        assert!(check(&template).is_empty());
        assert_eq!(before, template.to_json_string().unwrap());
    }

    #[test]
    fn live_preflight_large_capability_errors_are_bounded_without_truncating_validation() {
        for (counts, invalid, valid, range) in [
            ((2..=65536).collect::<Vec<u32>>(), 65537, 65536, true),
            (
                (2..=65536).step_by(2).collect::<Vec<u32>>(),
                3,
                65536,
                false,
            ),
        ] {
            let validate = |value| {
                validate_with_capabilities(
                    &template(
                        "scopes",
                        json!({"acquisition":{"acquisition_type":"average","average_count":value}}),
                        json!([action(
                            "scopes",
                            "capture",
                            json!({"channel":[1],"points":1000})
                        )]),
                    ),
                    |_| {
                        let mut caps = scopes_caps();
                        caps.average_counts = Some(counts.clone());
                        Ok(Capabilities::Scopes(caps))
                    },
                )
            };
            let errors = validate(invalid);
            assert_eq!(errors.len(), 1);
            assert!(errors[0].contains("average_count=") && errors[0].contains("unsupported"));
            assert!(errors[0].len() < 512, "error length: {}", errors[0].len());
            assert_eq!(errors[0].contains("2–65536"), range);
            assert!(errors[0].contains(&format!("{} values", counts.len())));
            assert!(validate(valid).is_empty());
        }
        assert_eq!(supported_values_summary(&json!([4, 16])), "[4,16]");
        assert_eq!(
            supported_values_summary(&json!(["png", "bmp"])),
            "[\"png\",\"bmp\"]"
        );
        assert!(
            supported_values_summary(&json!(["界".repeat(1000)]))
                .chars()
                .count()
                < 300
        );
    }

    #[test]
    fn live_preflight_setup_aggregates_features_and_channels() {
        let powers = template(
            "powers",
            json!({"protection":{"channels":[{"channel":3,"ovp_voltage":5,"ocp":"off","ocp_delay":0.1,"ocp_delay_trigger":"cc-transition"}]}}),
            json!([action("powers", "output-off", json!({"channel":3}))]),
        );
        let errors = check(&powers);
        assert_eq!(errors.len(), 6, "{errors:?}");
        for field in [
            "channel",
            "ovp_voltage",
            "ocp=",
            "ocp_delay=",
            "ocp_delay_trigger",
        ] {
            assert!(
                errors.iter().any(|error| error.contains(field)),
                "{errors:?}"
            );
        }
        let scopes = template(
            "scopes",
            json!({"acquisition":{"acquisition_type":"average","average_count":64},"channels":[{"channel":4,"invert":false}]}),
            json!([action(
                "scopes",
                "measure",
                json!({"channel":1,"item":"vpp"})
            )]),
        );
        assert_eq!(check(&scopes).len(), 2);
        let errors = validate_with_capabilities(&scopes, |_| {
            let mut caps = scopes_caps();
            caps.acquisition_modes = Some(vec!["normal".into()]);
            Ok(Capabilities::Scopes(caps))
        });
        assert_eq!(errors.len(), 3, "{errors:?}");
    }

    #[test]
    fn live_preflight_required_optional_capabilities_fail_closed_only_when_used() {
        for setup in [
            json!({}),
            json!({"acquisition":{"acquisition_type":"normal"}}),
            json!({"acquisition":{"acquisition_type":"average","average_count":16}}),
        ] {
            let template = template(
                "scopes",
                setup.clone(),
                json!([action(
                    "scopes",
                    "measure",
                    json!({"channel":1,"item":"vpp"})
                )]),
            );
            let errors = validate_with_capabilities(&template, |_| {
                let mut caps = scopes_caps();
                caps.acquisition_modes = None;
                caps.average_counts = None;
                Ok(Capabilities::Scopes(caps))
            });
            let expected = if setup.get("acquisition").is_none() {
                0
            } else if setup["acquisition"].get("average_count").is_some() {
                2
            } else {
                1
            };
            assert_eq!(errors.len(), expected, "{errors:?}");
            assert!(
                errors
                    .iter()
                    .all(|error| error.contains("required capability is unavailable"))
            );
        }
        let normal = template(
            "scopes",
            json!({"acquisition":{"acquisition_type":"normal"}}),
            json!([action(
                "scopes",
                "timebase-scale",
                json!({"seconds_per_division":0.01})
            )]),
        );
        assert!(
            validate_with_capabilities(&normal, |_| {
                let mut caps = scopes_caps();
                caps.average_counts = None;
                caps.measurement_items = None;
                caps.direct_measurement_items.clear();
                caps.trigger_edge_slopes.clear();
                caps.capture_point_options.clear();
                caps.screenshot_formats.clear();
                Ok(Capabilities::Scopes(caps))
            })
            .is_empty()
        );
    }

    #[test]
    fn live_preflight_valid_settings_and_protection_all_pass() {
        let powers = template(
            "powers",
            json!({"protection":{"channels":[{"channel":2,"ocp_delay_trigger":"setting-change"}]}}),
            json!([action(
                "powers",
                "protection-status",
                json!({"channel":"all"})
            )]),
        );
        assert!(check(&powers).is_empty());
        let mut caps = powers_caps();
        caps.protection_features.ovp_voltage = true;
        caps.protection_features.ocp = true;
        caps.protection_features.ocp_delay = true;
        let powers = template(
            "powers",
            json!({"protection":{"channels":[{"channel":1,"ovp_voltage":5,"ocp":"on","ocp_delay":0.1}]}}),
            json!([action(
                "powers",
                "set-output",
                json!({"channel":2,"voltage":1,"current":0.1})
            )]),
        );
        assert!(
            validate_with_capabilities(&powers, |_| Ok(Capabilities::Powers(caps.clone())))
                .is_empty()
        );
        let scopes = template(
            "scopes",
            json!({"acquisition":{"acquisition_type":"average","average_count":16},"channels":[{"channel":2,"coupling":"ac","probe_ratio":100,"units":"amp"}]}),
            json!([action(
                "scopes",
                "capture",
                json!({"channel":[1,2],"points":1000})
            )]),
        );
        assert!(check(&scopes).is_empty());
    }

    #[test]
    fn live_preflight_nested_loops_and_bindings_preserve_runtime_validation() {
        let mut bound = action(
            "scopes",
            "trigger-edge",
            json!({"source_channel":99,"level":0,"slope":"positive"}),
        );
        bound["bindings"] = json!({"source_channel":{"source":"variable","variable":"i"}});
        let loop_step = json!({"type":"for","id":"for","variable":"i","range":{"start":"1","stop":"2","step":"1"},"steps":[
        {"type":"while","id":"while","left":{"source":"literal","value":0},"operator":"less-than","right":{"source":"literal","value":1},"max_iterations":1000000,"steps":[
            bound, {"type":"tool-action","id":"invalid","target":"scopes","action":"capture","arguments":{"channel":[4],"points":5000}}
        ]}]});
        let nested = template("scopes", json!({}), json!([loop_step]));
        let errors = check(&nested);
        assert_eq!(errors.len(), 2, "{errors:?}");
        assert!(errors.iter().all(|error| error.contains("Step invalid")));
        for (tool, name, field, args) in [
            ("powers", "output-on", "channel", json!({"channel":99})),
            (
                "scopes",
                "capture",
                "channel",
                json!({"channel":[99],"points":1000}),
            ),
            (
                "scopes",
                "screenshot",
                "format",
                json!({"format":"unsupported"}),
            ),
        ] {
            let mut bound = action(tool, name, args);
            bound["bindings"] = json!({field:{"source":"literal","value":1}});
            assert!(check(&template(tool, json!({}), json!([bound]))).is_empty());
        }
    }

    #[test]
    fn live_preflight_queries_only_referenced_instances_and_keeps_their_capabilities_separate() {
        let template = Template::from_json_str(&json!({"schema_version":2,"name":"Instances","tool_instances":[
            {"id":"first","tool":"powers","setup":{}},{"id":"second","tool":"powers","setup":{}},{"id":"unused","tool":"scopes","setup":{}}
        ],"workflow":{"steps":[
            {"type":"tool-action","id":"first-step","target":"first","action":"output-off","arguments":{"channel":3}},
            {"type":"tool-action","id":"second-step","target":"second","action":"output-off","arguments":{"channel":3}}
        ]}}).to_string()).unwrap();
        let mut queried = Vec::new();
        let errors = validate_with_capabilities(&template, |instance| {
            queried.push(instance.id.as_str().to_owned());
            let mut caps = powers_caps();
            if instance.id.as_str() == "first" {
                caps.channels.push(3);
            }
            Ok(Capabilities::Powers(caps))
        });
        assert_eq!(queried, ["first", "second"]);
        assert_eq!(errors.len(), 1);
        assert!(errors[0].contains("second-step"));
        let errors =
            validate_with_capabilities(&template, |_| Err("query failed: unavailable".into()));
        assert_eq!(errors.len(), 2);
        assert!(errors.iter().all(|error| error.contains("query failed")));
    }

    #[test]
    fn live_preflight_missing_model_or_resource_is_rejected_without_querying_executable() {
        for tool in ["powers", "scopes"] {
            let template = template(
                tool,
                json!({}),
                json!([action(tool, "output-off", json!({"channel":1}))]),
            );
            let mut config = Config::default();
            assert!(!validate_live_preflight(&template, Path::new("unused"), &config).is_empty());
            config.set_live_resource(&template.tool_instances()[0].id, "USB0::TEST::INSTR");
            let errors = validate_live_preflight(&template, Path::new("unused"), &config);
            assert_eq!(errors.len(), 1, "{errors:?}");
            assert!(errors[0].contains("model ID is missing"));
        }
    }
}
