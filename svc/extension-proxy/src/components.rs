use crate::source::UpstreamSource;
use omaha_protocol::AppId;
use omaha_server::Endpoint;

const CRLSET: &str = "hfnkpimlhhgieaddgfemjhofmfblmnib";

pub fn endpoint(upstream: UpstreamSource) -> Endpoint {
    Endpoint::builder()
        .source(AppId::new(CRLSET), upstream)
        .build()
}
