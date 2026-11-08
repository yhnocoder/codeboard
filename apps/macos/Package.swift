// swift-tools-version: 6.0
// The CodeBoard macOS app. build.sh bundles the JavaScript side (dist/bridge.js), builds this and assembles CodeBoard.app.
import PackageDescription

let package = Package(
  name: "CodeBoard",
  platforms: [.macOS("26.0")],
  targets: [
    .executableTarget(
      name: "CodeBoard",
      path: "Sources/CodeBoard",
      swiftSettings: [.unsafeFlags(["-Onone"], .when(configuration: .debug))],
      linkerSettings: [.linkedFramework("JavaScriptCore"), .linkedFramework("AppKit"), .linkedFramework("QuartzCore")]
    ),
    .testTarget(name: "CodeBoardTests", dependencies: ["CodeBoard"], path: "Tests/CodeBoardTests"),
  ],
  swiftLanguageModes: [.v5]
)
