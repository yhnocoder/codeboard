// swift-tools-version:6.4
import PackageDescription

let package = Package(
  name: "CodeBoard",
  platforms: [.macOS(.v27)],
  // the code and Markdown components (CodeCore, CodeUI, TreeSitterCore, TreeSitterHighlight, MarkdownCore, MarkdownUI)
  // and the test guard: a package of their own, knowing nothing of CodeBoard; tree-sitter and its grammars come with it
  dependencies: [
    .package(url: "https://github.com/yhnocoder/better-swift-markdown", branch: "main"),
    .package(url: "https://github.com/yhnocoder/shiyi", from: "0.2.0"),
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
      name: "CodeBoardShell",
      dependencies: [
        "CodeBoardModel", "CodeBoardCanvas", "CodeBoardNotes", "CodeBoardReading", "CodeBoardResources",
        "CodeBoardWorkspace",
        .product(name: "Shiyi", package: "shiyi"),
      ]),
    .executableTarget(name: "CodeBoard", dependencies: ["CodeBoardShell"]),
    .executableTarget(
      name: "CanvasBench",
      dependencies: [
        "CodeBoardCanvas", "CodeBoardNotes", .product(name: "TreeSitterHighlight", package: "better-swift-markdown"),
      ]),
    // the acceptance driver (tools/accept/README.md): it runs CodeBoard, or with ACCEPT_APP=demo the Markdown demo, in
    // its own process
    .executableTarget(
      name: "Accept",
      dependencies: [
        "CodeBoardShell", "CodeBoardCanvas", "CodeBoardModel", "CodeBoardReading", "CodeBoardResources",
        "MarkdownDemoKit",
      ]),
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
    // packages/analysis with its tests as the specification. Foundation and the package's TreeSitterCore only, whose
    // trees the highlighter colours too; no target depends on it yet
    .target(
      name: "CodeBoardAnalysis",
      dependencies: [.product(name: "TreeSitterCore", package: "better-swift-markdown")]),
    .testTarget(
      name: "CodeBoardAnalysisTests",
      dependencies: ["CodeBoardAnalysis", .product(name: "TreeSitterCore", package: "better-swift-markdown")],
      resources: [.copy("Fixtures")]),
    // What the host knows of the code folders a board reads, a port of packages/host's code logic: analyses kept by
    // content, the workspace's name index, the background work's priorities, git and the segments' versions, the
    // language servers' answers and what the host makes of them, over a CodeWorkspace (a folder on disk,
    // FolderWorkspace). Foundation and CodeBoardAnalysis only
    .target(name: "CodeBoardWorkspace", dependencies: ["CodeBoardAnalysis"]),
    .testTarget(
      name: "CodeBoardWorkspaceTests", dependencies: ["CodeBoardWorkspace", "CodeBoardAnalysis"], exclude: ["Fixtures"]),
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
        "CodeBoardShell", "CodeBoardCanvas", "CodeBoardNotes", "CodeBoardWorkspace",
        .product(name: "TestGuard", package: "better-swift-markdown"),
      ]),
    // the reading pane beside the board and what its tabs show (PDF/, Web/, List/, Shared/); AppKit, PDFKit, the model
    // and a resource's files, below the shell
    .target(name: "CodeBoardReading", dependencies: ["CodeBoardModel", "CodeBoardResources"]),
    .testTarget(
      name: "CodeBoardReadingTests", dependencies: ["CodeBoardReading", "CodeBoardModel", "CodeBoardResources"]),
    .testTarget(
      name: "MarkdownDemoKitTests",
      dependencies: [
        "MarkdownDemoKit", "CodeBoardModel", .product(name: "TestGuard", package: "better-swift-markdown"),
      ]),
    // a resource's files (FORMAT.md, Resources): resource.json and its entries read and written; Foundation and the
    // model only
    .target(name: "CodeBoardResources", dependencies: ["CodeBoardModel"]),
    .testTarget(name: "CodeBoardResourcesTests", dependencies: ["CodeBoardResources"]),
  ]
)

// No warnings in our own Swift: a concurrency warning (Swift 6 downgrades some isolation errors from AppKit's
// overrides) is as much a crash as an error, and the rest stay at zero with it
for t in package.targets {
  t.swiftSettings = (t.swiftSettings ?? []) + [.treatAllWarnings(as: .error)]
}
