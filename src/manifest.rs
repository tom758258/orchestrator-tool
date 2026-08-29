use std::{error::Error, fmt};

use serde::Deserialize;

use crate::tool::{InvalidToolId, ToolId};

const SUPPORTED_MANIFEST_SCHEMA_VERSION: u32 = 2;
const SUPPORTED_WORKER_SCHEMA_VERSIONS: &[u32] = &[2];

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

    /// Returns worker schema compatibility with this orchestrator.
    pub fn worker_compatibility(&self) -> WorkerCompatibility {
        let compatible = self
            .worker_protocol
            .schema_versions
            .iter()
            .any(|version| supports_worker_schema_version(*version));

        if compatible {
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
            | Self::ToolIdMismatch { .. } => None,
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

    Ok(ToolManifest {
        schema_version: raw.schema_version,
        tool_id,
        tool_version: raw.tool_version,
        worker_protocol: WorkerProtocol {
            compatibility_policy: raw.worker_protocol.compatibility_policy,
            schema_versions: raw.worker_protocol.schema_versions,
        },
    })
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
            WorkerCompatibility::Compatible
        );
    }

    #[test]
    fn worker_schema_compatibility_uses_intersection() {
        let cases: Vec<(Vec<u32>, WorkerCompatibility)> = vec![
            (vec![2], WorkerCompatibility::Compatible),
            (vec![1, 2], WorkerCompatibility::Compatible),
            (vec![2, 3], WorkerCompatibility::Compatible),
            (vec![1], WorkerCompatibility::Incompatible),
            (vec![3], WorkerCompatibility::Incompatible),
            (vec![], WorkerCompatibility::Incompatible),
        ];

        for (versions, expected) in cases {
            let json =
                valid_manifest_json("meters", "3.1.0", 2, "tool_manifest", &versions, "v2-only");
            let manifest = parse_manifest(&json, &ToolId::meters()).unwrap();
            assert_eq!(
                manifest.worker_compatibility(),
                expected,
                "versions {versions:?} should be {expected:?}"
            );
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
