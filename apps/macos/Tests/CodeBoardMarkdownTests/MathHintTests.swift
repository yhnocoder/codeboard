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

/// MathJax's messages said as the web says KaTeX's, with the same one-click fixes (mathhints.ts explain)
@Suite struct MathExplainTests {
  func fixes(_ p: MDMathProblem) -> [(Range<Int>, String)] {
    p.parts.compactMap { if case .fix(_, let r, let t) = $0 { (r, t) } else { nil } }
  }

  @Test func eachMistake() {
    let unknown = MarkdownEditing.explainMath("Undefined control sequence \\fracc", tex: "\\fracc{a}{b}", preamble: "")
    #expect(fixes(unknown).first?.0 == 0..<6 && fixes(unknown).first?.1 == "\\frac" && unknown.at == 0)
    let open = MarkdownEditing.explainMath("Extra open brace or missing close brace", tex: "x^{2", preamble: "")
    #expect(fixes(open).first?.0 == 4..<4 && fixes(open).first?.1 == "}")
    let extra = MarkdownEditing.explainMath("Extra close brace or missing open brace", tex: "x}+1", preamble: "")
    #expect(fixes(extra).first?.0 == 1..<2 && fixes(extra).first?.1 == "")
    let sub = MarkdownEditing.explainMath("Double subscripts: use braces to clarify", tex: "x_i_j", preamble: "")
    #expect(sub.parts.contains(.code("x_{ij}")) && fixes(sub).isEmpty)
    let arg = MarkdownEditing.explainMath("Missing argument for \\frac", tex: "\\frac", preamble: "")
    #expect(arg.parts.first == .code("\\frac"))
    // a command name being typed is not an error yet
    #expect(MarkdownEditing.typingCommand("\\fra", caret: 4, preamble: ""))
    #expect(!MarkdownEditing.typingCommand("\\fracc", caret: 6, preamble: ""))
  }
}

/// A page's formula copied as text ("shown + TeX") comes back as $TeX$ (doubled.ts)
@Suite struct UndoubleTests {
  @Test func shownTextThenTeX() {
    // what each TeX shows, as the engine gives it
    let shows: [String: String] = ["N\\times N": "N×N", "x^2": "x2", "\\alpha": "α"]
    let shown: (String) -> String? = { shows[$0] }
    #expect(
      MarkdownEditing.undoubleTex("a grid of N×NN\\times N pixels", shown: shown) == "a grid of $N\\times N$ pixels")
    #expect(MarkdownEditing.undoubleTex("so x2x^2 and αα\\alpha here", shown: shown) == "so $x^2$ and α$\\alpha$ here")
    #expect(MarkdownEditing.undoubleTex("plain text", shown: shown) == "plain text")
  }
}
