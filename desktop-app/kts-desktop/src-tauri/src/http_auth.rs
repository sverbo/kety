//! Shared bearer-token checks for the app's local HTTP listeners.
//!
//! Both local listeners — the MCP API (`mcp_api`) and the Google Meet bridge
//! (`meet_bridge`) — guard every route with `Authorization: Bearer <token>`.
//! The comparison lives here so there is exactly one implementation, and so the
//! decision logic can be unit-tested without building a `tiny_http::Request`.
//!
//! Loopback is not a security boundary: every process running as the user can
//! reach 127.0.0.1, and so can any web page the user opens, because the browser
//! runs on the same machine. The token is what actually keeps them out.

/// Compares two byte strings without an early exit on the first difference.
///
/// A plain `==` on a secret returns as soon as two bytes differ, so the time it
/// takes reveals how long a common prefix the guess had — an attacker can
/// recover the token one byte at a time. This always inspects every byte of the
/// two (equal-length) inputs. Length itself is not hidden, which is fine: the
/// token length is a fixed, public property of the format, not a secret.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Checks an `Authorization` header value against the expected token.
///
/// Accepts `Bearer <token>`, case-insensitively on the scheme, tolerating
/// surrounding whitespace. Anything else — no header, a different scheme, a
/// wrong token — is a miss.
pub fn bearer_value_matches(header: Option<&str>, expected: &str) -> bool {
    let Some(header) = header else {
        return false;
    };
    let header = header.trim();
    let Some((scheme, token)) = header.split_once(' ') else {
        return false;
    };
    if !scheme.eq_ignore_ascii_case("Bearer") {
        return false;
    }
    constant_time_eq(token.trim().as_bytes(), expected.trim().as_bytes())
}

/// Reads a header value out of a `tiny_http` request, case-insensitively.
pub fn header_value<'a>(req: &'a tiny_http::Request, name: &str) -> Option<&'a str> {
    // `HeaderField::equiv` wants a `&'static str`; comparing the field name
    // directly keeps this usable with a borrowed name.
    req.headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str())
}

/// Checks the `Authorization` header of a request against the expected token.
pub fn bearer_matches(req: &tiny_http::Request, expected: &str) -> bool {
    bearer_value_matches(header_value(req, "Authorization"), expected)
}

/// Why a request to a local listener was turned away, or that it may proceed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthOutcome {
    /// Credentials are good and no browser origin was presented.
    Allowed,
    /// An `Origin` header was present. Only a browser sends one, and no MCP
    /// client is a browser, so this is a web page probing the loopback port.
    OriginRejected,
    /// No token, a malformed header, or the wrong token.
    Unauthorized,
    /// The app has no token yet, so nothing can be let through.
    NotConfigured,
}

/// Decides whether a local-listener request may proceed.
///
/// `origin` is the request's `Origin` header, `authorization` its
/// `Authorization` header, and `expected` the token the app currently accepts
/// (`None` when none has been generated yet).
///
/// Origin is checked first: a page that gets `403` learns only that something
/// is listening, which it could already tell from the connection succeeding.
pub fn check_request_auth(
    origin: Option<&str>,
    authorization: Option<&str>,
    expected: Option<&str>,
) -> AuthOutcome {
    if origin.map(|o| !o.trim().is_empty()).unwrap_or(false) {
        return AuthOutcome::OriginRejected;
    }
    let Some(expected) = expected else {
        return AuthOutcome::NotConfigured;
    };
    if bearer_value_matches(authorization, expected) {
        AuthOutcome::Allowed
    } else {
        AuthOutcome::Unauthorized
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "0f8b2c1e-4a6d-4c9b-9f3a-7d21e5b06c44";

    #[test]
    fn constant_time_eq_matches_identical_bytes() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(constant_time_eq(b"", b""));
    }

    #[test]
    fn constant_time_eq_rejects_different_bytes_and_lengths() {
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
        assert!(!constant_time_eq(b"", b"a"));
        // Differs only in the last byte: a short-circuiting compare would still
        // say false, but would take measurably longer to do so.
        assert!(!constant_time_eq(TOKEN.as_bytes(), b"0f8b2c1e-4a6d-4c9b-9f3a-7d21e5b06c45"));
    }

    #[test]
    fn bearer_value_accepts_the_right_token() {
        assert!(bearer_value_matches(Some(&format!("Bearer {TOKEN}")), TOKEN));
        assert!(bearer_value_matches(Some(&format!("  Bearer {TOKEN}  ")), TOKEN));
        assert!(bearer_value_matches(Some(&format!("bearer {TOKEN}")), TOKEN));
    }

    #[test]
    fn bearer_value_rejects_missing_wrong_and_malformed() {
        assert!(!bearer_value_matches(None, TOKEN));
        assert!(!bearer_value_matches(Some(""), TOKEN));
        assert!(!bearer_value_matches(Some("Bearer wrong-token"), TOKEN));
        assert!(!bearer_value_matches(Some(TOKEN), TOKEN)); // no scheme
        assert!(!bearer_value_matches(Some(&format!("Basic {TOKEN}")), TOKEN));
        assert!(!bearer_value_matches(Some("Bearer"), TOKEN));
    }

    #[test]
    fn request_without_a_token_is_unauthorized() {
        assert_eq!(
            check_request_auth(None, None, Some(TOKEN)),
            AuthOutcome::Unauthorized
        );
    }

    #[test]
    fn request_with_the_wrong_token_is_unauthorized() {
        assert_eq!(
            check_request_auth(None, Some("Bearer not-the-token"), Some(TOKEN)),
            AuthOutcome::Unauthorized
        );
    }

    #[test]
    fn request_with_the_right_token_is_allowed() {
        assert_eq!(
            check_request_auth(None, Some(&format!("Bearer {TOKEN}")), Some(TOKEN)),
            AuthOutcome::Allowed
        );
    }

    #[test]
    fn request_carrying_an_origin_is_rejected_even_with_a_valid_token() {
        assert_eq!(
            check_request_auth(
                Some("https://evil.example"),
                Some(&format!("Bearer {TOKEN}")),
                Some(TOKEN)
            ),
            AuthOutcome::OriginRejected
        );
        // "null" is what a sandboxed iframe or a file:// page sends.
        assert_eq!(
            check_request_auth(Some("null"), Some(&format!("Bearer {TOKEN}")), Some(TOKEN)),
            AuthOutcome::OriginRejected
        );
    }

    #[test]
    fn an_empty_origin_header_is_not_treated_as_a_browser() {
        assert_eq!(
            check_request_auth(Some("  "), Some(&format!("Bearer {TOKEN}")), Some(TOKEN)),
            AuthOutcome::Allowed
        );
    }

    #[test]
    fn no_token_configured_lets_nothing_through() {
        assert_eq!(
            check_request_auth(None, Some(&format!("Bearer {TOKEN}")), None),
            AuthOutcome::NotConfigured
        );
    }
}
