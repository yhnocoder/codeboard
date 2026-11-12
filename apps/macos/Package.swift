// swift-tools-version:6.4
import PackageDescription

let package = Package(
  name: "CodeBoard",
  platforms: [.macOS(.v27)],
  targets: [
    .target(name: "CodeBoardModel"),
    .target(name: "CodeBoardSyntax"),
    .target(name: "CodeBoardNotes", dependencies: ["CodeBoardModel"]),
    .target(name: "CodeBoardCanvas", dependencies: ["CodeBoardModel"]),
    .target(name: "CodeBoardShell", dependencies: ["CodeBoardModel", "CodeBoardCanvas"]),
    .executableTarget(name: "CodeBoard", dependencies: ["CodeBoardCanvas"]),
    .executableTarget(name: "CanvasBench", dependencies: ["CodeBoardCanvas"]),
    .testTarget(name: "CodeBoardModelTests", dependencies: ["CodeBoardModel"], resources: [.copy("Fixtures")]),
    .testTarget(name: "CodeBoardSyntaxTests", dependencies: ["CodeBoardSyntax"]),
    .testTarget(name: "CodeBoardNotesTests", dependencies: ["CodeBoardNotes"]),
    .testTarget(name: "CodeBoardCanvasTests", dependencies: ["CodeBoardCanvas"]),
    .testTarget(name: "CodeBoardShellTests", dependencies: ["CodeBoardShell"]),
  ]
)
