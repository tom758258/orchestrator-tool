use std::{error::Error, fmt};

/// A validated identifier for an external tool.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ToolId(String);

impl ToolId {
    /// Creates a tool ID from a lowercase kebab-case string.
    pub fn new(value: impl AsRef<str>) -> Result<Self, InvalidToolId> {
        let value = value.as_ref();

        if is_valid(value) {
            Ok(Self(value.to_owned()))
        } else {
            Err(InvalidToolId)
        }
    }

    /// Returns the canonical ID for the meters tool.
    pub fn meters() -> Self {
        Self("meters".to_owned())
    }

    /// Returns the canonical ID for the powers tool.
    pub fn powers() -> Self {
        Self("powers".to_owned())
    }

    /// Returns the canonical ID for the scopes tool.
    pub fn scopes() -> Self {
        Self("scopes".to_owned())
    }

    /// Returns the canonical ID for the wavegen tool.
    pub fn wavegen() -> Self {
        Self("wavegen".to_owned())
    }

    /// Returns the tool ID as a string slice.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ToolId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// The supplied value is not a valid tool ID.
#[derive(Debug)]
pub struct InvalidToolId;

impl fmt::Display for InvalidToolId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("tool ID must match [a-z0-9]+(-[a-z0-9]+)*")
    }
}

impl Error for InvalidToolId {}

fn is_valid(value: &str) -> bool {
    value.split('-').all(|segment| {
        !segment.is_empty()
            && segment
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
    })
}

#[cfg(test)]
mod tests {
    use super::ToolId;

    #[test]
    fn built_in_tool_ids_are_valid() {
        for (tool_id, expected) in [
            (ToolId::meters(), "meters"),
            (ToolId::powers(), "powers"),
            (ToolId::scopes(), "scopes"),
            (ToolId::wavegen(), "wavegen"),
        ] {
            assert_eq!(ToolId::new(expected).unwrap(), tool_id);
        }
    }

    #[test]
    fn non_built_in_tool_id_is_valid() {
        let tool_id = ToolId::new("electronic-load").unwrap();

        assert_eq!(tool_id.as_str(), "electronic-load");
    }

    #[test]
    fn invalid_tool_ids_are_rejected() {
        for value in [
            "",
            "Meters",
            "meters_tool",
            "-meters",
            "meters-",
            "meters--tool",
        ] {
            assert!(ToolId::new(value).is_err(), "{value:?} should be invalid");
        }
    }
}
