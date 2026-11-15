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
    // The code component, to share with other apps: it knows nothing of CodeBoard (CodeComponentBoundaryTests).
    // CodeCore: the rules, on text alone; CodeUI: laying code out and drawing it
    .target(name: "CodeCore"),
    .target(name: "CodeUI", dependencies: ["CodeCore"]),
    .target(name: "CodeBoardModel", dependencies: ["CodeCore"]),
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
    // what a test process may not show or touch (menus, alerts, panels, the browser, Finder, the clipboard), replaced
    .target(name: "CodeBoardTestGuard", dependencies: ["CodeBoardModel"]),
    .target(
      name: "CodeBoardCanvas",
      dependencies: [
        "CodeBoardModel", "CodeBoardSyntax", "CodeBoardNotes", "CodeBoardTestGuard", "CodeBoardMarkdown",
        "CodeBoardMarkdownUI", "CodeUI",
      ]),
    .target(name: "CodeBoardShell", dependencies: ["CodeBoardModel", "CodeBoardCanvas", "CodeBoardNotes"]),
    .executableTarget(name: "CodeBoard", dependencies: ["CodeBoardShell"]),
    .executableTarget(name: "CanvasBench", dependencies: ["CodeBoardCanvas", "CodeBoardNotes", "CodeBoardSyntax"]),
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
    .testTarget(name: "CodeBoardCanvasTests", dependencies: ["CodeBoardCanvas", "CodeBoardTestGuard"]),
    .testTarget(name: "CodeCoreTests", dependencies: ["CodeCore"], resources: [.copy("Fixtures")]),
    .testTarget(name: "CodeUITests", dependencies: ["CodeUI"]),
    .testTarget(
      name: "CodeBoardShellTests",
      dependencies: ["CodeBoardShell", "CodeBoardCanvas", "CodeBoardNotes", "CodeBoardTestGuard"]),
  ]
)

// The native Markdown component (apps/macos/docs/markdown-guideline.md), self-contained: the canvas draws its Markdown
// at rest with it, and it depends on none of the app's targets but the test guard, which its editor installs in a test
// process as the canvas does (CodeBoardSyntax colours code for the look tool only)
package.targets += [
  // Markdown parsed the way @yhnocoder/markdown parses it, with source ranges, and its editing rules (guideline 6.2)
  .target(name: "CodeBoardMarkdown", dependencies: ["CodeCore"]),
  // Markdown laid out and drawn with CoreText, edited in place; formulas and diagrams through JavaScriptCore (6.3)
  .target(name: "CodeBoardMarkdownUI", dependencies: ["CodeBoardMarkdown", "CodeBoardTestGuard"]),
  .executableTarget(name: "MarkdownBench", dependencies: ["CodeBoardMarkdown", "CodeBoardMarkdownUI"]),
  .executableTarget(
    name: "MarkdownLook", dependencies: ["CodeBoardMarkdown", "CodeBoardMarkdownUI", "CodeBoardSyntax"]),
  .testTarget(name: "CodeBoardMarkdownTests", dependencies: ["CodeBoardMarkdown"], resources: [.copy("Fixtures")]),
  .testTarget(name: "CodeBoardMarkdownUITests", dependencies: ["CodeBoardMarkdownUI", "CodeBoardTestGuard"]),
]
// a window to try the component in, standing alone (tools/markdown/make-demo.sh packages it); code coloured by
// CodeBoardSyntax, as the look tool colours it; a vault's Notes read with CodeBoardModel. The kit runs it in any process
// (runMarkdownDemo), for a driver too
package.targets += [
  .target(
    name: "MarkdownDemoKit",
    dependencies: [
      "CodeBoardMarkdown", "CodeBoardMarkdownUI", "CodeBoardSyntax", "CodeBoardModel", "CodeBoardTestGuard",
    ]),
  .executableTarget(name: "MarkdownDemo", dependencies: ["MarkdownDemoKit"]),
  .testTarget(name: "MarkdownDemoKitTests", dependencies: ["MarkdownDemoKit", "CodeBoardModel", "CodeBoardTestGuard"]),
]
// No warnings in our own Swift (the Markdown component included, so after its targets): a concurrency warning (Swift 6 downgrades some isolation errors from AppKit's overrides)
// is as much a crash as an error, and the rest stay at zero with it. The native Markdown component's targets, added
// below, are not under it yet
for t in package.targets where t.name != "CTreeSitterScanners" {
  t.swiftSettings = (t.swiftSettings ?? []) + [.treatAllWarnings(as: .error)]
}
