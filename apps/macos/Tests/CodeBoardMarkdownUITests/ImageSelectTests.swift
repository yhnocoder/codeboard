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
    // over a grip the pointer is a left-right resize, as on the web (it stayed an I-beam)
    #expect(v.cursor(at: CGPoint(x: grips[1].midX, y: grips[1].midY)) == .resizeLeftRight)
    #expect(v.cursor(at: CGPoint(x: grips[0].midX, y: grips[0].midY)) == .resizeLeftRight)
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

/// The shape acceptance's note-image has: an image with no width yet, ending the Note, selected by a click and widened
/// by its right grip; on release the width is written and the image stays selected, its source closed, also through
/// undo and redo (the selection once became the source line's text, which opened it and moved the picture down)
@MainActor @Suite struct ImageFirstWidthTests {
  @Test func theFirstWidthKeepsTheImageSelected() {
    _ = boardFonts
    let image = "![a picture of the scheduler](pictures/step.png)"
    let src = "Some text.\n\n" + image
    let l = BlockLayout(MarkdownDocument(src), width: 300, theme: testTheme, layout: nil, resources: ImageTests.Sized())
    let v = MarkdownEditorView(layout: l, caret: 0)
    let w = NSWindow(
      contentRect: CGRect(origin: .zero, size: l.size), styleMask: [.borderless], backing: .buffered, defer: true)
    w.isReleasedWhenClosed = false
    w.contentView = NSView(frame: CGRect(origin: .zero, size: l.size))
    w.contentView!.addSubview(v)
    func ev(_ t: NSEvent.EventType, _ p: CGPoint) -> NSEvent {
      NSEvent.mouseEvent(
        with: t, location: v.convert(p, to: nil), modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil,
        eventNumber: 0, clickCount: 1, pressure: 1)!
    }
    let pic = v.core.layout.images.first!.frame
    v.mouseDown(with: ev(.leftMouseDown, CGPoint(x: pic.midX, y: pic.midY)))
    v.mouseUp(with: ev(.leftMouseUp, CGPoint(x: pic.midX, y: pic.midY)))
    #expect(v.core.selectedImage != nil)
    // as in the window: the layout's caret left at the image's end, where its width is about to be written
    v.core.layout.setHead((src as NSString).length)
    let box = v.imageBox!
    let g = CGPoint(x: v.handles(box)[1].midX, y: box.midY)
    v.mouseDown(with: ev(.leftMouseDown, g))
    v.mouseDragged(with: ev(.leftMouseDragged, CGPoint(x: g.x - 60, y: g.y)))
    v.mouseUp(with: ev(.leftMouseUp, CGPoint(x: g.x - 60, y: g.y)))
    #expect(v.core.source.hasSuffix("{width=") == false && v.core.source.contains("{width="), "\(v.core.source)")
    #expect(v.core.selectedImage != nil && v.imageBox != nil, "\(v.core.selection)")
    #expect(abs(v.core.layout.images.first!.frame.minY - pic.minY) < 0.5)
    v.undo(nil)
    #expect(v.core.source == src && v.core.selectedImage != nil && v.imageBox != nil, "\(v.core.selection)")
    v.redo(nil)
    #expect(
      v.core.source.contains("{width=") && v.core.selectedImage != nil && v.imageBox != nil, "\(v.core.selection)")
    #expect(abs(v.core.layout.images.first!.frame.minY - pic.minY) < 0.5)
    w.close()
  }
}

/// The caret beside a drawn picture is drawn a little off its edge, as on the web (imagecaret.ts)
@MainActor @Suite struct ImageCaretTests {
  @Test func offThePicturesEdge() {
    _ = boardFonts
    let src = "Text ![p](a.png){width=30%} after"
    let l = BlockLayout(MarkdownDocument(src), width: 300, theme: testTheme, layout: nil, resources: ImageTests.Sized())
    let v = MarkdownEditorView(layout: l, caret: 5)
    let pic = l.images.first!.frame
    v.selection = MDSelection(5)
    #expect(abs(v.offImage(l.caretRect(MDCaret(5))!).minX - (pic.minX - 2)) < 0.5)
    v.selection = MDSelection(27)
    #expect(abs(v.offImage(l.caretRect(MDCaret(27))!).minX - (pic.maxX + 2)) < 0.5)
  }
}

/// An address typed while editing loads once it has stood for IMAGE_SETTLE; one shown before loads at once
@MainActor @Suite struct ImageSettleTests {
  @Test func aNewAddressWaits() {
    _ = boardFonts
    let src = "![p](a.png)"
    let l = BlockLayout(MarkdownDocument(src), width: 300, theme: testTheme, layout: nil, resources: ImageTests.Sized())
    let v = MarkdownEditorView(layout: l, caret: 0)
    var t = 100.0
    v.core.clock = { t }
    v.isEditing = false
    #expect(v.settled("a.png"))
    v.isEditing = true
    v.selection = MDSelection(7)
    #expect(v.settled("a.png"))
    #expect(!v.settled("ab.png"))
    t += MarkdownTiming.imageSettle / 2
    #expect(!v.settled("ab.png"))
    t += MarkdownTiming.imageSettle / 2
    #expect(v.settled("ab.png"))
  }
}
