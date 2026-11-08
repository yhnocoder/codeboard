//! One model's vectors in memory, for brute-force search. EmbeddingGemma 2 has a few dimensions far larger than the rest that
//! dominate every similarity; each dimension is clipped to ±c and the vector renormalized before comparing (queries too),
//! c = CLIP_TIMES × the median over dimensions of mean |x_d|, computed once CALIBRATE_AT vectors exist (persona: MRR 74 → 76).
//! Once calibrated, vectors are kept as int8 with one scale per dimension (lossless on persona); the best RESCORE rows are
//! scored again from the f16 vectors in the store. Before that there are few vectors and they are kept as f32.

use crate::store::Key;
use rayon::prelude::*;
use std::collections::HashMap;

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
            self.keys.push(k);
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
}
