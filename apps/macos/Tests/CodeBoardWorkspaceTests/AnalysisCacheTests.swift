import CodeBoardAnalysis
import CodeBoardWorkspace
import Foundation
import Testing

// packages/host/test/analysis.test.ts
@Suite struct SegmentAnalysisTests {
  /// New content, not in the cache
  private func text() throws -> String {
    try withNanoFile("nanovllm/engine/llm_engine.py") + "\n# segment test\n"
  }

  private func withNanoFile(_ path: String) throws -> String {
    let url = URL(filePath: #filePath).deletingLastPathComponent()
      .appending(path: "../CodeBoardAnalysisTests/Fixtures/nano-vllm/\(path)")
    return String(decoding: try Data(contentsOf: url), as: UTF8.self)
  }

  @Test func equalsTheWholeFileAnalysisClippedToTheSegmentBeforeAndAfterTheWholeFileWasAnalysed() throws {
    let cache = AnalysisCache()
    let tree = TreeAt(cache: TreeCache(), key: "seg-test")
    let s1 = cache.segAnalysis("python", try text(), start: 20, end: 45, tree: tree)
    let full = cache.analysisOf("python", try text(), tree: tree)
    #expect(!s1.calls.isEmpty)
    #expect(s1 == clipAnalysis(full, start: 20, end: 45))
    #expect(cache.segAnalysis("python", try text(), start: 20, end: 45) == s1)
    tree.cache.forget()
  }

  @Test func keepsTheFilesImportsWithNoLines() throws {
    let cache = AnalysisCache()
    let segment = cache.segAnalysis("python", try text(), start: 1, end: 0)
    #expect(segment.imports == cache.analysisOf("python", try text()).imports)
  }
}
