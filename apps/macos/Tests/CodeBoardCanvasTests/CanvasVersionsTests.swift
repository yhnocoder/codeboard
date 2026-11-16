import AppKit
import CodeBoardModel
import Testing

@testable import CodeBoardCanvas

// A code card's version on its header (CodeHead.tsx .rev, .rev.unc): the chip says the version ("Mixed" for several,
// "No commit" for a file with none), a dot when there is a newer one (hollow when only hidden lines changed), struck
// through when its code is lost, and "+ uncommitted"; clicked, it asks the shell (CanvasView.onVersion), and its tip is
// main's. What the shell's checks found redraws only the cards whose marks changed, in one refresh, their code not laid
// out again.

private let first = SegmentID(rawValue: "s1")

private func git(_ commit: String, uncommitted: Bool = false) -> CodeSource {
  .git(repository: nil, commit: commit, path: "a.py", uncommitted: uncommitted, checkout: nil)
}

private func card(_ id: String, x: Double, _ segs: [Segment]) -> Card {
  Card(id: cid(id), x: x, y: 0, width: 360, content: .own(CardContent(body: .code(CodeCard(segments: segs)))))
}

private func seg(_ id: String, _ source: CodeSource?) -> Segment {
  Segment(
    id: SegmentID(rawValue: id), source: source, language: "python", firstLine: 10,
    lines: ["def f(x):", "    y = x + 1", "    return y"], symbol: Symbol(name: "f", kind: .function))
}

@MainActor @Suite(.serialized) struct CanvasVersionsTests {
  static func board() -> Board {
    Board(
      id: BoardID(rawValue: "versions"),
      cards: [
        card("c", x: 0, [seg("s1", git("aa43ca3f00d"))]),
        card("u", x: 400, [seg("s2", git("bb43ca3f00d", uncommitted: true))]),
        card("h", x: 800, [seg("s3", .file(path: "a.py", hash: "9f3e00aa"))]),
        card("m", x: 0, [seg("s4", git("aa43ca3f00d")), seg("s5", git("cc00000"))]).moved(y: 300),
        card("n", x: 400, [seg("s6", .file(path: "a.py", hash: nil))]).moved(y: 300),
        card("f", x: 800, [seg("s7", nil)]).moved(y: 300),
      ])
  }

  func drawn(_ r: Rig, _ id: String) -> Drawing.Code? {
    guard let i = r.canvas.index(of: .card(cid(id))), case .code(let c) = r.canvas.scene?.items[i].drawing else {
      return nil
    }
    return c
  }

  @Test func theChipSaysTheVersionAndClickedAsksTheShell() async throws {
    let r = try await Rig(Self.board(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    #expect(
      drawn(r, "c")?.version == "aa43ca3" && drawn(r, "h")?.version == "9f3e" && drawn(r, "m")?.version == "Mixed")
    #expect(drawn(r, "n")?.version == "No commit" && drawn(r, "f")?.version == nil)
    #expect(drawn(r, "u")?.mark == Drawing.Mark(uncommitted: true))
    // no shell to ask: no buttons
    #expect(c.head(cid("c"))?.buttons.contains { $0.0 == .version } == false)
    var asked: [(CardID, VersionAsk)] = []
    c.onVersion = { id, what, _ in asked.append((id, what)) }
    let h = try #require(c.head(cid("c")))
    let chip = try #require(h.buttons.first { $0.0 == .version }?.1)
    let w = r.rect("c").width
    let t = c.theme
    #expect(chip.maxX == w - t.headerPadRight - 26 - t.headerGap, "left of the ···")
    #expect(c.headTip(.version, h) == Tip("aa43ca3 · Pinned version"))
    #expect(c.head(cid("f"))?.buttons.contains { $0.0 == .version } == false, "Free code has none")
    let uh = try #require(c.head(cid("u")))
    let unc = try #require(uh.buttons.first { $0.0 == .uncommitted }?.1)
    let ver = try #require(uh.buttons.first { $0.0 == .version }?.1)
    #expect(ver.maxX + t.headerGap == unc.minX, "+ uncommitted at the right")
    #expect(c.headTip(.uncommitted, uh) == Tip("+ uncommitted · HEAD vs Working Tree"))
    #expect(c.headTip(.version, try #require(c.head(cid("h")))) == Tip("9f3e · Unknown version (not in git)"))
    // a click on the chip, let go over it
    let rc = r.rect("c")
    let p = CGPoint(x: rc.minX + chip.midX, y: rc.minY + chip.midY)
    r.click(p)
    let ru = r.rect("u")
    r.click(CGPoint(x: ru.minX + unc.midX, y: ru.minY + unc.midY))
    #expect(asked.map(\.0) == [cid("c"), cid("u")] && asked.map(\.1) == [.newVersion, .uncommitted])
    #expect(r.doc.undoName == nil, "a click on it is no edit")
  }

  @Test func whatTheChecksFoundRedrawsOnlyTheCardsWhoseMarksChangedInOneRefresh() async throws {
    let r = try await Rig(Self.board(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    c.onVersion = { _, _, _ in }
    let before = c.refreshes
    c.versions = [first: .changed(hiddenOnly: false, label: "dd00000"), SegmentID(rawValue: "s3"): .lost]
    await c.refreshing?.value
    #expect(c.refreshes == before + 1)
    #expect(drawn(r, "c")?.mark.version == .changed && drawn(r, "h")?.mark.version == .lost)
    let s = try #require(c.scene)
    #expect(!s.reused.contains(cid("c")) && !s.reused.contains(cid("h")))
    #expect(s.reused.isSuperset(of: [cid("u"), cid("m"), cid("n"), cid("f")]), "the others as they were")
    let h = try #require(c.head(cid("c")))
    #expect(c.headTip(.version, h) == Tip("aa43ca3 · New version · View Diff"))
    // the chip grows by its dot, the title gives way
    let chip = try #require(h.buttons.first { $0.0 == .version }?.1)
    #expect(chip.width == Drawing.width("aa43ca3", c.theme.codePath) + 20)
    c.versions = [first: .changed(hiddenOnly: true, label: "dd00000")]
    await c.refreshing?.value
    #expect(c.headTip(.version, try #require(c.head(cid("c")))) == Tip("aa43ca3 · Changes only in hidden lines"))
    #expect(drawn(r, "h")?.mark.version == nil, "lost no more")
  }
}

extension Card {
  fileprivate func moved(y: Double) -> Card {
    var c = self
    c.y = y
    return c
  }
}
