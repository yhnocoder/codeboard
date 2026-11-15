import AppKit
import CodeBoardModel
import Foundation
import Testing

@testable import CodeBoardCanvas

// Plain text pasted on the board as main's pasteText makes a card of it (board actions/create.ts pasteText, newWriting,
// addCards, newFreeCode, addImage; state/sections.ts settleHome): a Note where it was asked (LaTeX brackets as $…$,
// <mark> as ==), Free code and SVG images at the nearest free place, every one in the Section it lands in, one step,
// selected. Only the test's own pasteboard is ever written.

@MainActor @Suite(.serialized) struct CanvasPasteTests {
  /// A Section at the top left, a card to keep clear of on the right
  static func board() -> Board {
    Board(
      id: BoardID(rawValue: "paste"),
      cards: [
        Card(
          id: cid("a"), x: 1000, y: 0, width: 300, height: 200,
          content: .own(CardContent(body: .note(Note(text: "in the way")))))
      ],
      sections: [Section(id: SectionID(rawValue: "g"), title: "Group", x: 0, y: 0, width: 600, height: 400)])
  }

  func rig(_ board: Board = board()) async throws -> (Rig, NSPasteboard) {
    let pb = NSPasteboard(name: NSPasteboard.Name("paste-\(UUID().uuidString)"))
    pb.clearContents()
    return (try await Rig(board, zoom: 1, pasteboard: pb), pb)
  }

  /// `text` pasted with ⌘V (the pointer at `p`, or away), and the card it made, once made
  func paste(_ text: String, _ r: Rig, _ pb: NSPasteboard, at p: CGPoint?) async throws -> Card {
    pb.clearContents()
    pb.setString(text, forType: .string)
    if let p { r.canvas.mouseMoved(with: r.mouse(.mouseMoved, p)) } else { r.canvas.pointerInWindow = nil }
    let before = Set(r.doc.board.cards.map(\.id))
    r.canvas.paste(nil)
    await r.until("the pasted card") { r.doc.board.cards.contains { !before.contains($0.id) } }
    let c = try #require(r.doc.board.cards.first { !before.contains($0.id) })
    #expect(r.doc.selection == [.card(c.id)] && r.doc.undoName == "Paste")
    return c
  }

  func body(_ c: Card) -> CardContent.Body? {
    if case .own(let k) = c.content { k.body } else { nil }
  }

  @Test func plainTextPastesAsANoteWhereMainPutsIt() async throws {
    let (r, pb) = try await rig()
    defer { r.close() }
    let c = r.canvas
    // the board's Paste is on with nothing to paste, as main's; choosing it then makes nothing
    let empty = CGPoint(x: 1300, y: 600)
    let m = try #require(c.menu(for: r.mouse(.rightMouseDown, empty)))
    let item = try #require(m.item(withTitle: "Paste"))
    #expect(item.action != nil && item.keyEquivalent == "v" && item.keyEquivalentModifierMask == .command)
    let cards = r.doc.board.cards.count
    try #require(item.representedObject as? MenuAction).run()
    #expect(r.doc.board.cards.count == cards && !r.doc.history.canUndo)
    // from the board's menu: its top left where it was asked
    pb.setString("A thought, written down.\n\nWith more to say.", forType: .string)
    try #require(
      c.menu(for: r.mouse(.rightMouseDown, CGPoint(x: 1300.4, y: 600.6)))?.item(withTitle: "Paste")?.representedObject
        as? MenuAction
    ).run()
    await r.until("the Note") { r.doc.board.cards.count == cards + 1 }
    let n1 = try #require(r.doc.board.cards.last)
    guard case .note(let t1)? = body(n1) else {
      Issue.record("not a Note: \(n1)")
      return
    }
    #expect(
      t1.text == "A thought, written down.\n\nWith more to say." && n1.x == 1300 && n1.y == 601
        && n1.width == Board.newNoteWidth)
    #expect(r.doc.undoName == "Paste" && r.doc.history.undoSteps.count == 1)
    // ⌘V with the pointer on the board: under it, even over a card (newWriting puts it exactly there)
    let n2 = try await paste("Another", r, pb, at: CGPoint(x: 1010, y: 10))
    #expect(n2.x == 1010 && n2.y == 10)
    // with the pointer away: 40 above the middle of the view
    let n3 = try await paste("Third", r, pb, at: nil)
    let v = c.camera.visible(c.bounds.size)
    #expect(n3.x == (v.midX - Board.newNoteWidth / 2).rounded() && n3.y == (v.midY - 40).rounded())
    // only white space: nothing
    pb.clearContents()
    pb.setString(" \n\t", forType: .string)
    let now = r.doc.board.cards.count
    c.paste(nil)
    #expect(r.doc.board.cards.count == now)
  }

  /// LaTeX's \( … \) and \[ … \] become $…$ and $$…$$ (texBrackets), and the text is then a Note where it was read as
  /// code before; <mark> becomes == (markTags)
  @Test func formulasAndMarksPasteInTheNotesOwnWriting() async throws {
    let (r, pb) = try await rig()
    defer { r.close() }
    let tex = try await paste(
      #"The energy of a body at rest is \(m\) times the <mark>square</mark> of the speed \[c\] of light."#, r, pb,
      at: CGPoint(x: 700, y: 500))
    guard case .note(let t)? = body(tex) else {
      Issue.record("not a Note: \(tex)")
      return
    }
    #expect(t.text == "The energy of a body at rest is $m$ times the ==square== of the speed $$c$$ of light.")
    let mark = try await paste("Read <mark>this</mark> twice", r, pb, at: CGPoint(x: 700, y: 800))
    guard case .note(let m)? = body(mark) else {
      Issue.record("not a Note: \(mark)")
      return
    }
    #expect(m.text == "Read ==this== twice")
  }

  /// Code: a Free code card in the language guessed, a Note's width, as tall as its lines, at the nearest place from the
  /// pointer free of the other cards (findFree: 40 further each round, down, right, both, up, left; 28 between cards)
  @Test func codePastesAsFreeCodeAtTheNearestFreePlace() async throws {
    let (r, pb) = try await rig()
    defer { r.close() }
    let a = r.rect("a")
    #expect(a == CGRect(x: 1000, y: 0, width: 300, height: 200))
    let k = try await paste(
      "import torch\n\ndef step(batch):\n    return run(batch)\n\n", r, pb, at: CGPoint(x: 1000, y: 0))
    guard case .code(let code)? = body(k), let seg = code.segments.first else {
      Issue.record("not code: \(k)")
      return
    }
    #expect(seg.source == nil && seg.language == "python" && seg.firstLine == 1)
    #expect(seg.lines == ["import torch", "", "def step(batch):", "    return run(batch)"])
    #expect(k.width == Board.newNoteWidth)
    // 128 tall (52 + 4 × 19): round 4 up, 160 above, is the first free; down needs round 6, right round 9
    #expect(k.x == 1000 && k.y == -160, "\(k.x), \(k.y)")
    #expect(k.section == nil)
  }

  /// An SVG: cleaned into a file of the board's images, an image card as wide as the picture (at most a Note's)
  @Test func anSVGPastesAsAnImageInTheBoardsFolder() async throws {
    let (r, pb) = try await rig()
    defer { r.close() }
    let svg =
      #"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100"/></svg>"#
    let small = try await paste(svg, r, pb, at: CGPoint(x: 700, y: 600))
    guard case .image(let img)? = body(small), case .file(let name) = img.source else {
      Issue.record("not an image file: \(small)")
      return
    }
    #expect(small.width == 200 && small.x == 700 && small.y == 600)
    let file = r.file.deletingLastPathComponent().appending(path: Vault.imagesFolder).appending(path: name)
    let saved = try String(contentsOf: file, encoding: .utf8)
    #expect(saved.contains("<rect"), "\(saved)")
    let wide = try await paste(
      svg.replacingOccurrences(of: #"width="200""#, with: #"width="900""#), r, pb, at: CGPoint(x: 700, y: 1000))
    #expect(wide.width == Board.newNoteWidth)
  }

  /// A link and a list of them (newWeb, newLinkList by addCards) from the pointer's place, as main's paste gives it
  /// (interact.ts worldAt(lastPointer())), the nearest free place there
  @Test func linksPasteFromThePointer() async throws {
    let (r, pb) = try await rig()
    defer { r.close() }
    r.canvas.fetchPage = { _ in WebPage(title: "T", description: "", site: "") }
    let web = try await paste("https://site.test/post", r, pb, at: CGPoint(x: 700, y: 500))
    #expect(web.x == 700 && web.y == 500)
    let list = try await paste("https://a.test/1\nhttps://b.test/2", r, pb, at: CGPoint(x: 700, y: 900))
    #expect(list.x == 700 && list.y == 900)
  }

  /// Pasted into a Section (by more than a third of the card): the card is the Section's (settleHome)
  @Test func aCardPastedIntoASectionIsTheSections() async throws {
    let (r, pb) = try await rig()
    defer { r.close() }
    let n = try await paste("Inside", r, pb, at: CGPoint(x: 100, y: 100))
    #expect(n.section == SectionID(rawValue: "g"))
    // mostly outside: not
    let out = try await paste("Outside", r, pb, at: CGPoint(x: 500, y: 300))
    #expect(out.section == nil)
  }

  /// Text just copied from a card (Copy Code) and pasted on this board lands beside that card, 36 further down and right
  /// with each paste, over what is there (clipboard.ts pasteNear, addCards exact); other text goes where it would
  @Test func textCopiedFromACardPastesBesideIt36Apart() async throws {
    var b = Self.board()
    let src = Segment(
      id: SegmentID(rawValue: "s1"), source: .file(path: "a.py", hash: nil), language: "python", firstLine: 10,
      lines: ["def f(x):", "    y = x + 1", "    return y"])
    b.cards.append(
      Card(id: cid("c"), x: 0, y: 600, width: 420, content: .own(CardContent(body: .code(CodeCard(segments: [src]))))))
    let (r, pb) = try await rig(b)
    defer { r.close() }
    r.canvas.copyCode(cid("c"))
    let copied = try #require(pb.string(forType: .string))
    let away = CGPoint(x: 700, y: 500)
    let one = try await paste(copied, r, pb, at: away)
    #expect(one.x == 36 && one.y == 636, "\(one.x), \(one.y)")
    // white space around it is the same text
    let two = try await paste("\n" + copied + "\n\n", r, pb, at: away)
    #expect(two.x == 72 && two.y == 672, "\(two.x), \(two.y)")
    // other text: at the pointer
    let other = try await paste("def g():\n    return 2", r, pb, at: away)
    #expect(other.x == 700 && other.y == 500, "\(other.x), \(other.y)")
  }
}
