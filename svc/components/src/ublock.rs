//! ublock origin, from imputnet/uBlock's newest github release: the crx its
//! release ci signs, served as it is.

use crate::BoxError;
use crate::keys::Keys;
use crate::provider::{Provider, Spec, SpecFile, get, sha256_hex};
use crx3::KeyHash;
use omaha_protocol::AppId;
use omaha_server::BoxFuture;
use serde::Deserialize;
use std::time::Duration;

const RELEASES: &str = "https://api.github.com/repos/imputnet/uBlock/releases/latest";
const MAX_METADATA: usize = 1 << 20;

/// What imputnet/uBlock's releases are signed with, which gives
/// blockkimnmffmmiiiikgeeoohkcccoob.
const KEY: KeyHash = KeyHash::from_bytes([
    0x1b, 0xe2, 0xaa, 0x8c, 0xdc, 0x55, 0xcc, 0x88, 0x88, 0xa6, 0x44, 0xee, 0x7a, 0x22, 0x2e, 0xe1,
    0xa4, 0x73, 0x6a, 0x25, 0x66, 0xb8, 0x24, 0x0b, 0xfb, 0xcc, 0x20, 0x41, 0xa0, 0x8e, 0x4b, 0x1c,
]);

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
    size: u64,
    digest: Option<String>,
}

async fn latest(http: &reqwest::Client, url: &str, key: KeyHash) -> Result<Spec, BoxError> {
    let release: Release = serde_json::from_slice(&get(http, url, MAX_METADATA).await?)?;
    let name = format!("uBlock0_{}.chromium.crx", release.tag_name);
    let asset = release
        .assets
        .iter()
        .find(|a| a.name == name)
        .ok_or_else(|| format!("release {} has no {name}", release.tag_name))?;
    let sha256 = asset
        .digest
        .as_deref()
        .and_then(|d| d.strip_prefix("sha256:"))
        .and_then(sha256_hex)
        .ok_or_else(|| format!("{name}: no sha256 digest"))?;

    Ok(Spec {
        appid: AppId::new(key.id()).ok_or("invalid ublock key")?,
        label: "ublock".into(),
        version: release.tag_name.parse()?,
        manifest: None,
        files: vec![SpecFile {
            name,
            url: asset.browser_download_url.clone(),
            size: Some(asset.size),
            sha256,
            zstd: None,
        }],
        signed_by: Some(key),
    })
}

pub struct UBlock {
    url: String,
    key: KeyHash,
}

impl UBlock {
    pub fn new(url: String, key: KeyHash) -> Self {
        UBlock { url, key }
    }
}

impl Default for UBlock {
    fn default() -> Self {
        UBlock::new(RELEASES.into(), KEY)
    }
}

impl Provider for UBlock {
    fn name(&self) -> &'static str {
        "ublock"
    }

    fn refresh(&self) -> Duration {
        Duration::from_secs(900)
    }

    fn fetch<'a>(
        &'a self,
        http: &'a reqwest::Client,
        _keys: &'a Keys,
    ) -> BoxFuture<'a, Result<Vec<Spec>, BoxError>> {
        Box::pin(async move { Ok(vec![latest(http, &self.url, self.key).await?]) })
    }
}
