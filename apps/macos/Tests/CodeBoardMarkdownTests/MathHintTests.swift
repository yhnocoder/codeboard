import Foundation
import Testing

@testable import CodeBoardMarkdown

/// The formula command list as editor/mathhints.ts makes it
@Suite struct MathHintTests {
  @Test func theCommandBeingTyped() {
    #expect(MarkdownEditing.mathToken("a + \\fr", caret: 7)! == ("fr", 4))
    #expect(MarkdownEditing.mathToken("a \\\\fr", caret: 6) == nil)
    #expect(MarkdownEditing.mathToken("\\\\\\fr", caret: 5)! == ("fr", 2))
    #expect(MarkdownEditing.mathToken("x", caret: 1) == nil)
  }

  @Test func completionsInTheWebsOrder() {
    #expect(MarkdownEditing.mathCommands.count == 88)
    #expect(MarkdownEditing.mathCompletions("fr", tex: "", preamble: "").map(\.name) == ["frac"])
    // starting with it first, case-sensitively, then the other case, then holding it
    #expect(
      MarkdownEditing.mathCompletions("le", tex: "", preamble: "").map(\.name).prefix(3) == [
        "left", "leq", "leftarrow",
      ])
    #expect(MarkdownEditing.mathCompletions("Righ", tex: "", preamble: "").first?.name == "Rightarrow")
    // typed in full, no arguments: nothing
    #expect(MarkdownEditing.mathCompletions("infty", tex: "", preamble: "").isEmpty)
    // the preamble's and the formula's own
    let mine = MarkdownEditing.mathCompletions(
      "R", tex: "\\newcommand{\\Rn}[1]{\\mathbb{R}^{#1}} \\Rn", preamble: "\\def\\RR{\\mathbb{R}}")
    #expect(mine.prefix(2).map(\.name) == ["RR", "Rn"])
    #expect(mine[0].origin == .preamble && mine[1].origin == .sameFormula && mine[1].snip == "\\Rn{|}")
  }
}
