//! The reranker: after a search by meaning, its best RERANK_TOP text hits are read again together with the query by a
//! cross-encoder (hindsight-ai/hs-rerank-1: MIT, mmBERT-small, 114M; ONNX with an int8 vocabulary table, run with ONNX
//! Runtime behind the cargo feature `rerank`) on the item's WHOLE text (title and text: the best piece alone measured much
//! worse), and those texts are ordered by w·minmax(vector) + (1−w)·minmax(rerank) among them, in the places text hits hold.
//! Pictures keep their places (a text model cannot see them). Off unless a client asks (rerank), downloaded only on request
//! (model.rs).
//!
//! Measured on persona (2026-11, search-index/impl/step2/rerank): top 10 reranked, top 30 slower and no better. FUSE_W is
//! from a plateau on persona87 alone (tune_w_plateau.py: the best MRR averaged with the neighbouring weights ±0.05; 0.00–0.10
//! all score 80.8–81.4, 0.15 drops to 78.8), so it is close to "reranker only": persona87 MRR 76.3 → 80.9; fresh2 (20
//! queries) 68.9 → 73.7 with top-1 unchanged at 60. fresh2 is not cleanly held out: the model, whole text vs best piece and
//! K were picked from a table that showed it. The gain is not proven, and the reranker is off unless a client asks. The raw
//! score is handed back too: unrelated queries reach at most −6.0, and only 2% of right cards score that low, but no cutoff is
//! set from that yet.

/// Text hits read again by the reranker
pub const RERANK_TOP: usize = 10;
/// The vector score's weight in the fused order (a plateau on persona87, see above)
pub const FUSE_W: f32 = 0.05;
/// What a rerank answers when a newer one of the same source came in before it was read: only the latest query's is worth
/// the cores (the reranker holds them all), so an older one stops at its next batch
pub const SUPERSEDED: &str = "superseded by a newer rerank of this source";

/// The latest rerank of each source: a new one makes the earlier ones of its source stale
#[derive(Default)]
pub struct Latest(std::sync::Mutex<std::collections::HashMap<String, u64>>);

impl Latest {
    /// A new rerank of the source; it is live until the next one of the same source begins
    pub fn begin(&self, source: &str) -> u64 {
        let mut m = self.0.lock().unwrap();
        let n = m.get(source).map_or(1, |g| g + 1);
        m.insert(source.to_string(), n);
        n
    }

    pub fn live(&self, source: &str, ticket: u64) -> bool {
        self.0.lock().unwrap().get(source) == Some(&ticket)
    }
}

/// Tokens of (query, text) the reranker reads; the text is cut to fit
#[cfg(feature = "rerank")]
const MAX_TOKENS: usize = 512;
/// Pairs per forward pass (sorted by length, so short texts are not padded to the longest)
#[cfg(feature = "rerank")]
const BATCH: usize = 8;

fn minmax(xs: &[f32]) -> Vec<f32> {
    let (lo, hi) = xs.iter().fold((f32::MAX, f32::MIN), |(a, b), &x| (a.min(x), b.max(x)));
    xs.iter()
        .map(|&x| if hi > lo { (x - lo) / (hi - lo) } else { 0.0 })
        .collect()
}

/// The fused order of hits by their vector scores and reranker scores (None: a picture, which the reranker cannot read):
/// indexes into the hits, best first. Only the text hits move, among the places text hits hold, by w·minmax(vector) +
/// (1−w)·minmax(rerank) over the texts alone; pictures keep their places (their scores are on another scale). With fewer
/// than two texts read there is nothing to compare (minmax of one is 0) and the order stays; ties keep the vector order
pub fn fuse(vector: &[f32], rerank: &[Option<f32>], w: f32) -> Vec<usize> {
    let mut order: Vec<usize> = (0..vector.len()).collect();
    let texts: Vec<usize> = (0..vector.len()).filter(|&i| rerank[i].is_some()).collect();
    if texts.len() < 2 {
        return order;
    }
    let v = minmax(&texts.iter().map(|&i| vector[i]).collect::<Vec<_>>());
    let r = minmax(&texts.iter().filter_map(|&i| rerank[i]).collect::<Vec<_>>());
    let fused: Vec<f32> = v.iter().zip(&r).map(|(vn, rn)| w * vn + (1.0 - w) * rn).collect();
    let mut by: Vec<usize> = (0..texts.len()).collect();
    by.sort_by(|a, b| fused[*b].total_cmp(&fused[*a]));
    for (slot, k) in texts.iter().zip(by) {
        order[*slot] = texts[k];
    }
    order
}

#[cfg(feature = "rerank")]
pub use run::Reranker;

#[cfg(feature = "rerank")]
mod run {
    use super::{BATCH, MAX_TOKENS, SUPERSEDED};
    use ort::session::Session;
    use ort::value::Tensor;
    use std::path::Path;
    use std::sync::Mutex;
    use tokenizers::{Tokenizer, TruncationParams, TruncationStrategy};

    pub struct Reranker {
        session: Mutex<Session>,
        tok: Tokenizer,
        pad: u32,
        types: bool,
        _env: ort::environment::Environment,
    }

    fn err(e: impl std::fmt::Display) -> String {
        format!("reranker: {e}")
    }

    impl Reranker {
        pub fn open(model: &Path, tokenizer: &Path) -> Result<Reranker, String> {
            let env = ort::init().with_name("box").build().map_err(err)?;
            let threads = std::thread::available_parallelism().map_or(4, |n| n.get());
            let session = Session::builder(&env)
                .map_err(err)?
                .with_intra_threads(threads)
                .map_err(err)?
                .commit_from_file(model)
                .map_err(err)?;
            let types = session.inputs().iter().any(|i| i.name() == "token_type_ids");
            let mut tok = Tokenizer::from_file(tokenizer).map_err(err)?;
            tok.with_padding(None);
            tok.with_truncation(Some(TruncationParams {
                max_length: MAX_TOKENS,
                strategy: TruncationStrategy::OnlySecond,
                ..Default::default()
            }))
            .map_err(err)?;
            let pad = tok.token_to_id("<pad>").unwrap_or(1);
            Ok(Reranker {
                session: Mutex::new(session),
                tok,
                pad,
                types,
                _env: env,
            })
        }

        /// The raw relevance score (a logit) of each text for the query; Err(SUPERSEDED) as soon as `live` says no (checked
        /// before each batch)
        pub fn score(&self, q: &str, texts: &[String], live: &dyn Fn() -> bool) -> Result<Vec<f32>, String> {
            let pairs: Vec<(String, String)> = texts.iter().map(|t| (q.to_string(), t.clone())).collect();
            let enc = self.tok.encode_batch(pairs, true).map_err(err)?;
            let mut order: Vec<usize> = (0..enc.len()).collect();
            order.sort_by_key(|&i| enc[i].get_ids().len());
            let mut out = vec![0f32; enc.len()];
            let mut session = self.session.lock().unwrap();
            for group in order.chunks(BATCH) {
                if !live() {
                    return Err(SUPERSEDED.into());
                }
                let len = group.iter().map(|&i| enc[i].get_ids().len()).max().unwrap_or(1);
                let mut ids = vec![self.pad as i64; group.len() * len];
                let mut mask = vec![0i64; group.len() * len];
                for (r, &i) in group.iter().enumerate() {
                    for (c, &t) in enc[i].get_ids().iter().enumerate() {
                        ids[r * len + c] = t as i64;
                        mask[r * len + c] = 1;
                    }
                }
                let shape = [group.len(), len];
                let mut inputs = ort::inputs![
                    "input_ids" => Tensor::from_array((shape, ids)).map_err(err)?,
                    "attention_mask" => Tensor::from_array((shape, mask)).map_err(err)?,
                ];
                if self.types {
                    let t = Tensor::from_array((shape, vec![0i64; group.len() * len])).map_err(err)?;
                    inputs.push(("token_type_ids".into(), t.into()));
                }
                let res = session.run(inputs).map_err(err)?;
                let (_, logits) = res[0].try_extract_tensor::<f32>().map_err(err)?;
                let per = logits.len() / group.len().max(1);
                for (r, &i) in group.iter().enumerate() {
                    out[i] = logits[r * per];
                }
            }
            Ok(out)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_fused_order_weighs_both_scores_and_pictures_keep_their_places() {
        // the reranker likes the third hit most; with w small its order wins
        let v = [0.80, 0.75, 0.70, 0.65];
        let r = [Some(-3.0), Some(-1.0), Some(4.0), None];
        assert_eq!(fuse(&v, &r, 0.1), [2, 1, 0, 3]);
        // all vector: the vector order
        assert_eq!(fuse(&v, &r, 1.0), [0, 1, 2, 3]);
        // texts the reranker does not separate keep the vector order
        let r = [None, Some(1.0), Some(1.0), Some(1.0)];
        assert_eq!(fuse(&v, &r, 0.1), [0, 1, 2, 3]);
        // the texts trade places around a picture, which stays where it was
        let r = [Some(-3.0), None, Some(4.0), Some(0.0)];
        assert_eq!(fuse(&v, &r, 0.1), [2, 1, 3, 0]);
    }

    #[test]
    fn one_text_read_keeps_its_place_ahead_of_pictures_it_beat() {
        // minmax of a single reranker score is 0: fusing would drop the best hit behind a picture
        let v = [0.70, 0.65, 0.60];
        assert_eq!(fuse(&v, &[Some(2.0), None, None], 0.1), [0, 1, 2]);
        assert_eq!(fuse(&v, &[None, Some(-5.0), None], 0.1), [0, 1, 2]);
        assert_eq!(fuse(&[], &[], 0.1), Vec::<usize>::new());
    }

    #[test]
    fn a_new_rerank_makes_the_earlier_one_of_its_source_stale() {
        let l = Latest::default();
        let a = l.begin("s");
        let other = l.begin("t");
        assert!(l.live("s", a));
        let b = l.begin("s");
        assert!(!l.live("s", a));
        assert!(l.live("s", b) && l.live("t", other));
    }

    /// The real model, when its files are there (BOX_RERANKER: a folder with model.onnx and tokenizer.json)
    #[cfg(feature = "rerank")]
    #[test]
    fn the_reranker_scores_the_right_text_higher() {
        let dir = std::env::var_os("BOX_RERANKER").map(std::path::PathBuf::from);
        let Some(dir) = dir.filter(|d| d.join("model.onnx").is_file()) else {
            let _ = writeln!(
                std::io::stderr(),
                "reranker test skipped: set BOX_RERANKER to a folder with hs-rerank-1's model.onnx and tokenizer.json"
            );
            return;
        };
        use std::io::Write;
        let r = Reranker::open(&dir.join("model.onnx"), &dir.join("tokenizer.json")).unwrap();
        let s = r
            .score(
                "how is the kv cache freed",
                &[
                    "CUDA graphs are captured once per batch size.".into(),
                    "BlockManager.deallocate frees the kv cache blocks of a finished sequence.".into(),
                    "显存：KV cache 随序列长度增长，块管理器按块回收。".into(),
                ],
                &|| true,
            )
            .unwrap();
        assert!(s[1] > s[0] && s[2] > s[0], "{s:?}");
    }
}
