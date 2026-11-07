//! The service end to end, over its socket, against a stand-in embedding server (deterministic vectors from word counts)
use boxlib::{paths, service};
use interprocess::local_socket::{Stream, prelude::*};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const WORDS: [&str; 7] = ["kv", "cache", "scheduler", "prefill", "graph", "cuda", "显存"];

/// What the stand-in server was asked to embed
type Asked = Arc<Mutex<Vec<Value>>>;

fn vec_of(t: &str) -> Vec<f32> {
    let body = t
        .split_once("| text: ")
        .or(t.split_once("| query: "))
        .map_or(t, |x| x.1);
    WORDS.iter().map(|w| body.matches(w).count() as f32 + 0.01).collect()
}

/// A tiny HTTP/1.1 server: GET /v1/models, POST /v1/embeddings (text, and images as {type: image_url})
fn embedding_server(fail_first: usize) -> (String, Asked) {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}/v1", l.local_addr().unwrap());
    let asked: Asked = Arc::default();
    let a = asked.clone();
    let fails = Arc::new(std::sync::atomic::AtomicUsize::new(fail_first));
    std::thread::spawn(move || {
        for s in l.incoming() {
            let Ok(mut s) = s else { continue };
            let a = a.clone();
            let fails = fails.clone();
            std::thread::spawn(move || {
                let mut r = BufReader::new(s.try_clone().unwrap());
                loop {
                    let mut head = String::new();
                    let mut len = 0;
                    loop {
                        let mut line = String::new();
                        if r.read_line(&mut line).unwrap_or(0) == 0 {
                            return;
                        }
                        if let Some(v) = line.to_lowercase().strip_prefix("content-length:") {
                            len = v.trim().parse().unwrap();
                        }
                        if line == "\r\n" {
                            break;
                        }
                        head.push_str(&line);
                    }
                    let mut body = vec![0; len];
                    r.read_exact(&mut body).unwrap();
                    let (status, out) = if head.starts_with("GET") {
                        (200, json!({ "data": [{ "id": "test-embed" }] }))
                    } else {
                        let j: Value = serde_json::from_slice(&body).unwrap();
                        a.lock().unwrap().push(j["input"].clone());
                        let input = j["input"].as_array().unwrap();
                        let failing = fails
                            .fetch_update(
                                std::sync::atomic::Ordering::SeqCst,
                                std::sync::atomic::Ordering::SeqCst,
                                |n| n.checked_sub(1),
                            )
                            .is_ok();
                        if failing {
                            (503, json!({ "error": "restarting" }))
                        } else if input.iter().any(|x| x.get("image").is_some()) {
                            (400, json!({ "error": "no such input" }))
                        } else {
                            let data: Vec<Value> = input
                                .iter()
                                .enumerate()
                                .map(|(i, x)| {
                                    let v = match x.as_str() {
                                        Some(t) => vec_of(t),
                                        None => vec_of(x["image_url"]["url"].as_str().unwrap()),
                                    };
                                    json!({ "index": i, "embedding": v })
                                })
                                .collect();
                            (200, json!({ "data": data }))
                        }
                    };
                    let b = out.to_string();
                    let _ = write!(
                        s,
                        "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{b}",
                        b.len()
                    );
                }
            });
        }
    });
    (base, asked)
}

struct Client {
    r: BufReader<Stream>,
    n: u64,
}

impl Client {
    fn connect(p: &paths::Paths) -> Client {
        let name = service::socket_name(p).unwrap();
        let s = loop {
            match Stream::connect(name.clone()) {
                Ok(s) => break s,
                Err(_) => std::thread::yield_now(),
            }
        };
        Client {
            r: BufReader::new(s),
            n: 0,
        }
    }
    fn ask(&mut self, op: &str, mut body: Value) -> Value {
        self.n += 1;
        body["id"] = json!(self.n);
        body["op"] = json!(op);
        writeln!(self.r.get_mut(), "{body}").unwrap();
        let mut line = String::new();
        self.r.read_line(&mut line).unwrap();
        let v: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["id"], json!(self.n));
        v
    }
    fn ok(&mut self, op: &str, body: Value) -> Value {
        let v = self.ask(op, body);
        assert!(v.get("error").is_none(), "{op}: {v}");
        v["result"].clone()
    }
    /// Asks for status until indexing is done
    fn settle(&mut self, source: &str, r: &str) -> Value {
        loop {
            let s = self.ok("status", json!({ "source": source, "ref": r }));
            if !s["indexing"].as_bool().unwrap() {
                return s;
            }
            std::thread::yield_now();
        }
    }
}

fn texts(asked: &Asked, from: usize) -> Vec<String> {
    asked.lock().unwrap()[from..]
        .iter()
        .flat_map(|x| {
            x.as_array()
                .unwrap()
                .iter()
                .filter_map(|t| t.as_str().map(String::from))
                .collect::<Vec<_>>()
        })
        .collect()
}

#[test]
fn sync_search_and_switching_refs_over_the_socket() {
    let home = std::env::temp_dir().join(format!("box-protocol-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    let p = paths::paths(&home);
    let h2 = home.clone();
    let svc = std::thread::spawn(move || service::serve(paths::paths(&h2), Duration::from_millis(300)).unwrap());
    let (base, asked) = embedding_server(0);
    let mut c = Client::connect(&p);

    // nothing but hello with the token first; a wrong token ends the connection
    let v = c.ask("status", json!({ "source": "s", "ref": "main" }));
    assert!(v["error"].as_str().unwrap().contains("hello"));
    let mut bad = Client::connect(&p);
    assert!(bad.ask("hello", json!({ "token": "nope" }))["error"].is_string());
    let token = std::fs::read_to_string(&p.token).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&p.token).unwrap().permissions().mode() & 0o777, 0o600);
    }
    let mut c = Client::connect(&p);
    let hello = c.ok("hello", json!({ "token": token.trim() }));
    assert_eq!(hello["pid"], json!(std::process::id()));

    let unsynced = c.ok("search", json!({ "source": "s", "ref": "main", "q": "kv" }));
    assert_eq!(unsynced["unsynced"], json!(true));

    let items = json!([
        { "id": "n1", "title": "Block manager", "text": "Frees kv cache blocks.\n\nWhen a sequence ends, its cache goes.",
          "groups": ["a"], "meta": { "board": "a" } },
        { "id": "n2", "title": "Scheduler", "text": "Picks prefill or decode.", "groups": ["a", "b"] },
        { "id": "n3", "title": "", "text": "The cuda graph is captured once.", "groups": ["b"],
          "images": [{ "key": "pic1", "url": "data:image/png;base64,显存显存" }, { "key": "pic2" }] },
    ]);
    let emb = json!({ "base": base, "key": "k1" });
    let r = c.ok(
        "sync",
        json!({ "source": "s", "ref": "main", "embedder": emb, "items": items }),
    );
    assert_eq!(r["accepted"], json!(3));
    let st = c.settle("s", "main");
    assert_eq!(st["error"], Value::Null, "{st}");
    assert_eq!(
        (st["items"].clone(), st["left"].clone(), st["model"].clone()),
        (json!(3), json!(0), json!("test-embed"))
    );
    let first = texts(&asked, 0);
    assert!(first.contains(&"title: Block manager | text: When a sequence ends, its cache goes.".to_string()));

    let s = c.ok(
        "search",
        json!({ "source": "s", "ref": "main", "q": "kv cache", "k": 2 }),
    );
    assert_eq!(
        (s["model"].clone(), s["source"].clone(), s["ref"].clone()),
        (json!("test-embed"), json!("s"), json!("main"))
    );
    let hit = &s["hits"][0];
    assert_eq!(
        (hit["id"].clone(), hit["meta"].clone()),
        (json!("n1"), json!({ "board": "a" }))
    );
    // its first paragraph matched best: the hit says which piece and where it is in the text (UTF-16)
    assert_eq!((hit["piece"].clone(), hit["range"].clone()), (json!(1), json!([0, 22])));
    assert!(hit["score"].as_f64().unwrap() > 0.9);
    assert_eq!(s["hits"].as_array().unwrap().len(), 2);
    // the image is a piece of its card; the other image had no data, so it is not embedded
    let img = c.ok("search", json!({ "source": "s", "ref": "main", "q": "显存" }));
    assert_eq!(
        (img["hits"][0]["id"].clone(), img["hits"][0]["picture"].clone()),
        (json!("n3"), json!("pic1"))
    );
    // groups: only items on board b; min_score drops the rest
    let b = c.ok(
        "search",
        json!({ "source": "s", "ref": "main", "q": "kv cache", "groups": ["b"] }),
    );
    assert!(b["hits"].as_array().unwrap().iter().all(|h| h["id"] != json!("n1")));
    let none = c.ok(
        "search",
        json!({ "source": "s", "ref": "main", "q": "kv cache", "min_score": 1.01 }),
    );
    assert_eq!(none["hits"], json!([]));

    // another ref with one item changed: only that item's text is embedded; switching back embeds nothing
    let mut items2 = items.clone();
    items2[1]["text"] = json!("Picks prefill or decode. Keeps 显存 in check.");
    let before = asked.lock().unwrap().len();
    c.ok(
        "sync",
        json!({ "source": "s", "ref": "feature", "embedder": emb, "items": items2 }),
    );
    c.settle("s", "feature");
    assert_eq!(
        texts(&asked, before),
        vec!["title: Scheduler | text: Picks prefill or decode. Keeps 显存 in check."]
    );
    let before = asked.lock().unwrap().len();
    c.ok(
        "sync",
        json!({ "source": "s", "ref": "main", "embedder": emb, "items": items }),
    );
    c.settle("s", "main");
    assert_eq!(asked.lock().unwrap().len(), before);

    // a second client shares the same service and index
    let mut d = Client::connect(&p);
    assert_eq!(d.ok("hello", json!({ "token": token.trim() }))["pid"], hello["pid"]);
    let st = d.ok("status", json!({ "source": "s", "ref": "feature" }));
    assert_eq!(st["items"], json!(3));

    c.ok("forget", json!({ "source": "s" }));
    assert_eq!(
        d.ok("status", json!({ "source": "s", "ref": "main" }))["items"],
        json!(0)
    );
    drop((c, d, bad));
    // idle with no connections: the service exits
    assert!(matches!(svc.join().unwrap(), service::Outcome::Stopped));
    std::fs::remove_dir_all(&home).unwrap();
}

#[test]
fn indexing_recovers_by_itself_after_the_embedding_server_fails() {
    let home = std::env::temp_dir().join(format!("box-retry-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    let p = paths::paths(&home);
    let h2 = home.clone();
    let svc = std::thread::spawn(move || service::serve(paths::paths(&h2), Duration::from_millis(300)).unwrap());
    // the first two embedding requests fail, as while the server restarts
    let (base, asked) = embedding_server(2);
    let mut c = Client::connect(&p);
    let token = std::fs::read_to_string(&p.token).unwrap();
    c.ok("hello", json!({ "token": token.trim() }));
    let items =
        json!([{ "id": "a", "title": "t", "text": "kv cache" }, { "id": "b", "title": "u", "text": "cuda graph" }]);
    c.ok(
        "sync",
        json!({ "source": "s", "ref": "main", "embedder": { "base": base }, "items": items }),
    );
    // no other sync: box tries again itself until everything is embedded
    let st = c.settle("s", "main");
    assert_eq!(
        (st["left"].clone(), st["error"].clone(), st["vectors"].clone()),
        (json!(0), Value::Null, json!(2))
    );
    assert_eq!(
        asked.lock().unwrap().len(),
        3,
        "two refused, then the batch and nothing more"
    );
    let s = c.ok(
        "search",
        json!({ "source": "s", "ref": "main", "q": "cuda graph", "k": 1 }),
    );
    assert_eq!(s["hits"][0]["id"], json!("b"));
    drop(c);
    assert!(matches!(svc.join().unwrap(), service::Outcome::Stopped));
    std::fs::remove_dir_all(&home).unwrap();
}
