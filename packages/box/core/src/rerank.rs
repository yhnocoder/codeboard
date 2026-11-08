//! The reranker: after a search by meaning, its best RERANK_TOP text hits are read again together with the query by a
//! cross-encoder (hindsight-ai/hs-rerank-1: MIT, mmBERT-small, 114M; ONNX with an int8 vocabulary table, run with ONNX
//! Runtime behind the cargo feature `rerank`) on the item's WHOLE text (title and text: the best piece alone measured much
//! worse), and the list is ordered by w·minmax(vector) + (1−w)·minmax(rerank) within those hits. Pictures keep their vector
//! score (a text model cannot see them). Off unless a client asks (rerank), downloaded only on request (model.rs).
//!
//! Measured on persona (2026-11, search-index/impl/step2/rerank): top 10 reranked, top 30 slower and no better; FUSE_W was
//! chosen on persona87 only (MRR 76.3 → 81.4) and checked on fresh2, which no setting was tuned on (68.9 → 74.8). The raw
//! score is handed back too: unrelated queries reach at most −6.0, and only 2% of right cards score that low, but no cutoff is
//! set from that yet.

/// Text hits read again by the reranker
pub const RERANK_TOP: usize = 10;
/// The vector score's weight in the fused order (tuned on persona87 only, see above)
pub const FUSE_W: f32 = 0.1;
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

/// The fused order of hits by their vector scores and reranker scores (None: a picture, which keeps its vector score):
/// indexes into the hits, best first; ties keep the vector order
pub fn fuse(vector: &[f32], rerank: &[Option<f32>], w: f32) -> Vec<usize> {
    let v = minmax(vector);
    let got: Vec<f32> = rerank.iter().flatten().copied().collect();
    let r = minmax(&got);
    let mut k = 0;
    let fused: Vec<f32> = rerank
        .iter()
        .zip(&v)
        .map(|(x, &vn)| {
            let rn = match x {
                Some(_) => {
                    k += 1;
                    r[k - 1]
                }
                None => vn,
            };
            w * vn + (1.0 - w) * rn
        })
        .collect();
    let mut order: Vec<usize> = (0..vector.len()).collect();
    order.sort_by(|a, b| fused[*b].total_cmp(&fused[*a]));
    order
}

#[cfg(feature = "rerank")]
pub use run::Reranker;

#[cfg(feature = "rerank")]
mod run {
    use super::{BATCH, MAX_TOKENS};
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

        /// The raw relevance score (a logit) of each text for the query
        pub fn score(&self, q: &str, texts: &[String]) -> Result<Vec<f32>, String> {
            let pairs: Vec<(String, String)> = texts.iter().map(|t| (q.to_string(), t.clone())).collect();
            let enc = self.tok.encode_batch(pairs, true).map_err(err)?;
            let mut order: Vec<usize> = (0..enc.len()).collect();
            order.sort_by_key(|&i| enc[i].get_ids().len());
            let mut out = vec![0f32; enc.len()];
            let mut session = self.session.lock().unwrap();
            for group in order.chunks(BATCH) {
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
    fn the_fused_order_weighs_both_scores_and_pictures_keep_their_vector_score() {
        // the reranker likes the third hit most; with w small its order wins
        let v = [0.80, 0.75, 0.70, 0.65];
        let r = [Some(-3.0), Some(-1.0), Some(4.0), None];
        assert_eq!(fuse(&v, &r, 0.1), [2, 1, 0, 3]);
        // all vector: the vector order
        assert_eq!(fuse(&v, &r, 1.0), [0, 1, 2, 3]);
        // a picture with the best vector score stays first when the reranker does not separate the texts
        let r = [None, Some(1.0), Some(1.0), Some(1.0)];
        assert_eq!(fuse(&v, &r, 0.1), [0, 1, 2, 3]);
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
            )
            .unwrap();
        assert!(s[1] > s[0] && s[2] > s[0], "{s:?}");
    }
}
