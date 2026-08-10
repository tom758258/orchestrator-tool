use std::{
    env, fs, io,
    path::{Path, PathBuf},
};

use crate::tool::ToolId;

/// The executable definition for an external tool known to the orchestrator.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolDefinition {
    id: ToolId,
    executable_name: &'static str,
}

impl ToolDefinition {
    fn new(id: ToolId, executable_name: &'static str) -> Self {
        Self {
            id,
            executable_name,
        }
    }

    /// Returns the tool's canonical ID.
    pub fn id(&self) -> &ToolId {
        &self.id
    }

    /// Returns the tool's executable filename.
    pub fn executable_name(&self) -> &str {
        self.executable_name
    }
}

/// Returns the external tools built into the orchestrator.
pub fn built_in_tool_definitions() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition::new(ToolId::meters(), "meters-tool.exe"),
        ToolDefinition::new(ToolId::powers(), "powers-tool.exe"),
        ToolDefinition::new(ToolId::scopes(), "scopes-tool.exe"),
        ToolDefinition::new(ToolId::wavegen(), "wavegen-tool.exe"),
    ]
}

/// Builds the expected portable executable path for a tool.
pub fn portable_tool_path(base_dir: impl AsRef<Path>, definition: &ToolDefinition) -> PathBuf {
    base_dir
        .as_ref()
        .join("tools")
        .join(definition.id().as_str())
        .join(definition.executable_name())
}

/// The source selected for an external tool's executable path.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExecutablePathSource {
    Configured,
    Portable,
}

/// A tool executable path selected by configuration or portable discovery.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedExecutable {
    tool_id: ToolId,
    path: PathBuf,
    source: ExecutablePathSource,
}

impl ResolvedExecutable {
    /// Returns the tool's canonical ID.
    pub fn tool_id(&self) -> &ToolId {
        &self.tool_id
    }

    /// Returns the selected executable path.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Returns how the executable path was selected.
    pub fn source(&self) -> ExecutablePathSource {
        self.source
    }
}

/// Selects a configured executable path or the portable default when absent.
pub fn resolve_executable_path(
    portable_base_dir: impl AsRef<Path>,
    definition: &ToolDefinition,
    configured_path: Option<&Path>,
) -> ResolvedExecutable {
    let (path, source) = match configured_path {
        Some(path) => (path.to_path_buf(), ExecutablePathSource::Configured),
        None => (
            portable_tool_path(portable_base_dir, definition),
            ExecutablePathSource::Portable,
        ),
    };

    ResolvedExecutable {
        tool_id: definition.id().clone(),
        path,
        source,
    }
}

/// The filesystem-level availability of an external tool executable.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExecutableStatus {
    Available,
    Missing,
    NotFile,
}

/// Checks whether an executable path exists and is a regular file.
pub fn validate_executable_path(path: impl AsRef<Path>) -> io::Result<ExecutableStatus> {
    match fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => Ok(ExecutableStatus::Available),
        Ok(_) => Ok(ExecutableStatus::NotFile),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(ExecutableStatus::Missing),
        Err(error) => Err(error),
    }
}

/// Returns the directory containing the currently running executable.
pub fn current_application_dir() -> io::Result<PathBuf> {
    let current_executable = env::current_exe()?;

    current_executable
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "current executable path has no parent directory",
            )
        })
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
        process,
        sync::atomic::{AtomicU64, Ordering},
    };

    use super::{
        ExecutablePathSource, ExecutableStatus, built_in_tool_definitions, portable_tool_path,
        resolve_executable_path, validate_executable_path,
    };

    static NEXT_TEST_DIR: AtomicU64 = AtomicU64::new(0);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let sequence = NEXT_TEST_DIR.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "orchestrator-tool-discovery-test-{}-{sequence}",
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
    fn built_in_tool_definitions_are_correct() {
        let definitions = built_in_tool_definitions();
        let actual: Vec<_> = definitions
            .iter()
            .map(|definition| (definition.id().as_str(), definition.executable_name()))
            .collect();

        assert_eq!(
            actual,
            vec![
                ("meters", "meters-tool.exe"),
                ("powers", "powers-tool.exe"),
                ("scopes", "scopes-tool.exe"),
                ("wavegen", "wavegen-tool.exe"),
            ]
        );
    }

    #[test]
    fn portable_tool_path_uses_expected_layout() {
        let base_dir = Path::new("portable-app");
        let meters = built_in_tool_definitions()
            .into_iter()
            .next()
            .expect("meters definition should be present");

        assert_eq!(
            portable_tool_path(base_dir, &meters),
            base_dir
                .join("tools")
                .join("meters")
                .join("meters-tool.exe")
        );
    }

    #[test]
    fn absent_configured_path_uses_portable_path() {
        let base_dir = Path::new("portable-app");
        let meters = built_in_tool_definitions().remove(0);

        let resolved = resolve_executable_path(base_dir, &meters, None);

        assert_eq!(resolved.tool_id(), meters.id());
        assert_eq!(resolved.path(), portable_tool_path(base_dir, &meters));
        assert_eq!(resolved.source(), ExecutablePathSource::Portable);
    }

    #[test]
    fn configured_path_has_priority_without_portable_fallback() {
        let test_dir = TestDir::new();
        let meters = built_in_tool_definitions().remove(0);
        let portable_path = portable_tool_path(test_dir.path(), &meters);
        fs::create_dir_all(portable_path.parent().unwrap()).unwrap();
        fs::write(&portable_path, []).unwrap();
        let configured_path = test_dir.path().join("my-meter-build.exe");

        let resolved = resolve_executable_path(test_dir.path(), &meters, Some(&configured_path));

        assert_eq!(resolved.path(), configured_path);
        assert_eq!(resolved.source(), ExecutablePathSource::Configured);
        assert_eq!(
            validate_executable_path(resolved.path()).unwrap(),
            ExecutableStatus::Missing
        );
    }

    #[test]
    fn executable_validation_distinguishes_file_missing_and_directory() {
        let test_dir = TestDir::new();
        let file_path = test_dir.path().join("tool.exe");
        let missing_path = test_dir.path().join("missing.exe");
        fs::write(&file_path, []).unwrap();

        assert_eq!(
            validate_executable_path(&file_path).unwrap(),
            ExecutableStatus::Available
        );
        assert_eq!(
            validate_executable_path(&missing_path).unwrap(),
            ExecutableStatus::Missing
        );
        assert_eq!(
            validate_executable_path(test_dir.path()).unwrap(),
            ExecutableStatus::NotFile
        );
    }
}
