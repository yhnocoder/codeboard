// swift-tools-version:6.4
import PackageDescription

let package = Package(
  name: "CodeBoard",
  platforms: [.macOS(.v27)],
  targets: [
    .target(name: "CodeBoardModel"),
    .target(name: "CodeBoardCanvas", dependencies: ["CodeBoardModel"]),
    .executableTarget(name: "CodeBoard", dependencies: ["CodeBoardCanvas"]),
    .testTarget(name: "CodeBoardModelTests", dependencies: ["CodeBoardModel"]),
    .testTarget(name: "CodeBoardCanvasTests", dependencies: ["CodeBoardCanvas"]),
  ]
)
