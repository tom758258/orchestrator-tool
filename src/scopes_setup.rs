//! Optional fixed acquisition and analog channel settings.

use serde::{Deserialize, Serialize};
use std::{collections::HashSet, error::Error, fmt};

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScopesSetup {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acquisition: Option<ScopesAcquisitionSetup>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub channels: Vec<ScopesChannelSetup>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScopesAcquisitionSetup {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acquisition_type: Option<AcquisitionType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub average_count: Option<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AcquisitionType {
    Normal,
    Average,
    HighResolution,
    Peak,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InputCoupling {
    Ac,
    Dc,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChannelUnits {
    Volt,
    Amp,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScopesChannelSetup {
    pub channel: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coupling: Option<InputCoupling>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub probe_ratio: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bandwidth_limit: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invert: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub units: Option<ChannelUnits>,
}

#[derive(Debug, PartialEq)]
pub struct ScopesSetupError(pub String);
impl fmt::Display for ScopesSetupError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl Error for ScopesSetupError {}

impl ScopesSetup {
    pub fn validate(&self) -> Result<(), ScopesSetupError> {
        if let Some(acquisition) = &self.acquisition {
            if acquisition.acquisition_type.is_none() && acquisition.average_count.is_none() {
                return Err(ScopesSetupError("acquisition has no settings".into()));
            }
            if let Some(count) = acquisition.average_count
                && (count < 2 || acquisition.acquisition_type != Some(AcquisitionType::Average))
            {
                return Err(ScopesSetupError(
                    "average_count requires acquisition_type average and an integer >= 2".into(),
                ));
            }
        }
        let mut seen = HashSet::new();
        for record in &self.channels {
            if record.channel == 0 || !seen.insert(record.channel) {
                return Err(ScopesSetupError(format!(
                    "invalid or duplicate channel {}",
                    record.channel
                )));
            }
            if record.coupling.is_none()
                && record.probe_ratio.is_none()
                && record.bandwidth_limit.is_none()
                && record.invert.is_none()
                && record.units.is_none()
            {
                return Err(ScopesSetupError(format!(
                    "channel {} has no settings",
                    record.channel
                )));
            }
            if let Some(value) = record.probe_ratio
                && (!value.is_finite() || value <= 0.0)
            {
                return Err(ScopesSetupError(format!(
                    "channel {} probe_ratio must be finite and positive",
                    record.channel
                )));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn scopes_empty_and_explicit_setup_round_trip() {
        for value in [
            json!({}),
            json!({"acquisition":{"acquisition_type":"average","average_count":16},
            "channels":[{"channel":1,"coupling":"dc","probe_ratio":10.0,"bandwidth_limit":false,"invert":true,"units":"amp"}]}),
        ] {
            let setup: ScopesSetup = serde_json::from_value(value.clone()).unwrap();
            setup.validate().unwrap();
            assert_eq!(serde_json::to_value(setup).unwrap(), value);
        }
    }
    #[test]
    fn scopes_rejects_invalid_setup() {
        for value in [
            json!({"acquisition":{}}),
            json!({"acquisition":{"average_count":16}}),
            json!({"acquisition":{"acquisition_type":"average","average_count":1}}),
            json!({"channels":[{"channel":0,"invert":false}]}),
            json!({"channels":[{"channel":1}]}),
            json!({"channels":[{"channel":1,"probe_ratio":0}]}),
            json!({"channels":[{"channel":1,"units":"volt"},{"channel":1,"units":"amp"}]}),
        ] {
            assert!(
                serde_json::from_value::<ScopesSetup>(value)
                    .unwrap()
                    .validate()
                    .is_err()
            );
        }
        for value in [
            json!({"model_id":"test"}),
            json!({"acquisition":{"acquisition_type":"unknown"}}),
            json!({"channels":[{"channel":1,"invert":"on"}]}),
        ] {
            assert!(serde_json::from_value::<ScopesSetup>(value).is_err());
        }
    }
}
