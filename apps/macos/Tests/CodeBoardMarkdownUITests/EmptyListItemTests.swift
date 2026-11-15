import CodeBoardMarkdown
import CoreGraphics
import Foundation
import Testing

@testable import CodeBoardMarkdownUI

/// An item with nothing after its marker is a line of its own the caret goes into: by Enter, by the arrows, by a
/// click anywhere on its line, and what is typed lands in it
@Suite struct EmptyListItemTests {
  func core(_ src: String, caret: Int) -> EditorCore {
    _ = boardFonts
    let l = BlockLayout(MarkdownDocument(src), width: 300, theme: testTheme, layout: nil, resources: TestResources())
    return EditorCore(layout: l, caret: caret)
  }
  func len(_ s: String) -> Int { (s as NSString).length }

  static let lists = [
    "- ab\n- \n- ", "- ab\n-\n-", "1. ab\n2. \n3. ", "- [ ] ab\n- [ ] \n- [ ] ", "- ab\n- \n- \n\nAfter",
    "| a | b |\n|---|---|\n| 1 | 2 |\n\nTable: t\n\n- ab\n- \n- ",
  ]

  /// where each empty item's caret goes: right after its marker and its space
  func empties(_ src: String) -> [Int] {
    let ns = src as NSString
    var out: [Int] = []
    ns.enumerateSubstrings(in: NSRange(location: 0, length: ns.length), options: [.byLines, .substringNotRequired]) {
      _, r, _, _ in
      let line = ns.substring(with: r)
      if ["-", "- ", "2. ", "3. ", "- [ ] "].contains(line) { out.append(r.location + (line as NSString).length) }
    }
    return out
  }

  @Test(arguments: lists) func eachEmptyItemHasALineOfItsOwn(_ src: String) {
    let e = core(src, caret: 0)
    let ys = empties(src).map { e.layout.caretRect(MDCaret($0))!.midY }
    #expect(ys.count == 2)
    let first = e.layout.caretRect(MDCaret(src.utf16.count > 0 ? empties(src)[0] - 3 : 0))!.midY
    #expect(Set(ys + [first]).count == 3)
  }

  @Test(arguments: lists) func arrowDownReachesEachEmptyItem(_ src: String) {
    let q = empties(src)
    let e = core(src, caret: q[0] - 2)
    e.moveVertically(down: true, extend: false)
    #expect(e.selection.head == q[0])
    e.moveVertically(down: true, extend: false)
    #expect(e.selection.head == q[1])
    e.moveVertically(down: false, extend: false)
    #expect(e.selection.head == q[0])
  }

  @Test(arguments: lists) func aClickOnAnEmptyItemsLinePutsTheCaretThere(_ src: String) {
    for q in empties(src) {
      for dx in [-12.0, 0.5, 60] {
        let e = core(src, caret: 0)
        let r = e.layout.caretRect(MDCaret(q))!
        e.mouseDown(at: CGPoint(x: r.minX + dx, y: r.midY), clicks: 1, extend: false)
        e.mouseUp()
        #expect(e.selection.head == q, "\(dx)")
      }
    }
  }

  @Test func typingLandsInTheEmptyItem() {
    let src = "- ab\n- \n- "
    let e = core(src, caret: 7)
    e.insert("x")
    #expect(e.layout.document.source == "- ab\n- x\n- ")
    let f = core("1. ab\n2. ", caret: 9)
    f.insert("y")
    #expect(f.layout.document.source == "1. ab\n2. y")
  }

  /// Enter at an item's end: a new empty item with the caret in it, its own line
  @Test func enterMakesAnItemTheCaretIsIn() {
    let e = core("- ab", caret: 4)
    _ = e.key(.enter)
    #expect(e.layout.document.source == "- ab\n- ")
    #expect(e.selection.head == 7)
    #expect(e.caretRect!.midY > e.layout.caretRect(MDCaret(4))!.midY)
    e.insert("c")
    #expect(e.layout.document.source == "- ab\n- c")
  }

  /// Enter in an empty last item leaves the list for a paragraph after it, as main's lift does
  @Test func enterInAnEmptyLastItemLeavesTheList() {
    for (src, out) in [("- ab\n- ", "- ab\n\nq"), ("- ab\n- \n\nAfter", "- ab\n\nq\n\nAfter")] {
      let e = core(src, caret: 7)
      _ = e.key(.enter)
      e.insert("q")
      #expect(e.layout.document.source == out)
      #expect(e.layout.document.blocks.count == (src.hasSuffix("After") ? 3 : 2))
    }
  }

  /// Enter in an empty nested item takes it up a level
  @Test func enterInAnEmptyNestedItemLiftsIt() {
    let e = core("- ab\n  - c\n  - ", caret: 15)
    _ = e.key(.enter)
    #expect(e.layout.document.source == "- ab\n  - c\n- ")
    #expect(e.selection.head == 13)
    e.insert("d")
    #expect(e.layout.document.source == "- ab\n  - c\n- d")
  }

  /// the source of empty items is kept as written
  @Test(arguments: lists) func emptyItemsKeepTheirSource(_ src: String) {
    #expect(MarkdownDocument(src).source == src)
    #expect(core(src, caret: 0).layout.document.source == src)
  }
}
