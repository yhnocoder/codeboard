import CodeBoardModel
import CodeBoardNotes
import Foundation
import Testing

@testable import CodeBoardCanvas

/// [[refs]] resolve as the web board resolves them (actions/common.ts resolveCardRef, md/refs.ts)
@Suite struct RefTests {
  func note(_ id: String, _ text: String, _ style: NoteStyle = .note) -> Card {
    Card(
      id: CardID(rawValue: id), x: 0, y: 0, width: 300,
      content: .own(CardContent(body: .note(Note(text: text, style: style)))))
  }

  func code(_ id: String, symbol: String) -> Card {
    let s = Segment(
      id: SegmentID(rawValue: "s"), source: .file(path: "engine/sched.py", hash: nil), language: "python",
      firstLine: 10, lines: ["def step(): pass"], symbol: Symbol(name: symbol, kind: .function))
    return Card(
      id: CardID(rawValue: id), x: 0, y: 0, width: 300, content: .own(CardContent(body: .code(CodeCard(segments: [s]))))
    )
  }

  /// A vault with this board ("Engine") and another ("Memory Model"), each in its package
  func vault(_ here: Board, other: Board) throws -> (Vault, URL) {
    let root = FileManager.default.temporaryDirectory.appending(path: "refs-\(UUID().uuidString)")
    for (b, name) in [(here, "Engine"), (other, "Memory Model")] {
      let p = root.appending(path: "\(name).board")
      try FileManager.default.createDirectory(at: p, withIntermediateDirectories: true)
      try b.encoded().write(to: p.appending(path: Vault.boardFileName))
    }
    return (Vault(root: root), root.appending(path: "Engine.board"))
  }

  let other = Board(
    id: BoardID(rawValue: "mem"),
    cards: [
      Card(
        id: CardID(rawValue: "m1"), x: 0, y: 0, width: 300,
        content: .own(CardContent(body: .note(Note(text: "# Coalescing\n\nbody"))))),
      Card(
        id: CardID(rawValue: "m2"), x: 0, y: 0, width: 300,
        content: .own(CardContent(body: .note(Note(text: "no heading here"))))),
    ])

  @Test func refsResolveOnThisBoardAndOthers() throws {
    let text = """
      [[Plan#^c2]] [[plan]] [[sched.step]] [[Warps]] [[Memory Model]] [[Memory Model › coalescing]] \
      [[x#^mem/m1]] [[Memory Model › Gone]] [[Nowhere › Card]] [[Nothing]] [[Plan#^c2]]
      """
    let here = Board(
      id: BoardID(rawValue: "eng"),
      cards: [note("c1", text), note("c2", "# Plan\n\nsteps"), code("c3", symbol: "sched.step")],
      sections: [Section(id: SectionID(rawValue: "s1"), title: "Warps", x: 0, y: 0, width: 10, height: 10)])
    let (v, package) = try vault(here, other: other)
    defer { try? FileManager.default.removeItem(at: v.root) }
    let refs = RefResolver(here, package: package, vault: v).refs(in: text)
    let seal = NoteRef.Seal(text: "MM", color: RefResolver.sealColor("mem"), alone: false)
    var alone = seal
    alone.alone = true
    #expect(
      refs.map(\.hit) == [
        .found(title: "Plan", seal: nil), .found(title: "Plan", seal: nil), .found(title: "sched.step", seal: nil),
        .found(title: "Warps", seal: nil), .found(title: "Memory Model", seal: alone),
        .found(title: "Coalescing", seal: seal), .found(title: "Coalescing", seal: seal),
        .broken(place: false, title: "Gone", badge: "Memory Model"),
        .broken(place: true, title: "Card", badge: "Nowhere"),
      ])
    #expect(
      refs.map(\.label) == [
        "Plan", "plan", "sched.step", "Warps", "Memory Model", "Memory Model › coalescing", "x", "Memory Model › Gone",
        "Nowhere › Card",
      ])
  }

  /// A Note's refs change with its target's title, and with nothing else on the board
  @Test func onlyATargetsTitleChangesANotesRefs() throws {
    let text = "See [[Plan#^c2]]."
    func refs(_ cards: [Card]) throws -> [NoteRef] {
      let b = Board(id: BoardID(rawValue: "eng"), cards: cards)
      let (v, package) = try vault(b, other: other)
      defer { try? FileManager.default.removeItem(at: v.root) }
      return RefResolver(b, package: package, vault: v).refs(in: text)
    }
    let base = try refs([note("c1", text), note("c2", "# Plan"), note("c3", "# Other")])
    #expect(try refs([note("c1", text), note("c2", "# Plan"), note("c3", "# Other, edited")]) == base)
    #expect(try refs([note("c1", text), note("c2", "# Plan v2"), note("c3", "# Other")]) != base)
    #expect(try refs([note("c1", text), note("c3", "# Other")]).isEmpty)
  }

  @Test func sealsAreTheBoardsDefaults() {
    #expect(RefResolver.sealText("Memory Model") == "MM")
    #expect(RefResolver.sealText("Large language models for CUDA") == "LLMCUDA")
    #expect(RefResolver.sealText("Convolution") == "Convolution")
    #expect(RefResolver.sealText("并行 计算 模式 与 优化 方法 总结") == "并计模与优")
    #expect(RefResolver.sealColors.contains(RefResolver.sealColor("anything")))
  }
}
