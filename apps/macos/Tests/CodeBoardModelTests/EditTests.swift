import Foundation
import Testing

@testable import CodeBoardModel

// The edit layer: every command, reference upkeep, undo and redo back to the same bytes, the three-way merge, copy and
// paste

private func cid(_ s: String) -> CardID { CardID(rawValue: s) }
private func gid(_ s: String) -> SectionID { SectionID(rawValue: s) }

/// A board with a bit of everything that hangs on cards and Sections
func editSample() -> Board {
  let seg = Segment(
    id: SegmentID(rawValue: "s1"), source: nil, language: "python", firstLine: 1, lines: ["a", "b", "c"])
  func note(_ id: String, x: Double, section: String? = nil) -> Card {
    Card(
      id: cid(id), x: x, y: 100, width: 200, section: section.map(gid),
      content: .own(CardContent(body: .note(Note(text: id)))))
  }
  return Board(
    id: BoardID(rawValue: "b"),
    cards: [
      Card(
        id: cid("c1"), x: 1200, y: 0, width: 300, content: .own(CardContent(body: .code(CodeCard(segments: [seg]))))),
      note("n1", x: 50, section: "g1"),
      note("n2", x: 500, section: "g2"),
      Card(id: cid("t1"), x: 1600, y: 0, width: 120, content: .own(CardContent(body: .text(TextCard(text: "T"))))),
    ],
    arrows: [
      Arrow(id: ArrowID(rawValue: "a1"), from: Endpoint(card: cid("c1")), to: Endpoint(card: cid("n1"))),
      Arrow(
        id: ArrowID(rawValue: "a2"), from: Endpoint(card: cid("c1"), segment: SegmentID(rawValue: "s1"), line: 2),
        to: Endpoint(card: cid("t1"))),
    ],
    sections: [
      Section(id: gid("g1"), title: "Outer", x: 0, y: 0, width: 1000, height: 800),
      Section(id: gid("g2"), title: "Inner", x: 400, y: 50, width: 500, height: 600, parent: gid("g1")),
    ],
    sidenotes: [
      Sidenote(
        id: SidenoteID(rawValue: "sn1"), anchor: .card(cid("c1"), segment: SegmentID(rawValue: "s1"), lines: 1...2),
        body: .text(TextNote(text: "on lines"))),
      Sidenote(id: SidenoteID(rawValue: "sn2"), anchor: .section(gid("g2")), body: .text(TextNote(text: "on g2"))),
      Sidenote(id: SidenoteID(rawValue: "sn3"), anchor: .point(x: 5, y: 5), body: .text(TextNote(text: "free"))),
    ],
    stickers: [
      Sticker(id: StickerID(rawValue: "k1"), glyph: .builtin(.star), anchor: .card(cid("n1"), x: 1, y: 1, size: nil)),
      Sticker(
        id: StickerID(rawValue: "k2"), glyph: .emoji("🔥"),
        anchor: .line(cid("c1"), segment: SegmentID(rawValue: "s1"), line: 2)),
      Sticker(id: StickerID(rawValue: "k3"), glyph: .builtin(.flag), anchor: .canvas(x: 0, y: 0, size: nil)),
    ],
    shelf: [
      ShelfEntry(
        id: "e1", at: 1,
        cards: [
          Card(
            id: cid("sh1"), x: 0, y: 0, width: 100, measuredHeight: 50,
            content: .own(CardContent(body: .note(Note(text: "shelved")))))
        ],
        arrows: [Arrow(id: ArrowID(rawValue: "a3"), from: Endpoint(card: cid("sh1")), to: Endpoint(card: cid("c1")))],
        stickers: [
          Sticker(
            id: StickerID(rawValue: "k4"), glyph: .builtin(.bug), anchor: .card(cid("sh1"), x: 0, y: 0, size: nil))
        ])
    ])
}

@Test func theSampleHoldsTogether() {
  #expect(editSample().problem() == nil)
}

@Test func deletingACardTakesWhatHangsOnIt() {
  var b = editSample()
  b.delete([.card(cid("c1"))])
  #expect(b.cards.map(\.id.rawValue) == ["n1", "n2", "t1"])
  #expect(b.arrows.isEmpty, "both arrows had an end on it")
  #expect(b.sidenotes.map(\.id.rawValue) == ["sn2", "sn3"])
  #expect(b.stickers.map(\.id.rawValue) == ["k1", "k3"])
  #expect(b.shelf[0].arrows.isEmpty, "a shelved card's arrow to it too")
  #expect(b.shelf[0].stickers.count == 1 && b.shelf[0].cards.count == 1)
  #expect(b.problem() == nil)
}

@Test func deletingASectionKeepsWhatIsInItOneLevelUp() {
  var b = editSample()
  b.delete([.section(gid("g1"))])
  #expect(b.sections.map(\.id.rawValue) == ["g2"])
  #expect(b.section(gid("g2"))?.parent == nil)
  #expect(b.card(cid("n1"))?.section == nil && b.card(cid("n2"))?.section == gid("g2"))
  b = editSample()
  b.delete([.section(gid("g2"))])
  #expect(b.card(cid("n2"))?.section == gid("g1"))
  #expect(!b.sidenotes.contains { $0.id.rawValue == "sn2" }, "its sidenote goes with it")
  b = editSample()
  b.delete([.section(gid("g1")), .section(gid("g2"))])
  #expect(b.sections.isEmpty && b.cards.allSatisfy { $0.section == nil })
}

@Test func lockedItemsAreLeftAlone() {
  var b = editSample()
  b.setLocked([.card(cid("t1"))], true)
  b.setLocked([.section(gid("g2"))], true)
  #expect(b.isLocked(.card(cid("n2"))), "a card in a locked Section is locked")
  let before = b
  b.move([.card(cid("t1")), .card(cid("n2")), .section(gid("g2"))], dx: 10, dy: 10)
  #expect(b == before)
  b.delete([.card(cid("t1")), .section(gid("g2"))])
  #expect(b == before)
}

@Test func movingASectionTakesItsSectionsAndCards() {
  var b = editSample()
  b.move([.section(gid("g1"))], dx: 10, dy: -5)
  #expect(b.section(gid("g1"))?.x == 10 && b.section(gid("g2"))?.x == 410)
  #expect(b.card(cid("n1"))?.x == 60 && b.card(cid("n2"))?.y == 95)
  #expect(b.card(cid("c1"))?.x == 1200)
}

@Test func resizeWrapScaleAndHomes() {
  var b = editSample()
  b.resize(cid("n1"), x: 40, y: 90, width: 260, height: 300)
  #expect(b.card(cid("n1"))?.width == 260 && b.card(cid("n1"))?.height == 300)
  b.resize(cid("t1"), x: 1600, y: 0, width: 300, height: 99)
  #expect(b.card(cid("t1"))?.height == nil, "a Text has no height")
  b.wrapText(cid("t1"), x: 1590, width: 140)
  guard case .own(let c)? = b.card(cid("t1"))?.content, case .text(let t) = c.body else {
    Issue.record("Text")
    return
  }
  #expect(t.wrap && b.card(cid("t1"))?.width == 140)
  b.scaleText(cid("t1"), fontSize: 999, width: 300)
  guard case .own(let c2)? = b.card(cid("t1"))?.content, case .text(let t2) = c2.body else {
    Issue.record("")
    return
  }
  #expect(t2.fontSize == 240)
  b.resize(section: gid("g2"), x: 400, y: 50, width: 100, height: 100)
  b.setHomes(cards: [cid("n2"): nil as SectionID?, cid("c1"): gid("g1")], sections: [gid("g1"): gid("g2")])
  #expect(b.card(cid("n2"))?.section == nil && b.card(cid("c1"))?.section == gid("g1"))
  #expect(b.section(gid("g1"))?.parent == nil, "never inside itself")
}

@Test func arrangeKeepsTheOrderAmongThemselves() {
  var b = editSample()
  b.arrange([cid("c1"), cid("n2")], toFront: true)
  #expect(b.cards.map(\.id.rawValue) == ["n1", "t1", "c1", "n2"])
  b.arrange([cid("t1"), cid("n2")], toFront: false)
  #expect(b.cards.map(\.id.rawValue) == ["t1", "n2", "n1", "c1"])
}

/// Every command, recorded and undone and redone: back to the same bytes each way
@Test func undoAndRedoGiveBackTheSameBytes() throws {
  let commands: [(String, (inout Board) -> Void)] = [
    ("move", { $0.move([.card(cid("c1")), .section(gid("g1"))], dx: 33, dy: 7) }),
    ("resize", { $0.resize(cid("n1"), x: 0, y: 0, width: 400, height: 250) }),
    ("wrap", { $0.wrapText(cid("t1"), x: 1500, width: 90) }),
    ("scale", { $0.scaleText(cid("t1"), fontSize: 40, width: 240) }),
    ("section", { $0.resize(section: gid("g2"), x: 1, y: 2, width: 3, height: 4) }),
    ("homes", { $0.setHomes(cards: [cid("n1"): nil as SectionID?], sections: [gid("g2"): nil as SectionID?]) }),
    ("delete card", { $0.delete([.card(cid("c1"))]) }),
    ("delete section", { $0.delete([.section(gid("g1"))]) }),
    ("delete all", { b in b.delete(Set(b.cards.map { .card($0.id) } + b.sections.map { .section($0.id) })) }),
    ("front", { $0.arrange([cid("n1")], toFront: true) }),
    ("back", { $0.arrange([cid("t1")], toFront: false) }),
    ("lock", { $0.setLocked([.card(cid("n1")), .section(gid("g1"))], true) }),
    ("tilt", { $0.setTilted([cid("n1"), cid("c1")], true) }),
    ("paste", { b in b.paste(b.clip([.section(gid("g1")), .card(cid("c1"))], shared: { _ in nil }), dx: 40, dy: 40) }),
  ]
  for (name, command) in commands {
    let start = editSample()
    var b = start
    var h = History()
    command(&b)
    let after = try b.encoded()
    h.record(name, from: start, to: b, selection: ([.card(cid("n1"))], [.card(cid("c1"))]))
    #expect(h.canUndo, "\(name)")
    #expect(h.undo(&b) == [.card(cid("n1"))], "the selection before")
    #expect(try b.encoded() == start.encoded(), "\(name) undone")
    #expect(h.redo(&b) == [.card(cid("c1"))], "the selection after")
    #expect(try b.encoded() == after, "\(name) redone")
  }
}

@Test func severalStepsUndoInOrder() throws {
  var b = editSample()
  var h = History()
  var states = [try b.encoded()]
  for i in 0..<5 {
    let was = b
    b.move([.card(cid("n1"))], dx: Double(i + 1), dy: 0)
    if i == 2 { b.delete([.card(cid("c1"))]) }
    h.record("step", from: was, to: b, selection: ([], []))
    states.append(try b.encoded())
  }
  h.record("nothing", from: b, to: b, selection: ([], []))
  #expect(h.undoSteps.count == 5, "an edit that changed nothing is no step")
  for i in (0..<5).reversed() {
    _ = h.undo(&b)
    #expect(try b.encoded() == states[i])
  }
  #expect(h.undo(&b) == nil)
  for i in 1...5 {
    _ = h.redo(&b)
    #expect(try b.encoded() == states[i])
  }
}

// MARK: Merge

@Test func changesOnBothSidesAreBothKept() {
  let base = editSample()
  var mine = base
  mine.move([.card(cid("n1"))], dx: 10, dy: 0)
  mine.delete([.card(cid("t1"))])
  var disk = base
  disk.setLocked([.card(cid("n1"))], true)
  disk.setTilted([cid("c1")], true)
  disk.sections.append(Section(id: gid("g3"), title: "New", x: 0, y: 0, width: 10, height: 10))
  let merged = Board.merge(base: base, mine: mine, disk: disk)
  #expect(merged.card(cid("n1"))?.x == 60 && merged.card(cid("n1"))?.locked == true, "two fields of one card")
  #expect(merged.card(cid("c1"))?.tilted == true && merged.card(cid("t1")) == nil)
  #expect(merged.sections.map(\.id.rawValue) == ["g1", "g2", "g3"])
  #expect(merged.problem() == nil)
}

@Test func onTheSameFieldTheDiskWins() {
  let base = editSample()
  var mine = base
  mine.move([.card(cid("n1"))], dx: 10, dy: 10)
  var disk = base
  disk.move([.card(cid("n1"))], dx: -20, dy: 0)
  let merged = Board.merge(base: base, mine: mine, disk: disk)
  #expect(merged.card(cid("n1"))?.x == 30, "x: both changed it, the disk's")
  #expect(merged.card(cid("n1"))?.y == 110, "y: only here")
}

@Test func whatTheDiskDeletedTakesWhatHangsOnIt() {
  let base = editSample()
  var mine = base
  mine.arrows.append(Arrow(id: ArrowID(rawValue: "a9"), from: Endpoint(card: cid("t1")), to: Endpoint(card: cid("n2"))))
  var disk = base
  disk.cards.removeAll { $0.id == cid("n2") }
  disk.prune()
  let merged = Board.merge(base: base, mine: mine, disk: disk)
  #expect(merged.card(cid("n2")) == nil)
  #expect(!merged.arrows.contains { $0.id.rawValue == "a9" }, "the arrow added here to the card deleted there")
  #expect(merged.problem() == nil)
}

@Test func onlyTheDiskReorderedTakesItsOrder() {
  let base = editSample()
  var disk = base
  disk.arrange([cid("c1")], toFront: true)
  #expect(Board.merge(base: base, mine: base, disk: disk).cards.map(\.id) == disk.cards.map(\.id))
  var mine = base
  mine.arrange([cid("t1")], toFront: false)
  #expect(Board.merge(base: base, mine: mine, disk: disk).cards.map(\.id.rawValue) == ["t1", "c1", "n1", "n2"])
}

@Test func aMergeDropsTheUndoStepsItBroke() {
  let base = editSample()
  var b = base
  var h = History()
  b.move([.card(cid("n1"))], dx: 5, dy: 0)
  h.record("move n1", from: base, to: b, selection: ([], []))
  let one = b
  b.move([.card(cid("t1"))], dx: 5, dy: 0)
  h.record("move t1", from: one, to: b, selection: ([], []))
  // the disk moved t1 too: the last step no longer holds, nor any before it
  var disk = base
  disk.move([.card(cid("t1"))], dx: 99, dy: 0)
  var kept = h
  let merged = Board.merge(base: base, mine: b, disk: disk)
  kept.keep(holdingOn: merged)
  #expect(kept.undoSteps.isEmpty)
  // the disk changed something else: both steps still undo
  var other = base
  other.setTilted([cid("c1")], true)
  var b2 = Board.merge(base: base, mine: b, disk: other)
  h.keep(holdingOn: b2)
  #expect(h.undoSteps.count == 2)
  _ = h.undo(&b2)
  _ = h.undo(&b2)
  #expect(b2.card(cid("n1"))?.x == 50 && b2.card(cid("t1"))?.x == 1600 && b2.card(cid("c1"))?.tilted == true)
}

// MARK: Copy and paste

@Test func pastingMakesPlainCopiesWithWhatHangsOnThem() throws {
  var b = editSample()
  // c1 is a shared card here
  let sharedContent = b.cards[0].content
  b.cards[0].content = .shared
  let travels = Sidenote(
    id: SidenoteID(rawValue: "tr"), anchor: .card(cid("c1")), body: .text(TextNote(text: "travels")))
  guard case .own(let content) = sharedContent else {
    Issue.record("")
    return
  }
  let shared = SharedCard(id: cid("c1"), content: content, sidenotes: [travels])
  let clip = b.clip([.section(gid("g1")), .card(cid("c1"))]) { $0 == cid("c1") ? shared : nil }
  #expect(clip.cards.map(\.id.rawValue).sorted() == ["c1", "n1", "n2"])
  #expect(clip.cards.allSatisfy { $0.content != .shared }, "a shared card is copied with its content")
  let data = try clip.encoded()
  #expect(try Clip(decoding: data) == clip)
  var ids = 0
  let made = b.paste(clip, dx: 50, dy: 50) { p in
    ids += 1
    return "\(p)-new\(ids)"
  }
  #expect(made.count == 5, "three cards and two Sections")
  #expect(b.cards.count == 7 && b.sections.count == 4)
  #expect(b.arrows.count == 3, "the arrow between two copied cards came too, not the one to t1")
  #expect(b.sidenotes.count == 6, "the one on c1's lines, the one on g2, the travelling one")
  #expect(b.stickers.count == 5, "the one on n1's copy and on c1's line")
  let inner = try #require(b.sections.last)
  #expect(inner.parent == b.sections[2].id && inner.x == 450)
  #expect(b.problem() == nil)
  // pasted again into a board without those cards: what pointed outside the clip is not there
  var other = Board(id: BoardID(rawValue: "o"))
  other.paste(b.clip([.card(cid("n1"))], shared: { _ in nil }), dx: 0, dy: 0)
  #expect(other.cards.count == 1 && other.cards[0].section == nil && other.stickers.count == 1)
  #expect(other.problem() == nil)
}
