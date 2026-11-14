import CodeBoardMarkdown
import CoreGraphics
import Foundation
import Testing

@testable import CodeBoardMarkdownUI

/// A drawn image in the editor (editor/inline.ts imageKey, image.ts): selected by a click, its width written by its
/// handles, ↵ opening its source, a typed key going after it, ⌫ taking it
@MainActor @Suite struct ImageTests {
  struct Sized: MarkdownResources {
    func imageSize(_ src: String) -> CGSize? { CGSize(width: 800, height: 400) }
    func ref(label: String, target: String?) -> MarkdownRefHit? { nil }
    func highlight(lines: [String], language: String) -> [[MarkdownToken]]? { nil }
    var mathPreamble: String { "" }
  }

  func view(_ src: String) -> MarkdownEditorView {
    _ = boardFonts
    let l = BlockLayout(MarkdownDocument(src), width: 300, theme: testTheme, layout: nil, resources: Sized())
    return MarkdownEditorView(layout: l, caret: 0)
  }

  @Test func clickSelectsThenKeysAndWidth() {
    let src = "Text\n\n![pic](a.png)\n\nMore"
    let v = view(src)
    let atom = v.core.layout.rects(forAtom: 6..<19)!
    v.core.mouseDown(at: CGPoint(x: atom.midX, y: atom.midY), clicks: 1, extend: false)
    v.core.mouseUp()
    #expect(v.core.selectedImage?.range == 6..<19)
    #expect(v.imageBox != nil)
    v.core.setImageWidth(0.4)
    #expect(v.core.source == "Text\n\n![pic](a.png){width=40%}\n\nMore")
    #expect(v.core.selectedImage?.image.width == 0.4)
    v.core.setImageWidth(nil)
    #expect(v.core.source == src)
    v.core.undo()
    v.core.undo()
    #expect(v.core.source == src)
    v.core.select(MDSelection(anchor: 6, head: 19))
    #expect(v.core.key(.enter))
    #expect(v.selection == MDSelection(8))
    v.core.select(MDSelection(anchor: 6, head: 19))
    v.core.insert("x")
    #expect(v.core.source == "Text\n\n![pic](a.png)x\n\nMore")
    v.core.undo()
    v.core.select(MDSelection(anchor: 6, head: 19))
    v.core.key(.backspace)
    #expect(v.core.source == "Text\n\n\n\nMore")
  }
}
