//! Instrument session setup before a run, separate from workflow steps.

use std::{error::Error, fmt};

/// Instrument session setups intended for future inclusion in a template.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct InstrumentSetup {
    /// Optional setup for the Meters session.
    pub meters: Option<MetersSetup>,
}

/// Meters session setup data, validated explicitly with [`MetersSetup::validate`].
#[derive(Clone, Debug, PartialEq)]
pub struct MetersSetup {
    pub measurement: MetersMeasurement,
    pub range_mode: RangeMode,
    /// Range value used in manual mode.
    pub manual_range: Option<f64>,
    pub nplc: f64,
    pub auto_zero: AutoZero,
    pub dcv_input_impedance: Option<DcvInputImpedance>,
    pub current_terminal: Option<u32>,
}

impl MetersSetup {
    /// Checks setup consistency; supported numeric values are validated by meters-tool.
    /// Auto range does not require or validate a manual range value.
    pub fn validate(&self) -> Result<(), MetersSetupError> {
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
}

impl fmt::Display for MetersSetupError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::MissingManualRange => "manual range mode requires a manual range value",
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

/// Supported Meters measurements.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MetersMeasurement {
    VoltageDc,
    CurrentDc,
}

/// Automatic or manual measurement range selection.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RangeMode {
    Auto,
    Manual,
}

/// Meters auto zero setting.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AutoZero {
    On,
    Off,
    Once,
}

/// Input impedance selection for DC voltage measurements.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DcvInputImpedance {
    Default,
    TenMegohm,
    Auto,
}

#[cfg(test)]
mod tests {
    use super::{
        AutoZero, DcvInputImpedance, InstrumentSetup, MetersMeasurement, MetersSetup,
        MetersSetupError, RangeMode,
    };

    #[test]
    fn default_setup_has_no_instrument_setup() {
        let setup = InstrumentSetup::default();

        assert!(setup.meters.is_none());
    }

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
        };
        let setup = InstrumentSetup {
            meters: Some(meters.clone()),
        };

        assert!(meters.validate().is_ok());
        assert_eq!(setup.meters, Some(meters));
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
        };
        let setup = InstrumentSetup {
            meters: Some(meters.clone()),
        };

        assert!(meters.validate().is_ok());
        assert_eq!(setup.meters, Some(meters));
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
