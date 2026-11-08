//! box: a local knowledge index. The index itself is box-core (core/); this crate is the service in front of it: one per
//! user, which every client (CodeBoard's host in every VS Code window, later other tools) reaches over a local socket
//! (service, paths). PROTOCOL.md has the requests.

pub mod paths;
pub mod service;
