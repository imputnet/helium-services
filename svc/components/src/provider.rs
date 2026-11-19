//! what a component source has to give: the newest release of each of its
//! components, as the files to pack and where to fetch them.

use crate::BoxError;
use crate::keys::Keys;
use omaha_protocol::{AppId, Version};
use omaha_server::BoxFuture;
use std::time::Duration;

const FETCH_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpecFile {
    pub name: String,
    pub url: String,
    pub size: Option<u64>,
    pub sha256: [u8; 32],
    pub zstd: Option<(u64, [u8; 32])>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Spec {
    pub appid: AppId,
    /// Names the component in logs, and picks its signing key.
    pub label: String,
    pub version: Version,
    pub manifest: Option<serde_json::Value>,
    pub files: Vec<SpecFile>,
}

pub trait Provider: Send + Sync {
    fn name(&self) -> &'static str;

    fn refresh(&self) -> Duration;

    fn fetch<'a>(
        &'a self,
        http: &'a reqwest::Client,
        keys: &'a Keys,
    ) -> BoxFuture<'a, Result<Vec<Spec>, BoxError>>;
}

pub(crate) async fn get(
    http: &reqwest::Client,
    url: &str,
    max: usize,
) -> Result<Vec<u8>, BoxError> {
    let mut response = http
        .get(url)
        .timeout(FETCH_TIMEOUT)
        .send()
        .await?
        .error_for_status()?;
    let mut bytes = Vec::new();

    while let Some(chunk) = response.chunk().await? {
        bytes.extend_from_slice(&chunk);

        if bytes.len() > max {
            return Err(format!("{url}: too large").into());
        }
    }

    Ok(bytes)
}

pub(crate) fn sha256_hex(hex: &str) -> Option<[u8; 32]> {
    if hex.len() != 64 {
        return None;
    }

    let mut out = [0u8; 32];

    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(hex.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }

    Some(out)
}
