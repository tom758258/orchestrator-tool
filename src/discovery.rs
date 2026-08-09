use std::{
    env, io,
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
    use std::path::Path;

    use super::{built_in_tool_definitions, portable_tool_path};

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
}
