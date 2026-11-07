//! The service: one per user (a lock file in the data folder), on a local socket only the user can use (a token file clients
//! send first; no TCP port). Requests and answers are lines of JSON (PROTOCOL.md). Indexing runs in a background thread per
//! source; a search never waits for it and answers with what is indexed so far and how many pieces are left. The service
//! exits after `idle` with no connections.

use crate::chunk::{query_prompt, text_pieces};
use crate::embed::{BATCH, Embedder, Endpoint, EndpointConfig, Input};
use crate::paths::Paths;
use crate::store::{self, ItemRow, Key, PieceRow, Store, image_key, text_key};
use crate::vectors::{ModelIndex, RESCORE, clipped, dot};
use interprocess::local_socket::{ListenerNonblockingMode, ListenerOptions, prelude::*};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
/// Without connections for this long, the service exits
pub const IDLE: Duration = Duration::from_secs(600);
/// How often old manifests and unused content are deleted while running (and once at start)
const GC_EVERY: Duration = Duration::from_secs(24 * 3600);
/// Query vectors kept (the same query typed again, or asked again while indexing)
const QUERY_CACHE: usize = 64;
/// A manifest's last use is written at most this often (seconds)
const TOUCH_EVERY: i64 = 3600;
/// How often the listener looks for a new connection, and for being idle
const ACCEPT_POLL: Duration = Duration::from_millis(25);

#[derive(Deserialize)]
pub struct ImageIn {
    /// The image's content hash, given by the client: one vector per key, however many items show it
    pub key: String,
    /// data:image/…;base64,… — none: embedded once a sync brings it
    #[serde(default)]
    pub url: Option<String>,
}

#[derive(Deserialize)]
pub struct ItemIn {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub groups: Vec<String>,
    #[serde(default)]
    pub meta: Option<Box<serde_json::value::RawValue>>,
    #[serde(default)]
    pub images: Vec<ImageIn>,
}

struct Job {
    r#ref: String,
    items: Vec<ItemIn>,
}

/// A manifest as search reads it
struct Manifest {
    id: i64,
    model: String,
    items: Vec<ItemRow>,
    touched: i64,
}

struct Source {
    conf: EndpointConfig,
    embedder: Arc<dyn Embedder>,
    pending: Option<Job>,
    running: bool,
    /// Pieces not embedded yet, per ref
    left: HashMap<String, usize>,
    error: Option<String>,
}

/// (source, ref) → its manifest
type Manifests = HashMap<(String, String), Arc<RwLock<Manifest>>>;

pub struct Service {
    paths: Paths,
    token: String,
    store: Mutex<Store>,
    models: RwLock<HashMap<String, Arc<RwLock<ModelIndex>>>>,
    manifests: RwLock<Manifests>,
    sources: Mutex<HashMap<String, Source>>,
    queries: Mutex<VecDeque<(String, String, Vec<f32>)>>,
    stop: AtomicBool,
    conns: AtomicUsize,
}

pub enum Outcome {
    /// Another service holds the data folder
    AlreadyRunning,
    /// Exited after being idle (or stop())
    Stopped,
}

pub fn log(paths: &Paths, line: &str) {
    if std::fs::metadata(&paths.log)
        .map(|m| m.len() > 1 << 20)
        .unwrap_or(false)
    {
        let _ = std::fs::remove_file(&paths.log);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&paths.log) {
        let _ = writeln!(f, "{} {line}", store::now());
    }
}

fn private_dir(dir: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// The token in the data folder, made once (random, readable only by the user)
fn token(paths: &Paths) -> std::io::Result<String> {
    if let Ok(t) = std::fs::read_to_string(&paths.token) {
        let t = t.trim().to_string();
        if t.len() >= 32 {
            return Ok(t);
        }
    }
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).map_err(|e| std::io::Error::other(e.to_string()))?;
    let t: String = b.iter().map(|x| format!("{x:02x}")).collect();
    let tmp = paths.token.with_extension("tmp");
    {
        let mut o = std::fs::OpenOptions::new();
        o.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            o.mode(0o600);
        }
        let mut f = o.open(&tmp)?;
        f.write_all(t.as_bytes())?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, &paths.token)?;
    Ok(t)
}

/// Runs the service for this data folder until it is idle for `idle`
pub fn serve(paths: Paths, idle: Duration) -> std::io::Result<Outcome> {
    private_dir(&paths.home)?;
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&paths.lock)?;
    match lock.try_lock() {
        Ok(()) => {}
        Err(std::fs::TryLockError::WouldBlock) => return Ok(Outcome::AlreadyRunning),
        Err(std::fs::TryLockError::Error(e)) => return Err(e),
    }
    let token = token(&paths)?;
    let mut st = Store::open(&paths.db).map_err(std::io::Error::other)?;
    let (m, c) = st
        .gc(store::now() - store::MANIFEST_DAYS * 86400)
        .map_err(std::io::Error::other)?;
    log(
        &paths,
        &format!(
            "start {VERSION} pid {}: gc dropped {m} manifests, {c} vectors",
            std::process::id()
        ),
    );
    let svc = Arc::new(Service {
        token,
        store: Mutex::new(st),
        models: RwLock::new(HashMap::new()),
        manifests: RwLock::new(HashMap::new()),
        sources: Mutex::new(HashMap::new()),
        queries: Mutex::new(VecDeque::new()),
        stop: AtomicBool::new(false),
        conns: AtomicUsize::new(0),
        paths,
    });
    svc.load_manifests().map_err(std::io::Error::other)?;

    #[cfg(unix)]
    let _ = std::fs::remove_file(&svc.paths.socket); // a socket file left by a service that died: ours now (we hold the lock)
    let name = socket_name(&svc.paths)?;
    let opts = ListenerOptions::new()
        .name(name)
        .nonblocking(ListenerNonblockingMode::Accept);
    #[cfg(unix)]
    let opts = {
        use interprocess::os::unix::local_socket::ListenerOptionsExt;
        opts.mode(0o600)
    };
    let listener = opts.create_sync()?;
    let mut quiet_since = Instant::now();
    let mut gc_at = Instant::now();
    loop {
        match listener.accept() {
            Ok(conn) => {
                svc.conns.fetch_add(1, Ordering::SeqCst);
                let s = svc.clone();
                std::thread::spawn(move || {
                    s.connection(conn);
                    s.conns.fetch_sub(1, Ordering::SeqCst);
                });
                continue;
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(e) => log(&svc.paths, &format!("accept: {e}")),
        }
        if svc.conns.load(Ordering::SeqCst) > 0 {
            quiet_since = Instant::now();
        } else if quiet_since.elapsed() >= idle {
            break;
        }
        if gc_at.elapsed() >= GC_EVERY {
            gc_at = Instant::now();
            svc.gc();
        }
        std::thread::sleep(ACCEPT_POLL);
    }
    svc.stop.store(true, Ordering::SeqCst);
    drop(listener);
    #[cfg(unix)]
    let _ = std::fs::remove_file(&svc.paths.socket);
    log(&svc.paths, "idle: exit");
    drop(lock);
    Ok(Outcome::Stopped)
}

pub fn socket_name(paths: &Paths) -> std::io::Result<interprocess::local_socket::Name<'static>> {
    #[cfg(windows)]
    {
        use interprocess::local_socket::{GenericNamespaced, ToNsName};
        crate::paths::pipe_name(&paths.home).to_ns_name::<GenericNamespaced>()
    }
    #[cfg(not(windows))]
    {
        use interprocess::local_socket::{GenericFilePath, ToFsName};
        std::path::PathBuf::from(&paths.socket).to_fs_name::<GenericFilePath>()
    }
}

type Reply = Result<Value, String>;

/// What an item was made from: the same hash, the same pieces
fn item_hash(fp: &str, it: &ItemIn) -> Key {
    let mut h = blake3::Hasher::new();
    for part in [fp, &it.title, &it.text] {
        h.update(&(part.len() as u64).to_le_bytes()).update(part.as_bytes());
    }
    for im in &it.images {
        h.update(&(im.key.len() as u64).to_le_bytes()).update(im.key.as_bytes());
    }
    *h.finalize().as_bytes()
}

/// The item's pieces (keys and places) and what each one embeds (an image without its data yet: None)
fn pieces_of(fp: &str, it: &ItemIn) -> Vec<(PieceRow, Option<Input>)> {
    let mut out: Vec<(PieceRow, Option<Input>)> = text_pieces(&it.title, &it.text)
        .into_iter()
        .map(|p| {
            let row = PieceRow {
                key: text_key(fp, &p.prompt),
                start: p.start,
                end: p.end,
                picture: None,
            };
            (row, Some(Input::Text(p.prompt)))
        })
        .collect();
    let mut seen = HashSet::new();
    for im in &it.images {
        if !seen.insert(im.key.as_str()) {
            continue;
        }
        let row = PieceRow {
            key: image_key(fp, &im.key),
            start: 0,
            end: 0,
            picture: Some(im.key.clone()),
        };
        out.push((row, im.url.clone().map(Input::Image)));
    }
    out
}

impl Service {
    fn load_manifests(&self) -> rusqlite::Result<()> {
        let st = self.store.lock().unwrap();
        let mut map = self.manifests.write().unwrap();
        for m in st.manifests()? {
            let items = st.items(m.id)?;
            map.insert(
                (m.source, m.r#ref),
                Arc::new(RwLock::new(Manifest {
                    id: m.id,
                    model: m.model,
                    items,
                    touched: m.used,
                })),
            );
        }
        Ok(())
    }

    fn gc(&self) {
        let r = self
            .store
            .lock()
            .unwrap()
            .gc(store::now() - store::MANIFEST_DAYS * 86400);
        match r {
            Ok((m, c)) => {
                if m > 0 {
                    self.manifests.write().unwrap().clear();
                    let _ = self.load_manifests();
                }
                if c > 0 {
                    self.models.write().unwrap().clear(); // read again from the store when next used
                }
                log(&self.paths, &format!("gc dropped {m} manifests, {c} vectors"));
            }
            Err(e) => log(&self.paths, &format!("gc: {e}")),
        }
    }

    /// The model's vectors in memory, read from the store the first time
    fn model(&self, fp: &str) -> Result<Arc<RwLock<ModelIndex>>, String> {
        if let Some(m) = self.models.read().unwrap().get(fp) {
            return Ok(m.clone());
        }
        let mut models = self.models.write().unwrap();
        if let Some(m) = models.get(fp) {
            return Ok(m.clone());
        }
        let st = self.store.lock().unwrap();
        let mut idx = ModelIndex::new(st.calibration(fp).map_err(|e| e.to_string())?);
        let mut rows = Vec::new();
        st.model_content(fp, |k, v| rows.push((k, if v.is_empty() { None } else { Some(v) })))
            .map_err(|e| e.to_string())?;
        if let Some((c, s)) = idx.add(rows) {
            st.set_calibration(fp, c, &s).map_err(|e| e.to_string())?;
        }
        let m = Arc::new(RwLock::new(idx));
        models.insert(fp.to_string(), m.clone());
        Ok(m)
    }

    fn connection(self: &Arc<Self>, conn: interprocess::local_socket::Stream) {
        let mut reader = BufReader::new(&conn);
        let mut writer = &conn;
        let mut line = String::new();
        let mut hello = false;
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => return,
                Ok(_) => {}
            }
            let req: Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(e) => {
                    let _ = writeln!(writer, "{}", json!({ "id": null, "error": format!("not JSON: {e}") }));
                    continue;
                }
            };
            let id = req.get("id").cloned().unwrap_or(Value::Null);
            let op = req.get("op").and_then(Value::as_str).unwrap_or("").to_string();
            let op = op.as_str();
            let reply: Reply = if !hello {
                if op == "hello" && req.get("token").and_then(Value::as_str) == Some(self.token.as_str()) {
                    hello = true;
                    Ok(json!({ "version": VERSION, "pid": std::process::id() }))
                } else {
                    Err("say hello with the token first".into())
                }
            } else {
                self.request(op, req)
            };
            let out = match reply {
                Ok(r) => json!({ "id": id, "result": r }),
                Err(e) => json!({ "id": id, "error": e }),
            };
            if writeln!(writer, "{out}").is_err() {
                return;
            }
            if !hello {
                return;
            }
        }
    }

    fn request(self: &Arc<Self>, op: &str, req: Value) -> Reply {
        fn parse<T: serde::de::DeserializeOwned>(v: Value) -> Result<T, String> {
            serde_json::from_value(v).map_err(|e| format!("bad request: {e}"))
        }
        match op {
            "hello" => Ok(json!({ "version": VERSION, "pid": std::process::id() })),
            "sync" => self.sync(parse(req)?),
            "search" => self.search(parse(req)?),
            "status" => self.status(parse(req)?),
            "forget" => self.forget(parse(req)?),
            _ => Err(format!("unknown op {op:?}")),
        }
    }

    fn sync(self: &Arc<Self>, r: SyncReq) -> Reply {
        let n = r.items.len();
        let mut sources = self.sources.lock().unwrap();
        let s = sources.entry(r.source.clone()).or_insert_with(|| Source {
            conf: r.embedder.clone(),
            embedder: Arc::new(Endpoint::new(r.embedder.clone())),
            pending: None,
            running: false,
            left: HashMap::new(),
            error: None,
        });
        if s.conf != r.embedder {
            s.conf = r.embedder.clone();
            s.embedder = Arc::new(Endpoint::new(r.embedder));
            s.error = None;
        }
        s.pending = Some(Job {
            r#ref: r.r#ref,
            items: r.items,
        });
        if !s.running {
            s.running = true;
            let me = self.clone();
            let source = r.source.clone();
            std::thread::spawn(move || me.worker(&source));
        }
        Ok(json!({ "accepted": n }))
    }

    /// One source's indexing: the latest sync, until none is waiting
    fn worker(self: &Arc<Self>, source: &str) {
        loop {
            let (job, emb) = {
                let mut sources = self.sources.lock().unwrap();
                let Some(s) = sources.get_mut(source) else {
                    return;
                };
                match s.pending.take() {
                    Some(j) if !self.stop.load(Ordering::SeqCst) => (j, s.embedder.clone()),
                    _ => {
                        s.running = false;
                        return;
                    }
                }
            };
            let r = job.r#ref.clone();
            let res = self.index(source, job, emb.as_ref());
            let mut sources = self.sources.lock().unwrap();
            if let Some(s) = sources.get_mut(source) {
                match res {
                    Ok(()) => s.error = None,
                    Err(e) => {
                        log(&self.paths, &format!("index {source} @ {r}: {e}"));
                        s.error = Some(e);
                    }
                }
            }
        }
    }

    /// Pieces left at a ref; after a batch went through (ok), the error of an earlier run is over
    fn set_left(&self, source: &str, r: &str, n: usize, ok: bool) {
        if let Some(s) = self.sources.lock().unwrap().get_mut(source) {
            s.left.insert(r.to_string(), n);
            if ok {
                s.error = None;
            }
        }
    }

    fn superseded(&self, source: &str) -> bool {
        self.stop.load(Ordering::SeqCst)
            || self
                .sources
                .lock()
                .unwrap()
                .get(source)
                .is_none_or(|s| s.pending.is_some())
    }

    fn index(&self, source: &str, job: Job, emb: &dyn Embedder) -> Result<(), String> {
        let fp = emb.fingerprint()?;
        let model = self.model(&fp)?;
        let key = (source.to_string(), job.r#ref.clone());
        let old: HashMap<String, ItemRow> = match self.manifests.read().unwrap().get(&key) {
            Some(m) => {
                let m = m.read().unwrap();
                if m.model == fp {
                    m.items.iter().map(|x| (x.id.clone(), x.clone())).collect()
                } else {
                    HashMap::new()
                }
            }
            None => HashMap::new(),
        };
        let mut rows = Vec::with_capacity(job.items.len());
        let mut changed = Vec::new();
        let mut seen_ids = HashSet::new();
        let items: Vec<&ItemIn> = job.items.iter().filter(|x| seen_ids.insert(x.id.as_str())).collect();
        for (i, it) in items.iter().enumerate() {
            let hash = item_hash(&fp, it);
            let meta = it
                .meta
                .as_ref()
                .map(|m| m.get().to_string())
                .unwrap_or_else(|| "null".into());
            match old.get(&it.id) {
                Some(o) if o.hash == hash => {
                    rows.push(ItemRow {
                        groups: it.groups.clone(),
                        meta,
                        ..o.clone()
                    });
                }
                _ => {
                    let pieces = pieces_of(&fp, it).into_iter().map(|x| x.0).collect();
                    rows.push(ItemRow {
                        id: it.id.clone(),
                        hash,
                        groups: it.groups.clone(),
                        meta,
                        pieces,
                    });
                    changed.push(i);
                }
            }
        }
        let id = self
            .store
            .lock()
            .unwrap()
            .write_manifest(source, &job.r#ref, &fp, &rows, &changed)
            .map_err(|e| e.to_string())?;
        // what still needs a vector, in the items' order (the client puts first what matters most)
        let mut need: Vec<(Key, Input)> = Vec::new();
        {
            let m = model.read().unwrap();
            let mut queued = HashSet::new();
            for (row, it) in rows.iter().zip(&items) {
                if row.pieces.iter().all(|p| m.has(&p.key)) {
                    continue;
                }
                for (p, input) in pieces_of(&fp, it) {
                    if let Some(input) = input
                        && !m.has(&p.key)
                        && queued.insert(p.key)
                    {
                        need.push((p.key, input));
                    }
                }
            }
        }
        self.manifests.write().unwrap().insert(
            key.clone(),
            Arc::new(RwLock::new(Manifest {
                id,
                model: fp.clone(),
                items: rows,
                touched: store::now(),
            })),
        );
        let mut left = need.len();
        self.set_left(source, &job.r#ref, left, false);
        // text in batches, each image on its own
        let mut i = 0;
        while i < need.len() {
            if self.superseded(source) {
                return Ok(());
            }
            let n = if matches!(need[i].1, Input::Image(_)) {
                1
            } else {
                need[i..]
                    .iter()
                    .take(BATCH)
                    .take_while(|x| matches!(x.1, Input::Text(_)))
                    .count()
            };
            let batch = &need[i..i + n];
            let inputs: Vec<Input> = batch.iter().map(|x| x.1.clone()).collect();
            let vecs = emb.embed(&inputs)?;
            let got: Vec<(Key, Option<Vec<f32>>)> = batch
                .iter()
                .zip(vecs)
                // an image the server gave nothing for is not written down: another server may take it
                .filter(|((_, input), v)| v.is_some() || matches!(input, Input::Text(_)))
                .map(|((k, _), v)| (*k, v))
                .collect();
            self.store
                .lock()
                .unwrap()
                .put_content(&fp, &got)
                .map_err(|e| e.to_string())?;
            if let Some((c, s)) = model.write().unwrap().add(got) {
                self.store
                    .lock()
                    .unwrap()
                    .set_calibration(&fp, c, &s)
                    .map_err(|e| e.to_string())?;
                log(&self.paths, &format!("{fp}: clip {c:.4}"));
            }
            i += n;
            left -= n;
            self.set_left(source, &job.r#ref, left, true);
        }
        Ok(())
    }

    fn query_vector(&self, fp: &str, emb: &dyn Embedder, q: &str) -> Result<Vec<f32>, String> {
        if let Some(v) = self
            .queries
            .lock()
            .unwrap()
            .iter()
            .find(|x| x.0 == fp && x.1 == q)
            .map(|x| x.2.clone())
        {
            return Ok(v);
        }
        let v = emb
            .embed(&[Input::Text(query_prompt(q))])?
            .pop()
            .flatten()
            .ok_or("The embedding server gave the query no vector")?;
        let mut c = self.queries.lock().unwrap();
        if c.len() >= QUERY_CACHE {
            c.pop_front();
        }
        c.push_back((fp.to_string(), q.to_string(), v.clone()));
        Ok(v)
    }

    fn search(&self, r: SearchReq) -> Reply {
        let (emb, error, left) = {
            let sources = self.sources.lock().unwrap();
            match sources.get(&r.source) {
                Some(s) => (
                    s.embedder.clone(),
                    s.error.clone(),
                    s.left.get(&r.r#ref).copied().unwrap_or(0),
                ),
                None => {
                    return Ok(json!({ "hits": [], "left": 0, "unsynced": true, "source": r.source, "ref": r.r#ref }));
                }
            }
        };
        let fail = |e: String| Ok(json!({ "hits": [], "left": left, "error": e, "source": r.source, "ref": r.r#ref }));
        let fp = match emb.fingerprint() {
            Ok(f) => f,
            Err(e) => return fail(e),
        };
        let Some(man) = self
            .manifests
            .read()
            .unwrap()
            .get(&(r.source.clone(), r.r#ref.clone()))
            .cloned()
        else {
            return Ok(
                json!({ "hits": [], "left": left, "error": error, "model": fp, "source": r.source, "ref": r.r#ref }),
            );
        };
        let qv = match self.query_vector(&fp, emb.as_ref(), &r.q) {
            Ok(v) => v,
            Err(e) => return fail(e),
        };
        let model = match self.model(&fp) {
            Ok(m) => m,
            Err(e) => return fail(e),
        };
        let hits = {
            let man = man.read().unwrap();
            if man.model != fp {
                vec![] // indexed by another model: the new one's index is on its way
            } else {
                let m = model.read().unwrap();
                search_in(&man.items, &m, &qv, &r, |k| {
                    self.store.lock().unwrap().vector(k).ok().flatten()
                })
            }
        };
        // kept while it is used: a manifest unused for MANIFEST_DAYS goes
        let stale = man.read().unwrap().touched < store::now() - TOUCH_EVERY;
        if stale {
            let mut m = man.write().unwrap();
            m.touched = store::now();
            let _ = self.store.lock().unwrap().touch(m.id);
        }
        Ok(json!({ "hits": hits, "left": left, "error": error, "model": fp, "source": r.source, "ref": r.r#ref }))
    }

    fn status(&self, r: StatusReq) -> Reply {
        let sources = self.sources.lock().unwrap();
        let s = sources.get(&r.source);
        let man = self
            .manifests
            .read()
            .unwrap()
            .get(&(r.source.clone(), r.r#ref.clone()))
            .cloned();
        let (items, pieces, model) = match &man {
            Some(m) => {
                let m = m.read().unwrap();
                (
                    m.items.len(),
                    m.items.iter().map(|x| x.pieces.len()).sum::<usize>(),
                    Some(m.model.clone()),
                )
            }
            None => (0, 0, None),
        };
        let vectors = match &model {
            Some(fp) => self.models.read().unwrap().get(fp).map(|m| m.read().unwrap().len()),
            None => None,
        };
        Ok(json!({
            "items": items,
            "pieces": pieces,
            "model": model,
            "vectors": vectors,
            "left": s.and_then(|s| s.left.get(&r.r#ref).copied()).unwrap_or(0),
            "indexing": s.is_some_and(|s| s.running),
            "error": s.and_then(|s| s.error.clone()),
            "synced": s.is_some(),
        }))
    }

    fn forget(&self, r: ForgetReq) -> Reply {
        self.sources.lock().unwrap().remove(&r.source);
        self.manifests.write().unwrap().retain(|k, _| k.0 != r.source);
        self.store
            .lock()
            .unwrap()
            .forget(&r.source)
            .map_err(|e| e.to_string())?;
        Ok(json!({}))
    }
}

/// The best k items for the query (raw unit vector) among the manifest's items in the asked groups: every visible piece
/// compared, the best RESCORE scored again from the stored f16 vector (vector), an item scored by its best piece
fn search_in(
    items: &[ItemRow],
    m: &ModelIndex,
    q: &[f32],
    r: &SearchReq,
    vector: impl Fn(&Key) -> Option<Vec<f32>>,
) -> Vec<Value> {
    let want: Option<HashSet<&str>> = r.groups.as_ref().map(|g| g.iter().map(String::as_str).collect());
    let mut at: Vec<(u32, u32)> = Vec::new(); // (item, piece)
    let mut rows: Vec<u32> = Vec::new();
    for (i, it) in items.iter().enumerate() {
        if let Some(w) = &want
            && !it.groups.iter().any(|g| w.contains(g.as_str()))
        {
            continue;
        }
        for (j, p) in it.pieces.iter().enumerate() {
            if let Some(row) = m.row(&p.key) {
                at.push((i as u32, j as u32));
                rows.push(row);
            }
        }
    }
    let k = r.k.unwrap_or(10);
    let qp = m.prepare(q);
    let scored: Vec<(usize, f32)> = if m.approximate() {
        let clip = m.clip.unwrap_or(0.0);
        let mut exact: HashMap<u32, f32> = HashMap::new();
        m.scan(&qp, &rows, RESCORE)
            .into_iter()
            .map(|(e, s)| {
                let row = rows[e];
                let s = *exact.entry(row).or_insert_with(|| {
                    let (i, j) = at[e];
                    vector(&items[i as usize].pieces[j as usize].key).map_or(s, |v| dot(&clipped(&v, clip), &qp))
                });
                (e, s)
            })
            .collect()
    } else {
        m.scan(&qp, &rows, rows.len())
    };
    let mut best: HashMap<u32, (f32, u32)> = HashMap::new();
    for (e, s) in scored {
        let (i, j) = at[e];
        let b = best.entry(i).or_insert((f32::MIN, j));
        if s > b.0 {
            *b = (s, j);
        }
    }
    let mut out: Vec<(u32, f32, u32)> = best.into_iter().map(|(i, (s, j))| (i, s, j)).collect();
    out.sort_by(|a, b| b.1.total_cmp(&a.1));
    out.into_iter()
        .filter(|x| r.min_score.is_none_or(|m| x.1 >= m))
        .take(k)
        .map(|(i, s, j)| {
            let it = &items[i as usize];
            let p = &it.pieces[j as usize];
            let meta: Value = serde_json::from_str(&it.meta).unwrap_or(Value::Null);
            let mut h = json!({ "id": it.id, "score": s, "piece": j, "meta": meta });
            match &p.picture {
                Some(pic) => h["picture"] = json!(pic),
                None => h["range"] = json!([p.start, p.end]),
            }
            h
        })
        .collect()
}

#[derive(Deserialize)]
struct SyncReq {
    source: String,
    r#ref: String,
    embedder: EndpointConfig,
    items: Vec<ItemIn>,
}

#[derive(Deserialize)]
pub struct SearchReq {
    source: String,
    r#ref: String,
    q: String,
    #[serde(default)]
    k: Option<usize>,
    #[serde(default)]
    groups: Option<Vec<String>>,
    #[serde(default)]
    min_score: Option<f32>,
}

#[derive(Deserialize)]
struct StatusReq {
    source: String,
    r#ref: String,
}

#[derive(Deserialize)]
struct ForgetReq {
    source: String,
}
