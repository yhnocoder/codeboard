//! box: a local knowledge index. Clients (CodeBoard's host in every VS Code window, later other tools) hand it their items;
//! box cuts them into pieces (chunk), embeds what it has not seen with the model the client names (embed), keeps content and
//! per-source manifests in SQLite (store), and searches the vectors in memory (vectors). One service per user serves them all
//! over a local socket (service); PROTOCOL.md has the requests.

pub mod chunk;
pub mod embed;
pub mod paths;
pub mod service;
pub mod store;
pub mod vectors;
