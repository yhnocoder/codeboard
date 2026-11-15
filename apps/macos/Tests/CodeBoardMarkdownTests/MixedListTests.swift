import Foundation
import Testing

@testable import CodeBoardMarkdown

/// A list may mix bullets and tasks: Enter continues the item it is pressed in, not the list's first item
@Suite struct MixedListTests {
  func enter(_ src: String, at q: Int? = nil) -> String? {
    let state = MDEditState(source: src, selection: MDSelection(q ?? (src as NSString).length))
    guard let e = MarkdownEditing.key(.enter, in: state, document: MarkdownDocument(src)) else { return nil }
    return (src as NSString).replacingCharacters(
      in: NSRange(location: e.range.lowerBound, length: e.range.count), with: e.replacement)
  }

  @Test func enterContinuesTheItemsOwnMarker() {
    let mixed = "- a\n  - b\n- [x] c\n- [ ] d"
    #expect(enter(mixed) == mixed + "\n- [ ] ")
    // a task after a checked one starts unchecked
    #expect(enter(mixed, at: 17) == "- a\n  - b\n- [x] c\n- [ ] \n- [ ] d")
    // a bullet after a bullet, though tasks follow
    #expect(enter(mixed, at: 9) == "- a\n  - b\n  - \n- [x] c\n- [ ] d")
    #expect(enter("1. a\n2. [ ] b") == "1. a\n2. [ ] b\n3. [ ] ")
  }
}
