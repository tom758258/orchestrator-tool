//! Logical external tool instances within a template.

use std::{error::Error, fmt};

use serde::{Deserialize, Serialize};

use crate::{meters_setup::MetersSetup, tool::ToolId};

/// A logical instance ID, unique within a template.
#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct ToolInstanceId(String);

impl ToolInstanceId {
    pub fn new(value: impl AsRef<str>) -> Result<Self, InvalidToolInstanceId> {
        ToolId::new(value.as_ref()).map_err(|_| InvalidToolInstanceId)?;
        Ok(Self(value.as_ref().to_owned()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
impl TryFrom<String> for ToolInstanceId {
    type Error = InvalidToolInstanceId;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}
impl From<ToolInstanceId> for String {
    fn from(value: ToolInstanceId) -> Self {
        value.0
    }
}
impl fmt::Display for ToolInstanceId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
#[derive(Debug)]
pub struct InvalidToolInstanceId;
impl fmt::Display for InvalidToolInstanceId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("tool instance ID must match [a-z0-9]+(-[a-z0-9]+)*")
    }
}
impl Error for InvalidToolInstanceId {}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ToolSetup {
    Meters(MetersSetup),
    Empty(EmptySetup),
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EmptySetup {}
impl Default for ToolSetup {
    fn default() -> Self {
        Self::Empty(EmptySetup {})
    }
}

#[derive(Clone, Debug, PartialEq)]
/// Per-instance setup, checked when constructing a Template.
pub struct ToolInstance {
    pub id: ToolInstanceId,
    pub tool: ToolId,
    pub setup: ToolSetup,
}
impl ToolInstance {
    pub fn meters_setup(&self) -> Option<&MetersSetup> {
        match &self.setup {
            ToolSetup::Meters(setup) => Some(setup),
            ToolSetup::Empty(_) => None,
        }
    }
}
