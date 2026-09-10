//! Instrument session setup before a run, separate from workflow steps.

/// Instrument session setups intended for future inclusion in a template.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct InstrumentSetup {
    /// Optional setup for the Meters session.
    pub meters: Option<MetersSetup>,
}

/// Meters session setup data, without validation.
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
        AutoZero, DcvInputImpedance, InstrumentSetup, MetersMeasurement, MetersSetup, RangeMode,
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

        assert_eq!(setup.meters, Some(meters));
    }
}
