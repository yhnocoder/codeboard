import CodeBoardMarkdown
import Foundation
import Testing

@testable import CodeBoardMarkdownUI

/// The paste rules (editor/paste.ts)
@Suite struct PasteTests {
  func core(_ src: String, _ sel: MDSelection) -> EditorCore {
    _ = boardFonts
    let l = BlockLayout(MarkdownDocument(src), width: 300, theme: testTheme, layout: nil, resources: TestResources())
    let e = EditorCore(layout: l)
    e.select(sel)
    return e
  }

  @Test func codeFromElsewhereIsABlockInTwoSteps() {
    let e = core("Before\n\n", MDSelection(8))
    let code = "def step(batch):\n    x = model(batch)\n    return x\n"
    e.paste(MDPaste(plain: code))
    #expect(e.source == "Before\n\n```python\ndef step(batch):\n    x = model(batch)\n    return x\n```\n\n")
    e.undo()
    #expect(e.source == "Before\n\n" + code)
    e.undo()
    #expect(e.source == "Before\n\n")
  }

  @Test func proseIsNotCode() {
    let e = core("", MDSelection(0))
    e.paste(MDPaste(plain: "First line of prose.\nAnd a second one, also prose."))
    #expect(e.source == "First line of prose.\nAnd a second one, also prose.")
    #expect(MarkdownEditing.codeLanguage("- a list\n- of things") == nil)
  }

  @Test func vsCodeCellsLinksAndHeadings() {
    var e = core("Text ", MDSelection(5))
    e.paste(MDPaste(plain: "let x = 1", vscodeLanguage: "rust"))
    #expect(e.source == "Text `let x = 1` ")
    e = core("| a |\n|---|\n| b |", MDSelection(14))
    e.paste(MDPaste(plain: "one\ntwo"))
    #expect(e.source == "| a |\n|---|\n| one<br>twob |")
    e = core("see docs here", MDSelection(anchor: 4, head: 8))
    e.paste(MDPaste(plain: "https://example.com"))
    #expect(e.source == "see [docs](https://example.com) here")
    e = core("in text", MDSelection(3))
    e.paste(MDPaste(plain: "## Title"))
    #expect(e.source == "in Titletext")
  }

  @Test func htmlAsMarkdown() {
    let md = HTMLMarkdown.markdown(
      "<p>Some <b>bold</b> and <a href=\"https://x.y\">a link</a>.</p><ul><li>one</li><li>two</li></ul><h2>Head</h2>")
    #expect(md == "Some **bold** and [a link](https://x.y).\n\n- one\n- two\n\n## Head")
  }
}

@Suite struct CopyTests {
  @Test func aPartOfASpanKeepsItsMarkersAndHTMLGoesAlong() {
    _ = boardFonts
    let src = "Some ==Plain words== and **more**"
    let d = MarkdownDocument(src)
    #expect(MarkdownEditing.copy(9..<16, in: d) == "==ain wor==")
    #expect(MarkdownEditing.copy(7..<18, in: d) == "Plain words")
    #expect(
      MarkdownHTML.render("# T\n\nSome **b** and [l](https://x.y).\n\n- a")
        == "<h1>T</h1><p>Some <strong>b</strong> and <a href=\"https://x.y\">l</a>.</p><ul><li><p>a</p></li></ul>")
  }
}

/// Formulas a page drew come back as TeX (KaTeX's MathML annotation, the drawn copy left out), and \( \) / \[ \] as $
@Suite struct PasteMathTests {
  @Test func drawnFormulasAndLaTeXDelimiters() {
    let katex =
      "<p>Energy <span class=\"katex\"><span class=\"katex-mathml\"><math><semantics><mrow><mi>E</mi></mrow>"
      + "<annotation encoding=\"application/x-tex\">E = mc^2</annotation></semantics></math></span>"
      + "<span class=\"katex-html\" aria-hidden=\"true\"><span class=\"base\"><span>E</span><span>=</span></span></span></span> here.</p>"
    #expect(HTMLMarkdown.markdown(katex) == "Energy $E = mc^2$ here.")
    let block =
      "<p>Before</p><math display=\"block\"><semantics><annotation encoding=\"application/x-tex\">\\sum x</annotation></semantics></math><p>After</p>"
    #expect(HTMLMarkdown.markdown(block) == "Before\n\n$$\n\\sum x\n$$\n\nAfter")
    #expect(HTMLMarkdown.markdown("<p>so \\(a+b\\) and \\[c\\]</p>") == "so $a+b$ and $$\nc\n$$")
  }
}
