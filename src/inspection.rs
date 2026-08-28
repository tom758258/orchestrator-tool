use std::{io, path::Path};

use crate::{
    config::Config,
    discovery::{
        ExecutableStatus, ResolvedExecutable, ToolDefinition, built_in_tool_definitions,
        resolve_executable_path, validate_executable_path,
    },
};

/// The resolved executable and availability of one built-in external tool.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolInspection {
    resolved: ResolvedExecutable,
    status: ExecutableStatus,
}

impl ToolInspection {
    /// Returns the tool's resolved executable.
    pub fn resolved(&self) -> &ResolvedExecutable {
        &self.resolved
    }

    /// Returns the filesystem-level availability of the executable.
    pub fn status(&self) -> ExecutableStatus {
        self.status
    }
}

/// Inspects a single built-in tool's executable.
pub fn inspect_tool(
    application_dir: impl AsRef<Path>,
    config: &Config,
    definition: &ToolDefinition,
) -> io::Result<ToolInspection> {
    let resolved = resolve_executable_path(
        application_dir.as_ref(),
        definition,
        config.executable_path(definition.id()),
    );
    let status = validate_executable_path(resolved.path()).map_err(|error| {
        io::Error::new(
            error.kind(),
            format!("failed to validate {} executable: {error}", definition.id()),
        )
    })?;

    Ok(ToolInspection { resolved, status })
}

/// Inspects every built-in tool's executable under an application directory.
///
/// The returned inspections follow `built_in_tool_definitions` order.
pub fn inspect_built_in_tools(
    application_dir: impl AsRef<Path>,
    config: &Config,
) -> io::Result<Vec<ToolInspection>> {
    let application_dir = application_dir.as_ref();
    let mut inspections = Vec::new();

    for definition in built_in_tool_definitions() {
        inspections.push(inspect_tool(application_dir, config, &definition)?);
    }

    Ok(inspections)
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
        process,
        sync::atomic::{AtomicU64, Ordering},
    };

    use super::inspect_built_in_tools;
    use crate::{
        config::Config,
        discovery::{ExecutablePathSource, ExecutableStatus},
    };

    static NEXT_TEST_DIR: AtomicU64 = AtomicU64::new(0);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let sequence = NEXT_TEST_DIR.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "orchestrator-tool-inspection-test-{}-{sequence}",
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
    fn inspection_combines_configured_precedence_and_filesystem_status() {
        let test_dir = TestDir::new();
        let configured_meters = test_dir.path().join("my-meter-build.exe");
        fs::write(&configured_meters, []).unwrap();
        let config_path = test_dir.path().join("orchestrator.toml");
        fs::write(&config_path, "[tools]\nmeters = \"my-meter-build.exe\"\n").unwrap();
        let powers_portable = test_dir
            .path()
            .join("tools")
            .join("powers")
            .join("powers-tool.exe");
        fs::create_dir_all(powers_portable.parent().unwrap()).unwrap();
        fs::write(&powers_portable, []).unwrap();

        let config = Config::load(&config_path).unwrap();
        let inspections =
            inspect_built_in_tools(test_dir.path(), &config).expect("inspection should succeed");

        let actual: Vec<_> = inspections
            .iter()
            .map(|inspection| {
                (
                    inspection.resolved().tool_id().as_str(),
                    inspection.resolved().source(),
                    inspection.status(),
                )
            })
            .collect();

        assert_eq!(
            actual,
            vec![
                (
                    "meters",
                    ExecutablePathSource::Configured,
                    ExecutableStatus::Available
                ),
                (
                    "powers",
                    ExecutablePathSource::Portable,
                    ExecutableStatus::Available
                ),
                (
                    "scopes",
                    ExecutablePathSource::Portable,
                    ExecutableStatus::Missing
                ),
                (
                    "wavegen",
                    ExecutablePathSource::Portable,
                    ExecutableStatus::Missing
                ),
            ]
        );
        assert_eq!(
            inspections[0].resolved().path(),
            configured_meters.as_path()
        );
    }
}
