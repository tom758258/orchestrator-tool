//! Serial settings for one startup-bound Serial Worker.
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SerialTransport {
    #[default]
    Serial,
    Tcp,
}

impl SerialTransport {
    fn is_serial(&self) -> bool {
        *self == Self::Serial
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SerialSetup {
    #[serde(default, skip_serializing_if = "SerialTransport::is_serial")]
    pub transport: SerialTransport,
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
    #[serde(
        default = "default_connect_timeout",
        skip_serializing_if = "is_default_connect_timeout"
    )]
    pub connect_timeout_ms: u64,
    #[serde(
        default = "default_timeout",
        skip_serializing_if = "is_default_io_timeout"
    )]
    pub io_timeout_ms: u64,
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
fn default_connect_timeout() -> u64 {
    3000
}
fn is_default_connect_timeout(value: &u64) -> bool {
    *value == default_connect_timeout()
}
fn is_default_io_timeout(value: &u64) -> bool {
    *value == default_timeout()
}

impl Default for SerialSetup {
    fn default() -> Self {
        Self {
            transport: SerialTransport::Serial,
            baud: 115_200,
            data_bits: 8,
            parity: default_parity(),
            stop_bits: 1,
            flow_control: default_parity(),
            timeout_ms: 1000,
            connect_timeout_ms: default_connect_timeout(),
            io_timeout_ms: default_timeout(),
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
        if self.connect_timeout_ms == 0 || self.io_timeout_ms == 0 {
            return Err("TCP timeouts must be positive".into());
        }
        Ok(())
    }
}

/// Parse the TCP device endpoint stored as one existing local Live Resource.
/// IPv6 literals must be bracketed so the device port is unambiguous.
pub(crate) fn parse_tcp_endpoint(resource: &str) -> Result<(String, u16), String> {
    let resource = resource.trim();
    let (host, port) = if let Some(rest) = resource.strip_prefix('[') {
        let (host, port) = rest
            .split_once("]:")
            .ok_or("TCP endpoint must be host:port or [IPv6]:port")?;
        if host.parse::<std::net::Ipv6Addr>().is_err() {
            return Err("TCP bracketed host must be an IPv6 address".into());
        }
        (host, port)
    } else {
        let (host, port) = resource
            .rsplit_once(':')
            .ok_or("TCP endpoint must be host:port or [IPv6]:port")?;
        if host.contains(':') || host.contains('[') || host.contains(']') {
            return Err("TCP IPv6 host must be bracketed".into());
        }
        (host, port)
    };
    if host.is_empty()
        || host.trim() != host
        || host.chars().any(char::is_whitespace)
        || host.contains('/')
        || host.contains('\\')
    {
        return Err("TCP host must not be empty or contain whitespace or path separators".into());
    }
    let port = port
        .parse::<u16>()
        .map_err(|_| "TCP port must be 1..=65535")?;
    if port == 0 {
        return Err("TCP port must be 1..=65535".into());
    }
    Ok((host.to_owned(), port))
}

#[cfg(test)]
mod tests {
    use super::{SerialSetup, SerialTransport, parse_tcp_endpoint};

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
        let invalid_tcp_timeout = SerialSetup {
            transport: SerialTransport::Tcp,
            io_timeout_ms: 0,
            ..Default::default()
        };
        assert!(invalid_tcp_timeout.validate().is_err());
    }

    #[test]
    fn legacy_uart_and_both_transport_settings_round_trip() {
        let legacy: SerialSetup =
            serde_json::from_str(r#"{"baud":9600,"parity":"even"}"#).unwrap();
        assert_eq!(legacy.transport, SerialTransport::Serial);
        let mut setup = legacy.clone();
        setup.transport = SerialTransport::Tcp;
        setup.connect_timeout_ms = 4500;
        setup.io_timeout_ms = 1250;
        let saved = serde_json::to_string(&setup).unwrap();
        let loaded: SerialSetup = serde_json::from_str(&saved).unwrap();
        assert_eq!(loaded, setup);
        assert_eq!(loaded.baud, 9600);
        assert_eq!(loaded.parity, "even");
        assert_eq!(loaded.io_timeout_ms, 1250);
        assert!(!serde_json::to_string(&legacy).unwrap().contains("transport"));
    }

    #[test]
    fn tcp_endpoint_requires_host_and_valid_port() {
        assert_eq!(
            parse_tcp_endpoint("device.local:5025").unwrap(),
            ("device.local".into(), 5025)
        );
        assert_eq!(
            parse_tcp_endpoint("[::1]:5025").unwrap(),
            ("::1".into(), 5025)
        );
        for invalid in [
            "COM4",
            ":5025",
            "host:0",
            "host:65536",
            "host:abc",
            "::1:5025",
            "[x]:5025",
            "host name:5025",
        ] {
            assert!(parse_tcp_endpoint(invalid).is_err(), "{invalid}");
        }
    }
}
