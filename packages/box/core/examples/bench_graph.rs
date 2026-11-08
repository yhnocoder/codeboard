//! cargo run --release -p box-core --example bench_graph -- <rows> [dim]: brute force against the graph (graph.rs) on
//! synthetic clustered unit vectors with a few large dimensions, like EmbeddingGemma's. Recall is against exact f32 cosine
//! of the clipped vectors, after the production path: the best RESCORE candidates scored again exactly
use box_core::graph::BRUTE_VISIBLE;
use box_core::vectors::{ModelIndex, RESCORE, clipped, dot};
use rayon::prelude::*;
use std::sync::Arc;
use std::time::Instant;

fn rng(seed: u64) -> impl FnMut() -> f32 {
    let mut s = seed;
    move || {
        s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((s >> 33) as f32 / (1u64 << 31) as f32) - 0.5
    }
}

fn unit(v: Vec<f32>) -> Vec<f32> {
    box_core::embed::unit(v).unwrap()
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let n: usize = args.first().and_then(|a| a.parse().ok()).unwrap_or(200_000);
    let dim: usize = args.get(1).and_then(|a| a.parse().ok()).unwrap_or(768);
    let mut r = rng(1);
    let centers: Vec<Vec<f32>> = (0..2000)
        .map(|_| (0..dim).map(|d| r() * if d % 150 == 7 { 10.0 } else { 1.0 }).collect())
        .collect();
    let member = |r: &mut dyn FnMut() -> f32| {
        let c = &centers[((r() + 0.5) * 1999.0) as usize];
        unit(c.iter().map(|x| x + r() * 0.8).collect())
    };
    let t = Instant::now();
    let vs: Vec<Vec<f32>> = (0..n).map(|_| member(&mut r)).collect();
    let qs: Vec<Vec<f32>> = (0..200).map(|_| member(&mut r)).collect();
    println!("{n} rows × {dim}, 2000 clusters; made in {:?}", t.elapsed());
    let key = |i: usize| -> [u8; 32] { blake3::hash(&(i as u64).to_le_bytes()).into() };
    let mut m = ModelIndex::new(None);
    let t = Instant::now();
    for (c, chunk) in vs.chunks(10_000).enumerate() {
        m.add(
            chunk
                .iter()
                .enumerate()
                .map(|(i, v)| (key(c * 10_000 + i), Some(v.clone())))
                .collect(),
        );
    }
    println!("int8 index: {:?}", t.elapsed());
    let clip = m.clip.unwrap();
    let mut exact = vs;
    exact.par_iter_mut().for_each(|v| *v = clipped(v, clip));
    let truth = |q: &[f32], rows: &[u32]| -> Vec<u32> {
        let mut s: Vec<(u32, f32)> = rows.par_iter().map(|&r| (r, dot(&exact[r as usize], q))).collect();
        s.sort_by(|a, b| b.1.total_cmp(&a.1));
        s.into_iter().take(10).map(|x| x.0).collect()
    };
    // the production path: candidates, scored again exactly, best 10
    let top10 = |c: Vec<(usize, f32)>, rows: &[u32], q: &[f32]| -> Vec<u32> {
        let mut s: Vec<(u32, f32)> = c
            .into_iter()
            .map(|(e, _)| (rows[e], dot(&exact[rows[e] as usize], q)))
            .collect();
        s.sort_by(|a, b| b.1.total_cmp(&a.1));
        s.dedup_by_key(|x| x.0);
        s.into_iter().take(10).map(|x| x.0).collect()
    };
    let all: Vec<u32> = (0..n as u32).collect();
    let run = |m: &ModelIndex, name: &str, rows: &[u32], graph: bool| {
        let mut times = Vec::new();
        let mut hit = 0;
        for q in &qs {
            let qp = m.prepare(q);
            let t = Instant::now();
            let c = if graph {
                m.candidates(&qp, rows, RESCORE)
            } else {
                m.scan(&qp, rows, RESCORE)
            };
            times.push(t.elapsed().as_secs_f64() * 1000.0);
            let want = truth(&qp, rows);
            let got = top10(c, rows, &qp);
            hit += want.iter().filter(|w| got.contains(w)).count();
        }
        times.sort_by(|a, b| a.total_cmp(b));
        println!(
            "  {name:<44} median {:>7.2} ms  p95 {:>7.2} ms  recall@10 {:>5.1}%",
            times[times.len() / 2],
            times[times.len() * 95 / 100],
            hit as f32 / (qs.len() * 10) as f32 * 100.0
        );
    };
    println!("brute force (int8, all cores), then rescoring {RESCORE}:");
    run(&m, "all rows", &all, false);
    let t = Instant::now();
    let g = m.graph_source().build().unwrap();
    let built = t.elapsed();
    let file = std::env::temp_dir().join("box-bench.usearch");
    g.save(&file).unwrap();
    drop(g);
    let size = std::fs::metadata(&file).unwrap().len();
    let t = Instant::now();
    let g = box_core::graph::Graph::load(&file, dim).unwrap();
    println!(
        "graph: built in {built:?} on {} threads, {:.0} MB on disk, loaded in {:?}",
        rayon::current_num_threads(),
        size as f64 / 1e6,
        t.elapsed()
    );
    std::fs::remove_file(&file).unwrap();
    m.attach(Arc::new(g));
    println!("graph (HNSW int8, M=16, ef=256), then rescoring {RESCORE}:");
    run(&m, "all rows", &all, true);
    for share in [10, 100, 1000] {
        let rows: Vec<u32> = (0..n as u32).filter(|r| r % share == 0).collect();
        let how = if rows.len() >= BRUTE_VISIBLE {
            "graph, filtered"
        } else {
            "brute force (below BRUTE_VISIBLE)"
        };
        run(
            &m,
            &format!("1/{share} visible ({} rows): {how}", rows.len()),
            &rows,
            true,
        );
        if rows.len() < BRUTE_VISIBLE {
            // what the graph would cost here (forced): why small visible sets skip it
            let g = m.graph().unwrap().clone();
            let vis: std::collections::HashSet<u64> = rows
                .iter()
                .map(|&r| u64::from_le_bytes(key(r as usize)[..8].try_into().unwrap()))
                .collect();
            let mut times = Vec::new();
            for q in &qs {
                let qp = m.prepare(q);
                let t = Instant::now();
                let _ = g.search(&qp, RESCORE, |k| vis.contains(&k));
                times.push(t.elapsed().as_secs_f64() * 1000.0);
            }
            times.sort_by(|a, b| a.total_cmp(b));
            println!(
                "  {:<44} median {:>7.2} ms",
                format!("  the graph forced at 1/{share}"),
                times[times.len() / 2]
            );
        }
    }
    // writes after the build: the exact tier beside the graph
    let fresh = box_core::graph::FRESH_MAX;
    m.add((0..fresh).map(|i| (key(n + i), Some(member(&mut r)))).collect());
    println!(
        "with an exact tier of {fresh} rows written after the build (FRESH_MAX): wants a rebuild: {}",
        m.wants_graph()
    );
    let all: Vec<u32> = (0..m.len() as u32).collect();
    let mut times = Vec::new();
    for q in &qs {
        let qp = m.prepare(q);
        let t = Instant::now();
        let _ = m.candidates(&qp, &all, RESCORE);
        times.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    times.sort_by(|a, b| a.total_cmp(b));
    println!(
        "  {:<44} median {:>7.2} ms",
        "graph + exact tier, all rows",
        times[times.len() / 2]
    );
}
