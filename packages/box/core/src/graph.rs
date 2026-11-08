//! An approximate index (HNSW, usearch) over a model's vectors once it has GRAPH_AT of them: brute force over 200 000 int8
//! rows is about 30 ms, over a million 160 ms, while the graph answers in a millisecond or two. It is a cache, rebuilt from
//! the store whenever it is missing, stale or broken (usearch writes files in place and has known bugs with heavy deletes,
//! so nothing lives only in it): kept next to the store as `<home>/graphs/<model hash>.usearch`, keyed by the first 8 bytes
//! of each content key. Vectors written after a build are a small exact tier, compared one by one beside it; the graph is
//! built again once that tier holds FRESH_SHARE of it (or FRESH_MAX), or when DEAD_SHARE of its vectors are gone. A search whose visible
//! set is small never uses it (filtered HNSW at 1/1000 visible is 800 times slower than comparing those few).

use rayon::prelude::*;
use std::path::{Path, PathBuf};
use usearch::{Index, IndexOptions, MetricKind, ScalarKind};

/// Vectors of a model before it gets a graph
pub const GRAPH_AT: usize = 200_000;
/// Visible rows below which a search compares them one by one anyway
pub const BRUTE_VISIBLE: usize = 50_000;
/// The exact tier's size, as a share of the graph or in vectors (whichever comes first), that makes it build again: 20 000
/// compared one by one cost about 6 ms
pub const FRESH_SHARE: f32 = 0.1;
pub const FRESH_MAX: usize = 20_000;
/// Vectors in the graph no longer in the store, as a share, that make it build again
pub const DEAD_SHARE: f32 = 0.2;
/// Candidates looked at per search (usearch's ef)
const EXPANSION_SEARCH: usize = 256;
const EXPANSION_ADD: usize = 128;
const CONNECTIVITY: usize = 16;

pub type GraphKey = u64;

pub fn graph_key(k: &crate::store::Key) -> GraphKey {
    u64::from_le_bytes(k[..8].try_into().unwrap())
}

/// Where a model's graph is kept
pub fn file(home: &Path, model: &str) -> PathBuf {
    let h = blake3::hash(model.as_bytes()).to_hex();
    home.join("graphs").join(format!("{}.usearch", &h[..16]))
}

pub struct Graph {
    index: Index,
}

fn options(dim: usize) -> IndexOptions {
    IndexOptions {
        dimensions: dim,
        metric: MetricKind::Cos,
        quantization: ScalarKind::I8,
        connectivity: CONNECTIVITY,
        expansion_add: EXPANSION_ADD,
        expansion_search: EXPANSION_SEARCH,
        multi: false,
    }
}

fn err(e: impl std::fmt::Display) -> String {
    format!("graph: {e}")
}

impl Graph {
    /// Builds a graph over keys[i] → vector(i) (clipped, as the index compares them), on all cores
    pub fn build(dim: usize, keys: &[GraphKey], vector: impl Fn(usize) -> Vec<f32> + Sync) -> Result<Graph, String> {
        let index = Index::new(&options(dim)).map_err(err)?;
        let threads = rayon::current_num_threads();
        index.reserve_capacity_and_threads(keys.len(), threads).map_err(err)?;
        (0..keys.len())
            .into_par_iter()
            .try_for_each(|i| index.add(keys[i], &vector(i)).map_err(err))?;
        Ok(Graph { index })
    }

    /// The graph in `path` when it is one of this dimension
    pub fn load(path: &Path, dim: usize) -> Result<Graph, String> {
        let index = Index::new(&options(dim)).map_err(err)?;
        index.load(&path.to_string_lossy()).map_err(err)?;
        if index.dimensions() != dim {
            return Err(err("another dimension"));
        }
        index.change_expansion_search(EXPANSION_SEARCH);
        Ok(Graph { index })
    }

    /// Writes it next to `path` and then puts it in place (a crash leaves the old one or none)
    pub fn save(&self, path: &Path) -> Result<(), String> {
        if let Some(d) = path.parent() {
            std::fs::create_dir_all(d).map_err(err)?;
        }
        let tmp = path.with_extension("tmp");
        self.index.save(&tmp.to_string_lossy()).map_err(err)?;
        std::fs::rename(&tmp, path).map_err(err)
    }

    pub fn len(&self) -> usize {
        self.index.size()
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn contains(&self, k: GraphKey) -> bool {
        self.index.contains(k)
    }

    /// The `n` nearest keys that pass `keep`, with their cosine (approximate: int8)
    pub fn search(&self, q: &[f32], n: usize, keep: impl Fn(GraphKey) -> bool) -> Vec<(GraphKey, f32)> {
        match self.index.filtered_search(q, n, keep) {
            Ok(m) => m.keys.into_iter().zip(m.distances).map(|(k, d)| (k, 1.0 - d)).collect(),
            Err(_) => Vec::new(),
        }
    }
}
