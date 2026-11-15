import AppKit
import CodeBoardMarkdown
import Foundation
import Testing

@testable import CodeBoardMarkdownUI

/// The pointer resting on the Note as on main: a link's address as a tooltip and the pointing hand on the static
/// picture, the pointing hand on links and references while editing, a table's band and grips on hover wherever the
/// caret is, gone when the pointer leaves or the Note moves under it
@MainActor @Suite struct HoverTests {
  struct Refs: MarkdownResources {
    func imageSize(_ src: String) -> CGSize? { nil }
    func ref(label: String, target: String?) -> MarkdownRefHit? {
      label == "gone" ? nil : .found(title: label, seal: nil)
    }
    func highlight(lines: [String], language: String) -> [[MarkdownToken]]? { nil }
    var mathPreamble: String { "" }
  }

  static let url = "https://example.com/docs/scheduler"
  static let text = "Read [the notes](\(url)) and [[Step]] or [[gone]] first.\n\nPlain words here."

  func view(_ src: String = HoverTests.text, caret: Int) -> MarkdownEditorView {
    _ = boardFonts
    let l = BlockLayout(MarkdownDocument(src), width: 360, theme: testTheme, layout: nil, resources: Refs())
    return MarkdownEditorView(layout: l, caret: caret)
  }

  /// a view with no window takes window points as its own, its y counted from the bottom
  func move(_ v: MarkdownEditorView, _ p: CGPoint) {
    let q = CGPoint(x: p.x * v.zoom, y: v.bounds.height - p.y * v.zoom)
    let e = NSEvent.mouseEvent(
      with: .mouseMoved, location: q, modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil, eventNumber: 0,
      clickCount: 0, pressure: 0)!
    v.mouseMoved(with: e)
  }
  func exit(_ v: MarkdownEditorView) {
    let e = NSEvent.enterExitEvent(
      with: .mouseExited, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil,
      eventNumber: 0, trackingNumber: 0, userData: nil)!
    v.mouseExited(with: e)
  }
  func mid(_ v: MarkdownEditorView, _ needle: String) -> CGPoint {
    let r = (v.core.source as NSString).range(of: needle)
    let b = v.core.rects(for: r.location..<(r.location + r.length)).first!
    return CGPoint(x: b.midX, y: b.midY)
  }
  func atom(_ v: MarkdownEditorView, _ needle: String) -> CGPoint {
    let r = (v.core.source as NSString).range(of: needle)
    let b = v.core.layout.rects(forAtom: r.location..<(r.location + r.length))!
    return CGPoint(x: b.midX, y: b.midY)
  }

  @Test func theStaticPictureShowsTheHandAndTheAddress() {
    let v = view(caret: 0)
    v.isEditing = false
    let link = mid(v, "the notes")
    #expect(v.cursor(at: link) == .pointingHand)
    #expect(v.cursor(at: mid(v, "Plain words")) == .arrow)
    // a reference that finds its card takes the hand, one that finds nothing does nothing there
    #expect(v.cursor(at: atom(v, "[[Step]]")) == .pointingHand)
    #expect(v.cursor(at: atom(v, "[[gone]]")) == .arrow)
    move(v, link)
    #expect(v.tips.contains { $0.text == Self.url && $0.box.contains(link) })
    #expect(v.view(v, stringForToolTip: 0, point: link, userData: nil) == Self.url)
    #expect(v.view(v, stringForToolTip: 0, point: atom(v, "[[gone]]"), userData: nil) == "Nothing with this title")
    #expect(v.view(v, stringForToolTip: 0, point: mid(v, "Plain words"), userData: nil) == "")
  }

  @Test func editingShowsTheHandOnLinksAndReferences() {
    let v = view(caret: (Self.text as NSString).range(of: "Plain").location)
    v.isEditing = true
    #expect(v.cursor(at: mid(v, "the notes")) == .pointingHand)
    #expect(v.cursor(at: atom(v, "[[Step]]")) == .pointingHand)
    #expect(v.cursor(at: mid(v, "first")) == .iBeam)
    // the link's source written out with the caret in it: its words are still the link, its markers text
    v.selection = MDSelection((Self.text as NSString).range(of: "the notes").location + 2)
    #expect(v.cursor(at: mid(v, "the notes")) == .pointingHand)
    #expect(v.cursor(at: mid(v, "](")) == .iBeam)
    // no address tooltips while editing (the editor's links have none)
    move(v, mid(v, "the notes"))
    #expect(v.tips.isEmpty)
  }

  static let table = "Before\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |"

  func cells(_ v: MarkdownEditorView) -> [[CGRect]] {
    guard case .table(let t) = v.core.document.blocks[1].kind else { return [] }
    return v.core.layout.cellBoxes(of: t)
  }

  @Test func aHoveredCellShowsItsTablesBandAndGripsWithTheCaretElsewhere() {
    let v = view(Self.table, caret: 2)
    v.isEditing = true
    #expect(!v.band.shown)
    let c = cells(v)
    let cell = CGPoint(x: c[2][1].midX, y: c[2][1].midY)
    move(v, cell)
    #expect(v.band.shown && v.band.table != nil)
    // the hovered row's grip at the table's left edge, the hovered column's on its top edge
    let rowGrip = CGPoint(x: c[2][0].minX + 6, y: c[2][0].midY)
    let colGrip = CGPoint(x: c[0][1].midX, y: c[0][1].minY + 6)
    #expect(v.cursor(at: rowGrip) == .openHand)
    #expect(v.cursor(at: colGrip) == .openHand)
    // a band action with the caret outside the table works on its last cell
    v.band.onPart("rowBelow", v, .zero)
    #expect(v.core.source == Self.table + "\n|   |   |")
    v.undo(nil)
    v.selection = MDSelection(2)
    // the pointer leaves the Note: the grips go at once, the band after its grace
    move(v, cell)
    exit(v)
    #expect(v.hoverTableAt == nil && v.cursor(at: rowGrip) == .iBeam)
    let end = Date().addingTimeInterval(2)
    while v.band.shown, Date() < end { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
    #expect(!v.band.shown)
  }

  @Test func nothingComesUpWhileTheNoteMovesUnderThePointer() {
    let v = view(Self.table, caret: 2)
    v.isEditing = true
    let c = cells(v)
    v.holdsToolbar = true
    move(v, CGPoint(x: c[2][1].midX, y: c[2][1].midY))
    #expect(!v.band.shown && v.hoverTableAt == nil)
    v.holdsToolbar = false
    v.freeze()
    move(v, CGPoint(x: c[2][1].midX, y: c[2][1].midY))
    #expect(!v.band.shown && v.hoverTableAt == nil)
    v.thaw()
    move(v, CGPoint(x: c[2][1].midX, y: c[2][1].midY))
    #expect(v.band.shown)
  }
}
