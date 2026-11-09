mod components;
mod google_cup;
mod mixins;
mod passthrough;
mod signed;
mod source;
mod upstream;
mod versions;

use http::header::{CACHE_CONTROL, PRAGMA};
use http::{HeaderValue, StatusCode};
use http_body_util::BodyExt;
use hyper::body::Incoming;
use hyper::service::service_fn;
use omaha_server::{Endpoint, ServeOptions};
use passthrough::Body;
use std::convert::Infallible;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use tower_service::Service;
use upstream::Service as UpstreamService;

pub use passthrough::BoxError;

pub struct Config {
    pub upstream_url: String,
    pub upstream_cup: Option<(cup2::KeyId, Vec<u8>)>,
    pub chrome_versions_url: String,
    pub snippet_url: String,
    pub hmac_secret: Option<String>,
    pub proxy_base_url: Option<String>,
}

impl Config {
    pub fn from_env() -> Self {
        Config {
            upstream_url: "https://clients2.google.com/service/update2/json".into(),
            upstream_cup: Some((
                cup2::KeyId::MlDsa44(google_cup::VERSION),
                google_cup::KEY.to_vec(),
            )),
            chrome_versions_url: "https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Windows&num=5&offset=0".into(),
            snippet_url: "https://chromewebstore.googleapis.com/v2/items/{}:fetchItemSnippet".into(),
            hmac_secret: std::env::var("HMAC_SECRET").ok(),
            proxy_base_url: std::env::var("PROXY_BASE_URL").ok(),
        }
    }
}

pub struct Proxy {
    webstore: Endpoint,
    components: Endpoint,
    http: reqwest::Client,
    signer: Option<Arc<signed::UrlSigner>>,
    snippet_url: String,
}

impl Proxy {
    pub fn new(config: Config) -> Result<Self, BoxError> {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .build()?;
        let versions = Arc::new(versions::ChromeVersions::new(
            http.clone(),
            config.chrome_versions_url,
        ));
        let signer = signed::UrlSigner::new(
            config.hmac_secret.as_deref(),
            config.proxy_base_url.as_deref(),
        )
        .map(Arc::new);

        if signer.is_none() {
            eprintln!("HMAC_SECRET (32+ bytes) or PROXY_BASE_URL unset: downloads aren't proxied");
        }

        let upstream = |service| -> Result<_, BoxError> {
            let cup = match &config.upstream_cup {
                Some((key, spki)) => Some(cup2::Client::new(*key, spki)?),
                None => None,
            };
            let upstream = upstream::Upstream::new(
                http.clone(),
                config.upstream_url.clone(),
                service,
                cup,
                versions.clone(),
            );
            Ok(source::UpstreamSource::new(upstream, signer.clone()))
        };

        Ok(Proxy {
            webstore: Endpoint::builder()
                .fallback(upstream(UpstreamService::WebStore)?)
                .build(),
            components: components::endpoint(upstream(UpstreamService::Components)?),
            http,
            signer,
            snippet_url: config.snippet_url,
        })
    }

    async fn update(endpoint: &Endpoint, request: http::Request<Incoming>) -> http::Response<Body> {
        let Ok(response) = endpoint.clone().call(request).await;
        let mut response = response.map(|body| body.map_err(|never| match never {}).boxed());
        let headers = response.headers_mut();
        headers.insert(
            CACHE_CONTROL,
            HeaderValue::from_static("no-cache, no-store, max-age=0, must-revalidate"),
        );
        headers.insert(PRAGMA, HeaderValue::from_static("no-cache"));
        response
    }

    pub async fn handle(&self, request: http::Request<Incoming>) -> http::Response<Body> {
        match request.uri().path() {
            "/" => Self::update(&self.webstore, request).await,
            "/com" => Self::update(&self.components, request).await,
            "/proxy" => {
                let (parts, _) = request.into_parts();
                passthrough::proxy(&self.http, self.signer.as_deref(), &parts).await
            }
            "/cws_snippet" => {
                let (parts, _) = request.into_parts();
                passthrough::snippet(&self.http, &self.snippet_url, &parts).await
            }
            "/health" => http::Response::new(passthrough::full("ok")),
            _ => passthrough::error(StatusCode::NOT_FOUND, "Not Found"),
        }
    }
}

pub async fn serve(
    proxy: Arc<Proxy>,
    listener: TcpListener,
    max_connections: usize,
    shutdown: impl Future<Output = ()>,
) {
    let service = service_fn(move |request| {
        let proxy = proxy.clone();
        async move { Ok::<_, Infallible>(proxy.handle(request).await) }
    });
    let options = ServeOptions::default().max_connections(max_connections);
    omaha_server::serve(listener, service, options, shutdown).await;
}
