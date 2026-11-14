import AppKit
import CodeBoardModel
import Testing

@testable import CodeBoardCanvas

// Every context menu the canvas builds, walked into every submenu: each item has a title (a person and VoiceOver read
// it), and an item is off only where main's menu has it off in the same state (`mainOff`, each with main's line).

private func walkBoard() -> Board {
  let free = Segment(
    id: SegmentID(rawValue: "s1"), source: nil, language: "python", firstLine: 1,
    lines: ["def step(batch):", "    return run(batch)"])
  let read = Segment(
    id: SegmentID(rawValue: "s2"), source: .file(path: "a.py", hash: nil), language: "python", firstLine: 10,
    lines: ["x = 1", "y = 2"])
  func own(_ body: CardContent.Body, title: String? = nil) -> Card.Content {
    .own(CardContent(title: title, body: body))
  }
  return Board(
    id: BoardID(rawValue: "walk"),
    cards: [
      Card(id: cid("note"), x: 0, y: 0, width: 240, height: 160, content: own(.note(Note(text: "# Plan\n\nwords")))),
      Card(id: cid("text"), x: 300, y: 0, width: 200, content: own(.text(TextCard(text: "Threads", wrap: true)))),
      Card(
        id: cid("box"), x: 300, y: 200, width: 200,
        content: own(.text(TextCard(text: "Bounds", look: .box, wrap: true)))),
      Card(id: cid("free"), x: 600, y: 0, width: 320, content: own(.code(CodeCard(segments: [free])), title: "Free")),
      Card(id: cid("code"), x: 600, y: 300, width: 320, content: own(.code(CodeCard(segments: [read])), title: "Read")),
      Card(id: cid("image"), x: 1000, y: 0, width: 200, content: own(.image(ImageCard(source: .file("p.png"))))),
      Card(
        id: cid("web"), x: 1300, y: 0, width: 420,
        content: own(.web(WebCard(url: "https://www.example.org/one", meta: WebMeta(title: "One", fetchedAt: 1))))),
      Card(
        id: cid("links"), x: 1300, y: 400, width: 380,
        content: own(
          .links(
            LinkList(items: [
              LinkList.Item(id: "r1", url: "https://a.org/one", meta: WebMeta(title: "One", fetchedAt: 1))
            ])))),
      Card(
        id: cid("sub"), x: 1800, y: 0, width: 300, height: 200,
        content: own(.board(SubBoard(board: BoardID(rawValue: "elsewhere"))))),
      Card(
        id: cid("in"), x: 40, y: 480, width: 240, height: 120, section: SectionID(rawValue: "g"),
        content: own(.note(Note(text: "inside")))),
    ],
    arrows: [
      Arrow(
        id: ArrowID(rawValue: "a"), from: Endpoint(card: cid("note")), to: Endpoint(card: cid("text")), label: "calls")
    ],
    sections: [Section(id: SectionID(rawValue: "g"), title: "Group", x: 0, y: 400, width: 600, height: 300)],
    sidenotes: [
      Sidenote(id: SidenoteID(rawValue: "sn"), anchor: .card(cid("note")), body: .text(TextNote(text: "a note")))
    ],
    stickers: [
      Sticker(id: StickerID(rawValue: "k"), glyph: .builtin(.star), anchor: .canvas(x: 300, y: 800, size: nil))
    ])
}

@MainActor @Suite(.serialized) struct MenuWalkTests {
  /// Off in main's menu in this state, with where main says so
  static let mainOff: [String: String] = [
    // the Note is the first card: already at the back (actions/edit.ts:181-182 atEdge)
    "note › Arrange › Send Backward": "edit.ts:181", "note › Arrange › Send to Back": "edit.ts:182",
    "several › Arrange › Send Backward": "edit.ts:181", "several › Arrange › Send to Back": "edit.ts:182",
    // no line hidden (menus.ts:453)
    "free › View › Show All Hidden Lines": "menus.ts:453", "code › View › Show All Hidden Lines": "menus.ts:453",
    "canvas › Insert Board › No other boards yet": "menus.ts:661",
    // neither end has a side of its own (menus.ts:805); the label is in the middle (menus.ts:881)
    "arrow › Reset Sides": "menus.ts:805", "label › Reset Label Position": "menus.ts:881",
    // nothing done yet (Chrome.tsx:183-184)
    "more › Undo": "Chrome.tsx:183", "more › Redo": "Chrome.tsx:184",
  ]

  /// Sent up the responder chain to the app, which answers them for an open board of its own
  /// (CodeBoardShellTests ParityMenuKeysTests theAppAnswersTheToolbarsMoreMenu)
  static let app: Set<Selector> = [
    Selector(("renameBoard:")), Selector(("editMark:")), Selector(("showSettings:")), Selector(("chooseTheme:")),
  ]

  /// Whether an item would be on when the menu opens (its own action, or its target's validation; the app's own
  /// items are on)
  func enabled(_ i: NSMenuItem) -> Bool {
    guard let a = i.action else { return false }
    if i.target == nil { return Self.app.contains(a) }
    if let v = i.target as? NSMenuItemValidation { return v.validateMenuItem(i) }
    return (i.target as AnyObject?)?.responds(to: a) == true
  }

  /// Every item, as "menu › item › subitem", with whether it has a title and is on
  func walk(_ m: NSMenu, _ path: String, into out: inout [(path: String, titled: Bool, on: Bool)]) {
    for i in m.items where !i.isSeparatorItem && !i.isHidden {
      let p = "\(path) › \(i.title)"
      if let s = i.submenu {
        out.append((p, !i.title.isEmpty, true))
        walk(s, p, into: &out)
      } else {
        out.append((p, !i.title.isEmpty && (i.view == nil || i.view?.accessibilityLabel() != nil), enabled(i)))
      }
    }
  }

  @Test func everyContextMenuItemHasATitleAndIsOffOnlyWhereMainsIs() async throws {
    let r = try await Rig(walkBoard(), zoom: 0.5)
    defer { r.close() }
    let c = r.canvas
    await r.settle()
    var menus: [(String, NSMenu)] = []
    func at(_ name: String, _ p: CGPoint) {
      if let m = c.menu(for: r.mouse(.rightMouseDown, p)) {
        menus.append((name, m))
      } else {
        Issue.record("\(name): none")
      }
    }
    for id in ["note", "text", "box", "free", "code", "image", "web", "sub"] {
      let rect = r.rect(id)
      at(id, CGPoint(x: rect.midX, y: rect.maxY - 12))
    }
    let title = try #require(c.scene?.items.first { $0.owner == .sectionTitle(SectionID(rawValue: "g")) }?.rect)
    at("section", CGPoint(x: title.midX, y: title.midY))
    at("canvas", CGPoint(x: 1000, y: 900))
    r.doc.select([.card(cid("note")), .card(cid("text"))])
    menus.append(("several", c.severalMenu()))
    menus.append(("sections", c.sectionsMenu([SectionID(rawValue: "g")])))
    if let m = c.arrowMenu(ArrowID(rawValue: "a")) { menus.append(("arrow", m)) }
    if let m = c.labelMenu(ArrowID(rawValue: "a")) { menus.append(("label", m)) }
    if let m = c.rowMenu(cid("links"), "r1") { menus.append(("row", m)) }
    menus.append(("sticker", c.stickerMenu(StickerID(rawValue: "k"))))
    menus.append(("sidenote", c.sidenoteMenu(SidenoteID(rawValue: "sn"))))
    menus.append(("more", c.moreMenu()))
    var items: [(path: String, titled: Bool, on: Bool)] = []
    for (name, m) in menus {
      m.update()
      walk(m, name, into: &items)
    }
    #expect(Set(menus.map(\.0)).count == 18, "every menu built: \(menus.map(\.0))")
    for i in items where !i.titled { Issue.record("no title: \(i.path)") }
    for i in items where !i.on && Self.mainOff[i.path] == nil {
      if i.path == "canvas › Paste" {
        // main's is always on: it reads the clipboard when chosen and pastes text as a Note; ours pastes only clips and
        // web addresses, so with nothing of those it is off
        withKnownIssue("Paste is off with no clip or web address on the clipboard; main pastes text as a Note") {
          Issue.record("off where main is on: \(i.path)")
        }
      } else {
        Issue.record("off where main is on: \(i.path)")
      }
    }
    // main's off items are all here and off
    for (p, line) in Self.mainOff { #expect(items.contains { $0.path == p && !$0.on }, "\(p) (main's \(line))") }
  }
}
