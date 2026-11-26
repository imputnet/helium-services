//! reads the config from the environment and runs the server, or with
//! `keys`, prints each component's id and key hash for the browser to pin.

use components::bergamot::Bergamot;
use components::crlset::CrlSet;
use components::google::Google;
use components::keys::Keys;
use components::ublock::UBlock;
use components::{BoxError, Components, Config, Provider, component_key, serve};
use std::net::SocketAddr;
use std::process::ExitCode;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::signal::unix::{SignalKind, signal};

fn var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

/// Prints each component's id, name and public key hash, for the browser to pin.
async fn print_keys(providers: &[Arc<dyn Provider>]) -> Result<(), BoxError> {
    let keys = Keys::new(&component_key()?);
    let http = reqwest::Client::new();
    let mut lines = Vec::new();

    for provider in providers {
        for spec in provider.fetch(&http, &keys).await? {
            let hash = match spec.signed_by {
                Some(key) => *key.as_bytes(),
                None => keys.hash(&spec.label)?,
            };
            let hash: String = hash.iter().map(|b| format!("{b:02x}")).collect();
            lines.push(format!("{} {} {hash}", spec.appid, spec.label));
        }
    }

    lines.sort_by(|a, b| a.split(' ').nth(1).cmp(&b.split(' ').nth(1)));
    println!("{}", lines.join("\n"));
    Ok(())
}

async fn run() -> Result<(), BoxError> {
    let mut providers: Vec<Arc<dyn Provider>> = Vec::new();

    if let Some(bergamot) = Bergamot::from_env() {
        providers.push(Arc::new(bergamot));
    }

    if let Some(crlset) = CrlSet::from_env() {
        providers.push(Arc::new(crlset));
    }

    providers.push(Arc::new(UBlock::default()));
    providers.push(Arc::new(Google::default()));

    if std::env::args().nth(1).as_deref() == Some("keys") {
        return print_keys(&providers).await;
    }

    let listen = var("LISTEN").unwrap_or_else(|| "0.0.0.0:8000".into());
    let max_connections: usize = match var("MAX_CONNECTIONS") {
        Some(value) => value
            .parse()
            .map_err(|_| format!("MAX_CONNECTIONS: invalid value {value:?}"))?,
        None => 1024,
    };

    if let Some(addr) = var("METRICS_LISTEN") {
        let addr: SocketAddr = addr
            .parse()
            .map_err(|_| format!("METRICS_LISTEN: invalid value {addr:?}"))?;
        metrics_exporter_prometheus::PrometheusBuilder::new()
            .with_http_listener(addr)
            .install()?;
    }

    let mut term = signal(SignalKind::terminate())?;
    let components = Arc::new(Components::new(Config::from_env()?, providers)?);
    components.start().await;
    let listener = TcpListener::bind(&listen).await?;
    eprintln!("listening on {}", listener.local_addr()?);

    let shutdown = async {
        tokio::select! {
            _ = term.recv() => {}
            _ = tokio::signal::ctrl_c() => {}
        }
    };
    serve(components, listener, max_connections, shutdown).await;
    Ok(())
}

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("components: {e}");
            ExitCode::FAILURE
        }
    }
}
