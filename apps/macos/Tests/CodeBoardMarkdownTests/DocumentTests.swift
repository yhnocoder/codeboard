import Foundation
import Testing

@testable import CodeBoardMarkdown

@Suite struct DocumentTests {
  func text(_ s: String, _ r: Range<Int>) -> String {
    (s as NSString).substring(with: NSRange(location: r.lowerBound, length: r.count))
  }

  @Test func readsTheBlocks() throws {
    let src =
      "# Title\n\npara **b**\n\n- a\n- [x] b\n\n1) one\n\n> q\n\n```py\nx = 1\n```\n\n```mermaid\ngraph TD\n```\n\n$$\nE\n$$\n\n| a | b |\n|:-|-:|\n| 1 | 2 |\n\nTable: cap\n\n---\n\n<div>h</div>\n\n[l]: https://x"
    let d = MarkdownDocument(src)
    let kinds = d.blocks.map { b -> String in
      switch b.kind {
      case .paragraph: "p"
      case .heading(let l): "h\(l)"
      case .quote: "quote"
      case .list(let l): "list \(l.marker)"
      case .code(let lang, let body): "code \(lang ?? "-") \(text(src, body))"
      case .mermaid(let body): "mermaid \(text(src, body))"
      case .math(let latex): "math \(latex)"
      case .table(let t): "table \(t.align) \(t.caption.map { text(src, $0.range) } ?? "-")"
      case .rule: "rule"
      case .html: "html"
      }
    }
    #expect(
      kinds == [
        "h1", "p", "list bullet(\"-\")", "list ordered(start: 1, delimiter: \")\")", "quote", "code py x = 1",
        "mermaid graph TD", "math E",
        "table [CodeBoardMarkdown.MDTable.Align.left, CodeBoardMarkdown.MDTable.Align.right] cap",
        "rule", "html", "p",
      ])
    #expect(text(src, d.blocks[0].range) == "# Title")
    guard case .list(let l) = d.blocks[2].kind else {
      Issue.record("not a list")
      return
    }
    #expect(l.items.map(\.checked) == [nil, true])
    #expect(l.items.map { text(src, $0.markerRange) } == ["-", "- [x]"])
    #expect(l.items[1].children.first.map { text(src, $0.range) } == "b")
  }

  @Test func inlineRangesPointIntoTheSourceThroughQuoteMarkers() throws {
    let src = "> a **b\n> c** d"
    let d = MarkdownDocument(src)
    guard case .quote(let children) = d.blocks[0].kind else {
      Issue.record("not a quote")
      return
    }
    let strong = try #require(children.first?.inlines.first)
    #expect(strong.kind == .strong)
    #expect(text(src, strong.range) == "**b\n> c**")
    #expect(strong.markers.map { text(src, $0) } == ["**", "**"])
    #expect(strong.inner.map { text(src, $0) } == "b\n> c")
  }

  @Test func atomsAndLinks() throws {
    let src = "x $a^2$ ![i](p.png \"cap\"){width=40%} [[R#^id]] [t](https://u) <https://v> :smile: {w|n|green below}"
    let d = MarkdownDocument(src)
    let ins = d.blocks[0].inlines
    #expect(ins.count == 7)
    #expect(ins[0].kind == .atom(.math(latex: "a^2", display: false)))
    guard case .atom(.image(let img)) = ins[1].kind else {
      Issue.record("not an image")
      return
    }
    #expect(img.width == 0.4 && img.caption == "cap" && text(src, img.url) == "p.png")
    #expect(img.attributes.map { text(src, $0) } == "{width=40%}")
    #expect(ins[2].kind == .atom(.ref(label: "R", target: "id")))
    #expect(ins[3].kind == .link(url: "https://u"))
    #expect(ins[3].markers.map { text(src, $0) } == ["[", "](https://u)"])
    #expect(ins[4].kind == .autolink(url: "https://v"))
    #expect(ins[5].kind == .atom(.emoji(name: "smile")))
    #expect(ins[6].kind == .atom(.annotation(text: "w", note: "n", color: "green", below: true)))
  }

  /// every inline range and marker of the corpus lies inside its block, and markers are inside their inline
  @Test func rangesNestOverTheCorpus() throws {
    for c in try JSON.load("blocks").array {
      let src = c["src"].string!
      let len = (src as NSString).length
      func check(_ i: MDInline, in outer: Range<Int>) {
        #expect(
          i.range.lowerBound >= outer.lowerBound && i.range.upperBound <= outer.upperBound, "\(src.debugDescription)")
        for m in i.markers { #expect(m.lowerBound >= i.range.lowerBound && m.upperBound <= i.range.upperBound) }
        for k in i.children { check(k, in: i.range) }
      }
      func walk(_ bs: [MDBlock]) {
        for b in bs {
          #expect(b.range.lowerBound >= 0 && b.range.upperBound <= len)
          for i in b.inlines { check(i, in: 0..<len) }
          switch b.kind {
          case .quote(let ch): walk(ch)
          case .list(let l): for it in l.items { walk(it.children) }
          default: break
          }
        }
      }
      walk(MarkdownDocument(src).blocks)
    }
  }

  /// guideline 8.7: an edit and its undo give back the same document; reparse always equals a fresh parse
  @Test func reparseEqualsAFreshParse() throws {
    var rng = SystemRandomNumberGenerator()
    for c in try JSON.load("blocks").array {
      let src = c["src"].string!
      let doc = MarkdownDocument(src)
      let len = (src as NSString).length
      for _ in 0..<4 {
        let at = len == 0 ? 0 : Int.random(in: 0...len, using: &rng)
        for ins in ["x", "*", "\n", "| ", "$"] {
          let edited = doc.reparse(replacing: at..<at, with: ins)
          #expect(edited == MarkdownDocument(edited.source), "\(src.debugDescription) +\(ins.debugDescription)@\(at)")
          let back = edited.reparse(replacing: at..<(at + (ins as NSString).length), with: "")
          #expect(back.source == src)
          #expect(back == doc)
        }
      }
    }
  }
}
