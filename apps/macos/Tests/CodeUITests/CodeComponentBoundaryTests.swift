import Foundation
import Testing

// The code component is to be shared with other apps: it imports the system's frameworks and itself only, and nothing in
// it speaks of CodeBoard, its targets or its things (boards, cards, segments, sidenotes, stickers, vaults).
private let allowed: [String: Set<String>] = [
  "CodeCore": ["Foundation"],
  "CodeUI": ["AppKit", "CodeCore", "CoreGraphics", "CoreText", "Foundation", "QuartzCore"],
  "TreeSitterHighlight": [
    "CodeUI", "Foundation", "TreeSitter", "TreeSitterCUDA", "TreeSitterPython", "TreeSitterRust",
  ],
  // the guard a component's tests run under (TestGuard: named so until the component's own package)
  "CodeBoardTestGuard": ["AppKit"],
]

@Test(arguments: allowed.keys.sorted())
func theCodeComponentKnowsNothingOfCodeBoard(_ target: String) throws {
  let sources = URL(filePath: #filePath).deletingLastPathComponent().appending(path: "../../Sources/\(target)")
  let files = try #require(FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil))
    .compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" }
  #expect(!files.isEmpty)
  let ok = allowed[target] ?? []
  let importLine = /^\s*(?:@\w+\s+)*import\s+(?:(?:typealias|struct|class|enum|protocol|let|var|func)\s+)?(\w+)/
    .anchorsMatchLineEndings()
  let theirs = /(?i)codeboard|\b(?:boards?|cards?|segments?|sidenotes?|stickers?|vaults?|always show)\b/
  for file in files {
    let text = try String(contentsOf: file, encoding: .utf8)
    for match in text.matches(of: importLine) where !ok.contains(String(match.1)) {
      Issue.record("\(target)/\(file.lastPathComponent) imports \(match.1)")
    }
    for match in text.matches(of: theirs) {
      Issue.record("\(target)/\(file.lastPathComponent) says \"\(match.0)\"")
    }
  }
}
