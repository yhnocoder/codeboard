// The external scanner of the Python grammar, copied unchanged from the version Package.swift pins:
// - python/scanner.c: tree-sitter/tree-sitter-python 0.25.0 (293fdc02038ee2bf0e2e206711b69c90ac0d413f)
// - tree_sitter/*.h: the headers it includes, from tree-sitter-python's src/
// That package's manifest adds src/scanner.c only when it exists relative to the working directory, which for a
// dependency it never does, so it builds its parser without it and leaves its functions to this target. Copy it again
// when the pin moves; once the pinned manifest compiles its own scanner, the duplicate symbols fail the link.
// Nothing to declare: the parser calls the scanner directly.
