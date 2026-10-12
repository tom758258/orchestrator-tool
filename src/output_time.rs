//! Display settings for Output time sources; committed values retain their original units.

use chrono::{DateTime, NaiveDate};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ElapsedTimeFormat {
    Seconds,
    MinutesSeconds,
    HoursMinutesSeconds,
    DaysDecimal,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum OutputTimeFormat {
    ElapsedTime {
        format: ElapsedTimeFormat,
    },
    Timestamp {
        include_date: bool,
        include_utc_offset: bool,
    },
}

impl OutputTimeFormat {
    pub fn excel_number_format(self) -> String {
        match self {
            Self::ElapsedTime { format } => match format {
                ElapsedTimeFormat::Seconds => "0.000",
                ElapsedTimeFormat::MinutesSeconds => "[mm]:ss.000",
                ElapsedTimeFormat::HoursMinutesSeconds => "[hh]:mm:ss.000",
                ElapsedTimeFormat::DaysDecimal => "0.000000000 \"d\"",
            }
            .to_owned(),
            Self::Timestamp {
                include_date,
                include_utc_offset,
            } => format!(
                "{}hh:mm:ss.000{}",
                if include_date { "yyyy-mm-dd\"T\"" } else { "" },
                if include_utc_offset { "\"+08:00\"" } else { "" },
            ),
        }
    }

    pub fn excel_value(self, value: &serde_json::Value) -> Result<f64, String> {
        match self {
            Self::ElapsedTime { format } => {
                let seconds = value.as_f64().ok_or("Elapsed time must be a number")?;
                Ok(if format == ElapsedTimeFormat::Seconds {
                    seconds
                } else {
                    seconds / 86400.0
                })
            }
            Self::Timestamp { .. } => {
                let timestamp = parse_timestamp(value)?;
                let epoch = NaiveDate::from_ymd_opt(1899, 12, 30)
                    .unwrap()
                    .and_hms_opt(0, 0, 0)
                    .unwrap();
                Ok((timestamp.naive_local() - epoch).num_milliseconds() as f64 / 86_400_000.0)
            }
        }
    }
}

fn parse_timestamp(value: &serde_json::Value) -> Result<DateTime<chrono::FixedOffset>, String> {
    DateTime::parse_from_rfc3339(value.as_str().ok_or("Timestamp must be an ISO string")?)
        .map_err(|error| error.to_string())
}

/// Absolute milliseconds for Scatter X, independent of the host timezone.
pub fn timestamp_millis(value: &serde_json::Value) -> Result<f64, String> {
    Ok(parse_timestamp(value)?.timestamp_millis() as f64)
}
