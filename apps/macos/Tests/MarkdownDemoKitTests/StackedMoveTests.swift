import AppKit
import CodeBoardMarkdown
import Testing

@testable import CodeBoardMarkdownUI
@testable import MarkdownDemoKit

/// ⌘ on a column of two cards with the inspector open, as she did it: a press and release on a block without moving is
/// main's ⌘-click (the blocks picked up, floating right of the Note, nothing written); the float stays where the window
/// shows it (it went under the inspector), and Esc puts the block back with the source unchanged
@MainActor @Suite struct StackedMoveTests {
  static var kept: [Demo] = []

  @Test func aCommandClickFloatsInViewAndEscPutsItBack() throws {
    _ = NSApplication.shared
    let demo = try Demo(text: sample, folder: sampleFolder(), cardWidth: 420)
    demo.secondText = secondSample
    demo.setUp()
    _ = Check.lay(demo, width: 1000)
    Self.kept.append(demo)
    let e = demo.cards[0]
    e.isEditing = true
    let before = e.core.source
    let f = e.core.layout.blockFrames[3]
    let local = CGPoint(x: f.midX, y: f.midY)
    let page = demo.page.convert(
      CGPoint(x: e.frame.minX + local.x * e.zoom, y: e.frame.minY + local.y * e.zoom), to: nil)
    for t in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
      let ev = NSEvent.mouseEvent(
        with: t, location: page, modifierFlags: [.command], timestamp: 0, windowNumber: demo.window.windowNumber,
        context: nil, eventNumber: 0, clickCount: 1, pressure: t == .leftMouseDown ? 1 : 0)!
      #expect(demo.moves.handle(ev) == nil)
    }
    // where the float goes, whatever the display's clock (a runner's display link may not have moved it yet)
    let shown = demo.scroll.documentVisibleRect
    #expect(demo.moves.floatFrame != nil)
    let to = try #require(demo.moves.lastGlide?.to)
    #expect(shown.contains(to))
    #expect(e.core.source == before)
    let esc = NSEvent.keyEvent(
      with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: demo.window.windowNumber,
      context: nil, characters: "\u{1b}", charactersIgnoringModifiers: "\u{1b}", isARepeat: false, keyCode: 53)!
    #expect(demo.moves.handle(esc) == nil)
    #expect(demo.moves.floatFrame == nil)
    #expect(e.core.source == before)
  }

  /// a ⌘-click's float starts on the block's box as it was at the press and glides straight right, level with it (it
  /// once went a block's height up first, its frame animated in the page layer while the Note closed up under it)
  @Test func aCommandClickGlidesStraightRightFromTheBlock() throws {
    _ = NSApplication.shared
    let demo = try Demo(text: sample, folder: sampleFolder(), cardWidth: 420)
    demo.secondText = secondSample
    demo.setUp()
    _ = Check.lay(demo, width: 1000)
    Self.kept.append(demo)
    let e = demo.cards[0]
    e.isEditing = true
    let f = e.core.layout.blockFrames[3]
    let local = CGPoint(x: f.midX, y: f.midY)
    let blocks = try #require(e.core.blocks(at: local))
    let r = e.core.frame(of: blocks)
    let o = demo.settledOrigin(of: e)
    let box = CGRect(
      x: o.x + r.minX * e.zoom, y: o.y + r.minY * e.zoom, width: r.width * e.zoom, height: r.height * e.zoom)
    let page = demo.page.convert(
      CGPoint(x: e.frame.minX + local.x * e.zoom, y: e.frame.minY + local.y * e.zoom), to: nil)
    for t in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
      let ev = NSEvent.mouseEvent(
        with: t, location: page, modifierFlags: [.command], timestamp: 0, windowNumber: demo.window.windowNumber,
        context: nil, eventNumber: 0, clickCount: 1, pressure: t == .leftMouseDown ? 1 : 0)!
      #expect(demo.moves.handle(ev) == nil)
    }
    let glide = try #require(demo.moves.lastGlide)
    #expect(glide.from == box, "\(glide.from) \(box)")
    #expect(glide.to.minY == box.minY && glide.to.size == box.size && glide.to.minX > box.minX)
  }

  /// the heading chip in the card's left padding, outside the editor's bounds: a press there reaches the chip (it went
  /// nowhere), and a level picked rewrites the marker as one undo step with the caret kept
  @Test func thePressOnTheHeadingChipReachesIt() throws {
    _ = NSApplication.shared
    let demo = try Demo(text: sample, folder: sampleFolder(), cardWidth: 420)
    demo.secondText = secondSample
    demo.setUp()
    _ = Check.lay(demo, width: 1000)
    Self.kept.append(demo)
    let e = demo.cards[0]
    e.isEditing = true
    e.selection = MDSelection(5)
    let chip = try #require(e.subviews.first { $0 is HeadingChip && !$0.isHidden })
    #expect(!e.bounds.contains(CGPoint(x: chip.frame.midX, y: chip.frame.midY)))
    let content = demo.window.contentView!
    let q = content.convert(e.convert(CGPoint(x: chip.frame.midX, y: chip.frame.midY), to: nil), from: nil)
    #expect(content.hitTest(q) === chip)
    let before = e.core.source
    (chip as! HeadingChip).onPick(2)
    #expect(e.core.source == "#" + before)
    #expect(e.selection == MDSelection(6))
    e.undo(nil)
    #expect(e.core.source == before)
  }

  /// Card one edited with its floating pieces up (a table's band, the heading chip, the selection toolbar, the note
  /// box, the find bar), then editing moves to card two: nothing of card one's stays over its static picture (a table's
  /// band stayed, the caret left in its cell)
  @Test func leavingANoteTakesItsChromeAway() throws {
    _ = NSApplication.shared
    let demo = try Demo(text: sample, folder: sampleFolder(), cardWidth: 420)
    demo.secondText = secondSample
    demo.setUp()
    _ = Check.lay(demo, width: 1000)
    Self.kept.append(demo)
    let (a, b) = (demo.cards[0], demo.cards[1])
    a.isEditing = true
    let cell = (a.core.source as NSString).range(of: "prefill |").location + 2
    a.selection = MDSelection(cell)
    #expect(a.band.shown)
    a.isEditing = false
    b.isEditing = true
    #expect(!a.band.shown)
    // and the rest, each shown then left
    a.isEditing = true
    a.selection = MDSelection(4)
    a.openFind(replace: false)
    let w = (a.core.source as NSString).range(of: "scheduler")
    a.selection = MDSelection(anchor: w.location, head: NSMaxRange(w))
    a.placeToolbar()
    a.openNoteBox()
    a.isEditing = false
    let floating = a.subviews.filter { !$0.isHidden && !($0 is CodeBand) || ($0 as? CodeBand)?.shown == true }
    #expect(floating.isEmpty, "\(floating.map { String(describing: type(of: $0)) })")
  }

  /// the caret put into a formula's command name by a click keeps the preview (her second click hid it behind a list
  /// that did not show); typing a command opens the list in its place, Esc brings the preview back
  @Test func aCaretPutIntoACommandKeepsThePreview() throws {
    _ = NSApplication.shared
    let demo = try Demo(text: sample, folder: sampleFolder(), cardWidth: 420)
    demo.setUp()
    _ = Check.lay(demo, width: 1000)
    Self.kept.append(demo)
    let e = demo.cards[0]
    e.isEditing = true
    let src = e.core.source as NSString
    let name = src.range(of: "operatorname")
    e.selection = MDSelection(name.location + 3)
    #expect(!e.hints.shown)
    let bs = src.range(of: "\\sqrt")
    e.selection = MDSelection(bs.location + 1)
    e.insertText("s", replacementRange: NSRange(location: NSNotFound, length: 0))
    #expect(e.hints.shown)
    e.doCommand(by: #selector(NSResponder.cancelOperation(_:)))
    #expect(!e.hints.shown)
  }

  /// a card's right edge dragged from narrow to wide: the card is laid out again at every step, at the width the drag
  /// gives (both edges move), and the numbers of the drag are kept for the HUD
  @Test func aCardsEdgeDragRelaysItOut() throws {
    _ = NSApplication.shared
    let demo = try Demo(text: sample, folder: sampleFolder(), cardWidth: 420)
    demo.secondText = secondSample
    demo.setUp()
    _ = Check.lay(demo, width: 1400)
    Self.kept.append(demo)
    let w = demo.window!
    w.alphaValue = 0.02
    w.ignoresMouseEvents = true
    w.setFrameOrigin(CGPoint(x: -30000, y: -30000))
    w.orderFrontRegardless()
    defer { w.orderOut(nil) }
    let r = demo.page.cardRects[0]
    let p = CGPoint(x: r.maxX - 2, y: r.midY)
    #expect(demo.edgeDown(p))
    for k in stride(from: -80.0, through: 400, by: 4) {
      demo.edgeDragged(CGPoint(x: p.x + k / 2, y: p.y))
    }
    demo.edgeUp()
    #expect(abs(demo.sheets[0].width - 820) < 0.5)
    #expect(abs(demo.cards[0].core.layout.width - (820 - 28)) < 1)
    #expect(demo.dragStats?.frames == 121)
    #expect(demo.widthLine != nil)
  }

  /// a card holding a heavy figure (an SVG of many labels) dragged wider step by step: the figure is never drawn again
  /// on the main thread during the drag (it was, at every step), and only a few times off it
  @Test func aWidthDragDrawsNoFigureOnTheMainThread() throws {
    _ = NSApplication.shared
    let folder = FileManager.default.temporaryDirectory.appending(path: "figure-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: folder) }
    var svg = "<svg xmlns='http://www.w3.org/2000/svg' width='800' height='500' viewBox='0 0 800 500'>"
    for r in 0..<10 {
      for c in 0..<8 {
        svg += "<rect x='\(c * 100)' y='\(r * 50)' width='100' height='50' fill='none' stroke='black'/>"
        svg += "<text x='\(c * 100 + 8)' y='\(r * 50 + 30)' font-size='14'>M[\(r)][\(c)], M[\(c)][\(r)]</text>"
      }
    }
    try Data((svg + "</svg>").utf8).write(to: folder.appending(path: "fig.svg"))
    let demo = try Demo(text: "Before.\n\n![a figure](fig.svg)\n\nAfter.", folder: folder, cardWidth: 420)
    demo.setUp()
    _ = Check.lay(demo, width: 1400)
    Self.kept.append(demo)
    let w = demo.window!
    w.alphaValue = 0.02
    w.ignoresMouseEvents = true
    w.setFrameOrigin(CGPoint(x: -30000, y: -30000))
    w.orderFrontRegardless()
    defer { w.orderOut(nil) }
    func draw() {
      let e = demo.cards[0]
      let rep = e.bitmapImageRepForCachingDisplay(in: e.bounds)!
      e.cacheDisplay(in: e.bounds, to: rep)
    }
    draw()
    let first = demo.svgDraws
    #expect(first.sync == 1)
    let r = demo.page.cardRects[0]
    let p = CGPoint(x: r.maxX - 2, y: r.midY)
    #expect(demo.edgeDown(p))
    for k in stride(from: 4.0, through: 120, by: 4) {
      demo.edgeDragged(CGPoint(x: p.x + k, y: p.y))
      draw()
    }
    demo.edgeUp()
    #expect(demo.svgDraws.sync == first.sync)
    #expect(demo.svgDraws.background - first.background <= 4)
  }

  /// a formula in an image's caption is drawn (its room was left blank): more ink with it than without it
  @Test func aFormulaInACaptionIsDrawn() throws {
    _ = NSApplication.shared
    func ink(_ caption: String) throws -> Int {
      let demo = try Demo(
        text: "![a picture](picture.png \"\(caption)\")", folder: sampleFolder(), cardWidth: 420)
      demo.setUp()
      Self.kept.append(demo)
      let l = demo.cards[0].core.layout
      let f = l.images[0].frame
      let band = CGRect(x: 0, y: f.maxY, width: l.width, height: l.size.height - f.maxY)
      let ctx = CGContext(
        data: nil, width: Int(band.width * 2), height: Int(band.height * 2), bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
      ctx.scaleBy(x: 2, y: -2)
      ctx.translateBy(x: 0, y: -band.maxY)
      l.draw(in: ctx, scale: 2, clip: band) { _ in nil }
      let rep = NSBitmapImageRep(cgImage: ctx.makeImage()!)
      var n = 0
      for y in 0..<rep.pixelsHigh {
        for x in 0..<rep.pixelsWide where (rep.colorAt(x: x, y: y)?.alphaComponent ?? 0) > 0.5 { n += 1 }
      }
      return n
    }
    #expect(try ink("Figure 1: the tiles of $M$ loaded") > ink("Figure 1: the tiles of loaded") + 20)
  }
}
