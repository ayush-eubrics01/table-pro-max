//! Secret redaction applied to every error message and log line that may contain
//! connection details.
//!
//! This is a defence-in-depth layer: code should avoid formatting secrets in the first
//! place. Redaction covers the common shapes secrets take in driver output:
//! `scheme://user:password@host` URLs and `password=...`-style key/value pairs.

const MASK: &str = "****";

const SECRET_KEYS: &[&str] = &[
    "password",
    "passwd",
    "pwd",
    "pass",
    "secret",
    "token",
    "api_key",
    "apikey",
    "passphrase",
    "private_key",
    "sslpassword",
];

/// Returns `input` with URL credentials and secret key/value pairs masked.
pub fn redact(input: &str) -> String {
    let s = redact_url_userinfo(input);
    redact_key_values(&s)
}

/// Masks the password part of `scheme://user:password@host` occurrences.
fn redact_url_userinfo(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(idx) = rest.find("://") {
        let (head, tail) = rest.split_at(idx + 3);
        out.push_str(head);
        // The authority ends at the first '/', '?', '#' or whitespace.
        let end = tail.find(|c: char| c == '/' || c == '?' || c == '#' || c.is_whitespace()).unwrap_or(tail.len());
        let authority = &tail[..end];
        match authority.rfind('@') {
            Some(at) => {
                let userinfo = &authority[..at];
                match userinfo.find(':') {
                    Some(colon) => {
                        out.push_str(&userinfo[..colon]);
                        out.push(':');
                        out.push_str(MASK);
                    }
                    None => out.push_str(userinfo),
                }
                out.push_str(&authority[at..]);
            }
            None => out.push_str(authority),
        }
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}

/// Masks values in `key=value`, `key: value` and `"key":"value"` shapes for known secret keys.
fn redact_key_values(input: &str) -> String {
    let lower = input.to_ascii_lowercase();
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    'outer: while i < input.len() {
        for key in SECRET_KEYS {
            if lower[i..].starts_with(key) && is_boundary_before(bytes, i) {
                let mut j = i + key.len();
                // Allow a closing quote after a JSON key.
                if j < bytes.len() && (bytes[j] == b'"' || bytes[j] == b'\'') {
                    j += 1;
                }
                while j < bytes.len() && bytes[j] == b' ' {
                    j += 1;
                }
                if j < bytes.len() && (bytes[j] == b'=' || bytes[j] == b':') {
                    j += 1;
                    while j < bytes.len() && bytes[j] == b' ' {
                        j += 1;
                    }
                    out.push_str(&input[i..j]);
                    let value_end = value_end(bytes, j);
                    let quoted = j < bytes.len() && (bytes[j] == b'"' || bytes[j] == b'\'');
                    if quoted {
                        out.push(bytes[j] as char);
                        out.push_str(MASK);
                        out.push(bytes[j] as char);
                    } else {
                        out.push_str(MASK);
                    }
                    i = value_end;
                    continue 'outer;
                }
            }
        }
        let ch = input[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn is_boundary_before(bytes: &[u8], i: usize) -> bool {
    i == 0 || !(bytes[i - 1].is_ascii_alphanumeric() || bytes[i - 1] == b'_')
}

fn value_end(bytes: &[u8], start: usize) -> usize {
    if start < bytes.len() && (bytes[start] == b'"' || bytes[start] == b'\'') {
        let q = bytes[start];
        let mut k = start + 1;
        while k < bytes.len() {
            if bytes[k] == b'\\' {
                k += 2;
                continue;
            }
            if bytes[k] == q {
                return k + 1;
            }
            k += 1;
        }
        return bytes.len();
    }
    let mut k = start;
    while k < bytes.len() && !bytes[k].is_ascii_whitespace() && bytes[k] != b'&' && bytes[k] != b';' && bytes[k] != b','
    {
        k += 1;
    }
    k
}

#[cfg(test)]
mod tests {
    use super::redact;

    #[test]
    fn masks_url_passwords() {
        assert_eq!(
            redact("connect postgres://alice:s3cr%40t@db.example.com:5432/app?sslmode=require failed"),
            "connect postgres://alice:****@db.example.com:5432/app?sslmode=require failed"
        );
        assert_eq!(redact("mysql://root@localhost/x"), "mysql://root@localhost/x");
        assert_eq!(redact("https://example.com/path"), "https://example.com/path");
    }

    #[test]
    fn masks_password_with_at_sign_in_password() {
        // An unencoded '@' in the password: we split on the last '@' of the authority.
        let r = redact("postgres://u:p@ss@host/db");
        assert!(!r.contains("p@ss"), "{r}");
        assert!(r.contains("@host/db"));
    }

    #[test]
    fn masks_key_value_pairs() {
        assert_eq!(redact("host=x password=hunter2 user=y"), "host=x password=**** user=y");
        assert_eq!(redact("PASSWORD = 'a b c' next"), "PASSWORD = '****' next");
        assert_eq!(redact(r#"{"password":"x\"y","user":"u"}"#), r#"{"password":"****","user":"u"}"#);
        assert_eq!(redact("pwd=abc;uid=sa"), "pwd=****;uid=sa");
        assert_eq!(redact("?sslpassword=zz&x=1"), "?sslpassword=****&x=1");
    }

    #[test]
    fn leaves_innocent_text_alone() {
        let s = "password authentication failed for user \"bob\"";
        assert_eq!(redact(s), s);
        assert_eq!(redact("compass=north"), "compass=north");
        assert_eq!(redact("ünïcødé password"), "ünïcødé password");
    }
}
