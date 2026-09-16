use std::{cell::RefCell, collections::HashMap, io::Cursor, time::Duration};

use calamine::{Reader, Xlsx};
use orchestrator_tool::{
    executor::execute_workflow_with_loop_stop,
    run::ExecutionMode,
    template::Template,
    workflow::{StepOutcome, WorkflowRunEvent, WorkflowRunResult},
    workflow_export::{page_csv, page_datasets, pages_xlsx},
};
use serde_json::{Value, json};

fn output(id: &str, page: &str, variable: &str) -> Value {
    json!({"type":"output", "id":id, "name":id, "page":page,
        "value":{"source":"variable", "variable":variable}})
}

fn for_loop(id: &str, variable: &str, stop: &str, steps: Vec<Value>) -> Value {
    json!({"type":"for", "id":id, "variable":variable,
        "range":{"start":"1", "stop":stop, "step":"1"}, "steps":steps})
}

fn template(steps: Vec<Value>) -> Result<Template, String> {
    Template::from_json_str(
        &json!({"schema_version":1, "name":"Nested", "tool_instances":[],
        "workflow":{"steps":steps}})
        .to_string(),
    )
    .map_err(|e| e.to_string())
}

fn fixture(fail: bool) -> Template {
    let mut inner = vec![
        output("inner-x", "Inner", "x"),
        output("inner-y", "Inner", "y"),
    ];
    if fail {
        inner.push(json!({"type":"set-variable", "id":"product", "variable":"product", "value":{
            "source":"expression", "left":{"source":"variable", "variable":"x"}, "operator":"multiply",
            "right":{"source":"variable", "variable":"y"}}}));
        inner.push(json!({"type":"assert", "id":"check", "left":{"source":"variable", "variable":"product"},
            "operator":"less-than", "right":{"source":"literal", "value":6}, "message":"inner failure"}));
    }
    template(vec![
        for_loop(
            "outer",
            "x",
            "3",
            vec![
                output("outer-x", "Outer", "x"),
                for_loop("inner", "y", "4", inner),
            ],
        ),
        json!({"type":"wait", "id":"after", "duration_ms":0}),
    ])
    .unwrap()
}

fn run(template: &Template, target: Option<&str>) -> (WorkflowRunResult, Vec<WorkflowRunEvent>) {
    let pending = RefCell::new(None);
    let mut events = Vec::new();
    let mut requested = false;
    let result = execute_workflow_with_loop_stop(template, &HashMap::new(), ExecutionMode::Simulate,
        Duration::from_secs(1), |event| {
            if !requested && matches!(&event, WorkflowRunEvent::StepCompleted(e) if e.step_id().as_str() == "inner-y") {
                *pending.borrow_mut() = target.map(str::to_owned);
                requested = true;
            }
            events.push(event);
        }, |id| {
            if pending.borrow().as_deref() == Some(id.as_str()) {
                pending.borrow_mut().take(); true
            } else { false }
        }).unwrap();
    (result, events)
}

fn count(run: &WorkflowRunResult, page: &str) -> usize {
    run.result_rows()
        .iter()
        .filter(|row| row.page() == page)
        .count()
}

#[test]
fn depth_paths_and_unlimited_validation() {
    for depth in [5, 6] {
        let mut body = vec![];
        for i in (0..depth).rev() {
            body = vec![if i % 2 == 0 {
                for_loop(&format!("loop-{i}"), "x", "1", body)
            } else {
                json!({"type":"while", "id":format!("loop-{i}"), "max_iterations":1,
                    "left":{"source":"literal", "value":0}, "operator":"less-than",
                    "right":{"source":"literal", "value":1}, "steps":body})
            }];
        }
        assert_eq!(template(body).is_ok(), depth == 5);
    }
    let unlimited = json!({"type":"while", "id":"unlimited", "max_iterations":null,
        "left":{"source":"literal", "value":0}, "operator":"less-than",
        "right":{"source":"literal", "value":1}, "steps":[for_loop("child", "y", "2", vec![])]});
    assert!(template(vec![unlimited.clone()]).is_ok());
    assert!(
        template(vec![for_loop("parent", "x", "1", vec![unlimited.clone()])])
            .unwrap_err()
            .contains("Unlimited")
    );
    let mut finite = unlimited.clone();
    finite["id"] = json!("finite");
    finite["max_iterations"] = json!(2);
    finite["steps"] = json!([unlimited]);
    assert!(template(vec![finite]).unwrap_err().contains("Unlimited"));
    let siblings = vec![
        for_loop("y-loop", "y", "2", vec![output("b", "Shared", "y")]),
        for_loop("z-loop", "z", "2", vec![output("c", "Shared", "z")]),
    ];
    assert!(
        template(vec![for_loop("x-loop", "x", "1", siblings)])
            .unwrap_err()
            .contains("loop paths")
    );
    for name in ["../bad", "CON", "bad.", "bad/name", "", "History"] {
        assert!(template(vec![output("out", name, "x")]).is_err());
    }
    assert!(template(vec![output("a", "Data", "x"), output("b", "data", "x")]).is_err());
}

#[test]
fn nested_pages_commit_independently_and_round_trip() {
    let template = fixture(false);
    assert_eq!(
        Template::from_json_str(&template.to_json_string().unwrap()).unwrap(),
        template
    );
    let (result, events) = run(&template, None);
    assert_eq!((count(&result, "Outer"), count(&result, "Inner")), (3, 12));
    assert!(
        result
            .step_executions()
            .iter()
            .all(|e| matches!(e.outcome(), StepOutcome::Succeeded { .. }))
    );
    let committed: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            WorkflowRunEvent::ResultRowCommitted(row) => Some(row.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(committed, result.result_rows());
    let inner: Vec<_> = result
        .result_rows()
        .iter()
        .filter(|r| r.page() == "Inner")
        .collect();
    assert_eq!(inner[4].outputs()[0].value(), &json!(2));
    assert_eq!(inner[4].outputs()[1].value(), &json!(1));
    let two = template_for_two_pages();
    let (result, _) = run(&two, None);
    assert_eq!((count(&result, "One"), count(&result, "Two")), (2, 2));
}

fn template_for_two_pages() -> Template {
    template(vec![for_loop(
        "scope",
        "x",
        "2",
        vec![output("a", "One", "x"), output("b", "Two", "x")],
    )])
    .unwrap()
}

#[test]
fn inner_failure_preserves_commits_and_wins_over_stop() {
    for target in [None, Some("outer"), Some("inner")] {
        let mut wire: Value =
            serde_json::from_str(&fixture(true).to_json_string().unwrap()).unwrap();
        // Fail in the same innermost iteration in which Stop is requested.
        if target.is_some() {
            wire["workflow"]["steps"][0]["steps"][1]["steps"][3]["right"]["value"] = json!(1);
        }
        let template = Template::from_json_str(&wire.to_string()).unwrap();
        let (result, _) = run(&template, target);
        assert_eq!(
            count(&result, "Outer"),
            if target.is_some() { 0 } else { 1 }
        );
        assert_eq!(
            count(&result, "Inner"),
            if target.is_some() { 0 } else { 6 }
        );
        assert!(matches!(
            result.step_executions().last().unwrap().outcome(),
            StepOutcome::Failed { .. }
        ));
    }
}

#[test]
fn targeted_stop_unwinds_only_to_its_owner() {
    for (target, outer, inner) in [("inner", 3, 9), ("outer", 0, 1)] {
        let (result, _) = run(&fixture(false), Some(target));
        assert_eq!(
            (count(&result, "Outer"), count(&result, "Inner")),
            (outer, inner)
        );
        assert_eq!(
            result.step_executions().last().unwrap().step_id().as_str(),
            "after"
        );
        assert!(
            result
                .step_executions()
                .iter()
                .all(|e| matches!(e.outcome(), StepOutcome::Succeeded { .. }))
        );
    }
}

#[test]
fn child_bindings_and_step_outputs_do_not_leak() {
    let child = for_loop("child", "y", "1", vec![output("child-out", "Child", "x")]);
    for after in [
        output("after-y", "Outer", "y"),
        for_loop(
            "sibling",
            "z",
            "1",
            vec![output("sibling-y", "Sibling", "y")],
        ),
    ] {
        let template = template(vec![for_loop(
            "outer",
            "x",
            "1",
            vec![child.clone(), after],
        )])
        .unwrap();
        let (result, _) = run(&template, None);
        assert_eq!(count(&result, "Child"), 1);
        assert!(result.step_executions().iter().any(|e| matches!(e.outcome(), StepOutcome::Failed { message } if message.contains("missing variable y"))));
    }
    let mut reference = output("after-ref", "Outer", "x");
    reference["value"] = json!({"source":"step-output", "step_id":"child-out", "pointer":""});
    assert!(
        template(vec![for_loop(
            "outer",
            "x",
            "1",
            vec![child.clone(), reference.clone()]
        )])
        .is_err()
    );
    assert!(
        template(vec![for_loop(
            "outer",
            "x",
            "1",
            vec![child, for_loop("sibling", "z", "1", vec![reference])]
        )])
        .is_err()
    );
}

#[test]
fn current_and_all_page_xlsx_match_csv_datasets() {
    let template = fixture(false);
    let (result, _) = run(&template, None);
    for selected in [Some("Inner"), None] {
        let datasets = page_datasets(template.workflow(), result.result_rows(), selected).unwrap();
        let bytes = pages_xlsx(&datasets).unwrap();
        let mut workbook = Xlsx::new(Cursor::new(bytes)).unwrap();
        assert_eq!(
            workbook.sheet_names(),
            datasets
                .iter()
                .map(|d| d.page.name().to_owned())
                .collect::<Vec<_>>()
        );
        for dataset in &datasets {
            let range = workbook.worksheet_range(dataset.page.name()).unwrap();
            let csv = page_csv(dataset).unwrap();
            let mut reader = csv::ReaderBuilder::new()
                .has_headers(false)
                .from_reader(csv.as_slice());
            let expected = reader
                .records()
                .map(|r| r.unwrap().iter().map(str::to_owned).collect::<Vec<_>>())
                .collect::<Vec<_>>();
            assert_eq!(
                range
                    .rows()
                    .map(|row| row.iter().map(ToString::to_string).collect::<Vec<_>>())
                    .collect::<Vec<_>>(),
                expected
            );
        }
    }
}

#[test]
fn finite_while_nesting_preserves_inherited_updates_and_hides_child_locals() {
    let set = |id: &str, variable: &str, value: Value| {
        json!({
        "type":"set-variable", "id":id, "variable":variable, "value":value})
    };
    let literal = |value| json!({"source":"literal", "value":value});
    let child = json!({"type":"while", "id":"inner", "max_iterations":2,
    "left":{"source":"variable", "variable":"counter"}, "operator":"less-than",
    "right":{"source":"literal", "value":2}, "steps":[
        set("increment", "counter", json!({"source":"expression",
            "left":{"source":"variable", "variable":"counter"}, "operator":"add",
            "right":{"source":"literal", "value":1}})),
        set("local", "local", literal(99)),
        for_loop("deep", "y", "1", vec![output("deep-x", "Deep", "x")]),
        output("inner-count", "Inner", "counter")
    ]});
    let outer = json!({"type":"while", "id":"top", "max_iterations":1,
    "left":{"source":"variable", "variable":"counter"}, "operator":"less-than",
    "right":{"source":"literal", "value":2}, "steps":[
        for_loop("outer", "x", "1", vec![child, output("outer-count", "Outer", "counter")])
    ]});
    let template = template(vec![
        set("init", "counter", literal(0)),
        outer,
        output("after-count", "Root", "counter"),
        output("after-local", "Root", "local"),
    ])
    .unwrap();
    let (result, _) = run(&template, None);
    assert_eq!(
        (
            count(&result, "Deep"),
            count(&result, "Inner"),
            count(&result, "Outer")
        ),
        (2, 2, 1)
    );
    assert!(
        result
            .step_executions()
            .iter()
            .any(|e| e.step_id().as_str() == "after-count"
                && matches!(e.outcome(), StepOutcome::Succeeded { output } if output.as_f64() == Some(2.0)))
    );
    assert!(matches!(result.step_executions().last().unwrap().outcome(),
        StepOutcome::Failed { message } if message.contains("missing variable local")));
}
