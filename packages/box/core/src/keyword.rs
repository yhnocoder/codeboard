//! The keyword group: a full-text index (tantivy) beside the vectors, searched on its own and answered as its own group (no
//! fusion with the meaning group). Content is kept once by the item's hash, like the vectors: a document holds an item's
//! title and text, and which items a search sees comes from the manifests (the hashes of the items of a source at a ref),
//! checked per document by a fast field. Switching branch changes nothing here; content no manifest has goes at gc.
//!
//! Fields: title and text cut into identifiers and CJK characters (identifiers as the whole and its parts,
//! BlockManager.deallocate → blockmanager.deallocate, blockmanager, deallocate, block, manager; Chinese, Japanese and
//! Korean as single characters and pairs); words: jieba's words for CJK text (ranking only); grams: three-letter grams
//! of the words, for half a word (comp-boun finds compute-bound). A query term matches exactly, by prefix (sched…), within
//! one edit from the fifth letter on (dealoc → dealloc), or by its grams; a run of CJK characters by most of its pairs.

use crate::chunk::utf16_at;
use std::collections::HashSet;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use tantivy::collector::{FilterCollector, TopDocs};
use tantivy::query::{BooleanQuery, BoostQuery, FuzzyTermQuery, Occur, Query, TermQuery};
use tantivy::schema::{
    FAST, Field, INDEXED, IndexRecordOption, STORED, Schema, TantivyDocument, TextFieldIndexing, TextOptions, Value,
};
use tantivy::tokenizer::{LowerCaser, NgramTokenizer, TextAnalyzer, Token, TokenStream, Tokenizer};
use tantivy::{DocAddress, Index, IndexReader, IndexWriter, ReloadPolicy, Term, doc};

/// Memory the writer may use before it flushes a segment
const WRITER_HEAP: usize = 15 << 20;
/// Documents a search looks at before it maps them to items (several items may share one)
const MAX_DOCS: usize = 1000;
/// Grams of a word for half-word matches
const GRAM: usize = 3;

pub type Hid = u64;

/// The id a document is kept under: the first 8 bytes of the item's hash
pub fn hid(hash: &[u8; 32]) -> Hid {
    u64::from_le_bytes(hash[..8].try_into().unwrap())
}

fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x3040..=0x30ff | 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xf900..=0xfaff | 0xac00..=0xd7af | 0x20000..=0x2ffff)
}
fn is_word(c: char) -> bool {
    (c.is_alphanumeric() || c == '_') && !is_cjk(c)
}
fn is_joiner(c: char) -> bool {
    matches!(c, '.' | ':' | '-' | '/')
}

/// A run of the text: an identifier (with its byte range) or a run of CJK characters
enum Run<'a> {
    Ident(usize, &'a str),
    Cjk(usize, &'a str),
}

fn runs(text: &str) -> Vec<Run<'_>> {
    let mut out = Vec::new();
    let cs: Vec<(usize, char)> = text.char_indices().collect();
    let mut i = 0;
    while i < cs.len() {
        let (at, c) = cs[i];
        if is_cjk(c) {
            let mut j = i;
            while j < cs.len() && is_cjk(cs[j].1) {
                j += 1;
            }
            let end = cs.get(j).map_or(text.len(), |x| x.0);
            out.push(Run::Cjk(at, &text[at..end]));
            i = j;
        } else if is_word(c) {
            let mut j = i;
            while j < cs.len()
                && (is_word(cs[j].1) || (is_joiner(cs[j].1) && cs.get(j + 1).is_some_and(|x| is_word(x.1))))
            {
                j += 1;
            }
            let end = cs.get(j).map_or(text.len(), |x| x.0);
            out.push(Run::Ident(at, &text[at..end]));
            i = j;
        } else {
            i += 1;
        }
    }
    out
}

/// An identifier's segments (split at . : - /) and parts (segments split at _ and camelCase), lowercased, without repeats;
/// the whole first
fn ident_terms(id: &str) -> (String, Vec<String>, Vec<String>) {
    let whole = id.to_lowercase();
    let segments: Vec<&str> = id.split(is_joiner).filter(|s| !s.is_empty()).collect();
    let mut parts = Vec::new();
    for s in &segments {
        for p in s.split('_').filter(|p| !p.is_empty()) {
            parts.extend(camel(p));
        }
    }
    let lower = |v: Vec<&str>| {
        let mut seen = HashSet::new();
        v.into_iter()
            .map(str::to_lowercase)
            .filter(|x| seen.insert(x.clone()))
            .collect::<Vec<_>>()
    };
    (whole, lower(segments), lower(parts))
}

/// camelCase and HTTPServer cut into their words (digits stay with their letters)
fn camel(s: &str) -> Vec<&str> {
    let cs: Vec<(usize, char)> = s.char_indices().collect();
    let mut out = Vec::new();
    let mut start = 0;
    for k in 1..cs.len() {
        let (prev, c) = (cs[k - 1].1, cs[k].1);
        let next_lower = cs.get(k + 1).is_some_and(|x| x.1.is_lowercase());
        if (prev.is_lowercase() && c.is_uppercase()) || (prev.is_uppercase() && c.is_uppercase() && next_lower) {
            out.push(&s[start..cs[k].0]);
            start = cs[k].0;
        }
    }
    out.push(&s[start..]);
    out
}

fn tok(text: String, from: usize, to: usize, position: usize) -> Token {
    Token {
        offset_from: from,
        offset_to: to,
        position,
        text,
        position_length: 1,
    }
}

/// title and text: identifiers (the whole and every segment and part at one position), CJK characters and their pairs
fn main_tokens(text: &str) -> Vec<Token> {
    let mut out = Vec::new();
    let mut pos = 0;
    for r in runs(text) {
        match r {
            Run::Ident(at, id) => {
                let (whole, segs, parts) = ident_terms(id);
                let mut seen = HashSet::new();
                for t in std::iter::once(whole).chain(segs).chain(parts) {
                    if seen.insert(t.clone()) {
                        out.push(tok(t, at, at + id.len(), pos));
                    }
                }
                pos += 1;
            }
            Run::Cjk(at, run) => {
                let cs: Vec<(usize, char)> = run.char_indices().collect();
                for (k, &(o, c)) in cs.iter().enumerate() {
                    let end = o + c.len_utf8();
                    out.push(tok(c.to_string(), at + o, at + end, pos));
                    if let Some(&(o2, c2)) = cs.get(k + 1) {
                        out.push(tok(format!("{c}{c2}"), at + o, at + o2 + c2.len_utf8(), pos));
                    }
                    pos += 1;
                }
            }
        }
    }
    out
}

fn jieba() -> &'static jieba_rs::Jieba {
    static J: OnceLock<jieba_rs::Jieba> = OnceLock::new();
    J.get_or_init(jieba_rs::Jieba::new)
}

/// words: jieba's words of each CJK run (loaded the first time CJK text comes)
fn word_tokens(text: &str) -> Vec<Token> {
    let mut out = Vec::new();
    for r in runs(text) {
        if let Run::Cjk(at, run) = r {
            for w in jieba().cut(run, false) {
                if w.word.chars().count() > 1 {
                    out.push(tok(w.word.to_string(), at + w.byte_start, at + w.byte_end, out.len()));
                }
            }
        }
    }
    out
}

/// The words a document's grams are made from: its identifiers' segments and parts of GRAM letters or more
fn gram_words(texts: &[&str]) -> String {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for t in texts {
        for r in runs(t) {
            if let Run::Ident(_, id) = r {
                let (_, segs, parts) = ident_terms(id);
                for w in segs.into_iter().chain(parts) {
                    if w.chars().count() >= GRAM && seen.insert(w.clone()) {
                        out.push(w);
                    }
                }
            }
        }
    }
    out.join(" ")
}

fn grams(w: &str) -> Vec<String> {
    let cs: Vec<char> = w.chars().collect();
    cs.windows(GRAM).map(|g| g.iter().collect()).collect()
}

/// A tokenizer from a function of the text
#[derive(Clone)]
struct FnTokenizer(fn(&str) -> Vec<Token>);

struct Tokens {
    all: Vec<Token>,
    at: usize,
}

impl TokenStream for Tokens {
    fn advance(&mut self) -> bool {
        self.at += 1;
        self.at <= self.all.len()
    }
    fn token(&self) -> &Token {
        &self.all[self.at - 1]
    }
    fn token_mut(&mut self) -> &mut Token {
        &mut self.all[self.at - 1]
    }
}

impl Tokenizer for FnTokenizer {
    type TokenStream<'a> = Tokens;
    fn token_stream<'a>(&'a mut self, text: &'a str) -> Tokens {
        Tokens {
            all: (self.0)(text),
            at: 0,
        }
    }
}

struct Fields {
    hid: Field,
    title: Field,
    text: Field,
    words: Field,
    grams: Field,
}

pub struct Keywords {
    f: Fields,
    writer: Mutex<IndexWriter>,
    reader: IndexReader,
    /// The documents there are
    have: RwLock<HashSet<Hid>>,
}

/// A document to add: its id, title and text
pub struct Doc<'a> {
    pub hid: Hid,
    pub title: &'a str,
    pub text: &'a str,
}

/// A document a search found: its id, score, and where in the text the first query word is (UTF-16)
#[derive(Debug, Clone, PartialEq)]
pub struct Found {
    pub hid: Hid,
    pub score: f32,
    pub range: Option<(u32, u32)>,
}

fn text_field(tokenizer: &str, positions: bool, stored: bool) -> TextOptions {
    let rec = if positions {
        IndexRecordOption::WithFreqsAndPositions
    } else {
        IndexRecordOption::WithFreqs
    };
    let o = TextOptions::default().set_indexing_options(
        TextFieldIndexing::default()
            .set_tokenizer(tokenizer)
            .set_index_option(rec),
    );
    if stored { o.set_stored() } else { o }
}

fn schema() -> (Schema, Fields) {
    let mut s = Schema::builder();
    let f = Fields {
        hid: s.add_u64_field("hid", INDEXED | FAST | STORED),
        title: s.add_text_field("title", text_field("box", true, true)),
        text: s.add_text_field("text", text_field("box", true, true)),
        words: s.add_text_field("words", text_field("box_words", false, false)),
        grams: s.add_text_field("grams", text_field("box_grams", false, false)),
    };
    (s.build(), f)
}

impl Keywords {
    /// Opens the index in `dir`, made if missing; one that cannot be read is made again (it is a cache of what syncs bring)
    pub fn open(dir: &Path) -> tantivy::Result<Keywords> {
        let (schema, f) = schema();
        let index = match Self::open_dir(dir, &schema) {
            Ok(i) => i,
            Err(_) => {
                let _ = std::fs::remove_dir_all(dir);
                Self::open_dir(dir, &schema)?
            }
        };
        let t = index.tokenizers();
        t.register("box", TextAnalyzer::from(FnTokenizer(main_tokens)));
        t.register("box_words", TextAnalyzer::from(FnTokenizer(word_tokens)));
        t.register(
            "box_grams",
            TextAnalyzer::builder(NgramTokenizer::new(GRAM, GRAM, false)?)
                .filter(LowerCaser)
                .build(),
        );
        let writer = index.writer_with_num_threads(1, WRITER_HEAP)?;
        let reader = index.reader_builder().reload_policy(ReloadPolicy::Manual).try_into()?;
        let mut have = HashSet::new();
        for seg in reader.searcher().segment_readers() {
            let col = seg.fast_fields().u64("hid")?;
            for d in seg.doc_ids_alive() {
                if let Some(v) = col.first(d) {
                    have.insert(v);
                }
            }
        }
        Ok(Keywords {
            f,
            writer: Mutex::new(writer),
            reader,
            have: RwLock::new(have),
        })
    }

    fn open_dir(dir: &Path, schema: &Schema) -> tantivy::Result<Index> {
        std::fs::create_dir_all(dir)?;
        let d = tantivy::directory::MmapDirectory::open(dir)?;
        let index = Index::open_or_create(d, schema.clone())?;
        if index.schema() != *schema {
            return Err(tantivy::TantivyError::SchemaError("another schema".into()));
        }
        Ok(index)
    }

    /// A document's title and text (what the reranker reads)
    pub fn doc_text(&self, h: Hid) -> Option<(String, String)> {
        let searcher = self.reader.searcher();
        let q = TermQuery::new(Term::from_field_u64(self.f.hid, h), IndexRecordOption::Basic);
        let top: Vec<(f32, DocAddress)> = searcher.search(&q, &TopDocs::with_limit(1).order_by_score()).ok()?;
        let d: TantivyDocument = searcher.doc(top.first()?.1).ok()?;
        let get = |f| d.get_first(f).and_then(|v| v.as_str()).unwrap_or("").to_string();
        Some((get(self.f.title), get(self.f.text)))
    }

    pub fn has(&self, h: Hid) -> bool {
        self.have.read().unwrap().contains(&h)
    }

    pub fn len(&self) -> usize {
        self.have.read().unwrap().len()
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Adds the documents not there yet and commits (searches see them at once)
    pub fn add(&self, docs: &[Doc]) -> tantivy::Result<usize> {
        let mut w = self.writer.lock().unwrap();
        let mut added = Vec::new();
        {
            let have = self.have.read().unwrap();
            let mut seen = HashSet::new();
            for d in docs {
                if have.contains(&d.hid) || !seen.insert(d.hid) {
                    continue;
                }
                w.add_document(doc!(
                    self.f.hid => d.hid,
                    self.f.title => d.title,
                    self.f.text => d.text,
                    self.f.words => format!("{}\n{}", d.title, d.text),
                    self.f.grams => gram_words(&[d.title, d.text]),
                ))?;
                added.push(d.hid);
            }
        }
        if added.is_empty() {
            return Ok(0);
        }
        w.commit()?;
        self.reader.reload()?;
        self.have.write().unwrap().extend(added.iter().copied());
        Ok(added.len())
    }

    /// Deletes the documents not in `keep`. Answers how many went
    pub fn retain(&self, keep: &HashSet<Hid>) -> tantivy::Result<usize> {
        let mut w = self.writer.lock().unwrap();
        let gone: Vec<Hid> = self
            .have
            .read()
            .unwrap()
            .iter()
            .filter(|h| !keep.contains(h))
            .copied()
            .collect();
        if gone.is_empty() {
            return Ok(0);
        }
        for h in &gone {
            w.delete_term(Term::from_field_u64(self.f.hid, *h));
        }
        w.commit()?;
        self.reader.reload()?;
        let mut have = self.have.write().unwrap();
        for h in &gone {
            have.remove(h);
        }
        Ok(gone.len())
    }

    fn query(&self, q: &str) -> Option<Box<dyn Query>> {
        let f = &self.f;
        let term = |field: Field, t: &str| Term::from_field_text(field, t);
        let exact = |t: &str, boost: f32| -> Box<dyn Query> {
            let tq = |field| Box::new(TermQuery::new(term(field, t), IndexRecordOption::WithFreqs)) as Box<dyn Query>;
            Box::new(BoostQuery::new(
                Box::new(BooleanQuery::new(vec![
                    (Occur::Should, tq(f.text)),
                    (Occur::Should, Box::new(BoostQuery::new(tq(f.title), 2.0))),
                ])),
                boost,
            ))
        };
        let all = |qs: Vec<Box<dyn Query>>| -> Box<dyn Query> {
            Box::new(BooleanQuery::new(qs.into_iter().map(|x| (Occur::Must, x)).collect()))
        };
        let mut units: Vec<Box<dyn Query>> = Vec::new();
        for r in runs(q) {
            match r {
                Run::Ident(_, id) => {
                    let (whole, segs, parts) = ident_terms(id);
                    let mut any: Vec<Box<dyn Query>> = vec![exact(&whole, 3.0)];
                    if segs.len() > 1 {
                        any.push(all(segs.iter().map(|s| exact(s, 2.0)).collect()));
                    }
                    if parts.len() > 1 {
                        any.push(all(parts.iter().map(|s| exact(s, 1.5)).collect()));
                    }
                    let n = whole.chars().count();
                    if n >= GRAM {
                        let d = if n >= 5 { 1 } else { 0 };
                        for field in [f.text, f.title] {
                            any.push(Box::new(FuzzyTermQuery::new_prefix(term(field, &whole), d, true)));
                        }
                    }
                    let gs: Vec<Box<dyn Query>> = segs
                        .iter()
                        .flat_map(|s| grams(s))
                        .map(|g| {
                            Box::new(TermQuery::new(term(f.grams, &g), IndexRecordOption::Basic)) as Box<dyn Query>
                        })
                        .collect();
                    if gs.len() >= 2 {
                        any.push(Box::new(BoostQuery::new(all(gs), 0.5)));
                    }
                    units.push(Box::new(BooleanQuery::new(
                        any.into_iter().map(|x| (Occur::Should, x)).collect(),
                    )));
                }
                Run::Cjk(_, run) => {
                    let cs: Vec<char> = run.chars().collect();
                    let keys: Vec<String> = if cs.len() == 1 {
                        vec![run.to_string()]
                    } else {
                        cs.windows(2).map(|w| w.iter().collect()).collect()
                    };
                    let need = (keys.len() * 2).div_ceil(3).max(1);
                    let pairs = BooleanQuery::with_minimum_required_clauses(
                        keys.iter().map(|k| (Occur::Should, exact(k, 1.0))).collect(),
                        need,
                    );
                    let mut unit: Vec<(Occur, Box<dyn Query>)> = vec![(Occur::Must, Box::new(pairs))];
                    for w in jieba().cut(run, false) {
                        if w.word.chars().count() > 1 {
                            let tq = TermQuery::new(term(f.words, w.word), IndexRecordOption::WithFreqs);
                            unit.push((Occur::Should, Box::new(tq)));
                        }
                    }
                    units.push(Box::new(BooleanQuery::new(unit)));
                }
            }
        }
        if units.is_empty() {
            return None;
        }
        Some(all(units))
    }

    /// The best documents for the query among `visible`, best first, at most MAX_DOCS
    pub fn search(&self, q: &str, visible: Arc<HashSet<Hid>>) -> tantivy::Result<Vec<Found>> {
        let Some(query) = self.query(q) else {
            return Ok(Vec::new());
        };
        let searcher = self.reader.searcher();
        let v = visible.clone();
        let c = FilterCollector::new(
            "hid".to_string(),
            move |h: u64| v.contains(&h),
            TopDocs::with_limit(MAX_DOCS).order_by_score(),
        );
        let top: Vec<(f32, DocAddress)> = searcher.search(&*query, &c)?;
        let words = query_words(q);
        let mut out = Vec::with_capacity(top.len());
        for (score, at) in top {
            let d: TantivyDocument = searcher.doc(at)?;
            let Some(h) = d.get_first(self.f.hid).and_then(|v| v.as_u64()) else {
                continue;
            };
            let text = d.get_first(self.f.text).and_then(|v| v.as_str()).unwrap_or("");
            out.push(Found {
                hid: h,
                score,
                range: first_match(text, &words),
            });
        }
        Ok(out)
    }
}

/// What a hit's range points at: the query's identifiers and CJK runs, lowercased
fn query_words(q: &str) -> Vec<String> {
    runs(q)
        .into_iter()
        .map(|r| match r {
            Run::Ident(_, s) | Run::Cjk(_, s) => s.to_lowercase(),
        })
        .collect()
}

/// The first place in the text where one of the words is (ignoring case), as UTF-16 offsets
fn first_match(text: &str, words: &[String]) -> Option<(u32, u32)> {
    let lower = text.to_lowercase();
    let same = lower.len() == text.len(); // lowercasing kept every byte offset
    let hay = if same { lower.as_str() } else { text };
    words
        .iter()
        .filter_map(|w| hay.find(w.as_str()).map(|a| (a, a + w.len())))
        .min()
        .map(|(a, b)| (utf16_at(text, a), utf16_at(text, b)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(ts: &[Token]) -> Vec<&str> {
        ts.iter().map(|t| t.text.as_str()).collect()
    }

    #[test]
    fn identifiers_are_kept_whole_and_in_parts_and_cjk_as_characters_and_pairs() {
        assert_eq!(
            texts(&main_tokens("BlockManager.deallocate(x)")),
            [
                "blockmanager.deallocate",
                "blockmanager",
                "deallocate",
                "block",
                "manager",
                "x"
            ]
        );
        assert_eq!(
            texts(&main_tokens("kv_cache HTTPServer")),
            ["kv_cache", "kv", "cache", "httpserver", "http", "server"]
        );
        assert_eq!(
            texts(&main_tokens("计算受限")),
            ["计", "计算", "算", "算受", "受", "受限", "限"]
        );
        assert_eq!(texts(&main_tokens("end.")), ["end"]);
        assert!(texts(&word_tokens("计算受限的判断")).contains(&"判断"));
        assert_eq!(gram_words(&["compute-bound", "x Scheduler"]), "compute bound scheduler");
    }

    fn open() -> (std::path::PathBuf, Keywords) {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("box-kw-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let k = Keywords::open(&dir).unwrap();
        (dir, k)
    }

    const DOCS: [(u64, &str, &str); 6] = [
        (
            1,
            "BlockManager",
            "BlockManager.deallocate frees the kv cache blocks of a finished sequence.",
        ),
        (2, "Scheduler", "The scheduler picks prefill or decode for each step."),
        (3, "计算受限的判断", "decode 阶段通常是访存受限，prefill 是计算受限。"),
        (
            4,
            "Roofline",
            "A kernel is compute-bound when its arithmetic intensity is high.",
        ),
        (5, "显存", "KV cache 占用的显存随序列长度增长。"),
        (6, "Graphs", "CUDA graphs are captured once per batch size."),
    ];

    fn ids(k: &Keywords, q: &str, visible: &[u64]) -> Vec<u64> {
        k.search(q, Arc::new(visible.iter().copied().collect()))
            .unwrap()
            .into_iter()
            .map(|f| f.hid)
            .collect()
    }

    #[test]
    fn finds_identifiers_chinese_prefixes_typos_and_half_words_among_the_visible() {
        let (dir, k) = open();
        let docs: Vec<Doc> = DOCS
            .iter()
            .map(|(h, t, x)| Doc {
                hid: *h,
                title: t,
                text: x,
            })
            .collect();
        assert_eq!(k.add(&docs).unwrap(), 6);
        assert_eq!(k.add(&docs[..2]).unwrap(), 0);
        let all: Vec<u64> = (1..=6).collect();
        // identifiers: the whole, a segment, a part
        assert_eq!(ids(&k, "BlockManager.deallocate", &all), [1]);
        assert_eq!(ids(&k, "deallocate", &all), [1]);
        assert_eq!(ids(&k, "block manager", &all), [1]);
        // a prefix while typing, a typo, half words
        assert_eq!(ids(&k, "sched", &all), [2]);
        assert_eq!(ids(&k, "dealocate", &all), [1]);
        assert_eq!(ids(&k, "comp-boun", &all), [4]);
        // Chinese: a word inside a sentence, mixed with English, the title first
        assert_eq!(ids(&k, "计算受限", &all), [3]);
        assert_eq!(ids(&k, "显存", &all)[0], 5);
        assert_eq!(ids(&k, "kv cache 显存", &all), [5]);
        assert!(ids(&k, "访存", &all).contains(&3));
        // only what is visible, and nothing for what no document has
        assert_eq!(ids(&k, "kv cache", &[2, 5]), [5]);
        assert!(ids(&k, "tensor parallel", &all).is_empty());
        assert!(ids(&k, "  ", &all).is_empty());
        // where the match is, in UTF-16
        let f = k.search("deallocate", Arc::new([1].into_iter().collect())).unwrap();
        assert_eq!(f[0].range, Some((13, 23)));
        let f = k.search("显存", Arc::new([5].into_iter().collect())).unwrap();
        assert_eq!(f[0].range, Some((12, 14)));
        // gone when no manifest has it, and the index opens again with what it had
        assert_eq!(k.retain(&[1, 2, 3, 4, 5].into_iter().collect()).unwrap(), 1);
        assert!(ids(&k, "cuda graphs", &all).is_empty());
        drop(k);
        let k = Keywords::open(&dir).unwrap();
        assert_eq!(k.len(), 5);
        assert!(k.has(1) && !k.has(6));
        assert_eq!(ids(&k, "deallocate", &all), [1]);
        drop(k);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
