import AppKit
import CodeBoardMarkdown
import CodeUI
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
    func highlight(lines: [String], language: String) -> [[CodeRun]]? { nil }
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
    #expect(v.tip(at: link)?.text == Self.url && v.tip(at: link)?.long == true)
    #expect(v.tip(at: atom(v, "[[gone]]"))?.text == "Nothing with this title")
    #expect(v.tip(at: mid(v, "Plain words")) == nil)
    // the board's own tip, not the system's: it waits for its delay
    #expect(v.tipView.pending?.text == Self.url && v.tipView.tip == nil && v.tipView.isTicking)
    v.tipView.press()
  }

  // MARK: the board's own tooltip

  @Test func theTipWaitsThenShowsAtOnceWhileWarmAndGoesOnEveryTrigger() {
    let v = view(caret: 0)
    v.isEditing = false
    var now = 100.0
    v.tipView.clock = { now }
    let link = mid(v, "the notes")
    move(v, link)
    #expect(v.tipView.tip == nil && v.tipView.pending != nil)
    v.tipView.fire()
    #expect(v.tipView.tip?.text == Self.url && !v.tipView.isHidden && !v.tipView.isTicking)
    // the pointer leaves the link: gone; back on it soon after, at once (TIP_WARM)
    move(v, mid(v, "Plain words"))
    #expect(v.tipView.tip == nil && v.tipView.isHidden)
    now += MarkdownTiming.tipWarm / 2
    move(v, atom(v, "[[gone]]"))
    #expect(v.tipView.tip?.text == "Nothing with this title")
    // a press, a scroll, a zoom, a pan or pinch, the pointer leaving the Note: each takes it away
    let triggers: [(String, (MarkdownEditorView) -> Void)] = [
      ("press", { $0.mouseDown(with: Self.press(at: .zero, in: $0)) }),
      ("scroll", { $0.scrollWheel(with: Self.wheel()) }),
      ("zoom", { $0.zoom = 1.5 }),
      ("freeze", { $0.freeze() }),
      ("exit", { HoverTests().exit($0) }),
    ]
    for (name, trigger) in triggers {
      let w = view(caret: 0)
      w.isEditing = false
      w.tipView.clock = { now }
      move(w, mid(w, "the notes"))
      w.tipView.fire()
      #expect(w.tipView.tip != nil, "\(name)")
      trigger(w)
      #expect(w.tipView.tip == nil && w.tipView.isHidden && !w.tipView.isTicking, "\(name)")
    }
    // after a press the next one waits its delay again
    let w = view(caret: 0)
    w.isEditing = false
    w.tipView.clock = { now }
    move(w, mid(w, "the notes"))
    w.tipView.fire()
    w.tipView.press()
    move(w, atom(w, "[[gone]]"))
    #expect(w.tipView.tip == nil && w.tipView.pending != nil)
    w.tipView.press()
  }

  static func press(at p: CGPoint, in v: NSView) -> NSEvent {
    NSEvent.mouseEvent(
      with: .leftMouseDown, location: CGPoint(x: p.x, y: v.bounds.height - p.y), modifierFlags: [], timestamp: 0,
      windowNumber: 0, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
  }
  static func up(at p: CGPoint, in v: NSView) -> NSEvent {
    NSEvent.mouseEvent(
      with: .leftMouseUp, location: CGPoint(x: p.x, y: v.bounds.height - p.y), modifierFlags: [], timestamp: 0,
      windowNumber: 0, context: nil, eventNumber: 0, clickCount: 1, pressure: 0)!
  }
  static func wheel() -> NSEvent {
    NSEvent(
      cgEvent: CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: -3, wheel2: 0, wheel3: 0)!)!
  }

  @Test func theTipSitsAboveFlipsBelowAndStaysInsideTheWindow() {
    let area = CGRect(x: 0, y: 0, width: 400, height: 300)
    let size = CGSize(width: 120, height: 25)
    // above, 8 off, centred
    let a = TipView.place(size, anchor: CGRect(x: 100, y: 100, width: 60, height: 16), in: area)
    #expect(a == CGRect(x: 70, y: 67, width: 120, height: 25))
    // no room above: below, 8 off
    let b = TipView.place(size, anchor: CGRect(x: 100, y: 10, width: 60, height: 16), in: area)
    #expect(b.minY == 34)
    // at the window's right edge: shifted to stay 4 inside, past the Note's own edge
    let c = TipView.place(size, anchor: CGRect(x: 380, y: 100, width: 20, height: 16), in: area)
    #expect(c.maxX == 396)
    // an address wraps at 480 (or the window less 16), a name stays on one line
    var theme = testTheme
    theme.controls = MarkdownLooks.controls(warm: false, dark: true)
    let long = TipView.Tip(
      text: "https://example.com/" + String(repeating: "a/very/long/path/", count: 40), long: true, anchor: .zero,
      owner: ObjectIdentifier(HoverTests.self))
    let wide = CGRect(x: 0, y: 0, width: 1200, height: 800)
    let s = TipView.size(long, theme: theme, in: wide)
    #expect(s.width <= 480 && s.height > 30)
    #expect(TipView.size(long, theme: theme, in: CGRect(x: 0, y: 0, width: 300, height: 800)).width <= 284)
    let name = TipView.Tip(text: "Bold", kbd: "⌘B", anchor: .zero, owner: ObjectIdentifier(HoverTests.self))
    // one line of 11.5 at 1.5, and 4 above and below
    #expect(TipView.size(name, theme: theme, in: wide).height == 26)
    // the looks' tips: Ink Wash square and dark on light, Warm Ink round
    #expect(theme.controls.tipRadius == 2 && theme.controls.tipInk == MDColor(hex: "#131312"))
    #expect(MarkdownLooks.theme("warm-ink", dark: false).controls.tipRadius == 8.5)
  }

  @Test func aControlsTipNamesItsKeysAndOnlyItTakesItAway() {
    let v = view(caret: 0)
    v.isEditing = true
    v.selection = MDSelection(anchor: 0, head: 4)
    v.toolbar.show(
      [.init(id: "bold", symbol: "bold", tip: "Bold", kbd: "⌘B", on: false)],
      over: CGRect(x: 40, y: 60, width: 30, height: 16),
      in: CGRect(x: 0, y: 0, width: 400, height: 300), theme: testTheme)
    let t = v.toolbar
    t.hover(at: CGPoint(x: 10, y: 10))
    #expect(v.tipView.pending?.text == "Bold" && v.tipView.pending?.kbd == "⌘B")
    // the text under it does not take the toolbar's tip away
    v.tipView.leave(ObjectIdentifier(v))
    #expect(v.tipView.pending != nil)
    t.hover(at: nil)
    #expect(v.tipView.pending == nil)
  }

  // MARK: pressed buttons

  @Test func aPressedButtonLooksPressedAndAReleaseOffItDoesNothing() {
    let v = view(caret: 0)
    var pressed: [String] = []
    let t = v.toolbar
    t.onPress = { pressed.append($0) }
    t.show(
      [
        .init(id: "bold", symbol: "bold", tip: "Bold", on: false),
        .init(id: "italic", symbol: "italic", tip: "Italic", on: false),
      ],
      over: CGRect(x: 40, y: 60, width: 30, height: 16), in: CGRect(x: 0, y: 0, width: 400, height: 300),
      theme: testTheme)
    var now = 10.0
    t.clock = { now }
    let bold = CGPoint(x: 18, y: 18)
    t.hover(at: bold)
    t.press(at: bold)
    // at once on the press (.tbtn:active: transition none): the ink at 12 %, a little smaller
    #expect(t.look("bold").ink == 0.12 && t.look("bold").scale == 0.96)
    // still pressed off the button while the button is held (CSS :active), and nothing happens on that release
    t.hover(at: CGPoint(x: 200, y: 200))
    #expect(t.look("bold").scale == 0.96)
    t.release(at: CGPoint(x: 200, y: 200))
    #expect(pressed.isEmpty && t.look("bold").scale == 1)
    // released on another button than the one pressed: nothing either
    t.press(at: bold)
    t.release(at: CGPoint(x: 46, y: 18))
    #expect(pressed.isEmpty)
    // a click acts, and the background eases back to the hover look over 120 ms
    t.press(at: bold)
    t.release(at: bold)
    #expect(pressed == ["bold"])
    #expect(t.look("bold").ink == 0.12)
    now += MarkdownTiming.toolbarButtonFade / 2
    #expect(t.look("bold").ink < 0.12 && t.look("bold").ink > 0.07)
    now += MarkdownTiming.toolbarButtonFade
    #expect(abs(t.look("bold").ink - 0.07) < 1e-9)
    // the link box's buttons are the board's too, but change at once
    let acts = LinkActs()
    acts.theme = testTheme
    let open = acts.controls()[0].box
    acts.press(at: CGPoint(x: open.midX, y: open.midY))
    #expect(acts.look("open").ink == 0.12 && acts.look("open").scale == 0.96)
    acts.release(at: CGPoint(x: open.midX, y: open.midY))
    #expect(acts.look("open").ink == 0.07 && !acts.isEasing)
  }

  // MARK: underlines

  @Test func aHoveredLinkOrReferenceDrawsItsLineSolid() {
    for editing in [false, true] {
      let v = view(caret: (Self.text as NSString).range(of: "Plain").location)
      v.isEditing = editing
      move(v, mid(v, "the notes"))
      let r = (Self.text as NSString).range(of: "[the notes](\(Self.url))")
      #expect(v.hoveredLine == r.location..<(r.location + r.length))
      // one line, under the words, where the lighter one is drawn
      let lines = v.core.layout.underlines(v.hoveredLine!)
      let words = v.core.rects(for: (r.location + 1)..<(r.location + 10))
      #expect(lines.count == 1 && lines[0].height == 1 && lines[0].minY > words[0].midY)
      #expect(abs(lines[0].minX - words[0].minX) < 1 && abs(lines[0].maxX - words[0].maxX) < 1)
      // a reference that finds its card: its line; one that finds nothing keeps its hairline
      move(v, atom(v, "[[Step]]"))
      #expect(v.hoveredLine.map { v.core.layout.refLine($0) != nil } == true)
      move(v, atom(v, "[[gone]]"))
      #expect(v.hoveredLine == nil)
      move(v, mid(v, "the notes"))
      exit(v)
      #expect(v.hoveredLine == nil)
    }
    // drawn solid in the link colour in every look
    for look in ["warm-ink", "ink-wash"] {
      for dark in [false, true] {
        let theme = MarkdownLooks.theme(look, dark: dark)
        let l = BlockLayout(MarkdownDocument(Self.text), width: 360, theme: theme, layout: nil, resources: Refs())
        let v = MarkdownEditorView(layout: l, caret: 0)
        v.isEditing = false
        move(v, mid(v, "the notes"))
        let line = v.core.layout.underlines(v.hoveredLine!)[0]
        let p = CGPoint(x: line.midX, y: line.midY)
        let solid = pixel(v, p)
        #expect(zip(solid, pixelOf(theme.colors.link)).allSatisfy { abs($0 - $1) <= 2 }, "\(look) \(dark) \(solid)")
        // and only while hovered: at rest the line is the lighter one
        exit(v)
        #expect(pixel(v, p)[3] < 200, "\(look) \(dark)")
      }
    }
  }

  /// the colour the view draws at a point, drawn 8 times its size so that a 1-point line covers whole pixels, as 8-bit
  /// sRGB with its alpha
  func pixel(_ v: MarkdownEditorView, _ p: CGPoint) -> [Int] {
    let k: CGFloat = 8
    let w = Int(v.bounds.width * k)
    let h = Int(v.bounds.height * k)
    let ctx = CGContext(
      data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.translateBy(x: 0, y: CGFloat(h))
    ctx.scaleBy(x: k, y: -k)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: true)
    v.draw(v.bounds)
    NSGraphicsContext.restoreGraphicsState()
    let bytes = ctx.data!.assumingMemoryBound(to: UInt8.self)
    let i = (Int(p.y * k) * w + Int(p.x * k)) * 4
    return (0..<4).map { Int(bytes[i + $0]) }
  }
  func pixelOf(_ c: MDColor) -> [Int] { [c.r, c.g, c.b, 1].map { Int(($0 * 255).rounded()) } }

  // MARK: transitions

  @Test func gripsAndButtonsEaseFromTheClockAndNothingRunsAtRest() {
    let v = view(Self.table, caret: 0)
    v.isEditing = true
    var now = 50.0
    v.core.clock = { now }
    let c = cells(v)
    move(v, CGPoint(x: c[2][1].midX, y: c[2][1].midY))
    // the grips come in over 90 ms ease-out, opacity and scale with it
    #expect(v.gripShow.row.value(at: now) == 0 && v.gripsEasing)
    let half = v.gripShow.row.value(at: now + MarkdownTiming.gripFade / 2)
    #expect(half > 0.5 && half < 1)
    now += MarkdownTiming.gripFade
    #expect(v.gripShow.row.value(at: now) == 1 && v.gripShow.col.value(at: now) == 1)
    v.gripFrame(nil)
    #expect(!v.gripsEasing)
    // and go the same way when the pointer leaves
    exit(v)
    #expect(v.gripShow.row.value(at: now + MarkdownTiming.gripFade / 2) > 0)
    now += MarkdownTiming.gripFade
    v.gripFrame(nil)
    #expect(v.gripShow.row.value(at: now) == 0 && !v.gripsEasing)
    // the band's controls: in after the strip has started up, out at once
    let strip = v.band.subviews.first!.subviews.first as! CodeBand.Strip
    strip.clock = { now }
    strip.showRow(false, animated: false)
    strip.showRow(true, animated: true)
    #expect(strip.row.value(at: now + MarkdownTiming.bandRowInDelay) == 0)
    #expect(strip.row.value(at: now + MarkdownTiming.bandRowInDelay + MarkdownTiming.bandRowIn) == 1)
    now += 1
    strip.easeFrame(nil)
    #expect(!strip.isEasing)
    // the heading chip eases over 90 ms; nothing is left running at rest
    let chip = v.headingChip
    chip.clock = { now }
    chip.frame = CGRect(x: 0, y: 0, width: 12, height: 13)
    chip.hover(at: CGPoint(x: 1, y: 1))
    #expect(chip.isEasing)
    #expect(chip.look("chip").ink == 0)
    now += MarkdownTiming.headingChipFade
    #expect(abs(chip.look("chip").ink - 0.085) < 1e-9)
    chip.easeFrame(nil)
    v.band.show(false)
    strip.showRow(false, animated: false)
    strip.easeFrame(nil)
    v.tipView.press()
    v.clearHover()
    now += 1
    v.gripFrame(nil)
    #expect(!v.gripsEasing && !v.easingControls && !v.tipView.isTicking)
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
