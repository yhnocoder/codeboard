import CodeBoardMarkdown
import Foundation
import Testing

@testable import CodeBoardMarkdownUI

/// the formula engine over the Note page build's engines.js (node apps/macos/web/build.mjs makes it)
let engines: JSEngines? = {
  let url = URL(filePath: #filePath).deletingLastPathComponent().appending(path: "../../web/dist/engines.js")
    .standardized
  return try? JSEngines(script: url)
}()

@Suite(.enabled(if: engines != nil, "needs apps/macos/web/dist/engines.js"))
struct MathTests {
  /// guideline 4: what the boards use, and a preamble
  @Test func typesetsWhatTheBoardsUse() {
    let formulas = [
      "x_i^2", "\\frac{a}{b} + \\tfrac12 + \\dfrac{\\pi}{2}", "\\sum_{k=1}^{n} k", "\\operatorname{softmax}(x)",
      "\\left( \\frac{a}{b} \\right)", "\\bigl( a \\bigr)", "\\lfloor n \\rfloor \\bmod 32", "a \\mathbin{\\oplus} b",
      "\\mathsf{KV} \\mathrm{d}x \\texttt{size}", "\\boxed{E = mc^2}",
      "\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}",
      "\\begin{align*} f &= x \\end{align*}", "\\begin{bmatrix} 1 & 0 \\\\ 0 & 1 \\end{bmatrix}",
      "\\begin{array}{ll} 1 & 2 \\end{array}", "\\text{显存占用} = B", "\\begin{equation} y = x \\end{equation}",
      "\\alpha \\beta \\leq \\neq \\approx",
    ]
    for f in formulas {
      guard case .ok(let p) = engines!.typeset(f, display: true, preamble: "") else {
        Issue.record("did not typeset: \(f)")
        continue
      }
      #expect(p.width > 0 && p.height > 0 && !p.paths.isEmpty, "\(f)")
    }
    let pre = "\\newcommand{\\R}{\\mathbb{R}} \\def\\half{\\frac12}"
    guard case .ok = engines!.typeset("\\R^n + \\half", display: false, preamble: pre) else {
      Issue.record("preamble macros not read")
      return
    }
  }

  @Test func aFormulaThatDoesNotReadIsAnError() {
    guard case .error(let message, _, _) = engines!.typeset("\\frac{a", display: false, preamble: "") else {
      Issue.record("expected an error")
      return
    }
    #expect(!message.isEmpty)
  }

  /// MathJax has no glyphs for Chinese: it is a native text, as wide as the native font makes it, not 1em a character
  @Test func chineseInTextIsMeasuredNatively() {
    _ = boardFonts
    guard case .ok(let p) = engines!.typeset("\\text{显存}", display: false, preamble: "") else {
      Issue.record("did not typeset")
      return
    }
    #expect(p.texts.map(\.text).joined() == "显存")
    #expect(p.width > 1.5 && p.width < 2.2)
  }

  @Test func atagIsDrawnAtTheRightEdgeOfABlock() {
    let l = MarkdownLayout.make(
      MarkdownDocument("$$\nE = mc^2 \\tag{1}\n$$"), width: 332, theme: testTheme, layout: nil,
      resources: MathResources(math: engines))
    let xs = l.items.compactMap { item -> CGFloat? in
      if case .math(let p, let s, let o, _) = item { o.x + CGFloat(p.width) * s } else { nil }
    }
    #expect(xs.count == 2)
    #expect(abs((xs.max() ?? 0) - 332) < 0.5)
  }
}

struct MathResources: MarkdownResources {
  let math: MathTypesetter?
  func imageSize(_ src: String) -> CGSize? { nil }
  func ref(label: String, target: String?) -> MarkdownRefHit? { nil }
  func highlight(lines: [String], language: String) -> [[MarkdownToken]]? { nil }
  var mathPreamble: String { "" }
}
