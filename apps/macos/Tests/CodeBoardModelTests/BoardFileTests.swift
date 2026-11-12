import CodeBoardModel
import Foundation
import Testing

private let file = URL(filePath: "/vault/A.board/board.json")

/// A board with every kind of thing model v1 holds
private func everything() -> Board {
  let seg = Segment(
    id: SegmentID(rawValue: "s1"),
    source: .git(
      repository: "https://github.com/x/y", commit: "abc", path: "a.py", uncommitted: true, checkout: nil),
    language: "python", firstLine: 10, lines: ["def f():", "    pass"], symbol: Symbol(name: "f", kind: .function),
    scope: "M", hidden: [11...11], highlights: [10...10],
    annotations: [Annotation(line: 10, from: 0, to: 3, text: "def", color: .green, below: true)])
  let code = CardContent(
    title: "F", description: "d", processes: [ProcessTag(text: "rank 0", light: true)],
    body: .code(
      CodeCard(
        segments: [
          seg,
          Segment(
            id: SegmentID(rawValue: "s2"), source: .package(name: "torch", version: "2", path: "t.py"),
            language: "python", firstLine: 1, lines: ["x"]),
          Segment(
            id: SegmentID(rawValue: "s3"), source: .file(path: "/abs/f.c", hash: nil), language: "c", firstLine: 1,
            lines: ["y"]),
          Segment(id: SegmentID(rawValue: "s4"), source: nil, language: "c", firstLine: 1, lines: []),
        ], hide: HideFlags(comments: true, docstrings: true, blankLines: true), wrap: true, framed: false)))
  let notes: [NoteStyle] = [
    .note, .text(size: .title, bold: true), .box(fill: .pink), .mark(color: .orange, weight: .bold, fontSize: 30),
    .freeText(level: 1, bold: false, fontSize: nil),
  ]
  var cards = [
    Card(
      id: CardID(rawValue: "c"), x: 1.5, y: -2, width: 300, height: 120, section: SectionID(rawValue: "sec"),
      locked: true, tilted: true, content: .own(code)),
    Card(
      id: CardID(rawValue: "img"), x: 0, y: 0, width: 10,
      content: .own(
        CardContent(body: .image(ImageCard(source: .file("p.png"), alt: "a", framed: true, stillFrame: 3, loops: true)))
      )
    ),
    Card(
      id: CardID(rawValue: "url"), x: 0, y: 0, width: 10,
      content: .own(CardContent(body: .image(ImageCard(source: .url("https://e/p.png")))))),
    Card(id: CardID(rawValue: "sh"), x: 0, y: 0, width: 10, content: .shared),
  ]
  for (i, style) in notes.enumerated() {
    let layout = i == 0 ? NoteLayout(tables: [nil, NoteLayout.Table(cols: [1, nil])], wrap: [2]) : nil
    cards.append(
      Card(
        id: CardID(rawValue: "n\(i)"), x: 0, y: 0, width: 10,
        content: .own(CardContent(body: .note(Note(text: "# T\n\nx", style: style, layout: layout))))))
  }
  return Board(
    id: BoardID(rawValue: "b"), cards: cards,
    arrows: [
      Arrow(
        id: ArrowID(rawValue: "a1"),
        from: Endpoint(card: CardID(rawValue: "c"), segment: SegmentID(rawValue: "s1"), line: 10, side: .right),
        to: Endpoint(card: CardID(rawValue: "n0"), block: BlockRef(index: 1, hash: "h"), lost: true), label: "l",
        labelPosition: 0.3, dashed: true, width: 1, startHead: true, endHead: false, color: "red"),
      Arrow(
        id: ArrowID(rawValue: "a2"), from: Endpoint(card: CardID(rawValue: "sh")),
        to: Endpoint(card: CardID(rawValue: "img"))),
    ],
    sections: [
      Section(id: SectionID(rawValue: "top"), title: "Top", x: 0, y: 0, width: 100, height: 100),
      Section(
        id: SectionID(rawValue: "sec"), title: "S", x: 1, y: 2, width: 3, height: 4, parent: SectionID(rawValue: "top"),
        color: "blue", collapsed: true, locked: true, description: "d"),
    ], hideComments: true, hideLineNumbers: true)
}

@Test func boardRoundTripsThroughItsFile() throws {
  let board = everything()
  let data = try board.encoded()
  #expect(try Board(decoding: data, file: file) == board)
  #expect(try Board(decoding: data, file: file).encoded() == data)
}

@Test func boardFileIsSortedIndentedAndEndsWithANewline() throws {
  let text = String(decoding: try Board(id: BoardID(rawValue: "b")).encoded(), as: UTF8.self)
  #expect(
    text == """
      {
        "arrows": [],
        "cards": [],
        "hideComments": false,
        "hideLineNumbers": false,
        "id": "b",
        "sections": [],
        "version": 1
      }

      """)
  let full = String(decoding: try everything().encoded(), as: UTF8.self)
  #expect(full.contains("\"hidden\": [\n") && full.contains("[11, 11]"), "line ranges stay on one line")
  #expect(full.contains("\"cols\": [1, null]"))
  #expect(full.contains("\"lines\": [\n"), "code is one line per line, for diffs")
}

@Test func sharedCardRoundTripsThroughItsFile() throws {
  let card = SharedCard(id: CardID(rawValue: "s"), content: CardContent(body: .note(Note(text: "x"))))
  let data = try card.encoded()
  #expect(try SharedCard(decoding: data, file: file) == card)
}

/// The board's JSON with `change` applied to it
private func edited(_ change: (inout [String: Any]) -> Void) throws -> Data {
  var json = try #require(try JSONSerialization.jsonObject(with: try everything().encoded()) as? [String: Any])
  change(&json)
  return try JSONSerialization.data(withJSONObject: json)
}

private func card(_ json: inout [String: Any], _ i: Int, _ change: (inout [String: Any]) -> Void) {
  var cards = json["cards"] as? [[String: Any]] ?? []
  change(&cards[i])
  json["cards"] = cards
}

@Test func decodingRejectsWhatTheWriterWouldNotWrite() throws {
  let cases: [(String, (inout [String: Any]) -> Void)] = [
    ("cards[1].extra: not part of the format (unknown field or null)", { j in card(&j, 1) { $0["extra"] = 1 } }),
    (
      "cards[0].height: not part of the format (unknown field or null)",
      { j in card(&j, 0) { $0["height"] = NSNull() } }
    ),
    ("cards[1].locked: missing", { j in card(&j, 1) { $0["locked"] = nil } }),
    ("hideComments: missing", { $0["hideComments"] = nil }),
  ]
  for (message, change) in cases {
    #expect(throws: VaultError.malformed(file, message)) { try Board(decoding: try edited(change), file: file) }
  }
  #expect(throws: VaultError.unsupportedVersion(file, 2)) {
    try Board(decoding: try edited { $0["version"] = 2 }, file: file)
  }
  #expect(throws: VaultError.malformed(file, "no format version")) {
    try Board(decoding: try edited { $0["version"] = nil }, file: file)
  }
  #expect(throws: VaultError.malformed(file, "not JSON")) { try Board(decoding: Data("{".utf8), file: file) }
}

@Test func decodingRejectsBrokenReferences() throws {
  func problem(_ change: (inout Board) -> Void) throws -> VaultError? {
    var b = everything()
    change(&b)
    do {
      _ = try Board(decoding: try b.encoded(), file: file)
      return nil
    } catch let e as VaultError {
      return e
    }
  }
  #expect(try problem { $0.arrows[1].to.card = CardID(rawValue: "zz") } == .malformed(file, "arrow a2: no card zz"))
  #expect(
    try problem { $0.arrows[0].from.segment = SegmentID(rawValue: "zz") }
      == .malformed(file, "arrow a1: card c has no segment zz"))
  #expect(try problem { $0.arrows[0].width = 4 } == .malformed(file, "arrow a1: width 4 is not 1, 2 or 3"))
  #expect(try problem { $0.cards[0].section = SectionID(rawValue: "zz") } == .malformed(file, "card c: no section zz"))
  #expect(try problem { $0.cards.append($0.cards[0]) } == .malformed(file, "card c is there twice"))
  #expect(
    try problem { $0.sections[0].parent = SectionID(rawValue: "sec") }
      == .malformed(file, "section top is inside itself"))
  #expect(
    try problem {
      $0.cards[4].content = .own(
        CardContent(body: .note(Note(text: "", style: .freeText(level: 4, bold: false, fontSize: nil)))))
    }
      == .malformed(file, "card n0: free text level 4"))
}

@Test func enumsAreOneObjectWithOneKey() throws {
  let data = try edited { j in
    card(&j, 1) { c in
      var content = c["content"] as? [String: Any] ?? [:]
      content["note"] = ["text": "x", "style": ["note": [:]]]
      c["content"] = content
    }
  }
  #expect(throws: VaultError.self) { try Board(decoding: data, file: file) }
}
