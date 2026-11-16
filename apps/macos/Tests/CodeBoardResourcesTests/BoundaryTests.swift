import Foundation
import Testing

// A resource's files are read and written without any UI, as the model's are: Foundation and the model only.
@Test func resourcesImportOnlyFoundationAndTheModel() throws {
  let sources = URL(filePath: #filePath).deletingLastPathComponent().appending(path: "../../Sources/CodeBoardResources")
  let files = try #require(FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil))
    .compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" }
  #expect(!files.isEmpty)
  let importLine = /^\s*(?:@\w+\s+)*import\s+(?:(?:typealias|struct|class|enum|protocol|let|var|func)\s+)?(\w+)/
    .anchorsMatchLineEndings()
  for file in files {
    for match in try String(contentsOf: file, encoding: .utf8).matches(of: importLine)
    where !["Foundation", "CodeBoardModel"].contains(match.1) {
      Issue.record("\(file.lastPathComponent) imports \(match.1)")
    }
  }
}
