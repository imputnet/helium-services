use crate::passthrough::BoxError;
use crate::versions::{ChromeVersions, user_agent};
use omaha_protocol::v4::{self, RequestIds};
use omaha_protocol::{App, AppResponse, Client, Hardware, Platform, Protocol, Request, Version};
use rand::Rng;
use rand::seq::IndexedRandom;
use std::sync::Arc;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Service {
    WebStore,
    Components,
}

pub struct Upstream {
    http: reqwest::Client,
    url: String,
    service: Service,
    cup: Option<cup2::Client>,
    versions: Arc<ChromeVersions>,
}

fn uuid() -> String {
    let mut b: [u8; 16] = rand::rng().random();
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{{{}-{}-{}-{}-{}}}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}

impl Upstream {
    pub fn new(
        http: reqwest::Client,
        url: String,
        service: Service,
        cup: Option<cup2::Client>,
        versions: Arc<ChromeVersions>,
    ) -> Self {
        Upstream {
            http,
            url,
            service,
            cup,
            versions,
        }
    }

    fn request(&self, apps: &[App], chrome: &Version) -> Request {
        let hw = Hardware {
            sse: Some(false),
            sse2: Some(false),
            sse3: Some(false),
            sse41: Some(false),
            sse42: Some(false),
            ssse3: Some(false),
            avx: Some(false),
            physmemory: [4, 8, 16].choose(&mut rand::rng()).copied(),
        };
        let client = Client {
            updater: Some("chrome".into()),
            prodversion: Some(chrome.clone()),
            updaterversion: Some(chrome.clone()),
            os: Some("win".into()),
            arch: Some("x86_64".into()),
            platform: Some(Platform {
                platform: Some("Windows".into()),
                version: Some("10.0.26100.3476".into()),
                arch: Some("x86_64".into()),
                ..Platform::default()
            }),
            acceptformat: vec!["crx3".into(), "download".into(), "run".into()],
            ismachine: false,
            domainjoined: Some(false),
            hw: Some(hw),
            ..Client::default()
        };
        let apps = apps
            .iter()
            .map(|a| {
                let mut app = App::new(a.appid.clone());
                app.version = a.version.clone().or_else(|| "0.0.0.0".parse().ok());
                app.enabled = Some(true);
                app.installsource = Some("ondemand".into());
                app.lang = Some(String::new());
                app.updatecheck = Some(a.updatecheck.clone().unwrap_or_default());
                app
            })
            .collect();
        Request {
            protocol: Protocol::V4,
            client,
            apps,
        }
    }

    pub async fn check(&self, apps: &[App]) -> Result<Vec<AppResponse>, BoxError> {
        let chrome = self.versions.pick().await.ok_or("no chrome version")?;
        let ids = RequestIds {
            session_id: uuid(),
            request_id: uuid(),
        };
        let body = v4::encode_request(&self.request(apps, &chrome), Some(&ids))?;
        let cup = match &self.cup {
            Some(client) => Some(client.prepare(&body)?),
            None => None,
        };
        let url = match &cup {
            Some(request) => format!("{}?{}", self.url, request.query()),
            None => self.url.clone(),
        };
        let appids: Vec<&str> = apps.iter().map(|a| a.appid.as_str()).collect();
        let interactivity = match self.service {
            Service::WebStore => "bg",
            Service::Components => "fg",
        };
        let response = self
            .http
            .post(url)
            .header(http::header::USER_AGENT, user_agent(&chrome))
            .header(http::header::CONTENT_TYPE, "application/json")
            .header("priority", "u=4, i")
            .header("sec-fetch-dest", "empty")
            .header("sec-fetch-mode", "no-cors")
            .header("sec-fetch-site", "none")
            .header("x-goog-update-appid", appids.join(","))
            .header("x-goog-update-interactivity", interactivity)
            .header("x-goog-update-updater", format!("chrome-{chrome}"))
            .body(body)
            .send()
            .await?
            .error_for_status()?;

        let proof = ["x-cup-server-proof", "etag"]
            .iter()
            .filter_map(|name| response.headers().get(*name))
            .find_map(|value| value.to_str().ok())
            .map(str::to_owned);
        let body = response.bytes().await?;

        if let (Some(client), Some(request)) = (&self.cup, &cup) {
            client.verify(request, &body, &proof.ok_or("no cup proof")?)?;
        }

        Ok(v4::decode_response(&body)?.response.apps)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn makes_v4_uuids() {
        let id = uuid();
        assert_eq!(id.len(), 38);
        assert!(id.starts_with('{') && id.ends_with('}'));
        assert_eq!(&id[15..16], "4");
        assert_ne!(uuid(), id);
    }
}
