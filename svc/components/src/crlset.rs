//! the crlset component, from opencrlset's newest published build.

use crate::BoxError;
use crate::keys::Keys;
use crate::provider::{Provider, Spec, SpecFile, get, sha256_hex};
use omaha_server::BoxFuture;
use serde::Deserialize;
use sha2::Digest;
use std::time::Duration;

const OPENCRLSET: &str = "https://crls.helium.computer/";
const MAX_METADATA: usize = 1 << 20;

#[derive(Deserialize)]
struct Latest {
    sequence: u64,
    path: String,
    sha256sums: String,
}

async fn latest(
    http: &reqwest::Client,
    keys: &Keys,
    base: &str,
    tier: &str,
) -> Result<Spec, BoxError> {
    if tier.is_empty() || !tier.bytes().all(|b| b.is_ascii_lowercase()) {
        return Err(format!("invalid tier {tier:?}").into());
    }

    let latest: Latest =
        serde_json::from_slice(&get(http, &format!("{base}latest.json"), MAX_METADATA).await?)?;

    if latest.path != format!("builds/{}/", latest.sequence) {
        return Err(format!("unexpected build path {:?}", latest.path).into());
    }

    let build = format!("{base}{}", latest.path);
    let sums = get(http, &format!("{build}SHA256SUMS"), MAX_METADATA).await?;

    if Some(<[u8; 32]>::from(sha2::Sha256::digest(&sums))) != sha256_hex(&latest.sha256sums) {
        return Err("SHA256SUMS doesn't match latest.json".into());
    }

    let sums = String::from_utf8(sums)?;
    let file = |name: &str| -> Result<SpecFile, BoxError> {
        let path = format!("crlset/{tier}/{name}");
        let sha256 = sums
            .lines()
            .find_map(|line| {
                let (hash, file) = line.split_once("  ")?;
                (file == path).then(|| sha256_hex(hash))?
            })
            .ok_or_else(|| format!("{path} isn't in SHA256SUMS"))?;
        Ok(SpecFile {
            name: name.into(),
            url: format!("{build}{path}"),
            size: None,
            sha256,
            zstd: None,
        })
    };

    Ok(Spec {
        appid: keys.appid("crlset")?,
        label: "crlset".into(),
        version: latest.sequence.to_string().parse()?,
        manifest: None,
        files: vec![file("crl-set")?, file("manifest.json")?],
    })
}

pub struct CrlSet {
    url: String,
    tier: String,
}

impl CrlSet {
    pub fn new(mut url: String, tier: String) -> Self {
        if !url.ends_with('/') {
            url.push('/');
        }

        CrlSet { url, tier }
    }

    pub fn from_env() -> Option<Self> {
        let url = std::env::var("CRLSET_URL").unwrap_or_else(|_| OPENCRLSET.into());
        let tier = std::env::var("CRLSET_TIER")
            .ok()
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| "standard".into());
        (!url.is_empty()).then(|| CrlSet::new(url, tier))
    }
}

impl Provider for CrlSet {
    fn name(&self) -> &'static str {
        "crlset"
    }

    fn refresh(&self) -> Duration {
        Duration::from_secs(300)
    }

    fn fetch<'a>(
        &'a self,
        http: &'a reqwest::Client,
        keys: &'a Keys,
    ) -> BoxFuture<'a, Result<Vec<Spec>, BoxError>> {
        Box::pin(async move { Ok(vec![latest(http, keys, &self.url, &self.tier).await?]) })
    }
}
