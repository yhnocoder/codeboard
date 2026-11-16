// swift-tools-version:6.4
import PackageDescription

let package = Package(
  name: "CodeBoard",
  platforms: [.macOS(.v27)],
  // the code and Markdown components (CodeCore, CodeUI, TreeSitterHighlight, MarkdownCore, MarkdownUI) and the test
  // guard: a package of their own, knowing nothing of CodeBoard
  dependencies: [
    .package(url: "https://github.com/yhnocoder/better-swift-markdown", branch: "main"),
    // tree-sitter and the grammars, as the package pins them, for CodeBoardAnalysis
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
    .target(name: "CodeBoardModel", dependencies: [.product(name: "CodeCore", package: "better-swift-markdown")]),
    .target(name: "CodeBoardNotes", dependencies: ["CodeBoardModel"]),
    // the board's looks (Warm Ink, Ink Wash, light and dark) as the Markdown component's themes, and its fonts
    .target(
      name: "CodeBoardMarkdownLooks",
      dependencies: [
        .product(name: "MarkdownCore", package: "better-swift-markdown"),
        .product(name: "MarkdownUI", package: "better-swift-markdown"),
      ]),
    .target(
      name: "CodeBoardCanvas",
      dependencies: [
        "CodeBoardModel", "CodeBoardNotes", "CodeBoardMarkdownLooks",
        .product(name: "TreeSitterHighlight", package: "better-swift-markdown"),
        .product(name: "TestGuard", package: "better-swift-markdown"),
        .product(name: "MarkdownCore", package: "better-swift-markdown"),
        .product(name: "MarkdownUI", package: "better-swift-markdown"),
        .product(name: "CodeUI", package: "better-swift-markdown"),
      ]),
    .target(
      name: "CodeBoardShell", dependencies: ["CodeBoardModel", "CodeBoardCanvas", "CodeBoardNotes", "CodeBoardReading"]),
    .executableTarget(name: "CodeBoard", dependencies: ["CodeBoardShell"]),
    .executableTarget(
      name: "CanvasBench",
      dependencies: [
        "CodeBoardCanvas", "CodeBoardNotes", .product(name: "TreeSitterHighlight", package: "better-swift-markdown"),
      ]),
    // the acceptance driver (tools/accept/README.md): it runs CodeBoard, or with ACCEPT_APP=demo the Markdown demo, in
    // its own process
    .executableTarget(
      name: "Accept", dependencies: ["CodeBoardShell", "CodeBoardCanvas", "CodeBoardModel", "MarkdownDemoKit"]),
    .executableTarget(
      name: "LookCompare",
      dependencies: [
        "CodeBoardCanvas", "CodeBoardModel", "CodeBoardNotes", "CodeBoardShell", "CodeBoardMarkdownLooks",
        .product(name: "TreeSitterHighlight", package: "better-swift-markdown"),
        .product(name: "MarkdownCore", package: "better-swift-markdown"),
        .product(name: "MarkdownUI", package: "better-swift-markdown"),
      ]),
    .executableTarget(
      name: "Drive", dependencies: ["CodeBoardShell", "CodeBoardCanvas", "CodeBoardModel", "CodeBoardNotes"]),
    // the board's Notes drawn by the component beside the web board's (tools/markdown/look.mjs)
    .executableTarget(
      name: "MarkdownLook",
      dependencies: [
        "CodeBoardMarkdownLooks",
        .product(name: "MarkdownCore", package: "better-swift-markdown"),
        .product(name: "MarkdownUI", package: "better-swift-markdown"),
        .product(name: "CodeUI", package: "better-swift-markdown"),
        .product(name: "TreeSitterHighlight", package: "better-swift-markdown"),
      ]),
    // a window to try the component in, standing alone (tools/markdown/make-demo.sh packages it); code coloured by
    // TreeSitterHighlight, as the look tool colours it; a vault's Notes read with CodeBoardModel. The kit runs it in any
    // process (runMarkdownDemo), for a driver too
    .target(
      name: "MarkdownDemoKit",
      dependencies: [
        "CodeBoardModel", "CodeBoardMarkdownLooks",
        .product(name: "MarkdownCore", package: "better-swift-markdown"),
        .product(name: "MarkdownUI", package: "better-swift-markdown"),
        .product(name: "CodeUI", package: "better-swift-markdown"),
        .product(name: "TreeSitterHighlight", package: "better-swift-markdown"),
        .product(name: "TestGuard", package: "better-swift-markdown"),
      ]),
    .executableTarget(name: "MarkdownDemo", dependencies: ["MarkdownDemoKit"]),
    // Code analysis for reading code (symbols, calls, selections, peek, cross-language boundaries), a port of
    // packages/analysis with its tests as the specification. Foundation and tree-sitter only, with its own small
    // tree-sitter wrapper instead of TreeSitterHighlight's; no target depends on it yet. TreeSitterHighlight is linked,
    // not imported: it carries the Python grammar's external scanner, which the grammar's package leaves out
    .target(
      name: "CodeBoardAnalysis",
      dependencies: [
        .product(name: "TreeSitter", package: "tree-sitter"),
        .product(name: "TreeSitterPython", package: "tree-sitter-python"),
        .product(name: "TreeSitterRust", package: "tree-sitter-rust"),
        .product(name: "TreeSitterCUDA", package: "tree-sitter-cuda"),
        .product(name: "TreeSitterHighlight", package: "better-swift-markdown"),
      ]),
    .testTarget(name: "CodeBoardAnalysisTests", dependencies: ["CodeBoardAnalysis"], resources: [.copy("Fixtures")]),
    .testTarget(name: "CodeBoardModelTests", dependencies: ["CodeBoardModel"], resources: [.copy("Fixtures")]),
    .testTarget(name: "CodeBoardNotesTests", dependencies: ["CodeBoardNotes"]),
    .testTarget(
      name: "CodeBoardMarkdownLooksTests",
      dependencies: [
        "CodeBoardMarkdownLooks",
        .product(name: "MarkdownCore", package: "better-swift-markdown"),
        .product(name: "MarkdownUI", package: "better-swift-markdown"),
        .product(name: "CodeUI", package: "better-swift-markdown"),
      ]),
    .testTarget(
      name: "CodeBoardCanvasTests",
      dependencies: ["CodeBoardCanvas", .product(name: "TestGuard", package: "better-swift-markdown")]),
    .testTarget(
      name: "CodeBoardShellTests",
      dependencies: [
        "CodeBoardShell", "CodeBoardCanvas", "CodeBoardNotes",
        .product(name: "TestGuard", package: "better-swift-markdown"),
      ]),
    // the reading pane beside the board and what its tabs show (PDF/, Web/, List/, Shared/); AppKit only, below the shell
    .target(name: "CodeBoardReading"),
    .testTarget(name: "CodeBoardReadingTests", dependencies: ["CodeBoardReading"]),
    .testTarget(
      name: "MarkdownDemoKitTests",
      dependencies: [
        "MarkdownDemoKit", "CodeBoardModel", .product(name: "TestGuard", package: "better-swift-markdown"),
      ]),
  ]
)

// No warnings in our own Swift: a concurrency warning (Swift 6 downgrades some isolation errors from AppKit's
// overrides) is as much a crash as an error, and the rest stay at zero with it
for t in package.targets {
  t.swiftSettings = (t.swiftSettings ?? []) + [.treatAllWarnings(as: .error)]
}
