//! Models box runs itself, downloaded into the data folder only when a client asks (model_download), each file checked
//! against its SHA-256 before it is kept: the reranker, hs-rerank-1 as ONNX. (A built-in embedder comes with a runtime for
//! it; until then embedding is the user's endpoint's.)

use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// A model box can download: its files under `<home>/models/`, each with where it comes from and its SHA-256
pub struct Spec {
    pub name: &'static str,
    pub files: &'static [(&'static str, &'static str, &'static str)],
}

/// The reranker: hindsight-ai/hs-rerank-1 (MIT, mmBERT-small cross-encoder), ONNX with an int8 vocabulary table (161 MB)
/// and its tokenizer (34 MB)
pub static RERANKER: Spec = Spec {
    name: "hs-rerank-1",
    files: &[
        (
            "hs-rerank-1/model.onnx",
            "https://huggingface.co/hindsight-ai/hs-rerank-1/resolve/main/onnx/model.onnx",
            "c866580692c6bf274b11ca622db4329f4cbfd6f08f96af964badc31d748ef243",
        ),
        (
            "hs-rerank-1/tokenizer.json",
            "https://huggingface.co/hindsight-ai/hs-rerank-1/resolve/main/tokenizer.json",
            "609d8f4c067cd3950f88594c5a802616cea245823836ef5848ee4fc40aab5b6f",
        ),
    ],
};

pub fn spec(name: &str) -> Option<&'static Spec> {
    [&RERANKER].into_iter().find(|s| s.name == name)
}

#[derive(Default, Clone)]
struct State {
    running: bool,
    bytes: u64,
    total: Option<u64>,
    error: Option<String>,
}

/// A downloadable model's files in a data folder, and their download
pub struct Model {
    spec: &'static Spec,
    dir: PathBuf,
    state: Arc<Mutex<State>>,
}

impl Model {
    pub fn new(home: &Path, spec: &'static Spec) -> Model {
        Model {
            spec,
            dir: home.join("models"),
            state: Arc::default(),
        }
    }

    pub fn spec(&self) -> &'static Spec {
        self.spec
    }

    /// The model's files, in the order of its spec
    pub fn files(&self) -> Vec<PathBuf> {
        self.spec.files.iter().map(|f| self.dir.join(f.0)).collect()
    }

    pub fn present(&self) -> bool {
        self.files().iter().all(|f| f.is_file())
    }

    pub fn status(&self) -> serde_json::Value {
        let s = self.state.lock().unwrap().clone();
        serde_json::json!({
            "name": self.spec.name,
            "files": self.files(),
            "present": self.present(),
            "downloading": s.running,
            "bytes": s.bytes,
            "total": s.total,
            "error": s.error,
            // whether this build can run it: the reranker with the cargo feature rerank
            "runs": cfg!(feature = "rerank"),
        })
    }

    /// Starts the download in the background unless the files are there or a download runs. `url` and `sha256` replace
    /// the first file's (tests)
    pub fn download(&self, url: Option<String>, sha256: Option<String>) -> serde_json::Value {
        {
            let mut s = self.state.lock().unwrap();
            if !s.running && !self.present() {
                *s = State {
                    running: true,
                    ..State::default()
                };
                let mut files: Vec<(PathBuf, String, String)> = self
                    .spec
                    .files
                    .iter()
                    .map(|f| (self.dir.join(f.0), f.1.to_string(), f.2.to_string()))
                    .collect();
                if let Some(u) = url {
                    files[0].1 = u;
                }
                if let Some(h) = sha256 {
                    files[0].2 = h.to_lowercase();
                }
                let state = self.state.clone();
                std::thread::spawn(move || {
                    let r = files
                        .iter()
                        .filter(|(f, _, _)| !f.is_file())
                        .try_for_each(|(f, u, h)| fetch(u, h, f, &state));
                    let mut s = state.lock().unwrap();
                    s.running = false;
                    s.error = r.err();
                });
            }
        }
        self.status()
    }
}

fn fetch(url: &str, sha: &str, file: &Path, state: &Mutex<State>) -> Result<(), String> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let part = file.with_extension("part");
    let res = ureq::get(url)
        .call()
        .map_err(|e| format!("Cannot download the model ({e})"))?;
    let total = res
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok());
    {
        let mut s = state.lock().unwrap();
        s.total = total.map(|t: u64| t + s.bytes);
    }
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

    /// A one-file model for the download's tests
    static TINY: Spec = Spec {
        name: "tiny",
        files: &[("tiny.bin", "http://127.0.0.1:9/tiny.bin", "00")],
    };

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
        let m = Model::new(&home, &TINY);
        let url = server(b"GGUF tiny model");
        assert_eq!(m.status()["present"], false);
        m.download(Some(url.clone()), Some("00".repeat(32)));
        let s = wait(&m);
        assert_eq!(s["present"], false);
        assert!(s["error"].as_str().unwrap().contains("not kept"), "{s}");
        assert!(!m.files()[0].with_extension("part").exists());
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
        assert_eq!(std::fs::read(&m.files()[0]).unwrap(), b"GGUF tiny model");
        std::fs::remove_dir_all(&home).unwrap();
    }
}
