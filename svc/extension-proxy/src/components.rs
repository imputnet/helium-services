use crate::source::UpstreamSource;
use omaha_protocol::AppId;
use omaha_server::Endpoint;

/// Components that are allowed to be proxied to upstream.
const ALLOWED: &[&str] = &[
    "hfnkpimlhhgieaddgfemjhofmfblmnib", // CRLSet
    "efniojlnjndmcbiieegkicadnoecjjef", // PKI Metadata
    "giekcmmlnklenlaomppkphknjmnnpneh", // SSL Error Assistant
];

pub fn endpoint(upstream: UpstreamSource) -> Endpoint {
    Endpoint::builder()
        .source(ALLOWED.iter().copied().filter_map(AppId::new), upstream)
        .build()
}
