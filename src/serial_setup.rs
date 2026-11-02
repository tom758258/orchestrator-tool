//! Serial settings for one startup-bound Serial Worker.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SerialSetup {
    pub baud: u32,
    #[serde(default = "default_data_bits")]
    pub data_bits: u8,
    #[serde(default = "default_parity")]
    pub parity: String,
    #[serde(default = "default_stop_bits")]
    pub stop_bits: u8,
    #[serde(default = "default_parity")]
    pub flow_control: String,
    #[serde(default = "default_timeout")]
    pub timeout_ms: u64,
}

fn default_data_bits() -> u8 {
    8
}
fn default_parity() -> String {
    "none".into()
}
fn default_stop_bits() -> u8 {
    1
}
fn default_timeout() -> u64 {
    1000
}

impl Default for SerialSetup {
    fn default() -> Self {
        Self {
            baud: 115_200,
            data_bits: 8,
            parity: default_parity(),
            stop_bits: 1,
            flow_control: default_parity(),
            timeout_ms: 1000,
        }
    }
}

impl SerialSetup {
    pub fn validate(&self) -> Result<(), String> {
        if self.baud == 0 {
            return Err("Serial baud must be positive".into());
        }
        if !(5..=8).contains(&self.data_bits) {
            return Err("Serial data_bits must be 5..=8".into());
        }
        if !matches!(self.parity.as_str(), "none" | "odd" | "even") {
            return Err("Serial parity must be none, odd or even".into());
        }
        if !(1..=2).contains(&self.stop_bits) {
            return Err("Serial stop_bits must be 1 or 2".into());
        }
        if !matches!(self.flow_control.as_str(), "none" | "software" | "hardware") {
            return Err("Serial flow_control must be none, software or hardware".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::SerialSetup;
    #[test]
    fn defaults_and_invalid_settings() {
        assert!(SerialSetup::default().validate().is_ok());
        let invalid_baud = SerialSetup {
            baud: 0,
            ..Default::default()
        };
        assert!(invalid_baud.validate().is_err());
        let invalid_parity = SerialSetup {
            parity: "mark".into(),
            ..Default::default()
        };
        assert!(invalid_parity.validate().is_err());
    }
}
