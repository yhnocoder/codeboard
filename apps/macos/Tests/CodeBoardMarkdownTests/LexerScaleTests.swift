import Foundation
import Testing

@testable import CodeBoardMarkdown

/// The block lexer steps through a document token by token without copying or re-reading the rest of it each time: eight
/// times the paragraphs take about eight times as long, not sixty-four (as when every token copied what followed it).
/// Measured in the thread's CPU time, best of three, so a busy machine does not make it fail
@Test func lexingGrowsLinearlyWithTheDocument() {
  func doc(_ n: Int) -> String {
    (0..<n).map { i in
      switch i % 6 {
      case 0: "## Heading \(i)"
      case 1: "- item \(i)\n- [ ] task\n  more"
      case 2: "> quoted **\(i)** text"
      case 3: "| a | b |\n| - | - |\n| \(i) | x |"
      default: "Paragraph \(i) with **bold**, `code`, a [link](u) and 中文 text."
      }
    }.joined(separator: "\n\n")
  }
  func cpu(_ f: () -> Void) -> Double {
    (0..<3).map { _ in
      var a = timespec()
      var b = timespec()
      clock_gettime(CLOCK_THREAD_CPUTIME_ID, &a)
      f()
      clock_gettime(CLOCK_THREAD_CPUTIME_ID, &b)
      return Double(b.tv_sec - a.tv_sec) + Double(b.tv_nsec - a.tv_nsec) / 1e9
    }.min()!
  }
  let small = doc(300)
  let large = doc(2400)
  _ = BlockLexer.lex(small)
  let ratio = cpu { _ = BlockLexer.lex(large) } / cpu { _ = BlockLexer.lex(small) }
  #expect(ratio < 20, "8× the paragraphs took \(ratio)× as long")
}
