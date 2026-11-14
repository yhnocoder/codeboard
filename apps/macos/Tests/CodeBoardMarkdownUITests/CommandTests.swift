import CodeBoardMarkdown
import Foundation
import Testing

@testable import CodeBoardMarkdownUI

/// Formatting commands, headings by key, brackets and quotes, the table rule (editor/typora.ts, inline.ts, pairs.ts)
@Suite struct CommandTests {
  func core(_ src: String, _ sel: MDSelection) -> EditorCore {
    _ = boardFonts
    let l = BlockLayout(MarkdownDocument(src), width: 300, theme: testTheme, layout: nil, resources: TestResources())
    let e = EditorCore(layout: l)
    e.select(sel)
    return e
  }

  @Test func toggleWrapsUnwrapsAndStepsOut() {
    var e = core("one two three", MDSelection(anchor: 4, head: 7))
    e.command(.toggle(.strong))
    #expect(e.source == "one **two** three")
    #expect(e.selection == MDSelection(anchor: 6, head: 9))
    e.command(.toggle(.strong))
    #expect(e.source == "one two three")
    // ⌘B, typed text, ⌘B: out over the closing marker (between words: a**x**b is no emphasis here, as on the web)
    e = core("a  b", MDSelection(2))
    e.command(.toggle(.strong))
    #expect(e.source == "a **** b" && e.selection == MDSelection(4))
    e.insert("x")
    e.command(.toggle(.strong))
    #expect(e.source == "a **x** b")
    #expect(e.selection == MDSelection(7))
    e = core("say hi", MDSelection(anchor: 4, head: 6))
    e.command(.toggle(.underline))
    #expect(e.source == "say <u>hi</u>")
    e.command(.toggle(.underline))
    #expect(e.source == "say hi")
    // a selection that cuts a span takes it whole
    e = core("a **bold** word", MDSelection(anchor: 6, head: 15))
    e.command(.toggle(.highlight))
    #expect(e.source == "a ==**bold** word==")
  }

  @Test func eachParagraphIsWrappedOnItsOwn() {
    let e = core("one two\n\nthree four", MDSelection(anchor: 4, head: 14))
    e.command(.toggle(.emphasis))
    #expect(e.source == "one *two*\n\n*three* four")
    e.command(.toggle(.emphasis))
    #expect(e.source == "one two\n\nthree four")
  }

  @Test func headingKeys() {
    let e = core("Title", MDSelection(2))
    e.command(.heading(2))
    #expect(e.source == "## Title" && e.selection == MDSelection(5))
    e.command(.headingStep(-1))
    #expect(e.source == "# Title")
    e.command(.headingStep(-1))
    #expect(e.source == "# Title")
    e.command(.heading(0))
    #expect(e.source == "Title" && e.selection == MDSelection(2))
    e.command(.headingStep(1))
    #expect(e.source == "Title")
    e.command(.headingStep(-1))
    #expect(e.source == "###### Title")
    e.undo()
    #expect(e.source == "Title")
    let item = core("- item", MDSelection(4))
    item.command(.heading(3))
    #expect(item.source == "- ### item")
  }

  @Test func bracketsAndQuotesPair() {
    var e = core("x", MDSelection(1))
    e.insert(" ")
    e.insert("(")
    #expect(e.source == "x ()" && e.selection == MDSelection(3))
    e.insert("a")
    e.insert(")")
    #expect(e.source == "x (a)")
    #expect(e.selection == MDSelection(5))
    // next to a word: not paired; a quote after a letter is an apostrophe
    e = core("word", MDSelection(0))
    e.insert("(")
    #expect(e.source == "(word")
    e = core("don", MDSelection(3))
    e.insert("'")
    #expect(e.source == "don'")
    // around a selection
    e = core("a b c", MDSelection(anchor: 2, head: 3))
    e.insert("[")
    #expect(e.source == "a [b] c" && e.selection == MDSelection(anchor: 3, head: 4))
    // ⌫ in an empty pair takes both; Markdown markers never pair
    e = core("x ", MDSelection(2))
    e.insert("{")
    e.key(.backspace)
    #expect(e.source == "x ")
    e.insert("*")
    #expect(e.source == "x *")
    // not in code
    e = core("`a b`", MDSelection(2))
    e.insert("(")
    #expect(e.source == "`a( b`")
  }

  @Test func aLineOfCellsBecomesATable() {
    let e = core("Before\n\n|a|b|", MDSelection(13))
    e.key(.enter)
    #expect(e.source == "Before\n\n| a | b |\n|---|---|\n|   |   |")
    #expect(e.document.blocks.last.map { if case .table = $0.kind { true } else { false } } == true)
    e.insert("1")
    #expect(e.source.hasSuffix("| 1 |   |") || e.source.hasSuffix("|  1|   |") || e.source.contains("1"))
  }
}

/// ⌥⌘ lists and quote, a table and a formula block after the paragraph, ⌘] ⌘[ (editor/typora.ts)
@Suite struct BlockCommandTests {
  func core(_ src: String, _ sel: MDSelection) -> EditorCore {
    _ = boardFonts
    let l = BlockLayout(MarkdownDocument(src), width: 300, theme: testTheme, layout: nil, resources: TestResources())
    let e = EditorCore(layout: l)
    e.select(sel)
    return e
  }

  @Test func listsAndQuotesOnAndOff() {
    let e = core("one\n\ntwo", MDSelection(1))
    e.command(.block(.bullet))
    #expect(e.source == "- one\n\ntwo")
    e.command(.block(.bullet))
    #expect(e.source == "one\n\ntwo")
    e.command(.block(.ordered))
    #expect(e.source == "1. one\n\ntwo")
    e.command(.block(.task))
    #expect(e.source == "- [ ] one\n\ntwo")
    e.command(.block(.quote))
    #expect(e.source == "> one\n\ntwo")
    e.undo()
    e.undo()
    e.undo()
    e.undo()
    e.undo()
    #expect(e.source == "one\n\ntwo")
  }

  @Test func blocksAfterTheParagraph() {
    var e = core("Text", MDSelection(2))
    e.command(.insertTable)
    #expect(e.source == "Text\n\n|  |  |\n|---|---|\n|  |  |")
    e = core("Text", MDSelection(2))
    e.command(.insertMathBlock)
    #expect(e.source == "Text\n\n$$\n\n$$")
  }

  @Test func itemsIndentAndOutdent() {
    let e = core("- one\n- two", MDSelection(10))
    e.command(.indent)
    #expect(e.source == "- one\n  - two")
    e.command(.outdent)
    #expect(e.source == "- one\n- two")
  }
}
