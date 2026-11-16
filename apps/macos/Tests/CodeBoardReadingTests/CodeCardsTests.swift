import AppKit
import CodeBoardAnalysis
import CodeBoardModel
import Foundation
import Testing

@testable import CodeBoardReading

// Code taken from a code tab to the board (CodeCards.swift): a selection's whole lines, a function or class whole
// from its plus, the outline or ⌥↵, each a new card through the pane's collect; nothing without a board; ⌘ over a name
// and ⌘-click to its definition, Back coming back. The shell is a fake of the test's own (the real one is
// ShellCodeTests'); presses are made-up events in a window never shown

private let source = """
  import os

  def helper(x):
      return x + 1


  class Engine:
      @staticmethod
      def make():
          def inner():
              return helper(1)
          return inner()

      def step(self):
          return self.make()

  """ + (16...79).map { "x\($0) = \($0)\n" }.joined() + "y = helper(2) + other_fn() + os.sep + step()\n"
  + (81...140).map { "z\($0) = \($0)\n" }.joined()

/// What the shell would answer, made up
@MainActor private final class FakeHost: CodeHost {
  var canAdd = true
  var opened: [String] = []
  var picks: [CodePick] = []
  /// The lines of the cards the board in front has of the file
  var onBoard: [ClosedRange<Int>] = []
  var defs: [String: [CodeDefinition]] = [:]
  var asked: [(CodeName, Bool)] = []
  /// The cards the vault's boards have of the file, and those gone to
  var places: [CodeOnBoard] = []
  var went: [CardID] = []

  func opened(_ repository: String) { opened.append(repository) }

  func onBoards(_ f: CodeFile, text: String) async -> [CodeOnBoard] { places }

  func go(to card: CodeOnBoard) { went.append(card.card) }

  func segment(_ f: CodeFile, _ pick: CodePick) async -> Segment? {
    picks.append(pick)
    let lines = pick.text.components(separatedBy: "\n")[(pick.lines.lowerBound - 1)..<pick.lines.upperBound]
    return Segment(
      id: SegmentID(rawValue: "s\(picks.count)"), source: .file(path: f.path, hash: "h"), language: "python",
      firstLine: pick.lines.lowerBound, lines: Array(lines), symbol: pick.symbol, scope: pick.scope)
  }

  func counts(_ f: CodeFile, _ ranges: [ClosedRange<Int>]) -> [Int] {
    ranges.map { r in onBoard.filter { $0.overlaps(r) }.count }
  }

  func definitions(_ f: CodeFile, _ name: CodeName, scan: Bool) async -> [CodeDefinition] {
    asked.append((name, scan))
    return defs[name.name] ?? []
  }
}

@MainActor @Suite struct CodeCardsTests {
  init() { ReadingKinds.registerBuiltIn() }

  // MARK: What is taken

  func text(_ s: String = source) -> CodeReading.Text { CodeReading.Text(text: s, analysis: analyze("python", s)) }

  /// The offset of a line's column
  func at(_ t: CodeReading.Text, _ line: Int, _ col: Int) -> Int { t.starts[line - 1] + col }

  /// Partial first and last lines are taken whole; a selection that stops at a line's start leaves that line out;
  /// blank lines at the ends go; the function it is in names it, the module's top when it is in none
  @Test func aSelectionTakesTheWholeLinesItCovers() {
    let t = text()
    let p = CodeReading.pick(at(t, 3, 6)..<at(t, 4, 8), in: t)
    #expect(p?.lines == 3...4 && p?.scope == "helper" && p?.symbol == nil)
    #expect(CodeReading.pick(at(t, 3, 0)..<at(t, 5, 0), in: t)?.lines == 3...4, "the next line's start is not taken")
    #expect(CodeReading.pick(at(t, 3, 0)..<at(t, 6, 0), in: t)?.lines == 3...4, "blank lines at the end go")
    let top = CodeReading.pick(at(t, 1, 3)..<at(t, 3, 0), in: t)
    #expect(top?.lines == 1...1 && top?.symbol == Symbol(name: "<module>", kind: .module) && top?.scope == nil)
    #expect(CodeReading.pick(at(t, 2, 0)..<at(t, 2, 0), in: t) == nil, "nothing selected")
    #expect(CodeReading.pick(at(t, 5, 0)..<at(t, 6, 0), in: t) == nil, "only a blank line")
    #expect(CodeReading.pick(at(t, 11, 4)..<at(t, 12, 3), in: t)?.scope == "Engine.make.inner")
    #expect(t.place(at(t, 11, 4)) == (11, 4) && t.line(3) == "def helper(x):")
  }

  /// A function or class whole: its decorators with it, named by its qualified name; a nested function is its own;
  /// a plus shows on each line from the first decorator to the def line
  @Test func aFunctionIsTakenWholeWithItsDecoratorsByItsQualifiedName() throws {
    let t = text()
    let make = try #require(t.symbols.first { $0.name == "make" })
    let p = CodeReading.pick(make, in: t)
    #expect(p.lines == 8...12 && p.symbol == Symbol(name: "Engine.make", kind: .function) && p.scope == nil)
    let inner = try #require(t.symbols.first { $0.name == "inner" })
    #expect(CodeReading.pick(inner, in: t).lines == 10...11)
    let engine = try #require(t.symbols.first { $0.name == "Engine" })
    #expect(CodeReading.pick(engine, in: t).symbol == Symbol(name: "Engine", kind: .class))
    #expect(CodeReading.pick(engine, in: t).lines == 7...15)
    let heads = CodeReading.heads(t.symbols)
    #expect(heads[8]?.qual == "Engine.make" && heads[9]?.qual == "Engine.make")
    #expect(heads[10]?.qual == "Engine.make.inner")
    #expect(heads[3]?.qual == "helper" && heads[7]?.qual == "Engine" && heads[4] == nil && heads[11] == nil)
    #expect(symbolAtCursor(t.analysis, line: 11)?.qual == "Engine.make.inner", "⌥↵ in it takes the innermost")
  }

  /// The name under the pointer and the names joined to it before
  @Test func theNameAtAColumnAndItsReceiver() {
    func n(_ line: String, _ col: Int) -> String? {
      CodeReading.name(at: col, in: line[...]).map { "\($0.name)|\($0.receiver ?? "")|\($0.range)" }
    }
    #expect(n("    return self.scheduler.schedule(x)", 28) == "schedule|self.scheduler|26..<34")
    #expect(n("    return self.scheduler.schedule(x)", 11) == "self||11..<15")
    #expect(n("  at::native::add(a, b);", 15) == "add|at::native|14..<17")
    #expect(n("x = 12 + f(y)", 4) == nil, "a number")
    #expect(n("x = 12 + f(y)", 7) == nil, "a space")
    #expect(n("x = 12 + f(y)", 9) == "f||9..<10")
  }

  // MARK: A tab

  @MainActor final class Tab {
    let pane: ReadingPane
    let view: CodeTabView
    let window: NSWindow
    let root: URL
    let paneView: ReadingPaneView
    var collected: [Collected] = []

    @MainActor init(_ host: FakeHostBox) async throws {
      root = FileManager.default.temporaryDirectory.appending(path: "cb-codecards-\(UUID().uuidString)")
      try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
      try Data(source.utf8).write(to: root.appending(path: "a.py"))
      try Data("\n\n\n\ndef other_fn():\n    pass\n".utf8).write(to: root.appending(path: "b.py"))
      pane = ReadingPane()
      pane.codeHost = host.host
      let pv = ReadingPaneView(pane: pane)
      paneView = pv
      pv.frame = CGRect(x: 0, y: 0, width: 520, height: 420)
      pane.openCode(CodeFile(repository: root.path, name: "repo", path: "a.py"), preview: false)
      pv.sync()
      view = try #require(pv.views[pane.tabs[0].id] as? CodeTabView)
      window = NSWindow(contentRect: pv.frame, styleMask: [.borderless], backing: .buffered, defer: true)
      window.isReleasedWhenClosed = false
      window.contentView = pv
      let v = view
      try await until("the file read") { v.code != nil }
      pv.layoutSubtreeIfNeeded()
      pane.onCollect = { [unowned self] in self.collected.append($0) }
    }

    @MainActor func close() {
      window.close()
      try? FileManager.default.removeItem(at: root)
    }

    /// Where a line's column is, in the window
    @MainActor func point(_ line: Int, _ col: Int) throws -> CGPoint {
      let v = try #require(view.code)
      let t = try #require(view.text)
      let q = t.starts[line - 1] + col
      let r = try #require(v.layout.rects(q..<(q + 1), right: v.bounds.width).first)
      return v.convert(CGPoint(x: r.midX, y: r.midY), to: nil)
    }

    @MainActor func event(_ type: NSEvent.EventType, _ p: CGPoint, _ mods: NSEvent.ModifierFlags = [], clicks: Int = 1)
      throws -> NSEvent
    {
      try #require(
        NSEvent.mouseEvent(
          with: type, location: p, modifierFlags: mods, timestamp: 0, windowNumber: window.windowNumber, context: nil,
          eventNumber: 0, clickCount: clicks, pressure: 1))
    }

    /// A press, dragged to `to` when given, let go
    @MainActor func press(_ from: CGPoint, to: CGPoint? = nil, _ mods: NSEvent.ModifierFlags = []) throws {
      view.page.mouseDown(with: try event(.leftMouseDown, from, mods))
      if let to { view.page.mouseDragged(with: try event(.leftMouseDragged, to, mods)) }
      view.page.mouseUp(with: try event(.leftMouseUp, to ?? from, mods))
    }

    /// The pointer over a point of the window
    @MainActor func hover(_ p: CGPoint, command: Bool = false) {
      view.hover(at: view.convert(p, from: nil), command: command)
    }

    @MainActor func optionReturn() throws {
      let key = try #require(
        NSEvent.keyEvent(
          with: .keyDown, location: .zero, modifierFlags: [.option], timestamp: 0, windowNumber: window.windowNumber,
          context: nil, characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36))
      view.keyDown(with: key)
    }

    var segments: [Segment] {
      collected.compactMap { if case .code(let s) = $0.body { s } else { nil } }
    }
  }

  /// The fake, reachable from the tab's helpers
  @MainActor final class FakeHostBox {
    fileprivate let host = FakeHost()
  }

  /// A selection made with the mouse gets the bar over its first line; Add to Board takes its whole lines to the
  /// board, and again a second card; its card is made ready for a drag out
  @Test func theSelectionsBarAddsItsWholeLinesEachTimeANewCard() async throws {
    let box = FakeHostBox()
    let tab = try await Tab(box)
    defer { tab.close() }
    #expect(box.host.opened == [tab.root.path], "the repository's names indexed")
    try tab.press(try tab.point(3, 6), to: try tab.point(4, 8))
    let v = tab.view
    #expect(v.code?.editor.selection.isEmpty == false && !v.selectionBar.isHidden)
    let code = try #require(v.code)
    let lines = code.layout.rects(code.editor.selection.range, right: 520).map { v.convert($0, from: code) }
    try #require(lines.count == 2, "its two lines")
    #expect(!lines.contains { $0.intersects(v.selectionBar.frame) }, "beside its lines, not over them")
    #expect(v.selectionBar.frame.minY > lines[1].maxY, "below: no room above under the top glass")
    let add = try #require(v.selectionBar.buttons.first)
    #expect(add.isEnabled && add.toolTip == "Add to Board ⌥↵")
    try await until("ready for a drag") { v.prepared != nil }
    #expect(v.prepared?.selection == v.code?.editor.selection.range)
    add.performClick(nil)
    try await until("on the board") { tab.collected.count == 1 }
    let s = try #require(tab.segments.first)
    #expect(s.firstLine == 3 && s.lines == ["def helper(x):", "    return x + 1"] && s.scope == "helper")
    add.performClick(nil)
    try await until("a second card") { tab.collected.count == 2 }
    #expect(tab.segments.map(\.firstLine) == [3, 3] && tab.segments[0].id != tab.segments[1].id)
    // a click elsewhere: no selection, no bar
    try tab.press(try tab.point(12, 4))
    #expect(v.code?.editor.selection.isEmpty == true && v.selectionBar.isHidden)
  }

  /// ⌥↵ takes the selection; without one the function (the innermost) the last press was in; before any press nothing
  @Test func optionReturnAddsTheSelectionOrTheFunctionThePressWasIn() async throws {
    let box = FakeHostBox()
    let tab = try await Tab(box)
    defer { tab.close() }
    try tab.optionReturn()
    #expect(box.host.picks.isEmpty, "no press yet")
    try tab.press(try tab.point(11, 10))
    try tab.optionReturn()
    try await until("the function added") { tab.collected.count == 1 }
    #expect(box.host.picks[0].lines == 10...11 && box.host.picks[0].symbol?.name == "Engine.make.inner")
    try tab.press(try tab.point(14, 4), to: try tab.point(15, 6))
    try tab.optionReturn()
    try await until("the selection added") { tab.collected.count == 2 }
    #expect(box.host.picks[1].lines == 14...15 && box.host.picks[1].scope == "Engine.step")
  }

  /// Over a head line (a decorator or the def), the plus is at its number; pressed, the whole function
  @Test func thePlusAtAHeadLineAddsTheWholeFunction() async throws {
    let box = FakeHostBox()
    let tab = try await Tab(box)
    defer { tab.close() }
    let v = tab.view
    tab.hover(try tab.point(8, 6))
    #expect(!v.plus.isHidden && v.plusSym?.qual == "Engine.make" && v.plus.isEnabled)
    #expect(v.plus.toolTip == "Add Engine.make to the Board")
    let row = v.convert(try tab.point(8, 6), from: nil).y
    #expect(abs(v.plus.frame.midY - row) < 1, "on its line")
    let gutter = try #require(v.code).gutter
    #expect(v.plus.frame.maxX <= v.convert(CGPoint(x: gutter, y: 0), from: v.code).x, "in the gutter")
    tab.hover(try tab.point(4, 6))
    #expect(v.plus.isHidden && v.plusSym == nil)
    tab.hover(try tab.point(9, 6))
    v.plus.performClick(nil)
    try await until("added") { tab.collected.count == 1 }
    #expect(box.host.picks[0].lines == 8...12)
    #expect(box.host.picks[0].symbol == Symbol(name: "Engine.make", kind: .function))
    tab.hover(try tab.point(9, 6))
    tab.view.mouseExited(with: try tab.event(.mouseMoved, .zero))
    #expect(v.plus.isHidden)
  }

  /// The outline's rows count the board's cards showing their lines and add their function whole
  @Test func theOutlineCountsTheCardsShowingAFunctionAndAddsItWhole() async throws {
    let box = FakeHostBox()
    box.host.onBoard = [3...4, 3...3, 14...15]
    let tab = try await Tab(box)
    defer { tab.close() }
    let v = tab.view
    v.toggleOutline(nil)
    let names = v.list.items.map(\.title)
    let counts = Dictionary(uniqueKeysWithValues: zip(names, v.list.items.map(\.count)))
    #expect(counts == ["helper": 2, "Engine": 1, "make": 0, "inner": 0, "step": 1])
    #expect(v.list.items.allSatisfy(\.adds) && v.list.counts.compactMap { $0 }.map(\.stringValue) == ["2", "1", "1"])
    let add = try #require(v.list.adders[names.firstIndex(of: "make")!])
    add.performClick(nil)
    try await until("added") { tab.collected.count == 1 }
    #expect(box.host.picks[0].lines == 8...12 && v.listing == .outline, "the outline stays")
  }

  /// With no board in front every add is disabled and adds nothing
  @Test func withoutABoardTheAddsAreDisabled() async throws {
    let box = FakeHostBox()
    box.host.canAdd = false
    let tab = try await Tab(box)
    defer { tab.close() }
    let v = tab.view
    try tab.press(try tab.point(3, 6), to: try tab.point(4, 8))
    let add = try #require(v.selectionBar.buttons.first)
    #expect(!v.selectionBar.isHidden && !add.isEnabled && add.toolTip == CodeList.noBoard)
    try tab.optionReturn()
    tab.hover(try tab.point(3, 2))
    #expect(!v.plus.isHidden && !v.plus.isEnabled)
    v.plusPressed(nil)
    v.toggleOutline(nil)
    #expect(!v.list.addsEnabled)
    v.addOutlineRow(0)
    await Task.yield()
    #expect(box.host.picks.isEmpty && tab.collected.isEmpty && v.prepared == nil)
  }

  /// ⌘ over a name it can go to: underlined; one the file defines at once, another once the shell knows it; none
  /// for a name with no definition
  @Test func commandOverANameUnderlinesItWhenItHasADefinition() async throws {
    let box = FakeHostBox()
    box.host.defs["other_fn"] = [CodeDefinition(path: "b.py", line: 5, label: "other_fn", detail: "b.py:5")]
    let tab = try await Tab(box)
    defer { tab.close() }
    let v = tab.view
    v.go(to: 70)
    tab.hover(try tab.point(80, 6), command: true)
    #expect(!v.underline.isHidden && v.pointed?.name.name == "helper", "the file's own function")
    let word = try #require(v.code).layout.rects(v.pointed!.range, right: 1000).first!
    #expect(abs(v.underline.frame.width - word.width) < 0.5 && v.underline.frame.minY > word.midY)
    tab.hover(try tab.point(80, 6), command: false)
    #expect(v.underline.isHidden && v.pointed == nil, "⌘ let go")
    tab.hover(try tab.point(80, 18), command: true)
    try await until("the shell's answer") { v.pointed?.name.name == "other_fn" }
    #expect(!v.underline.isHidden && box.host.asked.last.map { !$0.1 } == true, "only what is indexed is asked")
    tab.hover(try tab.point(80, 29), command: true)
    try await until("asked") { box.host.asked.last?.0.name == "os" }
    await Task.yield()
    #expect(v.underline.isHidden && v.pointed == nil, "os has none")
  }

  /// ⌘-click: one definition is gone to, in this file or in a kept tab of its own; several are a list at the click;
  /// Back comes back to where the click was; a name with none does nothing
  @Test func commandClickGoesToTheDefinitionAndBackComesBack() async throws {
    let box = FakeHostBox()
    box.host.defs["helper"] = [CodeDefinition(path: "a.py", line: 3, label: "helper", detail: "a.py:3")]
    box.host.defs["other_fn"] = [CodeDefinition(path: "b.py", line: 5, label: "other_fn", detail: "b.py:5")]
    box.host.defs["step"] = [
      CodeDefinition(path: "a.py", line: 14, label: "Engine.step", detail: "a.py:14"),
      CodeDefinition(path: "b.py", line: 1, label: "Other.step", detail: "b.py:1"),
    ]
    let tab = try await Tab(box)
    defer { tab.close() }
    let v = tab.view
    v.go(to: 70)
    try tab.press(try tab.point(80, 6), [.command])
    try await until("gone to helper") { v.topLine == 3 }
    #expect(box.host.asked.last?.1 == true && v.bar.back.isEnabled && v.code?.editor.selection.isEmpty == true)
    v.goBack(nil)
    #expect(v.topLine == 70)
    try tab.press(try tab.point(80, 29), [.command])
    try await until("os asked") { box.host.asked.last?.0.name == "os" }
    await Task.yield()
    #expect(v.topLine == 70 && v.listing == nil && tab.pane.tabs.count == 1, "nothing for os")
    try tab.press(try tab.point(80, 39), [.command])
    try await until("the list") { v.listing == .definitions }
    #expect(v.list.items.map(\.title) == ["Engine.step", "Other.step"] && v.list.selected == 0)
    let click = v.convert(try tab.point(80, 39), from: nil)
    #expect(v.list.frame.minY > click.y || v.list.frame.maxY < click.y, "beside the name, not over it")
    let row = v.list.rows[0]
    NSApp.sendAction(try #require(row.action), to: row.target, from: row)
    #expect(v.listing == nil && v.topLine == 14)
    v.goBack(nil)
    try tab.press(try tab.point(80, 18), [.command])
    try await until("b.py open") { tab.pane.tabs.count == 2 }
    let b = tab.pane.tabs[1]
    #expect(tab.pane.selected == b.id && !b.preview && tab.pane.currentCode?.path == "b.py", "kept")
  }

  // MARK: Lines on boards

  static func on(_ board: String, here: Bool, _ card: String, _ lines: ClosedRange<Int>, commit: String? = nil)
    -> CodeOnBoard
  {
    CodeOnBoard(
      board: BoardID(rawValue: board), boardName: board.capitalized, here: here, card: CardID(rawValue: card),
      title: card, lines: lines, range: "\(lines.lowerBound)–\(lines.upperBound)", commit: commit)
  }

  /// A line on a card of the board in front is marked as such, also when other boards have it; a line only on other
  /// boards as theirs; runs of lines are drawn as one
  @Test func theBoardInFrontsLinesWinOverTheOtherBoards() {
    let m = CodeReading.marks([
      Self.on("b", here: false, "o1", 3...6), Self.on("a", here: true, "h1", 5...8),
      Self.on("b", here: false, "o2", 20...20),
    ])
    #expect(m.here == Set(5...8) && m.other == Set([3, 4, 20]))
    #expect(CodeReading.runs(m.other) == [3...4, 20...20] && CodeReading.runs([]) == [])
  }

  /// The list: the board in front first (as This Board), then the other boards in the shell's order, each board's
  /// cards by where their lines start; a card from an older commit says it. One card of the board in front alone is
  /// gone to with no list
  @Test func theCardsOfALineAreListedByBoardTheBoardInFrontFirst() {
    let all = [
      Self.on("b", here: false, "late", 30...40), Self.on("c", here: false, "c1", 1...50, commit: "abc1234"),
      Self.on("b", here: false, "early", 10...35), Self.on("a", here: true, "mine", 32...33),
      Self.on("a", here: true, "away", 90...99),
    ]
    let cs = CodeReading.cards(on: 33...33, all)
    #expect(cs.map(\.card.rawValue) == ["mine", "early", "late", "c1"])
    let rows = CodeReading.rows(cs)
    #expect(rows.map(\.item.title) == ["This Board", "mine", "B", "early", "late", "C", "c1"])
    #expect(rows.map(\.item.heading) == [true, false, true, false, false, true, false])
    #expect(rows.last?.item.detail == "1–50 @ abc1234" && rows[1].item.detail == "32–33")
    #expect(CodeReading.straight(CodeReading.cards(on: 95...95, all))?.card.rawValue == "away")
    #expect(CodeReading.straight(CodeReading.cards(on: 12...12, all)) == nil, "only on another board: listed")
    #expect(CodeReading.straight(cs) == nil)
  }

  /// Where a line's thin line is, in the window
  @MainActor func mark(_ tab: Tab, _ line: Int) throws -> CGPoint {
    let v = try #require(tab.view.code)
    let r = try #require(v.frame(ofLines: line...line)?.rect)
    return v.convert(CGPoint(x: CodeMarks.x + 1, y: r.midY), to: nil)
  }

  /// The thin lines as the shell says, drawn again when it says the boards changed; a press on one card's line of
  /// the board in front goes to it, on lines of several cards lists them, a row goes to its card
  @Test func theThinLinesGoToTheirCardOrListTheCards() async throws {
    let box = FakeHostBox()
    box.host.places = [Self.on("a", here: true, "one", 3...4)]
    let tab = try await Tab(box)
    defer { tab.close() }
    let v = tab.view
    try await until("marked") { v.marks.here.path?.isEmpty == false }
    #expect(v.marks.other.path?.isEmpty != false)
    let here = try #require(v.marks.here.path?.boundingBoxOfPath)
    let lines = try #require(v.code?.frame(ofLines: 3...4)?.rect)
    #expect(abs(here.midY - lines.midY) < 1 && here.minX == CodeMarks.x && here.width == CodeMarks.width)
    tab.hover(try mark(tab, 3))
    #expect(v.listing == nil, "one card of this board: no list")
    try tab.press(try mark(tab, 3))
    #expect(box.host.went == [CardID(rawValue: "one")] && v.code?.editor.selection.isEmpty == true)
    // another board's card on the same lines, told
    box.host.places.append(Self.on("b", here: false, "two", 4...9))
    NotificationCenter.default.post(name: CodeReading.boardsChanged, object: tab.pane)
    try await until("drawn again") { v.marks.other.path?.isEmpty == false }
    tab.hover(try mark(tab, 4))
    #expect(v.listing == .places && v.list.items.map(\.title) == ["This Board", "one", "B", "two"])
    tab.hover(try tab.point(12, 4))
    #expect(v.listing == nil, "left, closed")
    try tab.press(try mark(tab, 4))
    #expect(v.listing == .places && v.list.selected == 1, "pinned, its first card chosen")
    let row = v.list.rows[3]
    NSApp.sendAction(try #require(row.action), to: row.target, from: row)
    #expect(box.host.went.last == CardID(rawValue: "two") && v.listing == nil)
    // a line on no card: nothing
    tab.hover(try mark(tab, 20))
    #expect(v.listing == nil)
  }

  /// The selection's bar counts the cards showing its lines beside Add to Board, none with none; the count lists them
  @Test func theSelectionsBarCountsTheCardsShowingItsLines() async throws {
    let box = FakeHostBox()
    box.host.places = [Self.on("a", here: true, "one", 3...4), Self.on("b", here: false, "two", 4...9)]
    let tab = try await Tab(box)
    defer { tab.close() }
    let v = tab.view
    try await until("marked") { v.marks.here.path?.isEmpty == false }
    try tab.press(try tab.point(3, 6), to: try tab.point(4, 8))
    v.layoutSubtreeIfNeeded()
    let count = v.selectionBar.buttons[1]
    #expect(!count.isHidden && count.title == "2" && count.toolTip == "On 2 cards: show where")
    #expect(count.frame.minX >= v.selectionBar.buttons[0].frame.maxX, "beside Add to Board")
    count.performClick(nil)
    #expect(v.listing == .places && v.list.items.map(\.title) == ["This Board", "one", "B", "two"])
    #expect(v.list.frame.minY >= v.selectionBar.frame.maxY || v.list.frame.maxY <= v.selectionBar.frame.minY)
    try tab.press(try tab.point(20, 2), to: try tab.point(21, 3))
    #expect(v.selectionBar.buttons[1].isHidden, "no card shows these")
  }

  /// A card's lines located in its file's tab: brought into view and marked a moment, the bar's quiet line saying
  /// which commit the card is from; asked before the file is read, done once it is
  @Test func aCardsLinesAreLocatedInAKeptTab() async throws {
    let box = FakeHostBox()
    let tab = try await Tab(box)
    defer { tab.close() }
    let b = CodeFile(repository: tab.root.path, name: "repo", path: "b.py")
    tab.pane.openCode(b, locating: 5...6, note: "Card from abc1234")
    let id = try #require(tab.pane.selected)
    #expect(tab.pane.tabs.count == 2 && tab.pane.tabs.first { $0.id == id }?.preview == false)
    tab.paneView.sync()
    try await until("located") { CodeTabView.live[id]?.view?.code != nil }
    let v = try #require(CodeTabView.live[id]?.view)
    try await until("marked") { v.flashView.layer?.animation(forKey: "flash") != nil }
    #expect(v.bar.note == "Card from abc1234")
    let f = try #require(v.code?.frame(ofLines: 5...6)?.rect)
    #expect(abs(v.flashView.frame.minY - f.minY) < 0.5 && abs(v.flashView.frame.height - f.height) < 0.5)
  }
}
