//! box's index behind a small C ABI, for Swift (swift/) and any language with a C FFI. Requests and answers are JSON strings
//! as PROTOCOL.md has them, without the socket: `{"op": "search", ...fields}` in, `{"result": ...}` or `{"error": "..."}`
//! out. Every string box hands out is freed with box_string_free. A request may block (a search embeds its query; a sync
//! only queues), so call it off the main thread. The header (swift/Sources/CBox/include/box.h) is made by cbindgen; a test
//! checks it is current.

use box_core::Index;
use serde_json::{Value, json};
use std::ffi::{CStr, CString, c_char};
use std::path::Path;

/// An open index (one per data folder in a process; dropping it, box_close, stops its background indexing)
pub struct BoxIndex(Index);

fn out(s: String) -> *mut c_char {
    // a NUL inside a JSON string is escaped, so this only fails on a message with one: drop it
    CString::new(s.replace('\0', "")).unwrap_or_default().into_raw()
}

/// Opens (making it if missing) the index in the data folder `home`, a UTF-8 path. Answers NULL when it cannot, with the
/// reason in *error when error is not NULL (free it with box_string_free)
///
/// # Safety
/// home is a NUL-terminated string; error is NULL or points to writable storage for one pointer
#[unsafe(no_mangle)]
pub unsafe extern "C" fn box_open(home: *const c_char, error: *mut *mut c_char) -> *mut BoxIndex {
    let fail = |e: String| {
        if !error.is_null() {
            unsafe { *error = out(e) };
        }
        std::ptr::null_mut()
    };
    if home.is_null() {
        return fail("no data folder".into());
    }
    let home = match unsafe { CStr::from_ptr(home) }.to_str() {
        Ok(h) => h,
        Err(_) => return fail("the data folder is not UTF-8".into()),
    };
    match Index::open(Path::new(home)) {
        Ok(i) => Box::into_raw(Box::new(BoxIndex(i))),
        Err(e) => fail(e.to_string()),
    }
}

/// One request (JSON with its "op") → its answer as JSON: {"result": …} or {"error": "…"}. Never NULL; free the answer
/// with box_string_free
///
/// # Safety
/// index comes from box_open and is not closed; request is a NUL-terminated string
#[unsafe(no_mangle)]
pub unsafe extern "C" fn box_request(index: *const BoxIndex, request: *const c_char) -> *mut c_char {
    let reply = (|| {
        let index = unsafe { index.as_ref() }.ok_or("no index")?;
        if request.is_null() {
            return Err("no request".to_string());
        }
        let text = unsafe { CStr::from_ptr(request) }
            .to_str()
            .map_err(|_| "the request is not UTF-8")?;
        let req: Value = serde_json::from_str(text).map_err(|e| format!("not JSON: {e}"))?;
        let op = req.get("op").and_then(Value::as_str).unwrap_or("").to_string();
        index.0.request(&op, req)
    })();
    out(match reply {
        Ok(r) => json!({ "result": r }),
        Err(e) => json!({ "error": e }),
    }
    .to_string())
}

/// Frees a string box handed out (NULL: nothing)
///
/// # Safety
/// s comes from box_request or box_open's error, and is freed once
#[unsafe(no_mangle)]
pub unsafe extern "C" fn box_string_free(s: *mut c_char) {
    if !s.is_null() {
        drop(unsafe { CString::from_raw(s) });
    }
}

/// Closes the index: background indexing stops after its current batch; the data folder is free for another process once
/// that batch is done
///
/// # Safety
/// index comes from box_open and is closed once
#[unsafe(no_mangle)]
pub unsafe extern "C" fn box_close(index: *mut BoxIndex) {
    if !index.is_null() {
        drop(unsafe { Box::from_raw(index) });
    }
}
