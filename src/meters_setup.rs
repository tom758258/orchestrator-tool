//! Meters session setup before a run, separate from workflow steps.

use std::{error::Error, fmt};

use serde::{Deserialize, Serialize};

/// Meters session setup data, validated explicitly with [`MetersSetup::validate`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MetersSetup {
    pub measurement: MetersMeasurement,
    pub range_mode: RangeMode,
    /// Range value used in manual mode.
    pub manual_range: Option<f64>,
    pub nplc: f64,
    pub auto_zero: AutoZero,
    pub dcv_input_impedance: Option<DcvInputImpedance>,
    pub current_terminal: Option<u32>,
    #[serde(default, skip_serializing_if = "MetersTriggerMode::is_software")]
    pub trigger_mode: MetersTriggerMode,
    #[serde(
        default = "default_sample_count",
        skip_serializing_if = "is_default_sample_count"
    )]
    pub sample_count: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub buffer_drain_size: Option<usize>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub allow_buffer_overflow_risk: bool,
}

impl Default for MetersSetup {
    fn default() -> Self {
        Self {
            measurement: MetersMeasurement::VoltageDc,
            range_mode: RangeMode::Auto,
            manual_range: None,
            nplc: 1.0,
            auto_zero: AutoZero::On,
            dcv_input_impedance: None,
            current_terminal: None,
            trigger_mode: MetersTriggerMode::Software,
            sample_count: 1,
            buffer_drain_size: None,
            allow_buffer_overflow_risk: false,
        }
    }
}

const fn default_sample_count() -> usize {
    1
}

fn is_default_sample_count(value: &usize) -> bool {
    *value == default_sample_count()
}

fn is_false(value: &bool) -> bool {
    !value
}

impl MetersSetup {
    /// Checks setup consistency and current terminal values; range and NPLC support are validated by meters-tool.
    /// Auto range does not require or validate a manual range value.
    pub fn validate(&self) -> Result<(), MetersSetupError> {
        if self.trigger_mode.is_custom() {
            if !(1..=1_000_000).contains(&self.sample_count) {
                return Err(MetersSetupError::InvalidSampleCount);
            }
            if self
                .buffer_drain_size
                .is_some_and(|size| !(1..=10_000).contains(&size))
            {
                return Err(MetersSetupError::InvalidBufferDrainSize);
            }
        }
        if self.range_mode == RangeMode::Manual && self.manual_range.is_none() {
            return Err(MetersSetupError::MissingManualRange);
        }

        match self.measurement {
            MetersMeasurement::VoltageDc if self.current_terminal.is_some() => {
                Err(MetersSetupError::CurrentTerminalForVoltageDc)
            }
            MetersMeasurement::CurrentDc if self.dcv_input_impedance.is_some() => {
                Err(MetersSetupError::InputImpedanceForCurrentDc)
            }
            _ if !matches!(self.current_terminal, None | Some(3 | 10)) => {
                Err(MetersSetupError::InvalidCurrentTerminal)
            }
            _ => Ok(()),
        }
    }
}

/// An inconsistent Meters session setup.
#[derive(Debug)]
pub enum MetersSetupError {
    MissingManualRange,
    CurrentTerminalForVoltageDc,
    InputImpedanceForCurrentDc,
    InvalidCurrentTerminal,
    InvalidSampleCount,
    InvalidBufferDrainSize,
}

impl fmt::Display for MetersSetupError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidCurrentTerminal => "current terminal must be 3 or 10",
            Self::MissingManualRange => "manual range mode requires a manual range value",
            Self::InvalidSampleCount => {
                "custom sample count must be between 1 and 1000000"
            }
            Self::InvalidBufferDrainSize => {
                "custom buffer drain size must be between 1 and 10000"
            }
            Self::CurrentTerminalForVoltageDc => {
                "DC voltage setup must not contain a current terminal"
            }
            Self::InputImpedanceForCurrentDc => {
                "DC current setup must not contain DC voltage input impedance"
            }
        })
    }
}

impl Error for MetersSetupError {}

/// Supported Meters trigger behavior exposed by Orchestrator.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MetersTriggerMode {
    #[default]
    Software,
    SoftwareCustom,
    ImmediateCustom,
    ExternalCustom,
}

impl MetersTriggerMode {
    fn is_software(&self) -> bool {
        *self == Self::Software
    }

    pub fn is_custom(&self) -> bool {
        matches!(
            self,
            Self::SoftwareCustom | Self::ImmediateCustom | Self::ExternalCustom
        )
    }

    pub fn uses_software_trigger(&self) -> bool {
        matches!(self, Self::Software | Self::SoftwareCustom)
    }
}

/// Supported Meters measurements.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MetersMeasurement {
    VoltageDc,
    CurrentDc,
}

/// Automatic or manual measurement range selection.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RangeMode {
    Auto,
    Manual,
}

/// Meters auto zero setting.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AutoZero {
    On,
    Off,
    Once,
}

/// Input impedance selection for DC voltage measurements.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DcvInputImpedance {
    Default,
    TenMegohm,
    Auto,
}

#[cfg(test)]
mod tests {
    use super::{
        AutoZero, DcvInputImpedance, MetersMeasurement, MetersSetup, MetersSetupError,
        MetersTriggerMode, RangeMode,
    };

    #[test]
    fn setup_can_hold_dc_voltage_setup() {
        let meters = MetersSetup {
            measurement: MetersMeasurement::VoltageDc,
            range_mode: RangeMode::Manual,
            manual_range: Some(10.0),
            nplc: 1.0,
            auto_zero: AutoZero::On,
            dcv_input_impedance: Some(DcvInputImpedance::TenMegohm),
            current_terminal: None,
            ..MetersSetup::default()
        };

        assert!(meters.validate().is_ok());
    }

    #[test]
    fn existing_setup_without_trigger_fields_defaults_to_software() {
        let setup: MetersSetup = serde_json::from_str(
            r#"{"measurement":"voltage-dc","range_mode":"auto","manual_range":null,"nplc":1.0,"auto_zero":"on","dcv_input_impedance":null,"current_terminal":null}"#,
        )
        .unwrap();
        assert_eq!(setup.trigger_mode, MetersTriggerMode::Software);
        assert_eq!(setup.sample_count, 1);
        assert_eq!(setup.buffer_drain_size, None);
        assert!(!setup.allow_buffer_overflow_risk);
    }

    #[test]
    fn all_custom_trigger_modes_validate_batch_fields() {
        for trigger_mode in [
            MetersTriggerMode::SoftwareCustom,
            MetersTriggerMode::ImmediateCustom,
            MetersTriggerMode::ExternalCustom,
        ] {
            let setup = MetersSetup {
                trigger_mode,
                sample_count: 1_000_000,
                buffer_drain_size: Some(10_000),
                ..MetersSetup::default()
            };
            assert!(setup.validate().is_ok());

            let invalid_samples = MetersSetup {
                sample_count: 0,
                ..setup.clone()
            };
            assert!(matches!(
                invalid_samples.validate(),
                Err(MetersSetupError::InvalidSampleCount)
            ));

            let invalid_drain = MetersSetup {
                buffer_drain_size: Some(10_001),
                ..setup
            };
            assert!(matches!(
                invalid_drain.validate(),
                Err(MetersSetupError::InvalidBufferDrainSize)
            ));
        }
    }

    #[test]
    fn setup_can_hold_dc_current_setup() {
        let meters = MetersSetup {
            measurement: MetersMeasurement::CurrentDc,
            range_mode: RangeMode::Auto,
            manual_range: None,
            nplc: 0.2,
            auto_zero: AutoZero::Once,
            dcv_input_impedance: None,
            current_terminal: Some(3),
            ..MetersSetup::default()
        };

        assert!(meters.validate().is_ok());
    }

    #[test]
    fn dc_current_rejects_invalid_current_terminal() {
        let setup = MetersSetup {
            measurement: MetersMeasurement::CurrentDc,
            range_mode: RangeMode::Auto,
            manual_range: None,
            nplc: 0.2,
            auto_zero: AutoZero::Once,
            dcv_input_impedance: None,
            current_terminal: Some(4),
            ..MetersSetup::default()
        };

        let error = setup.validate().unwrap_err();
        assert!(matches!(error, MetersSetupError::InvalidCurrentTerminal));
        assert_eq!(error.to_string(), "current terminal must be 3 or 10");
    }

    #[test]
    fn manual_range_requires_a_value() {
        let setup = MetersSetup {
            measurement: MetersMeasurement::VoltageDc,
            range_mode: RangeMode::Manual,
            manual_range: None,
            nplc: 1.0,
            auto_zero: AutoZero::On,
            dcv_input_impedance: None,
            current_terminal: None,
            ..MetersSetup::default()
        };

        let error = setup.validate().unwrap_err();
        assert!(matches!(error, MetersSetupError::MissingManualRange));
        assert_eq!(
            error.to_string(),
            "manual range mode requires a manual range value"
        );
    }

    #[test]
    fn dc_voltage_rejects_current_terminal() {
        let setup = MetersSetup {
            measurement: MetersMeasurement::VoltageDc,
            range_mode: RangeMode::Auto,
            manual_range: None,
            nplc: 1.0,
            auto_zero: AutoZero::On,
            dcv_input_impedance: None,
            current_terminal: Some(3),
            ..MetersSetup::default()
        };

        let error = setup.validate().unwrap_err();
        assert!(matches!(
            error,
            MetersSetupError::CurrentTerminalForVoltageDc
        ));
        assert_eq!(
            error.to_string(),
            "DC voltage setup must not contain a current terminal"
        );
    }

    #[test]
    fn dc_current_rejects_input_impedance() {
        let setup = MetersSetup {
            measurement: MetersMeasurement::CurrentDc,
            range_mode: RangeMode::Auto,
            manual_range: None,
            nplc: 0.2,
            auto_zero: AutoZero::Once,
            dcv_input_impedance: Some(DcvInputImpedance::Default),
            current_terminal: Some(3),
            ..MetersSetup::default()
        };

        let error = setup.validate().unwrap_err();
        assert!(matches!(
            error,
            MetersSetupError::InputImpedanceForCurrentDc
        ));
        assert_eq!(
            error.to_string(),
            "DC current setup must not contain DC voltage input impedance"
        );
    }
}
