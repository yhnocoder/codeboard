// The generated tree-sitter parsers, vendored unchanged (each grammar's src/ and LICENSE), pinned to what the
// TypeScript side runs so both read code with the same grammars:
// - python: tree-sitter-python 0.25.0, the npm tarball (what @vscode/tree-sitter-wasm 0.3.1 builds)
// - rust: tree-sitter/tree-sitter-rust at 261b20226c04ef601adbdf185a800512a5f66291 (pinned by @vscode/tree-sitter-wasm 0.3.1)
// - cuda: yhnocoder/tree-sitter-cuda v0.21.2-cb.2 (a1b629c7f653d6ce9fb4b0a71823605836c65754), the fork whose release
//   packages/analysis installs; one grammar for C, C++ and CUDA, as there
// The runtime (CTreeSitter) is tree-sitter v0.25.10 lib/ (da6fe9beb4f7f67beb75914ca8e0d48ae48d6406) without src/wasm,
// the runtime @vscode/tree-sitter-wasm 0.3.1 compiles.
// To update one, replace its folder from the new version's sources and run the CodeBoardSyntax tests.
#pragma once
#include <tree_sitter/api.h>

const TSLanguage *_Nonnull tree_sitter_python(void);
const TSLanguage *_Nonnull tree_sitter_rust(void);
const TSLanguage *_Nonnull tree_sitter_cuda(void);
