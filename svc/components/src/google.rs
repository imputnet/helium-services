//! google's pki metadata and ssl error assistant: the newest crx google
//! offers for each, served as it is once it's signed by its pinned key.

use crate::BoxError;
use crate::keys::Keys;
use crate::provider::{Provider, Spec, SpecFile, get, read};
use crx3::KeyHash;
use omaha_protocol::{
    App, AppId, Client, Outcome, Platform, Protocol, Request, Response, Version, v4,
};
use omaha_server::BoxFuture;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

const UPDATE: &str = "https://update.googleapis.com/service/update2/json";
const CHROMIUM_VERSION: &str =
    "https://raw.githubusercontent.com/imputnet/helium/main/chromium_version.txt";
const MAX_RESPONSE: usize = 1 << 20;

const COMPONENTS: [(&str, KeyHash); 2] = [
    (
        "pki-metadata",
        KeyHash::from_bytes([
            0x45, 0xd8, 0xe9, 0xbd, 0x9d, 0x3c, 0x21, 0x88, 0x44, 0x6a, 0x82, 0x03, 0xde, 0x42,
            0x99, 0x45, 0x66, 0x25, 0xfe, 0xb3, 0xd1, 0xf8, 0x11, 0x65, 0xb4, 0x6f, 0xd3, 0x1b,
            0x21, 0x89, 0xbe, 0x9c,
        ]),
    ),
    (
        "ssl-error-assistant",
        KeyHash::from_bytes([
            0x68, 0x4a, 0x2c, 0xcb, 0xda, 0xb4, 0xdb, 0x0e, 0xcf, 0xfa, 0xf7, 0xad, 0x9c, 0xdd,
            0xfd, 0x47, 0x97, 0xe4, 0x73, 0x24, 0x67, 0x93, 0x9c, 0xb1, 0x14, 0xcd, 0x3f, 0x54,
            0x66, 0x25, 0x99, 0x3f,
        ]),
    ),
];

pub struct Google {
    url: String,
    chromium_version: String,
    components: Vec<(&'static str, KeyHash)>,
    /// The newest release google offered for each component, kept while it
    /// can't answer for one, so that one doesn't hold back the others.
    last: Mutex<HashMap<&'static str, Spec>>,
}

impl Google {
    pub fn new(
        url: String,
        chromium_version: String,
        components: Vec<(&'static str, KeyHash)>,
    ) -> Self {
        Google {
            url,
            chromium_version,
            components,
            last: Mutex::default(),
        }
    }

    async fn latest(&self, http: &reqwest::Client) -> Result<Vec<Spec>, BoxError> {
        let version = get(http, &self.chromium_version, MAX_RESPONSE).await?;
        let version: Version = String::from_utf8(version)?.trim().parse()?;
        let ids = self
            .components
            .iter()
            .map(|(label, key)| {
                let appid = AppId::new(key.id()).ok_or("invalid component key")?;
                Ok((appid, *label, *key))
            })
            .collect::<Result<Vec<_>, BoxError>>()?;
        let request = Request {
            protocol: Protocol::V4,
            client: Client {
                updater: Some("chrome".into()),
                prodversion: Some(version.clone()),
                updaterversion: Some(version),
                os: Some("linux".into()),
                arch: Some("x86_64".into()),
                platform: Some(Platform {
                    platform: Some("Linux".into()),
                    arch: Some("x86_64".into()),
                    ..Platform::default()
                }),
                acceptformat: vec!["crx3".into(), "download".into(), "run".into()],
                ..Client::default()
            },
            apps: ids
                .iter()
                .map(|(appid, _, _)| {
                    let mut app = App::new(appid.clone());
                    app.version = "0.0.0.0".parse().ok();
                    app.updatecheck = Some(Default::default());
                    app
                })
                .collect(),
        };
        let request = http
            .post(&self.url)
            .header(http::header::CONTENT_TYPE, "application/json")
            .body(v4::encode_request(&request, None)?);
        let response = read(request, &self.url, MAX_RESPONSE).await?;
        let response = v4::decode_response(&response)?.response;
        let mut last = self.last.lock().map_err(|_| "poisoned lock")?;

        for (appid, label, key) in ids {
            match release(&response, appid, label, key) {
                Ok(spec) => {
                    last.insert(label, spec);
                }
                Err(e) => eprintln!("google: {label}: {e}"),
            }
        }

        let specs: Vec<Spec> = self
            .components
            .iter()
            .filter_map(|(label, _)| last.get(label).cloned())
            .collect();

        if specs.is_empty() {
            return Err("no update for any component".into());
        }

        Ok(specs)
    }
}

/// The crx google offers for one component in its answer.
fn release(response: &Response, appid: AppId, label: &str, key: KeyHash) -> Result<Spec, BoxError> {
    let Some(Outcome::Update {
        nextversion,
        pipelines,
    }) = response
        .apps
        .iter()
        .find(|a| a.appid == appid)
        .and_then(|a| a.updatecheck.as_ref())
        .map(|u| &u.outcome)
    else {
        return Err("no update".into());
    };
    let (urls, sha256, size) = pipelines
        .iter()
        .find_map(|p| p.full_crx())
        .ok_or("no full crx")?;
    let url = urls
        .iter()
        .find(|u| u.starts_with("https://"))
        .or(urls.first())
        .ok_or("no url")?;

    Ok(Spec {
        appid,
        label: label.into(),
        version: nextversion.clone(),
        manifest: None,
        files: vec![SpecFile {
            name: format!("{label}.crx3"),
            url: url.clone(),
            size: Some(size),
            sha256: *sha256.as_bytes(),
            zstd: None,
        }],
        signed_by: Some(key),
    })
}

impl Default for Google {
    fn default() -> Self {
        Google::new(UPDATE.into(), CHROMIUM_VERSION.into(), COMPONENTS.to_vec())
    }
}

impl Provider for Google {
    fn name(&self) -> &'static str {
        "google"
    }

    fn refresh(&self) -> Duration {
        Duration::from_secs(3600)
    }

    fn fetch<'a>(
        &'a self,
        http: &'a reqwest::Client,
        _keys: &'a Keys,
    ) -> BoxFuture<'a, Result<Vec<Spec>, BoxError>> {
        Box::pin(self.latest(http))
    }
}
