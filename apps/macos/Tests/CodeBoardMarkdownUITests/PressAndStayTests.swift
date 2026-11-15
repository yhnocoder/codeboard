import AppKit
import CodeBoardMarkdown
import Foundation
import Testing

@testable import CodeBoardMarkdownUI

/// The selection's toolbar stays up while its own buttons or the format keys change the text under it, and every
/// button of a Note's chrome shows the board's press (Luna, 2026-11-15)
@MainActor @Suite struct PressAndStayTests {
  func editing(_ src: String, _ sel: MDSelection) -> (MarkdownEditorView, NSWindow) {
    _ = boardFonts
    let l = BlockLayout(MarkdownDocument(src), width: 360, theme: testTheme, layout: nil, resources: TestResources())
    let v = MarkdownEditorView(layout: l, caret: 0)
    let w = NSWindow(
      contentRect: CGRect(x: 0, y: 0, width: 400, height: 300), styleMask: [.borderless], backing: .buffered,
      defer: true)
    w.contentView?.addSubview(v)
    v.isEditing = true
    w.makeFirstResponder(v)
    v.core.select(sel)
    v.placeToolbar()
    return (v, w)
  }

  func command(_ key: String, _ v: MarkdownEditorView, _ w: NSWindow) {
    let e = NSEvent.keyEvent(
      with: .keyDown, location: .zero, modifierFlags: [.command], timestamp: 0, windowNumber: w.windowNumber,
      context: nil, characters: key, charactersIgnoringModifiers: key, isARepeat: false, keyCode: 11)!
    _ = v.performKeyEquivalent(with: e)
  }

  @Test func theToolbarStaysThroughItsOwnButtons() {
    let (v, _) = editing("alpha beta gamma", MDSelection(anchor: 6, head: 10))
    #expect(v.toolbarShown)
    for id in ["bold", "italic", "italic", "highlight", "strike", "code", "math"] {
      v.toolbarPress(id)
      #expect(v.toolbarShown, "\(id)")
    }
    #expect(v.core.source != "alpha beta gamma")
    // the button's on state follows at once
    v.toolbarPress("bold")
    #expect(v.toolbarShown)
  }

  @Test func theToolbarStaysThroughTheFormatKeysAndAcrossParagraphs() {
    let (v, w) = editing("one two\n\nthree four", MDSelection(anchor: 4, head: 15))
    #expect(v.toolbarShown)
    command("b", v, w)
    #expect(v.core.source.contains("**"))
    #expect(v.toolbarShown)
    command("b", v, w)
    #expect(v.core.source == "one two\n\nthree four")
    #expect(v.toolbarShown)
  }

  /// the link button opens the link box, which takes the toolbar's place, as on main
  @Test func theLinkButtonGivesWayToItsBox() {
    let (v, _) = editing("alpha beta gamma", MDSelection(anchor: 6, head: 10))
    v.toolbarPress("link")
    #expect(!v.toolbarShown)
  }

  @Test func bandButtonsAndTheHeadingChipLookPressedWhileHeld() {
    let strip = CodeBand.Strip(frame: CGRect(x: 0, y: 0, width: 300, height: 40))
    strip.theme = testTheme
    strip.table = true
    strip.parts = [
      .init(id: "rowBelow", kind: .icon("rowBelow"), tip: "Row Below", on: false),
      .init(id: "delRow", kind: .icon("delRow"), tip: "Delete Row", on: false),
    ]
    strip.showRow(true, animated: false)
    let boxes = Dictionary(uniqueKeysWithValues: strip.controls().map { ($0.id, $0.box) })
    for id in ["rowBelow", "delRow"] {
      let b = boxes[id]!
      let mid = CGPoint(x: b.midX, y: b.midY)
      strip.hover(at: mid)
      let hovered = pixel(strip, at: CGPoint(x: b.minX + 4, y: b.midY))
      strip.press(at: mid)
      #expect(strip.look(id).scale == HoverControls.pressScale)
      let held = pixel(strip, at: CGPoint(x: b.minX + 4, y: b.midY))
      // a step deeper than hover; a delete stays in the warning's colour
      #expect(
        held.alphaComponent > hovered.alphaComponent || held.brightnessComponent < hovered.brightnessComponent, "\(id)")
      if id == "delRow" { #expect(held.redComponent > held.greenComponent + 0.05) }
      // released off it: back, and nothing done
      strip.release(at: CGPoint(x: 290, y: 5))
      #expect(strip.look(id).scale == 1)
    }
    let chip = HeadingChip(frame: CGRect(x: 0, y: 0, width: 12, height: 13))
    chip.press(at: CGPoint(x: 6, y: 6))
    #expect(chip.look("chip").scale == HoverControls.pressScale && chip.look("chip").ink == 0.12)
    chip.release(at: CGPoint(x: 100, y: 100))
    #expect(chip.look("chip").scale == 1)
  }

  func pixel(_ v: NSView, at p: CGPoint) -> NSColor {
    let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds)!
    v.cacheDisplay(in: v.bounds, to: rep)
    let k = CGFloat(rep.pixelsWide) / v.bounds.width
    let y = v.isFlipped ? p.y : v.bounds.height - p.y
    return rep.colorAt(x: Int(p.x * k), y: Int(y * k))!.usingColorSpace(.sRGB)!
  }
}
