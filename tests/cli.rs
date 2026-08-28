use std::{
    fs,
    path::{Path, PathBuf},
    process::{self, Command, Output},
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT_TEST_DIR: AtomicU64 = AtomicU64::new(0);

struct TestDir(PathBuf);

impl TestDir {
    fn new() -> Self {
        let sequence = NEXT_TEST_DIR.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "orchestrator-tool-cli-test-{}-{sequence}",
            process::id()
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn run_cli(arguments: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_orchestrator-tool"))
        .args(arguments)
        .output()
        .unwrap()
}

#[test]
fn tools_list_succeeds_and_lists_built_in_tools() {
    let output = run_cli(&["tools", "list"]);

    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    for tool_id in ["meters", "powers", "scopes", "wavegen"] {
        assert!(
            stdout.contains(tool_id),
            "missing {tool_id} in output: {stdout}"
        );
    }
}

#[test]
fn tools_list_uses_configured_executable_path() {
    let test_dir = TestDir::new();
    let config_path = test_dir.path().join("orchestrator.toml");
    let configured_path = test_dir.path().join("configured-meters.exe");
    fs::write(
        &config_path,
        "[tools]\nmeters = \"configured-meters.exe\"\n",
    )
    .unwrap();

    let output = run_cli(&["--config", config_path.to_str().unwrap(), "tools", "list"]);

    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("source: configured"), "output: {stdout}");
    assert!(
        stdout.contains(&format!("path: {}", configured_path.display())),
        "output: {stdout}"
    );
}

#[test]
fn tools_list_fails_when_config_cannot_be_read() {
    let test_dir = TestDir::new();
    let config_path = test_dir.path().join("missing.toml");

    let output = run_cli(&["--config", config_path.to_str().unwrap(), "tools", "list"]);

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("config read error"), "stderr: {stderr}");
}

#[test]
fn doctor_succeeds_and_reports_environment_sections() {
    let output = run_cli(&["doctor"]);

    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    for section in ["Application", "Configuration", "External tools", "Summary"] {
        assert!(
            stdout.contains(section),
            "missing {section} in output: {stdout}"
        );
    }
    for tool_id in ["meters", "powers", "scopes", "wavegen"] {
        assert!(
            stdout.contains(tool_id),
            "missing {tool_id} in output: {stdout}"
        );
    }
}

#[test]
fn doctor_uses_valid_config() {
    let test_dir = TestDir::new();
    let config_path = test_dir.path().join("orchestrator.toml");
    fs::write(
        &config_path,
        "[tools]\nmeters = \"configured-meters.exe\"\n",
    )
    .unwrap();

    let output = run_cli(&["--config", config_path.to_str().unwrap(), "doctor"]);

    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("Configuration"), "output: {stdout}");
    assert!(
        stdout.contains(&format!("path: {}", config_path.display())),
        "output: {stdout}"
    );
    assert!(stdout.contains("status: ok"), "output: {stdout}");
}

#[test]
fn doctor_fails_when_config_cannot_be_read() {
    let test_dir = TestDir::new();
    let config_path = test_dir.path().join("missing.toml");

    let output = run_cli(&["--config", config_path.to_str().unwrap(), "doctor"]);

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("config read error"), "stderr: {stderr}");
}

#[test]
fn tools_inspect_reports_missing_without_probe() {
    let test_dir = TestDir::new();
    let missing_path = test_dir.path().join("missing-meters.exe");
    let config_path = test_dir.path().join("orchestrator.toml");
    let config_value = format!("{:?}", missing_path.to_string_lossy().to_string());
    fs::write(&config_path, format!("[tools]\nmeters = {config_value}\n")).unwrap();

    let output = run_cli(&[
        "--config",
        config_path.to_str().unwrap(),
        "tools",
        "inspect",
        "meters",
    ]);

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("meters"), "output: {stdout}");
    assert!(stdout.contains("missing"), "output: {stdout}");
    assert!(stdout.contains("not-probed"), "output: {stdout}");
}

#[test]
fn tools_inspect_rejects_unknown_tool_id() {
    let output = run_cli(&["tools", "inspect", "electronic-load"]);

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("unknown tool ID"), "stderr: {stderr}");
}

#[test]
fn tools_inspect_reports_non_zero_probe() {
    let test_dir = TestDir::new();
    let config_path = test_dir.path().join("orchestrator.toml");
    let current_exe = env!("CARGO_BIN_EXE_orchestrator-tool");
    let config_value = format!("{:?}", current_exe);
    fs::write(&config_path, format!("[tools]\nmeters = {config_value}\n")).unwrap();

    let output = run_cli(&[
        "--config",
        config_path.to_str().unwrap(),
        "tools",
        "inspect",
        "meters",
    ]);

    assert!(!output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{stdout}{stderr}");
    assert!(
        stdout.contains("available"),
        "stdout should show available: {stdout}"
    );
    assert!(
        combined.contains("manifest probe failed")
            || combined.contains("non-zero")
            || combined.contains("error"),
        "combined: {combined}"
    );
}
