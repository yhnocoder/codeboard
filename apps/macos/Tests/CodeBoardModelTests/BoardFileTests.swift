import CodeBoardModel
import Foundation
import Testing

private let file = URL(filePath: "/vault/A.board/board.json")

/// A board with every kind of thing the format holds
private func everything() -> Board {
  let seg = Segment(
    id: SegmentID(rawValue: "s1"),
    source: .git(
      repository: "https://github.com/x/y", commit: "abc", path: "a.py", uncommitted: true, checkout: nil),
    language: "python", firstLine: 10, lines: ["def f():", "    pass"], symbol: Symbol(name: "f", kind: .function),
    scope: "M", hidden: [11...11], highlights: [10...10],
    annotations: [Annotation(line: 10, from: 0, to: 3, text: "def", color: .green, below: true)])
  let code = CardContent(
    title: "F", description: "d",
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
  let layout = NoteLayout(tables: [nil, NoteLayout.Table(cols: [1, nil])], wrap: [2])
  let notes: [CardContent.Body] = [
    .note(Note(text: "# T\n\nx", layout: layout)), .text(TextCard(text: "words")),
    .text(TextCard(text: "boxed", look: .box, fill: .pink, fontSize: 30.5, wrap: true, layout: layout)),
  ]
  let summary = Summary(
    text: "**a** b", title: "T", at: 1, sig: "s", edited: true, pairs: [Summary.Pair(ai: "x", user: "y", at: 2)],
    input: "in")
  let meta = WebMeta(
    title: "T", description: "D", site: "S", image: .file("og.png"), icon: .url("https://e/i.ico"), fetchedAt: 5,
    failed: true)
  var cards = [
    Card(
      id: CardID(rawValue: "c"), x: 1.5, y: -2, width: 300, height: 120, section: SectionID(rawValue: "sec"),
      locked: true, tilted: true, summary: summary, content: .own(code)),
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
    Card(
      id: CardID(rawValue: "web"), x: 0, y: 0, width: 10,
      content: .own(CardContent(body: .web(WebCard(url: "https://e", meta: meta, style: .compact))))),
    Card(
      id: CardID(rawValue: "links"), x: 0, y: 0, width: 10,
      content: .own(
        CardContent(
          body: .links(
            LinkList(
              items: [
                LinkList.Item(id: "i1", url: "https://a"),
                LinkList.Item(id: "i2", url: "https://b", title: "B", meta: meta, rich: false),
              ], rich: true))))),
    Card(
      id: CardID(rawValue: "sub"), x: 0, y: 0, width: 10, height: 200,
      content: .own(CardContent(body: .board(SubBoard(board: BoardID(rawValue: "other")))))),
  ]
  for (i, body) in notes.enumerated() {
    cards.append(Card(id: CardID(rawValue: "n\(i)"), x: 0, y: 0, width: 10, content: .own(CardContent(body: body))))
  }
  let c = CardID(rawValue: "c")
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
        color: "blue", collapsed: true, locked: true, description: "d", summary: summary, directSummary: summary),
    ],
    sidenotes: [
      Sidenote(
        id: SidenoteID(rawValue: "sn1"),
        anchor: .card(c, segment: SegmentID(rawValue: "s1"), lines: 10...11),
        body: .text(
          TextNote(
            text: "why", alwaysShow: true,
            question: Question(at: 3, done: true, answers: [Question.Answer(id: "a", text: "[[F#^c]]", at: 4)]))),
        lineRemoved: true, boardOnly: true, review: "widened"),
      Sidenote(
        id: SidenoteID(rawValue: "sn2"), anchor: .card(CardID(rawValue: "n0"), block: BlockRef(index: 0, hash: "h")),
        body: .code(
          Segment(id: SegmentID(rawValue: "x"), source: nil, language: "plaintext", firstLine: 1, lines: ["z"]))),
      Sidenote(
        id: SidenoteID(rawValue: "sn3"), anchor: .section(SectionID(rawValue: "top")), body: .text(TextNote(text: ""))),
      Sidenote(id: SidenoteID(rawValue: "sn4"), anchor: .point(x: -3, y: 4.5), body: .text(TextNote(text: "free"))),
    ],
    stickers: [
      Sticker(id: StickerID(rawValue: "k1"), glyph: .builtin(.todoText), anchor: .canvas(x: 1, y: 2, size: nil)),
      Sticker(
        id: StickerID(rawValue: "k2"), glyph: .emoji("🔥"), color: "#E3A132", anchor: .card(c, x: -11, y: 3, size: 22)),
      Sticker(
        id: StickerID(rawValue: "k3"), glyph: .builtin(.star),
        anchor: .line(c, segment: SegmentID(rawValue: "s1"), line: 11)),
    ],
    shelf: [
      ShelfEntry(
        id: "e1", at: 9,
        cards: [
          Card(
            id: CardID(rawValue: "shelved"), x: 5, y: 6, width: 200, measuredHeight: 48,
            section: SectionID(rawValue: "put"), content: .own(CardContent(body: .note(Note(text: "aside")))))
        ],
        sections: [Section(id: SectionID(rawValue: "put"), title: "Put away", x: 0, y: 0, width: 9, height: 9)],
        arrows: [
          Arrow(
            id: ArrowID(rawValue: "a3"), from: Endpoint(card: CardID(rawValue: "shelved")), to: Endpoint(card: c))
        ],
        stickers: [
          Sticker(
            id: StickerID(rawValue: "k4"), glyph: .builtin(.heart),
            anchor: .card(CardID(rawValue: "shelved"), x: 1, y: 1, size: nil))
        ])
    ], seal: Seal(text: "印AB", color: .teal), hideComments: true)
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
        "id": "b",
        "sections": [],
        "shelf": [],
        "sidenotes": [],
        "stickers": [],
        "version": 2
      }

      """)
  let full = String(decoding: try everything().encoded(), as: UTF8.self)
  #expect(full.contains("\"hidden\": [\n") && full.contains("[11, 11]"), "line ranges stay on one line")
  #expect(full.contains("\"cols\": [1, null]"))
  #expect(full.contains("\"lines\": [\n"), "code is one line per line, for diffs")
}

@Test func sharedCardRoundTripsThroughItsFile() throws {
  let s = CardID(rawValue: "s")
  let card = SharedCard(
    id: s, content: CardContent(body: .note(Note(text: "x"))),
    sidenotes: [Sidenote(id: SidenoteID(rawValue: "n"), anchor: .card(s), body: .text(TextNote(text: "travels")))])
  let data = try card.encoded()
  #expect(try SharedCard(decoding: data, file: file) == card)
  var other = card
  other.sidenotes[0].boardOnly = true
  #expect(throws: VaultError.malformed(file, "sidenote n is not this card's own")) {
    try SharedCard(decoding: try other.encoded(), file: file)
  }
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
  let newerField =
    "not in format 2 as this CodeBoard knows it; a newer CodeBoard may have written it. Update CodeBoard to open the "
    + "file (it is left as it is)"
  let cases: [(String, (inout [String: Any]) -> Void)] = [
    ("cards[1].extra: \(newerField)", { j in card(&j, 1) { $0["extra"] = 1 } }),
    (
      "cards[0].content: no kind this CodeBoard knows: \(newerField)",
      { j in card(&j, 0) { $0["content"] = ["later": [String: Any]()] } }
    ),
    (
      "cards[0].height: null, which is never written",
      { j in card(&j, 0) { $0["height"] = NSNull() } }
    ),
    ("cards[1].locked: missing", { j in card(&j, 1) { $0["locked"] = nil } }),
    ("hideComments: missing", { $0["hideComments"] = nil }),
  ]
  for (message, change) in cases {
    #expect(throws: VaultError.malformed(file, message)) { try Board(decoding: try edited(change), file: file) }
  }
  #expect(throws: VaultError.olderFormat(file, 1)) {
    try Board(decoding: try edited { $0["version"] = 1 }, file: file)
  }
  #expect(throws: VaultError.newerFormat(file, 3)) {
    try Board(decoding: try edited { $0["version"] = 3 }, file: file)
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
    try problem { $0.cards[8].content = .own(CardContent(body: .text(TextCard(text: "", fontSize: 9)))) }
      == .malformed(file, "card n1: font size 9.0 is outside 10…240"))
  #expect(try problem { $0.cards[8].height = 40 } == .malformed(file, "card n1: a Text has no height"))
  #expect(
    try problem { $0.sidenotes[0].anchor = .card(CardID(rawValue: "zz")) }
      == .malformed(file, "sidenote sn1: no card zz"))
  #expect(
    try problem { $0.sidenotes[2].anchor = .section(SectionID(rawValue: "zz")) }
      == .malformed(file, "sidenote sn3: no section zz"))
  #expect(
    try problem { $0.stickers[2].anchor = .line(CardID(rawValue: "c"), segment: SegmentID(rawValue: "zz"), line: 1) }
      == .malformed(file, "sticker k3: card c has no segment zz"))
  #expect(try problem { $0.shelf[0].cards[0].id = CardID(rawValue: "c") } == .malformed(file, "card c is there twice"))
  #expect(
    try problem { $0.seal = Seal(text: "two words") }
      == .malformed(file, "seal text two words: 1–5 CJK and 1–12 other characters"))
}

@Test func enumsAreOneObjectWithOneKey() throws {
  let data = try edited { j in
    card(&j, 1) { c in
      var content = c["content"] as? [String: Any] ?? [:]
      content["note"] = ["text": "x"]
      c["content"] = content
    }
  }
  #expect(throws: VaultError.self) { try Board(decoding: data, file: file) }
}
