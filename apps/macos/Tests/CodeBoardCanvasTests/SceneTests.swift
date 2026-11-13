import CodeBoardModel
import CodeBoardSyntax
import CoreGraphics
import Foundation
import Testing

@testable import CodeBoardCanvas

private let metrics = CodeMetrics(charWidth: 6.6)
private let highlighter = Highlighter()

/// Each line row's text and the text its tokens cover
private func coloured(_ l: CodeLayout) -> [(text: String, tokens: [String: TokenClass])] {
  l.rows.compactMap { p in
    guard case .line(_, _, let text, let tokens) = p.row else { return nil }
    let units = Array(text.utf16)
    var covered: [String: TokenClass] = [:]
    for t in tokens { covered[String(decoding: units[t.columns], as: UTF16.self)] = t.kind }
    return (text, covered)
  }
}

private func segment(_ id: String, path: String? = "src/engine.py", first: Int, _ lines: [String]) -> Segment {
  Segment(
    id: SegmentID(rawValue: id),
    source: path.map { .git(repository: nil, commit: "c0ffee", path: $0, uncommitted: false, checkout: "") },
    language: "python", firstLine: first, lines: lines)
}

@Suite struct CodeLayoutTests {
  @Test func hiddenRangesAndTheGapsBetweenSegmentsBecomeRows() {
    var a = segment("a", first: 8, ["def f():", "    x = 1", "    y = 2", "    return x"])
    a.hidden = [9...10]
    let b = segment("b", first: 20, ["def g():"])
    let l = CodeLayout(CodeCard(segments: [a, b]), width: 400, metrics: metrics)
    #expect(
      l.rows.map(\.row) == [
        .line(segment: 0, number: 8, text: "def f():"), .gap(from: 9, to: 10),
        .line(segment: 0, number: 11, text: "    return x"), .gap(from: 12, to: 19),
        .line(segment: 1, number: 20, text: "def g():"),
      ])
    // 6 padding, 20 + 24 + 20 + 24 + 20 rows and gaps, 8 padding
    #expect(l.height == 122)
    #expect(l.lineY(segment: 0, line: 11) == 60)
    #expect(l.lineY(segment: 0, line: 9) == nil)
  }

  @Test func anotherFileOrFunctionIsMarked() {
    let a = segment("a", first: 1, ["x"])
    let b = segment("b", path: "src/other.py", first: 2, ["y"])
    var c = segment("c", path: "src/other.py", first: 3, ["z"])
    c.scope = "Engine.step"
    let l = CodeLayout(CodeCard(segments: [a, b, c]), width: 400, metrics: metrics)
    #expect(l.rows.map(\.row)[1] == .file("src/other.py"))
    #expect(l.rows.map(\.row)[3] == .function("def step"))
  }

  @Test func blankLinesHideAndTabsExpand() {
    let s = segment("a", first: 1, ["a", "   ", "\tb"])
    let l = CodeLayout(CodeCard(segments: [s], hide: HideFlags(blankLines: true)), width: 400, metrics: metrics)
    #expect(
      l.rows.map(\.row) == [.line(segment: 0, number: 1, text: "a"), .line(segment: 0, number: 3, text: "    b")])
  }

  @Test func wrappedLinesContinueWithoutANumber() {
    let s = segment("a", first: 98, [String(repeating: "x", count: 50)])
    // gutter: 17 + 2 digits × 6.6 + 22 = 52.2; 66 px of code is 10 characters
    let l = CodeLayout(CodeCard(segments: [s], wrap: true), width: 52.2 + 66 + 18 + 1, metrics: metrics)
    #expect(l.gutter == 17 + 2 * 6.6 + 22)
    #expect(l.rows.count == 5)
    #expect(l.rows.dropFirst().allSatisfy { if case .line(_, nil, _, _) = $0.row { true } else { false } })
  }

  @Test func tokensKeepTheirCharactersThroughTabsWideTextAndHiddenLines() {
    // columns are UTF-16 within the original line: the emoji is two units, the tab one
    var s = segment("a", first: 1, ["\tx = 1  # 注释 🙂 ok", "hidden", "y = '中'"])
    s.hidden = [2...2]
    let tokens: [[Token]] = [
      [Token(columns: 1..<2, kind: .keyword), Token(columns: 8..<18, kind: .comment)],
      [Token(columns: 0..<6, kind: .string)],
      [Token(columns: 4..<7, kind: .string)],
    ]
    let rows = coloured(CodeLayout(CodeCard(segments: [s]), tokens: [tokens], width: 400, metrics: metrics))
    #expect(rows.map(\.text) == ["    x = 1  # 注释 🙂 ok", "y = '中'"])
    #expect(rows[0].tokens == ["x": .keyword, "# 注释 🙂 ok": .comment])
    #expect(rows[1].tokens == ["'中'": .string])
  }

  @Test func aWrappedLinesTokensSplitAtTheWrap() {
    // 10 characters a row; the string runs from column 4 to 23, over all three rows
    let line = "x = '一二三四五六七八九十一二三四五六七八' + y"
    let s = segment("a", first: 98, [line])
    let units = line.utf16.count
    let tokens: [[Token]] = [
      [Token(columns: 4..<24, kind: .string), Token(columns: units - 1..<units, kind: .function)]
    ]
    let l = CodeLayout(
      CodeCard(segments: [s], wrap: true), tokens: [tokens], width: 52.2 + 66 + 18 + 1, metrics: metrics)
    let rows = coloured(l)
    #expect(rows.map(\.text) == ["x = '一二三四五", "六七八九十一二三四五", "六七八' + y"])
    #expect(rows.map(\.tokens) == [["'一二三四五": .string], ["六七八九十一二三四五": .string], ["六七八'": .string, "y": .function]])
  }

  @Test func theHighlighterColoursACardsRows() {
    let s = segment("a", first: 1, ["def f(self):  # 注释", "    return 1"])
    let code = CodeCard(segments: [s])
    let tokens = code.segments.map { highlighter.tokens(lines: $0.lines, language: $0.language) }
    let rows = coloured(CodeLayout(code, tokens: tokens, width: 400, metrics: metrics))
    #expect(rows[0].tokens["def"] == .keyword && rows[0].tokens["f"] == .function)
    #expect(rows[0].tokens["self"] == .receiver && rows[0].tokens["# 注释"] == .comment)
    #expect(rows[1].tokens["return"] == .keyword && rows[1].tokens["1"] == .number)
  }

  @Test func highlightsBandTheirShownRows() {
    var s = segment("a", first: 1, ["a", "b", "c", "d"])
    s.highlights = [2...3]
    let l = CodeLayout(CodeCard(segments: [s]), width: 400, metrics: metrics)
    #expect(l.bands == [26...66])
  }
}

@Suite struct SceneTests {
  let vault = Vault(root: URL(filePath: "/nonexistent-vault"))

  func card(_ id: String, x: Double, y: Double, width: Double = 300, height: Double? = nil, _ body: CardContent.Body)
    -> Card
  {
    Card(id: CardID(rawValue: id), x: x, y: y, width: width, height: height, content: .own(CardContent(body: body)))
  }

  func scene(_ b: Board) -> Scene {
    try! Scene(
      b, package: URL(filePath: "/nonexistent-vault/B.board"), vault: vault, theme: .warmInk,
      highlighter: highlighter)
  }

  @Test func aCodeCardWithoutAHeightGrowsWithItsCodeUpToTheCap() {
    let short = card("s", x: 0, y: 0, .code(CodeCard(segments: [segment("a", first: 1, ["x", "y"])])))
    let long = card(
      "l", x: 400, y: 0, .code(CodeCard(segments: [segment("a", first: 1, Array(repeating: "x", count: 100))])))
    let fixed = card("f", x: 800, y: 0, height: 100, .code(CodeCard(segments: [segment("a", first: 1, ["x"])])))
    let s = scene(Board(id: BoardID(rawValue: "b"), cards: [short, long, fixed]))
    let heights: [CGFloat] = [90, 496, 136]
    #expect(s.items.map(\.rect.height) == heights)
    #expect(s.bounds == CGRect(x: 0, y: 0, width: 1100, height: 496))
  }

  @Test func anArrowFromALineLeavesFromThatRowAndSkipsMissingSharedCards() {
    let code = card("c", x: 0, y: 0, .code(CodeCard(segments: [segment("a", first: 10, ["a", "b", "c"])])))
    let note = card("n", x: 600, y: 0, height: 120, .note(Note(text: "# Idea")))
    let gone = Card(id: CardID(rawValue: "gone"), x: 0, y: 500, width: 300, content: .shared)
    let arrows = [
      Arrow(
        id: ArrowID(rawValue: "a"), from: Endpoint(card: code.id, segment: SegmentID(rawValue: "a"), line: 11),
        to: Endpoint(card: note.id), label: "next"),
      Arrow(id: ArrowID(rawValue: "b"), from: Endpoint(card: note.id), to: Endpoint(card: gone.id)),
    ]
    let s = scene(Board(id: BoardID(rawValue: "b"), cards: [code, note, gone], arrows: arrows))
    #expect(s.missing == [gone.id])
    #expect(s.arrows.count == 1)
    // line 11 is the second row: 36 header + 6 padding + 20 + half a row
    let line = s.arrows[0].fill.cg.boundingBoxOfPath
    #expect(abs(line.minX - 300) < 2 && line.minY < 72 && line.maxY > 72)
    #expect(!s.arrows[0].heads.isEmpty)
    #expect(s.cardsFrom == 0 && s.labelsFrom == 2)
    guard case .label(let l)? = s.items.last?.drawing else {
      Issue.record("no label")
      return
    }
    #expect(l.text == "next" && l.kind == .arrow)
    if case .note(let n) = s.items[1].drawing { #expect(n.title == "Idea") }
  }

  @Test func sectionsGetAFrameAndATitle() {
    let s = scene(
      Board(
        id: BoardID(rawValue: "b"),
        sections: [
          Section(id: SectionID(rawValue: "s"), title: "Step", x: 10, y: 20, width: 500, height: 300, color: "blue")
        ]))
    #expect(s.frames.map(\.rect) == [CGRect(x: 10, y: 20, width: 500, height: 300)])
    #expect(s.frames[0].fill == Theme.warmInk.sectionColors["blue"])
    #expect(s.items.first?.rect.origin == CGPoint(x: 26, y: 26))
  }
}

@Suite struct ByteLRUTests {
  @Test func theLeastRecentlyUsedGoFirstAndTheNewestStays() {
    var l = ByteLRU<String>(cap: 100)
    #expect(l.insert("a", bytes: 40).isEmpty)
    #expect(l.insert("b", bytes: 40).isEmpty)
    l.touch("a")
    #expect(l.insert("c", bytes: 40) == ["b"])
    #expect(l.insert("huge", bytes: 500) == ["a", "c"])
    #expect(l.contains("huge") && l.bytes == 500)
  }
}
