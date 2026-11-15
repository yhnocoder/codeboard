import AppKit
import CodeBoardMarkdown
import CodeBoardTestGuard
import Foundation
import Testing

@testable import CodeBoardMarkdownUI

/// The editor view draws with the static picture's code: with the caret where it opens nothing, its pixels are the
/// static layout's (guideline 8.5); keys reach the core through the system's key bindings
@MainActor @Suite struct EditorViewTests {
  /// A Markdown editor made in a test process puts the test guard in, as a canvas does: no menu, alert, panel, browser
  /// or Finder comes up, and ⌘C, ⌘X and ⌘V go to the process's own pasteboard, never the owner's clipboard
  @Test func anEditorPutsTheTestGuardIn() {
    let l = BlockLayout(
      MarkdownDocument("Some text"), width: 300, theme: testTheme, layout: nil, resources: TestResources())
    let v = MarkdownEditorView(layout: l, caret: 0)
    // first: asking the guard whether it is in puts it in
    #expect(v.pasteboard.name != NSPasteboard.Name.general)
    #expect(TestGuard.guardsContextMenus && TestGuard.guardsOpening && TestGuard.guardsPasteboard)
  }

  static let text = """
    # Title with **bold**

    Body with **bold**, *em*, `code` and ==hl==. 中文混排一段，看看折行是不是一样。

    - one item
    - two

    The end of it
    """

  func bitmap(_ draw: (CGContext) -> Void, _ size: CGSize, scale: CGFloat) -> [UInt8] {
    let w = Int((size.width * scale).rounded(.up))
    let h = Int((size.height * scale).rounded(.up))
    let ctx = CGContext(
      data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.translateBy(x: 0, y: CGFloat(h))
    ctx.scaleBy(x: scale, y: -scale)
    draw(ctx)
    return Array(UnsafeBufferPointer(start: ctx.data!.assumingMemoryBound(to: UInt8.self), count: w * h * 4))
  }

  @Test func theEditorIsTheStaticPictureWithTheCaretAtTheEnd() {
    _ = boardFonts
    let d = MarkdownDocument(Self.text)
    let still = MarkdownLayout.make(d, width: 320, theme: testTheme, layout: nil, resources: TestResources())
    let view = MarkdownEditorView(
      layout: BlockLayout(d, width: 320, theme: testTheme, layout: nil, resources: TestResources()))
    #expect(view.selection == MDSelection((Self.text as NSString).length))
    let size = still.size
    let a = bitmap(
      { ctx in
        ctx.setShouldSubpixelQuantizeFonts(false)
        ctx.setAllowsFontSubpixelQuantization(false)
        still.draw(in: ctx, scale: 2, clip: CGRect(origin: .zero, size: size)) { _ in nil }
      }, size, scale: 2)
    let b = bitmap(
      { ctx in
        NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: true)
        view.draw(CGRect(origin: .zero, size: size))
        NSGraphicsContext.current = nil
      }, size, scale: 2)
    #expect(a == b)
  }

  /// A key redraws only the rows of the block it changed (with the caret's old and new place), and what that redraw
  /// leaves on the old picture is the picture of the new text; a key that makes a block redraws all below it
  @Test func aKeyRedrawsOnlyWhereThePictureChanged() throws {
    _ = boardFonts
    let text = (0..<40).map { "Paragraph \($0) with **bold** and `code` in it." }.joined(separator: "\n\n")
    let view = MarkdownEditorView(
      layout: BlockLayout(
        MarkdownDocument(text), width: 320, theme: testTheme, layout: nil, resources: TestResources()),
      caret: (text as NSString).range(of: "Paragraph 20 with").upperBound)
    view.alwaysShowsCaret = true
    let size = view.frame.size
    let ctx = CGContext(
      data: nil, width: Int(size.width * 2), height: Int(size.height * 2), bitsPerComponent: 8,
      bytesPerRow: Int(size.width * 2) * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.translateBy(x: 0, y: size.height * 2)
    ctx.scaleBy(x: 2, y: -2)
    func draw(_ r: CGRect) {
      ctx.saveGState()
      ctx.clip(to: r)
      ctx.clear(r)
      NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: true)
      view.draw(r)
      NSGraphicsContext.current = nil
      ctx.restoreGState()
    }
    func pixels() -> [UInt8] {
      Array(
        UnsafeBufferPointer(start: ctx.data!.assumingMemoryBound(to: UInt8.self), count: ctx.bytesPerRow * ctx.height))
    }
    let all = CGRect(origin: .zero, size: size)
    draw(all)
    view.insertText("x", replacementRange: NSRange(location: NSNotFound, length: 0))
    let block = view.core.layout.blockFrames[20]
    let area = try #require(view.changedArea())
    #expect(area.minY >= block.minY - 20 && area.maxY <= block.maxY + 20, "\(area) for \(block)")
    draw(area.insetBy(dx: -1, dy: -1).integral)
    let patched = pixels()
    draw(all)
    #expect(patched == pixels(), "the redrawn rows on the old picture are the new picture")
    view.doCommand(by: #selector(NSResponder.insertNewline(_:)))
    let below = try #require(view.changedArea())
    #expect(below.maxY >= view.core.layout.size.height - 1, "a new block moves all below it")
  }

  @Test func keysGoThroughTheSystemsBindings() {
    _ = boardFonts
    let view = MarkdownEditorView(
      layout: BlockLayout(
        MarkdownDocument("alpha beta"), width: 320, theme: testTheme, layout: nil, resources: TestResources()),
      caret: 0)
    view.doCommand(by: #selector(NSResponder.moveWordRight(_:)))
    #expect(view.selection == MDSelection(5))
    view.doCommand(by: #selector(NSResponder.moveToEndOfDocumentAndModifySelection(_:)))
    #expect(view.selection == MDSelection(anchor: 5, head: 10))
    view.doCommand(by: #selector(NSResponder.moveLeft(_:)))
    #expect(view.selection == MDSelection(5))
  }
}
