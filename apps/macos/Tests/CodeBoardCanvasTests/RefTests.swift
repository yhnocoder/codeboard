import CodeBoardModel
import CodeBoardNotes
import Foundation
import Testing

@testable import CodeBoardCanvas

/// [[refs]] resolve as the web board resolves them (actions/common.ts resolveCardRef, md/refs.ts)
@Suite struct RefTests {
  func note(_ id: String, _ text: String) -> Card {
    Card(id: CardID(rawValue: id), x: 0, y: 0, width: 300, content: .own(CardContent(body: .note(Note(text: text)))))
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
    let seal = NoteRef.Seal(text: "MM", color: Seal.defaultColor(BoardID(rawValue: "mem")).rawValue, alone: false)
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

  /// The [[ list as the web board builds it (md/load.ts refCandidates, md/refs.ts refGroups, core boardRefsOf): this
  /// board's cards with a title of their own (a heading-like first line, a title, a code card's symbol; never an image
  /// or a Note whose first line is plain text), its titled Sections, and each other board as a group of its titled cards,
  /// with the Section each is in; the ids written are `card` here and `board/card` elsewhere
  @Test func theRefListHasThisBoardsTitledCardsAndSectionsThenEachOtherBoard() throws {
    var other = self.other
    other.sections = [Section(id: SectionID(rawValue: "g"), title: " Caches ", x: 0, y: 0, width: 10, height: 10)]
    other.cards[0].section = SectionID(rawValue: "g")
    let here = Board(
      id: BoardID(rawValue: "eng"),
      cards: [
        note("c1", "just words"), note("c2", "# Plan\n\nsteps"), code("c3", symbol: "sched.step"),
        Card(
          id: CardID(rawValue: "c4"), x: 0, y: 0, width: 200,
          content: .own(CardContent(body: .text(TextCard(text: "## Big [idea]"))))),
      ],
      sections: [
        Section(id: SectionID(rawValue: "s1"), title: "Warps", x: 0, y: 0, width: 10, height: 10),
        Section(id: SectionID(rawValue: "s2"), title: "  ", x: 0, y: 0, width: 10, height: 10),
      ])
    let (v, package) = try vault(here, other: other)
    defer { try? FileManager.default.removeItem(at: v.root) }
    let list = RefResolver(here, package: package, vault: v).candidates(recent: [("eng", "c2"), ("mem", "m1")])
    #expect(list.items.map(\.id) == ["c2", "c3", "c4", "s1"])
    #expect(list.items.map(\.title) == ["Plan", "sched.step", "Big  idea ", "Warps"])
    #expect(list.items.map(\.kind) == ["note", "code", "note", "section"])
    #expect(list.items.map(\.target) == ["c2", "c3", "c4", "s1"])
    #expect(list.items.allSatisfy { $0.label == nil && $0.crumb == nil })
    let g = try #require(list.groups.first)
    #expect(list.groups.count == 1)
    #expect(g.id == "mem" && g.title == "Memory Model" && g.label == "Memory Model" && g.target == "mem")
    #expect(g.note == "1 card · whiteboard")
    #expect(g.items.map(\.title) == ["Coalescing"])
    #expect(g.items.first?.label == "Memory Model › Coalescing")
    #expect(g.items.first?.target == "mem/m1")
    #expect(g.items.first?.crumb == "Caches")
    let seal = NoteRef.Seal(text: "MM", color: Seal.defaultColor(BoardID(rawValue: "mem")).rawValue, alone: false)
    #expect(g.items.first?.hit == .found(title: "Coalescing", seal: seal))
    var alone = seal
    alone.alone = true
    #expect(g.hit == .found(title: "Memory Model", seal: alone))
    #expect(list.recent == [.init(group: nil, id: "c2"), .init(group: "mem", id: "m1")])
    #expect(list.foot == "4 titled cards · 2 boards")
  }
}
