//! the http side: config, routing between update checks and `/files/`,
//! cup signing and refreshing the providers.

use crate::BoxError;
use crate::builds::{BuildConfig, Builds, Shared};
use crate::keys::Keys;
use crate::provider::Provider;
use bytes::Bytes;
use http::StatusCode;
use http_body_util::combinators::UnsyncBoxBody;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::service::service_fn;
use omaha_server::{Endpoint, ServeOptions};
use std::convert::Infallible;
use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use tower::ServiceExt;
use tower_http::services::ServeDir;
use tower_service::Service;

pub type Body = UnsyncBoxBody<Bytes, BoxError>;

const RETRY: Duration = Duration::from_secs(60);

pub struct Config {
    pub dir: PathBuf,
    pub base_url: String,
    pub key: Vec<u8>,
    pub puffin: Option<PathBuf>,
    pub cup_keys: Vec<(u32, Vec<u8>)>,
}

fn var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

fn pem_file(path: &str, label: &str) -> Result<Vec<u8>, BoxError> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
    let (found, der) =
        pem_rfc7468::decode_vec(text.as_bytes()).map_err(|e| format!("{path}: {e}"))?;

    if found != label {
        return Err(format!("{path}: expected {label}, found {found}").into());
    }

    Ok(der)
}

/// The secret every component's signing key is derived from.
pub fn component_key() -> Result<Vec<u8>, BoxError> {
    pem_file(
        &var("COMPONENT_KEY").ok_or("COMPONENT_KEY is required")?,
        "PRIVATE KEY",
    )
}

impl Config {
    pub fn from_env() -> Result<Self, BoxError> {
        let mut base_url = var("BASE_URL").ok_or("BASE_URL is required")?;

        if !base_url.ends_with('/') {
            base_url.push('/');
        }

        let cup_keys = var("CUP_KEYS")
            .map(|keys| {
                keys.split(',')
                    .map(|key| {
                        let (version, path) = key.split_once('=').ok_or_else(|| {
                            format!("CUP_KEYS: expected <version>=<key.pem>, got {key:?}")
                        })?;
                        let version = version
                            .parse()
                            .map_err(|_| format!("CUP_KEYS: invalid version in {key:?}"))?;
                        Ok((version, pem_file(path, "PRIVATE KEY")?))
                    })
                    .collect::<Result<Vec<_>, BoxError>>()
            })
            .transpose()?
            .unwrap_or_default();

        Ok(Config {
            dir: var("DATA_DIR").unwrap_or_else(|| "/data".into()).into(),
            base_url,
            key: component_key()?,
            puffin: var("PUFFIN").map(Into::into),
            cup_keys,
        })
    }
}

fn cup_server(keys: &[(u32, Vec<u8>)]) -> Result<Option<cup2::Server>, BoxError> {
    if keys.is_empty() {
        return Ok(None);
    }

    let mut server = cup2::Server::new();

    for (version, der) in keys {
        server = server.with(cup2::aws_lc::AnySigner::from_pkcs8(*version, der)?);
    }

    Ok(Some(server))
}

fn text(status: StatusCode, body: &'static str) -> http::Response<Body> {
    let mut response = http::Response::new(
        Full::new(Bytes::from_static(body.as_bytes()))
            .map_err(|never| match never {})
            .boxed_unsync(),
    );
    *response.status_mut() = status;
    response
}

pub struct Components {
    http: reqwest::Client,
    keys: Arc<Keys>,
    endpoint: Endpoint,
    files: ServeDir,
    builds: Arc<Builds>,
    providers: Vec<Arc<dyn Provider>>,
}

impl Components {
    pub fn new(config: Config, providers: Vec<Arc<dyn Provider>>) -> Result<Self, BoxError> {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .build()?;
        let files = ServeDir::new(&config.dir);
        let keys = Arc::new(Keys::new(&config.key));
        let builds = Arc::new(Builds::new(
            http.clone(),
            BuildConfig {
                dir: config.dir,
                base: format!("{}files/", config.base_url),
                puffin: config.puffin,
            },
            keys.clone(),
        ));
        let mut endpoint = Endpoint::builder().fallback(Shared(builds.clone()));

        if let Some(cup) = cup_server(&config.cup_keys)? {
            endpoint = endpoint.cup(cup);
        }

        Ok(Components {
            http,
            keys,
            endpoint: endpoint.build(),
            files,
            builds,
            providers,
        })
    }

    async fn refresh_one(&self, provider: &dyn Provider) -> bool {
        match provider.fetch(&self.http, &self.keys).await {
            Ok(specs) => {
                self.builds.set_catalog(provider.name(), specs);
                true
            }
            Err(e) => {
                eprintln!("{}: {e}", provider.name());
                false
            }
        }
    }

    pub async fn refresh(&self) {
        for provider in &self.providers {
            self.refresh_one(provider.as_ref()).await;
        }
    }

    pub async fn start(self: &Arc<Self>) {
        for provider in &self.providers {
            let mut fetched = self.refresh_one(provider.as_ref()).await;
            let this = self.clone();
            let provider = provider.clone();
            tokio::spawn(async move {
                loop {
                    let wait = if fetched { provider.refresh() } else { RETRY };
                    tokio::time::sleep(wait).await;
                    fetched = this.refresh_one(provider.as_ref()).await;
                }
            });
        }
    }

    pub async fn handle(&self, request: http::Request<Incoming>) -> http::Response<Body> {
        let path = request.uri().path();

        if path == "/health" {
            return text(StatusCode::OK, "ok");
        }

        if let Some(rest) = path.strip_prefix("/files/") {
            // only builds and patches, which are named by their hash and never change
            if !rest.ends_with(".crx3") && !rest.ends_with(".puff") {
                return text(StatusCode::NOT_FOUND, "not found");
            }

            let Ok(uri) = format!("/{rest}").parse::<http::Uri>() else {
                return text(StatusCode::BAD_REQUEST, "bad path");
            };
            let (mut parts, body) = request.into_parts();
            parts.uri = uri;

            return match self
                .files
                .clone()
                .oneshot(http::Request::from_parts(parts, body))
                .await
            {
                Ok(mut response) => {
                    if response.status().is_success() {
                        response.headers_mut().insert(
                            http::header::CACHE_CONTROL,
                            http::HeaderValue::from_static("public, max-age=31536000, immutable"),
                        );
                    }

                    response.map(|body| body.map_err(BoxError::from).boxed_unsync())
                }
                Err(never) => match never {},
            };
        }

        let Ok(response) = self.endpoint.clone().call(request).await;
        response.map(|body| body.map_err(|never| match never {}).boxed_unsync())
    }
}

pub async fn serve(
    components: Arc<Components>,
    listener: TcpListener,
    max_connections: usize,
    shutdown: impl Future<Output = ()>,
) {
    let service = service_fn(move |request| {
        let components = components.clone();
        async move { Ok::<_, Infallible>(components.handle(request).await) }
    });
    let options = ServeOptions::default().max_connections(max_connections);
    omaha_server::serve(listener, service, options, shutdown).await;
}
