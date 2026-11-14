import AppKit
import CodeBoardModel
import Testing

@testable import CodeBoardCanvas

// The summary level on the real canvas (CanvasEditTests' rig: a window far off screen, events straight to the canvas,
// frames driven by the test with tick(at:)): its pictures made before they are needed, the switch frame by frame in both
// modes with nothing drawn again, a zoom the app makes, editing in place with its undo, ↻ with a writer of the test's
// own (no network, no Keychain), and the stale dot's ✓ 保留.

/// Two Sections of two Notes each (one summarized, one never), a loose Note with its summary, a Text that stays as it is
func summaryBoard() -> Board {
  func note(_ id: String, _ md: String, _ x: Double, _ y: Double, _ s: String? = nil) -> Card {
    var c = Card(id: cid(id), x: x, y: y, width: 700, content: .own(CardContent(body: .note(Note(text: md)))))
    c.section = s.map(SectionID.init(rawValue:))
    return c
  }
  var b = Board(
    id: BoardID(rawValue: "sum"),
    cards: [
      note("a1", "## 合并访存\n\n同一 warp 访问连续地址。", 80, 80, "s1"),
      note("a2", "## bank 冲突\n\n填充一列错开 bank。", 880, 80, "s1"),
      note("b1", "## 流和事件\n\n流里的操作按顺序执行。", 2200, 80, "s2"),
      note("b2", "## 异步拷贝\n\n要页锁定内存。", 3000, 80, "s2"),
      note("loose", "# 本章导读\n\n从设计取舍讲起。", 80, 1400),
      Card(
        id: cid("t"), x: 2200, y: 1400, width: 600, content: .own(CardContent(body: .text(TextCard(text: "# 笔记"))))),
    ],
    sections: [
      Section(id: SectionID(rawValue: "s1"), title: "访存", x: 60, y: 40, width: 1560, height: 300, color: "blue"),
      Section(id: SectionID(rawValue: "s2"), title: "流", x: 2180, y: 40, width: 1560, height: 300, color: "sand"),
    ])
  for (k, text) in [
    (SummaryKey.section(SectionID(rawValue: "s1")), "同一 warp 访问**连续地址**，填充错开 bank。"),
    (.card(cid("loose")), "从**设计取舍**讲起。"),
  ] {
    _ = b.putSummary(
      Summary(text: text, at: 1, sig: b.summarySig(k) ?? "", input: b.summaryInput(k)), for: k)
  }
  return b
}

let sec1 = SummaryKey.section(SectionID(rawValue: "s1"))
let sec2 = SummaryKey.section(SectionID(rawValue: "s2"))

/// A writer of the test's own: what it was asked, and its answer (or a failure)
final class FakeWriter: SummaryWriter, @unchecked Sendable {
  var asked: [String] = []
  var answer: Result<String, SummaryFailure> = .success("新写的**摘要**。")

  func write(system: String, user: String) async throws(SummaryFailure) -> String {
    await MainActor.run { asked.append(user) }
    return try answer.get()
  }
}

@MainActor @Suite(.serialized) struct CanvasSummaryTests {
  static let frame = 1.0 / 120

  /// The column of `key`
  func column(_ r: Rig, _ key: SummaryKey) throws -> SummaryColumn {
    try #require(r.canvas.summaryColumns.first { $0.col.key == key })
  }

  /// The canvas at the summary level, at rest
  func atSummaries(_ r: Rig) {
    r.canvas.place(zoom: 0.2, centre: CGPoint(x: 1900, y: 800))
    #expect(r.canvas.levels.level == .summaries)
  }

  /// ⌘-scroll steps of `d` (|ln| each) with a trackpad, one per frame from `t`, each followed by its frame
  func scroll(_ r: Rig, _ d: CGFloat, times: Int, t: inout TimeInterval) {
    let mid = CGPoint(x: r.canvas.bounds.midX, y: r.canvas.bounds.midY)
    for _ in 0..<times {
      r.canvas.wheelZoom(by: d, precise: true, at: mid, time: t)
      r.canvas.tick(at: t)
      t += Self.frame
    }
  }

  @Test func theSummaryLevelIsLaidOutAndDrawnWhenTheBoardIsShown() async throws {
    let r = try await Rig(summaryBoard(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    #expect(abs(c.levels.cut - 0.3) < 1e-9 && c.levels.level == .cards && c.summaryLayer.isHidden)
    // a column per Section and loose card, the Text none; each drawn already
    #expect(Set(c.summaryColumns.map(\.col.key)) == [sec1, sec2, .card(cid("loose"))])
    for col in c.summaryColumns { #expect(col.layer.contents != nil) }
    // the summarized Section's body, the never-written one only its title
    let (one, two) = (try column(r, sec1), try column(r, sec2))
    #expect(one.text.text?.contains("连续地址") == true && two.text.text == nil)
    // the Text is shown as it is at both levels, on the layer the switch does not fade
    let t = try #require(c.index(of: .card(cid("t"))))
    #expect(c.items[t].box.superlayer === c.kept)
  }

  @Test func aPinchStopsAtTheCutThinsThePushAndCrossFadesWithNothingDrawnAgain() async throws {
    let r = try await Rig(summaryBoard(), zoom: 0.5)
    defer { r.close() }
    let c = r.canvas
    let pictures = c.summaryColumns.map { $0.layer.contents as AnyObject? }
    let breaks = r.breaks
    var t = 100.0
    // out to the cut: it stops there
    while c.camera.zoom > 0.3 + 1e-9 { scroll(r, -0.05, times: 1, t: &t) }
    #expect(abs(c.camera.zoom - 0.3) < 1e-9 && c.levels.level == .cards)
    // half a push (each step |ln| / 0.6 of one): the card level thins to 0.65, the camera held
    let before = c.levels.push
    scroll(r, -0.05, times: Int(((0.5 - before) * 0.6 / 0.05).rounded()), t: &t)
    #expect(abs(c.levels.push - 0.5) < 0.05, "\(c.levels.push)")
    #expect(abs(c.cardLevel.opacity - Float(SummaryLevels.thinned(c.levels.push))) < 1e-4 && c.summaryLayer.isHidden)
    #expect(abs(c.camera.zoom - 0.3) < 1e-9)
    // through: the layers cross-fade in place, the camera still
    scroll(r, -0.05, times: 8, t: &t)
    #expect(c.levels.level == .summaries && abs(c.camera.zoom - 0.3) < 1e-9)
    var shown: [(Float, Float)] = []
    for _ in 0..<40 {
      c.tick(at: t)
      shown.append(
        (c.cardLevel.isHidden ? 0 : c.cardLevel.opacity, c.summaryLayer.isHidden ? 0 : c.summaryLayer.opacity))
      t += Self.frame
    }
    #expect(shown.last! == (0, 1) && c.cardLevel.isHidden)
    // the halves overlap only slightly: once the text is half there the cards have gone
    #expect(shown.allSatisfy { $0.1 < 0.5 || $0.0 < 0.01 })
    #expect(abs(c.camera.zoom - 0.3) < 1e-9)
    // nothing drawn, decoded or requested; the columns' pictures the ones made before
    #expect(r.breaks == breaks)
    #expect(zip(pictures, c.summaryColumns.map { $0.layer.contents as AnyObject? }).allSatisfy { $0 === $1 })
  }

  @Test func letGoThePushDrainsAndAStepBackDropsIt() async throws {
    let r = try await Rig(summaryBoard(), zoom: 0.31)
    defer { r.close() }
    let c = r.canvas
    var t = 100.0
    scroll(r, -0.06, times: 4, t: &t)
    #expect(c.levels.push > 0.2 && c.cardLevel.opacity < 0.9)
    for _ in 0..<120 {
      c.tick(at: t)
      t += Self.frame
    }
    #expect(c.levels.push == 0 && c.cardLevel.opacity == 1 && c.levels.level == .cards)
    scroll(r, -0.06, times: 4, t: &t)
    scroll(r, 0.02, times: 1, t: &t)
    #expect(c.levels.push == 0 && c.cardLevel.opacity == 1 && c.camera.zoom > 0.3)
  }

  @Test func oneMouseWheelNotchGoesStraightThrough() async throws {
    let r = try await Rig(summaryBoard(), zoom: 0.31)
    defer { r.close() }
    let c = r.canvas
    let mid = CGPoint(x: c.bounds.midX, y: c.bounds.midY)
    c.wheelZoom(by: -0.1, precise: false, at: mid, time: 100)
    c.tick(at: 100)
    #expect(c.levels.level == .summaries && abs(c.camera.zoom - 0.3) < 1e-9)
  }

  @Test func continuousNeverStopsAndComesBackOnlyPastTheHysteresis() async throws {
    let r = try await Rig(summaryBoard(), zoom: 0.5)
    defer { r.close() }
    let c = r.canvas
    c.summarySwitch = .continuous
    var t = 100.0
    scroll(r, -0.1, times: 7, t: &t)
    #expect(c.camera.zoom < 0.3 && c.levels.level == .summaries)
    // back over the point but under 1.12 times it: still summaries
    while c.camera.zoom < 0.32 { scroll(r, 0.01, times: 1, t: &t) }
    #expect(c.levels.level == .summaries)
    while c.camera.zoom < 0.34 { scroll(r, 0.01, times: 1, t: &t) }
    #expect(c.levels.level == .cards)
  }

  @Test func aDoubleClickOnATitleFliesToItsSectionAndTheSummariesGoFast() async throws {
    let r = try await Rig(summaryBoard(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    atSummaries(r)
    let col = try column(r, sec1)
    let title = CGPoint(x: col.rect.minX + 2 * CGFloat(c.summaryLayout!.padding), y: col.rect.minY + col.bodyTop / 2)
    r.send(r.mouse(.leftMouseDown, title, clicks: 1))
    r.send(r.mouse(.leftMouseUp, title, clicks: 1))
    r.send(r.mouse(.leftMouseDown, title, clicks: 2))
    r.send(r.mouse(.leftMouseUp, title, clicks: 2))
    #expect(c.summaryEditor == nil, "a title is not edited")
    var t = CACurrentMediaTime()
    var crossed: TimeInterval?
    var late: Float = 0
    while !c.motion.isResting || c.levels.isAnimating {
      c.tick(at: t)
      if crossed == nil, c.levels.level == .cards { crossed = t }
      if let x = crossed, t - x > 0.085 { late = max(late, c.summaryLayer.isHidden ? 0 : c.summaryLayer.opacity) }
      t += Self.frame
      if t > CACurrentMediaTime() + 5 { break }
    }
    #expect(crossed != nil && late == 0, "the summaries gone within 80 ms of the crossing")
    // the Section's frame in view at 100 % at most
    let frame = try #require(c.scene?.frames.first { $0.id == SectionID(rawValue: "s1") })
    #expect(c.camera.zoom <= 1 && c.shownRect.contains(frame.rect))
  }

  @Test func aBodyClickedIsEditedInPlaceEnterKeepsEscLeavesAndUndoBringsItBack() async throws {
    let r = try await Rig(summaryBoard(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    atSummaries(r)
    let before = try #require(r.doc.board.summary(for: sec1))
    func body() throws -> CGPoint {
      let col = try column(r, sec1)
      return CGPoint(x: col.rect.minX + 2 * CGFloat(c.summaryLayout!.padding), y: col.rect.minY + col.bodyTop + 30)
    }
    func key(_ code: UInt16) {
      let e = NSEvent.keyEvent(
        with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: r.window.windowNumber,
        context: nil, characters: "", charactersIgnoringModifiers: "", isARepeat: false, keyCode: code)!
      c.summaryEditor?.keyDown(with: e)
    }
    // Esc: nothing changes
    r.click(try body())
    let ed = try #require(c.summaryEditor)
    #expect(ed.markdown() == before.text, "its bold read back as **…**")
    ed.string = "改过的摘要"
    key(53)
    #expect(c.summaryEditor == nil && r.doc.board.summary(for: sec1) == before)
    // Enter: kept as the user's, paired with the AI text it replaced, one step
    r.click(try body())
    c.summaryEditor?.string = "手写的**新**摘要"
    key(36)
    let after = try #require(r.doc.board.summary(for: sec1))
    #expect(c.summaryEditor == nil && after.text == "手写的**新**摘要" && after.edited)
    #expect(after.pairs.first?.ai == before.text && r.doc.undoName == "Edit Summary")
    r.doc.undo()
    #expect(r.doc.board.summary(for: sec1) == before)
  }

  @Test func rewriteOnlyWithAWriterFollowsTheHandEditAndAFailureKeepsTheText() async throws {
    let r = try await Rig(summaryBoard(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    atSummaries(r)
    // no key: no ↻
    c.hoverSummary(sec1)
    #expect(c.summaryButtons.sublayers?.isEmpty ?? true)
    c.hoverSummary(nil)
    let w = FakeWriter()
    c.summaryWriter = w
    c.hoverSummary(sec1)
    #expect(c.summaryButtons.sublayers?.count == 1)
    // a hand edit first: the rewrite is asked with it
    var b = r.doc.board
    let edited = b.editSummary(sec1, text: "我自己写的**版本**。", now: 2)
    #expect(edited)
    r.doc.edit("Edit Summary") { $0 = b }
    c.rewriteSummary(sec1)
    #expect(
      c.summaryWriting.contains(sec1)
        && c.summaryColumns.first { $0.col.key == sec1 }?.layer.animation(forKey: "breathe") != nil)
    await r.until("written") { !c.summaryWriting.contains(sec1) }
    #expect(w.asked.count == 1 && w.asked[0].contains("我自己写的**版本**。"))
    let s = try #require(r.doc.board.summary(for: sec1))
    #expect(s.text == "新写的**摘要**。" && !s.edited && s.pairs.first?.user == "我自己写的**版本**。")
    #expect(r.doc.undoName == "Rewrite Summary")
    // a failure: the text as it was, nothing in the history
    w.answer = .failure(.network("offline"))
    let steps = r.doc.undoName
    c.rewriteSummary(sec1)
    await r.until("failed") { !c.summaryWriting.contains(sec1) }
    #expect(r.doc.board.summary(for: sec1) == s && r.doc.undoName == steps)
    // nothing is written on its own: a Section's cards changed, no request
    b = r.doc.board
    b.cards[0].content = .own(CardContent(body: .note(Note(text: "## 合并访存与对齐\n\n改了。"))))
    r.doc.edit("Edit") { $0 = b }
    await r.settle()
    #expect(w.asked.count == 2)
  }

  @Test func aSectionWhoseCardsChangedShowsItsDotAndKeepClearsItAsOneStep() async throws {
    let r = try await Rig(summaryBoard(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    var b = r.doc.board
    b.cards[0].content = .own(CardContent(body: .note(Note(text: "## 合并访存与对齐\n\n同一 warp 访问连续地址。"))))
    r.doc.edit("Edit") { $0 = b }
    await r.settle()
    atSummaries(r)
    #expect(try column(r, sec1).text.stale)
    c.hoverSummary(sec1)
    // no writer: ✓ 保留 alone, with the dot
    let keep = try #require(c.summaryButtons.sublayers?.first)
    #expect(c.summaryButtons.sublayers?.count == 1 && keep.sublayers?.count == 2)
    c.keepSummary(sec1)
    #expect(!r.doc.board.summaryPending(sec1) && r.doc.undoName == "Keep Summary")
    await r.settle()
    #expect(try !column(r, sec1).text.stale)
    r.doc.undo()
    #expect(r.doc.board.summaryPending(sec1))
  }
}
