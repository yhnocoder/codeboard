//! One model's vectors in memory, for brute-force search. EmbeddingGemma 2 has a few dimensions far larger than the rest that
//! dominate every similarity; each dimension is clipped to ±c and the vector renormalized before comparing (queries too),
//! c = CLIP_TIMES × the median over dimensions of mean |x_d|, computed once CALIBRATE_AT vectors exist (persona: MRR 74 → 76).
//! Once calibrated, vectors are kept as int8 with one scale per dimension (lossless on persona); the best RESCORE rows are
//! scored again from the f16 vectors in the store. Before that there are few vectors and they are kept as f32.

use crate::graph::{BRUTE_VISIBLE, DEAD_SHARE, FRESH_MAX, FRESH_SHARE, GRAPH_AT, Graph, GraphKey, graph_key};
use crate::store::Key;
use rayon::prelude::*;
use std::collections::HashMap;
use std::sync::Arc;

pub const CALIBRATE_AT: usize = 200;
pub const CLIP_TIMES: f32 = 6.0;
/// Rows scored again from the store after the int8 pass
pub const RESCORE: usize = 100;

/// The clip constant for these unit vectors
pub fn clip_of(vs: &[&[f32]]) -> f32 {
    let dim = vs.first().map_or(0, |v| v.len());
    let mut mean = vec![0f32; dim];
    for v in vs {
        for (m, x) in mean.iter_mut().zip(v.iter()) {
            *m += x.abs();
        }
    }
    for m in &mut mean {
        *m /= vs.len().max(1) as f32;
    }
    mean.sort_by(|a, b| a.total_cmp(b));
    CLIP_TIMES * mean.get(dim / 2).copied().unwrap_or(0.0)
}

/// v with each dimension clipped to ±c and then unit length again (c = 0: as it is)
pub fn clipped(v: &[f32], c: f32) -> Vec<f32> {
    if c <= 0.0 {
        return v.to_vec();
    }
    let w: Vec<f32> = v.iter().map(|x| x.clamp(-c, c)).collect();
    crate::embed::unit(w).unwrap_or_else(|| v.to_vec())
}

pub fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

#[derive(Default)]
pub struct ModelIndex {
    pub dim: usize,
    /// None until calibrated
    pub clip: Option<f32>,
    scales: Vec<f32>,
    rows: HashMap<Key, u32>,
    keys: Vec<Key>,
    /// calibrated: n × dim int8
    q: Vec<i8>,
    /// before calibration: n × dim f32, clipped by nothing
    raw: Vec<f32>,
    /// keys the model gave no vector for (never asked again)
    empty: std::collections::HashSet<Key>,
    /// The approximate index once there are GRAPH_AT rows (graph.rs), and which rows it has; the rest are the exact tier
    graph: Option<Arc<Graph>>,
    by_graph_key: HashMap<GraphKey, u32>,
    in_graph: Vec<bool>,
    in_graph_count: usize,
    /// A graph is being built (or failed to be: not tried again until the model is read again)
    pub graph_pending: bool,
}

/// What a graph is built from: a copy of the int8 rows, so the index stays writable meanwhile
pub struct GraphSource {
    pub dim: usize,
    keys: Vec<GraphKey>,
    q: Vec<i8>,
    scales: Vec<f32>,
}

impl GraphSource {
    pub fn build(&self) -> Result<Graph, String> {
        let d = self.dim;
        Graph::build(d, &self.keys, |i| {
            self.q[i * d..(i + 1) * d]
                .iter()
                .zip(&self.scales)
                .map(|(x, s)| *x as f32 * s)
                .collect()
        })
    }
}

/// One candidate of a search: which entry of the caller's list, and its score
pub type Scored = (usize, f32);

impl ModelIndex {
    pub fn new(calibration: Option<(f32, Vec<f32>)>) -> Self {
        let mut m = ModelIndex::default();
        if let Some((c, s)) = calibration {
            m.dim = s.len();
            m.clip = Some(c);
            m.scales = s;
        }
        m
    }

    pub fn len(&self) -> usize {
        self.keys.len()
    }
    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }

    /// Whether the key has been embedded (with or without a vector)
    pub fn has(&self, k: &Key) -> bool {
        self.rows.contains_key(k) || self.empty.contains(k)
    }

    pub fn row(&self, k: &Key) -> Option<u32> {
        self.rows.get(k).copied()
    }

    /// Adds vectors (unit length; None: the model gave none). Answers the new calibration when this add made it
    pub fn add(&mut self, items: Vec<(Key, Option<Vec<f32>>)>) -> Option<(f32, Vec<f32>)> {
        for (k, v) in items {
            let Some(v) = v else {
                self.empty.insert(k);
                continue;
            };
            if self.rows.contains_key(&k) {
                continue;
            }
            if self.dim == 0 {
                self.dim = v.len();
            }
            if v.len() != self.dim {
                continue;
            }
            self.rows.insert(k, self.keys.len() as u32);
            self.by_graph_key.insert(graph_key(&k), self.keys.len() as u32);
            self.keys.push(k);
            self.in_graph.push(false);
            match self.clip {
                Some(c) => {
                    let w = clipped(&v, c);
                    self.q.extend(quantize(&w, &self.scales));
                }
                None => self.raw.extend_from_slice(&v),
            }
        }
        if self.clip.is_none() && self.keys.len() >= CALIBRATE_AT {
            return Some(self.calibrate());
        }
        None
    }

    fn calibrate(&mut self) -> (f32, Vec<f32>) {
        let dim = self.dim;
        let vs: Vec<&[f32]> = self.raw.chunks_exact(dim).collect();
        let c = clip_of(&vs);
        let ws: Vec<Vec<f32>> = vs.iter().map(|v| clipped(v, c)).collect();
        let mut scales = vec![0f32; dim];
        for w in &ws {
            for (s, x) in scales.iter_mut().zip(w) {
                *s = s.max(x.abs());
            }
        }
        for s in &mut scales {
            *s = if *s > 0.0 { *s / 127.0 } else { 1.0 };
        }
        self.q = ws.iter().flat_map(|w| quantize(w, &scales)).collect();
        self.raw = Vec::new();
        self.scales = scales.clone();
        self.clip = Some(c);
        (c, scales)
    }

    /// The query as the index compares it: clipped like the rows
    pub fn prepare(&self, q: &[f32]) -> Vec<f32> {
        clipped(q, self.clip.unwrap_or(0.0))
    }

    /// Scores the rows of `entries` (each a row of this index) against q (prepared): the best `top` of them, best first.
    /// Calibrated, these are int8 scores, to be scored again exactly (rescore)
    pub fn scan(&self, q: &[f32], entries: &[u32], top: usize) -> Vec<Scored> {
        if q.len() != self.dim || self.dim == 0 {
            return Vec::new();
        }
        let dim = self.dim;
        let mut all: Vec<Scored> = match self.clip {
            Some(_) => {
                let qs: Vec<f32> = q.iter().zip(&self.scales).map(|(a, s)| a * s).collect();
                entries
                    .par_iter()
                    .enumerate()
                    .map(|(i, &r)| {
                        let row = &self.q[r as usize * dim..(r as usize + 1) * dim];
                        (i, row.iter().zip(&qs).map(|(x, y)| *x as f32 * y).sum())
                    })
                    .collect()
            }
            None => entries
                .par_iter()
                .enumerate()
                .map(|(i, &r)| (i, dot(&self.raw[r as usize * dim..(r as usize + 1) * dim], q)))
                .collect(),
        };
        let top = top.min(all.len());
        if top < all.len() {
            all.select_nth_unstable_by(top, |a, b| b.1.total_cmp(&a.1));
            all.truncate(top);
        }
        all.sort_by(|a, b| b.1.total_cmp(&a.1));
        all
    }

    /// Whether scan's scores are int8 approximations (rescore them from the store)
    pub fn approximate(&self) -> bool {
        self.clip.is_some()
    }

    /// Takes a graph built (or loaded) for this model: the rows it has are searched through it from now on
    pub fn attach(&mut self, g: Arc<Graph>) {
        self.in_graph = self.keys.iter().map(|k| g.contains(graph_key(k))).collect();
        self.in_graph_count = self.in_graph.iter().filter(|x| **x).count();
        self.graph = Some(g);
        self.graph_pending = false;
    }

    pub fn graph(&self) -> Option<&Arc<Graph>> {
        self.graph.as_ref()
    }

    /// Whether a graph should be built now: there are GRAPH_AT rows, and none is there, or its exact tier or its dead
    /// share grew too large
    pub fn wants_graph(&self) -> bool {
        if self.graph_pending || self.len() < GRAPH_AT || self.clip.is_none() {
            return false;
        }
        match &self.graph {
            None => true,
            Some(g) => {
                let n = g.len().max(1) as f32;
                let fresh = self.len() - self.in_graph_count;
                let dead = g.len().saturating_sub(self.in_graph_count);
                fresh > FRESH_MAX || fresh as f32 > FRESH_SHARE * n || dead as f32 > DEAD_SHARE * n
            }
        }
    }

    /// What to build a graph from (calibrated rows only)
    pub fn graph_source(&self) -> GraphSource {
        GraphSource {
            dim: self.dim,
            keys: self.keys.iter().map(graph_key).collect(),
            q: self.q.clone(),
            scales: self.scales.clone(),
        }
    }

    /// The best `top` of `entries` (rows of this index) for q (prepared), as scan: through the graph when there is one and
    /// enough rows are visible, with the exact tier compared one by one beside it; otherwise every entry one by one
    pub fn candidates(&self, q: &[f32], entries: &[u32], top: usize) -> Vec<Scored> {
        let Some(g) = self.graph.as_ref().filter(|_| entries.len() >= BRUTE_VISIBLE) else {
            return self.scan(q, entries, top);
        };
        // each visible row's entry (most rows have one; the same content in two items has two)
        const NONE: u32 = u32::MAX;
        let mut entry_of = vec![NONE; self.len()];
        let mut more: HashMap<u32, Vec<usize>> = HashMap::new();
        let mut fresh: Vec<usize> = Vec::new();
        for (e, &r) in entries.iter().enumerate() {
            let slot = &mut entry_of[r as usize];
            if *slot == NONE {
                *slot = e as u32;
            } else {
                more.entry(r).or_default().push(e);
            }
            if !self.in_graph[r as usize] {
                fresh.push(e);
            }
        }
        let mut out: Vec<Scored> = Vec::new();
        let row_of = |k: GraphKey| self.by_graph_key.get(&k).copied();
        for (k, s) in g.search(q, top, |k| row_of(k).is_some_and(|r| entry_of[r as usize] != NONE)) {
            let Some(r) = row_of(k) else { continue };
            if entry_of[r as usize] == NONE {
                continue;
            }
            out.push((entry_of[r as usize] as usize, s));
            out.extend(more.get(&r).into_iter().flatten().map(|&e| (e, s)));
        }
        let fresh_rows: Vec<u32> = fresh.iter().map(|&e| entries[e]).collect();
        out.extend(self.scan(q, &fresh_rows, top).into_iter().map(|(i, s)| (fresh[i], s)));
        out.sort_by(|a, b| b.1.total_cmp(&a.1));
        out
    }
}

fn quantize(w: &[f32], scales: &[f32]) -> Vec<i8> {
    w.iter()
        .zip(scales)
        .map(|(x, s)| (x / s).round().clamp(-127.0, 127.0) as i8)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic unit vectors with a few large dimensions, like EmbeddingGemma's
    pub fn vecs(n: usize, dim: usize, seed: u64) -> Vec<Vec<f32>> {
        let mut s = seed;
        let mut next = || {
            s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((s >> 33) as f32 / (1u64 << 31) as f32) - 0.5
        };
        (0..n)
            .map(|_| {
                let v: Vec<f32> = (0..dim).map(|d| next() * if d < 3 { 12.0 } else { 1.0 }).collect();
                crate::embed::unit(v).unwrap()
            })
            .collect()
    }

    fn key(i: usize) -> Key {
        blake3::hash(&i.to_le_bytes()).into()
    }

    #[test]
    fn int8_ranks_like_the_clipped_f32_vectors() {
        let dim = 64;
        let vs = vecs(400, dim, 7);
        let mut m = ModelIndex::new(None);
        let cal = m.add(vs.iter().enumerate().map(|(i, v)| (key(i), Some(v.clone()))).collect());
        let (c, _) = cal.expect("calibrated at 400 vectors");
        assert!(c > 0.0 && c < 1.0);
        assert!(m.approximate());
        let refs: Vec<&[f32]> = vs.iter().map(|v| v.as_slice()).collect();
        assert!((clip_of(&refs) - c).abs() < 1e-6);
        let entries: Vec<u32> = (0..vs.len() as u32).collect();
        for q in vecs(10, dim, 99) {
            let qp = m.prepare(&q);
            let exact: Vec<f32> = vs.iter().map(|v| dot(&clipped(v, c), &qp)).collect();
            let best = (0..vs.len()).max_by(|a, b| exact[*a].total_cmp(&exact[*b])).unwrap();
            let got = m.scan(&qp, &entries, 5);
            // the exact best row is among int8's best few, and int8's scores are close to the exact ones
            assert!(got.iter().any(|x| x.0 == best), "best {best} not in {got:?}");
            for (i, s) in &got {
                assert!((s - exact[*i]).abs() < 0.02, "{s} vs {}", exact[*i]);
            }
        }
    }

    #[test]
    fn uncalibrated_scores_are_exact_and_only_given_rows_are_scanned() {
        let vs = vecs(10, 16, 3);
        let mut m = ModelIndex::new(None);
        assert!(
            m.add(vs.iter().enumerate().map(|(i, v)| (key(i), Some(v.clone()))).collect())
                .is_none()
        );
        m.add(vec![(key(100), None)]);
        assert!(m.has(&key(100)) && m.row(&key(100)).is_none());
        let got = m.scan(&vs[4], &[1, 2, 3], 10);
        assert_eq!(got.len(), 3);
        assert!(got.iter().all(|(i, _)| *i < 3));
        let full = m.scan(&vs[4], &(0..10).collect::<Vec<_>>(), 1);
        assert_eq!(full[0].0, 4);
        assert!((full[0].1 - 1.0).abs() < 1e-5);
    }

    #[test]
    fn a_graph_finds_what_brute_force_finds_and_the_exact_tier_is_searched_beside_it() {
        let dim = 32;
        let n = crate::graph::BRUTE_VISIBLE + 2000;
        let vs = vecs(n, dim, 11);
        let mut m = ModelIndex::new(None);
        m.add(vs.iter().enumerate().map(|(i, v)| (key(i), Some(v.clone()))).collect());
        assert!(!m.wants_graph(), "below GRAPH_AT");
        let g = Arc::new(m.graph_source().build().unwrap());
        assert_eq!(g.len(), n);
        let file = std::env::temp_dir().join(format!("box-graph-{}.usearch", std::process::id()));
        g.save(&file).unwrap();
        let g = Arc::new(crate::graph::Graph::load(&file, dim).unwrap());
        std::fs::remove_file(&file).unwrap();
        m.attach(g);
        // written after the build: the exact tier
        let extra = vecs(50, dim, 12);
        m.add(
            extra
                .iter()
                .enumerate()
                .map(|(i, v)| (key(n + i), Some(v.clone())))
                .collect(),
        );
        let all: Vec<u32> = (0..m.len() as u32).collect();
        let mut overlap = 0;
        for q in vecs(20, dim, 13) {
            let qp = m.prepare(&q);
            let exact: Vec<usize> = m.scan(&qp, &all, 10).into_iter().map(|x| x.0).collect();
            // what matters: the true best 10 are among the candidates scored again exactly
            let got: Vec<usize> = m.candidates(&qp, &all, RESCORE).into_iter().map(|x| x.0).collect();
            overlap += exact.iter().filter(|e| got.contains(e)).count();
        }
        assert!(overlap >= 195, "graph recall@10 among the candidates {overlap}/200");
        // a fresh row is found, and only visible rows come back
        let qp = m.prepare(&extra[7]);
        assert_eq!(m.candidates(&qp, &all, RESCORE)[0].0, n + 7);
        let half: Vec<u32> = (0..m.len() as u32).filter(|r| r.is_multiple_of(2)).collect();
        let got = m.candidates(&m.prepare(&vs[3]), &half, RESCORE);
        assert!(!got.is_empty() && got.iter().all(|(e, _)| half[*e].is_multiple_of(2)));
        assert!(got.iter().all(|(e, _)| half[*e] != 3));
    }
}
