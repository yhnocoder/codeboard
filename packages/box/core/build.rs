// ONNX Runtime's prebuilt macOS library (the reranker, feature rerank) checks the OS version with clang's `@available`,
// which calls __isPlatformVersionAtLeast from clang's runtime library; rustc links with -nodefaultlibs, so it is linked here
fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    let rerank = std::env::var_os("CARGO_FEATURE_RERANK").is_some();
    if !rerank || std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let out = std::process::Command::new("cc")
        .arg("--print-resource-dir")
        .output()
        .expect("cc --print-resource-dir");
    let dir = String::from_utf8(out.stdout).expect("a path");
    let lib = std::path::Path::new(dir.trim()).join("lib").join("darwin");
    assert!(
        lib.join("libclang_rt.osx.a").is_file(),
        "no libclang_rt.osx.a in {}",
        lib.display()
    );
    println!("cargo:rustc-link-search=native={}", lib.display());
    println!("cargo:rustc-link-lib=static=clang_rt.osx");
}
