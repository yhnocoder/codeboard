import AppKit
import CodeBoardModel
import Testing

@testable import CodeBoardCanvas

// A card header's hover buttons and the bottom-right grip, as main's (CodeHead.tsx and NoteBody.tsx .hov, .cmenu,
// Card.tsx .grip): which each kind has and where, shown while hovered or selected in the card's own layer, faded out
// when left; a button acts on the release over it and not when let go off it, each doing main's command, undone as one.

private let seg = SegmentID(rawValue: "s1")

@MainActor @Suite(.serialized) struct CanvasHeadActsTests {
  static func board() -> Board {
    func own(_ b: CardContent.Body) -> Card.Content { .own(CardContent(body: b)) }
    let src = Segment(
      id: seg, source: .file(path: "a.py", hash: nil), language: "python", firstLine: 10,
      lines: ["def f(x):", "    y = x + 1", "    return y", ""])
    let free = Segment(id: SegmentID(rawValue: "s2"), source: nil, language: "python", firstLine: 1, lines: ["x = 1"])
    return Board(
      id: BoardID(rawValue: "head"),
      cards: [
        Card(id: cid("c"), x: 0, y: 0, width: 420, content: own(.code(CodeCard(segments: [src])))),
        Card(id: cid("f"), x: 0, y: 300, width: 420, content: own(.code(CodeCard(segments: [free])))),
        Card(
          id: cid("n"), x: 600, y: 0, width: 380, height: 300,
          content: own(.note(Note(text: "Intro\n\n## A\n\na\n\n## B\n\nb")))),
        Card(id: cid("plain"), x: 600, y: 400, width: 380, content: own(.note(Note(text: "Nothing to split")))),
        Card(
          id: cid("img"), x: 1100, y: 0, width: 200, content: own(.image(ImageCard(source: .file("p.png"))))),
        Card(id: cid("lock"), x: 1100, y: 300, width: 300, locked: true, content: own(.note(Note(text: "Locked")))),
        Card(
          id: cid("w"), x: 0, y: 700, width: 380,
          content: own(.web(WebCard(url: "https://site.test/post", meta: WebMeta(title: "Post", fetchedAt: 1))))),
        Card(
          id: cid("l"), x: 600, y: 700, width: 380,
          content: own(.links(LinkList(items: [LinkList.Item(id: "r1", url: "https://a.test/1")])))),
      ])
  }

  /// A button's middle on the board (the cards are not tilted)
  func at(_ r: Rig, _ id: String, _ a: HeadAct) throws -> CGPoint {
    let b = try #require(r.canvas.head(cid(id))?.buttons.first { $0.0 == a }?.1)
    let c = r.rect(id)
    return CGPoint(x: c.minX + b.midX, y: c.minY + b.midY)
  }

  func hoverOver(_ r: Rig, _ p: CGPoint) { r.canvas.mouseMoved(with: r.mouse(.mouseMoved, p)) }

  @Test func eachKindHasMainsButtonsWhereMainPutsThem() async throws {
    let r = try await Rig(Self.board(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    let t = c.theme
    #expect(c.head(cid("c"))?.buttons.map(\.0) == [.fit, .wrap, .copy, .more])
    let free = try #require(c.head(cid("f")))
    #expect(free.buttons.map(\.0) == [.fit, .wrap, .copy, .lang, .more] && free.lang == "Python")
    let n = try #require(c.head(cid("n")))
    #expect(n.buttons.map(\.0) == [.fit, .split, .more] && n.faint.isEmpty)
    #expect(c.headTip(.split, n) == "Split by Headings · 3 cards, linked by arrows")
    #expect(c.headTip(.fit, n) == "Fit Content  ⌥F")
    // nothing to do: faint, and the tip says why
    let plain = try #require(c.head(cid("plain")))
    #expect(plain.faint == [.fit, .split])
    #expect(c.headTip(.fit, plain) == "Fit Content · already as tall as its content")
    #expect(c.headTip(.split, plain) == "Split by Headings · no headings to split at")
    #expect(c.head(cid("img")) == nil)
    // a Web card's ↗ and ⋯ on glass over its top right corner; a Link List's ··· in its header
    let web = try #require(c.head(cid("w")))
    let ww = r.rect("w").width
    #expect(web.floating && web.buttons.map(\.0) == [.open, .more])
    #expect(
      web.buttons.map(\.1) == [
        CGRect(x: ww - 7 - 22 - 2 - 22, y: 7, width: 22, height: 22),
        CGRect(x: ww - 7 - 22, y: 7, width: 22, height: 22),
      ])
    #expect(c.head(cid("l"))?.buttons.map(\.0) == [.more])
    // the ··· at the right in the place kept for it, the hover buttons ending a gap before it, 2 apart
    let w = r.rect("c").width
    let bs = try #require(c.head(cid("c"))?.buttons)
    #expect(bs.last?.1 == CGRect(x: w - t.headerPadRight - 26, y: t.headerHeight / 2 - 13, width: 26, height: 26))
    #expect(bs[2].1.maxX == w - t.headerPadRight - 26 - t.headerGap)
    #expect(bs[1].1.maxX == bs[2].1.minX - 2 && bs[0].1.maxX == bs[1].1.minX - 2)
  }

  @Test func theyShowWhileHoveredOrSelectedInTheCardsLayerAndFadeOut() async throws {
    let r = try await Rig(Self.board(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    #expect(c.headShown.isEmpty && c.gripShown == nil)
    hoverOver(r, r.centre("c"))
    let shown = try #require(c.headShown[cid("c")]?.layer)
    let box = c.items[try #require(c.index(of: .card(cid("c"))))].box
    #expect(shown.superlayer === box && shown.zPosition == 3.5 && shown.animation(forKey: "in") != nil)
    #expect(shown.frame == CGRect(x: 0, y: 0, width: r.rect("c").width, height: c.theme.headerHeight))
    #expect(c.gripShown?.id == cid("c") && c.gripShown?.layer.superlayer === box && c.gripShown?.layer.opacity == 0.7)
    // left: faded out over 160 ms, then gone
    hoverOver(r, CGPoint(x: 500, y: 650))
    #expect(c.headShown.isEmpty && c.gripShown == nil)
    #expect(shown.opacity == 0 && shown.animation(forKey: "out")?.duration == 0.16)
    // selected: shown with no pointer over it
    r.doc.select([.card(cid("n"))])
    #expect(c.headShown[cid("n")] != nil && c.gripShown == nil)
    // a picture has a grip and no header; a locked card no grip
    hoverOver(r, r.centre("img"))
    #expect(c.headShown[cid("img")] == nil && c.gripShown?.id == cid("img"))
    hoverOver(r, r.centre("lock"))
    #expect(c.gripShown == nil)
  }

  @Test func aButtonActsOnTheReleaseOverItAndIsUndoneAsOne() async throws {
    let pb = NSPasteboard(name: NSPasteboard.Name("head-\(UUID().uuidString)"))
    pb.clearContents()
    let r = try await Rig(Self.board(), zoom: 1, pasteboard: pb)
    defer { r.close() }
    let c = r.canvas
    func wraps() -> Bool {
      if case .own(let k) = r.card("c").content, case .code(let code) = k.body { code.wrap } else { false }
    }
    hoverOver(r, r.centre("c"))
    let wrap = try at(r, "c", .wrap)
    // pressed and moved off: nothing
    r.drag(wrap, CGPoint(x: 500, y: 650))
    #expect(!wraps() && !r.doc.history.canUndo)
    hoverOver(r, wrap)
    #expect(c.hoveredHead?.1 == .wrap && c.toolTip == "Wrap Lines  ⌥Z")
    r.click(wrap)
    #expect(wraps() && r.doc.undoName == "Wrap Lines" && r.doc.selection.isEmpty)
    r.doc.undo()
    #expect(!wraps())
    // Copy Code: the lines shown
    await r.settle()
    hoverOver(r, r.centre("c"))
    r.click(try at(r, "c", .copy))
    #expect(
      pb.string(forType: .string) == "def f(x):\n    y = x + 1\n    return y\n" && c.toastText == "Copied 4 lines")
    // Fit Content on a Note with a height of its own; none on one as tall as its content
    hoverOver(r, r.centre("n"))
    r.click(try at(r, "n", .fit))
    #expect(r.card("n").height == nil && r.doc.undoName == "Fit Content")
    r.doc.undo()
    await r.settle()
    let steps = r.doc.history.undoSteps.count
    hoverOver(r, r.centre("plain"))
    r.click(try at(r, "plain", .fit))
    #expect(r.doc.history.undoSteps.count == steps)
    // ···: the card's menu under it
    var menus: [NSMenu] = []
    c.menuShown = { m, _ in menus.append(m) }
    hoverOver(r, r.centre("n"))
    r.click(try at(r, "n", .more))
    #expect(menus.last?.items.first?.title == "Add Sidenote")
    // Split by Headings: two Notes linked from it, one step
    let cards = r.doc.board.cards.count
    r.click(try at(r, "n", .split))
    await r.until("split") { r.doc.board.cards.count == cards + 2 }
    #expect(r.doc.undoName == "Split by Headings" && r.doc.selection.count == 3)
    #expect(r.doc.board.arrows.filter { $0.from.card == cid("n") }.count == 2)
    r.doc.undo()
    #expect(r.doc.board.cards.count == cards && r.doc.board.arrows.isEmpty)
    // Free code's language: Auto-detect with its guess, then main's languages
    await r.settle()
    hoverOver(r, r.centre("f"))
    r.click(try at(r, "f", .lang))
    await r.until("the language menu") { menus.count == 2 }
    let langs = try #require(menus.last)
    #expect(langs.items.first?.title == "Auto-detect (Python)" && langs.items.first?.state == .on)
    #expect(langs.items.dropFirst(2).map(\.title).prefix(4) == ["Python", "Triton", "TileLang", "CUDA"])
    try #require(langs.item(withTitle: "Rust")?.representedObject as? MenuAction).run()
    let s = try #require(r.doc.board.freeCodeSegment(cid("f")))
    #expect(s.language == "rust" && s.languagePicked == true && r.doc.undoName == "Change Language")
    // a Web card's ↗: its page in the browser
    var opened: [URL] = []
    c.openURL = { opened.append($0) }
    await r.settle()
    hoverOver(r, r.centre("w"))
    r.click(try at(r, "w", .open))
    #expect(opened == [URL(string: "https://site.test/post")!])
  }

  @Test func doubleClickingTheGripFitsTheCard() async throws {
    let r = try await Rig(Self.board(), zoom: 1)
    defer { r.close() }
    let n = r.rect("n")
    let corner = CGPoint(x: n.maxX - 3, y: n.maxY - 3)
    hoverOver(r, corner)
    r.send(r.mouse(.leftMouseDown, corner))
    r.send(r.mouse(.leftMouseUp, corner))
    r.send(r.mouse(.leftMouseDown, corner, clicks: 2))
    r.send(r.mouse(.leftMouseUp, corner, clicks: 2))
    #expect(r.card("n").height == nil && r.doc.undoName == "Fit Content")
  }

  /// Free code's header shows its own title only, none when it has none; code from a file its symbol (CodeHead.tsx: a
  /// free card's title is `c.title ?? ""`, shown only when set)
  @Test func untitledFreeCodeShowsNoTitle() async throws {
    var b = Self.board()
    let titled = Segment(id: SegmentID(rawValue: "s3"), source: nil, language: "python", firstLine: 1, lines: ["y = 2"])
    b.cards.append(
      Card(
        id: cid("named"), x: 0, y: 1100, width: 420,
        content: .own(CardContent(title: "Mine", body: .code(CodeCard(segments: [titled]))))))
    let r = try await Rig(b, zoom: 1)
    defer { r.close() }
    func title(_ id: String) -> String? {
      guard let i = r.canvas.index(of: .card(cid(id))), case .code(let d) = r.canvas.scene?.items[i].drawing else {
        return nil
      }
      return d.title
    }
    #expect(title("f") == "")
    #expect(title("named") == "Mine")
    #expect(title("c") == "a.py")
  }
}
