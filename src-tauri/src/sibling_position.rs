//! Native canonical base-62 fractional keys. The midpoint/integer algorithm is
//! the CC0 fractional-indexing algorithm also used by the frontend. The 64-bit
//! FNV-1a / SplitMix64 jitter matches app/src/core/sibling-position.ts.
use crate::{document_model::ReadError, namespace::valid_position};

const DIGITS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
fn invalid() -> ReadError {
    ReadError::new(
        "INVALID_POSITION",
        "Invalid or oversized sibling position bounds",
    )
}
fn integer_len(key: &[u8]) -> usize {
    if key[0] >= b'a' {
        (key[0] - b'a') as usize + 2
    } else {
        (b'Z' - key[0]) as usize + 2
    }
}
fn digit(value: u8) -> usize {
    DIGITS.iter().position(|d| *d == value).unwrap()
}

fn step(integer: &str, up: bool) -> Option<String> {
    let mut bytes = integer.as_bytes().to_vec();
    for i in (1..bytes.len()).rev() {
        let d = digit(bytes[i]);
        if (up && d < 61) || (!up && d > 0) {
            bytes[i] = DIGITS[if up { d + 1 } else { d - 1 }];
            return Some(String::from_utf8(bytes).unwrap());
        }
        bytes[i] = if up { b'0' } else { b'z' };
    }
    if up {
        if bytes[0] == b'z' {
            return None;
        }
        if bytes[0] == b'Z' {
            return Some("a0".into());
        }
        bytes[0] += 1;
        if bytes[0] > b'a' {
            bytes.push(b'0');
        } else {
            bytes.pop();
        }
    } else {
        if bytes[0] == b'A' {
            return None;
        }
        if bytes[0] == b'a' {
            return Some("Zz".into());
        }
        bytes[0] -= 1;
        if bytes[0] < b'Z' {
            bytes.push(b'z');
        } else {
            bytes.pop();
        }
    }
    Some(String::from_utf8(bytes).unwrap())
}

// Iterative rather than recursive: adversarial long common prefixes must not
// consume stack. Inputs already passed canonical key validation.
fn fraction(mut a: &[u8], mut b: Option<&[u8]>) -> String {
    let mut out = Vec::new();
    loop {
        if let Some(upper) = b {
            let mut n = 0;
            while upper
                .get(n)
                .is_some_and(|v| *v == *a.get(n).unwrap_or(&b'0'))
            {
                n += 1;
            }
            out.extend_from_slice(&upper[..n]);
            a = &a[n.min(a.len())..];
            b = Some(&upper[n..]);
        }
        let low = a.first().map_or(0, |v| digit(*v));
        let high = b.map_or(62, |v| digit(v[0]));
        if high - low > 1 {
            out.push(DIGITS[(low + high).div_ceil(2)]);
            break;
        }
        if b.is_some_and(|v| v.len() > 1) {
            out.push(b.unwrap()[0]);
            break;
        }
        out.push(DIGITS[low]);
        a = &a[1.min(a.len())..];
        b = None;
    }
    String::from_utf8(out).unwrap()
}
fn midpoint(lower: Option<&str>, upper: Option<&str>) -> Result<String, ReadError> {
    match (lower, upper) {
        (None, None) => Ok("a0".into()),
        (None, Some(b)) => {
            let integer = &b[..integer_len(b.as_bytes())];
            if integer < b {
                Ok(integer.into())
            } else {
                step(integer, false).ok_or_else(invalid)
            }
        }
        (Some(a), None) => {
            let n = integer_len(a.as_bytes());
            Ok(step(&a[..n], true)
                .unwrap_or_else(|| format!("{}{}", &a[..n], fraction(&a.as_bytes()[n..], None))))
        }
        (Some(a), Some(b)) => {
            let na = integer_len(a.as_bytes());
            let nb = integer_len(b.as_bytes());
            if a[..na] == b[..nb] {
                Ok(format!(
                    "{}{}",
                    &a[..na],
                    fraction(&a.as_bytes()[na..], Some(&b.as_bytes()[nb..]))
                ))
            } else if let Some(next) = step(&a[..na], true).filter(|next| next.as_str() < b) {
                Ok(next)
            } else {
                Ok(format!(
                    "{}{}",
                    &a[..na],
                    fraction(&a.as_bytes()[na..], None)
                ))
            }
        }
    }
}
pub(crate) fn between(
    lower: Option<&str>,
    upper: Option<&str>,
    seed: &str,
) -> Result<String, ReadError> {
    if lower
        .into_iter()
        .chain(upper)
        .any(|s| !valid_position(s) || s.len() > 1024)
        || lower.zip(upper).is_some_and(|(a, b)| a >= b)
    {
        return Err(invalid());
    }
    let mut low = lower.map(str::to_owned);
    let mut high = upper.map(str::to_owned);
    let mut mid = midpoint(low.as_deref(), high.as_deref())?;
    let state = seed.bytes().fold(0xcbf29ce484222325u64, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
    });
    let mut bits = state.wrapping_add(0x9e3779b97f4a7c15);
    bits = (bits ^ (bits >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    bits = (bits ^ (bits >> 27)).wrapping_mul(0x94d049bb133111eb);
    bits ^= bits >> 31;
    for _ in 0..64 {
        if bits & 1 == 1 {
            low = Some(mid);
        } else {
            high = Some(mid);
        }
        bits >>= 1;
        mid = midpoint(low.as_deref(), high.as_deref())?;
    }
    if !valid_position(&mid)
        || mid.len() > 1024
        || lower.is_some_and(|a| a >= mid.as_str())
        || upper.is_some_and(|b| b <= mid.as_str())
    {
        return Err(invalid());
    }
    Ok(mid)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canonical_bounds_and_repeated_insertions() {
        // Golden values generated by the frontend's actual 64-bit jitter implementation.
        for (a, b, expected) in [
            (None, None, "a2KiusyIUx1dG"),
            (None, Some("a0"), "ZznakEzq9zl6W"),
            (Some("Zz"), Some("a0"), "ZzuIscUvZzt3GV"),
            (Some("a0"), Some("a1"), "a0uIscUvZzt3GV"),
            (Some("a0V"), Some("a0W"), "a0VuIscUvZzt3GV"),
            (Some("az"), Some("b00"), "azuIscUvZzt3GV"),
        ] {
            let value = between(a, b, "日本語").unwrap();
            assert!(valid_position(&value));
            assert!(a.is_none_or(|a| a < value.as_str()));
            assert!(b.is_none_or(|b| b > value.as_str()));
            assert_eq!(value, between(a, b, "日本語").unwrap());
            assert_eq!(value, expected);
        }
        let mut low = None;
        for i in 0..1000 {
            let next = between(low.as_deref(), None, &i.to_string()).unwrap();
            assert!(next.len() < 64);
            low = Some(next);
        }
        assert!(between(Some("a0"), Some("a0"), "x").is_err());
        assert!(between(Some("invalid"), None, "x").is_err());
    }
}
