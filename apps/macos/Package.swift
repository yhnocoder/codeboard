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
    .target(name: "CodeBoardNotes", dependencies: ["CodeBoardModel"]),
    .target(name: "CodeBoardCanvas", dependencies: ["CodeBoardModel", "CodeBoardSyntax", "CodeBoardNotes"]),
    .target(name: "CodeBoardShell", dependencies: ["CodeBoardModel", "CodeBoardCanvas", "CodeBoardNotes"]),
    .executableTarget(name: "CodeBoard", dependencies: ["CodeBoardShell"]),
    .executableTarget(name: "CanvasBench", dependencies: ["CodeBoardCanvas", "CodeBoardNotes"]),
    // the acceptance driver (tools/accept/README.md): it runs CodeBoard, or with ACCEPT_APP=demo the Markdown demo, in
    // its own process
    .executableTarget(
      name: "Accept", dependencies: ["CodeBoardShell", "CodeBoardCanvas", "CodeBoardModel", "MarkdownDemoKit"]),
    .executableTarget(
      name: "LookCompare",
      dependencies: ["CodeBoardCanvas", "CodeBoardModel", "CodeBoardNotes", "CodeBoardSyntax", "CodeBoardShell"]),
    .executableTarget(
      name: "Drive", dependencies: ["CodeBoardShell", "CodeBoardCanvas", "CodeBoardModel", "CodeBoardNotes"]),
    .testTarget(name: "CodeBoardModelTests", dependencies: ["CodeBoardModel"], resources: [.copy("Fixtures")]),
    .testTarget(name: "CodeBoardSyntaxTests", dependencies: ["CodeBoardSyntax"]),
    .testTarget(name: "CodeBoardNotesTests", dependencies: ["CodeBoardNotes"]),
    .testTarget(name: "CodeBoardCanvasTests", dependencies: ["CodeBoardCanvas"]),
    .testTarget(name: "CodeBoardShellTests", dependencies: ["CodeBoardShell", "CodeBoardCanvas", "CodeBoardNotes"]),
  ]
)

// No warnings in our own Swift: a concurrency warning (Swift 6 downgrades some isolation errors from AppKit's overrides)
// is as much a crash as an error, and the rest stay at zero with it. The native Markdown component's targets, added
// below, are not under it yet
for t in package.targets where t.name != "CTreeSitterScanners" {
  t.swiftSettings = (t.swiftSettings ?? []) + [.treatAllWarnings(as: .error)]
}

// The native Markdown component (apps/macos/docs/markdown-guideline.md), self-contained: no target of the app depends
// on it yet, and it depends on none of the app's but CodeBoardSyntax, which only the look tool uses for code colours
package.targets += [
  // Markdown parsed the way @yhnocoder/markdown parses it, with source ranges, and its editing rules (guideline 6.2)
  .target(name: "CodeBoardMarkdown"),
  // Markdown laid out and drawn with CoreText, edited in place; formulas and diagrams through JavaScriptCore (6.3)
  .target(name: "CodeBoardMarkdownUI", dependencies: ["CodeBoardMarkdown"]),
  .executableTarget(name: "MarkdownBench", dependencies: ["CodeBoardMarkdown", "CodeBoardMarkdownUI"]),
  .executableTarget(
    name: "MarkdownLook", dependencies: ["CodeBoardMarkdown", "CodeBoardMarkdownUI", "CodeBoardSyntax"]),
  .testTarget(name: "CodeBoardMarkdownTests", dependencies: ["CodeBoardMarkdown"], resources: [.copy("Fixtures")]),
  .testTarget(name: "CodeBoardMarkdownUITests", dependencies: ["CodeBoardMarkdownUI"]),
]
// a window to try the component in, standing alone (tools/markdown/make-demo.sh packages it); code coloured by
// CodeBoardSyntax, as the look tool colours it; a vault's Notes read with CodeBoardModel. The kit runs it in any process
// (runMarkdownDemo), for a driver too
package.targets += [
  .target(
    name: "MarkdownDemoKit",
    dependencies: ["CodeBoardMarkdown", "CodeBoardMarkdownUI", "CodeBoardSyntax", "CodeBoardModel"]),
  .executableTarget(name: "MarkdownDemo", dependencies: ["MarkdownDemoKit"]),
  .testTarget(name: "MarkdownDemoKitTests", dependencies: ["MarkdownDemoKit", "CodeBoardModel"]),
]

// Code analysis for reading code (symbols, calls, selections, peek, cross-language boundaries), a port of
// packages/analysis with its tests as the specification. Foundation and tree-sitter only, with its own small
// tree-sitter wrapper instead of CodeBoardSyntax's, so that it stands alone; no target depends on it yet
package.targets += [
  .target(
    name: "CodeBoardAnalysis",
    dependencies: [
      .product(name: "TreeSitter", package: "tree-sitter"),
      .product(name: "TreeSitterPython", package: "tree-sitter-python"),
      .product(name: "TreeSitterRust", package: "tree-sitter-rust"),
      .product(name: "TreeSitterCUDA", package: "tree-sitter-cuda"),
      "CTreeSitterScanners",
    ],
    swiftSettings: [.treatAllWarnings(as: .error)]
  ),
  .testTarget(
    name: "CodeBoardAnalysisTests",
    dependencies: ["CodeBoardAnalysis"],
    resources: [.copy("Fixtures")],
    swiftSettings: [.treatAllWarnings(as: .error)]
  ),
]
