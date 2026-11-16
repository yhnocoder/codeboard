import Foundation
import Testing

// The model (board files, the vault, the legacy importer) must stay usable without any UI, so it imports Foundation only,
// the code component's rules, which import Foundation only themselves (the better-swift-markdown package's
// PackageBoundaryTests), CoreGraphics for the picture type a source gives the board (not a UI framework), and
// CodeBoardDiagnostics, which imports Foundation and the standard library's Synchronization only.
@Test func modelImportsOnlyFoundation() throws {
  let sources = URL(filePath: #filePath).deletingLastPathComponent().appending(path: "../../Sources/CodeBoardModel")
  let files = try #require(FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil))
    .compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" }
  #expect(!files.isEmpty)
  let importLine = /^\s*(?:@\w+\s+)*import\s+(?:(?:typealias|struct|class|enum|protocol|let|var|func)\s+)?(\w+)/
    .anchorsMatchLineEndings()
  for file in files {
    for match in try String(contentsOf: file, encoding: .utf8).matches(of: importLine)
    where !["Foundation", "CodeCore", "CoreGraphics", "CodeBoardDiagnostics"].contains(match.1) {
      Issue.record("\(file.lastPathComponent) imports \(match.1)")
    }
  }
}
