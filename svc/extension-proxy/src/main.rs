use extension_proxy::{BoxError, Config, Proxy, serve};
use std::net::SocketAddr;
use std::process::ExitCode;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::signal::unix::{SignalKind, signal};

async fn run() -> Result<(), BoxError> {
    let listen = std::env::var("LISTEN").unwrap_or_else(|_| "0.0.0.0:8000".into());
    let max_connections: usize = match std::env::var("MAX_CONNECTIONS") {
        Ok(value) => value
            .parse()
            .map_err(|_| format!("MAX_CONNECTIONS: invalid value {value:?}"))?,
        Err(_) => 1024,
    };
    let mut term = signal(SignalKind::terminate())?;

    if let Ok(addr) = std::env::var("METRICS_LISTEN") {
        let addr: SocketAddr = addr
            .parse()
            .map_err(|_| format!("METRICS_LISTEN: invalid value {addr:?}"))?;
        metrics_exporter_prometheus::PrometheusBuilder::new()
            .with_http_listener(addr)
            .install()?;
    }

    let proxy = Arc::new(Proxy::new(Config::from_env())?);
    let listener = TcpListener::bind(&listen).await?;
    eprintln!("listening on {}", listener.local_addr()?);

    let shutdown = async {
        tokio::select! {
            _ = term.recv() => {}
            _ = tokio::signal::ctrl_c() => {}
        }
    };
    serve(proxy, listener, max_connections, shutdown).await;
    Ok(())
}

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("extension-proxy: {e}");
            ExitCode::FAILURE
        }
    }
}
