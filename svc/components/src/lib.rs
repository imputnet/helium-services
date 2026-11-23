//! helium's component update server, as a library so the tests can run it.

pub mod bergamot;
mod builds;
pub mod crlset;
pub mod keys;
mod provider;
mod server;
pub mod ublock;

pub use provider::{Provider, Spec, SpecFile};
pub use server::{Body, Components, Config, component_key, serve};

pub type BoxError = Box<dyn std::error::Error + Send + Sync>;
