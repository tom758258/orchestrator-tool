use std::{
    collections::BTreeMap,
    error::Error,
    fmt, fs, io,
    path::{Path, PathBuf},
};

use serde::Deserialize;

use crate::{discovery::built_in_tool_definitions, tool::ToolId};

/// Executable path overrides loaded from an orchestrator configuration file.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Config {
    tools: BTreeMap<String, PathBuf>,
}

impl Config {
    /// Loads and validates a configuration file supplied by the caller.
    pub fn load(path: impl AsRef<Path>) -> Result<Self, ConfigError> {
        let supplied_path = path.as_ref();
        let config_path =
            std::path::absolute(supplied_path).map_err(|source| ConfigError::Read {
                path: supplied_path.to_path_buf(),
                source,
            })?;
        let contents = fs::read_to_string(&config_path).map_err(|source| ConfigError::Read {
            path: config_path.clone(),
            source,
        })?;
        let raw: RawConfig = toml::from_str(&contents).map_err(|source| ConfigError::Parse {
            path: config_path.clone(),
            source,
        })?;
        let config_dir = config_path.parent().ok_or_else(|| ConfigError::Read {
            path: config_path.clone(),
            source: io::Error::new(
                io::ErrorKind::InvalidInput,
                "config path has no parent directory",
            ),
        })?;
        let definitions = built_in_tool_definitions();
        let mut tools = BTreeMap::new();

        for (tool_id, path) in raw.tools {
            if !definitions
                .iter()
                .any(|definition| definition.id().as_str() == tool_id)
            {
                return Err(ConfigError::UnknownTool {
                    path: config_path,
                    tool_id,
                });
            }

            let path = if path.is_relative() {
                config_dir.join(path)
            } else {
                path
            };
            tools.insert(tool_id, path);
        }

        Ok(Self { tools })
    }

    /// Returns the configured executable path for a tool, if present.
    pub fn executable_path(&self, tool_id: &ToolId) -> Option<&Path> {
        self.tools.get(tool_id.as_str()).map(PathBuf::as_path)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawConfig {
    #[serde(default)]
    tools: BTreeMap<String, PathBuf>,
}

/// An error produced while loading an orchestrator configuration file.
#[derive(Debug)]
pub enum ConfigError {
    /// The configuration file could not be read.
    Read { path: PathBuf, source: io::Error },
    /// The configuration file contains invalid TOML or an unknown field.
    Parse {
        path: PathBuf,
        source: toml::de::Error,
    },
    /// The configuration names a tool outside the built-in registry.
    UnknownTool { path: PathBuf, tool_id: String },
}

impl fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Read { path, source } => {
                write!(
                    formatter,
                    "config read error for {}: {source}",
                    path.display()
                )
            }
            Self::Parse { path, source } => {
                write!(
                    formatter,
                    "config parse error in {}: {source}",
                    path.display()
                )
            }
            Self::UnknownTool { path, tool_id } => write!(
                formatter,
                "config error in {}: unknown tool ID {tool_id:?}",
                path.display()
            ),
        }
    }
}

impl Error for ConfigError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Read { source, .. } => Some(source),
            Self::Parse { source, .. } => Some(source),
            Self::UnknownTool { .. } => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
        process,
        sync::atomic::{AtomicU64, Ordering},
    };

    use super::{Config, ConfigError};
    use crate::tool::ToolId;

    static NEXT_TEST_DIR: AtomicU64 = AtomicU64::new(0);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let sequence = NEXT_TEST_DIR.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "orchestrator-tool-config-test-{}-{sequence}",
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
    fn relative_executable_path_uses_config_directory() {
        let test_dir = TestDir::new();
        let config_dir = test_dir.path().join("config");
        fs::create_dir(&config_dir).unwrap();
        let config_path = config_dir.join("orchestrator.toml");
        fs::write(
            &config_path,
            "[tools]\nmeters = \"../tools-dev/my-meter-build.exe\"\n",
        )
        .unwrap();

        let config = Config::load(&config_path).unwrap();

        assert_eq!(
            config.executable_path(&ToolId::meters()),
            Some(config_dir.join("../tools-dev/my-meter-build.exe").as_path())
        );
    }

    #[test]
    fn malformed_toml_and_unknown_top_level_fields_are_rejected() {
        let test_dir = TestDir::new();

        for (name, contents) in [
            ("malformed.toml", "[tools\nmeters = \"meter.exe\"\n"),
            ("unknown-field.toml", "logging = true\n"),
        ] {
            let config_path = test_dir.path().join(name);
            fs::write(&config_path, contents).unwrap();

            assert!(
                matches!(Config::load(config_path), Err(ConfigError::Parse { .. })),
                "{name} should produce a parse error"
            );
        }
    }

    #[test]
    fn unknown_tool_id_is_rejected() {
        let test_dir = TestDir::new();
        let config_path = test_dir.path().join("orchestrator.toml");
        fs::write(
            &config_path,
            "[tools]\nelectronic-load = \"load-tool.exe\"\n",
        )
        .unwrap();

        let error = Config::load(config_path).unwrap_err();

        assert!(matches!(
            error,
            ConfigError::UnknownTool { tool_id, .. } if tool_id == "electronic-load"
        ));
    }
}
