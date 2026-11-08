//! box's core: a local knowledge index in one process. Items are cut into pieces (chunk), embedded by a model the client
//! names (embed), kept as content by hash and per-source manifests in SQLite (store) and searched in memory (vectors);
//! index ties them together behind one API (Index), which the service (box serve), the Node binding and the C ABI (Swift)
//! all use. PROTOCOL.md has the requests.

pub mod chunk;
pub mod embed;
pub mod graph;
pub mod index;
pub mod keyword;
pub mod probe;
pub mod rerank;
pub mod store;
pub mod vectors;

pub use index::{Index, OpenError, Reply};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
