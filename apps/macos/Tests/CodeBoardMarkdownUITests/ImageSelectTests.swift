import AppKit
import CodeBoardMarkdown
import Testing

@testable import CodeBoardMarkdownUI

/// A selected image as on the web (noteImageSelect): grips on its sides, no text toolbar; a press and release on a grip
/// resizes and leaves it selected with its source closed (the press was once taken as a click on the picture, whose
/// release opened the source and moved the picture down)
@MainActor @Suite struct ImageSelectTests {
  func press(_ v: MarkdownEditorView, _ type: NSEvent.EventType, _ p: CGPoint) -> NSEvent {
    NSEvent.mouseEvent(
      with: type, location: v.convert(p, to: nil), modifierFlags: [], timestamp: 0,
      windowNumber: v.window?.windowNumber ?? 0, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
  }

  @Test func gripsResizeWithoutOpeningTheSource() {
    _ = boardFonts
    let src = "Text\n\n![pic](a.png \"a caption under it\"){width=50%}\n\nMore"
    let l = BlockLayout(MarkdownDocument(src), width: 300, theme: testTheme, layout: nil, resources: ImageTests.Sized())
    let v = MarkdownEditorView(layout: l, caret: 0)
    // in a window (never shown), so points go through the window's coordinates as a real press does
    let w = NSWindow(
      contentRect: CGRect(origin: .zero, size: l.size), styleMask: [.borderless], backing: .buffered, defer: true)
    w.isReleasedWhenClosed = false
    w.contentView = NSView(frame: CGRect(origin: .zero, size: l.size))
    w.contentView!.addSubview(v)
    let atom = v.core.layout.rects(forAtom: 6..<54)!
    v.core.mouseDown(at: CGPoint(x: atom.midX, y: atom.minY + 20), clicks: 1, extend: false)
    v.core.mouseUp()
    #expect(v.core.selectedImage != nil)
    let box = v.imageBox!
    let picture = v.core.layout.images.first!.frame
    #expect(box == picture)
    let grips = v.handles(box)
    #expect(
      grips.allSatisfy { abs($0.midY - box.midY) < 0.5 } && grips[0].midX < box.minX + 1 && grips[1].midX > box.maxX - 1
    )
    v.selection = v.core.selection
    #expect(v.toolbar.isHidden && !v.isTicking)
    // the grip's outer half, past the editor's edge, is the editor's
    #expect(
      w.contentView!.hitTest(v.convert(CGPoint(x: grips[1].maxX - 0.5, y: grips[1].midY), to: w.contentView)) === v)
    let g = CGPoint(x: grips[1].midX, y: grips[1].midY)
    v.mouseDown(with: press(v, .leftMouseDown, g))
    v.mouseDragged(with: press(v, .leftMouseDragged, CGPoint(x: g.x + 20, y: g.y)))
    v.mouseUp(with: press(v, .leftMouseUp, CGPoint(x: g.x + 20, y: g.y)))
    #expect(v.core.selectedImage != nil)
    #expect(abs(v.core.layout.images.first!.frame.minY - picture.minY) < 0.01)
    #expect(v.core.source.contains("{width=") && !v.core.source.contains("width=50%"))
    w.close()
  }
}
