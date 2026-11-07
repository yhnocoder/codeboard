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
                        // take one of the failures left, if any (a plain CAS loop: fetch_update is deprecated on
                        // newer toolchains and try_update missing on older ones)
                        let failing = {
                            use std::sync::atomic::Ordering::SeqCst;
                            let mut n = fails.load(SeqCst);
                            loop {
                                if n == 0 {
                                    break false;
                                }
                                match fails.compare_exchange(n, n - 1, SeqCst, SeqCst) {
                                    Ok(_) => break true,
                                    Err(now) => n = now,
                                }
                            }
                        };
                        let image = input.first().and_then(|x| x["image_url"]["url"].as_str()).unwrap_or("");
                        if failing {
                            (503, json!({ "error": "restarting" }))
                        } else if image.contains("toolarge") {
                            (413, json!({ "error": "payload too large" }))
                        } else if image.contains("noimg") {
                            (400, json!({ "error": "unknown input type" }))
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

/// Ends the whole test run with the service's log when a test is still going after a minute and a half, so a hang shows
/// what the service was doing instead of running into the job's timeout. Dropping the guard disarms it
struct Watchdog(Arc<std::sync::atomic::AtomicBool>);
impl Drop for Watchdog {
    fn drop(&mut self) {
        self.0.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}
fn watchdog(name: &'static str, p: &paths::Paths) -> Watchdog {
    let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let d = done.clone();
    let log = p.log.clone();
    std::thread::spawn(move || {
        let until = std::time::Instant::now() + Duration::from_secs(90);
        while std::time::Instant::now() < until {
            if d.load(std::sync::atomic::Ordering::SeqCst) {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        // straight to the process's stderr: the test harness captures eprintln! in threads a test spawns and would drop
        // it on exit
        let _ = writeln!(
            std::io::stderr().lock(),
            "{name} still running after 90 s; last requests: {:?}; the service's log:\n{}",
            LAST.lock().unwrap(),
            std::fs::read_to_string(&log).unwrap_or_default()
        );
        std::process::exit(101);
    });
    Watchdog(done)
}

/// What each connection last asked or is waiting for, for the watchdog's report
static LAST: Mutex<Vec<String>> = Mutex::new(Vec::new());
fn note(what: String) {
    let mut l = LAST.lock().unwrap();
    l.push(what);
    let n = l.len();
    if n > 40 {
        l.drain(..n - 40);
    }
}

struct Client {
    r: BufReader<Stream>,
    n: u64,
}

impl Client {
    fn connect(p: &paths::Paths) -> Client {
        let name = service::socket_name(p).unwrap();
        note(format!("connect {}", p.socket));
        let s = loop {
            match Stream::connect(name.clone()) {
                Ok(s) => break s,
                // a poll, not a spin
                Err(_) => std::thread::sleep(Duration::from_millis(5)),
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
        note(format!("ask {op}"));
        writeln!(self.r.get_mut(), "{body}").unwrap();
        let mut line = String::new();
        self.r.read_line(&mut line).unwrap();
        note(format!("answer {op}: {}", line.chars().take(160).collect::<String>()));
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
            // a poll, not a spin: each status takes the lock the indexing job also needs
            std::thread::sleep(Duration::from_millis(5));
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
    let _watch = watchdog("sync_search_and_switching_refs_over_the_socket", &p);
    let h2 = home.clone();
    let svc = std::thread::spawn(move || service::serve(paths::paths(&h2), Duration::from_millis(300)).unwrap());
    let (base, asked) = embedding_server(0);
    let mut c = Client::connect(&p);

    // nothing but hello with the token first; a wrong token ends the connection
    let v = c.ask("status", json!({ "source": "s", "ref": "main" }));
    assert!(v["error"].as_str().unwrap().contains("hello"));
    let mut bad = Client::connect(&p);
    assert!(bad.ask("hello", json!({ "token": "nope" }))["error"].is_string());
    // before hello a line is at most 64 KB: a longer one is answered with an error and the connection ends
    let mut big = Client::connect(&p);
    big.r.get_mut().write_all(&vec![b'x'; 70 << 10]).unwrap();
    let mut line = String::new();
    big.r.read_line(&mut line).unwrap();
    assert!(line.contains("request over 65536 bytes"), "{line}");
    line.clear();
    assert_eq!(big.r.read_line(&mut line).unwrap(), 0);
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
    // cleanup only: on Windows the service that just exited may hold its files a moment longer
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn indexing_recovers_by_itself_after_the_embedding_server_fails() {
    let home = std::env::temp_dir().join(format!("box-retry-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    let p = paths::paths(&home);
    let _watch = watchdog("indexing_recovers_by_itself_after_the_embedding_server_fails", &p);
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
        4,
        "two refused, then the probe texts (the model's fingerprint), the batch and nothing more"
    );
    let s = c.ok(
        "search",
        json!({ "source": "s", "ref": "main", "q": "cuda graph", "k": 1 }),
    );
    assert_eq!(s["hits"][0]["id"], json!("b"));
    drop(c);
    assert!(matches!(svc.join().unwrap(), service::Outcome::Stopped));
    // cleanup only: on Windows the service that just exited may hold its files a moment longer
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn one_refused_image_is_skipped_and_a_server_without_images_is_found_out() {
    let home = std::env::temp_dir().join(format!("box-images-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    let p = paths::paths(&home);
    let _watch = watchdog(
        "one_refused_image_is_skipped_and_a_server_without_images_is_found_out",
        &p,
    );
    let h2 = home.clone();
    let svc = std::thread::spawn(move || service::serve(paths::paths(&h2), Duration::from_millis(300)).unwrap());
    let (base, asked) = embedding_server(0);
    let mut c = Client::connect(&p);
    let token = std::fs::read_to_string(&p.token).unwrap();
    c.ok("hello", json!({ "token": token.trim() }));
    let images_asked = |from: usize| {
        asked.lock().unwrap()[from..]
            .iter()
            .filter(|x| x[0].is_object())
            .count()
    };
    // too large (413 in both formats): only that image is skipped, the next one goes in
    let items = json!([{ "id": "a", "title": "t", "text": "kv", "images": [
        { "key": "big", "url": "data:image/png;base64,toolarge" }, { "key": "ok", "url": "data:image/png;base64,cuda" }] }]);
    c.ok(
        "sync",
        json!({ "source": "s", "ref": "main", "embedder": { "base": base }, "items": items }),
    );
    c.settle("s", "main");
    let s = c.ok("search", json!({ "source": "s", "ref": "main", "q": "cuda", "k": 1 }));
    assert_eq!(s["hits"][0]["picture"], json!("ok"));
    // a server that understands neither format: after three images refused in both, the rest are not sent
    let before = asked.lock().unwrap().len();
    let pics: Vec<Value> = (1..=5)
        .map(|i| json!({ "key": format!("n{i}"), "url": format!("data:image/png;base64,noimg{i}") }))
        .collect();
    let items = json!([{ "id": "b", "title": "t", "text": "graph", "images": pics }]);
    c.ok(
        "sync",
        json!({ "source": "other", "ref": "main", "embedder": { "base": base }, "items": items }),
    );
    let st = c.settle("other", "main");
    assert_eq!((st["left"].clone(), st["error"].clone()), (json!(0), Value::Null));
    assert_eq!(images_asked(before), 6);
    drop(c);
    assert!(matches!(svc.join().unwrap(), service::Outcome::Stopped));
    // cleanup only: on Windows the service that just exited may hold its files a moment longer
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn forget_while_indexing_then_sync_leaves_one_right_index() {
    let home = std::env::temp_dir().join(format!("box-forget-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    let p = paths::paths(&home);
    let _watch = watchdog("forget_while_indexing_then_sync_leaves_one_right_index", &p);
    let h2 = home.clone();
    let svc = std::thread::spawn(move || service::serve(paths::paths(&h2), Duration::from_millis(300)).unwrap());
    let (base, _asked) = embedding_server(0);
    let mut c = Client::connect(&p);
    let token = std::fs::read_to_string(&p.token).unwrap();
    c.ok("hello", json!({ "token": token.trim() }));
    let many = |tag: &str| -> Value {
        (0..300)
            .map(|i| json!({ "id": format!("{tag}{i}"), "title": "t", "text": format!("{tag} kv cache {i}") }))
            .collect()
    };
    let emb = json!({ "base": base });
    c.ok(
        "sync",
        json!({ "source": "s", "ref": "main", "embedder": emb, "items": many("old") }),
    );
    c.ok("forget", json!({ "source": "s" }));
    c.ok(
        "sync",
        json!({ "source": "s", "ref": "main", "embedder": emb, "items": many("new") }),
    );
    // another ref replaces main's job before it is done: main is not being indexed any more, so nothing is left there
    c.ok(
        "sync",
        json!({ "source": "s", "ref": "feature", "embedder": emb, "items": many("new") }),
    );
    let st = c.settle("s", "feature");
    assert_eq!((st["items"].clone(), st["left"].clone()), (json!(300), json!(0)));
    assert_eq!(
        c.ok("status", json!({ "source": "s", "ref": "main" }))["left"],
        json!(0)
    );
    let s = c.ok(
        "search",
        json!({ "source": "s", "ref": "feature", "q": "kv cache", "k": 400 }),
    );
    let hits = s["hits"].as_array().unwrap();
    assert!(hits.iter().all(|h| h["id"].as_str().unwrap().starts_with("new")));
    // the forgotten job wrote nothing: main has the new set (or none of it yet), never the old one
    let m = c.ok(
        "search",
        json!({ "source": "s", "ref": "main", "q": "kv cache", "k": 400 }),
    );
    assert!(
        m["hits"]
            .as_array()
            .unwrap()
            .iter()
            .all(|h| h["id"].as_str().unwrap().starts_with("new"))
    );
    drop(c);
    assert!(matches!(svc.join().unwrap(), service::Outcome::Stopped));
    // cleanup only: on Windows the service that just exited may hold its files a moment longer
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn the_keyword_group_is_there_without_a_model_and_sees_only_its_ref() {
    let home = std::env::temp_dir().join(format!("box-keyword-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    let p = paths::paths(&home);
    let _watch = watchdog("the_keyword_group_is_there_without_a_model_and_sees_only_its_ref", &p);
    let h2 = home.clone();
    let svc = std::thread::spawn(move || service::serve(paths::paths(&h2), Duration::from_millis(300)).unwrap());
    let mut c = Client::connect(&p);
    let token = std::fs::read_to_string(&p.token).unwrap();
    c.ok("hello", json!({ "token": token.trim() }));
    let items = json!([
        { "id": "a", "title": "BlockManager", "text": "BlockManager.deallocate frees the kv cache blocks.", "groups": ["b1"],
          "meta": { "n": 1 } },
        { "id": "b", "title": "计算受限的判断", "text": "decode 阶段通常是访存受限，prefill 是计算受限。", "groups": ["b2"] },
    ]);
    // no embedding server at all: the keyword group is indexed anyway
    let down = "http://127.0.0.1:9/v1";
    c.ok(
        "sync",
        json!({ "source": "s", "ref": "main", "embedder": { "base": down }, "items": items }),
    );
    let kw = |c: &mut Client, r: &str, q: &str, groups: Value| {
        let mut body = json!({ "source": "s", "ref": r, "q": q });
        if !groups.is_null() {
            body["groups"] = groups;
        }
        c.ok("search_keyword", body)
    };
    let hits = loop {
        let h = kw(&mut c, "main", "deallocate", Value::Null)["hits"].clone();
        if !h.as_array().unwrap().is_empty() {
            break h;
        }
        std::thread::sleep(Duration::from_millis(5)); // a poll: the sync's job adds the documents
    };
    assert_eq!(
        hits,
        json!([{ "id": "a", "score": hits[0]["score"], "range": [13, 23], "meta": { "n": 1 } }])
    );
    let ids = |v: Value| -> Vec<String> {
        v["hits"]
            .as_array()
            .unwrap()
            .iter()
            .map(|h| h["id"].as_str().unwrap().to_string())
            .collect()
    };
    assert_eq!(ids(kw(&mut c, "main", "计算受限", Value::Null)), ["b"]);
    assert_eq!(ids(kw(&mut c, "main", "block manager", Value::Null)), ["a"]);
    assert!(ids(kw(&mut c, "main", "kv cache", json!(["b2"]))).is_empty());
    let st = c.ok("status", json!({ "source": "s", "ref": "main" }));
    assert_eq!((st["items"].clone(), st["model"].clone()), (json!(2), Value::Null));
    assert!(st["error"].as_str().unwrap().contains("Cannot reach"), "{st}");
    // another ref sees only its own items, though the content is shared
    c.ok(
        "sync",
        json!({ "source": "s", "ref": "feature", "embedder": { "base": down }, "items": [items[1].clone()] }),
    );
    loop {
        if ids(kw(&mut c, "feature", "计算受限", Value::Null)) == ["b"] {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(ids(kw(&mut c, "feature", "deallocate", Value::Null)).is_empty());
    assert!(ids(kw(&mut c, "nowhere", "deallocate", Value::Null)).is_empty());
    // the server comes: the same manifest gets its vectors, and both groups answer
    let (base, _) = embedding_server(0);
    c.ok(
        "sync",
        json!({ "source": "s", "ref": "main", "embedder": { "base": base }, "items": items }),
    );
    let st = c.settle("s", "main");
    assert_eq!(
        (st["left"].clone(), st["model"].clone()),
        (json!(0), json!("test-embed"))
    );
    assert_eq!(
        ids(c.ok(
            "search",
            json!({ "source": "s", "ref": "main", "q": "kv cache", "k": 1 })
        )),
        ["a"]
    );
    assert_eq!(ids(kw(&mut c, "main", "deallocate", Value::Null)), ["a"]);
    // forgotten: nothing found
    c.ok("forget", json!({ "source": "s" }));
    assert!(ids(kw(&mut c, "main", "deallocate", Value::Null)).is_empty());
    drop(c);
    assert!(matches!(svc.join().unwrap(), service::Outcome::Stopped));
    let _ = std::fs::remove_dir_all(&home);
}
