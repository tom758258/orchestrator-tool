use std::{
    collections::BTreeMap,
    error::Error,
    fmt, fs, io,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use crate::{discovery::built_in_tool_definitions, tool::ToolId, tool_instance::ToolInstanceId};

/// Executable path overrides and exact live resources loaded from an orchestrator configuration file.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Config {
    tools: BTreeMap<String, PathBuf>,
    live_resources: BTreeMap<String, String>,
    live_resource_identities: BTreeMap<String, ResourceIdentity>,
}

/// Last-known device presentation metadata stored only in local configuration.
#[derive(Clone, Debug, Default, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ResourceIdentity {
    #[serde(default)]
    pub manufacturer: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub serial: Option<String>,
    #[serde(default)]
    pub identity: Option<String>,
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

        for instance_id in raw
            .live_resources
            .keys()
            .chain(raw.live_resource_identities.keys())
        {
            ToolInstanceId::new(instance_id).map_err(|_| ConfigError::InvalidInstanceId {
                path: config_path.clone(),
                instance_id: instance_id.clone(),
            })?;
        }
        Ok(Self {
            tools,
            live_resources: raw.live_resources,
            live_resource_identities: raw.live_resource_identities,
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

    /// Returns the exact configured live resource for an instance, if present.
    pub fn live_resource(&self, instance_id: &ToolInstanceId) -> Option<&str> {
        self.live_resources
            .get(instance_id.as_str())
            .map(String::as_str)
    }

    /// Sets an opaque live resource and clears any last-known identity.
    ///
    /// Instance IDs are scoped to the template chosen by the caller.
    pub fn set_live_resource(&mut self, instance_id: &ToolInstanceId, resource: impl Into<String>) {
        self.live_resource_identities.remove(instance_id.as_str());
        self.live_resources
            .insert(instance_id.as_str().to_owned(), resource.into());
    }

    /// Sets a discovered resource and its last-known identity together.
    pub fn set_live_resource_with_identity(
        &mut self,
        instance_id: &ToolInstanceId,
        resource: impl Into<String>,
        identity: Option<ResourceIdentity>,
    ) {
        self.set_live_resource(instance_id, resource);
        if let Some(identity) = identity {
            self.live_resource_identities
                .insert(instance_id.as_str().to_owned(), identity);
        }
    }

    /// Returns local presentation metadata keyed by logical instance ID.
    pub fn live_resource_identities(&self) -> &BTreeMap<String, ResourceIdentity> {
        &self.live_resource_identities
    }

    /// Removes a resource and its identity, returning false when no binding was present.
    pub fn remove_live_resource(&mut self, instance_id: &ToolInstanceId) -> bool {
        self.live_resource_identities.remove(instance_id.as_str());
        self.live_resources.remove(instance_id.as_str()).is_some()
    }

    /// Returns resource bindings keyed by logical instance ID.
    pub fn live_resources(&self) -> &BTreeMap<String, String> {
        &self.live_resources
    }

    /// Saves the configuration as TOML, creating parent directories as needed.
    pub fn save(&self, path: impl AsRef<Path>) -> Result<(), ConfigError> {
        let supplied_path = path.as_ref();
        let raw = RawConfig {
            tools: self.tools.clone(),
            live_resources: self.live_resources.clone(),
            live_resource_identities: self.live_resource_identities.clone(),
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
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    live_resource_identities: BTreeMap<String, ResourceIdentity>,
}

/// An error produced while loading an orchestrator configuration file.
#[derive(Debug)]
pub enum ConfigError {
    InvalidInstanceId {
        path: PathBuf,
        instance_id: String,
    },
    /// The configuration file could not be read.
    Read {
        path: PathBuf,
        source: io::Error,
    },
    /// The configuration file contains invalid TOML or an unknown field.
    Parse {
        path: PathBuf,
        source: toml::de::Error,
    },
    /// The configuration names a tool outside the built-in registry.
    UnknownTool {
        path: PathBuf,
        tool_id: String,
    },
    /// The configuration could not be serialized to TOML.
    Serialize {
        path: PathBuf,
        source: toml::ser::Error,
    },
    /// The configuration file could not be written.
    Write {
        path: PathBuf,
        source: io::Error,
    },
}

impl fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidInstanceId { path, instance_id } => write!(
                formatter,
                "config error in {}: invalid instance ID {instance_id:?}",
                path.display()
            ),
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
            Self::UnknownTool { .. } | Self::InvalidInstanceId { .. } => None,
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

    use super::{Config, ConfigError, ResourceIdentity};
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
        let powers_id = crate::tool_instance::ToolInstanceId::new("powers-1").unwrap();
        let meters_id = crate::tool_instance::ToolInstanceId::new("meters-1").unwrap();
        let powers_identity = ResourceIdentity {
            manufacturer: Some("Keysight Technologies".to_owned()),
            model: Some("E36312A".to_owned()),
            serial: Some("MY123456".to_owned()),
            identity: Some("Keysight Technologies,E36312A,MY123456,1.0".to_owned()),
        };
        let meters_identity = ResourceIdentity {
            manufacturer: None,
            model: Some("34461A".to_owned()),
            serial: None,
            identity: Some("34461A".to_owned()),
        };
        let mut config = Config::default();
        config.set_executable_path(&ToolId::powers(), &executable);
        config.set_live_resource_with_identity(&powers_id, powers, Some(powers_identity.clone()));
        config.set_live_resource_with_identity(&meters_id, meters, Some(meters_identity.clone()));
        config.save(&path).unwrap();
        let mut loaded = Config::load(&path).unwrap();
        assert_eq!(loaded.live_resource(&powers_id), Some(powers));
        assert_eq!(loaded.live_resource(&meters_id), Some(meters));
        assert_eq!(
            loaded.live_resource_identities().get("powers-1"),
            Some(&powers_identity)
        );
        assert_eq!(
            loaded.live_resource_identities().get("meters-1"),
            Some(&meters_identity)
        );
        assert_eq!(
            loaded.executable_path(&ToolId::powers()),
            Some(executable.as_path())
        );

        loaded.set_live_resource(&powers_id, "USB0::Replacement::INSTR");
        assert_eq!(loaded.live_resource_identities().get("powers-1"), None);
        loaded.set_live_resource_with_identity(&powers_id, powers, Some(powers_identity.clone()));
        assert_eq!(
            loaded.live_resource_identities().get("powers-1"),
            Some(&powers_identity)
        );
        assert!(loaded.remove_live_resource(&powers_id));
        assert!(!loaded.remove_live_resource(&powers_id));
        assert_eq!(loaded.live_resource(&powers_id), None);
        assert_eq!(loaded.live_resource_identities().get("powers-1"), None);
        loaded.save(&path).unwrap();
        let reloaded = Config::load(&path).unwrap();
        assert_eq!(reloaded.live_resource(&powers_id), None);
        assert_eq!(reloaded.live_resource_identities().get("powers-1"), None);
        assert_eq!(reloaded.live_resource(&meters_id), Some(meters));
        assert_eq!(
            reloaded.live_resource_identities().get("meters-1"),
            Some(&meters_identity)
        );
        assert_eq!(
            reloaded.executable_path(&ToolId::powers()),
            Some(executable.as_path())
        );

        let legacy_path = test_dir.path().join("legacy.toml");
        fs::write(
            &legacy_path,
            "[live_resources]\nmeters-1 = \"USB0::Legacy::INSTR\"\n",
        )
        .unwrap();
        let legacy = Config::load(&legacy_path).unwrap();
        assert_eq!(
            legacy.live_resource(&meters_id),
            Some("USB0::Legacy::INSTR")
        );
        assert!(legacy.live_resource_identities().is_empty());
    }

    #[test]
    fn invalid_live_resource_instance_id_is_rejected() {
        let test_dir = TestDir::new();
        let path = test_dir.path().join("orchestrator.toml");
        fs::write(&path, "[live_resources]\nbad_id = \"USB0::load\"\n").unwrap();
        assert!(matches!(
            Config::load(path),
            Err(ConfigError::InvalidInstanceId { .. })
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
        assert_eq!(
            config.live_resource(&crate::tool_instance::ToolInstanceId::new("meters-1").unwrap()),
            None
        );

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
