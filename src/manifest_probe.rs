use std::{error::Error, fmt, path::Path, time::Duration};

use crate::{
    manifest::{ManifestError, ToolManifest, parse_manifest},
    process::{CaptureError, run_output_with_timeout},
    tool::ToolId,
};

const MANIFEST_PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// Result of a successful manifest probe.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManifestProbe {
    manifest: ToolManifest,
    stderr: String,
}

impl ManifestProbe {
    /// Returns the parsed manifest.
    pub fn manifest(&self) -> &ToolManifest {
        &self.manifest
    }

    /// Returns captured stderr text.
    pub fn stderr(&self) -> &str {
        &self.stderr
    }
}

/// Errors from probing a tool manifest.
#[derive(Debug)]
pub enum ManifestProbeError {
    Io(std::io::Error),
    Timeout,
    NonZeroExit {
        status: std::process::ExitStatus,
        stderr: String,
    },
    InvalidStdoutUtf8(std::string::FromUtf8Error),
    Manifest(ManifestError),
}

impl fmt::Display for ManifestProbeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "manifest probe I/O error: {error}"),
            Self::Timeout => write!(
                formatter,
                "manifest probe timed out after {} seconds",
                MANIFEST_PROBE_TIMEOUT.as_secs()
            ),
            Self::NonZeroExit { status, stderr } => {
                write!(formatter, "manifest probe failed with {status}")?;
                let trimmed = stderr.trim();
                if !trimmed.is_empty() {
                    write!(formatter, ": {trimmed}")?;
                }
                Ok(())
            }
            Self::InvalidStdoutUtf8(error) => {
                write!(
                    formatter,
                    "manifest probe stdout is not valid UTF-8: {error}"
                )
            }
            Self::Manifest(error) => write!(formatter, "{error}"),
        }
    }
}

impl Error for ManifestProbeError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(source) => Some(source),
            Self::Manifest(source) => Some(source),
            Self::InvalidStdoutUtf8(source) => Some(source),
            Self::Timeout | Self::NonZeroExit { .. } => None,
        }
    }
}

/// Probes an executable for its tool manifest.
pub fn probe_manifest(
    executable: impl AsRef<Path>,
    expected_tool_id: &ToolId,
) -> Result<ManifestProbe, ManifestProbeError> {
    let output = run_output_with_timeout(
        executable.as_ref(),
        ["manifest", "--json"],
        MANIFEST_PROBE_TIMEOUT,
    )
    .map_err(|error| match error {
        CaptureError::Io(error) => ManifestProbeError::Io(error),
        CaptureError::Timeout => ManifestProbeError::Timeout,
    })?;

    if !output.status.success() {
        return Err(ManifestProbeError::NonZeroExit {
            status: output.status,
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        });
    }

    let stdout = String::from_utf8(output.stdout).map_err(ManifestProbeError::InvalidStdoutUtf8)?;
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let manifest =
        parse_manifest(&stdout, expected_tool_id).map_err(ManifestProbeError::Manifest)?;

    Ok(ManifestProbe { manifest, stderr })
}
