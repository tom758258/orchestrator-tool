use std::{
    collections::BTreeMap,
    error::Error,
    fmt, fs, io,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use crate::{discovery::built_in_tool_definitions, tool::ToolId};

/// Executable path overrides and exact live resources loaded from an orchestrator configuration file.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Config {
    tools: BTreeMap<String, PathBuf>,
    live_resources: BTreeMap<String, String>,
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

        for tool_id in raw.live_resources.keys() {
            if !definitions
                .iter()
                .any(|definition| definition.id().as_str() == tool_id)
            {
                return Err(ConfigError::UnknownTool {
                    path: config_path,
                    tool_id: tool_id.clone(),
                });
            }
        }
        Ok(Self {
            tools,
            live_resources: raw.live_resources,
        })
    }

    /// Returns the configured executable path for a tool, if present.
    pub fn executable_path(&self, tool_id: &ToolId) -> Option<&Path> {
        self.tools.get(tool_id.as_str()).map(PathBuf::as_path)
    }

    /// Overrides the executable path for a tool.
    ///
    /// Callers must only pass IDs from the built-in tool registry: saving an
    /// unknown tool ID produces a file that [`Config::load`] will reject.
    pub fn set_executable_path(&mut self, tool_id: &ToolId, path: impl AsRef<Path>) {
        self.tools
            .insert(tool_id.as_str().to_owned(), path.as_ref().to_path_buf());
    }

    /// Removes the executable path override for a tool.
    ///
    /// Returns false when no override was present.
    pub fn remove_executable_path(&mut self, tool_id: &ToolId) -> bool {
        self.tools.remove(tool_id.as_str()).is_some()
    }

    /// Returns the exact configured live resource for a tool, if present.
    pub fn live_resource(&self, tool_id: &ToolId) -> Option<&str> {
        self.live_resources
            .get(tool_id.as_str())
            .map(String::as_str)
    }

    /// Sets an opaque live resource without path resolution or normalization.
    ///
    /// Callers must use built-in tool IDs, as with executable path overrides.
    pub fn set_live_resource(&mut self, tool_id: &ToolId, resource: impl Into<String>) {
        self.live_resources
            .insert(tool_id.as_str().to_owned(), resource.into());
    }

    /// Removes a live resource, returning false when none was present.
    pub fn remove_live_resource(&mut self, tool_id: &ToolId) -> bool {
        self.live_resources.remove(tool_id.as_str()).is_some()
    }

    /// Saves the configuration as TOML, creating parent directories as needed.
    pub fn save(&self, path: impl AsRef<Path>) -> Result<(), ConfigError> {
        let supplied_path = path.as_ref();
        let raw = RawConfig {
            tools: self.tools.clone(),
            live_resources: self.live_resources.clone(),
        };
        let contents = toml::to_string(&raw).map_err(|source| ConfigError::Serialize {
            path: supplied_path.to_path_buf(),
            source,
        })?;
        if let Some(parent) = supplied_path.parent()
            && !parent.as_os_str().is_empty()
        {
            fs::create_dir_all(parent).map_err(|source| ConfigError::Write {
                path: supplied_path.to_path_buf(),
                source,
            })?;
        }
        fs::write(supplied_path, contents).map_err(|source| ConfigError::Write {
            path: supplied_path.to_path_buf(),
            source,
        })
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RawConfig {
    #[serde(default)]
    tools: BTreeMap<String, PathBuf>,
    #[serde(default)]
    live_resources: BTreeMap<String, String>,
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
    /// The configuration could not be serialized to TOML.
    Serialize {
        path: PathBuf,
        source: toml::ser::Error,
    },
    /// The configuration file could not be written.
    Write { path: PathBuf, source: io::Error },
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
            Self::Serialize { path, source } => {
                write!(
                    formatter,
                    "config serialize error for {}: {source}",
                    path.display()
                )
            }
            Self::Write { path, source } => {
                write!(
                    formatter,
                    "config write error for {}: {source}",
                    path.display()
                )
            }
        }
    }
}

impl Error for ConfigError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Read { source, .. } => Some(source),
            Self::Parse { source, .. } => Some(source),
            Self::UnknownTool { .. } => None,
            Self::Serialize { source, .. } => Some(source),
            Self::Write { source, .. } => Some(source),
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
    fn live_resources_round_trip_preserves_exact_strings_and_independent_bindings() {
        let test_dir = TestDir::new();
        let path = test_dir.path().join("orchestrator.toml");
        let executable = test_dir.path().join("powers-tool.exe");
        let powers = " USB0::Vendor::Power serial::INSTR ";
        let meters = "TCPIP0::MeterHost::inst0::INSTR";
        let mut config = Config::default();
        config.set_executable_path(&ToolId::powers(), &executable);
        config.set_live_resource(&ToolId::powers(), powers);
        config.set_live_resource(&ToolId::meters(), meters);
        config.save(&path).unwrap();
        let mut loaded = Config::load(&path).unwrap();
        assert_eq!(loaded.live_resource(&ToolId::powers()), Some(powers));
        assert_eq!(loaded.live_resource(&ToolId::meters()), Some(meters));
        assert_eq!(
            loaded.executable_path(&ToolId::powers()),
            Some(executable.as_path())
        );
        assert!(loaded.remove_live_resource(&ToolId::powers()));
        assert!(!loaded.remove_live_resource(&ToolId::powers()));
        assert_eq!(loaded.live_resource(&ToolId::powers()), None);
        loaded.save(&path).unwrap();
        let reloaded = Config::load(&path).unwrap();
        assert_eq!(reloaded.live_resource(&ToolId::powers()), None);
        assert_eq!(reloaded.live_resource(&ToolId::meters()), Some(meters));
        assert_eq!(
            reloaded.executable_path(&ToolId::powers()),
            Some(executable.as_path())
        );
    }

    #[test]
    fn unknown_live_resource_tool_id_is_rejected() {
        let test_dir = TestDir::new();
        let path = test_dir.path().join("orchestrator.toml");
        fs::write(
            &path,
            "[live_resources]\nelectronic-load = \"USB0::load\"\n",
        )
        .unwrap();
        assert!(matches!(
            Config::load(path),
            Err(ConfigError::UnknownTool { .. })
        ));
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
        assert_eq!(config.live_resource(&ToolId::meters()), None);

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

    #[test]
    fn set_save_load_round_trip_and_remove_clears_override() {
        let test_dir = TestDir::new();
        let config_path = test_dir.path().join("orchestrator.toml");
        let meters_exe = test_dir.path().join("my-meter-build.exe");
        fs::write(&meters_exe, []).unwrap();

        let mut config = Config::default();
        config.set_executable_path(&ToolId::meters(), &meters_exe);
        config.save(&config_path).unwrap();

        let loaded = Config::load(&config_path).unwrap();
        assert_eq!(
            loaded.executable_path(&ToolId::meters()),
            Some(meters_exe.as_path())
        );
        assert_eq!(loaded.executable_path(&ToolId::powers()), None);

        let mut updated = loaded;
        assert!(updated.remove_executable_path(&ToolId::meters()));
        assert!(!updated.remove_executable_path(&ToolId::meters()));
        assert_eq!(updated.executable_path(&ToolId::meters()), None);
        updated.save(&config_path).unwrap();

        let reloaded = Config::load(&config_path).unwrap();
        assert_eq!(reloaded.executable_path(&ToolId::meters()), None);

        let empty_path = test_dir.path().join("empty.toml");
        Config::default().save(&empty_path).unwrap();
        let empty = Config::load(&empty_path).unwrap();
        for tool_id in [
            ToolId::meters(),
            ToolId::powers(),
            ToolId::scopes(),
            ToolId::wavegen(),
        ] {
            assert_eq!(empty.executable_path(&tool_id), None);
        }
    }
}
