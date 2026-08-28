use std::{io, path::Path};

use crate::{
    config::Config,
    discovery::{ExecutableStatus, built_in_tool_definitions},
    inspection::{ToolInspection, inspect_tool},
    manifest_probe::{ManifestProbe, ManifestProbeError, probe_manifest},
    tool::ToolId,
};

/// Manifest inspection outcome for a tool.
#[derive(Debug)]
pub enum ManifestStatus {
    NotProbed,
    Probed(ManifestProbe),
    Error(ManifestProbeError),
}

/// Aggregate status for a single tool.
#[derive(Debug)]
pub struct ToolStatus {
    tool_id: ToolId,
    executable: Result<ToolInspection, io::Error>,
    manifest: ManifestStatus,
}

impl ToolStatus {
    /// Returns the tool ID.
    pub fn tool_id(&self) -> &ToolId {
        &self.tool_id
    }

    /// Returns the executable inspection result.
    pub fn executable(&self) -> &Result<ToolInspection, io::Error> {
        &self.executable
    }

    /// Returns the manifest inspection status.
    pub fn manifest(&self) -> &ManifestStatus {
        &self.manifest
    }
}

/// Inspects all built-in tools and returns per-tool aggregate statuses.
pub fn inspect_built_in_tool_statuses(
    application_dir: impl AsRef<Path>,
    config: &Config,
) -> Vec<ToolStatus> {
    let application_dir = application_dir.as_ref();
    let mut statuses = Vec::new();

    for definition in built_in_tool_definitions() {
        let tool_id = definition.id().clone();
        let executable = inspect_tool(application_dir, config, &definition);

        let manifest = match &executable {
            Ok(inspection) if inspection.status() == ExecutableStatus::Available => {
                match probe_manifest(inspection.resolved().path(), &tool_id) {
                    Ok(probe) => ManifestStatus::Probed(probe),
                    Err(error) => ManifestStatus::Error(error),
                }
            }
            _ => ManifestStatus::NotProbed,
        };

        statuses.push(ToolStatus {
            tool_id,
            executable,
            manifest,
        });
    }

    statuses
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
        process,
        sync::atomic::{AtomicU64, Ordering},
    };

    use super::{ManifestStatus, inspect_built_in_tool_statuses};
    use crate::{config::Config, discovery::ExecutableStatus};

    static NEXT_TEST_DIR: AtomicU64 = AtomicU64::new(0);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let sequence = NEXT_TEST_DIR.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "orchestrator-tool-status-test-{}-{sequence}",
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

    #[test]
    fn aggregate_keeps_all_tools_and_isolates_probe_error() {
        let test_dir = TestDir::new();
        let app_dir = test_dir.path().join("app");
        fs::create_dir(&app_dir).unwrap();
        let config_path = test_dir.path().join("orchestrator.toml");
        let current_exe = std::env::current_exe().unwrap();
        let config_value = format!("{:?}", current_exe.to_string_lossy().to_string());
        fs::write(&config_path, format!("[tools]\nmeters = {config_value}\n")).unwrap();
        let config = Config::load(&config_path).unwrap();

        let statuses = inspect_built_in_tool_statuses(&app_dir, &config);

        assert_eq!(statuses.len(), 4);
        assert_eq!(statuses[0].tool_id().as_str(), "meters");
        assert_eq!(statuses[1].tool_id().as_str(), "powers");
        assert_eq!(statuses[2].tool_id().as_str(), "scopes");
        assert_eq!(statuses[3].tool_id().as_str(), "wavegen");

        let meters = &statuses[0];
        assert!(meters.executable().is_ok());
        assert_eq!(
            meters.executable().as_ref().unwrap().status(),
            ExecutableStatus::Available
        );
        assert!(matches!(meters.manifest(), ManifestStatus::Error(_)));

        for status in &statuses[1..] {
            assert!(status.executable().is_ok(), "{}", status.tool_id());
            assert_eq!(
                status.executable().as_ref().unwrap().status(),
                ExecutableStatus::Missing,
                "{}",
                status.tool_id()
            );
            assert!(matches!(status.manifest(), ManifestStatus::NotProbed));
        }
    }
}
