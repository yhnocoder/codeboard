import AppKit
import CodeBoardMarkdown
import Foundation
import Testing

@testable import CodeBoardMarkdownUI

/// The editor view draws with the static picture's code: with the caret where it opens nothing, its pixels are the
/// static layout's (guideline 8.5); keys reach the core through the system's key bindings
@MainActor @Suite struct EditorViewTests {
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
