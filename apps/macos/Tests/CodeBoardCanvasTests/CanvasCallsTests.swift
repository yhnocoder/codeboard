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
}

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
}
