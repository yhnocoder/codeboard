//! The built-in model's file: EmbeddingGemma 2 as GGUF Q8_0 (310 MB), downloaded into the data folder only when a client asks
//! (model_download), checked against its SHA-256 before it is kept. Never fp16: EmbeddingGemma's activations overflow it.

use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub const FILE: &str = "embeddinggemma-2-Q8_0.gguf";
pub const URL: &str = "https://huggingface.co/ggml-org/embeddinggemma-2-GGUF/resolve/main/embeddinggemma-2-Q8_0.gguf";
pub const SHA256: &str = "2188ac1deca4b77dffefd603c2776a9d76d9d74ec01841392982ebb840b09135";

#[derive(Default, Clone)]
struct State {
    running: bool,
    bytes: u64,
    total: Option<u64>,
    error: Option<String>,
}

/// The model file of a data folder and its download
pub struct Model {
    dir: PathBuf,
    state: Arc<Mutex<State>>,
}

impl Model {
    pub fn new(home: &Path) -> Model {
        Model {
            dir: home.join("models"),
            state: Arc::default(),
        }
    }

    pub fn file(&self) -> PathBuf {
        self.dir.join(FILE)
    }

    pub fn status(&self) -> serde_json::Value {
        let s = self.state.lock().unwrap().clone();
        let file = self.file();
        serde_json::json!({
            "file": file,
            "present": file.is_file(),
            "downloading": s.running,
            "bytes": s.bytes,
            "total": s.total,
            "error": s.error,
        })
    }

    /// Starts the download in the background unless the file is there or a download runs. `url` and `sha256` default to
    /// the model's
    pub fn download(&self, url: Option<String>, sha256: Option<String>) -> serde_json::Value {
        {
            let mut s = self.state.lock().unwrap();
            if !s.running && !self.file().is_file() {
                *s = State {
                    running: true,
                    ..State::default()
                };
                let (dir, file, state) = (self.dir.clone(), self.file(), self.state.clone());
                let url = url.unwrap_or_else(|| URL.into());
                let sha = sha256.unwrap_or_else(|| SHA256.into()).to_lowercase();
                std::thread::spawn(move || {
                    let r = fetch(&url, &sha, &dir, &file, &state);
                    let mut s = state.lock().unwrap();
                    s.running = false;
                    s.error = r.err();
                });
            }
        }
        self.status()
    }
}

fn fetch(url: &str, sha: &str, dir: &Path, file: &Path, state: &Mutex<State>) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let part = file.with_extension("part");
    let res = ureq::get(url)
        .call()
        .map_err(|e| format!("Cannot download the model ({e})"))?;
    let total = res
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok());
    state.lock().unwrap().total = total;
    let mut body = res.into_body();
    let mut r = body.with_config().limit(u64::MAX).reader();
    let mut out = std::fs::File::create(&part).map_err(|e| e.to_string())?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = r
            .read(&mut buf)
            .map_err(|e| format!("The model's download broke off ({e})"))?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
        out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        state.lock().unwrap().bytes += n as u64;
    }
    out.sync_all().map_err(|e| e.to_string())?;
    drop(out);
    let got: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if got != sha {
        let _ = std::fs::remove_file(&part);
        return Err(format!("The downloaded model's SHA-256 is {got}, not {sha}: not kept"));
    }
    std::fs::rename(&part, file).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    /// Serves `body` to every GET
    fn server(body: &'static [u8]) -> String {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/m.gguf", l.local_addr().unwrap());
        std::thread::spawn(move || {
            for s in l.incoming() {
                let Ok(mut s) = s else { continue };
                let mut req = [0u8; 4096];
                let _ = s.read(&mut req);
                let _ = write!(
                    s,
                    "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    body.len()
                );
                let _ = s.write_all(body);
            }
        });
        url
    }

    fn wait(m: &Model) -> serde_json::Value {
        loop {
            let s = m.status();
            if s["downloading"] == false {
                return s;
            }
            std::thread::sleep(std::time::Duration::from_millis(5)); // a poll of the download's thread
        }
    }

    #[test]
    fn a_download_is_kept_only_with_the_right_checksum() {
        let home = std::env::temp_dir().join(format!("box-model-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let m = Model::new(&home);
        let url = server(b"GGUF tiny model");
        assert_eq!(m.status()["present"], false);
        m.download(Some(url.clone()), Some("00".repeat(32)));
        let s = wait(&m);
        assert_eq!(s["present"], false);
        assert!(s["error"].as_str().unwrap().contains("not kept"), "{s}");
        assert!(!m.file().with_extension("part").exists());
        let sha: String = Sha256::digest(b"GGUF tiny model")
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        m.download(Some(url), Some(sha.to_uppercase()));
        let s = wait(&m);
        assert_eq!(
            (s["present"].clone(), s["bytes"].clone(), s["error"].clone()),
            (true.into(), 15.into(), serde_json::Value::Null)
        );
        assert_eq!(std::fs::read(m.file()).unwrap(), b"GGUF tiny model");
        std::fs::remove_dir_all(&home).unwrap();
    }
}
