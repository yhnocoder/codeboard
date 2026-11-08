//! The reranker: after a search by meaning, its best RERANK_TOP text hits are read again together with the query by a
//! cross-encoder the embedding server runs (POST {base}/rerank, Cohere / Jina style: on Linda's Mac oMLX serving
//! hindsight-ai/hs-rerank-1, an mmBERT-small cross-encoder), on the start of the item's text (title and text, cut to
//! RERANK_CHARS), and those texts are ordered by w·minmax(vector) + (1−w)·minmax(rerank) among them, in the places text hits
//! hold. Pictures keep their places (a text model cannot see them). The model is the one the client names, else the first
//! the server lists with "rerank" in its id; a server with none answers NO_RERANKER.
//!
//! Measured on persona (2026-11, search-index/impl/step2/rerank, with hs-rerank-1 run as ONNX int8): top 10 reranked, top
//! 30 slower and no better. FUSE_W is from a plateau on persona87 alone (tune_w_plateau.py: the best MRR averaged with the
//! neighbouring weights ±0.05; 0.00–0.10 all score 80.8–81.4, 0.15 drops to 78.8), so it is close to "reranker only":
//! persona87 MRR 76.3 → 80.9; fresh2 (20 queries) 68.9 → 73.7 with top-1 unchanged at 60. fresh2 is not cleanly held out:
//! the model, whole text vs best piece and K were picked from a table that showed it. The gain is not proven. The server's
//! score is handed back too (its relevance score: a sigmoid, 0..1, on oMLX), but no cutoff is set from it yet.

use crate::embed::Endpoint;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

/// Text hits read again by the reranker
pub const RERANK_TOP: usize = 10;
/// The vector score's weight in the fused order (a plateau on persona87, see above)
pub const FUSE_W: f32 = 0.05;
/// Characters of each text the reranker reads (title and text, cut at a character): oMLX does not cut what its model
/// cannot read, and whole cards were slower and worse. Measured with hs-rerank-1 on oMLX against the ONNX reranker on the
/// same 127 persona questions (search-index/impl/step2/rerank/omlx, omlx-rerank-check.py): whole cards 94 ms a question,
/// cut to 800 characters 31 ms, with MRR 80.0 against ONNX's 79.2
pub const RERANK_CHARS: usize = 800;
/// How a rerank's error starts when the embedding server has no reranking model (none listed, or POST /rerank is not there)
pub const NO_RERANKER: &str = "No reranking model on the embedding server";

/// The latest rerank of each source: a new one makes the earlier ones of its source stale
#[derive(Default)]
pub struct Latest(Mutex<std::collections::HashMap<String, u64>>);

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

/// The embedding server's reranker (POST {base}/rerank), with the model it was found to have
pub struct Remote {
    endpoint: Arc<Endpoint>,
    /// The model picked from the server's list (none named): looked up once it is found
    picked: Mutex<Option<String>>,
}

impl Remote {
    pub fn new(endpoint: Arc<Endpoint>) -> Remote {
        Remote {
            endpoint,
            picked: Mutex::new(None),
        }
    }

    /// The model named, else the first the server lists with "rerank" in its id (remembered once found)
    fn model(&self, named: Option<&str>) -> Result<String, String> {
        if let Some(m) = named.map(str::trim).filter(|m| !m.is_empty()) {
            return Ok(m.to_string());
        }
        let mut picked = self.picked.lock().unwrap();
        if let Some(m) = picked.as_ref() {
            return Ok(m.clone());
        }
        let ids = self.endpoint.models()?;
        let id = ids
            .iter()
            .find(|x| x.to_lowercase().contains("rerank"))
            .cloned()
            .ok_or_else(|| {
                let list = if ids.is_empty() {
                    "none".to_string()
                } else {
                    ids.join(", ")
                };
                format!("{NO_RERANKER} at {} (it lists: {list})", self.endpoint.base())
            })?;
        *picked = Some(id.clone());
        Ok(id)
    }

    /// The server's relevance score of each text for the query, each text cut to RERANK_CHARS
    pub fn score(&self, named: Option<&str>, q: &str, texts: &[String]) -> Result<Vec<f32>, String> {
        let model = self.model(named)?;
        let docs: Vec<&str> = texts.iter().map(|t| crate::chunk::cut(t, RERANK_CHARS)).collect();
        let body = json!({
            "model": model,
            "query": q,
            "documents": docs,
            "top_n": docs.len(),
            "return_documents": false,
        });
        let j = match self.endpoint.call("/rerank", Some(&body))? {
            Ok(j) => j,
            Err(e) if crate::embed::status_of(&e) == Some(404) => {
                *self.picked.lock().unwrap() = None; // looked up again next time: a model may have been loaded since
                return Err(format!("{NO_RERANKER} at {} ({model}: {e})", self.endpoint.base()));
            }
            Err(e) => return Err(e),
        };
        scores_of(&j, docs.len())
    }
}

/// The scores of a /rerank answer ({results: [{index, relevance_score}]}), in document order
fn scores_of(j: &Value, n: usize) -> Result<Vec<f32>, String> {
    let mut out = vec![None; n];
    for r in j["results"].as_array().ok_or("The reranker sent no results")? {
        let i = r["index"].as_u64().map(|i| i as usize).filter(|&i| i < n);
        let s = r["relevance_score"].as_f64().or(r["score"].as_f64());
        if let (Some(i), Some(s)) = (i, s) {
            out[i] = Some(s as f32);
        }
    }
    out.into_iter()
        .collect::<Option<Vec<f32>>>()
        .ok_or_else(|| format!("The reranker scored fewer than the {n} texts it was sent"))
}

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

    #[test]
    fn a_rerank_answer_is_read_in_document_order() {
        let j = json!({ "results": [{ "index": 1, "relevance_score": 0.9 }, { "index": 0, "relevance_score": 0.2 }] });
        assert_eq!(scores_of(&j, 2).unwrap(), [0.2, 0.9]);
        assert!(scores_of(&j, 3).unwrap_err().contains("fewer"));
        assert!(scores_of(&json!({}), 1).is_err());
    }
}
