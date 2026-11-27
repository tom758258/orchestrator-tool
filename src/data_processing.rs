//! Pure Workflow array, string, and byte operations. No transport or variable mutation.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Number, Value};

pub const MAX_PROCESS_STRING_BYTES: usize = 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ArrayOperation {
    Length,
    GetItem,
}

impl ArrayOperation {
    pub fn parameters(self) -> &'static [&'static str] {
        match self {
            Self::Length => &["input"],
            Self::GetItem => &["input", "index"],
        }
    }

    pub fn execute(self, input: &Value, index: Option<&Value>) -> Result<Value, String> {
        let array = input.as_array().ok_or("input must be an Array")?;
        match self {
            Self::Length => Ok(Value::from(array.len())),
            Self::GetItem => {
                let n = index
                    .and_then(Value::as_f64)
                    .ok_or("index must be a non-negative integer")?;
                if n.fract() != 0.0 || n < 0.0 || n >= array.len() as f64 {
                    return Err("Array index is out of range or not an integer".into());
                }
                array
                    .get(n as usize)
                    .cloned()
                    .ok_or_else(|| "Array index is out of range".into())
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StringOperation {
    Length,
    Substring,
    Concat,
    Contains,
    IndexOf,
    Replace,
    Trim,
    ToUpperCase,
    ToLowerCase,
    ToNumber,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ByteOrder {
    MsbFirst,
    LsbFirst,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NumberFormat {
    Signed,
    Unsigned,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum ByteOperation {
    ByteLength,
    GetByte,
    GetBytes,
    Concat,
    Contains,
    HexToNumber {
        byte_order: ByteOrder,
        number_format: NumberFormat,
    },
    NumberToHex {
        byte_order: ByteOrder,
        number_format: NumberFormat,
    },
    HexToText,
    TextToHex,
}

impl StringOperation {
    pub fn parameters(self) -> &'static [&'static str] {
        match self {
            Self::Substring => &["input", "start_index", "length"],
            Self::Concat => &["input", "append"],
            Self::Contains | Self::IndexOf => &["input", "search"],
            Self::Replace => &["input", "search", "replacement"],
            _ => &["input"],
        }
    }

    pub fn execute(self, args: &BTreeMap<String, Value>) -> Result<Value, String> {
        validate_parameters(self.parameters(), args)?;
        let input = text(args, "input")?;
        let result = match self {
            Self::Length => Value::from(input.chars().count()),
            Self::Substring => {
                let start = index(args, "start_index")?;
                let length = index(args, "length")?;
                let count = input.chars().count();
                checked_range(start, length, count)?;
                Value::String(input.chars().skip(start).take(length).collect())
            }
            Self::Concat => {
                let append = text(args, "append")?;
                check_size(input.len() + append.len())?;
                Value::String(format!("{input}{append}"))
            }
            Self::Contains => Value::Bool(input.contains(search_text(args)?)),
            Self::IndexOf => {
                let search = search_text(args)?;
                match input.find(search) {
                    Some(offset) => Value::from(input[..offset].chars().count()),
                    None => Value::from(-1),
                }
            }
            Self::Replace => {
                let search = search_text(args)?;
                let replacement = text(args, "replacement")?;
                let occurrences = input.matches(search).count();
                let retained = input.len() - occurrences * search.len();
                let added = occurrences
                    .checked_mul(replacement.len())
                    .and_then(|size| size.checked_add(retained))
                    .ok_or_else(|| "Process output exceeds 1 MiB".to_owned())?;
                check_size(added)?;
                Value::String(input.replace(search, replacement))
            }
            Self::Trim => Value::String(input.trim().to_owned()),
            Self::ToUpperCase => Value::String(input.to_uppercase()),
            Self::ToLowerCase => Value::String(input.to_lowercase()),
            Self::ToNumber => {
                let input = input.trim();
                let number = if let Ok(value) = input.parse::<i64>() {
                    Number::from(value)
                } else if let Ok(value) = input.parse::<u64>() {
                    Number::from(value)
                } else {
                    let value = input
                        .parse::<f64>()
                        .map_err(|_| "input is not a valid number".to_owned())?;
                    // A nonzero significand that rounds to zero is out of range.
                    if value == 0.0
                        && input
                            .bytes()
                            .take_while(|byte| !matches!(*byte, b'e' | b'E'))
                            .any(|byte| matches!(byte, b'1'..=b'9'))
                    {
                        return Err("nonzero input underflows the JSON number range".to_owned());
                    }
                    // Use integer JSON results where conversion is exact and safe.
                    if value.is_finite()
                        && value.fract() == 0.0
                        && value.abs() <= 9_007_199_254_740_991.0
                    {
                        Number::from(value as i64)
                    } else {
                        Number::from_f64(value)
                            .ok_or_else(|| "input is not a finite JSON number".to_owned())?
                    }
                };
                Value::Number(number)
            }
        };
        check_result(result)
    }
}

impl ByteOperation {
    pub fn parameters(self) -> &'static [&'static str] {
        match self {
            Self::GetByte => &["input", "byte_index"],
            Self::GetBytes | Self::HexToNumber { .. } => &["input", "start_index", "byte_count"],
            Self::Concat => &["input", "append"],
            Self::Contains => &["input", "search"],
            Self::NumberToHex { .. } => &["input", "byte_count"],
            _ => &["input"],
        }
    }

    pub fn execute(self, args: &BTreeMap<String, Value>) -> Result<Value, String> {
        validate_parameters(self.parameters(), args)?;
        let result = match self {
            Self::NumberToHex {
                byte_order,
                number_format,
            } => {
                let count = numeric_byte_count(args)?;
                let number = args["input"]
                    .as_f64()
                    .ok_or_else(|| "input must be a number".to_owned())?;
                let bits = count * 8;
                let (min, max) = match number_format {
                    NumberFormat::Unsigned => (0, (1_i64 << bits) - 1),
                    NumberFormat::Signed => (-(1_i64 << (bits - 1)), (1_i64 << (bits - 1)) - 1),
                };
                if !number.is_finite()
                    || number.fract() != 0.0
                    || !(min as f64..=max as f64).contains(&number)
                {
                    return Err(
                        "input must be an integer within the selected byte range".to_owned()
                    );
                }
                let raw = (number as i64).to_be_bytes();
                let mut bytes = raw[raw.len() - count..].to_vec();
                if byte_order == ByteOrder::LsbFirst {
                    bytes.reverse();
                }
                Value::String(encode_hex(&bytes)?)
            }
            Self::TextToHex => Value::String(encode_hex(text(args, "input")?.as_bytes())?),
            operation => {
                let bytes = decode_hex(text(args, "input")?)?;
                match operation {
                    Self::ByteLength => Value::from(bytes.len()),
                    Self::GetByte => {
                        let position = index(args, "byte_index")?;
                        Value::from(
                            *bytes
                                .get(position)
                                .ok_or_else(|| "byte_index is out of range".to_owned())?,
                        )
                    }
                    Self::GetBytes => {
                        let start = index(args, "start_index")?;
                        let count = index(args, "byte_count")?;
                        let range = checked_range(start, count, bytes.len())?;
                        Value::String(encode_hex(&bytes[range])?)
                    }
                    Self::Concat => {
                        let append = decode_hex(text(args, "append")?)?;
                        check_size((bytes.len() + append.len()) * 2)?;
                        let mut result = bytes;
                        result.extend(append);
                        Value::String(encode_hex(&result)?)
                    }
                    Self::Contains => {
                        let search = decode_hex(text(args, "search")?)?;
                        if search.is_empty() {
                            return Err("search must not be empty".to_owned());
                        }
                        Value::Bool(
                            bytes
                                .windows(search.len())
                                .any(|part| part == search.as_slice()),
                        )
                    }
                    Self::HexToNumber {
                        byte_order,
                        number_format,
                    } => {
                        let start = index(args, "start_index")?;
                        let count = numeric_byte_count(args)?;
                        let range = checked_range(start, count, bytes.len())?;
                        let selected = &bytes[range];
                        let combine = |value, &byte| (value << 8) | i64::from(byte);
                        let mut value = match byte_order {
                            ByteOrder::MsbFirst => selected.iter().fold(0_i64, combine),
                            ByteOrder::LsbFirst => selected.iter().rev().fold(0_i64, combine),
                        };
                        let bits = count * 8;
                        if number_format == NumberFormat::Signed && value >= (1_i64 << (bits - 1)) {
                            value -= 1_i64 << bits;
                        }
                        Value::from(value)
                    }
                    Self::HexToText => match String::from_utf8(bytes) {
                        Ok(value) => Value::String(value),
                        Err(_) => Value::Null,
                    },
                    Self::NumberToHex { .. } | Self::TextToHex => unreachable!(),
                }
            }
        };
        check_result(result)
    }
}

pub(crate) fn validate_parameters<T>(
    required: &[&str],
    args: &BTreeMap<String, T>,
) -> Result<(), String> {
    for &name in required {
        if !args.contains_key(name) {
            return Err(format!("missing Process parameter {name}"));
        }
    }
    for name in args.keys() {
        if !required.contains(&name.as_str()) {
            return Err(format!("unexpected Process parameter {name}"));
        }
    }
    Ok(())
}

fn check_size(size: usize) -> Result<(), String> {
    if size > MAX_PROCESS_STRING_BYTES {
        Err("Process string exceeds 1 MiB (1,048,576 UTF-8 bytes)".to_owned())
    } else {
        Ok(())
    }
}

fn check_result(value: Value) -> Result<Value, String> {
    if let Some(text) = value.as_str() {
        check_size(text.len())?;
    }
    Ok(value)
}

fn text<'a>(args: &'a BTreeMap<String, Value>, name: &str) -> Result<&'a str, String> {
    let text = args[name]
        .as_str()
        .ok_or_else(|| format!("{name} must be a string"))?;
    check_size(text.len())?;
    Ok(text)
}

fn search_text(args: &BTreeMap<String, Value>) -> Result<&str, String> {
    let search = text(args, "search")?;
    if search.is_empty() {
        Err("search must not be empty".to_owned())
    } else {
        Ok(search)
    }
}

fn index(args: &BTreeMap<String, Value>, name: &str) -> Result<usize, String> {
    let number = args[name]
        .as_f64()
        .ok_or_else(|| format!("{name} must be a non-negative integer"))?;
    // Every valid index is bounded by the maximum input size. Accept integral
    // JSON floats as well as integers, including values from a For loop.
    if !number.is_finite()
        || number.fract() != 0.0
        || !(0.0..=MAX_PROCESS_STRING_BYTES as f64).contains(&number)
    {
        return Err(format!("{name} must be a non-negative integer in range"));
    }
    Ok(number as usize)
}

fn checked_range(start: usize, count: usize, len: usize) -> Result<std::ops::Range<usize>, String> {
    match start.checked_add(count) {
        Some(end) if end <= len => Ok(start..end),
        _ => Err("requested range is out of bounds".to_owned()),
    }
}

fn numeric_byte_count(args: &BTreeMap<String, Value>) -> Result<usize, String> {
    let count = index(args, "byte_count")?;
    if (1..=4).contains(&count) {
        Ok(count)
    } else {
        Err("numeric byte_count must be 1 to 4".to_owned())
    }
}

fn decode_hex(input: &str) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::with_capacity(input.len() / 2);
    let mut high = None;
    for c in input.chars() {
        if c.is_whitespace() && high.is_none() {
            continue;
        }
        let digit = c
            .to_digit(16)
            .ok_or_else(|| "invalid Hex String (expected complete byte pairs)".to_owned())?
            as u8;
        if let Some(first) = high.take() {
            bytes.push((first << 4) | digit);
        } else {
            high = Some(digit);
        }
    }
    if high.is_some() {
        return Err("invalid Hex String (expected complete byte pairs)".to_owned());
    }
    Ok(bytes)
}

fn encode_hex(bytes: &[u8]) -> Result<String, String> {
    check_size(bytes.len() * 2)?;
    const DIGITS: &[u8; 16] = b"0123456789ABCDEF";
    let mut result = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        result.push(char::from(DIGITS[(byte >> 4) as usize]));
        result.push(char::from(DIGITS[(byte & 15) as usize]));
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn args(value: Value) -> BTreeMap<String, Value> {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn string_operations() {
        use StringOperation::*;
        for (operation, input, expected) in [
            (Length, json!({"input":"A測😀"}), json!(3)),
            (
                Substring,
                json!({"input":"A測😀","start_index":1,"length":2}),
                json!("測😀"),
            ),
            (
                Substring,
                json!({"input":"A","start_index":1,"length":0}),
                json!(""),
            ),
            (Concat, json!({"input":"AB","append":"CD"}), json!("ABCD")),
            (Concat, json!({"input":"AB","append":""}), json!("AB")),
            (
                Contains,
                json!({"input":"PASS","search":"PASS"}),
                json!(true),
            ),
            (
                Contains,
                json!({"input":"PASS","search":"pass"}),
                json!(false),
            ),
            (IndexOf, json!({"input":"測😀A😀A","search":"😀"}), json!(1)),
            (IndexOf, json!({"input":"ABC","search":"Z"}), json!(-1)),
            (
                Replace,
                json!({"input":"ABAB","search":"AB","replacement":"CD"}),
                json!("CDCD"),
            ),
            (Trim, json!({"input":" \tABC\n "}), json!("ABC")),
            (ToUpperCase, json!({"input":"abc"}), json!("ABC")),
            (ToLowerCase, json!({"input":"ABC"}), json!("abc")),
            (ToNumber, json!({"input":" -1.25e2 "}), json!(-125)),
            (ToNumber, json!({"input":"+3.305"}), json!(3.305)),
            (ToNumber, json!({"input":"0e-400"}), json!(0)),
            (ToNumber, json!({"input":"-0.00E-999"}), json!(0)),
            (ToNumber, json!({"input":"5e-324"}), json!(5e-324)),
            (ToNumber, json!({"input":"-5e-324"}), json!(-5e-324)),
        ] {
            assert_eq!(operation.execute(&args(input)).unwrap(), expected);
        }
        for (operation, input) in [
            (Length, json!({"input":12})),
            (Substring, json!({"input":"A","start_index":0,"length":2})),
            (Substring, json!({"input":"A","start_index":0.5,"length":0})),
            (Contains, json!({"input":"A","search":""})),
            (IndexOf, json!({"input":"A","search":""})),
            (Replace, json!({"input":"A","search":"","replacement":"B"})),
            (ToNumber, json!({"input":"NaN"})),
            (ToNumber, json!({"input":"Infinity"})),
            (ToNumber, json!({"input":"1e400"})),
            (ToNumber, json!({"input":"-1e400"})),
            (ToNumber, json!({"input":"1e-400"})),
            (ToNumber, json!({"input":"-1e-400"})),
            (ToNumber, json!({"input":".01E-999"})),
            (ToNumber, json!({"input":"abc"})),
        ] {
            assert!(operation.execute(&args(input)).is_err());
        }
    }

    #[test]
    fn byte_operations() {
        use ByteOperation::*;
        for (operation, input, expected) in [
            (ByteLength, json!({"input":"aa 01\n02 FF"}), json!(4)),
            (
                GetByte,
                json!({"input":"AA0102FF","byte_index":0.0}),
                json!(170),
            ),
            (
                GetBytes,
                json!({"input":"AA0102FF","start_index":1,"byte_count":2}),
                json!("0102"),
            ),
            (
                Concat,
                json!({"input":"aa 01","append":"02ff"}),
                json!("AA0102FF"),
            ),
            (
                Contains,
                json!({"input":"AA0102FF","search":"0102"}),
                json!(true),
            ),
            (
                Contains,
                json!({"input":"ABCD","search":"BC"}),
                json!(false),
            ),
            (HexToText, json!({"input":"4F4B"}), json!("OK")),
            (HexToText, json!({"input":"FF"}), Value::Null),
            (TextToHex, json!({"input":"OK"}), json!("4F4B")),
        ] {
            assert_eq!(operation.execute(&args(input)).unwrap(), expected);
        }
        for (operation, input) in [
            (ByteLength, json!({"input":"A"})),
            (ByteLength, json!({"input":"A A"})),
            (ByteLength, json!({"input":"XY"})),
            (GetByte, json!({"input":"AA","byte_index":1})),
            (GetByte, json!({"input":"AA","byte_index":-1})),
            (
                GetBytes,
                json!({"input":"AA","start_index":0,"byte_count":2}),
            ),
            (Contains, json!({"input":"AA","search":" "})),
        ] {
            assert!(operation.execute(&args(input)).is_err());
        }
    }

    #[test]
    fn integer_conversions() {
        for count in 1..=4 {
            let bits = count * 8;
            for order in [ByteOrder::MsbFirst, ByteOrder::LsbFirst] {
                for format in [NumberFormat::Signed, NumberFormat::Unsigned] {
                    let (min, max) = match format {
                        NumberFormat::Signed => (-(1_i64 << (bits - 1)), (1_i64 << (bits - 1)) - 1),
                        NumberFormat::Unsigned => (0, (1_i64 << bits) - 1),
                    };
                    let encode = ByteOperation::NumberToHex {
                        byte_order: order,
                        number_format: format,
                    };
                    let decode = ByteOperation::HexToNumber {
                        byte_order: order,
                        number_format: format,
                    };
                    for number in [min, max] {
                        let hex = encode
                            .execute(&args(json!({"input":number,"byte_count":count})))
                            .unwrap();
                        assert_eq!(hex.as_str().unwrap().len(), count * 2);
                        assert_eq!(
                            decode
                                .execute(&args(
                                    json!({"input":hex,"start_index":0,"byte_count":count})
                                ))
                                .unwrap(),
                            json!(number)
                        );
                    }
                    for number in [min - 1, max + 1] {
                        assert!(
                            encode
                                .execute(&args(json!({"input":number,"byte_count":count})))
                                .is_err()
                        );
                    }
                    assert!(
                        encode
                            .execute(&args(json!({"input":1.5,"byte_count":count})))
                            .is_err()
                    );
                }
            }
        }
        for (order, expected) in [(ByteOrder::MsbFirst, 4660), (ByteOrder::LsbFirst, 13330)] {
            let operation = ByteOperation::HexToNumber {
                byte_order: order,
                number_format: NumberFormat::Unsigned,
            };
            assert_eq!(
                operation
                    .execute(&args(
                        json!({"input":"AA1234FF","start_index":1,"byte_count":2})
                    ))
                    .unwrap(),
                json!(expected)
            );
            for count in [0, 5] {
                assert!(
                    operation
                        .execute(&args(
                            json!({"input":"001234567890","start_index":0,"byte_count":count})
                        ))
                        .is_err()
                );
            }
        }
    }

    #[test]
    fn string_limits_apply_to_individual_inputs_and_outputs() {
        let at_limit = "測".repeat(MAX_PROCESS_STRING_BYTES / 3) + "x";
        assert_eq!(at_limit.len(), MAX_PROCESS_STRING_BYTES);
        assert!(
            StringOperation::Length
                .execute(&args(json!({"input":at_limit})))
                .is_ok()
        );
        let over = at_limit.clone() + "x";
        assert!(
            StringOperation::Length
                .execute(&args(json!({"input":over})))
                .is_err()
        );
        assert!(
            StringOperation::Concat
                .execute(&args(json!({"input":at_limit,"append":"x"})))
                .is_err()
        );
        assert!(
            StringOperation::Replace
                .execute(&args(
                    json!({"input":"A".repeat(1024),"search":"A","replacement":"B".repeat(1025)})
                ))
                .is_err()
        );
        let half = "A".repeat(MAX_PROCESS_STRING_BYTES / 2);
        assert_eq!(
            ByteOperation::TextToHex
                .execute(&args(json!({"input":half})))
                .unwrap()
                .as_str()
                .unwrap()
                .len(),
            MAX_PROCESS_STRING_BYTES
        );
        assert!(
            ByteOperation::TextToHex
                .execute(&args(json!({"input":half + "A"})))
                .is_err()
        );
    }
}

#[cfg(test)]
#[test]
fn array_operations_handle_empty_and_invalid_input() {
    use serde_json::json;
    let input = json!([null, {"value":2}, [3]]);
    assert_eq!(
        ArrayOperation::Length.execute(&json!([]), None).unwrap(),
        json!(0)
    );
    assert_eq!(
        ArrayOperation::Length.execute(&input, None).unwrap(),
        json!(3)
    );
    assert_eq!(
        ArrayOperation::GetItem
            .execute(&input, Some(&json!(0)))
            .unwrap(),
        Value::Null
    );
    for index in [json!(-1), json!(1.5), json!(3), json!("0")] {
        assert!(
            ArrayOperation::GetItem
                .execute(&input, Some(&index))
                .is_err()
        );
    }
    assert!(ArrayOperation::Length.execute(&json!({}), None).is_err());
    assert!(
        ArrayOperation::GetItem
            .execute(&json!([]), Some(&json!(0)))
            .is_err()
    );
}
