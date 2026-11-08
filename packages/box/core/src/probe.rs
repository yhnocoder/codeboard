//! Which index a model's vectors belong to. Vectors of different models cannot be compared, and the same model served by two
//! programs (oMLX and Ollama, or an endpoint and a built-in llama.cpp) may differ a little too. So before a model's first
//! vectors are kept, it embeds a few fixed probe texts: when its probes agree with a model already known (every cosine at
//! least AGREE), it shares that model's index, whatever it is called; otherwise it gets one of its own, named after the
//! model (with a hash of its probes when that name is taken by a model that does not agree).

use crate::embed::{Embedder, Input, Vectors};
use crate::store::Store;
use std::sync::{Arc, Mutex};

/// The probes' cosine with a known model's, for both to share an index
pub const AGREE: f32 = 0.999;

/// Prompted as documents are (chunk::doc_prompt): English, Chinese, code
pub const PROBES: [&str; 3] = [
    "title: Scheduler | text: The scheduler batches waiting sequences for prefill and runs the rest as decode steps.",
    "title: 显存 | text: KV cache 占用的显存随序列长度线性增长，块管理器按块分配和回收。",
    "title: none | text: def deallocate(self, seq): for block_id in reversed(seq.block_table): self.free(block_id)",
];

fn agrees(a: &[Vec<f32>], b: &[Vec<f32>]) -> bool {
    a.len() == b.len()
        && a.iter()
            .zip(b)
            .all(|(x, y)| x.len() == y.len() && crate::vectors::dot(x, y) >= AGREE)
}

/// The fingerprint for a model called `name` whose probes are `vs` (unit vectors), recorded in the store when new
pub fn resolve(store: &Store, name: &str, vs: &[Vec<f32>]) -> rusqlite::Result<String> {
    let known = store.probes()?;
    let agreeing: Vec<&String> = known.iter().filter(|(_, p)| agrees(p, vs)).map(|(n, _)| n).collect();
    if let Some(n) = agreeing.iter().find(|n| n.as_str() == name).or(agreeing.first()) {
        return Ok(n.to_string());
    }
    let mut fp = name.to_string();
    if known.iter().any(|(n, _)| *n == fp) {
        let mut h = blake3::Hasher::new();
        for v in vs {
            for x in v {
                h.update(&x.to_le_bytes());
            }
        }
        fp = format!("{name}~{}", &h.finalize().to_hex()[..8]);
    }
    store.put_probes(&fp, vs)?;
    Ok(fp)
}

/// An embedder whose fingerprint is resolved by its probes (once, on first use)
pub struct Probed {
    inner: Arc<dyn Embedder>,
    store: Arc<Mutex<Store>>,
    fp: Mutex<Option<String>>,
}

impl Probed {
    pub fn new(inner: Arc<dyn Embedder>, store: Arc<Mutex<Store>>) -> Probed {
        Probed {
            inner,
            store,
            fp: Mutex::new(None),
        }
    }
}

impl Embedder for Probed {
    fn fingerprint(&self) -> Result<String, String> {
        let mut fp = self.fp.lock().unwrap();
        if let Some(f) = fp.as_ref() {
            return Ok(f.clone());
        }
        let name = self.inner.fingerprint()?;
        let vs: Vec<Vec<f32>> = self
            .inner
            .embed(&PROBES.map(|p| Input::Text(p.to_string())))?
            .into_iter()
            .collect::<Option<_>>()
            .ok_or("The embedding server gave a probe text no vector")?;
        let f = resolve(&self.store.lock().unwrap(), &name, &vs).map_err(|e| e.to_string())?;
        *fp = Some(f.clone());
        Ok(f)
    }

    fn embed(&self, inputs: &[Input]) -> Result<Vectors, String> {
        self.inner.embed(inputs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit(v: Vec<f32>) -> Vec<f32> {
        crate::embed::unit(v).unwrap()
    }

    #[test]
    fn the_same_model_shares_an_index_and_one_that_differs_gets_its_own() {
        let dir = std::env::temp_dir().join(format!("box-probe-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let st = Store::open(&dir.join("p.db")).unwrap();
        let a = vec![
            unit(vec![1.0, 0.0, 0.1]),
            unit(vec![0.0, 1.0, 0.1]),
            unit(vec![0.3, 0.3, 1.0]),
        ];
        // a tiny difference (another program, another quantization of the same weights): the same index
        let near: Vec<Vec<f32>> = a.iter().map(|v| unit(v.iter().map(|x| x + 0.001).collect())).collect();
        let far: Vec<Vec<f32>> = a.iter().map(|v| unit(v.iter().rev().copied().collect())).collect();
        assert_eq!(resolve(&st, "embeddinggemma", &a).unwrap(), "embeddinggemma");
        assert_eq!(resolve(&st, "embeddinggemma", &a).unwrap(), "embeddinggemma");
        assert_eq!(
            resolve(&st, "local:embeddinggemma-2-q8_0", &near).unwrap(),
            "embeddinggemma"
        );
        // the same name for vectors that disagree: an index of its own, named apart
        let other = resolve(&st, "embeddinggemma", &far).unwrap();
        assert!(
            other.starts_with("embeddinggemma~") && other.len() == "embeddinggemma~".len() + 8,
            "{other}"
        );
        assert_eq!(resolve(&st, "embeddinggemma", &far).unwrap(), other);
        // another dimension never agrees
        let short: Vec<Vec<f32>> = a.iter().map(|v| unit(v[..2].to_vec())).collect();
        assert_eq!(resolve(&st, "small", &short).unwrap(), "small");
        drop(st);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
