import AppKit
import CodeBoardModel
import Testing

@testable import CodeBoardCanvas

// Sidenotes on the real canvas (as CanvasEditTests: a window of its own far off screen, events straight to the canvas,
// frames ticked by the test): a marker for each kind of anchor where the web board puts it, hit areas that keep their
// size on screen, a click that opens and closes the popup.

private func nid(_ s: String) -> SidenoteID { SidenoteID(rawValue: s) }
private func gid(_ s: String) -> SectionID { SectionID(rawValue: s) }
let s1 = SegmentID(rawValue: "s1")
let noteText = "# 调度 Scheduling\n\nRequests wait in the queue until a slot is free.\n\n- 每一步取一批\n- 再算一步"
let noteBlocks = ["# 调度 Scheduling", "Requests wait in the queue until a slot is free.", "- 每一步取一批\n- 再算一步"]

/// A code card with a Highlight and a sidenote on it, a Note with sidenotes on itself and on its third block, a Section
/// with one and a free one; `question`: the Note's is an open question
func sidenoteBoard(question: Bool = false) -> Board {
  let seg = Segment(
    id: s1, source: nil, language: "python", firstLine: 10,
    lines: [
      "def schedule(queue):", "    # 取出等待的请求", "    batch = queue.take(8)", "    run(batch)", "    return batch",
    ], highlights: [12...13])
  func text(_ t: String, q: Bool = false) -> Sidenote.Body {
    .text(TextNote(text: t, question: q ? Question(at: 1000) : nil))
  }
  return Board(
    id: BoardID(rawValue: "sidenotes"),
    cards: [
      Card(id: cid("c1"), x: 0, y: 0, width: 420, content: .own(CardContent(body: .code(CodeCard(segments: [seg]))))),
      Card(
        id: cid("n1"), x: 600, y: 0, width: 300, section: gid("g1"),
        content: .own(CardContent(body: .note(Note(text: noteText))))),
      Card(
        id: cid("t1"), x: 0, y: 400, width: 200, content: .own(CardContent(body: .text(TextCard(text: "备注 a note"))))),
    ],
    sections: [Section(id: gid("g1"), title: "调度 Section", x: 560, y: -80, width: 400, height: 420)],
    sidenotes: [
      Sidenote(id: nid("l1"), anchor: .card(cid("c1"), segment: s1, lines: 12...13), body: text("取一批")),
      Sidenote(id: nid("l2"), anchor: .card(cid("c1"), segment: s1, lines: 12...13), body: text("再取")),
      Sidenote(id: nid("w1"), anchor: .card(cid("n1")), body: text("整张卡", q: question)),
      Sidenote(
        id: nid("b1"), anchor: .card(cid("n1"), block: BlockRef(index: 2, hash: BlockRef.sig(noteBlocks[2]))),
        body: text("这一块")),
      Sidenote(id: nid("g1"), anchor: .section(gid("g1")), body: text("分段")),
      Sidenote(id: nid("f1"), anchor: .point(x: 300, y: 600), body: text("自由")),
      Sidenote(id: nid("t1"), anchor: .card(cid("t1")), body: text("文字")),
    ])
}

@MainActor @Suite(.serialized) struct CanvasSidenoteTests {
  @Test(arguments: [0.1, 0.5, 1, 2] as [CGFloat])
  func eachAnchorsMarkerIsWhereTheWebBoardPutsItAndTakesTheClick(zoom: CGFloat) async throws {
    let r = try await Rig(sidenoteBoard(question: true), zoom: zoom)
    defer { r.close() }
    let c = r.canvas
    let t = c.theme
    func mark(_ at: PopAt) throws -> Mark { try #require(c.marks.first { $0.at == at }, "\(at)") }
    func onBoard(_ m: Mark) -> CGRect {
      guard case .card(let id)? = m.owner else {
        if case .sectionTitle(let s)? = m.owner, let r = c.scene?.items.first(where: { $0.owner == .sectionTitle(s) }) {
          return m.frame.offsetBy(dx: r.rect.minX, dy: r.rect.minY)
        }
        return m.frame
      }
      let o = r.rect(id.rawValue).origin
      return m.frame.offsetBy(dx: o.x, dy: o.y)
    }
    #expect(c.marks.count == 6 && c.markLayers.count == 6)
    let gap = 4.5 * sqrt(max(1, 1 / zoom)) + 5 / zoom
    // a whole card: past its right edge, clear of its ports, level with its header; an open question's is a ?
    let n1 = r.rect("n1")
    let whole = try mark(.spot(.card(cid("n1"))))
    #expect(
      abs(onBoard(whole).minX - (n1.maxX + gap)) < 0.01
        && abs(onBoard(whole).midY - (n1.minY + t.headerHeight / 2)) < 0.01)
    #expect(onBoard(whole).minX > n1.maxX + c.portRadius && whole.ask && whole.notes == [nid("w1")])
    // a Text has no header: 16 from its top
    let text = try mark(.spot(.card(cid("t1"))))
    #expect(abs(onBoard(text).midY - (r.rect("t1").minY + 16)) < 0.01)
    // a Note's block: level with the block's first line, under the whole card's
    let block = try mark(.spot(.block(cid("n1"), BlockRef(index: 2, hash: BlockRef.sig(noteBlocks[2])))))
    #expect(onBoard(block).minX == onBoard(whole).minX && onBoard(block).midY > onBoard(whole).midY + 40)
    #expect(onBoard(block).maxY < n1.maxY)
    // a Highlight: in the line numbers, right of them and left of the code, level with its first line; its count
    let lines = try mark(.lines(Lines(card: cid("c1"), segment: s1, range: 12...13)))
    let c1 = r.rect("c1")
    let code = try #require(c.scene?.placed[cid("c1")]?.code)
    let row = try #require(code.layout.row(segment: 0, line: 12))
    #expect(lines.gutter && lines.notes.count == 2 && onBoard(lines).height == 13)
    #expect(onBoard(lines).maxX == c1.minX + code.layout.gutter - 6)
    #expect(abs(onBoard(lines).minY - (c1.minY + code.top + row.y + 3.5)) < 0.01)
    // a Section's: after its title
    let section = try mark(.spot(.section(gid("g1"))))
    let title = try #require(c.scene?.items.first { $0.owner == .sectionTitle(gid("g1")) }?.rect)
    #expect(onBoard(section).minX == title.maxX + 6 && abs(onBoard(section).midY - title.midY) < 0.01)
    // a free one: centred on its point
    let free = try mark(.spot(.point(x: 300, y: 600)))
    #expect(onBoard(free).midX == 300 && onBoard(free).midY == 600 && free.owner == nil)
    // each takes the pointer at least 18 px across on screen, and never less than 18 board units
    for m in c.marks {
      #expect(m.hit.width * zoom >= 17.99 && m.hit.width >= 17.99, "\(m.at)")
      if !m.gutter { #expect(m.hit.height * zoom >= 17.99) }
      #expect(m.hit.contains(CGPoint(x: onBoard(m).midX, y: onBoard(m).midY)))
    }
    // a gutter marker is no taller than a line, so the next line's keeps its own
    #expect(lines.hit.height <= 20)
    // a click opens its popup, another closes it; hover opens nothing
    var opened: [PopAt?] = []
    c.onPop = { opened.append($0) }
    let p = CGPoint(x: onBoard(whole).midX, y: onBoard(whole).midY)
    #expect(c.markAt(p) != nil)
    r.click(p)
    #expect(c.openPop == .spot(.card(cid("n1"))))
    r.click(p)
    #expect(c.openPop == nil && opened == [.spot(.card(cid("n1"))), nil])
    #expect(r.doc.selection.isEmpty, "a marker click selects nothing")
  }
}
