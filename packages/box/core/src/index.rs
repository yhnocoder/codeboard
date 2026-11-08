//! The index: everything box does, in one process. Clients hand it a source's items at a ref (sync); it cuts them into pieces
//! (chunk), embeds what it has not seen with the model the client names (embed), keeps content and per-source manifests in
//! SQLite (store) and searches the vectors in memory (vectors). Indexing runs in a background thread per source; a search
//! never waits for it and answers with what is indexed so far and how many pieces are left.
//!
//! The service (box serve) is a socket in front of one Index; an app with a single process opens one itself (the Node and
//! Swift bindings). One Index per data folder at a time: open takes a lock file in it.

use crate::chunk::{query_prompt, text_pieces};
use crate::embed::{BATCH, Embedder, Endpoint, EndpointConfig, Input};
use crate::graph::{self, Graph};
use crate::keyword::{self, Doc, Keywords, hid};
use crate::probe::Probed;
use crate::rerank::Remote;
use crate::store::{self, ItemRow, Key, PieceRow, Store, image_key, text_key};
use crate::vectors::{ModelIndex, RESCORE, clipped, dot};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::time::{Duration, Instant};

/// How often old manifests and unused content are deleted while open (and once at open)
const GC_EVERY: Duration = Duration::from_secs(24 * 3600);
/// Query vectors kept (the same query typed again, or asked again while indexing)
const QUERY_CACHE: usize = 64;
/// A manifest's last use is written at most this often (seconds)
const TOUCH_EVERY: i64 = 3600;
/// After a failed indexing run, the first pause before it runs again; it doubles up to RETRY_MAX
const RETRY_FIRST: Duration = Duration::from_secs(1);
const RETRY_MAX: Duration = Duration::from_secs(60);

/// The files of a data folder the index keeps
pub struct Files {
    pub home: PathBuf,
    /// The SQLite index
    pub db: PathBuf,
    /// The keyword group's full-text index (a folder)
    pub keywords: PathBuf,
    /// Held by the process that has the index open
    pub lock: PathBuf,
    pub log: PathBuf,
}

impl Files {
    pub fn of(home: &Path) -> Files {
        Files {
            home: home.to_path_buf(),
            db: home.join("index.db"),
            keywords: home.join("keywords"),
            lock: home.join("box.lock"),
            log: home.join("box.log"),
        }
    }
}

/// A line in the data folder's log (kept under 1 MB: a longer one starts again)
pub fn log(file: &Path, line: &str) {
    if std::fs::metadata(file).map(|m| m.len() > 1 << 20).unwrap_or(false) {
        let _ = std::fs::remove_file(file);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(file) {
        let _ = writeln!(f, "{} {line}", store::now());
    }
}

#[derive(Debug)]
pub enum OpenError {
    /// Another process has this data folder's index open
    Locked,
    Other(String),
}

impl std::fmt::Display for OpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OpenError::Locked => write!(f, "another process has this data folder open"),
            OpenError::Other(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for OpenError {}

/// The index of one data folder. Dropping it stops the background indexing (each worker ends after its current batch)
pub struct Index {
    inner: Arc<Inner>,
}

pub type Reply = Result<Value, String>;

impl Index {
    /// Opens the data folder's index (made if missing): takes its lock, deletes what is no longer used, reads the manifests
    pub fn open(home: &Path) -> Result<Index, OpenError> {
        let other = |e: &dyn std::fmt::Display| OpenError::Other(e.to_string());
        std::fs::create_dir_all(home).map_err(|e| other(&e))?;
        let files = Files::of(home);
        let lock = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&files.lock)
            .map_err(|e| other(&e))?;
        match lock.try_lock() {
            Ok(()) => {}
            Err(std::fs::TryLockError::WouldBlock) => return Err(OpenError::Locked),
            Err(std::fs::TryLockError::Error(e)) => return Err(other(&e)),
        }
        let mut st = Store::open(&files.db).map_err(|e| other(&e))?;
        let (m, c) = st
            .gc(store::now() - store::MANIFEST_DAYS * 86400)
            .map_err(|e| other(&e))?;
        let keywords = Keywords::open(&files.keywords).map_err(|e| other(&e))?;
        let k = keywords
            .retain(&st.item_hids().map_err(|e| other(&e))?)
            .map_err(|e| other(&e))?;
        log(
            &files.log,
            &format!(
                "open {} pid {}: gc dropped {m} manifests, {c} vectors, {k} keyword documents",
                crate::VERSION,
                std::process::id()
            ),
        );
        let inner = Arc::new(Inner {
            files,
            _lock: lock,
            store: Arc::new(Mutex::new(st)),
            keywords,
            reranks: Default::default(),
            models: RwLock::new(HashMap::new()),
            manifests: RwLock::new(HashMap::new()),
            sources: Mutex::new(HashMap::new()),
            wake: Condvar::new(),
            queries: Mutex::new(VecDeque::new()),
            stop: AtomicBool::new(false),
            gc_at: Mutex::new(Instant::now()),
        });
        inner.load_manifests().map_err(|e| other(&e))?;
        Ok(Index { inner })
    }

    pub fn files(&self) -> &Files {
        &self.inner.files
    }

    pub fn log(&self, line: &str) {
        self.inner.log(line);
    }

    /// One request as PROTOCOL.md has it: op and its fields as JSON, the answer's result or error
    pub fn request(&self, op: &str, req: Value) -> Reply {
        fn parse<T: serde::de::DeserializeOwned>(v: Value) -> Result<T, String> {
            serde_json::from_value(v).map_err(|e| format!("bad request: {e}"))
        }
        match op {
            "sync" => self.sync(parse(req)?),
            "search" => self.search(parse(req)?),
            "search_keyword" => self.search_keyword(parse(req)?),
            "status" => self.status(parse(req)?),
            "rerank" => self.inner.rerank(parse(req)?),
            "forget" => self.forget(parse(req)?),
            _ => Err(format!("unknown op {op:?}")),
        }
    }

    /// The whole set of a source's items at a ref; answers at once, indexing goes on in the background
    pub fn sync(&self, r: SyncReq) -> Reply {
        self.inner.sync(r)
    }

    /// Searches what is indexed now, never waiting for indexing
    pub fn search(&self, r: SearchReq) -> Reply {
        self.inner.search(r)
    }

    /// The keyword group: what is indexed now, never waiting, and needing no model
    pub fn search_keyword(&self, r: KeywordReq) -> Reply {
        self.inner.search_keyword(r)
    }

    pub fn status(&self, r: StatusReq) -> Reply {
        self.inner.status(r)
    }

    /// Every manifest of the source goes; indexing under way for it stops and writes nothing more
    pub fn forget(&self, r: ForgetReq) -> Reply {
        self.inner.forget(r)
    }
}

impl Drop for Index {
    fn drop(&mut self) {
        self.inner.stop.store(true, Ordering::SeqCst);
        // under the lock a waiting worker checks it with: it cannot miss the signal
        let _sources = self.inner.sources.lock().unwrap();
        self.inner.wake.notify_all();
    }
}

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
    /// The source's generation when it was synced: a forget since makes it stale
    generation: u64,
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
    /// The same server's reranker
    reranker: Arc<Remote>,
    pending: Option<Job>,
    running: bool,
    /// Pieces not embedded yet, per ref
    left: HashMap<String, usize>,
    error: Option<String>,
    /// One more on every forget: a job of an earlier generation stops and writes nothing
    generation: u64,
}

/// (source, ref) → its manifest
type Manifests = HashMap<(String, String), Arc<RwLock<Manifest>>>;

struct Inner {
    files: Files,
    /// Held while the index is open: one process per data folder
    _lock: std::fs::File,
    store: Arc<Mutex<Store>>,
    keywords: Keywords,
    /// The latest rerank of each source (an older one stops)
    reranks: crate::rerank::Latest,
    models: RwLock<HashMap<String, Arc<RwLock<ModelIndex>>>>,
    manifests: RwLock<Manifests>,
    sources: Mutex<HashMap<String, Source>>,
    /// Signalled with `sources` when a source's job changes (a sync, a forget) or the index stops: a worker waiting to retry
    /// wakes then, and sleeps otherwise (no polling)
    wake: Condvar,
    queries: Mutex<VecDeque<(String, String, Vec<f32>)>>,
    stop: AtomicBool,
    gc_at: Mutex<Instant>,
}

/// What an item was made from (title, text, images): the same hash, the same pieces under one model, the same keyword
/// document under any
fn item_hash(it: &ItemIn) -> Key {
    let mut h = blake3::Hasher::new();
    for part in [&it.title, &it.text] {
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

impl Inner {
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
                let st = self.store.lock().unwrap();
                let k = st
                    .item_hids()
                    .map_err(|e| e.to_string())
                    .and_then(|keep| self.keywords.retain(&keep).map_err(|e| e.to_string()));
                self.log(&format!(
                    "gc dropped {m} manifests, {c} vectors, {k:?} keyword documents"
                ));
            }
            Err(e) => self.log(&format!("gc: {e}")),
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
        drop(st);
        if idx.len() >= crate::graph::GRAPH_AT
            && let Ok(g) = Graph::load(&graph::file(&self.files.home, fp), idx.dim)
        {
            idx.attach(Arc::new(g));
        }
        let m = Arc::new(RwLock::new(idx));
        models.insert(fp.to_string(), m.clone());
        self.maybe_graph(fp, &m);
        Ok(m)
    }

    fn log(&self, line: &str) {
        log(&self.files.log, line);
    }

    /// Builds the model's graph in the background when it wants one (vectors::wants_graph), then saves it next to the store
    fn maybe_graph(&self, fp: &str, m: &Arc<RwLock<ModelIndex>>) {
        let src = {
            let mut w = m.write().unwrap();
            if !w.wants_graph() {
                return;
            }
            w.graph_pending = true;
            w.graph_source()
        };
        let (m, file, logf, fp) = (
            m.clone(),
            graph::file(&self.files.home, fp),
            self.files.log.clone(),
            fp.to_string(),
        );
        std::thread::spawn(move || {
            let t = Instant::now();
            match src.build() {
                Ok(g) => {
                    let n = g.len();
                    if let Err(e) = g.save(&file) {
                        log(&logf, &format!("{fp}: {e}"));
                    }
                    m.write().unwrap().attach(Arc::new(g));
                    log(&logf, &format!("{fp}: graph of {n} vectors built in {:?}", t.elapsed()));
                }
                // left pending: not tried again until the model is read again
                Err(e) => log(&logf, &format!("{fp}: {e}")),
            }
        });
    }

    /// Old manifests and unused content go once a day (and at open)
    fn maybe_gc(&self) {
        {
            let mut at = self.gc_at.lock().unwrap();
            if at.elapsed() < GC_EVERY {
                return;
            }
            *at = Instant::now();
        }
        self.gc();
    }

    fn sync(self: &Arc<Self>, r: SyncReq) -> Reply {
        self.maybe_gc();
        let n = r.items.len();
        let mut sources = self.sources.lock().unwrap();
        let s = sources.entry(r.source.clone()).or_insert_with(|| {
            let endpoint = Arc::new(Endpoint::new(r.embedder.clone()));
            Source {
                conf: r.embedder.clone(),
                embedder: Arc::new(Probed::new(endpoint.clone(), self.store.clone())),
                reranker: Arc::new(Remote::new(endpoint)),
                pending: None,
                running: false,
                left: HashMap::new(),
                error: None,
                generation: 0,
            }
        });
        if s.conf != r.embedder {
            s.conf = r.embedder.clone();
            let endpoint = Arc::new(Endpoint::new(r.embedder));
            s.embedder = Arc::new(Probed::new(endpoint.clone(), self.store.clone()));
            s.reranker = Arc::new(Remote::new(endpoint));
            s.error = None;
        }
        s.pending = Some(Job {
            r#ref: r.r#ref,
            items: r.items,
            generation: s.generation,
        });
        self.wake.notify_all();
        if !s.running {
            s.running = true;
            let me = self.clone();
            let source = r.source.clone();
            std::thread::spawn(move || me.worker(&source));
        }
        Ok(json!({ "accepted": n }))
    }

    /// One source's indexing: the latest sync, until none is waiting. A run that failed (the server restarted, timed out) is
    /// tried again after RETRY_FIRST, then twice as long each time up to RETRY_MAX, unless a newer sync comes first
    fn worker(self: &Arc<Self>, source: &str) {
        let mut wait = RETRY_FIRST;
        let mut retry: Option<Job> = None;
        loop {
            let (job, emb) = {
                let mut sources = self.sources.lock().unwrap();
                let Some(s) = sources.get_mut(source) else {
                    return;
                };
                let next = match s.pending.take() {
                    Some(j) => {
                        retry = None;
                        wait = RETRY_FIRST;
                        Some(j)
                    }
                    None => retry.take(),
                };
                match next {
                    Some(j) if !self.stop.load(Ordering::SeqCst) => (j, s.embedder.clone()),
                    _ => {
                        s.running = false;
                        return;
                    }
                }
            };
            let res = self.index(source, &job, emb.as_ref());
            {
                let mut sources = self.sources.lock().unwrap();
                let Some(s) = sources.get_mut(source) else {
                    return;
                };
                match res {
                    Ok(()) => {
                        s.error = None;
                        wait = RETRY_FIRST;
                        continue;
                    }
                    Err(e) => {
                        self.log(&format!("index {source} @ {}: {e} (again in {wait:?})", job.r#ref));
                        s.error = Some(e);
                    }
                }
            }
            let until = Instant::now() + wait;
            let mut sources = self.sources.lock().unwrap();
            loop {
                let now = Instant::now();
                if now >= until || self.superseded_in(&sources, source, &job) {
                    break;
                }
                sources = self.wake.wait_timeout(sources, until - now).unwrap().0;
            }
            drop(sources);
            retry = Some(job); // a stale one (forgotten since) writes nothing: index checks its generation
            wait = (wait * 2).min(RETRY_MAX);
        }
    }

    /// Pieces left at a ref; after a batch went through (ok), the error of an earlier run is over
    fn set_left(&self, source: &str, r: &str, n: usize, ok: bool) {
        if let Some(s) = self.sources.lock().unwrap().get_mut(source) {
            if !ok {
                s.left.clear(); // a new job: a ref it replaced is not being indexed any more
            }
            s.left.insert(r.to_string(), n);
            if ok {
                s.error = None;
            }
        }
    }

    /// Whether a job should stop: the service stops, a newer sync waits, or the source was forgotten since
    fn superseded(&self, source: &str, job: &Job) -> bool {
        self.superseded_in(&self.sources.lock().unwrap(), source, job)
    }
    fn superseded_in(&self, sources: &HashMap<String, Source>, source: &str, job: &Job) -> bool {
        self.stop.load(Ordering::SeqCst)
            || sources.get(source).is_none_or(|s| s.pending.is_some() || s.generation != job.generation)
    }

    fn index(&self, source: &str, job: &Job, emb: &dyn Embedder) -> Result<(), String> {
        let mut seen_ids = HashSet::new();
        let items: Vec<&ItemIn> = job.items.iter().filter(|x| seen_ids.insert(x.id.as_str())).collect();
        let hashes: Vec<Key> = items.iter().map(|it| item_hash(it)).collect();
        // the keyword group first: it needs no model, so it is there while the embedding server is not
        let docs: Vec<Doc> = items
            .iter()
            .zip(&hashes)
            .filter(|(_, h)| !self.keywords.has(hid(h)))
            .map(|(it, h)| Doc {
                hid: hid(h),
                title: &it.title,
                text: &it.text,
            })
            .collect();
        self.keywords.add(&docs).map_err(|e| format!("keyword index: {e}"))?;
        // no model (the server is down): the manifest is written all the same, keeping the pieces of what did not change,
        // and the run fails, to be tried again
        let fp = emb.fingerprint();
        let key = (source.to_string(), job.r#ref.clone());
        let (old_model, old): (String, HashMap<String, ItemRow>) = match self.manifests.read().unwrap().get(&key) {
            Some(m) => {
                let m = m.read().unwrap();
                let same = fp.as_ref().map_or(true, |f| *f == m.model);
                let old = if same {
                    m.items.iter().map(|x| (x.id.clone(), x.clone())).collect()
                } else {
                    HashMap::new()
                };
                (m.model.clone(), old)
            }
            None => (String::new(), HashMap::new()),
        };
        let model_name = fp.clone().unwrap_or(old_model);
        let mut rows = Vec::with_capacity(items.len());
        let mut changed = Vec::new();
        for (i, (it, hash)) in items.iter().zip(hashes).enumerate() {
            let meta = it
                .meta
                .as_ref()
                .map(|m| m.get().to_string())
                .unwrap_or_else(|| "null".into());
            match old.get(&it.id) {
                Some(o) if o.hash == hash && (fp.is_err() || !o.pieces.is_empty()) => {
                    rows.push(ItemRow {
                        groups: it.groups.clone(),
                        meta,
                        ..o.clone()
                    });
                }
                _ => {
                    let pieces = match &fp {
                        Ok(f) => pieces_of(f, it).into_iter().map(|x| x.0).collect(),
                        Err(_) => Vec::new(),
                    };
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
        // what still needs a vector, in the items' order (the client puts first what matters most)
        let mut need: Vec<(Key, Input)> = Vec::new();
        let model = match &fp {
            Ok(f) => Some(self.model(f)?),
            Err(_) => None,
        };
        if let (Some(model), Ok(fp)) = (&model, &fp) {
            let m = model.read().unwrap();
            let mut queued = HashSet::new();
            for (row, it) in rows.iter().zip(&items) {
                if row.pieces.iter().all(|p| m.has(&p.key)) {
                    continue;
                }
                for (p, input) in pieces_of(fp, it) {
                    if let Some(input) = input
                        && !m.has(&p.key)
                        && queued.insert(p.key)
                    {
                        need.push((p.key, input));
                    }
                }
            }
        }
        // written under the sources' lock, so a forget either comes first (and this job writes nothing) or after
        let sources = self.sources.lock().unwrap();
        if sources.get(source).is_none_or(|s| s.generation != job.generation) {
            return Ok(());
        }
        let id = self
            .store
            .lock()
            .unwrap()
            .write_manifest(source, &job.r#ref, &model_name, &rows, &changed)
            .map_err(|e| e.to_string())?;
        self.manifests.write().unwrap().insert(
            key.clone(),
            Arc::new(RwLock::new(Manifest {
                id,
                model: model_name,
                items: rows,
                touched: store::now(),
            })),
        );
        drop(sources);
        let fp = fp?;
        let Some(model) = model else {
            return Ok(());
        };
        let mut left = need.len();
        self.set_left(source, &job.r#ref, left, false);
        // text in batches, each image on its own
        let mut i = 0;
        while i < need.len() {
            if self.superseded(source, job) {
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
            let calibrated = model.write().unwrap().add(got);
            self.maybe_graph(&fp, &model);
            if let Some((c, s)) = calibrated {
                self.store
                    .lock()
                    .unwrap()
                    .set_calibration(&fp, c, &s)
                    .map_err(|e| e.to_string())?;
                self.log(&format!("{fp}: clip {c:.4}"));
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

    /// search, then its best text hits read again by the embedding server's reranker and the list in the fused order
    /// (rerank.rs); each text hit it read gets the server's score as `rerank`. The query's vector comes from the cache the
    /// search before it filled (query_vector), so a rerank embeds nothing
    fn rerank(&self, r: RerankReq) -> Reply {
        let RerankReq { search: r, model } = r;
        let (source, rf, q) = (r.source.clone(), r.r#ref.clone(), r.q.clone());
        let ticket = self.reranks.begin(&source);
        let live = || self.reranks.live(&source, ticket);
        let superseded = || Ok(json!({ "hits": [], "superseded": true, "source": source, "ref": rf }));
        let mut out = self.search(r)?;
        let hits: Vec<Value> = out["hits"].as_array().cloned().unwrap_or_default();
        if hits.is_empty() || out.get("error").is_some_and(|e| !e.is_null()) {
            return Ok(out);
        }
        let n = hits.len().min(crate::rerank::RERANK_TOP);
        let texts: Vec<Option<String>> = {
            let man = self
                .manifests
                .read()
                .unwrap()
                .get(&(source.clone(), rf.clone()))
                .cloned();
            let Some(man) = man else { return Ok(out) };
            let man = man.read().unwrap();
            let by_id: HashMap<&str, &ItemRow> = man.items.iter().map(|x| (x.id.as_str(), x)).collect();
            hits[..n]
                .iter()
                .map(|h| {
                    if h.get("picture").is_some() {
                        return None;
                    }
                    let it = by_id.get(h["id"].as_str()?)?;
                    let (title, text) = self.keywords.doc_text(hid(&it.hash))?;
                    Some(if title.trim().is_empty() {
                        text
                    } else {
                        format!("{title}\n{text}")
                    })
                })
                .collect()
        };
        if !live() {
            return superseded();
        }
        let reranker = match self.sources.lock().unwrap().get(&source) {
            Some(s) => s.reranker.clone(),
            None => return Ok(out),
        };
        let want: Vec<String> = texts.iter().flatten().cloned().collect();
        let got = if want.is_empty() {
            Ok(vec![])
        } else {
            reranker.score(model.as_deref(), &q, &want)
        };
        // a newer rerank of this source came in while the server read this one: that one's order is the one to show
        if !live() {
            return superseded();
        }
        let mut got = got?.into_iter();
        let scores: Vec<Option<f32>> = texts.iter().map(|t| t.as_ref().and_then(|_| got.next())).collect();
        let vector: Vec<f32> = hits[..n]
            .iter()
            .map(|h| h["score"].as_f64().unwrap_or(0.0) as f32)
            .collect();
        let order = crate::rerank::fuse(&vector, &scores, crate::rerank::FUSE_W);
        let mut ordered: Vec<Value> = order
            .into_iter()
            .map(|i| {
                let mut h = hits[i].clone();
                if let Some(s) = scores[i] {
                    h["rerank"] = json!(s);
                }
                h
            })
            .collect();
        ordered.extend(hits[n..].iter().cloned());
        out["hits"] = Value::Array(ordered);
        out["reranked"] = json!(n);
        Ok(out)
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
        self.touch(&man);
        Ok(json!({ "hits": hits, "left": left, "error": error, "model": fp, "source": r.source, "ref": r.r#ref }))
    }

    fn search_keyword(&self, r: KeywordReq) -> Reply {
        let Some(man) = self
            .manifests
            .read()
            .unwrap()
            .get(&(r.source.clone(), r.r#ref.clone()))
            .cloned()
        else {
            return Ok(json!({ "hits": [], "source": r.source, "ref": r.r#ref }));
        };
        let hits = {
            let man = man.read().unwrap();
            let want: Option<HashSet<&str>> = r.groups.as_ref().map(|g| g.iter().map(String::as_str).collect());
            let mut at: HashMap<keyword::Hid, Vec<usize>> = HashMap::new();
            for (i, it) in man.items.iter().enumerate() {
                if want
                    .as_ref()
                    .is_none_or(|w| it.groups.iter().any(|g| w.contains(g.as_str())))
                {
                    at.entry(hid(&it.hash)).or_default().push(i);
                }
            }
            let visible = Arc::new(at.keys().copied().collect());
            let found = self.keywords.search(&r.q, visible).map_err(|e| e.to_string())?;
            let mut hits = Vec::new();
            'out: for f in found {
                for &i in at.get(&f.hid).into_iter().flatten() {
                    if hits.len() >= r.k.unwrap_or(10) {
                        break 'out;
                    }
                    let it = &man.items[i];
                    let meta: Value = serde_json::from_str(&it.meta).unwrap_or(Value::Null);
                    let mut h = json!({ "id": it.id, "score": f.score, "meta": meta });
                    if let Some((a, b)) = f.range {
                        h["range"] = json!([a, b]);
                    }
                    hits.push(h);
                }
            }
            hits
        };
        self.touch(&man);
        Ok(json!({ "hits": hits, "source": r.source, "ref": r.r#ref }))
    }

    /// Kept while it is used: a manifest unused for MANIFEST_DAYS goes
    fn touch(&self, man: &RwLock<Manifest>) {
        let stale = man.read().unwrap().touched < store::now() - TOUCH_EVERY;
        if stale {
            let mut m = man.write().unwrap();
            m.touched = store::now();
            let _ = self.store.lock().unwrap().touch(m.id);
        }
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
                    Some(m.model.clone()).filter(|m| !m.is_empty()),
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
        // under the sources' lock (as index writes a manifest): a job running now writes nothing more
        let mut sources = self.sources.lock().unwrap();
        if let Some(s) = sources.get_mut(&r.source) {
            if s.running {
                // its worker keeps running (a sync coming next reuses it) and drops its stale job
                s.generation += 1;
                s.pending = None;
                s.left.clear();
                s.error = None;
                self.wake.notify_all();
            } else {
                sources.remove(&r.source);
            }
        }
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
        m.candidates(&qp, &rows, RESCORE)
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
pub struct SyncReq {
    pub source: String,
    pub r#ref: String,
    pub embedder: EndpointConfig,
    pub items: Vec<ItemIn>,
}

#[derive(Deserialize)]
pub struct SearchReq {
    pub source: String,
    pub r#ref: String,
    pub q: String,
    #[serde(default)]
    pub k: Option<usize>,
    #[serde(default)]
    pub groups: Option<Vec<String>>,
    #[serde(default)]
    pub min_score: Option<f32>,
}

#[derive(Deserialize)]
pub struct RerankReq {
    #[serde(flatten)]
    pub search: SearchReq,
    /// The reranking model on the embedding server; none: the first it lists with "rerank" in its id
    #[serde(default)]
    pub model: Option<String>,
}

#[derive(Deserialize)]
pub struct KeywordReq {
    pub source: String,
    pub r#ref: String,
    pub q: String,
    #[serde(default)]
    pub k: Option<usize>,
    #[serde(default)]
    pub groups: Option<Vec<String>>,
}

#[derive(Deserialize)]
pub struct StatusReq {
    pub source: String,
    pub r#ref: String,
}

#[derive(Deserialize)]
pub struct ForgetReq {
    pub source: String,
}
