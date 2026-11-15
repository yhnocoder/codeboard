import Foundation
import Testing

// The code and Markdown components are to be shared with other apps: they import the system's frameworks and each other
// only, and nothing in them speaks of CodeBoard, its targets or its things (boards, cards, segments, sidenotes,
// stickers, vaults). Until the components have a package of their own, their targets keep CodeBoard's names, and the
// board's looks (Looks.swift: Warm Ink and Ink Wash, the board's fonts) stay beside the Markdown component's code, which
// takes its themes and fonts from the host; both go with the split.
private let allowed: [String: Set<String>] = [
  "CodeCore": ["Foundation"],
  "CodeUI": ["AppKit", "CodeCore", "CoreGraphics", "CoreText", "Foundation", "QuartzCore"],
  "TreeSitterHighlight": [
    "CodeUI", "Foundation", "TreeSitter", "TreeSitterCUDA", "TreeSitterPython", "TreeSitterRust",
  ],
  // the guard a component's tests run under (TestGuard: named so until the component's own package)
  "CodeBoardTestGuard": ["AppKit"],
  "CodeBoardMarkdown": ["CodeCore", "Foundation"],
  "CodeBoardMarkdownUI": [
    "AppKit", "CodeBoardMarkdown", "CodeBoardTestGuard", "CodeUI", "CoreGraphics", "CoreText", "Foundation",
    "JavaScriptCore", "Synchronization",
  ],
  // the component's own bench and demo, in its sample look
  "MarkdownBench": [
    "AppKit", "CodeBoardMarkdown", "CodeBoardMarkdownUI", "CodeUI", "CoreGraphics", "Foundation", "ImageIO",
    "UniformTypeIdentifiers",
  ],
  "MarkdownEditorDemo": [
    "AppKit", "CodeBoardMarkdown", "CodeBoardMarkdownUI", "CodeUI", "Foundation", "ImageIO", "TreeSitterHighlight",
  ],
]
/// The components' own targets, by the names they keep until the split
private let ownNames = ["CodeBoardMarkdownUI", "CodeBoardMarkdown", "CodeBoardTestGuard"]
/// What goes to CodeBoard with the split
private let theBoards: Set<String> = ["CodeBoardMarkdownUI/Looks.swift"]

@Test(arguments: allowed.keys.sorted())
func theCodeComponentKnowsNothingOfCodeBoard(_ target: String) throws {
  let sources = URL(filePath: #filePath).deletingLastPathComponent().appending(path: "../../Sources/\(target)")
  let files = try #require(FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil))
    .compactMap { $0 as? URL }.filter {
      $0.pathExtension == "swift" && !theBoards.contains("\(target)/\($0.lastPathComponent)")
    }
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
    for match in ownNames.reduce(text, { $0.replacingOccurrences(of: $1, with: "") }).matches(of: theirs) {
      Issue.record("\(target)/\(file.lastPathComponent) says \"\(match.0)\"")
    }
  }
}
