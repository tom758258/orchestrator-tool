use std::{error::Error, fmt};

use serde::Deserialize;
use serde_json::{Map, Value};

use crate::tool::{InvalidToolId, ToolId};

const SUPPORTED_MANIFEST_SCHEMA_VERSION: u32 = 2;
const SUPPORTED_WORKER_SCHEMA_VERSIONS: &[u32] = &[3];

pub(crate) fn supports_worker_schema_version(version: u32) -> bool {
    SUPPORTED_WORKER_SCHEMA_VERSIONS.contains(&version)
}

#[derive(Deserialize)]
struct RawToolManifest {
    event: String,
    schema_version: u32,
    tool_id: String,
    tool_version: String,
    worker_protocol: RawWorkerProtocol,
    execution: Option<Value>,
    features: Option<Value>,
    commands: Option<Value>,
}

#[derive(Deserialize)]
struct RawWorkerProtocol {
    compatibility_policy: String,
    schema_versions: Vec<u32>,
}

/// Validated tool manifest.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolManifest {
    schema_version: u32,
    tool_id: ToolId,
    tool_version: String,
    worker_protocol: WorkerProtocol,
    execution_model: Option<String>,
    context_binding: Option<String>,
    features: Map<String, Value>,
    commands: Map<String, Value>,
}

impl ToolManifest {
    /// Returns the manifest schema version.
    pub fn schema_version(&self) -> u32 {
        self.schema_version
    }

    /// Returns the tool ID declared by the manifest.
    pub fn tool_id(&self) -> &ToolId {
        &self.tool_id
    }

    /// Returns the tool version string.
    pub fn tool_version(&self) -> &str {
        &self.tool_version
    }

    /// Returns the worker protocol metadata.
    pub fn worker_protocol(&self) -> &WorkerProtocol {
        &self.worker_protocol
    }

    /// Execution-model declaration, if this is a v3 Manifest.
    pub fn execution_model(&self) -> Option<&str> {
        self.execution_model.as_deref()
    }

    pub fn context_binding(&self) -> Option<&str> {
        self.context_binding.as_deref()
    }

    pub fn feature(&self, name: &str) -> Option<&Value> {
        self.features.get(name)
    }

    /// The command kind is declared by the Manifest when available.
    pub fn command_kind(&self, name: &str) -> Option<&str> {
        self.commands.get(name)?.get("kind")?.as_str()
    }

    /// Runtime declarations must be adopted subsets of the Manifest, not
    /// inferred from the package version or a Tool ID.
    pub fn validate_runtime_features(&self, raw: &Value, required: &[&str]) -> Result<(), String> {
        let runtime = raw
            .as_object()
            .ok_or("runtime features must be an object")?;
        for &name in required {
            if !runtime.contains_key(name) {
                return Err(format!("required runtime feature {name} was not adopted"));
            }
        }
        for (name, adoption) in runtime {
            let Some(manifest) = self.features.get(name) else {
                return Err(format!("undeclared runtime feature {name}"));
            };
            if name.starts_with("common.") {
                validate_common_feature(name, adoption)?;
                if name == "common.streaming" {
                    let selected = adoption["lifecycles"]
                        .as_array()
                        .ok_or("streaming runtime lifecycles missing")?;
                    if selected.len() != 1
                        || !manifest["lifecycles"]
                            .as_array()
                            .is_some_and(|allowed| allowed.iter().any(|item| item == &selected[0]))
                    {
                        return Err("streaming runtime lifecycle is not supported".into());
                    }
                    if adoption["contract_version"] != manifest["contract_version"] {
                        return Err("streaming runtime contract version mismatch".into());
                    }
                } else if adoption != manifest {
                    return Err(format!("runtime feature {name} differs from Manifest"));
                }
            } else if adoption != manifest {
                return Err(format!(
                    "runtime domain feature {name} differs from Manifest"
                ));
            }
        }
        Ok(())
    }

    /// Returns worker schema compatibility with this orchestrator.
    pub fn worker_compatibility(&self) -> WorkerCompatibility {
        let compatible = self
            .worker_protocol
            .schema_versions
            .iter()
            .any(|version| supports_worker_schema_version(*version));

        if compatible
            && self.worker_protocol.compatibility_policy == "v3-only"
            && self.worker_protocol.schema_versions == [3]
            && self.execution_model.is_some()
            && self.context_binding.is_some()
        {
            WorkerCompatibility::Compatible
        } else {
            WorkerCompatibility::Incompatible
        }
    }
}

/// Worker protocol metadata from the manifest.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerProtocol {
    compatibility_policy: String,
    schema_versions: Vec<u32>,
}

impl WorkerProtocol {
    /// Returns the compatibility policy string.
    pub fn compatibility_policy(&self) -> &str {
        &self.compatibility_policy
    }

    /// Returns the worker schema versions declared by the tool.
    pub fn schema_versions(&self) -> &[u32] {
        &self.schema_versions
    }
}

/// Whether the tool worker schema overlaps the orchestrator.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkerCompatibility {
    Compatible,
    Incompatible,
}

/// Errors produced while parsing a tool manifest.
#[derive(Debug)]
pub enum ManifestError {
    InvalidManifest(serde_json::Error),
    UnexpectedEvent(String),
    UnsupportedManifestSchemaVersion(u32),
    InvalidToolId(InvalidToolId),
    ToolIdMismatch { expected: ToolId, actual: ToolId },
    InvalidV3(String),
}

impl fmt::Display for ManifestError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidManifest(source) => write!(formatter, "invalid manifest: {source}"),
            Self::UnexpectedEvent(event) => write!(formatter, "unexpected event {event:?}"),
            Self::UnsupportedManifestSchemaVersion(version) => {
                write!(formatter, "unsupported manifest schema version {version}")
            }
            Self::InvalidToolId(_) => write!(formatter, "invalid tool ID"),
            Self::InvalidV3(message) => write!(formatter, "invalid v3 Manifest: {message}"),
            Self::ToolIdMismatch { expected, actual } => write!(
                formatter,
                "tool ID mismatch: expected {expected}, got {actual}"
            ),
        }
    }
}

impl Error for ManifestError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::InvalidManifest(source) => Some(source),
            Self::InvalidToolId(source) => Some(source),
            Self::UnexpectedEvent(_)
            | Self::UnsupportedManifestSchemaVersion(_)
            | Self::ToolIdMismatch { .. }
            | Self::InvalidV3(_) => None,
        }
    }
}

/// Parses and validates a tool manifest JSON string.
pub fn parse_manifest(
    json: &str,
    expected_tool_id: &ToolId,
) -> Result<ToolManifest, ManifestError> {
    let raw: RawToolManifest =
        serde_json::from_str(json).map_err(ManifestError::InvalidManifest)?;
    let document: Value = serde_json::from_str(json).map_err(ManifestError::InvalidManifest)?;
    if document
        .get("schema_version")
        .and_then(Value::as_u64)
        .is_none()
    {
        return Err(ManifestError::InvalidV3(
            "Manifest schema requires an integer token".into(),
        ));
    }

    if raw.event != "tool_manifest" {
        return Err(ManifestError::UnexpectedEvent(raw.event));
    }

    if raw.schema_version != SUPPORTED_MANIFEST_SCHEMA_VERSION {
        return Err(ManifestError::UnsupportedManifestSchemaVersion(
            raw.schema_version,
        ));
    }

    let tool_id = ToolId::new(raw.tool_id).map_err(ManifestError::InvalidToolId)?;

    if &tool_id != expected_tool_id {
        return Err(ManifestError::ToolIdMismatch {
            expected: expected_tool_id.clone(),
            actual: tool_id,
        });
    }

    let v3 = raw.worker_protocol.schema_versions.contains(&3);
    let (execution_model, context_binding, features, commands) = if v3 {
        if raw.worker_protocol.schema_versions != [3]
            || raw.worker_protocol.compatibility_policy != "v3-only"
        {
            return Err(ManifestError::InvalidV3(
                "Worker protocol must be v3-only [3]".into(),
            ));
        }
        let execution = raw
            .execution
            .as_ref()
            .and_then(Value::as_object)
            .ok_or_else(|| ManifestError::InvalidV3("execution object required".into()))?;
        let model = execution
            .get("model")
            .and_then(Value::as_str)
            .filter(|v| matches!(*v, "run_bound" | "multi_job"))
            .ok_or_else(|| ManifestError::InvalidV3("unsupported execution.model".into()))?;
        let binding = execution
            .get("context_binding")
            .and_then(Value::as_str)
            .filter(|v| matches!(*v, "startup" | "per_command"))
            .ok_or_else(|| {
                ManifestError::InvalidV3("unsupported execution.context_binding".into())
            })?;
        let features = raw
            .features
            .as_ref()
            .and_then(Value::as_object)
            .ok_or_else(|| ManifestError::InvalidV3("features object required".into()))?;
        for (name, value) in features {
            if name.starts_with("common.") {
                validate_common_feature(name, value).map_err(ManifestError::InvalidV3)?;
            }
        }
        if features.contains_key("common.job_cancel") && !features.contains_key("common.async_jobs")
        {
            return Err(ManifestError::InvalidV3(
                "job_cancel requires async_jobs".into(),
            ));
        }
        let commands = match raw.commands.as_ref() {
            Some(value) => value
                .as_object()
                .ok_or_else(|| ManifestError::InvalidV3("commands must be an object".into()))?
                .clone(),
            None => Map::new(),
        };
        for (name, entry) in &commands {
            if name.trim().is_empty()
                || !matches!(
                    entry.get("kind").and_then(Value::as_str),
                    Some("control" | "async_job")
                )
            {
                return Err(ManifestError::InvalidV3(format!(
                    "invalid command entry {name}"
                )));
            }
        }
        (
            Some(model.to_owned()),
            Some(binding.to_owned()),
            features.clone(),
            commands,
        )
    } else {
        (None, None, Map::new(), Map::new())
    };
    if raw.tool_version.trim().is_empty() {
        return Err(ManifestError::InvalidV3(
            "tool_version must not be empty".into(),
        ));
    }

    Ok(ToolManifest {
        schema_version: raw.schema_version,
        tool_id,
        tool_version: raw.tool_version,
        worker_protocol: WorkerProtocol {
            compatibility_policy: raw.worker_protocol.compatibility_policy,
            schema_versions: raw.worker_protocol.schema_versions,
        },
        execution_model,
        context_binding,
        features,
        commands,
    })
}

/// Validate the supported, independently versioned Common capability contracts.
fn validate_common_feature(name: &str, value: &Value) -> Result<(), String> {
    let declaration = value
        .as_object()
        .ok_or_else(|| format!("{name} must be an object"))?;
    let version = declaration.get("contract_version").and_then(Value::as_u64);
    match name {
        "common.async_jobs" | "common.job_cancel" | "common.streaming" => {
            if version != Some(1) {
                return Err(format!("unsupported {name} contract_version"));
            }
        }
        _ => return Ok(()), // unknown optional common feature is not adopted
    }
    let key = match name {
        "common.job_cancel" => Some("commands"),
        "common.streaming" => Some("lifecycles"),
        _ => None,
    };
    if let Some(key) = key {
        let values = declaration
            .get(key)
            .and_then(Value::as_array)
            .filter(|items| !items.is_empty())
            .ok_or_else(|| format!("{name}.{key} must be a non-empty array"))?;
        for item in values {
            let word = item
                .as_str()
                .filter(|x| !x.trim().is_empty())
                .ok_or_else(|| format!("invalid {name}.{key} entry"))?;
            if key == "lifecycles" && !matches!(word, "run_bound" | "deferred_start") {
                return Err(format!("invalid streaming lifecycle {word}"));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{ManifestError, WorkerCompatibility, parse_manifest};
    use crate::tool::ToolId;

    fn valid_manifest_json(
        tool_id: &str,
        tool_version: &str,
        schema_version: u32,
        event: &str,
        schema_versions: &[u32],
        policy: &str,
    ) -> String {
        let versions = schema_versions
            .iter()
            .map(|v| v.to_string())
            .collect::<Vec<_>>()
            .join(", ");
        format!(
            r#"{{
  "event": "{event}",
  "schema_version": {schema_version},
  "tool_id": "{tool_id}",
  "tool_version": "{tool_version}",
  "worker_protocol": {{
    "compatibility_policy": "{policy}",
    "schema_versions": [{versions}]
  }}
}}"#
        )
    }

    #[test]
    fn valid_manifest_is_parsed() {
        let json = r#"{
  "event": "tool_manifest",
  "schema_version": 2,
  "tool_id": "meters",
  "tool_version": "3.1.0",
  "future_optional_field": "hello",
  "worker_protocol": {
    "compatibility_policy": "v2-only",
    "schema_versions": [2],
    "future_worker_field": true
  }
}"#;
        let manifest = parse_manifest(json, &ToolId::meters()).unwrap();

        assert_eq!(manifest.schema_version(), 2);
        assert_eq!(manifest.tool_id(), &ToolId::meters());
        assert_eq!(manifest.tool_version(), "3.1.0");
        assert_eq!(manifest.worker_protocol().compatibility_policy(), "v2-only");
        assert_eq!(manifest.worker_protocol().schema_versions(), &[2]);
        assert_eq!(
            manifest.worker_compatibility(),
            WorkerCompatibility::Incompatible
        );
    }

    #[test]
    fn worker_schema_compatibility_uses_intersection() {
        let cases: Vec<(Vec<u32>, WorkerCompatibility)> = vec![
            (vec![2], WorkerCompatibility::Incompatible),
            (vec![1, 2], WorkerCompatibility::Incompatible),
            (vec![2, 3], WorkerCompatibility::Incompatible),
            (vec![1], WorkerCompatibility::Incompatible),
            (vec![3], WorkerCompatibility::Incompatible),
            (vec![], WorkerCompatibility::Incompatible),
        ];

        for (versions, expected) in cases {
            let json =
                valid_manifest_json("meters", "3.1.0", 2, "tool_manifest", &versions, "v2-only");
            if versions.contains(&3) {
                assert!(
                    parse_manifest(&json, &ToolId::meters()).is_err(),
                    "v3-only Manifest must not accept mixed versions or v2-only policy"
                );
            } else {
                let manifest = parse_manifest(&json, &ToolId::meters()).unwrap();
                assert_eq!(manifest.worker_compatibility(), expected);
            }
        }
    }

    #[test]
    fn v3_manifest_and_runtime_adoption_gate() {
        let payload = serde_json::json!({
            "event":"tool_manifest","schema_version":2,"tool_id":"meters",
            "tool_version":"1.0","worker_protocol":{"compatibility_policy":"v3-only",
            "schema_versions":[3]},"execution":{"model":"run_bound","context_binding":"startup"},
            "features":{"common.streaming":{"contract_version":1,"lifecycles":["run_bound"]}},
            "commands":{"software_trigger":{"kind":"control"}}
        })
        .to_string();
        let manifest = parse_manifest(&payload, &ToolId::meters()).unwrap();
        assert_eq!(
            manifest.worker_compatibility(),
            WorkerCompatibility::Compatible
        );
        assert_eq!(manifest.execution_model(), Some("run_bound"));
        assert_eq!(manifest.command_kind("software_trigger"), Some("control"));
        assert!(
            manifest
                .validate_runtime_features(&serde_json::json!({}), &[])
                .is_ok()
        );
        assert!(manifest.validate_runtime_features(
            &serde_json::json!({"common.streaming":{"contract_version":1,"lifecycles":["run_bound"]}}),
            &["common.streaming"]).is_ok());
        assert!(
            manifest
                .validate_runtime_features(&serde_json::json!({}), &["common.streaming"])
                .is_err()
        );
        assert!(
            manifest
                .validate_runtime_features(
                    &serde_json::json!({"common.async_jobs":{"contract_version":1}}),
                    &[]
                )
                .is_err()
        );
    }

    #[test]
    fn v3_manifest_rejects_noninteger_tokens_and_bad_feature_versions() {
        let base = serde_json::json!({
            "event":"tool_manifest","schema_version":2,"tool_id":"meters",
            "tool_version":"1.0","worker_protocol":{"compatibility_policy":"v3-only",
            "schema_versions":[3]},"execution":{"model":"run_bound","context_binding":"startup"},
            "features":{"common.streaming":{"contract_version":1,"lifecycles":["run_bound"]}}
        })
        .to_string();
        for version in ["\"3\"", "3.0", "3e0", "true"] {
            let bad = base.replace(
                "\"schema_versions\":[3]",
                &format!("\"schema_versions\":[{version}]"),
            );
            assert!(parse_manifest(&bad, &ToolId::meters()).is_err());
        }
        for version in ["\"1\"", "1.0", "1e0", "true", "2"] {
            let bad = base.replace(
                "\"contract_version\":1",
                &format!("\"contract_version\":{version}"),
            );
            assert!(parse_manifest(&bad, &ToolId::meters()).is_err());
        }
    }
    #[test]
    fn tool_identity_mismatch_is_rejected() {
        let json = valid_manifest_json("powers", "3.1.0", 2, "tool_manifest", &[2], "v2-only");
        let error = parse_manifest(&json, &ToolId::meters()).unwrap_err();

        assert!(matches!(error, ManifestError::ToolIdMismatch { .. }));
    }

    #[test]
    fn invalid_tool_id_is_rejected() {
        let json = valid_manifest_json("Meters", "3.1.0", 2, "tool_manifest", &[2], "v2-only");
        let error = parse_manifest(&json, &ToolId::meters()).unwrap_err();

        assert!(matches!(error, ManifestError::InvalidToolId(_)));
    }

    #[test]
    fn manifest_header_is_validated() {
        let wrong_event = valid_manifest_json("meters", "3.1.0", 2, "tool_status", &[2], "v2-only");
        assert!(matches!(
            parse_manifest(&wrong_event, &ToolId::meters()).unwrap_err(),
            ManifestError::UnexpectedEvent(_)
        ));

        for version in [1, 3] {
            let json =
                valid_manifest_json("meters", "3.1.0", version, "tool_manifest", &[2], "v2-only");
            assert!(
                matches!(
                    parse_manifest(&json, &ToolId::meters()).unwrap_err(),
                    ManifestError::UnsupportedManifestSchemaVersion(v) if v == version
                ),
                "schema_version {version} should be rejected"
            );
        }
    }

    #[test]
    fn invalid_manifest_json_is_rejected() {
        let malformed = "{ not json }";
        assert!(matches!(
            parse_manifest(malformed, &ToolId::meters()).unwrap_err(),
            ManifestError::InvalidManifest(_)
        ));

        let missing_field = r#"{
  "event": "tool_manifest"
}"#;
        assert!(matches!(
            parse_manifest(missing_field, &ToolId::meters()).unwrap_err(),
            ManifestError::InvalidManifest(_)
        ));
    }
}
