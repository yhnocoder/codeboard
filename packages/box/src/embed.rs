//! Embedding models. Box adds the prompts itself (chunk.rs: Ollama, oMLX and LM Studio add none), normalizes every vector
//! (servers may return unnormalized ones) and drops all-zero ones. Step 1 has one provider, an OpenAI-compatible endpoint the
//! user runs (POST {base}/embeddings); a built-in model is another implementation of the same trait.

use serde_json::{Value, json};
use std::sync::Mutex;
use std::time::Duration;

/// Inputs per request (text; an image goes alone)
pub const BATCH: usize = 16;
/// A text a context-length error made shorter is never cut below this many characters
const MIN_RETRY_CHARS: usize = 64;

/// What to embed: prompted text, or an image as a data: URL (no prompt)
#[derive(Debug, Clone)]
pub enum Input {
    Text(String),
    Image(String),
}

/// One vector per input (None: the model gave none)
pub type Vectors = Vec<Option<Vec<f32>>>;

pub trait Embedder: Send + Sync {
    /// Names the model the vectors come from: vectors are kept and compared per fingerprint, a different one indexes anew
    fn fingerprint(&self) -> Result<String, String>;
    /// One vector per input, unit length; None for an input the model gave no vector (all zeros, or an image it does not take)
    fn embed(&self, inputs: &[Input]) -> Result<Vectors, String>;
}

/// Scales v to unit length; None when it is all zeros (or not a number)
pub fn unit(mut v: Vec<f32>) -> Option<Vec<f32>> {
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if n == 0.0 || !n.is_finite() {
        return None;
    }
    for x in &mut v {
        *x /= n;
    }
    Some(v)
}

/// How a server takes an image in /embeddings input. Kept in this one place: oMLX takes the OpenAI chat-style part, SGLang
/// a bare {image}
const IMAGE_FORMATS: [fn(&str) -> Value; 2] = [
    |url| json!({ "type": "image_url", "image_url": { "url": url } }),
    |url| json!({ "image": url }),
];

/// The endpoint settings a client sends with sync. The key is kept in memory only, never logged or written down
#[derive(Clone, PartialEq, Eq, serde::Deserialize)]
pub struct EndpointConfig {
    /// e.g. http://127.0.0.1:11001/v1
    pub base: String,
    /// none: the first model the server lists with "embed" in its id, or its only model
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub key: Option<String>,
}

impl std::fmt::Debug for EndpointConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EndpointConfig")
            .field("base", &self.base)
            .field("model", &self.model)
            .field("key", &self.key.as_ref().map(|_| "…"))
            .finish()
    }
}

pub struct Endpoint {
    base: String,
    conf: EndpointConfig,
    agent: ureq::Agent,
    model: Mutex<Option<String>>,
    /// Which IMAGE_FORMATS entry the server took; Some(None) once it took neither (images are skipped from then on)
    image_format: Mutex<Option<Option<usize>>>,
}

impl Endpoint {
    pub fn new(conf: EndpointConfig) -> Self {
        let base = conf.base.trim().trim_end_matches('/').to_string();
        let loopback = ["//127.", "//localhost", "//[::1]"].iter().any(|h| base.contains(h));
        let mut c = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(120)))
            .timeout_connect(Some(Duration::from_secs(5)))
            .http_status_as_error(false);
        if loopback {
            c = c.proxy(None);
        }
        Endpoint {
            base,
            conf,
            agent: c.build().into(),
            model: Mutex::new(None),
            image_format: Mutex::new(None),
        }
    }

    fn call(&self, path: &str, body: Option<&Value>) -> Result<Result<Value, String>, String> {
        let url = format!("{}{path}", self.base);
        let auth = self
            .conf
            .key
            .as_ref()
            .filter(|k| !k.is_empty())
            .map(|k| format!("Bearer {k}"));
        let res = match body {
            Some(b) => {
                let mut r = self.agent.post(&url).header("content-type", "application/json");
                if let Some(a) = &auth {
                    r = r.header("authorization", a);
                }
                r.send(b.to_string())
            }
            None => {
                let mut r = self.agent.get(&url);
                if let Some(a) = &auth {
                    r = r.header("authorization", a);
                }
                r.call()
            }
        };
        let mut res = res.map_err(|e| format!("Cannot reach the embedding server at {} ({e})", self.base))?;
        let status = res.status().as_u16();
        let text = res
            .body_mut()
            .with_config()
            .limit(256 << 20)
            .read_to_string()
            .map_err(|e| e.to_string())?;
        if status >= 400 {
            let short: String = text.chars().take(200).collect();
            return Ok(Err(format!("The embedding server answered {status}: {short}")));
        }
        serde_json::from_str(&text)
            .map(Ok)
            .map_err(|e| format!("The embedding server sent no JSON ({e})"))
    }

    fn model_id(&self) -> Result<String, String> {
        if let Some(m) = self.conf.model.as_ref().filter(|m| !m.trim().is_empty()) {
            return Ok(m.trim().to_string());
        }
        let mut picked = self.model.lock().unwrap();
        if let Some(m) = picked.as_ref() {
            return Ok(m.clone());
        }
        let j = self.call("/models", None)??;
        let ids: Vec<String> = j["data"]
            .as_array()
            .map(|a| a.iter().filter_map(|m| m["id"].as_str().map(String::from)).collect())
            .unwrap_or_default();
        let id = ids
            .iter()
            .find(|x| x.to_lowercase().contains("embed"))
            .or(if ids.len() == 1 { ids.first() } else { None })
            .cloned()
            .ok_or_else(|| {
                let list = if ids.is_empty() {
                    "none".to_string()
                } else {
                    ids.join(", ")
                };
                format!("No embedding model on {} (it lists: {list})", self.base)
            })?;
        *picked = Some(id.clone());
        Ok(id)
    }

    /// POST /embeddings: Ok(Ok(vectors)) in input order, Ok(Err(message)) when the server refused
    fn post(&self, model: &str, input: Vec<Value>) -> Result<Result<Vectors, String>, String> {
        let n = input.len();
        let j = match self.call("/embeddings", Some(&json!({ "model": model, "input": input })))? {
            Ok(j) => j,
            Err(e) => return Ok(Err(e)),
        };
        let mut data: Vec<(usize, Vec<f32>)> = j["data"]
            .as_array()
            .ok_or("The embedding server sent no data")?
            .iter()
            .enumerate()
            .map(|(i, d)| {
                let at = d["index"].as_u64().map(|x| x as usize).unwrap_or(i);
                let v = d["embedding"]
                    .as_array()
                    .map(|a| a.iter().map(|x| x.as_f64().unwrap_or(0.0) as f32).collect())
                    .unwrap_or_default();
                (at, v)
            })
            .collect();
        data.sort_by_key(|d| d.0);
        if data.len() != n {
            return Err(format!(
                "The embedding server sent {} vectors for {n} inputs",
                data.len()
            ));
        }
        Ok(Ok(data.into_iter().map(|(_, v)| unit(v)).collect()))
    }

    fn embed_texts(&self, model: &str, texts: &[String]) -> Result<Vectors, String> {
        match self.post(model, texts.iter().map(|t| json!(t)).collect())? {
            Ok(v) => Ok(v),
            Err(e) if too_long(&e) => {
                // one at a time, each made shorter until the model takes it
                let mut out = Vec::with_capacity(texts.len());
                for t in texts {
                    let mut t = t.as_str();
                    loop {
                        match self.post(model, vec![json!(t)])? {
                            Ok(mut v) => {
                                out.push(v.pop().flatten());
                                break;
                            }
                            Err(e) if too_long(&e) && t.chars().count() > MIN_RETRY_CHARS => {
                                let n = t.chars().count() * 3 / 4;
                                t = crate::chunk::cut(t, n.max(MIN_RETRY_CHARS));
                            }
                            Err(e) => return Err(e),
                        }
                    }
                }
                Ok(out)
            }
            Err(e) => Err(e),
        }
    }

    fn embed_image(&self, model: &str, url: &str) -> Result<Option<Vec<f32>>, String> {
        let known = *self.image_format.lock().unwrap();
        let order: Vec<usize> = match known {
            Some(None) => return Ok(None),
            Some(Some(i)) => vec![i],
            None => (0..IMAGE_FORMATS.len()).collect(),
        };
        for i in order {
            if let Ok(mut v) = self.post(model, vec![IMAGE_FORMATS[i](url)])? {
                *self.image_format.lock().unwrap() = Some(Some(i));
                return Ok(v.pop().flatten());
            }
        }
        if known.is_none() {
            *self.image_format.lock().unwrap() = Some(None);
        }
        Ok(None)
    }
}

/// Whether a refusal says the input is longer than the model reads
fn too_long(e: &str) -> bool {
    let e = e.to_lowercase();
    [
        "context",
        "too long",
        "exceed",
        "maximum",
        "too many tokens",
        "input length",
    ]
    .iter()
    .any(|w| e.contains(w))
}

impl Embedder for Endpoint {
    fn fingerprint(&self) -> Result<String, String> {
        self.model_id()
    }

    fn embed(&self, inputs: &[Input]) -> Result<Vectors, String> {
        let model = self.model_id()?;
        let mut out: Vec<Option<Vec<f32>>> = vec![None; inputs.len()];
        let texts: Vec<(usize, String)> = inputs
            .iter()
            .enumerate()
            .filter_map(|(i, x)| match x {
                Input::Text(t) => Some((i, t.clone())),
                Input::Image(_) => None,
            })
            .collect();
        for chunk in texts.chunks(BATCH) {
            let t: Vec<String> = chunk.iter().map(|x| x.1.clone()).collect();
            for ((i, _), v) in chunk.iter().zip(self.embed_texts(&model, &t)?) {
                out[*i] = v;
            }
        }
        for (i, x) in inputs.iter().enumerate() {
            if let Input::Image(url) = x {
                out[i] = self.embed_image(&model, url)?;
            }
        }
        Ok(out)
    }
}
