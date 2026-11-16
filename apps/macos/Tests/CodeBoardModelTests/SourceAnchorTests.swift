import CodeBoardModel
import Foundation
import Testing

// A card's source and an image card's resource picture: a place in a resource entry, named by the entry's id, written
// only when there and read strictly.

private let file = URL(filePath: "/vault/A.board/board.json")
private let anchor = SourceAnchor(
  entry: EntryID(rawValue: "e-attention"),
  place: Place(version: VersionID(rawValue: "v1"), block: .id("p-3"), range: 4..<20))

private func board(_ contents: [CardContent]) -> Board {
  Board(
    id: BoardID(rawValue: "b"),
    cards: contents.enumerated().map { i, c in
      Card(id: CardID(rawValue: "c\(i)"), x: 0, y: 0, width: 240, content: .own(c))
    })
}

@Test func aCardsSourceAndAResourcePictureRoundTrip() throws {
  let region = SourceAnchor(
    entry: EntryID(rawValue: "e2"),
    place: Place(
      version: VersionID(rawValue: "v2"), block: .page(5, rect: Place.Rect(x: 72, y: 96.5, width: 300, height: 180))))
  let b = board([
    CardContent(title: "Scaled dot product", source: anchor, body: .note(Note(text: "Divide by √d"))),
    CardContent(
      source: SourceAnchor(entry: anchor.entry, place: Place(version: anchor.place.version, block: .page(2))),
      body: .text(TextCard(text: "x"))),
    CardContent(body: .image(ImageCard(source: .resource(region), alt: "Figure 1", framed: true))),
  ])
  let data = try b.encoded()
  #expect(try Board(decoding: data, file: file) == b)
  let text = String(decoding: data, as: UTF8.self)
  #expect(
    text.contains(
      """
              "source": {
                "block": {
                  "id": "p-3"
                },
                "entry": "e-attention",
                "range": [4, 20],
                "version": "v1"
              },
      """))
  #expect(
    text.contains(
      """
                "source": {
                  "resource": {
                    "block": {
                      "page": {
                        "page": 5,
                        "rect": [72, 96.5, 300, 180]
                      }
                    },
                    "entry": "e2",
                    "version": "v2"
                  }
                }
      """))
}

@Test func aCardWithoutASourceIsWrittenAsBefore() throws {
  let plain = board([CardContent(title: "T", body: .note(Note(text: "x")))])
  #expect(!String(decoding: try plain.encoded(), as: UTF8.self).contains("source"))
}

@Test func aSourceIsReadStrictly() throws {
  func json(_ change: (inout [String: Any]) -> Void) throws -> Data {
    var j = try #require(
      try JSONSerialization.jsonObject(
        with: try board([CardContent(source: anchor, body: .note(Note(text: "x")))]).encoded())
        as? [String: Any])
    var cards = j["cards"] as? [[String: Any]] ?? []
    var content = cards[0]["content"] as? [String: Any] ?? [:]
    var source = content["source"] as? [String: Any] ?? [:]
    change(&source)
    content["source"] = source
    cards[0]["content"] = content
    j["cards"] = cards
    return try JSONSerialization.data(withJSONObject: j)
  }
  let cases: [(String, (inout [String: Any]) -> Void)] = [
    ("cards[0].content.source.range: [3, 3]: not 0 ≤ from < to", { $0["range"] = [3, 3] }),
    ("cards[0].content.source.block.page: page 0: pages are from 1", { $0["block"] = ["page": ["page": 0]] }),
    ("cards[0].content.source.entry: missing", { $0["entry"] = nil }),
    ("cards[0].content.source.block: more than one kind", { $0["block"] = ["id": "p", "page": ["page": 1]] }),
    ("cards[0].content.source.paragraph: not in format", { $0["paragraph"] = 2 }),
  ]
  for (message, change) in cases {
    let data = try json(change)
    #expect {
      try Board(decoding: data, file: file)
    } throws: { error in
      guard case .malformed(_, let why) = error as? VaultError else { return false }
      return why.hasPrefix(message)
    }
  }
}

/// An image card whose picture is a resource's names the place already: it has no source besides. And a web card's
/// pictures are files or addresses, never a resource's
@Test func aResourcePictureHasNoSourceBesidesAndWebPicturesAreNotAResources() throws {
  let cases: [(CardContent, String)] = [
    (
      CardContent(source: anchor, body: .image(ImageCard(source: .resource(anchor)))),
      "card c0: its picture is a resource's: it has no source besides"
    ),
    (
      CardContent(body: .web(WebCard(url: "https://arxiv.org", meta: WebMeta(image: .resource(anchor))))),
      "card c0: a web card's picture is not a resource's"
    ),
    (
      CardContent(
        body: .links(
          LinkList(items: [LinkList.Item(id: "i", url: "https://a", meta: WebMeta(icon: .resource(anchor)))]))),
      "card c0: a link's picture is not a resource's"
    ),
  ]
  for (content, message) in cases {
    #expect(throws: VaultError.malformed(file, message)) {
      try Board(decoding: try board([content]).encoded(), file: file)
    }
  }
  // a file's picture with a source is fine
  let ok = board([CardContent(source: anchor, body: .image(ImageCard(source: .file("fig1.png"))))])
  #expect(try Board(decoding: try ok.encoded(), file: file) == ok)
}
