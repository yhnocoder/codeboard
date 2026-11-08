//! cargo run --release -p box-core --features rerank --example rerank_eval -- <model dir> <cands.json> <out.json>
//! box's reranker (rerank.rs) on the study's candidates (search-index/impl/step2/rerank/cands.json): the whole text of the
//! best RERANK_TOP, scores written like ort_rank.py's, so evalrr.py and tune_w.py read them
use box_core::rerank::{RERANK_TOP, Reranker};
use serde_json::{Value, json};
use std::time::Instant;

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let dir = std::path::Path::new(&a[0]);
    let r = Reranker::open(&dir.join("model.onnx"), &dir.join("tokenizer.json")).unwrap();
    let cands: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(&a[1]).unwrap()).unwrap();
    let mut out = Vec::new();
    for c in cands.iter().filter(|c| c["set"] != "girl") {
        let docs: Vec<String> = c["cands"]
            .as_array()
            .unwrap()
            .iter()
            .take(RERANK_TOP)
            .map(|x| x["whole"].as_str().unwrap_or("").to_string())
            .collect();
        let t = Instant::now();
        let s = r.score(c["q"].as_str().unwrap(), &docs).unwrap();
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        out.push(json!({ "q": c["q"], "set": c["set"], "ms": ms, "cpu": null, "ntokIn": 0, "idx": (0..docs.len()).collect::<Vec<_>>(), "scores": s }));
    }
    let mut ms: Vec<f64> = out.iter().map(|o| o["ms"].as_f64().unwrap()).collect();
    ms.sort_by(|a, b| a.total_cmp(b));
    println!(
        "{} queries, median {:.0} ms per query (wall, {} threads)",
        out.len(),
        ms[ms.len() / 2],
        std::thread::available_parallelism().map_or(0, |n| n.get())
    );
    std::fs::write(
        &a[2],
        json!({ "model": "hs-rerank-1 (box)", "field": "whole", "maxTok": 512, "topK": RERANK_TOP, "out": out })
            .to_string(),
    )
    .unwrap();
}
