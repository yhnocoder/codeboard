// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "CanvasProto",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "CanvasProto",
            path: "Sources/CanvasProto"
        )
    ]
)
