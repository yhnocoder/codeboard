// The external scanners of two grammar packages, copied unchanged from the versions Package.swift pins:
// - python/scanner.c: tree-sitter/tree-sitter-python 0.25.0 (293fdc02038ee2bf0e2e206711b69c90ac0d413f)
// - cuda/scanner.c: yhnocoder/tree-sitter-cuda v0.21.2-cb.2 (9bbc052820f228600f8a22cef6d3597759f49a3b)
// - tree_sitter/*.h: the headers they include, from tree-sitter-python's src/ (tree-sitter-cuda's alloc.h and parser.h
//   are the same bytes)
// Both packages' manifests add src/scanner.c only when it exists relative to the working directory, which for a
// dependency it never does, so they build their parsers without it and leave its functions to this target. Copy these
// again when a pin moves; once a pinned manifest compiles its own scanner, the duplicate symbols fail the link.
// Nothing to declare: the parsers call the scanners directly.
