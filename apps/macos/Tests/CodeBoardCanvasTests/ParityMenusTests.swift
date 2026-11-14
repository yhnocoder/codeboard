import AppKit
import CodeBoardModel
import Testing

@testable import CodeBoardCanvas

// The web board's context menus (packages/board/src/actions/menus.ts and the files apps/macos/review/
// parity-keys-menus.md names) on the real canvas: each menu's items in order with its separators, their keys, which are
// off, and what some of them do.

private func gid(_ s: String) -> SectionID { SectionID(rawValue: s) }

private func menusBoard() -> Board {
  let seg = Segment(
    id: SegmentID(rawValue: "s1"), source: nil, language: "python", firstLine: 1,
    lines: ["def step(batch):", "", "    return run(batch)"])
  func note(_ id: String, x: Double, y: Double, section: String? = nil) -> Card {
    Card(
      id: cid(id), x: x, y: y, width: 240, height: 160, section: section.map(gid),
      content: .own(CardContent(body: .note(Note(text: "# \(id)\n\nA few words.")))))
  }
  return Board(
    id: BoardID(rawValue: "menus"),
    cards: [
      note("n1", x: 0, y: 0), note("n2", x: 100, y: 60),
      Card(
        id: cid("c1"), x: 500, y: 0, width: 320,
        content: .own(CardContent(title: "Step", body: .code(CodeCard(segments: [seg]))))),
      Card(
        id: cid("w1"), x: 1000, y: 0, width: 420,
        content: .own(
          CardContent(
            body: .web(WebCard(url: "https://www.example.org/one", meta: WebMeta(title: "One", fetchedAt: 1)))))),
      Card(
        id: cid("l1"), x: 1000, y: 300, width: 380,
        content: .own(
          CardContent(
            body: .links(
              LinkList(items: [
                LinkList.Item(id: "r1", url: "https://a.org/one", meta: WebMeta(title: "One", fetchedAt: 1))
              ]))))),
      Card(
        id: cid("b1"), x: 1500, y: 0, width: 300, height: 200,
        content: .own(CardContent(body: .board(SubBoard(board: BoardID(rawValue: "elsewhere")))))),
      note("m1", x: 40, y: 480, section: "g1"), note("m2", x: 700, y: 520, section: "g2"),
    ],
    arrows: [Arrow(id: ArrowID(rawValue: "a1"), from: Endpoint(card: cid("n1")), to: Endpoint(card: cid("c1")))],
    sections: [
      Section(id: gid("g1"), title: "Outer", x: 0, y: 420, width: 1200, height: 500),
      Section(id: gid("g2"), title: "Inner", x: 660, y: 460, width: 400, height: 300, parent: gid("g1")),
    ])
}

private func titles(_ m: NSMenu?) -> [String] { m?.items.map { $0.isSeparatorItem ? "-" : $0.title } ?? [] }

@MainActor private func item(_ m: NSMenu?, _ path: String...) -> NSMenuItem? {
  var menu = m
  var found: NSMenuItem?
  for t in path {
    found = menu?.items.first { $0.title == t }
    menu = found?.submenu
  }
  return found
}

/// Whether an item would be on when the menu opens (its own action off, or its target's validation)
@MainActor private func enabled(_ i: NSMenuItem?) -> Bool {
  guard let i, let a = i.action else { return false }
  if let v = i.target as? NSMenuItemValidation { return v.validateMenuItem(i) }
  return (i.target as AnyObject?)?.responds(to: a) == true
}

@MainActor private func fire(_ i: NSMenuItem?) {
  guard let i else {
    Issue.record("no item")
    return
  }
  if let a = i.representedObject as? MenuAction { a.run() } else { NSApp.sendAction(i.action!, to: i.target, from: i) }
}

@MainActor @Suite(.serialized) struct ParityMenusTests {
  func menu(_ r: Rig, at p: CGPoint) -> NSMenu? { r.canvas.menu(for: r.mouse(.rightMouseDown, p)) }

  /// A Note's (cardItems + kindItems): Add Sidenote, the tail; Arrange ▸ with its four orders, Tilt and Lock
  @Test func aNotesMenuIsAddSidenoteThenArrangeCopyPathAndDelete() async throws {
    let r = try await Rig(menusBoard(), zoom: 1)
    defer { r.close() }
    let m = menu(r, at: CGPoint(x: 20, y: 20))
    #expect(titles(m) == ["Add Sidenote", "-", "Arrange", "Copy Path", "-", "Delete"])
    #expect(
      titles(item(m, "Arrange")?.submenu) == [
        "Bring to Front", "Bring Forward", "Send Backward", "Send to Back", "-", "Tilt", "Lock",
      ])
    // n1 is at the back: Backward and Back are off, Front and Forward on
    #expect(enabled(item(m, "Arrange", "Bring to Front")) && enabled(item(m, "Arrange", "Bring Forward")))
    #expect(!enabled(item(m, "Arrange", "Send Backward")) && !enabled(item(m, "Arrange", "Send to Back")))
    let keys = [
      ("Bring to Front", "f", NSEvent.ModifierFlags([.command, .option, .shift])),
      ("Send to Back", "b", [.command, .option, .shift]),
      ("Tilt", "t", [.option, .shift]), ("Lock", "l", [.command, .shift]),
    ]
    for (t, k, mask) in keys {
      let i = item(m, "Arrange", t)
      #expect(i?.keyEquivalent == k && i?.keyEquivalentModifierMask == mask, "\(t)")
    }
    #expect(item(m, "Delete")?.keyEquivalent == "\u{8}")
    // Bring Forward: past the next card it overlaps, n2 (core arrangeCards forward)
    fire(item(m, "Arrange", "Bring Forward"))
    #expect(r.doc.board.cards.prefix(2).map(\.id) == [cid("n2"), cid("n1")])
  }

  /// Copy Path: the board's file and the card's id, one per line (host paths.ts itemPaths)
  @Test func copyPathCopiesTheBoardFileAndTheCardsId() async throws {
    let r = try await Rig(menusBoard(), zoom: 1)
    defer { r.close() }
    fire(item(menu(r, at: CGPoint(x: 20, y: 20)), "Copy Path"))
    #expect(r.canvas.pasteboard.string(forType: .string) == "\(r.file.path(percentEncoded: false))#n1")
    #expect(r.canvas.toastText == "Copied path")
    r.doc.select([.card(cid("n1")), .card(cid("c1"))])
    fire(item(menu(r, at: CGPoint(x: 20, y: 20)), "Copy Paths"))
    let file = r.file.path(percentEncoded: false)
    #expect(r.canvas.pasteboard.string(forType: .string) == "\(file)#n1\n\(file)#c1")
    #expect(r.canvas.toastText == "Copied 2 paths")
  }

  /// A Web card's, a Link List's and a code card's own items go straight before the tail
  @Test func eachKindsOwnItemsComeBeforeArrange() async throws {
    let r = try await Rig(menusBoard(), zoom: 1)
    defer { r.close() }
    #expect(
      titles(menu(r, at: r.centre("w1"))) == [
        "Add Sidenote", "-", "Open in Browser", "Refresh Preview", "View", "Edit Title", "Edit Description", "Arrange",
        "Copy Path", "-", "Delete",
      ])
    #expect(
      titles(menu(r, at: r.centre("l1"))) == [
        "Add Sidenote", "-", "Open All in Browser", "View", "Rename", "Arrange", "Copy Path", "-", "Delete",
      ])
    let code = menu(r, at: r.centre("c1"))
    #expect(titles(code) == ["Add Sidenote", "-", "View", "Arrange", "Copy Path", "-", "Delete"])
    #expect(
      titles(item(code, "View")?.submenu) == [
        "Hide Blank Lines", "Hide Comments", "Hide Docstrings", "Show All Hidden Lines", "-", "Background",
      ])
    #expect(item(code, "View", "Background")?.state == .on)
    #expect(!enabled(item(code, "View", "Show All Hidden Lines")))
    fire(item(code, "View", "Hide Blank Lines"))
    guard case .own(let c)? = r.doc.board.card(cid("c1"))?.content, case .code(let k) = c.body else {
      Issue.record("no code card")
      return
    }
    #expect(k.hide.blankLines)
  }

  /// A sub-board card's: Open, then Arrange and Copy Path, then Remove from This Board (the board stays)
  @Test func aSubBoardCardsMenuOpensAndRemovesFromThisBoard() async throws {
    let r = try await Rig(menusBoard(), zoom: 1)
    defer { r.close() }
    let m = menu(r, at: r.centre("b1"))
    #expect(
      titles(m) == ["Add Sidenote", "-", "Open", "-", "Arrange", "Copy Path", "-", "Remove from This Board"])
    #expect(item(m, "Open")?.keyEquivalent == "\r" && item(m, "Open")?.keyEquivalentModifierMask == .command)
  }

  /// Several cards (multiItems), in main's order
  @Test func severalCardsMenuIsMainsOrder() async throws {
    let r = try await Rig(menusBoard(), zoom: 1)
    defer { r.close() }
    r.doc.select([.card(cid("n1")), .card(cid("n2"))])
    let m = menu(r, at: CGPoint(x: 20, y: 20))
    #expect(
      titles(m) == [
        "Connect with Arrow", "Move to Section", "Move to New Section", "Move to Shelf", "Turn into Board…", "Lock",
        "Tilt", "Arrange", "Copy Paths", "-", "Cut", "Copy", "Duplicate", "Delete",
      ])
    #expect(titles(item(m, "Move to Section")?.submenu) == ["Outer", "Outer › Inner"])
    #expect(item(m, "Turn into Board…")?.keyEquivalent == "b")
    fire(item(m, "Move to Section", "Outer › Inner"))
    #expect(r.doc.board.card(cid("n1"))?.section == gid("g2") && r.doc.board.card(cid("n2"))?.section == gid("g2"))
  }

  /// A Section's: its row of Fit Content, Color and Lock, then Add Sidenote, Collapse, Move Out of Parent Section,
  /// Copy Path, then Remove Section; Collapse folds it
  @Test func aSectionsMenuIsMainsOrder() async throws {
    let r = try await Rig(menusBoard(), zoom: 1)
    defer { r.close() }
    let rect = try #require(r.canvas.sectionTitle(gid("g2")))
    let title = CGPoint(x: rect.midX, y: rect.midY)
    r.doc.select([.section(gid("g2"))])
    let m = menu(r, at: title)
    #expect(
      titles(m) == [
        "Fit Content", "Color", "Lock", "-", "Add Sidenote", "Collapse", "Move Out of Parent Section", "Copy Path", "-",
        "Remove Section",
      ])
    fire(item(m, "Collapse"))
    #expect(r.doc.board.section(gid("g2"))?.collapsed == true)
    r.doc.select([.section(gid("g1")), .section(gid("g2"))])
    #expect(
      titles(menu(r, at: title)) == [
        "Fit Content", "Lock", "Color", "Copy Paths", "-", "Move to Shelf", "Remove 2 Sections",
      ])
  }

  /// The board's own (canvasMenu): New Text, New Note, Add Sidenote, Paste, Insert Board ▸, then Select All and Fit to
  /// Window; New Note puts a Note where it was asked
  @Test func theBoardsMenuIsMainsOrder() async throws {
    let r = try await Rig(menusBoard(), zoom: 1)
    defer { r.close() }
    let at = CGPoint(x: 600, y: 1100)
    let m = menu(r, at: at)
    #expect(
      titles(m) == [
        "New Text", "New Note", "Add Sidenote", "Paste", "Insert Board", "-", "Select All", "Fit to Window",
      ])
    #expect(titles(item(m, "Insert Board")?.submenu) == ["No other boards yet"])
    #expect(!enabled(item(m, "Insert Board", "No other boards yet")))
    let before = Set(r.doc.board.cards.map(\.id))
    fire(item(m, "New Note"))
    await r.until("the new card") { r.doc.board.cards.count > before.count }
    let made = r.doc.board.cards.first { !before.contains($0.id) }
    #expect(made.map { CGPoint(x: $0.x, y: $0.y) } == at)
    await r.editorReady()
    await r.canvas.endEditing()
  }

  /// The toolbar's ⋯ (Chrome.tsx more): after the tools and a separator; Undo, Redo, Copy Path (the board's file),
  /// Settings…, Theme ▸ (the app's items answer those)
  @Test func theToolbarsMoreMenu() async throws {
    let bar = CanvasToolbar()
    var asked: CGRect?
    bar.onMore = { asked = $0 }
    let more = bar.extraRects().more
    #expect(bar.button(at: CGPoint(x: more.midX, y: more.midY)) == -3)
    #expect(more.minX > (bar.buttonRects().last?.maxX ?? .infinity) && more.maxX < bar.barRect.maxX)
    _ = asked
    let r = try await Rig(menusBoard(), zoom: 1)
    defer { r.close() }
    let m = r.canvas.moreMenu()
    #expect(
      titles(m) == ["Undo", "Redo", "-", "Rename Board…", "Copy Path", "Edit Mark…", "-", "Settings…", "Theme"])
    #expect(item(m, "Rename Board…")?.action == Selector(("renameBoard:")))
    #expect(item(m, "Edit Mark…")?.action == Selector(("editMark:")))
    #expect(titles(item(m, "Theme")?.submenu) == Theme.all.map(\.name))
    #expect(item(m, "Redo")?.keyEquivalent == "z" && item(m, "Redo")?.keyEquivalentModifierMask == [.command, .shift])
    fire(item(m, "Copy Path"))
    #expect(r.canvas.pasteboard.string(forType: .string) == r.file.path(percentEncoded: false))
  }

  /// Warm Ink's bar is a squircle of 14 (.pill, the board's --corner), its blur too: not a capsule; Ink Wash's blur is
  /// inside its stroke (--ink-bar-mask), whose tail and rounded start are left clear
  @Test func theToolbarsGlassIsItsSquircleOrItsStroke() throws {
    let bar = CanvasToolbar(frame: CGRect(x: 0, y: 0, width: 600, height: 120))
    bar.layout()
    #expect(bar.glass.maskImage?.size == bar.barRect.size && !bar.glass.isHidden)
    bar.theme = .inkWash
    bar.layout()
    let mask = try #require(bar.glass.maskImage)
    #expect(mask.size == bar.barRect.size && !bar.glass.isHidden)
    var r = CGRect(origin: .zero, size: mask.size)
    let img = try #require(mask.cgImage(forProposedRect: &r, context: nil, hints: nil))
    let rep = NSBitmapImageRep(cgImage: img)
    func alpha(_ x: CGFloat, _ y: CGFloat) -> CGFloat {
      let k = CGFloat(rep.pixelsWide) / mask.size.width
      return rep.colorAt(x: Int(x * k), y: Int(y * k))?.alphaComponent ?? -1
    }
    let w = mask.size.width
    #expect(alpha(w / 2, 23) == 1, "the stroke's middle is blurred")
    #expect(alpha(w / 2, 2) == 0 && alpha(w / 2, 44) == 0, "above and below the stroke is not")
    #expect(alpha(1, 23) == 0 && alpha(w - 1, 23) == 0, "nor before its start and after its tail")
  }
}
