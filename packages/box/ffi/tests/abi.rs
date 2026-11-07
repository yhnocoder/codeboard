//! The C ABI as a C caller uses it, and the header the Swift package compiles against
use box_ffi::{box_close, box_open, box_request, box_string_free};
use std::ffi::{CStr, CString, c_char};
use std::path::PathBuf;

fn ask(index: *const box_ffi::BoxIndex, req: &str) -> serde_json::Value {
    let req = CString::new(req).unwrap();
    let out = unsafe { box_request(index, req.as_ptr()) };
    assert!(!out.is_null());
    let text = unsafe { CStr::from_ptr(out) }.to_str().unwrap().to_string();
    unsafe { box_string_free(out) };
    serde_json::from_str(&text).unwrap()
}

#[test]
fn open_request_close_through_the_c_abi() {
    let home = std::env::temp_dir().join(format!("box-ffi-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    let h = CString::new(home.to_str().unwrap()).unwrap();
    let mut err: *mut c_char = std::ptr::null_mut();
    let index = unsafe { box_open(h.as_ptr(), &mut err) };
    assert!(!index.is_null() && err.is_null());
    let st = ask(index, r#"{"op": "status", "source": "s", "ref": "main"}"#);
    assert_eq!(st["result"]["items"], 0);
    assert_eq!(st["result"]["synced"], false);
    let unsynced = ask(index, r#"{"op": "search", "source": "s", "ref": "main", "q": "x"}"#);
    assert_eq!(unsynced["result"]["unsynced"], true);
    assert!(ask(index, "{").get("error").is_some());
    assert!(
        ask(index, r#"{"op": "nope"}"#)["error"]
            .as_str()
            .unwrap()
            .contains("unknown op")
    );
    // one process per data folder: a second open says why it cannot
    let again = unsafe { box_open(h.as_ptr(), &mut err) };
    assert!(again.is_null() && !err.is_null());
    assert!(unsafe { CStr::from_ptr(err) }.to_str().unwrap().contains("open"));
    unsafe { box_string_free(err) };
    unsafe { box_close(index) };
    // closed: the folder is free again
    let mut err: *mut c_char = std::ptr::null_mut();
    let index = unsafe { box_open(h.as_ptr(), &mut err) };
    assert!(!index.is_null());
    unsafe { box_close(index) };
    std::fs::remove_dir_all(&home).unwrap();
}

#[test]
fn the_swift_packages_header_is_current() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let config = cbindgen::Config::from_file(dir.join("cbindgen.toml")).unwrap();
    let mut made = Vec::new();
    cbindgen::Builder::new()
        .with_crate(&dir)
        .with_config(config)
        .generate()
        .unwrap()
        .write(&mut made);
    let file = dir.join("../swift/Sources/CBox/include/box.h");
    if std::env::var_os("BOX_WRITE_HEADER").is_some() {
        std::fs::write(&file, &made).unwrap();
    }
    // a Windows checkout may turn the file's line ends into CRLF
    let have = std::fs::read_to_string(&file).unwrap_or_default().replace("\r\n", "\n");
    let made = String::from_utf8(made).unwrap();
    assert!(
        have == made,
        "{} is not what cbindgen makes from ffi/src/lib.rs: BOX_WRITE_HEADER=1 cargo test -p box-ffi",
        file.display()
    );
}
