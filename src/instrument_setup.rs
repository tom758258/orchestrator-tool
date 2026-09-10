//! Instrument session setup before a run, separate from workflow steps.

/// Instrument session setups intended for future inclusion in a template.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct InstrumentSetup {
    /// Optional setup for the Meters session.
    pub meters: Option<MetersSetup>,
}

/// Placeholder for Meters session setup fields.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MetersSetup {}

#[cfg(test)]
mod tests {
    use super::{InstrumentSetup, MetersSetup};

    #[test]
    fn default_setup_has_no_instrument_setup() {
        let setup = InstrumentSetup::default();

        assert!(setup.meters.is_none());
    }

    #[test]
    fn setup_can_hold_meters_setup() {
        let setup = InstrumentSetup {
            meters: Some(MetersSetup {}),
        };

        assert_eq!(setup.meters, Some(MetersSetup {}));
    }
}
