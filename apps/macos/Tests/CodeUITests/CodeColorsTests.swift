import CodeUI
import Foundation
import Testing

/// Colours while editing: what is drawn never waits for the highlighter, keeps each line's colours through an edit, and
/// only the lines in view are coloured again, a batch at a time
@MainActor @Suite struct CodeColorsTests {
  /// Colours each line as one run whose style is the call's number; a call waits until the test lets it go when gated
  final class Fake: CodeHighlighter, @unchecked Sendable {
    let lock = NSLock()
    var asked: [Range<Int>] = []
    var calls = 0
    var gated = false
    var waiting: [CheckedContinuation<Void, Never>] = []

    func runs(of text: String, lines: Range<Int>) async -> [[CodeRun]]? {
      let (n, gate) = lock.withLock {
        asked.append(lines)
        calls += 1
        return (calls, gated)
      }
      if gate { await withCheckedContinuation { c in lock.withLock { waiting.append(c) } } }
      let all = text.components(separatedBy: "\n")
      return lines.map { [CodeRun(columns: 0..<all[$0].utf16.count, style: UInt8(n))] }
    }

    func open() {
      let w = lock.withLock {
        defer { waiting = [] }
        return waiting
      }
      for c in w { c.resume() }
    }
  }

  func whole(_ s: String, _ style: UInt8) -> [CodeRun] { [CodeRun(columns: 0..<s.utf16.count, style: style)] }

  /// Does `body`, then waits for the colours' next `ready`
  func ready(_ c: CodeColors, after body: () -> Void) async {
    await withCheckedContinuation { k in
      c.ready = {
        c.ready = nil
        k.resume()
      }
      body()
    }
  }

  @Test func anEditKeepsTheColoursAndTheNewOnesComeAfter() async {
    let f = Fake()
    let c = CodeColors(f, text: "let a = 1\nlet b = 2", runs: [whole("let a = 1", 0), whole("let b = 2", 0)])
    // all coloured already: nothing asked
    #expect(c.runs(for: "let a = 1\nlet b = 2", visible: 0..<2) == [whole("let a = 1", 0), whole("let b = 2", 0)])
    #expect(f.asked.isEmpty)
    // the second line changed after "let ": its run cut there; the first kept
    await ready(c) {
      #expect(c.runs(for: "let a = 1\nlet bb = 22", visible: 0..<2) == [whole("let a = 1", 0), []])
    }
    // the line before the change was right already and stays
    #expect(c.runs(for: "let a = 1\nlet bb = 22", visible: 0..<2) == [whole("let a = 1", 0), whole("let bb = 22", 1)])
    #expect(f.asked == [0..<2])
  }

  @Test func aChangedLineKeepsTheRunsBeforeTheChange() {
    let c = CodeColors(
      Fake(), text: "foo(bar)",
      runs: [[CodeRun(columns: 0..<3, style: 1), CodeRun(columns: 4..<7, style: 2)]])
    #expect(c.runs(for: "foo(baz)", visible: 0..<0) == [[CodeRun(columns: 0..<3, style: 1)]])
  }

  @Test func onlyTheLinesInViewAreAskedForABatchAroundThem() async {
    let f = Fake()
    let text = (0..<1000).map { "line \($0)" }.joined(separator: "\n")
    let c = CodeColors(f, text: text)
    await ready(c) { _ = c.runs(for: text, visible: 500..<520) }
    #expect(f.asked == [410..<610])
    // in view and coloured: nothing more asked
    _ = c.runs(for: text, visible: 450..<600)
    #expect(f.asked.count == 1)
  }

  @Test func typingWhileColouringTakesWhatStillFitsAndAsksAgain() async {
    let f = Fake()
    f.gated = true
    let c = CodeColors(f, text: "a\nb")
    _ = c.runs(for: "a\nb", visible: 0..<2)
    // a key while the highlighter works: answered at once, nothing more asked while one is out
    #expect(c.runs(for: "a\nbc", visible: 0..<2) == [[], []])
    while f.lock.withLock({ f.waiting.isEmpty }) { await Task.yield() }
    f.lock.withLock { f.gated = false }
    await ready(c) { f.open() }
    // the line still as it was takes its colours; the changed one is asked again
    await ready(c) { #expect(c.runs(for: "a\nbc", visible: 0..<2) == [whole("a", 1), []]) }
    #expect(c.runs(for: "a\nbc", visible: 0..<2) == [whole("a", 2), whole("bc", 2)])
    #expect(f.asked == [0..<2, 0..<2])
  }
}
