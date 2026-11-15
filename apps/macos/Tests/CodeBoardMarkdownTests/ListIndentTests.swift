import Foundation
import Testing

@testable import CodeBoardMarkdown

/// Tab and ⇧Tab in lists as main's list items have them (TipTap sinkListItem, liftListItem)
@Suite struct ListIndentTests {
  /// the source after the key, the caret at `q` (or a selection), nil when the key changes nothing
  func press(_ key: MDKey, _ src: String, at q: Int, to r: Int? = nil) -> (String, MDSelection)? {
    let state = MDEditState(source: src, selection: MDSelection(anchor: q, head: r ?? q))
    guard let e = MarkdownEditing.key(key, in: state, document: MarkdownDocument(src)) else { return nil }
    let out = (src as NSString).replacingCharacters(
      in: NSRange(location: e.range.lowerBound, length: e.range.count), with: e.replacement)
    return (out, e.selection)
  }
  func at(_ src: String, _ s: String) -> Int { (src as NSString).range(of: s).location }

  /// anywhere in an item, at its start or in its text: the whole item goes under the one before, the caret with it
  @Test func tabSinksTheItemFromItsStartOrItsMiddle() {
    let src = "- a\n- b\n- c"
    for q in [at(src, "b"), at(src, "b") + 1] {
      #expect(press(.tab, src, at: q)?.0 == "- a\n  - b\n- c")
      // the caret stays on the same text
      #expect(press(.tab, src, at: q)?.1 == MDSelection(q + 2))
    }
  }

  /// a task goes under the item before at its text, its box kept
  @Test func aTaskSinksWithItsBox() {
    #expect(press(.tab, "- [ ] a\n- [x] b", at: 12)?.0 == "- [ ] a\n  - [x] b")
  }

  /// ordered: the moved item starts a list of its own from 1 at the number's width, the ones after it renumbered
  @Test func orderedItemsAreRenumbered() {
    let src = "1. a\n2. b\n3. c\n4. d"
    #expect(press(.tab, src, at: at(src, "c"))?.0 == "1. a\n2. b\n   1. c\n3. d")
  }

  /// a selection over two items moves both
  @Test func aSelectionMovesEveryItemItTouches() {
    let src = "- a\n- b\n- c\n- d"
    #expect(press(.tab, src, at: at(src, "b"), to: at(src, "c") + 1)?.0 == "- a\n  - b\n  - c\n- d")
  }

  /// the first item has nothing to go under: nothing changes, in a nested list too
  @Test func theFirstItemStays() {
    #expect(press(.tab, "- a\n- b", at: 2) == nil)
    #expect(press(.tab, "- a\n  - b\n  - c", at: 8) == nil)
  }

  /// ⌫ at an item's start lifts it as ⇧Tab does; in an empty item amid a top-level list the item only goes
  @Test func backspaceAtAnItemsStartLiftsIt() {
    #expect(press(.backspace, "- a\n  - b", at: 8)?.0 == "- a\n- b")
    #expect(press(.backspace, "- a\n- b", at: 6)?.0 == "- a\n\nb")
    #expect(press(.backspace, "- a\n- ", at: 6)?.0 == "- a\n\n")
    #expect(press(.backspace, "- a\n- \n- c", at: 6)?.0 == "- a\n- c")
    #expect(press(.backspace, "- a\n- \n- c", at: 6)?.1 == MDSelection(3))
  }

  /// already nested: deeper still, under the item before at its level
  @Test func aNestedItemSinksDeeper() {
    let src = "- a\n  - b\n  - c"
    #expect(press(.tab, src, at: at(src, "c"))?.0 == "- a\n  - b\n    - c")
  }

  /// a mixed list: each item keeps its own marker
  @Test func aMixedListKeepsEachMarker() {
    let src = "- a\n- [ ] b\n- c"
    #expect(press(.tab, src, at: at(src, "b"))?.0 == "- a\n  - [ ] b\n- c")
  }

  /// ⇧Tab: a nested item back to its parent's place, the ones after it staying under it
  @Test func shiftTabLiftsANestedItem() {
    let src = "- a\n  - b\n  - c"
    #expect(press(.shiftTab, src, at: at(src, "b"))?.0 == "- a\n- b\n  - c")
  }

  /// ⇧Tab under an ordered parent: the lifted items numbered on from it; a task keeps its box; a selection lifts all
  @Test func shiftTabNumbersKeepsBoxesAndTakesTheSelection() {
    let ordered = "1. a\n   1. b\n2. c"
    #expect(press(.shiftTab, ordered, at: at(ordered, "b"))?.0 == "1. a\n2. b\n3. c")
    let task = "- [ ] a\n  - [x] b"
    #expect(press(.shiftTab, task, at: at(task, "b"))?.0 == "- [ ] a\n- [x] b")
    let two = "- a\n  - b\n  - c"
    #expect(press(.shiftTab, two, at: at(two, "b"), to: at(two, "c") + 1)?.0 == "- a\n- b\n- c")
  }

  /// ⇧Tab on a top-level item: out of the list, a paragraph set apart from it
  @Test func shiftTabTakesATopLevelItemOutOfTheList() {
    let src = "- a\n- b\n- c"
    #expect(press(.shiftTab, src, at: at(src, "b"))?.0 == "- a\n\nb\n\n- c")
  }

  /// outside lists Tab does nothing; in code and tables it does what it did
  @Test func tabElsewhereIsUnchanged() {
    #expect(press(.tab, "plain text", at: 3) == nil)
    #expect(press(.tab, "# Title", at: 3) == nil)
    // code: its indent unit at the caret, in a list item's code block too
    #expect(press(.tab, "```\nx\n```", at: 4)?.0 == "```\n    x\n```")
    #expect(press(.tab, "- a\n\n  ```\n  x\n  ```", at: 13)?.0 == "- a\n\n  ```\n      x\n  ```")
    // a table cell: the next cell
    let table = "| a | b |\n|---|---|\n| 1 | 2 |"
    #expect(press(.tab, table, at: 2).map { $0.0 == table && $0.1.head > 2 } == true)
  }
}
