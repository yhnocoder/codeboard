//! The index on disk: one SQLite file. Content is kept by key (a hash of the model's fingerprint and the exact prompted text,
//! or an image's key) and holds the vector as 768 f16; a piece seen once is never embedded again, wherever it appears. A
//! manifest is one source's set of items at one ref (CodeBoard: a storage folder at a git branch): switching branch is
//! another manifest over the same content, so nothing is embedded again. Manifests not used for MANIFEST_DAYS and content no
//! manifest has are deleted (gc). Every write is one transaction: a crash leaves the index as it was before it.

use half::f16;
use rusqlite::{Connection, OptionalExtension, params};
use std::path::Path;

pub type Key = [u8; 32];

/// Days a manifest is kept without a sync or a search
pub const MANIFEST_DAYS: i64 = 30;

/// The key a piece's vector is kept under: text and images in separate namespaces, both under the model's fingerprint
pub fn text_key(fp: &str, prompt: &str) -> Key {
    key(fp, "t:", prompt.as_bytes())
}
pub fn image_key(fp: &str, image: &str) -> Key {
    key(fp, "img:", image.as_bytes())
}
fn key(fp: &str, kind: &str, data: &[u8]) -> Key {
    let mut h = blake3::Hasher::new();
    h.update(fp.as_bytes())
        .update(&[0])
        .update(kind.as_bytes())
        .update(data);
    *h.finalize().as_bytes()
}

/// One piece as a manifest keeps it: its content key, and where it is in the item (UTF-16 range of its text, or the image's key)
#[derive(Debug, Clone, PartialEq)]
pub struct PieceRow {
    pub key: Key,
    pub start: u32,
    pub end: u32,
    pub picture: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ItemRow {
    pub id: String,
    /// What the item was made from (model, title, text, images): the same hash, the same pieces
    pub hash: Key,
    pub groups: Vec<String>,
    /// JSON the client gave, handed back with hits
    pub meta: String,
    pub pieces: Vec<PieceRow>,
}

#[derive(Debug, Clone)]
pub struct ManifestRow {
    pub id: i64,
    pub source: String,
    pub r#ref: String,
    pub model: String,
    pub used: i64,
}

pub struct Store {
    db: Connection,
}

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn f16_bytes(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|x| f16::from_f32(*x).to_le_bytes()).collect()
}
pub fn f16_vec(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(2)
        .map(|c| f16::from_le_bytes([c[0], c[1]]).to_f32())
        .collect()
}

type R<T> = rusqlite::Result<T>;

impl Store {
    pub fn open(file: &Path) -> R<Store> {
        let db = Connection::open(file)?;
        db.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;
             CREATE TABLE IF NOT EXISTS content(key BLOB PRIMARY KEY, model TEXT NOT NULL, vec BLOB NOT NULL) WITHOUT ROWID;
             CREATE INDEX IF NOT EXISTS content_model ON content(model);
             CREATE TABLE IF NOT EXISTS models(model TEXT PRIMARY KEY, clip REAL NOT NULL, scales BLOB NOT NULL);
             CREATE TABLE IF NOT EXISTS manifests(id INTEGER PRIMARY KEY, source TEXT NOT NULL, ref TEXT NOT NULL,
               model TEXT NOT NULL, used INTEGER NOT NULL, UNIQUE(source, ref));
             CREATE TABLE IF NOT EXISTS items(manifest INTEGER NOT NULL REFERENCES manifests(id) ON DELETE CASCADE,
               id TEXT NOT NULL, ord INTEGER NOT NULL, hash BLOB NOT NULL, groups TEXT NOT NULL, meta TEXT NOT NULL,
               PRIMARY KEY(manifest, id)) WITHOUT ROWID;
             CREATE TABLE IF NOT EXISTS pieces(manifest INTEGER NOT NULL, item TEXT NOT NULL, idx INTEGER NOT NULL,
               key BLOB NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, picture TEXT,
               PRIMARY KEY(manifest, item, idx), FOREIGN KEY(manifest, item) REFERENCES items(manifest, id) ON DELETE CASCADE)
               WITHOUT ROWID;
             CREATE INDEX IF NOT EXISTS pieces_key ON pieces(key);",
        )?;
        Ok(Store { db })
    }

    pub fn manifests(&self) -> R<Vec<ManifestRow>> {
        let mut q = self.db.prepare("SELECT id, source, ref, model, used FROM manifests")?;
        q.query_map([], |r| {
            Ok(ManifestRow {
                id: r.get(0)?,
                source: r.get(1)?,
                r#ref: r.get(2)?,
                model: r.get(3)?,
                used: r.get(4)?,
            })
        })?
        .collect()
    }

    pub fn items(&self, manifest: i64) -> R<Vec<ItemRow>> {
        let mut q = self
            .db
            .prepare("SELECT id, hash, groups, meta FROM items WHERE manifest = ? ORDER BY ord")?;
        let mut items: Vec<ItemRow> = q
            .query_map([manifest], |r| {
                let groups: String = r.get(2)?;
                Ok(ItemRow {
                    id: r.get(0)?,
                    hash: r.get(1)?,
                    groups: serde_json::from_str(&groups).unwrap_or_default(),
                    meta: r.get(3)?,
                    pieces: Vec::new(),
                })
            })?
            .collect::<R<_>>()?;
        let at: std::collections::HashMap<String, usize> =
            items.iter().enumerate().map(|(i, x)| (x.id.clone(), i)).collect();
        let mut q = self
            .db
            .prepare("SELECT item, key, start, end, picture FROM pieces WHERE manifest = ? ORDER BY item, idx")?;
        let rows = q.query_map([manifest], |r| {
            Ok((
                r.get::<_, String>(0)?,
                PieceRow {
                    key: r.get(1)?,
                    start: r.get(2)?,
                    end: r.get(3)?,
                    picture: r.get(4)?,
                },
            ))
        })?;
        for row in rows {
            let (item, p) = row?;
            if let Some(&i) = at.get(&item) {
                items[i].pieces.push(p);
            }
        }
        Ok(items)
    }

    /// Writes a manifest's items as they now are: `items` in order, of which `changed` (indexes) have new pieces; items not in
    /// the list are dropped. Answers the manifest's id
    pub fn write_manifest(
        &mut self,
        source: &str,
        r: &str,
        model: &str,
        items: &[ItemRow],
        changed: &[usize],
    ) -> R<i64> {
        let tx = self.db.transaction()?;
        let t = now();
        let old: Option<(i64, String)> = tx
            .query_row(
                "SELECT id, model FROM manifests WHERE source = ? AND ref = ?",
                params![source, r],
                |x| Ok((x.get(0)?, x.get(1)?)),
            )
            .optional()?;
        let id = match old {
            Some((id, m)) if m == model => {
                tx.execute("UPDATE manifests SET used = ? WHERE id = ?", params![t, id])?;
                id
            }
            Some((id, _)) => {
                tx.execute("DELETE FROM items WHERE manifest = ?", [id])?;
                tx.execute(
                    "UPDATE manifests SET used = ?, model = ? WHERE id = ?",
                    params![t, model, id],
                )?;
                id
            }
            None => {
                tx.execute(
                    "INSERT INTO manifests(source, ref, model, used) VALUES (?, ?, ?, ?)",
                    params![source, r, model, t],
                )?;
                tx.last_insert_rowid()
            }
        };
        {
            let keep: std::collections::HashSet<&str> = items.iter().map(|x| x.id.as_str()).collect();
            let mut q = tx.prepare("SELECT id FROM items WHERE manifest = ?")?;
            let gone: Vec<String> = q
                .query_map([id], |x| x.get(0))?
                .collect::<R<Vec<String>>>()?
                .into_iter()
                .filter(|x| !keep.contains(x.as_str()))
                .collect();
            let mut del = tx.prepare("DELETE FROM items WHERE manifest = ? AND id = ?")?;
            for g in gone {
                del.execute(params![id, g])?;
            }
            let mut up = tx.prepare(
                "INSERT INTO items(manifest, id, ord, hash, groups, meta) VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT(manifest, id) DO UPDATE SET ord = excluded.ord, hash = excluded.hash, groups = excluded.groups,
                 meta = excluded.meta",
            )?;
            for (ord, x) in items.iter().enumerate() {
                let groups = serde_json::to_string(&x.groups).unwrap_or_else(|_| "[]".into());
                up.execute(params![id, x.id, ord as i64, &x.hash[..], groups, x.meta])?;
            }
            let mut clear = tx.prepare("DELETE FROM pieces WHERE manifest = ? AND item = ?")?;
            let mut put = tx.prepare(
                "INSERT INTO pieces(manifest, item, idx, key, start, end, picture) VALUES (?, ?, ?, ?, ?, ?, ?)",
            )?;
            for &i in changed {
                let x = &items[i];
                clear.execute(params![id, x.id])?;
                for (j, p) in x.pieces.iter().enumerate() {
                    put.execute(params![id, x.id, j as i64, &p.key[..], p.start, p.end, p.picture])?;
                }
            }
        }
        tx.commit()?;
        Ok(id)
    }

    pub fn touch(&self, manifest: i64) -> R<()> {
        self.db
            .execute("UPDATE manifests SET used = ? WHERE id = ?", params![now(), manifest])?;
        Ok(())
    }

    pub fn forget(&self, source: &str) -> R<()> {
        self.db.execute("DELETE FROM manifests WHERE source = ?", [source])?;
        Ok(())
    }

    /// Vectors for these keys (empty: the model gave none), stored at once
    pub fn put_content(&mut self, model: &str, rows: &[(Key, Option<Vec<f32>>)]) -> R<()> {
        let tx = self.db.transaction()?;
        {
            let mut put = tx.prepare("INSERT OR REPLACE INTO content(key, model, vec) VALUES (?, ?, ?)")?;
            for (k, v) in rows {
                put.execute(params![&k[..], model, v.as_deref().map(f16_bytes).unwrap_or_default()])?;
            }
        }
        tx.commit()
    }

    /// Every vector of a model (an empty one: the model gave none for that key)
    pub fn model_content(&self, model: &str, mut each: impl FnMut(Key, Vec<f32>)) -> R<()> {
        let mut q = self.db.prepare("SELECT key, vec FROM content WHERE model = ?")?;
        let mut rows = q.query([model])?;
        while let Some(r) = rows.next()? {
            let k: Key = r.get(0)?;
            let v: Vec<u8> = r.get(1)?;
            each(k, f16_vec(&v));
        }
        Ok(())
    }

    pub fn vector(&self, key: &Key) -> R<Option<Vec<f32>>> {
        let mut q = self.db.prepare_cached("SELECT vec FROM content WHERE key = ?")?;
        q.query_row([&key[..]], |r| r.get::<_, Vec<u8>>(0))
            .optional()
            .map(|v| v.map(|b| f16_vec(&b)))
    }

    /// The model's clip and int8 scales, once calibrated
    pub fn calibration(&self, model: &str) -> R<Option<(f32, Vec<f32>)>> {
        self.db
            .query_row("SELECT clip, scales FROM models WHERE model = ?", [model], |r| {
                let s: Vec<u8> = r.get(1)?;
                Ok((
                    r.get::<_, f64>(0)? as f32,
                    s.chunks_exact(4)
                        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                        .collect(),
                ))
            })
            .optional()
    }

    pub fn set_calibration(&self, model: &str, clip: f32, scales: &[f32]) -> R<()> {
        let s: Vec<u8> = scales.iter().flat_map(|x| x.to_le_bytes()).collect();
        self.db.execute(
            "INSERT OR REPLACE INTO models(model, clip, scales) VALUES (?, ?, ?)",
            params![model, clip as f64, s],
        )?;
        Ok(())
    }

    /// Deletes manifests unused since `before` and then content no manifest has. Answers (manifests, contents) deleted
    pub fn gc(&mut self, before: i64) -> R<(usize, usize)> {
        let tx = self.db.transaction()?;
        let m = tx.execute("DELETE FROM manifests WHERE used < ?", [before])?;
        let c = tx.execute(
            "DELETE FROM content WHERE NOT EXISTS (SELECT 1 FROM pieces WHERE pieces.key = content.key)",
            [],
        )?;
        tx.commit()?;
        Ok((m, c))
    }

    pub fn content_count(&self) -> R<usize> {
        self.db
            .query_row("SELECT count(*) FROM content", [], |r| r.get::<_, i64>(0))
            .map(|n| n as usize)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, keys: &[Key]) -> ItemRow {
        ItemRow {
            id: id.into(),
            hash: blake3::hash(id.as_bytes()).into(),
            groups: vec!["b1".into()],
            meta: "{}".into(),
            pieces: keys
                .iter()
                .map(|k| PieceRow {
                    key: *k,
                    start: 0,
                    end: 1,
                    picture: None,
                })
                .collect(),
        }
    }

    #[test]
    fn manifests_share_content_and_gc_drops_only_what_no_manifest_has() {
        let dir = std::env::temp_dir().join(format!("box-store-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut s = Store::open(&dir.join("t.db")).unwrap();
        let (a, b, c) = (text_key("m", "a"), text_key("m", "b"), text_key("m", "c"));
        assert_ne!(text_key("m", "a"), text_key("m2", "a"));
        assert_ne!(text_key("m", "a"), image_key("m", "a"));
        s.put_content("m", &[(a, Some(vec![0.6, 0.8])), (b, Some(vec![1.0, 0.0])), (c, None)])
            .unwrap();
        let main = s
            .write_manifest("src", "main", "m", &[item("x", &[a]), item("y", &[b])], &[0, 1])
            .unwrap();
        let feat = s
            .write_manifest("src", "feature", "m", &[item("x", &[a])], &[0])
            .unwrap();
        assert_ne!(main, feat);
        // the same set again: nothing changed
        let again = s
            .write_manifest("src", "main", "m", &[item("y", &[b]), item("x", &[a])], &[])
            .unwrap();
        assert_eq!(again, main);
        assert_eq!(
            s.items(main).unwrap().iter().map(|x| x.id.as_str()).collect::<Vec<_>>(),
            ["y", "x"]
        );
        assert_eq!(s.items(main).unwrap()[1].pieces[0].key, a);
        // y leaves main: b is no longer anyone's, c never was
        s.write_manifest("src", "main", "m", &[item("x", &[a])], &[]).unwrap();
        assert_eq!(s.gc(0).unwrap(), (0, 2));
        assert_eq!(s.content_count().unwrap(), 1);
        let v = s.vector(&a).unwrap().unwrap();
        assert!((v[0] - 0.6).abs() < 1e-3 && (v[1] - 0.8).abs() < 1e-3);
        // an unused manifest goes, and with it what only it had
        s.forget("src").unwrap();
        assert_eq!(s.gc(now() - MANIFEST_DAYS * 86400).unwrap(), (0, 1));
        let m = s.write_manifest("old", "main", "m", &[item("x", &[a])], &[0]).unwrap();
        s.db.execute("UPDATE manifests SET used = 0 WHERE id = ?", [m]).unwrap();
        assert_eq!(s.gc(now() - MANIFEST_DAYS * 86400).unwrap(), (1, 0));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
