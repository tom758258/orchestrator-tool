//! Incremental UTF-8 view for raw Serial RX. Raw hex always remains authoritative.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SerialDataFormat {
    #[default]
    Hex,
    Text,
}

#[derive(Default)]
pub struct SerialTextDecoder {
    pending: Vec<u8>,
}

pub fn raw_bytes(hex: &str) -> Result<Vec<u8>, String> {
    if !hex.len().is_multiple_of(2) {
        return Err("Serial hex has an odd number of digits".into());
    }
    let bytes = hex.as_bytes();
    let (pairs, _) = bytes.as_chunks::<2>();
    pairs
        .iter()
        .map(|pair| {
            let pair = std::str::from_utf8(pair).map_err(|e| e.to_string())?;
            u8::from_str_radix(pair, 16).map_err(|e| e.to_string())
        })
        .collect()
}

pub fn spaced_hex(hex: &str) -> String {
    hex.as_bytes()
        .chunks(2)
        .map(|c| std::str::from_utf8(c).unwrap_or("?").to_uppercase())
        .collect::<Vec<_>>()
        .join(" ")
}

fn escape_controls(s: &str) -> String {
    let mut output = String::new();
    for ch in s.chars() {
        match ch {
            '\r' => output.push_str("\\r"),
            '\n' => output.push_str("\\n"),
            '\t' => output.push_str("\\t"),
            _ if (ch as u32) < 0x20 || (0x7f..=0x9f).contains(&(ch as u32)) => {
                output.push_str(&format!("\\u{{{:X}}}", ch as u32));
            }
            _ => output.push(ch),
        }
    }
    output
}

impl SerialTextDecoder {
    pub fn decode(&mut self, hex: &str) -> Result<String, String> {
        let mut bytes = std::mem::take(&mut self.pending);
        bytes.extend(raw_bytes(hex)?);
        let mut output = String::new();
        let mut cursor = 0;
        while cursor < bytes.len() {
            match std::str::from_utf8(&bytes[cursor..]) {
                Ok(s) => {
                    output.push_str(&escape_controls(s));
                    break;
                }
                Err(error) => {
                    let valid_end = cursor + error.valid_up_to();
                    output.push_str(&escape_controls(
                        std::str::from_utf8(&bytes[cursor..valid_end]).expect("valid prefix"),
                    ));
                    cursor = valid_end;
                    if let Some(length) = error.error_len() {
                        output.push('�');
                        cursor += length;
                    } else {
                        self.pending.extend_from_slice(&bytes[cursor..]);
                        break;
                    }
                }
            }
        }
        Ok(output)
    }
}

pub fn serial_cells(
    sample: &serde_json::Value,
    mode: SerialDataFormat,
    decoder: &mut SerialTextDecoder,
) -> Result<Vec<serde_json::Value>, String> {
    use serde_json::json;
    let hex = sample["rx_hex"].as_str().ok_or("Missing Serial RX hex")?;
    let data = match mode {
        SerialDataFormat::Hex => spaced_hex(hex),
        SerialDataFormat::Text => decoder.decode(hex)?,
    };
    Ok(vec![
        sample["timestamp_utc"].clone(),
        sample["elapsed_s"].clone(),
        sample["captured"].clone(),
        json!(data),
        sample["rx_bytes"].clone(),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_split_utf8_and_binary_data() {
        let mut decoder = SerialTextDecoder::default();
        assert_eq!(decoder.decode("e4").unwrap(), "");
        assert_eq!(decoder.decode("b8").unwrap(), "");
        assert_eq!(decoder.decode("ad").unwrap(), "中");
        assert_eq!(spaced_hex("00ff0d0a"), "00 FF 0D 0A");
        assert_eq!(raw_bytes("00ff0d0a").unwrap(), [0, 255, 13, 10]);
        let mut controls = SerialTextDecoder::default();
        assert_eq!(
            controls.decode("00097fc280").unwrap(),
            "\\u{0}\\t\\u{7F}\\u{80}"
        );
        assert_eq!(controls.decode("0d0a").unwrap(), "\\r\\n");
        let mut unfinished = SerialTextDecoder::default();
        assert_eq!(unfinished.decode("e4").unwrap(), "");
        assert_eq!(unfinished.decode("b8ad").unwrap(), "中");
    }
}
