import AppKit
import CodeBoardModel
import Foundation
import Testing

@testable import CodeBoardCanvas

// The calls on a code card's lines (CanvasCalls.swift): what the shell says of a segment drawn into the card's picture
// and found under the pointer where its name is drawn; nothing for a segment it says nothing of

private let caller = SegmentID(rawValue: "s1")

/// A shell that knows the calls of the segments it is given, and says when they come
@MainActor final class FakeCalls: CallHost {
  var onCallsChanged: (() -> Void)?
  var known: [SegmentID: [CallSpan]] = [:]
  var asked: [SegmentID] = []

  func calls(_ s: Segment) -> [CallSpan]? {
    asked.append(s.id)
    return known[s.id]
  }

  func give(_ id: SegmentID, _ calls: [CallSpan]) {
    known[id] = calls
    onCallsChanged?()
  }

  /// What a click on a call gets, by the choice picked (nil: the first ask)
  var answer: (CallChoice?) -> CallAnswer = { _ in .said }
  var expanded: [(segment: SegmentID, call: CallSpan, pick: CallChoice?)] = []

  func expand(_ s: Segment, call: CallSpan, pick: CallChoice?, at: CGRect, on canvas: CanvasView) async -> CallAnswer {
    expanded.append((s.id, call, pick))
    return answer(pick)
  }
}

/// `Scheduler.schedule`'s card, as the shell gives it
let scheduleDef = Segment(
  id: SegmentID(rawValue: "d1"), source: .file(path: "scheduler.py", hash: nil), language: "python", firstLine: 5,
  lines: ["def schedule(self):", "    return []"], symbol: Symbol(name: "Scheduler.schedule", kind: .function))

func callsBoard() -> Board {
  let s = Segment(
    id: caller, source: .file(path: "engine.py", hash: nil), language: "python", firstLine: 10,
    lines: ["def step(self):", "    seqs = self.scheduler.schedule()", "    return seqs"])
  let free = Segment(id: SegmentID(rawValue: "s2"), source: nil, language: "python", firstLine: 1, lines: ["f(1)"])
  func own(_ b: CardContent.Body) -> Card.Content { .own(CardContent(body: b)) }
  return Board(
    id: BoardID(rawValue: "calls"),
    cards: [
      Card(id: cid("c"), x: 0, y: 0, width: 420, content: own(.code(CodeCard(segments: [s])))),
      Card(id: cid("f"), x: 0, y: 300, width: 420, content: own(.code(CodeCard(segments: [free])))),
    ])
}

/// `schedule` on line 11: its columns in "    seqs = self.scheduler.schedule()"
let scheduleCall = CallSpan(line: 11, col: 26, end: 34, name: "schedule", recv: "self.scheduler")

@MainActor @Suite(.serialized) struct CanvasCallsTests {
  /// Where the scene draws a call's name on its card (board units)
  static func box(_ r: Rig, _ card: String, _ call: CallSpan) -> CGRect? {
    let c = r.canvas
    guard let s = c.scene, let placed = s.placed[cid(card)], let code = placed.code else { return nil }
    for row in code.layout.rows {
      guard case .line(_, call.line?, let text, _) = row.row else { continue }
      return Drawing.callBox(
        call, text: text, font: c.theme.codeStyle.font, x: placed.rect.minX + code.layout.gutter + code.layout.shift,
        y: placed.rect.minY + code.top + row.y, height: row.height)
    }
    return nil
  }

  @Test func aSegmentsCallsAreDrawnAndFoundWhereTheirNamesAreOnceTheShellKnowsThem() async throws {
    let r = try await Rig(callsBoard(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    let host = FakeCalls()
    c.callHost = host
    await r.settle()
    #expect(host.asked.contains(caller) && !host.asked.contains(SegmentID(rawValue: "s2")), "free code is not asked")
    guard case .code(let before)? = c.scene?.items[c.index(of: .card(cid("c")))!].drawing else {
      Issue.record("no code card")
      return
    }
    #expect(before.calls.allSatisfy { $0.isEmpty }, "none while the shell does not know them")
    host.give(caller, [scheduleCall])
    await r.until("the calls drawn") {
      if case .code(let d)? = c.scene?.items[c.index(of: .card(cid("c")))!].drawing {
        d.calls == [[scheduleCall]]
      } else {
        false
      }
    }
    let b = try #require(Self.box(r, "c", scheduleCall))
    // "schedule" is 8 characters of the code font, after "    seqs = self.scheduler."
    let w = c.theme.metrics.charWidth
    #expect(abs(b.width - 8 * w) < 0.5 && b.minX > r.rect("c").minX)
    let hit = try #require(c.callAt(CGPoint(x: b.midX, y: b.midY)))
    #expect(hit.card == cid("c") && hit.segment.id == caller && hit.call == scheduleCall)
    #expect(c.callAt(CGPoint(x: b.minX - w, y: b.midY)) == nil, "the dot before the name is no call")
    #expect(c.callAt(CGPoint(x: b.midX, y: b.midY + 20)) == nil, "nor the line under it")
    #expect(!r.doc.history.canUndo, "the board is unchanged")
  }

  /// A rig on the calls board whose code card shows `schedule` as a call, `answer` what a click on it gets
  static func clickable(_ board: Board = callsBoard(), _ answer: @escaping (CallChoice?) -> CallAnswer) async throws
    -> (Rig, FakeCalls, CGRect)
  {
    let r = try await Rig(board, zoom: 1)
    let host = FakeCalls()
    host.known[caller] = [scheduleCall]
    host.answer = answer
    r.canvas.callHost = host
    await r.until("the call drawn") {
      if case .code(let d)? = r.canvas.scene?.items[r.canvas.index(of: .card(cid("c")))!].drawing {
        d.calls == [[scheduleCall]]
      } else {
        false
      }
    }
    await r.idle()
    await r.until("opened") { !r.canvas.opening }
    return (r, host, try #require(Self.box(r, "c", scheduleCall)))
  }

  /// The card the board has besides `c` and `f`
  static func expandedCard(_ r: Rig) -> Card? { r.doc.board.cards.first { !["c", "f"].contains($0.id.rawValue) } }

  @Test func aClickedCallsCardGoesBesideItsLineWithAnArrowFromItInOneStepAndAClickAgainShowsIt() async throws {
    let (r, host, b) = try await Self.clickable { _ in .card(scheduleDef, title: nil) }
    defer { r.close() }
    let c = r.canvas
    r.click(CGPoint(x: b.midX, y: b.midY))
    await r.until("its card") { Self.expandedCard(r) != nil }
    let n = try #require(Self.expandedCard(r))
    #expect(host.expanded.count == 1 && host.expanded[0].call == scheduleCall && host.expanded[0].pick == nil)
    // the column to its right, its top 18 over the call's line; as wide as its code
    #expect(n.x == r.rect("c").maxX + 96 && n.y == (b.midY - 18).rounded() && n.width == 380)
    guard case .own(let k) = n.content, case .code(let code) = k.body else {
      Issue.record("not a code card")
      return
    }
    #expect(code.segments == [scheduleDef])
    let a = try #require(r.doc.board.arrows.first)
    #expect(r.doc.board.arrows.count == 1)
    #expect(a.from == Endpoint(card: cid("c"), segment: caller, line: 11) && a.to == Endpoint(card: n.id))
    #expect(r.doc.selection == [.card(n.id)])
    #expect(c.flashedLine == 11, "its line flashes")
    // clicked again: the card it went to is shown and selected, its line flashed, nothing asked
    await r.settle()
    r.doc.select([])
    c.flashedLine = nil
    r.click(CGPoint(x: b.midX, y: b.midY))
    await r.settle()
    #expect(
      host.expanded.count == 1 && r.doc.board.cards.count == 3 && r.doc.selection == [.card(n.id)],
      "\(host.expanded.count) \(r.doc.board.cards.count) \(r.doc.selection)")
    #expect(c.flashedLine == 11)
    // one step
    r.doc.undo()
    #expect(r.doc.board.cards.count == 2 && r.doc.board.arrows.isEmpty)
    #expect(c.callsAsked.isEmpty)
  }

  @Test func aCallClickedTwiceAtOnceIsAskedOnceAndOptionClickExpandsToo() async throws {
    let (r, host, b) = try await Self.clickable { _ in .card(scheduleDef, title: nil) }
    defer { r.close() }
    let p = CGPoint(x: b.midX, y: b.midY)
    r.click(p, .option)
    r.click(p, .option)
    await r.until("its card") { Self.expandedCard(r) != nil }
    await r.settle()
    #expect(host.expanded.count == 1 && r.doc.board.cards.count == 3)
  }

  @Test func aCallsCardGoesInTheSectionOfTheCardItIsCalledFrom() async throws {
    var board = callsBoard()
    let sec = SectionID(rawValue: "sec")
    board.sections = [Section(id: sec, title: "S", x: -20, y: -40, width: 460, height: 260)]
    board.cards[0].section = sec
    let (r, host, b) = try await Self.clickable(board) { _ in .card(scheduleDef, title: nil) }
    defer { r.close() }
    #expect(r.canvas.callAt(CGPoint(x: b.midX, y: b.midY)) != nil, "\(b) \(r.rect("c"))")
    r.click(CGPoint(x: b.midX, y: b.midY))
    await r.until("asked") { !host.expanded.isEmpty }
    await r.until("its card") { Self.expandedCard(r) != nil }
    #expect(Self.expandedCard(r)?.section == sec, "\(r.canvas.toastText ?? "") \(r.doc.board.cards.map(\.id))")
  }

  @Test func definitionsToPickAreAMenuUnderTheCallAndThePickedOneIsExpanded() async throws {
    let choices = [
      CallChoice(label: "Scheduler.schedule", detail: "scheduler.py:5", path: "/r/scheduler.py", line: 5),
      CallChoice(label: "Planner.schedule", detail: "planner.py:9", path: "/r/planner.py", line: 9),
    ]
    let (r, host, b) = try await Self.clickable { pick in
      pick == nil ? .pick(choices) : .card(scheduleDef, title: "Scheduler.schedule")
    }
    defer { r.close() }
    var menus: [NSMenu] = []
    r.canvas.menuShown = { m, _ in menus.append(m) }
    r.click(CGPoint(x: b.midX, y: b.midY))
    await r.until("the picker") { !menus.isEmpty }
    let m = try #require(menus.first)
    #expect(
      m.items.map(\.title) == [
        "schedule() · 2 definitions", "Scheduler.schedule  scheduler.py:5", "Planner.schedule  planner.py:9",
      ])
    #expect(!m.items[0].isEnabled && m.items[1].isEnabled)
    try #require(m.items[2].representedObject as? MenuAction).run()
    await r.until("its card") { Self.expandedCard(r) != nil }
    #expect(host.expanded.last?.pick == choices[1])
    guard case .own(let k)? = Self.expandedCard(r)?.content else {
      Issue.record("no card")
      return
    }
    #expect(k.title == "Scheduler.schedule")
  }

  @Test func aCallWithNoDefinitionSaysWhyAndNothingIsAdded() async throws {
    let (r, host, b) = try await Self.clickable { _ in .none("No definition found for “schedule”.", name: "schedule") }
    defer { r.close() }
    r.click(CGPoint(x: b.midX, y: b.midY))
    await r.until("said") { r.canvas.toastText == "No definition found for “schedule”." }
    #expect(
      r.canvas.toastText == "No definition found for “schedule”.",
      "\(host.expanded.count) \(r.canvas.callsAsked) \(r.canvas.callAt(CGPoint(x: b.midX, y: b.midY)) != nil) \(b)")
    #expect(r.doc.board.cards.count == 2 && !r.doc.history.canUndo)
  }

  @Test func aCallDraggedOntoACodeCardLinksItsLineAndLetGoOnTheBoardExpandsThere() async throws {
    let (r, host, b) = try await Self.clickable { _ in .card(scheduleDef, title: nil) }
    defer { r.close() }
    let from = CGPoint(x: b.midX, y: b.midY)
    var rings = 0
    r.drag(from, r.centre("f")) { rings = r.canvas.callRings.count }
    #expect(rings == 2, "the card under the pointer ringed twice (.drop-hot)")
    #expect(r.canvas.callRings.isEmpty, "gone once let go")
    #expect(host.expanded.isEmpty)
    #expect(
      r.doc.board.arrows.map(\.from) == [Endpoint(card: cid("c"), segment: caller, line: 11)]
        && r.doc.board.arrows.map(\.to) == [Endpoint(card: cid("f"))])
    #expect(r.canvas.toastText?.hasPrefix("Linked to ") == true)
    r.drag(from, r.centre("f"))
    #expect(r.doc.board.arrows.count == 1 && r.canvas.toastText?.hasPrefix("Already linked to ") == true)
    // let go on the board: the card there, its top left by the pointer
    let to = CGPoint(x: 700, y: 520)
    r.drag(from, to)
    await r.until("its card") { Self.expandedCard(r) != nil }
    let n = try #require(Self.expandedCard(r))
    #expect(n.x == 708 && n.y == 502 && host.expanded.count == 1)
    #expect(r.doc.board.arrows.contains { $0.to.card == n.id && $0.from.line == 11 })
  }

  @Test func theCallUnderThePointerIsTintedOverTheCardsPicture() async throws {
    let (r, _, b) = try await Self.clickable { _ in .said }
    defer { r.close() }
    let c = r.canvas
    let drawn = c.scene?.items[c.index(of: .card(cid("c")))!].drawing
    r.send(r.mouse(.mouseMoved, CGPoint(x: b.midX, y: b.midY)))
    #expect(!c.callTint.isHidden && c.callTint.frame == b.insetBy(dx: 0, dy: 1))
    r.send(r.mouse(.mouseMoved, CGPoint(x: b.minX - 30, y: b.midY)))
    #expect(c.callTint.isHidden)
    #expect(!c.pendingRefresh, "nothing drawn again")
    _ = drawn
  }

  @Test func theCardsOfTheCallGraphItLandsOnSlideDownInTheSameStep() async throws {
    var board = callsBoard()
    // what line 12 calls, already in the column where line 11's card goes
    let g = Segment(
      id: SegmentID(rawValue: "g1"), source: .file(path: "g.py", hash: nil), language: "python", firstLine: 1,
      lines: ["def g():", "    pass"], symbol: Symbol(name: "g", kind: .function))
    board.cards.append(
      Card(id: cid("g"), x: 516, y: 60, width: 380, content: .own(CardContent(body: .code(CodeCard(segments: [g]))))))
    board.arrows.append(
      Arrow(
        id: ArrowID(rawValue: "a"), from: Endpoint(card: cid("c"), segment: caller, line: 12),
        to: Endpoint(card: cid("g"))))
    let (r, host, b) = try await Self.clickable(board) { _ in .card(scheduleDef, title: nil) }
    defer { r.close() }
    #expect(r.canvas.callAt(CGPoint(x: b.midX, y: b.midY)) != nil)
    r.click(CGPoint(x: b.midX, y: b.midY))
    await r.until("its card") { r.doc.board.cards.count == 4 }
    #expect(host.expanded.count == 1, "\(r.canvas.toastText ?? "") \(r.doc.selection)")
    let n = try #require(r.doc.board.cards.first { !["c", "f", "g"].contains($0.id.rawValue) })
    #expect(n.y == Double((b.midY - 18).rounded()), "\(n.y - Double((b.midY - 18).rounded()))")
    // pushed down by the new card's height and the gap, and sliding there
    #expect(r.card("g").y == 60 + 52 + 2 * 19 + 24)
    #expect(r.canvas.tidySlide?.from[cid("g")] == CGVector(dx: 0, dy: -(52 + 2 * 19 + 24)))
    r.doc.undo()
    #expect(r.doc.board.cards.count == 3 && r.card("g").y == 60)
  }

  @Test func aMoveAlongARowLaysItsCallsOutOnce() async throws {
    let (r, _, b) = try await Self.clickable { _ in .said }
    defer { r.close() }
    let c = r.canvas
    #expect(c.callAt(CGPoint(x: b.midX, y: b.midY))?.call == scheduleCall)
    let kept = try #require(c.callRow)
    #expect(c.callAt(CGPoint(x: b.minX + 1, y: b.midY))?.call == scheduleCall)
    #expect(c.callAt(CGPoint(x: b.minX - 20, y: b.midY)) == nil)
    #expect(c.callRow?.boxes == kept.boxes && c.callRow?.card == kept.card && c.callRow?.at == kept.at)
  }
}

@Suite struct CallPlaceTests {
  /// core layout.test.ts's placeChild: beside at the line, under the earlier siblings, down past what is in the way
  @Test func aChildGoesBesideAtItsLineUnderItsEarlierSiblingsAndDownPastOthers() {
    let parent = CGRect(x: 0, y: 0, width: 400, height: 300)
    let size = CGSize(width: 380, height: 200)
    #expect(CallPlace.child(parent, size, before: [], others: [], side: true, top: 120) == CGPoint(x: 496, y: 120))
    #expect(CallPlace.child(parent, size, before: [], others: [], side: false, top: 0) == CGPoint(x: 56, y: 328))
    let sib = CGRect(x: 496, y: 100, width: 380, height: 240)
    #expect(CallPlace.child(parent, size, before: [sib], others: [], side: true, top: 120) == CGPoint(x: 496, y: 364))
    let other = CGRect(x: 500, y: 150, width: 300, height: 100)
    #expect(
      CallPlace.child(parent, size, before: [], others: [other], side: true, top: 120) == CGPoint(x: 496, y: 274))
  }
}
