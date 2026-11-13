// swift-tools-version:6.4
import PackageDescription

let package = Package(
  name: "CodeBoard",
  platforms: [.macOS(.v27)],
  // tree-sitter and the grammars the TypeScript side runs (@vscode/tree-sitter-wasm 0.3.1 for the runtime, Python and
  // Rust; packages/analysis's tree-sitter-cuda for C, C++ and CUDA), so both read code with the same grammars
  dependencies: [
    .package(url: "https://github.com/tree-sitter/tree-sitter", exact: "0.25.10"),
    .package(url: "https://github.com/tree-sitter/tree-sitter-python", exact: "0.25.0"),
    // untagged: v0.24.0 and six commits
    .package(
      url: "https://github.com/tree-sitter/tree-sitter-rust",
      revision: "261b20226c04ef601adbdf185a800512a5f66291"
    ),
    .package(url: "https://github.com/yhnocoder/tree-sitter-cuda", exact: "0.21.2-cb.3"),
  ],
  targets: [
    .target(name: "CodeBoardModel"),
    // Markdown parsed the way @yhnocoder/markdown parses it, with source ranges (docs/markdown-guideline.md 6.2)
    .target(name: "CodeBoardMarkdown"),
    // Markdown laid out and drawn with CoreText, formulas and diagrams through JavaScriptCore (guideline 6.3)
    .target(name: "CodeBoardMarkdownUI", dependencies: ["CodeBoardMarkdown"]),
    .target(
      name: "CodeBoardSyntax",
      dependencies: [
        .product(name: "TreeSitter", package: "tree-sitter"),
        .product(name: "TreeSitterPython", package: "tree-sitter-python"),
        .product(name: "TreeSitterRust", package: "tree-sitter-rust"),
        .product(name: "TreeSitterCUDA", package: "tree-sitter-cuda"),
        "CTreeSitterScanners",
      ]
    ),
    // The Python grammar's external scanner, which its package leaves out (include/scanners.h says why)
    .target(
      name: "CTreeSitterScanners",
      exclude: ["python/LICENSE"],
      cSettings: [.headerSearchPath("."), .disableWarning("shorten-64-to-32")]
    ),
    .target(name: "CodeBoardNotes", dependencies: ["CodeBoardModel", "CodeBoardMarkdown", "CodeBoardMarkdownUI"]),
    .target(name: "CodeBoardCanvas", dependencies: ["CodeBoardModel", "CodeBoardSyntax", "CodeBoardNotes"]),
    .target(name: "CodeBoardShell", dependencies: ["CodeBoardModel", "CodeBoardCanvas"]),
    .executableTarget(name: "CodeBoard", dependencies: ["CodeBoardShell"]),
    .executableTarget(name: "CanvasBench", dependencies: ["CodeBoardCanvas", "CodeBoardNotes"]),
    .executableTarget(
      name: "MarkdownLook",
      dependencies: ["CodeBoardMarkdown", "CodeBoardMarkdownUI", "CodeBoardModel", "CodeBoardNotes", "CodeBoardSyntax"]),
    .executableTarget(name: "LookCompare", dependencies: ["CodeBoardCanvas", "CodeBoardModel", "CodeBoardSyntax"]),
    .testTarget(name: "CodeBoardMarkdownTests", dependencies: ["CodeBoardMarkdown"], resources: [.copy("Fixtures")]),
    .testTarget(name: "CodeBoardMarkdownUITests", dependencies: ["CodeBoardMarkdownUI"]),
    .testTarget(name: "CodeBoardModelTests", dependencies: ["CodeBoardModel"], resources: [.copy("Fixtures")]),
    .testTarget(name: "CodeBoardSyntaxTests", dependencies: ["CodeBoardSyntax"]),
    .testTarget(name: "CodeBoardNotesTests", dependencies: ["CodeBoardNotes", "CodeBoardMarkdownUI"]),
    .testTarget(name: "CodeBoardCanvasTests", dependencies: ["CodeBoardCanvas"]),
    .testTarget(name: "CodeBoardShellTests", dependencies: ["CodeBoardShell"]),
  ]
)
