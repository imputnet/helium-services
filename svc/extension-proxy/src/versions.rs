use omaha_protocol::Version;
use rand::seq::IndexedRandom;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const REFRESH: Duration = Duration::from_secs(3600);
const RETRY: Duration = Duration::from_secs(60);
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);

pub fn user_agent(version: &Version) -> String {
    let version = version.to_string();
    let major = version.split('.').next().unwrap_or_default();
    format!(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{major}.0.0.0 Safari/537.36"
    )
}

struct Timing {
    refresh: Duration,
    retry: Duration,
    timeout: Duration,
}

#[derive(Default)]
struct State {
    versions: Vec<Version>,
    next: Option<Instant>,
}

pub struct ChromeVersions {
    http: reqwest::Client,
    url: String,
    timing: Timing,
    state: Mutex<State>,
    refreshing: Arc<tokio::sync::Mutex<()>>,
}

#[derive(serde::Deserialize)]
struct Release {
    version: String,
}

impl ChromeVersions {
    pub fn new(http: reqwest::Client, url: String) -> Self {
        Self::with_timing(
            http,
            url,
            Timing {
                refresh: REFRESH,
                retry: RETRY,
                timeout: FETCH_TIMEOUT,
            },
        )
    }

    fn with_timing(http: reqwest::Client, url: String, timing: Timing) -> Self {
        ChromeVersions {
            http,
            url,
            timing,
            state: Mutex::default(),
            refreshing: Arc::default(),
        }
    }

    fn status(&self) -> (bool, bool) {
        self.state.lock().map_or((true, false), |state| {
            let due = state.next.is_none_or(|next| Instant::now() >= next);
            (due, !state.versions.is_empty())
        })
    }

    pub async fn pick(self: &Arc<Self>) -> Option<Version> {
        let (due, cached) = self.status();

        if due && cached {
            if let Ok(guard) = self.refreshing.clone().try_lock_owned() {
                let this = self.clone();
                tokio::spawn(async move {
                    this.refresh().await;
                    drop(guard);
                });
            }
        } else if due {
            let _guard = self.refreshing.lock().await;

            if self.status().0 {
                self.refresh().await;
            }
        }

        let state = self.state.lock().ok()?;
        state.versions.choose(&mut rand::rng()).cloned()
    }

    async fn refresh(&self) {
        let fetched = tokio::time::timeout(self.timing.timeout, self.fetch()).await;
        let wait = match fetched {
            Ok(Ok(versions)) if !versions.is_empty() => {
                if let Ok(mut state) = self.state.lock() {
                    state.versions = versions;
                }

                self.timing.refresh
            }
            Ok(Ok(_)) => {
                eprintln!("chrome versions: empty list");
                self.timing.retry
            }
            Ok(Err(e)) => {
                eprintln!("chrome versions: {e}");
                self.timing.retry
            }
            Err(_) => {
                eprintln!("chrome versions: timed out");
                self.timing.retry
            }
        };

        if let Ok(mut state) = self.state.lock() {
            state.next = Some(Instant::now() + wait);
        }
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
    use bytes::Bytes;
    use http_body_util::Full;
    use hyper::service::service_fn;
    use std::convert::Infallible;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::net::TcpListener;

    #[derive(Clone, Copy)]
    enum Reply {
        Fail,
        List,
        Hang,
    }

    async fn server(replies: Vec<Reply>) -> (String, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let count = Arc::new(AtomicUsize::new(0));
        let seen = count.clone();
        let service = service_fn(move |_: http::Request<hyper::body::Incoming>| {
            let n = seen.fetch_add(1, Ordering::SeqCst);
            let reply = replies.get(n).copied().unwrap_or(Reply::List);
            async move {
                let response = match reply {
                    Reply::Fail => http::Response::builder()
                        .status(500)
                        .body(Full::new(Bytes::new()))
                        .unwrap(),
                    Reply::List => http::Response::new(Full::new(Bytes::from_static(
                        br#"[{"version":"150.0.7000.1"}]"#,
                    ))),
                    Reply::Hang => std::future::pending().await,
                };
                Ok::<_, Infallible>(response)
            }
        });
        tokio::spawn(omaha_server::serve(
            listener,
            service,
            omaha_server::ServeOptions::default(),
            std::future::pending(),
        ));
        (url, count)
    }

    fn versions(url: String, refresh: u64, retry: u64, timeout: u64) -> Arc<ChromeVersions> {
        Arc::new(ChromeVersions::with_timing(
            reqwest::Client::new(),
            url,
            Timing {
                refresh: Duration::from_millis(refresh),
                retry: Duration::from_millis(retry),
                timeout: Duration::from_millis(timeout),
            },
        ))
    }

    #[test]
    fn reduces_the_user_agent_to_the_major_version() {
        assert_eq!(
            user_agent(&"150.0.7000.12".parse().unwrap()),
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"
        );
    }

    #[tokio::test]
    async fn retries_a_failed_fetch_soon() {
        let (url, count) = server(vec![Reply::Fail, Reply::List]).await;
        let versions = versions(url, 3_600_000, 50, 1000);

        assert_eq!(versions.pick().await, None);
        assert_eq!(versions.pick().await, None);
        assert_eq!(count.load(Ordering::SeqCst), 1);

        tokio::time::sleep(Duration::from_millis(60)).await;
        assert!(versions.pick().await.is_some());
    }

    #[tokio::test]
    async fn keeps_answering_while_a_refresh_hangs() {
        let (url, _) = server(vec![Reply::List, Reply::Hang]).await;
        let versions = versions(url, 50, 50, 60_000);
        assert!(versions.pick().await.is_some());

        tokio::time::sleep(Duration::from_millis(60)).await;

        for _ in 0..3 {
            let picked = tokio::time::timeout(Duration::from_millis(500), versions.pick()).await;
            assert!(matches!(picked, Ok(Some(_))));
        }
    }

    #[tokio::test]
    async fn gives_up_on_a_stalled_first_fetch() {
        let (url, _) = server(vec![Reply::Hang]).await;
        let versions = versions(url, 3_600_000, 50, 100);
        let picked = tokio::time::timeout(Duration::from_secs(2), versions.pick()).await;
        assert_eq!(picked.ok(), Some(None));
    }
}
