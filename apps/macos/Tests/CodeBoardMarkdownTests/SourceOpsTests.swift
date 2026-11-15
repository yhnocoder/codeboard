import Foundation
import Testing

@testable import CodeBoardMarkdown

// The cases of packages/markdown's tests for the same functions (blockstarts, blockmove, image, image-playback,
// markdown, pastemath, pastemarks), with the results that package gives

@Suite struct BlockStartsTests {
  func blocksAt(_ src: String) -> [String]? {
    let ns = src as NSString
    return MarkdownSourceOps.blockStarts(src).map { starts in
      starts.enumerated().map { i, s in
        let end = i + 1 < starts.count ? starts[i + 1] : ns.length
        return Mapped(ns.substring(with: NSRange(location: s, length: end - s))).trimmedEnd().string
      }
    }
  }

  @Test func givesWhereEachTopLevelBlockStarts() {
    let src =
      "# Title\n\nFirst paragraph\nstill first.\n\n- a\n- b\n\n```py\nx = 1\n```\n\n$$\nx^2\n$$\n\n> quote\n\n![](assets/a.png){width=40%}\n\nlast"
    #expect(
      blocksAt(src) == [
        "# Title", "First paragraph\nstill first.", "- a\n- b", "```py\nx = 1\n```", "$$\nx^2\n$$", "> quote",
        "![](assets/a.png){width=40%}", "last",
      ])
  }
  @Test func givesNilWhenBlocksAndSourceDoNotLineUp() {
    #expect(MarkdownSourceOps.blockStarts("a\n\n\n\n\nb") == nil)
    #expect(MarkdownSourceOps.blockStarts("a\r\n\r\nb") == nil)
  }
  @Test func oneParagraphAndAnEmptyNote() {
    #expect(MarkdownSourceOps.blockStarts("just text") == [0])
    #expect(MarkdownSourceOps.blockStarts("") == [])
  }
}

@Suite struct BlockMoveTests {
  typealias Part = MarkdownSourceOps.Part
  let src = "# T\n\nOne.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```py\nx\n```\n\nTwo.\n\n```js\ny\n```"

  @Test func cutsBlocksOutAndTheLayoutGoesWithItsTableAndCodeBlock() throws {
    let layout = MDLayoutInfo(tables: [.init(cols: [40, nil])], wrap: [1])
    let r = try #require(MarkdownSourceOps.cutBlocks(Part(source: src, layout: layout), 2..<4))
    #expect(
      r.cut
        == Part(
          source: "| a | b |\n|---|---|\n| 1 | 2 |\n\n```py\nx\n```",
          layout: MDLayoutInfo(tables: [.init(cols: [40, nil])])))
    #expect(r.rest == Part(source: "# T\n\nOne.\n\nTwo.\n\n```js\ny\n```", layout: MDLayoutInfo(wrap: [0])))
  }
  @Test func insertsBlocksBeforeABlockOrAtTheEnd() {
    let part = Part(source: "```c\nz\n```", layout: MDLayoutInfo(wrap: [0]))
    #expect(
      MarkdownSourceOps.insertBlocks(Part(source: "A\n\n```py\nx\n```", layout: MDLayoutInfo(wrap: [0])), part, at: 1)
        == Part(source: "A\n\n```c\nz\n```\n\n```py\nx\n```", layout: MDLayoutInfo(wrap: [0, 1])))
    #expect(MarkdownSourceOps.insertBlocks(Part(source: "A"), Part(source: "B"), at: 1) == Part(source: "A\n\nB"))
    #expect(MarkdownSourceOps.insertBlocks(Part(source: ""), Part(source: "B"), at: 0) == Part(source: "B"))
  }
  @Test func movesBlocksDownAndUpAndAMoveOntoItselfIsNothing() {
    let md = Part(source: "A\n\nB\n\nC\n\nD")
    #expect(MarkdownSourceOps.moveBlocks(md, 0..<2, to: 4)?.source == "C\n\nD\n\nA\n\nB")
    #expect(MarkdownSourceOps.moveBlocks(md, 2..<3, to: 0)?.source == "C\n\nA\n\nB\n\nD")
    #expect(MarkdownSourceOps.moveBlocks(md, 1..<2, to: 2) == nil)
  }
  @Test func keepsAListPutNextToAListOfItsKindAListOfItsOwn() {
    let md = Part(source: "- a\n- b\n\nP\n\n- c")
    #expect(MarkdownSourceOps.cutBlocks(md, 1..<2)?.rest.source == "- a\n- b\n\n* c")
    #expect(MarkdownSourceOps.moveBlocks(md, 2..<3, to: 1)?.source == "- a\n- b\n\n* c\n\nP")
    #expect(
      MarkdownSourceOps.insertBlocks(Part(source: "1. x"), Part(source: "1. y\n2. z"), at: 1)?.source
        == "1. x\n\n1) y\n2) z")
    #expect(MarkdownSourceOps.insertBlocks(Part(source: "- x"), Part(source: "1. y"), at: 1)?.source == "- x\n\n1. y")
  }
  @Test func movesSetsOfBlocks() {
    let md = Part(source: "A\n\nB\n\nC\n\nD\n\nE")
    #expect(MarkdownSourceOps.moveBlocks(md, IndexSet([0, 2]), to: 5)?.source == "B\n\nD\n\nE\n\nA\n\nC")
    let cut = MarkdownSourceOps.cutBlocks(md, IndexSet([1, 3, 4]))
    #expect(cut?.rest.source == "A\n\nC")
    #expect(cut?.cut.map(\.source) == ["B", "D\n\nE"])
  }
}

@Suite struct TaskToggleTests {
  @Test func togglesTheNthTaskSkippingCodeBlocks() {
    let s = "- [ ] a\n```\n- [ ] not a task\n```\n- [x] b"
    #expect(MarkdownSourceOps.toggleTask(s, nth: 0) == "- [x] a\n```\n- [ ] not a task\n```\n- [x] b")
    #expect(MarkdownSourceOps.toggleTask(s, nth: 1) == "- [ ] a\n```\n- [ ] not a task\n```\n- [ ] b")
    #expect(MarkdownSourceOps.toggleTask(s, nth: 2) == nil)
  }
}

@Suite struct ImageOpsTests {
  let md = "Intro **x**\n\n![](assets/a.gif)\n\nThen ![](assets/a.gif){width=40%} and `![](assets/a.gif)`\n"

  @Test func rewritesOnlyTheNthImagesAttributeBlock() {
    #expect(
      MarkdownSourceOps.setImagePlayback(md, src: "assets/a.gif", nth: 0, frame: 4, loops: false)
        == "Intro **x**\n\n![](assets/a.gif){frame=4}\n\nThen ![](assets/a.gif){width=40%} and `![](assets/a.gif)`\n")
    #expect(
      MarkdownSourceOps.setImagePlayback(md, src: "assets/a.gif", nth: 1, frame: 2, loops: true)
        == "Intro **x**\n\n![](assets/a.gif)\n\nThen ![](assets/a.gif){width=40% frame=2 loop=true} and `![](assets/a.gif)`\n"
    )
  }
  @Test func frameOneAndLoopOffTakeTheirAttributeAway() {
    #expect(
      MarkdownSourceOps.setImagePlayback(
        "![](a.gif){width=30% frame=4 loop=true}", src: "a.gif", nth: 0, frame: 1, loops: false)
        == "![](a.gif){width=30%}")
    #expect(
      MarkdownSourceOps.setImagePlayback("![](a.gif){frame=4}", src: "a.gif", nth: 0, frame: nil, loops: false)
        == "![](a.gif)")
  }
  @Test func leavesMarkdownWithoutThatImageAlone() {
    #expect(MarkdownSourceOps.setImagePlayback(md, src: "assets/b.gif", nth: 0, frame: 2, loops: false) == md)
    #expect(MarkdownSourceOps.setImagePlayback(md, src: "assets/a.gif", nth: 0, frame: nil, loops: false) == md)
  }
  @Test func setsChangesAndRemovesTheCaptionOfTheNthImage() {
    let md =
      "# T\n\n`![x](assets/a.png)` and\n\n```\n![y](assets/a.png)\n```\n\n![first (1)](assets/a.png)\n\nmid *text*  \n![second](<assets/a.png> 'old'){width=50%}"
    let one = MarkdownSourceOps.setImageCaption(md, src: "assets/a.png", nth: 0, caption: "A \"quoted\" one")
    #expect(
      one
        == md.replacingOccurrences(
          of: "![first (1)](assets/a.png)", with: "![first (1)](assets/a.png \"A \\\"quoted\\\" one\")"))
    #expect(MarkdownSourceOps.image(one, src: "assets/a.png", nth: 0)?.caption == "A \"quoted\" one")
    let two = MarkdownSourceOps.setImageCaption(md, src: "assets/a.png", nth: 1, caption: "new")
    #expect(
      two == md.replacingOccurrences(of: "![second](<assets/a.png> 'old')", with: "![second](<assets/a.png> \"new\")"))
    #expect(
      MarkdownSourceOps.setImageCaption(two, src: "assets/a.png", nth: 1, caption: " ")
        == md.replacingOccurrences(of: "![second](<assets/a.png> 'old')", with: "![second](<assets/a.png>)"))
    #expect(MarkdownSourceOps.setImageCaption(md, src: "assets/zzz.png", nth: 0, caption: "x") == md)
  }
  @Test func setsTheWidthAsAShareOfTheBody() {
    #expect(MarkdownSourceOps.setImageWidth("![](a.png)", src: "a.png", nth: 0, width: 0.4) == "![](a.png){width=40%}")
    #expect(
      MarkdownSourceOps.setImageWidth("![](a.png){width=40% loop=true}", src: "a.png", nth: 0, width: nil)
        == "![](a.png){loop=true}")
  }
}

@Suite struct TableCaptionTests {
  let table = "| a   | b   |\n| --- | --- |\n| 1   | 2   |"
  @Test func setsChangesAndRemovesTheCaptionOfTheNthTable() {
    let md =
      "# *T*\n\n- list\n\n  " + table.replacingOccurrences(of: "\n", with: "\n  ") + "\n\n" + table
      + "\n\nTable: old\n\nend   *x*"
    let one = MarkdownSourceOps.setTableCaption(md, nth: 1, caption: "new\n$M$")
    #expect(one == md.replacingOccurrences(of: "Table: old", with: "Table: new $M$"))
    #expect(
      MarkdownSourceOps.setTableCaption(one, nth: 1, caption: " ")
        == md.replacingOccurrences(of: "\n\nTable: old", with: ""))
    let nested = MarkdownSourceOps.setTableCaption(md, nth: 0, caption: "inner")
    #expect(nested.hasSuffix("Table: old\n\nend   *x*"))
    #expect(nested.contains("  | 1   | 2   |\n\n  Table: inner\n\n"))
    #expect(MarkdownSourceOps.setTableCaption(md, nth: 5, caption: "x") == md)
  }
}

@Suite struct PasteRewriteTests {
  @Test func bracketsBecomeDollarsOutsideCode() {
    let md = "`\\(a\\)` 和\n\n```\n\\[b\\]\n```\n\n$x \\(c\\) y$ 与 [l](u\\(d\\)) 和 \\\\(e\\) 和 \\(f 没配上"
    #expect(MarkdownSourceOps.texBrackets(md) == md)
    #expect(MarkdownSourceOps.texBrackets("- 列表 \\(a\\)\n> 引用 \\[b\\]") == "- 列表 $a$\n> 引用 $$b$$")
    #expect(MarkdownSourceOps.texBrackets("不跨段 \\(a\n\nb\\)") == "不跨段 \\(a\n\nb\\)")
    let t = "| 大小 | occupancy |\n| :---: | :---: |\n| 1024 | \\(50\\%\\) |\n\n即\n\n\\[\n 32 \\times 32 = 1024 \n\\]"
    #expect(
      MarkdownSourceOps.texBrackets(t)
        == "| 大小 | occupancy |\n| :---: | :---: |\n| 1024 | $50\\%$ |\n\n即\n\n$$\n 32 \\times 32 = 1024 \n$$")
  }
  @Test func markTagsBecomeHighlights() {
    #expect(MarkdownSourceOps.markTags("a <mark>hot</mark> b <mark> c </mark>d") == "a ==hot== b  ==c== d")
    for k in [
      "`<mark>c</mark>` \\<mark>esc</mark> <mark class=\"x\">a</mark> <mark>a <b>b</b></mark> <mark></mark> <mark>a==b</mark>",
      "```\n<mark>c</mark>\n```", "para\n\n    <mark>indented</mark>", "<div>\n<mark>in html</mark>\n</div>",
    ] {
      #expect(MarkdownSourceOps.markTags(k) == k)
    }
    #expect(MarkdownSourceOps.markTags("- item <mark>li</mark>") == "- item ==li==")
    #expect(
      MarkdownSourceOps.markTags("- ```\n  <mark>x</mark>\n  ```\n\nafter <mark>y</mark>")
        == "- ```\n  <mark>x</mark>\n  ```\n\nafter ==y==")
    #expect(
      MarkdownSourceOps.markTags("> ```\n> <mark>x</mark>\n> ```\n\n<mark>y</mark>")
        == "> ```\n> <mark>x</mark>\n> ```\n\n==y==")
    let sample = "```md\n- ```\n  <mark>x</mark>\n    ```\n<mark>y</mark>\n```\n\nafter <mark>z</mark>"
    #expect(
      MarkdownSourceOps.markTags(sample)
        == "```md\n- ```\n  <mark>x</mark>\n    ```\n<mark>y</mark>\n```\n\nafter ==z==")
    #expect(MarkdownSourceOps.markTags("<mark>a</mark><mark>b</mark>") == "==a==<mark>b</mark>")
    #expect(
      MarkdownSourceOps.markTags("$<mark>a</mark>$ and $$<mark>b</mark>$$ but <mark>c</mark>")
        == "$<mark>a</mark>$ and $$<mark>b</mark>$$ but ==c==")
    #expect(MarkdownSourceOps.markTags("costs $5 and <mark>c</mark>") == "costs $5 and ==c==")
  }
}
