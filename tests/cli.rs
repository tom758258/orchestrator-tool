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
