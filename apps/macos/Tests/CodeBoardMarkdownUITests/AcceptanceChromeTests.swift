import AppKit
import CodeBoardMarkdown
import Testing

@testable import CodeBoardMarkdownUI

/// What the acceptance run on the editing chrome found, each as it drives it
@MainActor @Suite struct AcceptanceChromeTests {
  func view(_ src: String, caret: Int) -> MarkdownEditorView {
    _ = boardFonts
    let l = BlockLayout(MarkdownDocument(src), width: 400, theme: testTheme, layout: nil, resources: TestResources())
    let v = MarkdownEditorView(layout: l, caret: caret)
    v.isEditing = true
    return v
  }

  /// the / menu longer than its panel scrolls inside it: nothing of its last rows is drawn below the panel
  @Test func theSlashMenusRowsStayInsideItsPanel() {
    let v = view("Text", caret: 4)
    v.insertText(" /", replacementRange: NSRange(location: NSNotFound, length: 0))
    let m = v.typedMenu
    #expect(m.shown && CGFloat(m.items.count) * 26 + 8 > m.frame.height)
    #expect(m.clipsToBounds)
  }

  /// a / menu opened on the Note's last line, with no room under it: above the line, inside the Note (the [[ menu ran
  /// off the window's bottom)
  @Test func aMenuNearTheBottomOpensAbove() {
    let v = view((1...20).map { "Line \($0)" }.joined(separator: "\n\n"), caret: 0)
    v.selection = MDSelection((v.core.source as NSString).length)
    v.insertText(" /", replacementRange: NSRange(location: NSNotFound, length: 0))
    let caret = v.core.caretRect!
    #expect(v.typedMenu.shown)
    #expect(v.typedMenu.frame.maxY <= caret.minY * v.zoom)
    #expect(v.typedMenu.frame.minY >= v.bounds.minY)
  }

  /// the pointer stepped down through a long menu's rows, then again after the list is scrolled: the chosen row is
  /// the row under the pointer at every step (it followed only sometimes)
  @Test func theChosenRowFollowsThePointer() {
    let v = view((1...20).map { "Line \($0)" }.joined(separator: "\n\n"), caret: 0)
    v.selection = MDSelection((v.core.source as NSString).length)
    v.insertText(" /", replacementRange: NSRange(location: NSNotFound, length: 0))
    let m = v.typedMenu
    for k in 0..<10 {
      m.point(at: CGPoint(x: 40, y: 4 + 26 * CGFloat(k) + 13))
      #expect(m.chosen == k)
    }
    // down the keys to the list's last rows (15 of them): it scrolls
    for _ in 0..<4 { m.step(1) }
    // scrolled now: the row under the same point is a later one
    m.point(at: CGPoint(x: 40, y: 4 + 13))
    #expect(m.chosen > 0)
    let before = m.chosen
    m.point(at: CGPoint(x: 40, y: 4 + 26 + 13))
    #expect(m.chosen == before + 1)
  }

  /// a menu hanging past the Note's bottom edge, and a band's buttons: tracked over their whole box (the part outside
  /// the Note got no mouse moves, the highlight stuck), and the menu ends on a whole row where it scrolls
  @Test func floatingControlsAreTrackedOverTheirWholeBox() {
    let v = view("Line", caret: 4)
    v.insertText(" /", replacementRange: NSRange(location: NSNotFound, length: 0))
    let m = v.typedMenu
    #expect(m.frame.maxY > v.bounds.maxY)
    m.updateTrackingAreas()
    let a = m.trackingAreas.first { $0.owner === m }
    #expect(a?.rect == m.bounds)
    #expect(a.map { !$0.options.contains(.inVisibleRect) } == true)
    #expect((m.frame.height - 8).truncatingRemainder(dividingBy: 26) == 0)
  }

  /// the toolbar over a selection on the last line: above it, 8 points off, as main places it; never where the pointer
  /// just pressed (a press on the line above went to the toolbar's Link and opened the link box)
  @Test func theToolbarSitsAboveTheSelectionAndAwayFromThePress() {
    let v = view("First line\n\nSecond line\n\nLast words here", caret: 0)
    let ns = v.core.source as NSString
    let r = ns.range(of: "words")
    v.selection = MDSelection(anchor: r.location, head: NSMaxRange(r))
    v.placeToolbar()
    let line = v.core.selectionRects[0]
    #expect(abs(v.toolbar.frame.maxY - (line.minY - 8)) < 0.5)
    // the press was where the toolbar would sit: it goes under the line instead
    v.lastPress = CGPoint(x: v.toolbar.frame.midX, y: v.toolbar.frame.midY)
    v.placeToolbar()
    #expect(abs(v.toolbar.frame.minY - (line.maxY + 8)) < 0.5)
    #expect(!v.toolbar.frame.contains(v.lastPress!))
  }

  /// on the first line, above would leave the Note: under it
  @Test func theToolbarFlipsUnderWhenAboveLeavesTheNote() {
    let v = view("Top words here\n\nmore\n\nand more\n\nand the end", caret: 0)
    v.selection = MDSelection(anchor: 4, head: 9)
    v.placeToolbar()
    #expect(v.toolbar.frame.minY > v.core.selectionRects[0].maxY)
  }

  /// an appearance switched while the selection toolbar is open: the toolbar takes the dark theme (it stayed white)
  @Test func anOpenToolbarTakesANewAppearance() {
    let v = view("Some words here", caret: 0)
    v.selection = MDSelection(anchor: 0, head: 4)
    v.placeToolbar()
    #expect(!v.toolbar.isHidden)
    let dark = MarkdownLooks.theme("warm-ink", dark: true)
    v.core.relayout(
      BlockLayout(v.core.document, width: 400, theme: dark, layout: nil, resources: TestResources()))
    #expect(v.toolbar.theme?.colors.surface == dark.colors.surface)
  }
}

/// A click in the space just below a code block, above a formula block: the gap's caret between them (it went into the
/// formula's source, the formula's slop taking the click)
@MainActor @Suite struct GapClickTests {
  @Test func aClickBelowACodeBlockAboveAFormulaIsTheGap() {
    _ = boardFonts
    let src = "Text\n\n```python\ndef f():\n    return 1\n```\n\n$$\nx^2\n$$\n\nAfter"
    let l = BlockLayout(MarkdownDocument(src), width: 400, theme: testTheme, layout: nil, resources: TestResources())
    let code = l.blockFrames[1]
    let math = l.blockFrames[2]
    for y in [code.maxY + 2, (code.maxY + math.minY) / 2, math.minY - 2] {
      let e = EditorCore(layout: l, caret: 0)
      e.mouseDown(at: CGPoint(x: 100, y: y), clicks: 1, extend: false)
      e.mouseUp()
      #expect(e.selection == MDSelection(41))
    }
  }
}

/// A centred picture resized by its right grip (her recording: it collapsed, came back larger): the width is the press's
/// plus twice the pointer's way, so back at the press point it is the width it started with, and the ring is the
/// picture's rect in every step
@MainActor @Suite struct ImageResizeTests {
  @Test func aDragLeftAndBackReturnsToTheStartingWidth() {
    _ = boardFonts
    let src = "# Pic\n\nA line.\n\n![p](a.png){width=60%}\n\nAfter."
    let l = BlockLayout(MarkdownDocument(src), width: 392, theme: testTheme, layout: nil, resources: ImageTests.Sized())
    let v = MarkdownEditorView(layout: l, caret: 0)
    v.isEditing = true
    func send(_ t: NSEvent.EventType, _ p: CGPoint) {
      // a view with no window takes window points as its own, its y counted from the bottom
      let q = CGPoint(x: p.x, y: v.bounds.height - p.y)
      let ev = NSEvent.mouseEvent(
        with: t, location: q, modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil, eventNumber: 0,
        clickCount: 1, pressure: 1)!
      switch t {
      case .leftMouseDown: v.mouseDown(with: ev)
      case .leftMouseDragged: v.mouseDragged(with: ev)
      default: v.mouseUp(with: ev)
      }
    }
    let f0 = v.core.layout.images[0].frame
    send(.leftMouseDown, CGPoint(x: f0.midX, y: f0.midY))
    send(.leftMouseUp, CGPoint(x: f0.midX, y: f0.midY))
    #expect(v.core.selectedImage != nil)
    let g = CGPoint(x: f0.maxX, y: f0.midY)
    send(.leftMouseDown, g)
    // a point a frame to the left: the width follows by two points every step (it once moved in whole-percent steps)
    var last = f0.width
    for dx in stride(from: -1.0, through: -20, by: -1) {
      send(.leftMouseDragged, CGPoint(x: g.x + dx, y: g.y))
      let f = v.core.layout.images[0].frame
      #expect(abs(last - f.width - 2) < 0.1, "\(dx): \(last) → \(f.width)")
      #expect(v.imageBox == f)
      last = f.width
    }
    send(.leftMouseDragged, g)
    #expect(abs(v.core.layout.images[0].frame.width - f0.width) < 0.5)
    send(.leftMouseUp, g)
    #expect(v.core.source == src)
  }
}

/// A table under a heading and a paragraph whose cells start with inline code (her card): every cell has its box, so
/// the band sits on the table's top edge (a cell without one made the table's box reach the Note's top)
@MainActor @Suite struct TableBandPlaceTests {
  @Test func cellsStartingWithCodeHaveTheirBoxes() {
    _ = boardFonts
    let src =
      "## A heading\n\nA paragraph of two lines, long enough to wrap in a narrow Note, before the table.\n\n"
      + "| Declaration | Memory |\n|---|---|\n| plain words | register |\n| `__device__ int x;` | global |\n"
      + "| `[x] y` | shared |"
    let l = BlockLayout(MarkdownDocument(src), width: 300, theme: testTheme, layout: nil, resources: TestResources())
    let doc = l.document
    guard case .table(let t) = doc.blocks[2].kind else { return #expect(Bool(false)) }
    let cells = l.cellBoxes(of: t)
    #expect(!cells.joined().contains(.zero))
    let top = cells.joined().map(\.minY).min() ?? 0
    #expect(abs(top - l.blockFrames[2].minY) < 2)
  }
}

/// A table wider than its Note (ten columns in 320 points): its band spans the part the Note shows, so ⋯ is in reach
/// (the band ran the table's whole width, its end and ⋯ cut off past the Note's edge)
@MainActor @Suite struct WideTableBandTests {
  @Test func theBandStaysOverTheShownPart() {
    _ = boardFonts
    let cols = 1...10
    let src =
      "| " + cols.map { "H\($0)" }.joined(separator: " | ") + " |\n|" + String(repeating: "---|", count: 10) + "\n| "
      + cols.map { _ in "a longer cell text" }.joined(separator: " | ") + " |"
    let l = BlockLayout(MarkdownDocument(src), width: 320, theme: testTheme, layout: nil, resources: TestResources())
    let v = MarkdownEditorView(layout: l, caret: 2)
    v.isEditing = true
    v.selection = MDSelection(2)
    #expect(v.band.shown)
    #expect(v.band.bandFrame.maxX <= v.bounds.maxX + 0.5)
    #expect(v.band.partRect("more") != nil)
  }
}

/// A table wider than its Note scrolls across inside it (it was cut off): a sideways scroll over it moves the table, the
/// caret moved to its last column scrolls it into view, and what is drawn and hit follows the scroll
@MainActor @Suite struct WideTableScrollTests {
  @Test func theTableScrollsAndTheCaretStaysInView() {
    _ = boardFonts
    let cols = 1...10
    let src =
      "| " + cols.map { "H\($0)" }.joined(separator: " | ") + " |\n|" + String(repeating: "---|", count: 10) + "\n| "
      + cols.map { "cell\($0) words" }.joined(separator: " | ") + " |"
    let l = BlockLayout(MarkdownDocument(src), width: 320, theme: testTheme, layout: nil, resources: TestResources())
    let v = MarkdownEditorView(layout: l, caret: 2)
    v.isEditing = true
    let last = (src as NSString).range(of: "cell10").location + 2
    v.selection = MDSelection(last)
    let r = v.core.caretRect!
    #expect(r.minX >= 0 && r.maxX <= 320)
    #expect((v.core.layout.scrollX[0] ?? 0) > 0)
    // a press where the caret is drawn finds that place again
    v.core.mouseDown(at: CGPoint(x: r.midX, y: r.midY), clicks: 1, extend: false)
    v.core.mouseUp()
    #expect(abs(v.core.selection.head - last) <= 1)
  }
}
