//! box's index as a Node addon, for tools that are one Node process (CodeBoard itself uses the service: every VS Code window
//! is a process of its own). One generic request, JSON in and out as PROTOCOL.md has it, run on libuv's thread pool so it
//! never blocks the event loop; node/index.ts gives it types. Built with build.mjs into node/bin/<platform>-<arch>/box.node
use box_core::Index;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::sync::{Arc, Mutex};

/// An open index (one per data folder in a process)
#[napi]
pub struct BoxIndex {
    index: Mutex<Option<Arc<Index>>>,
}

pub struct Request {
    index: Arc<Index>,
    op: String,
    body: String,
}

impl Task for Request {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<String> {
        let body: serde_json::Value =
            serde_json::from_str(&self.body).map_err(|e| Error::from_reason(format!("not JSON: {e}")))?;
        let r = self.index.request(&self.op, body).map_err(Error::from_reason)?;
        Ok(r.to_string())
    }

    fn resolve(&mut self, _env: Env, out: String) -> Result<String> {
        Ok(out)
    }
}

#[napi]
impl BoxIndex {
    /// Opens (making it if missing) the index in the data folder `home`; throws when another process has it open
    #[napi(factory)]
    pub fn open(home: String) -> Result<BoxIndex> {
        let index = Index::open(std::path::Path::new(&home)).map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(BoxIndex {
            index: Mutex::new(Some(Arc::new(index))),
        })
    }

    /// One request: its op and its fields as JSON → the result as JSON (rejects with the error)
    #[napi(ts_return_type = "Promise<string>")]
    pub fn request(&self, op: String, body: String) -> Result<AsyncTask<Request>> {
        let index = self
            .index
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| Error::from_reason("box index closed"))?;
        Ok(AsyncTask::new(Request { index, op, body }))
    }

    /// Closes the index: background indexing stops after its current batch, and requests still running finish first
    #[napi]
    pub fn close(&self) {
        self.index.lock().unwrap().take();
    }
}
