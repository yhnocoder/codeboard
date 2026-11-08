// swift-tools-version:5.9
// box's index inside a Swift app (one process: the Mac app), over box's C ABI (../ffi). Build the library first:
// cargo build --release -p box-ffi (in packages/box), or set BOX_LIB_DIR to the folder holding libbox_ffi.a
import Foundation
import PackageDescription

let here = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let lib = ProcessInfo.processInfo.environment["BOX_LIB_DIR"]
  ?? here.appendingPathComponent("../target/release").standardized.path

let package = Package(
  name: "Box",
  platforms: [.macOS("15.0")],
  products: [.library(name: "Box", targets: ["Box"])],
  targets: [
    .target(
      name: "CBox",
      linkerSettings: [
        .unsafeFlags(["\(lib)/libbox_ffi.a"]),
        .linkedFramework("Security", .when(platforms: [.macOS])),
        .linkedFramework("CoreFoundation", .when(platforms: [.macOS])),
        .linkedLibrary("m", .when(platforms: [.linux])),
        // the C++ inside (usearch)
        .linkedLibrary("c++", .when(platforms: [.macOS])),
        .linkedLibrary("stdc++", .when(platforms: [.linux])),
      ]
    ),
    .target(name: "Box", dependencies: ["CBox"]),
    .testTarget(name: "BoxTests", dependencies: ["Box"]),
  ]
)
