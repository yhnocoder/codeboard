import AppKit
import CodeBoardMarkdown
import Testing

@testable import CodeBoardMarkdownUI

// The editor's own pictures (MarkdownEditorView strips) in a window under the desktop: what each strip shows is what
// the editor draws there, whichever way it came to be drawn (a key, a move of the editor or of what holds it, a new size
// its host answers by moving it, a blink)

private final class Flipped: NSView {
  override var isFlipped: Bool { true }
}

/// Sixty paragraphs in a window 400 × 500 under the desktop (AppKit draws it, it never shows on the screen)
@MainActor private final class StripRig {
  let window: NSWindow
  /// the window's content, and the view holding the editor inside it (moved as a scrolling tray moves its content)
  let host = Flipped(frame: CGRect(x: 0, y: 0, width: 400, height: 500))
  let inner = Flipped(frame: CGRect(x: 0, y: 0, width: 400, height: 4000))
  let view: MarkdownEditorView

  init(width: CGFloat = 320, zoom: CGFloat = 1, caretAt: String = "Paragraph 3 with", text: String? = nil) {
    _ = boardFonts
    let text = text ?? (0..<60).map { "Paragraph \($0) with **bold** and `code` in it." }.joined(separator: "\n\n")
    view = MarkdownEditorView(
      layout: BlockLayout(
        MarkdownDocument(text), width: width, theme: testTheme, layout: nil, resources: TestResources()),
      caret: (text as NSString).range(of: caretAt).upperBound)
    view.zoom = zoom
    window = NSWindow(
      contentRect: CGRect(x: 0, y: 0, width: 400, height: 500), styleMask: [.borderless], backing: .buffered,
      defer: false)
    window.alphaValue = 0.02
    window.ignoresMouseEvents = true
    window.setFrameOrigin(CGPoint(x: -30000, y: -30000))
    window.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) - 1)
    host.wantsLayer = true
    window.contentView = host
    host.addSubview(inner)
    inner.addSubview(view)
    view.frame.origin = CGPoint(x: 10, y: 0)
    window.orderFrontRegardless()
    show()
  }

  func close() { window.orderOut(nil) }

  /// AppKit's display pass, and what it committed
  func show() {
    window.displayIfNeeded()
    CATransaction.flush()
  }

  var scale: CGFloat { window.backingScaleFactor }

  /// The editor's own drawing of strip `i`'s band, as the strip's pixels are laid out, in its effective appearance
  func drawn(_ i: Int, like s: MarkdownEditorView.Strip) -> Data? {
    let h = MarkdownEditorView.stripHeight
    let band = CGRect(x: 0, y: CGFloat(i) * h, width: view.bounds.width, height: h)
    let ctx = CGContext(
      data: nil, width: s.ctx.width, height: s.ctx.height, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpace(name: CGColorSpace.sRGB)!,
      bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
    ctx.setShouldSmoothFonts(false)
    ctx.translateBy(x: 0, y: CGFloat(ctx.height))
    ctx.scaleBy(x: CGFloat(ctx.width) / band.width, y: -CGFloat(ctx.width) / band.width)
    ctx.translateBy(x: 0, y: -band.minY)
    view.effectiveAppearance.performAsCurrentDrawingAppearance {
      NSGraphicsContext.saveGraphicsState()
      NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: true)
      view.draw(band)
      NSGraphicsContext.restoreGraphicsState()
    }
    return ctx.makeImage()?.dataProvider?.data as Data?
  }

  /// The strips that show something else than the editor's drawing of their band
  func wrong() -> [Int] {
    view.strips.keys.sorted().filter { i in
      let s = view.strips[i]!
      return s.layer.contents as AnyObject? !== s.surface
        || s.ctx.makeImage()?.dataProvider?.data as Data? != drawn(i, like: s)
    }
  }

  /// The strips the window shows: those in it and one band around
  func wanted() -> Set<Int> {
    let h = MarkdownEditorView.stripHeight
    let shown = view.visibleRect.insetBy(dx: 0, dy: -h).intersection(view.bounds)
    return shown.isEmpty ? [] : Set(Int(shown.minY / h)..<Int((shown.maxY / h).rounded(.up)))
  }
}

/// Moves the editor down by `by` each time its size changes, as a host placing it again would
@MainActor private final class Mover: MarkdownEditorDelegate {
  var by: CGFloat
  init(by: CGFloat) { self.by = by }
  func editor(_ e: MarkdownEditorView, didChange source: String) {}
  func editor(_ e: MarkdownEditorView, didResize size: CGSize) { e.frame.origin.y -= by }
  func editorWantsToEnd(_ e: MarkdownEditorView) {}
  func editorDidBegin(_ e: MarkdownEditorView) {}
}

@MainActor @Suite struct StripTests {
  /// A strip's new picture shows at once: no fade from the one before (an implicit animation of `contents` kept the
  /// surface being drawn into on the screen a quarter of a second)
  @Test func aStripsNewPictureShowsAtOnce() {
    let r = StripRig()
    defer { r.close() }
    r.view.insertText("x", replacementRange: NSRange(location: NSNotFound, length: 0))
    r.show()
    #expect(!r.view.strips.isEmpty)
    for (i, s) in r.view.strips {
      #expect((s.layer.animationKeys() ?? []).isEmpty, "strip \(i): \(s.layer.animationKeys() ?? [])")
    }
  }

  /// Moved out of its window and back (its frame set, as the canvas places it), the editor shows its text again
  @Test func anEditorMovedOutOfItsWindowAndBackShowsItsText() {
    let r = StripRig()
    defer { r.close() }
    r.view.frame.origin.y = 3000
    r.show()
    #expect(r.view.strips.isEmpty, "out of the window: none kept")
    r.view.frame.origin.y = -300
    r.show()
    #expect(!r.view.strips.isEmpty && Set(r.view.strips.keys) == r.wanted(), "\(r.view.strips.keys.sorted())")
    #expect(r.wrong().isEmpty, "\(r.wrong())")
  }

  /// What holds the editor moved (a tray scrolled), the editor's own frame the same: the bands come into view drawn
  @Test func theBandsAScrollBringsInAreDrawn() {
    let r = StripRig()
    defer { r.close() }
    r.inner.frame.origin.y = -900
    r.show()
    #expect(!r.view.strips.isEmpty && Set(r.view.strips.keys) == r.wanted(), "\(r.view.strips.keys.sorted())")
    #expect(r.wrong().isEmpty, "\(r.wrong())")
    r.window.setContentSize(CGSize(width: 400, height: 900))
    r.show()
    #expect(Set(r.view.strips.keys) == r.wanted() && r.wrong().isEmpty, "a taller window")
  }

  /// A key and a move in the same pass: each strip shown takes one new picture, in the display pass, never drawn into
  /// while it shows (moved, only the bands new in view are made)
  @Test func aStripTurnsOnceAPass() {
    let r = StripRig()
    defer { r.close() }
    let before = r.view.strips.mapValues { $0.surface }
    r.view.insertText("x", replacementRange: NSRange(location: NSNotFound, length: 0))
    r.view.frame.origin.y = -300
    for (i, s) in before where r.view.strips[i] != nil {
      #expect(r.view.strips[i]!.surface === s, "strip \(i) turned on the move")
    }
    r.show()
    #expect(r.wrong().isEmpty, "\(r.wrong())")
  }

  /// A host that moves the editor when it grows (bringing a new band into view, drawn there and then) loses nothing of
  /// the change that grew it
  @Test func aChangeThatGrowsTheEditorIsDrawnWhenItsHostMovesIt() {
    let r = StripRig(caretAt: "Paragraph 4 with **bold** and `code` in it.")
    defer { r.close() }
    let mover = Mover(by: 300)
    r.view.delegate = mover
    r.view.doCommand(by: #selector(NSResponder.insertNewline(_:)))
    r.view.insertText("A new paragraph", replacementRange: NSRange(location: NSNotFound, length: 0))
    r.show()
    #expect(r.wrong().isEmpty, "\(r.wrong())")
  }
}
