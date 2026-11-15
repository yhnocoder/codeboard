import AppKit
import CodeBoardMarkdownUI
import CodeBoardModel
import Testing

@testable import CodeBoardCanvas

// A code, Free code or image card's description (Card.tsx Desc, .cdesc): drawn by the Markdown component under a code
// card's header (its code below it) or under an image's picture, the card taller by it; written in place from the
// card's menu (Description / Add Description, then Edit Description), as one step, blank being none

private func descBoard(code: String? = nil, image: String? = nil) -> Board {
  let free = Segment(
    id: s1, source: nil, language: "python", firstLine: 1, lines: ["def step(batch):", "    return 1"])
  let f = Card(
    id: cid("f"), x: 100, y: 100, width: 320,
    content: .own(CardContent(title: "Free", description: code, body: .code(CodeCard(segments: [free])))))
  let img = Card(
    id: cid("i"), x: 600, y: 100, width: 300,
    content: .own(CardContent(description: image, body: .image(ImageCard(source: .file("none.png"))))))
  return Board(id: BoardID(rawValue: "desc"), cards: [f, img])
}

@MainActor @Suite struct CanvasDescTests {
  func titles(_ m: NSMenu) -> [String] { m.items.map(\.title) }
  func addItems(_ m: NSMenu) -> [String] { m.item(withTitle: "Add")?.submenu?.items.map(\.title) ?? [] }

  @Test func aDescriptionIsDrawnUnderTheHeaderWithTheCodeBelowIt() async throws {
    let plain = try await Rig(descBoard(), zoom: 1)
    let bare = try #require(plain.canvas.scene?.placed[cid("f")])
    let bareImage = plain.rect("i")
    plain.close()
    let r = try await Rig(descBoard(code: "Why it **runs** first", image: "Where it was taken"), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    let p = try #require(c.scene?.placed[cid("f")])
    let i = try #require(c.index(of: .card(cid("f"))))
    guard case .code(let d) = c.scene!.items[i].drawing, let desc = d.desc else {
      return #expect(Bool(false), "no description drawn")
    }
    // 7 + 12 × 1.55 + 6 + its line
    #expect(desc.height >= 7 + 18 + 6 + 1 && desc.height < 40, "\(desc.height)")
    #expect(p.code?.top == c.theme.headerHeight + desc.height && p.code?.top ?? 0 > bare.code?.top ?? 0)
    #expect(p.rect.height == bare.rect.height + desc.height, "the card taller by it")
    let j = try #require(c.index(of: .card(cid("i"))))
    guard case .image(let pic) = c.scene!.items[j].drawing, let idesc = pic.desc else {
      return #expect(Bool(false), "no image description")
    }
    #expect(r.rect("i").height == bareImage.height + idesc.height)
  }

  @Test func writtenFromTheMenuAsOneStep() async throws {
    let r = try await Rig(descBoard(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    let f = r.rect("f")
    #expect(addItems(c.cardMenu(cid("f"), at: CGPoint(x: f.midX, y: f.midY))) == ["Description"])
    #expect(titles(c.cardMenu(cid("i"), at: CGPoint(x: 700, y: 150))).contains("Add Description"))
    c.editDescription(cid("f"))
    let d = try #require(c.descWriting)
    #expect(r.window.firstResponder === d.editor, "the editor has the keys")
    for ch in "Why it runs" {
      d.editor.insertText(String(ch), replacementRange: NSRange(location: NSNotFound, length: 0))
    }
    // a press elsewhere writes it
    r.click(CGPoint(x: f.midX, y: f.maxY + 300))
    #expect(c.descWriting == nil)
    guard case .own(let k)? = r.doc.board.card(cid("f"))?.content else { return #expect(Bool(false)) }
    #expect(k.description == "Why it runs" && r.doc.undoName == "Edit Description")
    await r.until("laid out with it") {
      (c.scene?.placed[cid("f")]?.code?.top ?? 0) > c.theme.headerHeight
    }
    #expect(addItems(c.cardMenu(cid("f"), at: CGPoint(x: f.midX, y: f.midY))) == ["Edit Description"])
    // written blank: none
    c.editDescription(cid("f"))
    let e = try #require(c.descWriting)
    e.editor.doCommand(by: #selector(NSResponder.selectAll(_:)))
    e.editor.doCommand(by: #selector(NSResponder.deleteBackward(_:)))
    c.endDesc()
    guard case .own(let k2)? = r.doc.board.card(cid("f"))?.content else { return #expect(Bool(false)) }
    #expect(k2.description == nil)
  }
}
