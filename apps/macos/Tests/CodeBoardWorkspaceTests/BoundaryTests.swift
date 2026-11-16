import Foundation
import Testing

// What the host knows of code folders must stay usable without any UI and in any shell, so it imports Foundation, the
// standard library's Synchronization and the analysis only
@Test func workspaceImportsOnlyFoundationAndTheAnalysis() throws {
  let sources = URL(filePath: #filePath).deletingLastPathComponent().appending(path: "../../Sources/CodeBoardWorkspace")
  let files = try #require(FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil))
    .compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" }
  #expect(!files.isEmpty)
  let importLine = /^\s*(?:@\w+\s+)*import\s+(?:(?:typealias|struct|class|enum|protocol|let|var|func)\s+)?(\w+)/
    .anchorsMatchLineEndings()
  for file in files {
    for match in try String(contentsOf: file, encoding: .utf8).matches(of: importLine)
    where !["Foundation", "Synchronization", "CodeBoardAnalysis"].contains(match.1) {
      Issue.record("\(file.lastPathComponent) imports \(match.1)")
    }
  }
}
