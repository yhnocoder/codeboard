import AppKit
import CodeBoardModel
import CodeBoardTestGuard
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers

@testable import CodeBoardCanvas
@testable import CodeBoardShell

// The bottom toolbar's Code and Image in the whole window (Chrome.tsx tools), clicked through the window as a person
// does. Each is one button here: main's menus behind them have one item each in the app. The picture file New Image
// asks for is the test's, in its own folder: no open panel is made in the test process. And the buttons' tips
// (Menu.tsx TooltipLayer), on the test's own clock.

@MainActor @Suite(.serialized) struct FullWindowToolbarTests {
  let edit = FullWindowEditTests()

  func toolbar(_ w: FullWindowEditTests.Window) throws -> CanvasToolbar {
    let pane = try #require(w.pane.flatMap { $0.superview })
    return try #require(pane.subviews.compactMap { $0 as? CanvasToolbar }.first)
  }

  /// A click on the tool's button where the window would hand it
  func click(_ tool: Tool, in w: FullWindowEditTests.Window) throws {
    let bar = try toolbar(w)
    let r = try #require(bar.rect(of: tool))
    let at = bar.convert(CGPoint(x: r.midX, y: r.midY), to: nil)
    let frame = try #require(w.window.contentView?.superview)
    let hit = try #require(frame.hitTest(frame.convert(at, from: nil)))
    #expect(hit === bar, "the button is the toolbar's: \(hit)")
    for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
      let e = NSEvent.mouseEvent(
        with: type, location: at, modifierFlags: [], timestamp: 0, windowNumber: w.window.windowNumber, context: nil,
        eventNumber: 0, clickCount: 1, pressure: 1)!
      if type == .leftMouseDown { hit.mouseDown(with: e) } else { hit.mouseUp(with: e) }
    }
  }

  @Test func codeAndImageSitAfterBoxInMainsOrder() async throws {
    let w = try await edit.opened()
    defer { w.close() }
    #expect(try toolbar(w).tools == [.note, .text, .box, .code, .image, .web, .section, .arrow, .sticker])
  }

  /// Code (create.ts newFreeCode with no point): a Free code card half a Note's width left of the view's middle and 60
  /// above it, its code written at once; left empty it goes
  @Test func codeMakesFreeCodeInTheViewsMiddle() async throws {
    let w = try await edit.opened()
    defer { w.close() }
    let c = w.canvas
    let v = c.camera.visible(c.bounds.size)
    try click(.code, in: w)
    await edit.until("its code written", in: w) { c.editing?.code == true && c.editing?.ready == true }
    let id = try #require(c.editing?.id)
    let card = try #require(c.document?.board.card(id))
    #expect(c.document?.board.isFreeCode(id) == true && c.editing?.fresh == true)
    #expect(card.x == (v.midX - Board.newNoteWidth / 2).rounded() && card.y == (v.midY - 60).rounded())
    #expect(card.width == Board.newNoteWidth)
    await c.endEditing()
    #expect(c.document?.board.card(id) == nil, "left empty, it goes")
  }

  /// Image (create.ts newImage, addImage; host handlers.ts pickImage): the file asked for on this window, kept in the
  /// board's images, a card as wide as the picture shows (a PNG at 144 dpi: half its pixels), selected, one step; a file
  /// that is no picture says so
  @Test func imageAddsTheChosenPicture() async throws {
    let w = try await edit.opened()
    defer { w.close() }
    let c = w.canvas
    let folder = FileManager.default.temporaryDirectory.appending(path: "pick-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: folder) }
    let png = folder.appending(path: "wide.png")
    let ctx = try #require(
      CGContext(
        data: nil, width: 400, height: 100, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
    ctx.setFillColor(CGColor(red: 0.2, green: 0.4, blue: 0.8, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: 400, height: 100))
    let dest = try #require(CGImageDestinationCreateWithURL(png as CFURL, UTType.png.identifier as CFString, 1, nil))
    CGImageDestinationAddImage(
      dest, try #require(ctx.makeImage()),
      [kCGImagePropertyDPIWidth: 144, kCGImagePropertyDPIHeight: 144] as CFDictionary)
    #expect(CGImageDestinationFinalize(dest))
    var answer = png
    var asked: [NSWindow] = []
    c.pickImage = { window in
      asked.append(window)
      return answer
    }
    let before = Set(c.document?.board.cards.map(\.id) ?? [])
    func added() -> Card? { c.document?.board.cards.first { !before.contains($0.id) } }
    try click(.image, in: w)
    await edit.until("the picture on the board", in: w) { added() != nil }
    #expect(asked.count == 1 && asked.first === w.window)
    let card = try #require(added())
    guard case .own(let k) = card.content, case .image(let img) = k.body, case .file(let name) = img.source else {
      Issue.record("not an image card: \(card.content)")
      return
    }
    #expect(card.width == 200, "400 pixels at 144 dpi show 200 wide")
    let (board, vault) = try #require(c.shown)
    let kept = vault.url(of: board.path).appending(path: "\(Vault.imagesFolder)/\(name)")
    #expect(FileManager.default.fileExists(atPath: kept.path(percentEncoded: false)))
    #expect(c.document?.selection == [.card(card.id)])
    #expect(c.document?.history.undoSteps.last?.name == "New Image")
    // a file that is no picture
    answer = folder.appending(path: "notes.txt")
    try Data("hello".utf8).write(to: answer)
    let cards = c.document?.board.cards.count
    try click(.image, in: w)
    await edit.until("said", in: w) { c.toastText == "notes.txt is not a PNG, JPEG, WebP, GIF or SVG image." }
    #expect(c.document?.board.cards.count == cards)
  }

  /// The pointer moved to `p` in `view`, as its tracking area hands it the move
  func move(_ view: NSView, to p: CGPoint, in w: FullWindowEditTests.Window) throws {
    let at = view.convert(p, to: nil)
    let e = NSEvent.mouseEvent(
      with: .mouseMoved, location: at, modifierFlags: [], timestamp: 0, windowNumber: w.window.windowNumber,
      context: nil, eventNumber: 0, clickCount: 0, pressure: 0)!
    view.mouseMoved(with: e)
  }

  /// A button's tip (Menu.tsx TooltipLayer): after TIP_DELAY resting on it, over it with its key; another button's at
  /// once while one shows and for TIP_WARM after it goes; a press hides it and the next waits again
  @Test func aButtonsTipShowsAfterItsDelayWithItsKey() async throws {
    let w = try await edit.opened()
    defer { w.close() }
    let tips = Tips.shared
    let (after, now) = (tips.after, tips.now)
    var pending: [(TimeInterval, @MainActor () -> Void)] = []
    var t: TimeInterval = 1000
    tips.after = { pending.append(($0, $1)) }
    tips.now = { t }
    defer {
      tips.press()
      tips.after = after
      tips.now = now
    }
    tips.press()
    let bar = try toolbar(w)
    func over(_ tool: Tool) throws {
      let r = try #require(bar.rect(of: tool))
      try move(bar, to: CGPoint(x: r.midX, y: r.midY), in: w)
    }
    func tipView() -> TipView? { w.window.contentView?.subviews.compactMap { $0 as? TipView }.first }
    try over(.note)
    #expect(tips.shown == nil && pending.map(\.0) == [0.5], "it waits TIP_DELAY")
    pending.removeFirst().1()
    #expect(tips.shown?.tip == Tip("New Note", kbd: "N"))
    // over the button, 8 above it
    let tv = try #require(tipView())
    let note = try #require(bar.rect(of: .note))
    let button = bar.convert(note, to: nil)
    let shownAt = tv.convert(tv.bounds, to: nil)
    #expect(abs(shownAt.minY - (button.maxY + 8)) <= 1 && abs(shownAt.midX - button.midX) <= 1, "\(shownAt) \(button)")
    #expect(tv.layer?.opacity == 1)
    try over(.text)
    #expect(tips.shown?.tip == Tip("New Text", kbd: "T") && pending.isEmpty, "the next at once")
    try over(.code)
    #expect(tips.shown?.tip == Tip("New Code"))
    try over(.image)
    #expect(tips.shown?.tip == Tip("New Image"))
    try over(.arrow)
    #expect(tips.shown?.tip == Tip("Select two cards, or pick a card then click another"))
    let exited = try #require(
      NSEvent.otherEvent(
        with: .applicationDefined, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil,
        subtype: 0, data1: 0, data2: 0))
    bar.mouseExited(with: exited)
    #expect(tips.shown == nil && tv.layer?.opacity == 0)
    t += 0.5
    try over(.section)
    #expect(tips.shown?.tip == Tip("Draw a Section") && pending.isEmpty, "within TIP_WARM, at once")
    bar.mouseExited(with: exited)
    t += 1
    try over(.sticker)
    #expect(tips.shown == nil && pending.count == 1, "past TIP_WARM it waits again")
    pending.removeFirst().1()
    #expect(tips.shown?.tip == Tip("Add a Sticker"))
    // a press hides it, and the next waits its full delay
    let r = try #require(bar.rect(of: .sticker))
    let down = NSEvent.mouseEvent(
      with: .leftMouseDown, location: bar.convert(CGPoint(x: r.midX, y: r.midY), to: nil), modifierFlags: [],
      timestamp: 0, windowNumber: w.window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
    bar.mouseDown(with: down)
    // let go off every button: nothing is used
    bar.mouseUp(
      with: NSEvent.mouseEvent(
        with: .leftMouseUp, location: bar.convert(CGPoint(x: 1, y: 1), to: nil), modifierFlags: [], timestamp: 0,
        windowNumber: w.window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 0)!)
    #expect(tips.shown == nil)
    let dock = w.canvas.dock
    let zoomIn = try #require(dock.layoutParts().parts[.zoomIn])
    try move(dock, to: CGPoint(x: zoomIn.midX, y: zoomIn.midY), in: w)
    #expect(tips.shown == nil && pending.count == 1)
    pending.removeFirst().1()
    #expect(tips.shown?.tip == Tip("Zoom In", kbd: "⌘+"))
  }

  /// Web (create.ts newWeb): its address asked in a sheet on the window as main's promptText asks it (Add Web Link,
  /// https://…, Add / Cancel); https:// put before one without; a Web card where a pasted one goes, its page read
  @Test func webAsksForTheAddressInASheetAndAddsItsCard() async throws {
    let w = try await edit.opened()
    defer { w.close() }
    let c = w.canvas
    var read: [URL] = []
    c.fetchPage = { u in
      await MainActor.run { read.append(u) }
      return WebPage(title: "A page", description: "", site: "")
    }
    func answer(_ text: String?, _ button: String) async throws {
      try click(.web, in: w)
      await edit.until("asked", in: w) { w.window.attachedSheet != nil }
      let sheet = try #require(w.window.attachedSheet)
      let content = try #require(sheet.contentView)
      func all(_ v: NSView) -> [NSView] { [v] + v.subviews.flatMap(all) }
      let labels = all(content).compactMap { $0 as? NSTextField }
      #expect(labels.contains { $0.stringValue == "Add Web Link" })
      let field = try #require(labels.first { $0.isEditable })
      #expect(field.placeholderString == "https://…")
      if let text { field.stringValue = text }
      let buttons = all(content).compactMap { $0 as? NSButton }
      #expect(Set(buttons.map(\.title)).isSuperset(of: ["Add", "Cancel"]))
      // Return answers Add (its key equivalent reads empty while the test's window is not key)
      #expect(sheet.defaultButtonCell === buttons.first { $0.title == "Add" }?.cell)
      let b = try #require(buttons.first { $0.title == button })
      b.sendAction(b.action, to: b.target)
      await edit.until("answered", in: w) { w.window.attachedSheet == nil }
    }
    let before = c.document?.board.cards.count ?? 0
    try await answer("example.com/a", "Cancel")
    #expect(c.document?.board.cards.count == before, "cancelled: nothing")
    try await answer("   ", "Add")
    #expect(c.document?.board.cards.count == before, "blank: nothing")
    try await answer(" example.com/a ", "Add")
    await edit.until("the card", in: w) { c.document?.board.cards.count == before + 1 }
    let card = try #require(c.document?.board.cards.last)
    guard case .own(let k) = card.content, case .web(let web) = k.body else {
      Issue.record("not a Web card: \(card.content)")
      return
    }
    #expect(web.url == "https://example.com/a")
    #expect(c.document?.selection == [.card(card.id)] && c.document?.history.undoSteps.last?.name == "New Web Card")
    await edit.until("its page read", in: w) { read == [URL(string: "https://example.com/a")!] }
    // its page is read for the card, never opened in the browser
    #expect(TestGuard.guardsOpening)
    #expect(!TestGuard.shown.contains { $0.hasPrefix("open: ") && $0.contains("example.com") }, "\(TestGuard.shown)")
  }
}
