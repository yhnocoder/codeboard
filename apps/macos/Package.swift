// swift-tools-version:6.4
import PackageDescription

let package = Package(
  name: "CodeBoard",
  platforms: [.macOS(.v27)],
  targets: [
    .target(name: "CodeBoardModel"),
    .target(name: "CodeBoardSyntax", dependencies: ["CTreeSitter", "CTreeSitterGrammars"]),
    // Vendored C, built as upstream builds it (lib.c includes every other runtime file); SwiftPM's extra warning is
    // about code that is not ours to change
    .target(
      name: "CTreeSitter",
      exclude: ["LICENSE", "src/unicode/ICU_SHA", "src/unicode/LICENSE", "src/unicode/README.md"],
      sources: ["src/lib.c"],
      cSettings: [
        .headerSearchPath("src"), .define("_POSIX_C_SOURCE", to: "200112L"), .define("_DEFAULT_SOURCE"),
        .define("_DARWIN_C_SOURCE"), .disableWarning("shorten-64-to-32"),
      ]
    ),
    .target(
      name: "CTreeSitterGrammars",
      dependencies: ["CTreeSitter"],
      exclude: ["python/LICENSE", "rust/LICENSE", "cuda/LICENSE"],
      cSettings: [.disableWarning("shorten-64-to-32")]
    ),
    .target(name: "CodeBoardNotes", dependencies: ["CodeBoardModel"]),
    .target(name: "CodeBoardCanvas", dependencies: ["CodeBoardModel", "CodeBoardSyntax", "CodeBoardNotes"]),
    .target(name: "CodeBoardShell", dependencies: ["CodeBoardModel", "CodeBoardCanvas"]),
    .executableTarget(name: "CodeBoard", dependencies: ["CodeBoardShell"]),
    .executableTarget(name: "CanvasBench", dependencies: ["CodeBoardCanvas"]),
    .testTarget(name: "CodeBoardModelTests", dependencies: ["CodeBoardModel"], resources: [.copy("Fixtures")]),
    .testTarget(name: "CodeBoardSyntaxTests", dependencies: ["CodeBoardSyntax"]),
    .testTarget(name: "CodeBoardNotesTests", dependencies: ["CodeBoardNotes"]),
    .testTarget(name: "CodeBoardCanvasTests", dependencies: ["CodeBoardCanvas"]),
    .testTarget(name: "CodeBoardShellTests", dependencies: ["CodeBoardShell"]),
  ]
)
