use aws_lc_rs::hmac;
use base64::Engine;
use base64::alphabet;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use serde::Serialize;
use url::Url;

const LIFETIME_MS: u64 = 3600 * 1000;
const MIN_SECRET_LEN: usize = 32;

const BASE64URL: GeneralPurpose = GeneralPurpose::new(
    &alphabet::URL_SAFE,
    GeneralPurposeConfig::new()
        .with_encode_padding(false)
        .with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

pub struct UrlSigner {
    key: hmac::Key,
    proxy: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum UnwrapError {
    Malformed,
    BadSignature,
    Expired,
}

#[derive(Serialize)]
struct Message<'a> {
    url: &'a str,
    expiry: u64,
}

fn message(url: &str, expiry: u64) -> Vec<u8> {
    serde_json::to_vec(&Message { url, expiry }).unwrap_or_default()
}

pub fn is_fetchable(url: &str) -> bool {
    Url::parse(url).is_ok_and(|u| {
        matches!(u.scheme(), "http" | "https")
            && u.username().is_empty()
            && u.password().is_none()
            && u.port().is_none()
    })
}

impl UrlSigner {
    pub fn new(secret: Option<&str>, base: Option<&str>) -> Option<Self> {
        let secret = secret.filter(|s| s.len() >= MIN_SECRET_LEN)?;
        let base = base?;
        let proxy = if base.ends_with('/') {
            format!("{base}proxy")
        } else {
            format!("{base}/proxy")
        };
        Some(UrlSigner {
            key: hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes()),
            proxy,
        })
    }

    pub fn wrap(&self, url: &str, now_ms: u64) -> String {
        let expiry = now_ms + LIFETIME_MS;
        let sig = BASE64URL.encode(hmac::sign(&self.key, &message(url, expiry)));
        let query = form_urlencoded::Serializer::new(String::new())
            .append_pair("url", url)
            .append_pair("sig", &sig)
            .append_pair("exp", &expiry.to_string())
            .finish();
        format!("{}?{query}", self.proxy)
    }

    pub fn unwrap(&self, query: &str, now_ms: u64) -> Result<String, UnwrapError> {
        let mut url = None;
        let mut sig = None;
        let mut exp = None;

        for (key, value) in form_urlencoded::parse(query.as_bytes()) {
            match key.as_ref() {
                "url" => url = Some(value.into_owned()),
                "sig" => sig = Some(value.into_owned()),
                "exp" => exp = Some(value.into_owned()),
                _ => {}
            }
        }

        let (Some(url), Some(sig), Some(exp)) = (url, sig, exp) else {
            return Err(UnwrapError::Malformed);
        };
        let expiry: u64 = exp.parse().map_err(|_| UnwrapError::Malformed)?;

        if !is_fetchable(&url) {
            return Err(UnwrapError::Malformed);
        }

        let sig = BASE64URL
            .decode(sig.as_bytes())
            .map_err(|_| UnwrapError::Malformed)?;
        hmac::verify(&self.key, &message(&url, expiry), &sig)
            .map_err(|_| UnwrapError::BadSignature)?;

        if now_ms > expiry {
            return Err(UnwrapError::Expired);
        }

        Ok(url)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "0123456789abcdef0123456789abcdef-test";
    const URL: &str =
        "https://clients2.googleusercontent.com/crx/blobs/AV8Xwo6/ext_1_2_3.crx?x=1&y=ü";
    const EXPIRY: u64 = 1_800_000_000_000;
    const DENO: &str = "https://services.helium.imput.net/ext/proxy?url=https%3A%2F%2Fclients2.googleusercontent.com%2Fcrx%2Fblobs%2FAV8Xwo6%2Fext_1_2_3.crx%3Fx%3D1%26y%3D%C3%BC&sig=dNy1b4fyG53maFE4pg2K4FBeBvW8BNclYejbTffq2m4&exp=1800000000000";

    fn signer() -> UrlSigner {
        UrlSigner::new(Some(SECRET), Some("https://services.helium.imput.net/ext")).unwrap()
    }

    #[test]
    fn matches_the_deno_version() {
        assert_eq!(signer().wrap(URL, EXPIRY - LIFETIME_MS), DENO);
        let query = DENO.split_once('?').unwrap().1;
        assert_eq!(signer().unwrap(query, EXPIRY - 1).unwrap(), URL);
    }

    #[test]
    fn rejects_bad_links() {
        let s = signer();
        let query = DENO.split_once('?').unwrap().1;
        assert_eq!(s.unwrap(query, EXPIRY + 1), Err(UnwrapError::Expired));
        assert_eq!(
            s.unwrap(&query.replace("exp=1800000000000", "exp=1900000000000"), 0),
            Err(UnwrapError::BadSignature)
        );
        assert_eq!(s.unwrap("url=x", 0), Err(UnwrapError::Malformed));

        let other = UrlSigner::new(Some(&"x".repeat(32)), Some("https://a/")).unwrap();
        assert_eq!(other.unwrap(query, 0), Err(UnwrapError::BadSignature));

        let wrapped = s.wrap("https://user:pw@evil.example/", 0);
        let query = wrapped.split_once('?').unwrap().1;
        assert_eq!(s.unwrap(query, 0), Err(UnwrapError::Malformed));
    }

    #[test]
    fn needs_a_long_secret_and_a_base() {
        assert!(UrlSigner::new(Some("short"), Some("https://a/")).is_none());
        assert!(UrlSigner::new(Some(SECRET), None).is_none());
    }

    #[test]
    fn fetches_only_plain_http_urls() {
        assert!(is_fetchable("https://a.example/x"));
        assert!(is_fetchable("http://a.example:80/x"));
        assert!(!is_fetchable("https://a.example:8443/x"));
        assert!(!is_fetchable("file:///etc/passwd"));
        assert!(!is_fetchable("https://u@a.example/"));
    }
}
