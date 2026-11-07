//! Where box keeps its files: the platform's per-user data folder (`dirs::data_local_dir()/codeboard-box`), or `BOX_HOME`.
//! Not plain `box`: on macOS, whose file system ignores case, that is Box Drive's folder

use std::path::{Path, PathBuf};

/// The data folder's name in the platform's local data folder
pub const DIR_NAME: &str = "codeboard-box";

pub struct Paths {
    pub home: PathBuf,
    /// The SQLite index
    pub db: PathBuf,
    /// The token clients send first (only the user can read it)
    pub token: PathBuf,
    /// Held by the running service: one per data folder
    pub lock: PathBuf,
    pub log: PathBuf,
    /// The local socket as Node's net.connect takes it: a file on macOS and Linux, a named pipe on Windows
    pub socket: String,
}

pub fn home() -> PathBuf {
    match std::env::var_os("BOX_HOME") {
        Some(h) if !h.is_empty() => PathBuf::from(h),
        _ => dirs::data_local_dir().unwrap_or_else(std::env::temp_dir).join(DIR_NAME),
    }
}

pub fn paths(home: &Path) -> Paths {
    let socket = if cfg!(windows) {
        format!(r"\\.\pipe\{}", pipe_name(home))
    } else {
        home.join("box.sock").to_string_lossy().into_owned()
    };
    Paths {
        home: home.to_path_buf(),
        db: home.join("index.db"),
        token: home.join("token"),
        lock: home.join("box.lock"),
        log: home.join("box.log"),
        socket,
    }
}

/// The named pipe of a data folder (Windows)
pub fn pipe_name(home: &Path) -> String {
    let h = blake3::hash(home.to_string_lossy().as_bytes()).to_hex();
    format!("codeboard-box-{}", &h[..16])
}
