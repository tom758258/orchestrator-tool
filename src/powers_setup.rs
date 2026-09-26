//! Optional per-channel Powers protection setup.

use std::{collections::HashSet, error::Error, fmt};

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PowersSetup {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protection: Option<PowersProtectionSetup>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PowersProtectionSetup {
    pub channels: Vec<PowersProtectionChannelSetup>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PowersProtectionChannelSetup {
    pub channel: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ovp_voltage: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ocp: Option<OcpState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ocp_delay: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ocp_delay_trigger: Option<OcpDelayTrigger>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OcpState {
    On,
    Off,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OcpDelayTrigger {
    SettingChange,
    CcTransition,
}

#[derive(Debug, PartialEq)]
pub struct PowersSetupError(pub String);

impl fmt::Display for PowersSetupError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}
impl Error for PowersSetupError {}

impl PowersSetup {
    pub fn validate(&self) -> Result<(), PowersSetupError> {
        let Some(protection) = &self.protection else {
            return Ok(());
        };
        if protection.channels.is_empty() {
            return Err(PowersSetupError(
                "protection channels must not be empty".into(),
            ));
        }
        let mut seen = HashSet::new();
        for record in &protection.channels {
            if record.channel == 0 {
                return Err(PowersSetupError(
                    "protection channel must be positive".into(),
                ));
            }
            if !seen.insert(record.channel) {
                return Err(PowersSetupError(format!(
                    "duplicate protection channel {}",
                    record.channel
                )));
            }
            if record.ovp_voltage.is_none()
                && record.ocp.is_none()
                && record.ocp_delay.is_none()
                && record.ocp_delay_trigger.is_none()
            {
                return Err(PowersSetupError(format!(
                    "protection channel {} has no settings",
                    record.channel
                )));
            }
            for (name, value) in [
                ("ovp_voltage", record.ovp_voltage),
                ("ocp_delay", record.ocp_delay),
            ] {
                if let Some(value) = value
                    && (!value.is_finite() || value < 0.0)
                {
                    return Err(PowersSetupError(format!(
                        "protection channel {} {name} must be finite and nonnegative",
                        record.channel
                    )));
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    #[test]
    fn legacy_and_protection_round_trip() {
        let empty: PowersSetup = serde_json::from_value(json!({})).unwrap();
        empty.validate().unwrap();
        assert_eq!(serde_json::to_value(empty).unwrap(), json!({}));
        let value = json!({"protection":{"channels":[{"channel":1,"ovp_voltage":5.5,"ocp":"on"},
            {"channel":2,"ocp_delay":0.05,"ocp_delay_trigger":"setting-change"}]}});
        let setup: PowersSetup = serde_json::from_value(value.clone()).unwrap();
        setup.validate().unwrap();
        assert_eq!(serde_json::to_value(setup).unwrap(), value);
    }

    #[test]
    fn rejects_invalid_shape_and_values() {
        for value in [
            json!({"protection":{"channels":[]}}),
            json!({"protection":{"channels":[{"channel":0,"ocp":"on"}]}}),
            json!({"protection":{"channels":[{"channel":1,"ocp":"on"},{"channel":1,"ocp":"off"}]}}),
            json!({"protection":{"channels":[{"channel":1}]}}),
            json!({"protection":{"channels":[{"channel":1,"ovp_voltage":-1.0}]}}),
            json!({"protection":{"channels":[{"channel":1,"ocp_delay":-1.0}]}}),
        ] {
            let setup: PowersSetup = serde_json::from_value(value).unwrap();
            assert!(setup.validate().is_err());
        }
        for value in [
            json!({"protection":{"channels":[{"channel":1,"ocp":"invalid"}]}}),
            json!({"protection":{"channels":[{"channel":1,"ocp_delay_trigger":"invalid"}]}}),
        ] {
            assert!(serde_json::from_value::<PowersSetup>(value).is_err());
        }
        for field in ["ovp_voltage", "ocp_delay"] {
            let mut setup = PowersSetup {
                protection: Some(PowersProtectionSetup {
                    channels: vec![PowersProtectionChannelSetup {
                        channel: 1,
                        ovp_voltage: None,
                        ocp: None,
                        ocp_delay: None,
                        ocp_delay_trigger: None,
                    }],
                }),
            };
            let record = &mut setup.protection.as_mut().unwrap().channels[0];
            match field {
                "ovp_voltage" => record.ovp_voltage = Some(f64::NAN),
                _ => record.ocp_delay = Some(f64::INFINITY),
            }
            assert!(setup.validate().is_err());
        }
        assert!(serde_json::from_value::<PowersSetup>(Value::Null).is_err());
    }
}
