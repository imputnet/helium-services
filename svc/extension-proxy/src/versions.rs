use omaha_protocol::Version;
use rand::seq::IndexedRandom;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

const REFRESH: Duration = Duration::from_secs(3600);

pub fn user_agent(version: &Version) -> String {
    let version = version.to_string();
    let major = version.split('.').next().unwrap_or_default();
    format!(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{major}.0.0.0 Safari/537.36"
    )
}

pub struct ChromeVersions {
    http: reqwest::Client,
    url: String,
    cache: Mutex<Cache>,
}

#[derive(Default)]
struct Cache {
    fetched: Option<Instant>,
    versions: Vec<Version>,
}

#[derive(serde::Deserialize)]
struct Release {
    version: String,
}

impl ChromeVersions {
    pub fn new(http: reqwest::Client, url: String) -> Self {
        ChromeVersions {
            http,
            url,
            cache: Mutex::new(Cache::default()),
        }
    }

    pub async fn pick(&self) -> Option<Version> {
        let mut cache = self.cache.lock().await;

        if cache.fetched.is_none_or(|at| at.elapsed() > REFRESH) {
            match self.fetch().await {
                Ok(versions) if !versions.is_empty() => cache.versions = versions,
                Ok(_) => eprintln!("chrome versions: empty list"),
                Err(e) => eprintln!("chrome versions: {e}"),
            }
            cache.fetched = Some(Instant::now());
        }

        cache.versions.choose(&mut rand::rng()).cloned()
    }

    async fn fetch(&self) -> Result<Vec<Version>, Box<dyn std::error::Error + Send + Sync>> {
        let body = self
            .http
            .get(&self.url)
            .send()
            .await?
            .error_for_status()?
            .bytes()
            .await?;
        let releases: Vec<Release> = serde_json::from_slice(&body)?;
        Ok(releases
            .into_iter()
            .filter_map(|r| r.version.parse().ok())
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reduces_the_user_agent_to_the_major_version() {
        assert_eq!(
            user_agent(&"150.0.7000.12".parse().unwrap()),
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"
        );
    }
}
