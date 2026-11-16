import CodeBoardModel
import CodeBoardResources
import Foundation
import Testing

// resource.json and entry.json: every field and kind round trips, the writer is deterministic, and the reader refuses
// what the writer would not write and references that do not hold.

private let file = URL(filePath: "/vault/Papers.resource/Attention/entry.json")
private let v1 = VersionID(rawValue: "v1")
private let v2 = VersionID(rawValue: "v2")

/// An entry with every field and every kind of version, block, colour and value
private func everything() -> Entry {
  let page = Place(version: v1, block: .page(3), range: 10..<42)
  let region = Place(
    version: v1, block: .page(4, rect: Place.Rect(x: 72, y: 400.5, width: 200, height: 100)))
  let block = Place(version: v2, block: .id("p-12"), range: 0..<5)
  let colors: [Highlight.Color] = [.yellow, .green, .blue, .pink, .purple]
  return Entry(
    id: EntryID(rawValue: "e-attention"), title: "Attention Is All You Need", added: 1_700_000_000_000,
    origin: .arxiv("1706.03762"), authors: ["Ashish Vaswani", "Noam Shazeer"], year: 2017,
    versions: [
      Version(id: v1, label: "v7", added: 1_700_000_000_000, content: .pdf(file: "1706.03762v7.pdf")),
      Version(
        id: v2, label: "v7 中文", added: 1_700_000_100_000, language: "zh", of: v1,
        content: .pdf(file: "1706.03762v7.zh.pdf", blocks: "1706.03762.zh.anchors.json")),
      Version(
        id: VersionID(rawValue: "v3"), added: 1_700_000_200_000, content: .page(hash: "9f86d081884c7d65", bytes: 52_113)
      ),
      Version(id: VersionID(rawValue: "v4"), label: "slides", added: 1_700_000_250_000, content: .file("talk.key")),
    ],
    highlights: colors.enumerated().map { i, c in
      Highlight(id: "h\(i)", place: i.isMultiple(of: 2) ? page : block, color: c, at: 1_700_000_300_000 + Double(i))
    },
    sidenotes: [
      EntrySidenote(id: SidenoteID(rawValue: "n1"), place: region, note: TextNote(text: "The **figure**")),
      EntrySidenote(
        id: SidenoteID(rawValue: "n2"), place: block,
        note: TextNote(
          text: "Why divide by √d?", alwaysShow: true,
          question: Question(
            at: 1_700_000_400_000, done: true,
            answers: [Question.Answer(id: "a1", text: "Scale", at: 1_700_000_500_000)])
        )),
    ],
    fields: ["read": .bool(true), "stars": .number(4.5), "venue": .text("NeurIPS"), "on": .text("2017-12-04")])
}

/// The entry's JSON with `change` applied to it
private func edited(_ change: (inout [String: Any]) -> Void) throws -> Data {
  var json = try #require(try JSONSerialization.jsonObject(with: try everything().encoded()) as? [String: Any])
  change(&json)
  return try JSONSerialization.data(withJSONObject: json)
}

private func at(_ json: inout [String: Any], _ list: String, _ i: Int, _ change: (inout [String: Any]) -> Void) {
  var items = json[list] as? [[String: Any]] ?? []
  change(&items[i])
  json[list] = items
}

@Test func resourceFileRoundTripsEveryFieldAndKind() throws {
  let kinds: [Resource.Field.Kind] = [.text, .number, .date, .checkbox]
  let presets: [ResourcePreset] = [.papers, .web, .files]
  for preset in presets {
    let r = Resource(
      id: ResourceID(rawValue: "r1"), preset: preset,
      fields: kinds.map { Resource.Field(id: "f-\($0.rawValue)", name: "\($0)", type: $0) })
    let data = try r.encoded()
    #expect(try Resource(decoding: data, file: file) == r)
    #expect(try r.encoded() == data)
  }
  let plain = Resource(
    id: ResourceID(rawValue: "r1"), preset: .papers, fields: [Resource.Field(id: "venue", name: "Venue", type: .text)])
  #expect(
    String(decoding: try plain.encoded(), as: UTF8.self) == """
      {
        "fields": [
          {
            "id": "venue",
            "name": "Venue",
            "type": "text"
          }
        ],
        "id": "r1",
        "preset": "papers",
        "version": 1
      }

      """)
}

@Test func entryFileRoundTripsEveryFieldAndKind() throws {
  let e = everything()
  let data = try e.encoded()
  #expect(try Entry(decoding: data, file: file) == e)
  #expect(try Entry(decoding: data, file: file).encoded() == data)
  for origin: Entry.Origin in [.doi("10.48550/arXiv.1706.03762"), .web("https://arxiv.org/abs/1706.03762")] {
    var other = e
    other.origin = origin
    #expect(try Entry(decoding: try other.encoded(), file: file) == other)
  }
  // an entry saved as a link alone: no versions, nothing optional
  let bare = Entry(id: EntryID(rawValue: "e2"), title: "A link", added: 1, origin: .web("https://example.org"))
  #expect(try Entry(decoding: try bare.encoded(), file: file) == bare)
}

@Test func entryFileIsWrittenAsTheFormatSays() throws {
  let e = Entry(
    id: EntryID(rawValue: "e1"), title: "Attention Is All You Need", added: 1_700_000_000_000,
    versions: [Version(id: v1, added: 1_700_000_000_000, content: .pdf(file: "1706.03762v7.pdf"))],
    highlights: [
      Highlight(
        id: "h1", place: Place(version: v1, block: .page(2, rect: nil), range: 3..<9), color: .green,
        at: 1_700_000_000_001)
    ],
    sidenotes: [
      EntrySidenote(
        id: SidenoteID(rawValue: "n1"),
        place: Place(version: v1, block: .page(4, rect: Place.Rect(x: 72, y: 400.5, width: 200, height: 100))),
        note: TextNote(text: "x"))
    ])
  #expect(
    String(decoding: try e.encoded(), as: UTF8.self) == """
      {
        "added": 1700000000000,
        "fields": {},
        "highlights": [
          {
            "at": 1700000000001,
            "color": "green",
            "id": "h1",
            "place": {
              "block": {
                "page": {
                  "page": 2
                }
              },
              "range": [3, 9],
              "version": "v1"
            }
          }
        ],
        "id": "e1",
        "sidenotes": [
          {
            "alwaysShow": false,
            "id": "n1",
            "place": {
              "block": {
                "page": {
                  "page": 4,
                  "rect": [72, 400.5, 200, 100]
                }
              },
              "version": "v1"
            },
            "text": "x"
          }
        ],
        "title": "Attention Is All You Need",
        "version": 1,
        "versions": [
          {
            "added": 1700000000000,
            "content": {
              "pdf": {
                "file": "1706.03762v7.pdf"
              }
            },
            "id": "v1"
          }
        ]
      }

      """)
}

@Test func readingAnEntryRefusesWhatTheWriterWouldNotWrite() throws {
  let cases: [(String, (inout [String: Any]) -> Void)] = [
    // in the entry file's own format and version
    ("extra: not in entry format 1 as this CodeBoard knows it; a newer CodeBoard", { $0["extra"] = 1 }),
    ("year: null, which is never written", { $0["year"] = NSNull() }),
    ("highlights: missing", { $0["highlights"] = nil }),
    (
      "versions[0].content: no kind this CodeBoard knows: not in entry format 1 as",
      { j in at(&j, "versions", 0) { $0["content"] = ["epub": [String: Any]()] } }
    ),
    (
      "versions[0].content.pdf: ../x.pdf is not a file name",
      { j in at(&j, "versions", 0) { $0["content"] = ["pdf": ["file": "../x.pdf"]] } }
    ),
    (
      "versions[3].content.file: .key is not a file name",
      { j in at(&j, "versions", 3) { $0["content"] = ["file": ["file": ".key"]] } }
    ),
    ("origin.arxiv: 1706.03762v7: an id without a version", { $0["origin"] = ["arxiv": ["id": "1706.03762v7"]] }),
    (
      "highlights[0].place.range: [5, 5]: not 0 ≤ from < to",
      { j in at(&j, "highlights", 0) { $0["place"] = ["version": "v1", "block": ["id": "p"], "range": [5, 5]] } }
    ),
    (
      "highlights[0].place.range: [-1, 2]: not 0 ≤ from < to",
      { j in at(&j, "highlights", 0) { $0["place"] = ["version": "v1", "block": ["id": "p"], "range": [-1, 2]] } }
    ),
    (
      "highlights[0].place.range",
      { j in at(&j, "highlights", 0) { $0["place"] = ["version": "v1", "block": ["id": "p"], "range": [7, 3]] } }
    ),
    (
      "highlights[0].place.block.page: page 0: pages are from 1",
      { j in at(&j, "highlights", 0) { $0["place"] = ["version": "v1", "block": ["page": ["page": 0]]] } }
    ),
    (
      "sidenotes[0].place.block.page: a rect is [x, y, width, height] with a width and height above 0",
      { j in
        at(&j, "sidenotes", 0) {
          $0["place"] = ["version": "v1", "block": ["page": ["page": 1, "rect": [0, 0, 10]]]]
        }
      }
    ),
    (
      "sidenotes[0].place.block.page: a rect is [x, y, width, height] with a width and height above 0",
      { j in
        at(&j, "sidenotes", 0) {
          $0["place"] = ["version": "v1", "block": ["page": ["page": 1, "rect": [0, 0, 0, 9]]]]
        }
      }
    ),
    ("highlights[1].color", { j in at(&j, "highlights", 1) { $0["color"] = "orange" } }),
    // what holds only among the entry's own
    (
      "version v1 is there twice",
      { j in
        at(&j, "versions", 1) {
          $0["id"] = "v1"
          $0["of"] = nil
        }
      }
    ),
    ("highlight h0 is there twice", { j in at(&j, "highlights", 1) { $0["id"] = "h0" } }),
    ("sidenote n1 is there twice", { j in at(&j, "sidenotes", 1) { $0["id"] = "n1" } }),
    ("version v2: no other version v9 to translate", { j in at(&j, "versions", 1) { $0["of"] = "v9" } }),
    ("version v2: no other version v2 to translate", { j in at(&j, "versions", 1) { $0["of"] = "v2" } }),
    (
      "highlight h1: no version v9",
      { j in at(&j, "highlights", 1) { $0["place"] = ["version": "v9", "block": ["id": "p"]] } }
    ),
    (
      "sidenote n2: no version v9",
      { j in at(&j, "sidenotes", 1) { $0["place"] = ["version": "v9", "block": ["id": "p"]] } }
    ),
    (
      "highlight h0: on a region of a page",
      { j in
        at(&j, "highlights", 0) {
          $0["place"] = ["version": "v1", "block": ["page": ["page": 1, "rect": [0, 0, 10, 10]]]]
        }
      }
    ),
  ]
  for (message, change) in cases {
    let data = try edited(change)
    #expect {
      try Entry(decoding: data, file: file)
    } throws: { error in
      guard case .malformed(let f, let why) = error as? VaultError, f == file else { return false }
      return why.hasPrefix(message)
    }
  }
  #expect(throws: VaultError.newerFormat(file, 2, reads: 1)) {
    try Entry(decoding: try edited { $0["version"] = 2 }, file: file)
  }
  #expect(
    VaultError.newerFormat(file, 2, reads: 1).description.contains(
      "version 2, written by a newer CodeBoard; this one reads version 1."))
  #expect(throws: VaultError.olderFormat(file, 0)) { try Entry(decoding: try edited { $0["version"] = 0 }, file: file) }
}

@Test func readingAResourceRefusesWhatTheWriterWouldNotWrite() throws {
  let at = URL(filePath: "/vault/Papers.resource/resource.json")
  func json(_ s: String) -> Data { Data(s.utf8) }
  let fields = #"[{"id": "a", "name": "A", "type": "text"}, {"id": "a", "name": "B", "type": "date"}]"#
  #expect(throws: VaultError.malformed(at, "field a is there twice")) {
    try Resource(decoding: json(#"{"version": 1, "id": "r", "preset": "papers", "fields": \#(fields)}"#), file: at)
  }
  for bad in [
    #"{"version": 1, "id": "r", "preset": "videos", "fields": []}"#,
    #"{"version": 1, "id": "r", "preset": "papers"}"#,
    #"{"version": 1, "id": "r", "preset": "papers", "fields": [{"id": "a", "name": "A", "type": "url"}]}"#,
  ] {
    #expect(throws: VaultError.self) { try Resource(decoding: json(bad), file: at) }
  }
  #expect(
    throws: VaultError.malformed(
      at,
      "title: not in resource format 1 as this CodeBoard knows it; a newer CodeBoard may have written it. Update "
        + "CodeBoard to open the file (it is left as it is)")
  ) {
    try Resource(
      decoding: json(#"{"version": 1, "id": "r", "preset": "papers", "fields": [], "title": "Papers"}"#), file: at)
  }
  #expect(throws: VaultError.newerFormat(at, 2, reads: 1)) {
    try Resource(decoding: json(#"{"version": 2, "id": "r", "preset": "papers", "fields": []}"#), file: at)
  }
}

/// A page saved as a link keeps what a Web card keeps, coded as a Web card's: pictures as files or addresses
@Test func anEntrysPageMetaRoundTripsAsAWebCardsAndIsLeftOutWhenAbsent() throws {
  let meta = WebMeta(
    title: "A field guide", description: "Birds of the river bank", site: "example.org",
    image: .file("guide-1a2b.png"), icon: .url("https://example.org/favicon.ico"), fetchedAt: 1_700_000_000_000)
  let e = Entry(
    id: EntryID(rawValue: "e3"), title: "A field guide", added: 1, origin: .web("https://example.org/guide"),
    meta: meta)
  let data = try e.encoded()
  #expect(try Entry(decoding: data, file: file) == e)
  let json = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
  let card = try #require(
    try JSONSerialization.jsonObject(with: try JSONEncoder().encode(meta)) as? [String: Any])
  #expect(NSDictionary(dictionary: try #require(json["meta"] as? [String: Any])).isEqual(to: card))
  #expect(!String(decoding: try everything().encoded(), as: UTF8.self).contains("\"meta\""))
}

@Test func anEntrysPageMetaWithAResourcesPictureIsRefused() throws {
  let anchor = SourceAnchor(entry: EntryID(rawValue: "e1"), place: Place(version: v1, block: .page(1)))
  let e = Entry(
    id: EntryID(rawValue: "e3"), title: "A field guide", added: 1, meta: WebMeta(icon: .resource(anchor)))
  #expect {
    try Entry(decoding: try e.encoded(), file: file)
  } throws: { error in
    guard case .malformed(_, let why) = error as? VaultError else { return false }
    return why == "its page's picture is not a resource's"
  }
}
