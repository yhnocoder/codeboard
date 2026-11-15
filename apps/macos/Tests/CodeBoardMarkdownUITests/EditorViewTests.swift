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

  /// In a window the editor shows pictures of its own, strips of it: those in view and one around them, the pixels of
  /// its drawing; a key draws into them again what changed, a new line the rest below it, and nothing is lost
  @Test func itsStripsInViewArePixelsOfItsDrawing() throws {
    _ = boardFonts
    let text = (0..<60).map { "Paragraph \($0) with **bold** and `code` in it." }.joined(separator: "\n\n")
    let view = MarkdownEditorView(
      layout: BlockLayout(
        MarkdownDocument(text), width: 320, theme: testTheme, layout: nil, resources: TestResources()),
      caret: (text as NSString).range(of: "Paragraph 3 with").upperBound)
    let w = NSWindow(
      contentRect: CGRect(x: 0, y: 0, width: 400, height: 500), styleMask: [.borderless], backing: .buffered,
      defer: false)
    w.alphaValue = 0.02
    w.ignoresMouseEvents = true
    w.setFrameOrigin(CGPoint(x: -30000, y: -30000))
    // under the desktop: AppKit draws it, it never shows on the screen
    w.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) - 1)
    let host = FlippedHost(frame: CGRect(x: 0, y: 0, width: 400, height: 500))
    host.wantsLayer = true
    w.contentView = host
    host.addSubview(view)
    view.setFrameOrigin(CGPoint(x: 10, y: 0))
    w.orderFrontRegardless()
    defer { w.orderOut(nil) }
    let scale = w.backingScaleFactor
    let h = MarkdownEditorView.stripHeight
    /// each strip's picture against the editor drawing that band itself
    func same() -> Bool {
      w.displayIfNeeded()
      CATransaction.flush()
      return !view.strips.isEmpty
        && view.strips.allSatisfy { i, s in
          let band = CGRect(x: 0, y: CGFloat(i) * h, width: view.bounds.width, height: h)
          let ctx = CGContext(
            data: nil, width: s.ctx.width, height: s.ctx.height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
          ctx.setShouldSmoothFonts(false)
          ctx.translateBy(x: 0, y: CGFloat(ctx.height))
          ctx.scaleBy(x: scale, y: -scale)
          ctx.translateBy(x: 0, y: -band.minY)
          NSGraphicsContext.saveGraphicsState()
          NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: true)
          view.draw(band)
          NSGraphicsContext.restoreGraphicsState()
          let shown = s.layer.contents.map { $0 as! CGImage }
          return shown?.dataProvider?.data as Data? == ctx.makeImage()?.dataProvider?.data as Data?
            && s.layer.frame == band
        }
    }
    #expect(view.frame.height > 1500 && same())
    // the window's 500 points and a strip under them, of a Note over 1500 tall
    #expect(Set(view.strips.keys) == Set(0..<3), "\(view.strips.keys.sorted())")
    // shown the right way up: the editor's layer as Core Animation draws it, against the editor drawing itself
    let top = CGRect(x: 0, y: 0, width: view.bounds.width, height: 3 * h)
    func bitmap(_ draw: (CGContext) -> Void) -> Data? {
      let ctx = CGContext(
        data: nil, width: Int(top.width * scale), height: Int(top.height * scale), bitsPerComponent: 8,
        bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
      ctx.setShouldSmoothFonts(false)
      ctx.translateBy(x: 0, y: CGFloat(ctx.height))
      ctx.scaleBy(x: scale, y: -scale)
      draw(ctx)
      return ctx.makeImage()?.dataProvider?.data as Data?
    }
    let drawn = bitmap { ctx in
      NSGraphicsContext.saveGraphicsState()
      NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: true)
      view.draw(top)
      NSGraphicsContext.restoreGraphicsState()
    }
    // (hidden: the editor's own subviews, a find bar and the like, are not what is compared)
    for v in view.subviews { v.isHidden = true }
    let down = bitmap { ctx in view.layer!.render(in: ctx) }
    /// bytes that differ: Core Animation's own drawing of a picture may round a pixel or two
    func differ(_ a: Data?, _ b: Data?) -> Int {
      guard let a, let b, a.count == b.count else { return .max }
      return zip(a, b).reduce(0) { $0 + ($1.0 == $1.1 ? 0 : 1) }
    }
    #expect(differ(down, drawn) < 64, "the strips the right way up: \(differ(down, drawn)) bytes differ")
    view.insertText("x", replacementRange: NSRange(location: NSNotFound, length: 0))
    #expect(same(), "a key")
    view.doCommand(by: #selector(NSResponder.insertNewline(_:)))
    view.insertText("A new paragraph", replacementRange: NSRange(location: NSNotFound, length: 0))
    #expect(same(), "a new block")
    view.setFrameOrigin(CGPoint(x: 10, y: -600))
    #expect(Set(view.strips.keys) == Set(1..<6) && same(), "moved up: \(view.strips.keys.sorted())")
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

private final class FlippedHost: NSView {
  override var isFlipped: Bool { true }
}
