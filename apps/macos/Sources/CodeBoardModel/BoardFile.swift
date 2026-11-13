import Foundation

// Reading and writing board.json and shared card files. Writing is deterministic (sorted keys, pretty-printed, trailing
// newline) so git diffs stay small. Reading is strict: a file must be exactly what the writer would write for the value it
// decodes to (no unknown fields, no nulls, no left-out fields), and its references must hold.

public enum VaultError: Error, Equatable, CustomStringConvertible {
  case unreadable(URL, String)
  case malformed(URL, String)
  /// Written by a newer CodeBoard in a format version this one does not read
  case newerFormat(URL, Int)
  /// A format version from before this one, which it no longer reads
  case olderFormat(URL, Int)
  case duplicateBoardID(BoardID, [URL])
  case badSharedCardID(String)

  public var description: String {
    switch self {
    case .unreadable(let file, let why): "\(file.path): cannot be read: \(why)"
    case .malformed(let file, let why): "\(file.path): \(why)"
    case .newerFormat(let file, let v):
      "\(file.path): format version \(v), written by a newer CodeBoard; this one reads version \(Board.version). "
        + "Update CodeBoard to open it (the file is left as it is)"
    case .olderFormat(let file, let v):
      "\(file.path): format version \(v), from an early build, which this one no longer reads; import the board again "
        + "from its VS Code storage folder"
    case .duplicateBoardID(let id, let files):
      "board id \(id.rawValue) is in more than one board: \(files.map(\.path).joined(separator: ", "))"
    case .badSharedCardID(let id): "\(id) cannot name a shared card (letters, digits, - and _ only)"
    }
  }
}

extension Board {
  public func encoded() throws -> Data { try canonicalJSON(self) }

  public init(decoding data: Data, file: URL) throws {
    self = try strictDecode(Board.self, from: data, file: file, version: Board.version)
    if let problem = problem() { throw VaultError.malformed(file, problem) }
  }

  /// The first reference or value that does not hold, as a message
  func problem() -> String? {
    let shelved = shelf.flatMap(\.cards)
    var cardIDs = Set<CardID>()
    var codeCards: [CardID: CodeCard] = [:]
    for card in cards + shelved {
      guard cardIDs.insert(card.id).inserted else { return "card \(card.id.rawValue) is there twice" }
      if case .own(let content) = card.content {
        if let p = content.problem() { return "card \(card.id.rawValue): \(p)" }
        if case .code(let code) = content.body { codeCards[card.id] = code }
        if case .text = content.body, card.height != nil { return "card \(card.id.rawValue): a Text has no height" }
      }
    }
    let allSections = sections + shelf.flatMap(\.sections)
    var parents: [SectionID: SectionID?] = [:]
    for s in allSections {
      guard parents.updateValue(s.parent, forKey: s.id) == nil else { return "section \(s.id.rawValue) is there twice" }
    }
    for s in allSections {
      var seen: Set<SectionID> = [s.id]
      var at = s.parent
      while let p = at {
        guard let up = parents[p] else { return "section \(s.id.rawValue): no parent section \(p.rawValue)" }
        guard seen.insert(p).inserted else { return "section \(s.id.rawValue) is inside itself" }
        at = up
      }
    }
    for card in cards + shelved {
      if let s = card.section, parents[s] == nil { return "card \(card.id.rawValue): no section \(s.rawValue)" }
    }
    func segmentProblem(_ card: CardID, _ segment: SegmentID?) -> String? {
      guard cardIDs.contains(card) else { return "no card \(card.rawValue)" }
      if let seg = segment, let code = codeCards[card], !code.segments.contains(where: { $0.id == seg }) {
        return "card \(card.rawValue) has no segment \(seg.rawValue)"
      }
      return nil
    }
    var arrowIDs = Set<ArrowID>()
    for a in arrows + shelf.flatMap(\.arrows) {
      guard arrowIDs.insert(a.id).inserted else { return "arrow \(a.id.rawValue) is there twice" }
      guard (1...3).contains(a.width) else { return "arrow \(a.id.rawValue): width \(a.width) is not 1, 2 or 3" }
      if let t = a.labelPosition, !(0...1).contains(t) { return "arrow \(a.id.rawValue): label position \(t)" }
      for end in [a.from, a.to] {
        if let p = segmentProblem(end.card, end.segment) { return "arrow \(a.id.rawValue): \(p)" }
      }
    }
    var noteIDs = Set<SidenoteID>()
    for n in sidenotes {
      guard noteIDs.insert(n.id).inserted else { return "sidenote \(n.id.rawValue) is there twice" }
      if let p = n.problem() { return "sidenote \(n.id.rawValue): \(p)" }
      switch n.anchor {
      case .card(let card, let segment, _, _):
        if let p = segmentProblem(card, segment) { return "sidenote \(n.id.rawValue): \(p)" }
      case .section(let s):
        if parents[s] == nil { return "sidenote \(n.id.rawValue): no section \(s.rawValue)" }
      case .point: break
      }
    }
    var stickerIDs = Set<StickerID>()
    for k in stickers + shelf.flatMap(\.stickers) {
      guard stickerIDs.insert(k.id).inserted else { return "sticker \(k.id.rawValue) is there twice" }
      if let p = k.problem() { return "sticker \(k.id.rawValue): \(p)" }
      if let card = k.anchor.card {
        var segment: SegmentID?
        if case .line(_, let s, _) = k.anchor { segment = s }
        if let p = segmentProblem(card, segment) { return "sticker \(k.id.rawValue): \(p)" }
      }
    }
    if let text = seal?.text, !Seal.isText(text) { return "seal text \(text): 1–5 CJK and 1–12 other characters" }
    return nil
  }
}

extension Sidenote {
  func problem() -> String? {
    if case .code(let s) = body, s.firstLine < 1 { return "its code starts at line \(s.firstLine)" }
    if case .card(_, _, let lines?, _) = anchor, lines.lowerBound < 1 { return "line \(lines.lowerBound)" }
    return nil
  }
}

extension Sticker {
  func problem() -> String? {
    switch anchor {
    case .canvas(_, _, let size?), .card(_, _, _, let size?): if size <= 0 { return "size \(size)" }
    default: break
    }
    if case .emoji(let e) = glyph, e.count != 1 { return "\(e) is not one emoji" }
    return nil
  }
}

extension SharedCard {
  public func encoded() throws -> Data { try canonicalJSON(self) }

  public init(decoding data: Data, file: URL) throws {
    self = try strictDecode(SharedCard.self, from: data, file: file, version: SharedCard.version)
    if let problem = problem() { throw VaultError.malformed(file, problem) }
  }
}

extension SharedCard {
  func problem() -> String? {
    if let p = content.problem() { return p }
    var ids = Set<SidenoteID>()
    for n in sidenotes {
      guard ids.insert(n.id).inserted else { return "sidenote \(n.id.rawValue) is there twice" }
      if let p = n.problem() { return "sidenote \(n.id.rawValue): \(p)" }
      // it travels with this card: on it, wherever it is placed
      guard n.anchor.card == id, !n.boardOnly else { return "sidenote \(n.id.rawValue) is not this card's own" }
      if case .card(_, let seg?, _, _) = n.anchor, case .code(let code) = content.body,
        !code.segments.contains(where: { $0.id == seg })
      {
        return "sidenote \(n.id.rawValue): no segment \(seg.rawValue)"
      }
    }
    return nil
  }
}

extension CardContent {
  func problem() -> String? {
    switch body {
    case .code(let code):
      var ids = Set<SegmentID>()
      for s in code.segments {
        guard ids.insert(s.id).inserted else { return "segment \(s.id.rawValue) is there twice" }
        guard s.firstLine >= 1 else { return "segment \(s.id.rawValue) starts at line \(s.firstLine)" }
      }
    case .text(let t):
      if !TextCard.fontSizes.contains(t.fontSize) { return "font size \(t.fontSize) is outside 10…240" }
    case .image(let image):
      if let f = image.stillFrame, f < 1 { return "still frame \(f)" }
    case .links(let list):
      var ids = Set<String>()
      for item in list.items where !ids.insert(item.id).inserted { return "link \(item.id) is there twice" }
    case .note, .web, .board: break
    }
    return nil
  }
}

/// Sorted keys, two-space indent, one value per line; empty lists and objects and lists of numbers (line ranges, sizes)
/// stay on one line. Foundation's pretty printing spreads `[]` over three lines and writes `"key" : value`
func canonicalJSON(_ value: some Encodable) throws -> Data {
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
  let compact = Array(try encoder.encode(value))
  var out: [UInt8] = []
  var depth = 0
  var i = 0
  func newline() { out += [UInt8(ascii: "\n")] + Array(repeating: UInt8(ascii: " "), count: depth * 2) }
  while i < compact.count {
    let b = compact[i]
    switch b {
    case UInt8(ascii: "\""):
      // a string, copied as it is up to its closing quote
      var j = i + 1
      while compact[j] != UInt8(ascii: "\"") { j += compact[j] == UInt8(ascii: "\\") ? 2 : 1 }
      out += compact[i...j]
      i = j
    case UInt8(ascii: "{"), UInt8(ascii: "["):
      let close = b == UInt8(ascii: "{") ? UInt8(ascii: "}") : UInt8(ascii: "]")
      if compact[i + 1] == close {
        out += [b, close]
        i += 1
      } else if b == UInt8(ascii: "["),
        let end = compact[(i + 1)...].firstIndex(where: { "{[\"]".utf8.contains($0) }),
        compact[end] == close
      {
        for c in compact[i...end] { out += c == UInt8(ascii: ",") ? Array(", ".utf8) : [c] }
        i = end
      } else {
        out.append(b)
        depth += 1
        newline()
      }
    case UInt8(ascii: "}"), UInt8(ascii: "]"):
      depth -= 1
      newline()
      out.append(b)
    case UInt8(ascii: ","):
      out.append(b)
      newline()
    case UInt8(ascii: ":"):
      out += Array(": ".utf8)
    default:
      out.append(b)
    }
    i += 1
  }
  return Data(out + [UInt8(ascii: "\n")])
}

func strictDecode<T: Codable>(_ type: T.Type, from data: Data, file: URL, version: Int) throws -> T {
  let raw: Any
  do {
    raw = try JSONSerialization.jsonObject(with: data)
  } catch {
    throw VaultError.malformed(file, "not JSON")
  }
  guard let object = raw as? [String: Any] else { throw VaultError.malformed(file, "not a JSON object") }
  guard let v = object["version"] as? Int else { throw VaultError.malformed(file, "no format version") }
  guard v <= version else { throw VaultError.newerFormat(file, v) }
  // a breaking change raises the version: an upgrade step from the version before goes here (FORMAT.md, Versions)
  guard v == version else { throw VaultError.olderFormat(file, v) }
  let value: T
  do {
    value = try JSONDecoder().decode(T.self, from: data)
  } catch let DecodingError.keyNotFound(key, context) {
    throw VaultError.malformed(file, "\(pathText(context.codingPath + [key])): missing")
  } catch let DecodingError.typeMismatch(_, context), let DecodingError.valueNotFound(_, context),
    let DecodingError.dataCorrupted(context)
  {
    throw VaultError.malformed(file, "\(pathText(context.codingPath)): \(context.debugDescription)")
  }
  let again = try JSONSerialization.jsonObject(with: canonicalJSON(value))
  if let (path, what) = firstDifference(raw, again, at: "") {
    throw VaultError.malformed(file, "\(path.isEmpty ? "(root)" : path): \(what)")
  }
  return value
}

/// What an older build says of a field or kind a newer one added (FORMAT.md, Versions): it never drops it
let newerField =
  "not in format \(Board.version) as this CodeBoard knows it; a newer CodeBoard may have written it. "
  + "Update CodeBoard to open the file (it is left as it is)"

private func pathText(_ path: [any CodingKey]) -> String {
  path.map { $0.intValue.map { "[\($0)]" } ?? ".\($0.stringValue)" }.joined().trimmingPrefix(".").description
}

/// The path of the first place where what was read differs from what the writer writes for it, and how
private func firstDifference(_ a: Any, _ b: Any, at path: String) -> (String, String)? {
  if let x = a as? [String: Any], let y = b as? [String: Any] {
    for key in Set(x.keys).union(y.keys).sorted() {
      let here = path.isEmpty ? key : "\(path).\(key)"
      switch (x[key], y[key]) {
      case (let xv?, let yv?): if let d = firstDifference(xv, yv, at: here) { return d }
      case (is NSNull, nil): return (here, "null, which is never written")
      case (_?, nil): return (here, newerField)
      default: return (here, "missing")
      }
    }
    return nil
  }
  if let x = a as? [Any], let y = b as? [Any] {
    guard x.count == y.count else { return (path, "not as the writer writes it") }
    for (i, (xv, yv)) in zip(x, y).enumerated() {
      if let d = firstDifference(xv, yv, at: "\(path)[\(i)]") { return d }
    }
    return nil
  }
  return (a as? NSObject)?.isEqual(b) == true ? nil : (path, "not as the writer writes it")
}

// MARK: Coding where the JSON shape is not the synthesized one

/// An enum is one object with exactly one key, naming the case
private func theCase<K: CodingKey>(of c: KeyedDecodingContainer<K>) throws -> K {
  // a kind this build does not know is not in allKeys
  guard c.allKeys.count == 1, let key = c.allKeys.first else {
    let what = c.allKeys.isEmpty ? "no kind this CodeBoard knows: " + newerField : "more than one kind"
    throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: what))
  }
  return key
}

private struct Empty: Codable {}

extension Board: Codable {
  private enum Keys: String, CodingKey {
    case version, id, cards, arrows, sections, sidenotes, stickers, shelf, seal, hideComments
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    _ = try c.decode(Int.self, forKey: .version)
    self.init(
      id: try c.decode(BoardID.self, forKey: .id), cards: try c.decode([Card].self, forKey: .cards),
      arrows: try c.decode([Arrow].self, forKey: .arrows), sections: try c.decode([Section].self, forKey: .sections),
      sidenotes: try c.decode([Sidenote].self, forKey: .sidenotes),
      stickers: try c.decode([Sticker].self, forKey: .stickers), shelf: try c.decode([ShelfEntry].self, forKey: .shelf),
      seal: try c.decodeIfPresent(Seal.self, forKey: .seal),
      hideComments: try c.decode(Bool.self, forKey: .hideComments)
    )
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: Keys.self)
    try c.encode(Board.version, forKey: .version)
    try c.encode(id, forKey: .id)
    try c.encode(cards, forKey: .cards)
    try c.encode(arrows, forKey: .arrows)
    try c.encode(sections, forKey: .sections)
    try c.encode(sidenotes, forKey: .sidenotes)
    try c.encode(stickers, forKey: .stickers)
    try c.encode(shelf, forKey: .shelf)
    try c.encodeIfPresent(seal, forKey: .seal)
    try c.encode(hideComments, forKey: .hideComments)
  }
}

extension SharedCard: Codable {
  private enum Keys: String, CodingKey {
    case version, id, content, sidenotes
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    _ = try c.decode(Int.self, forKey: .version)
    self.init(
      id: try c.decode(CardID.self, forKey: .id), content: try c.decode(CardContent.self, forKey: .content),
      sidenotes: try c.decode([Sidenote].self, forKey: .sidenotes))
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: Keys.self)
    try c.encode(SharedCard.version, forKey: .version)
    try c.encode(id, forKey: .id)
    try c.encode(content, forKey: .content)
    try c.encode(sidenotes, forKey: .sidenotes)
  }
}

extension Card: Codable {
  private enum Keys: String, CodingKey {
    case id, x, y, width, height, measuredHeight, section, locked, tilted, summary, content, shared
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    let content: Content
    if c.contains(.content) {
      content = .own(try c.decode(CardContent.self, forKey: .content))
    } else if try c.decode(Bool.self, forKey: .shared) {
      content = .shared
    } else {
      throw DecodingError.dataCorruptedError(
        forKey: .shared, in: c, debugDescription: "a card is shared or has content")
    }
    self.init(
      id: try c.decode(CardID.self, forKey: .id), x: try c.decode(Double.self, forKey: .x),
      y: try c.decode(Double.self, forKey: .y), width: try c.decode(Double.self, forKey: .width),
      height: try c.decodeIfPresent(Double.self, forKey: .height),
      measuredHeight: try c.decodeIfPresent(Double.self, forKey: .measuredHeight),
      section: try c.decodeIfPresent(SectionID.self, forKey: .section),
      locked: try c.decode(Bool.self, forKey: .locked), tilted: try c.decode(Bool.self, forKey: .tilted),
      summary: try c.decodeIfPresent(Summary.self, forKey: .summary), content: content)
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: Keys.self)
    try c.encode(id, forKey: .id)
    try c.encode(x, forKey: .x)
    try c.encode(y, forKey: .y)
    try c.encode(width, forKey: .width)
    try c.encodeIfPresent(height, forKey: .height)
    try c.encodeIfPresent(measuredHeight, forKey: .measuredHeight)
    try c.encodeIfPresent(section, forKey: .section)
    try c.encode(locked, forKey: .locked)
    try c.encode(tilted, forKey: .tilted)
    try c.encodeIfPresent(summary, forKey: .summary)
    switch content {
    case .own(let own): try c.encode(own, forKey: .content)
    case .shared: try c.encode(true, forKey: .shared)
    }
  }
}

extension CardContent: Codable {
  private enum Keys: String, CodingKey {
    case title, description, code, note, text, image, web, links, board
  }
  private enum Kind: String, CodingKey {
    case code, note, text, image, web, links, board
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    let body: Body =
      switch try theCase(of: decoder.container(keyedBy: Kind.self)) {
      case .code: .code(try c.decode(CodeCard.self, forKey: .code))
      case .note: .note(try c.decode(Note.self, forKey: .note))
      case .text: .text(try c.decode(TextCard.self, forKey: .text))
      case .image: .image(try c.decode(ImageCard.self, forKey: .image))
      case .web: .web(try c.decode(WebCard.self, forKey: .web))
      case .links: .links(try c.decode(LinkList.self, forKey: .links))
      case .board: .board(try c.decode(SubBoard.self, forKey: .board))
      }
    self.init(
      title: try c.decodeIfPresent(String.self, forKey: .title),
      description: try c.decodeIfPresent(String.self, forKey: .description), body: body)
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: Keys.self)
    try c.encodeIfPresent(title, forKey: .title)
    try c.encodeIfPresent(description, forKey: .description)
    switch body {
    case .code(let code): try c.encode(code, forKey: .code)
    case .note(let note): try c.encode(note, forKey: .note)
    case .text(let text): try c.encode(text, forKey: .text)
    case .image(let image): try c.encode(image, forKey: .image)
    case .web(let web): try c.encode(web, forKey: .web)
    case .links(let links): try c.encode(links, forKey: .links)
    case .board(let board): try c.encode(board, forKey: .board)
    }
  }
}

extension Sidenote: Codable {
  private enum Keys: String, CodingKey {
    case id, anchor, lineRemoved, boardOnly, review, text, code
  }
  private enum Kind: String, CodingKey {
    case text, code
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    let body: Body =
      switch try theCase(of: decoder.container(keyedBy: Kind.self)) {
      case .text: .text(try c.decode(TextNote.self, forKey: .text))
      case .code: .code(try c.decode(Segment.self, forKey: .code))
      }
    self.init(
      id: try c.decode(SidenoteID.self, forKey: .id), anchor: try c.decode(Anchor.self, forKey: .anchor), body: body,
      lineRemoved: try c.decode(Bool.self, forKey: .lineRemoved),
      boardOnly: try c.decode(Bool.self, forKey: .boardOnly),
      review: try c.decodeIfPresent(String.self, forKey: .review))
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: Keys.self)
    try c.encode(id, forKey: .id)
    try c.encode(anchor, forKey: .anchor)
    try c.encode(lineRemoved, forKey: .lineRemoved)
    try c.encode(boardOnly, forKey: .boardOnly)
    try c.encodeIfPresent(review, forKey: .review)
    switch body {
    case .text(let t): try c.encode(t, forKey: .text)
    case .code(let s): try c.encode(s, forKey: .code)
    }
  }
}

extension Anchor: Codable {
  private enum Keys: String, CodingKey {
    case card, section, point
  }
  private struct OnCard: Codable {
    var card: CardID
    var segment: SegmentID?
    var lines: ClosedRange<Int>?
    var block: BlockRef?
  }
  private struct OnSection: Codable {
    var section: SectionID
  }
  private struct Point: Codable {
    var x: Double
    var y: Double
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    switch try theCase(of: c) {
    case .card:
      let o = try c.decode(OnCard.self, forKey: .card)
      self = .card(o.card, segment: o.segment, lines: o.lines, block: o.block)
    case .section: self = .section(try c.decode(OnSection.self, forKey: .section).section)
    case .point:
      let p = try c.decode(Point.self, forKey: .point)
      self = .point(x: p.x, y: p.y)
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: Keys.self)
    switch self {
    case .card(let card, let segment, let lines, let block):
      try c.encode(OnCard(card: card, segment: segment, lines: lines, block: block), forKey: .card)
    case .section(let s): try c.encode(OnSection(section: s), forKey: .section)
    case .point(let x, let y): try c.encode(Point(x: x, y: y), forKey: .point)
    }
  }
}

extension Sticker: Codable {
  private enum Keys: String, CodingKey {
    case id, glyph, color, anchor
  }
  private enum GlyphKeys: String, CodingKey {
    case builtin, emoji
  }
  private enum AnchorKeys: String, CodingKey {
    case canvas, card, line
  }
  private struct Canvas: Codable {
    var x: Double
    var y: Double
    var size: Double?
  }
  private struct OnCard: Codable {
    var card: CardID
    var x: Double
    var y: Double
    var size: Double?
  }
  private struct Line: Codable {
    var card: CardID
    var segment: SegmentID
    var line: Int
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    let g = try c.nestedContainer(keyedBy: GlyphKeys.self, forKey: .glyph)
    let glyph: Glyph =
      switch try theCase(of: g) {
      case .builtin: .builtin(try g.decode(BuiltinSticker.self, forKey: .builtin))
      case .emoji: .emoji(try g.decode(String.self, forKey: .emoji))
      }
    let a = try c.nestedContainer(keyedBy: AnchorKeys.self, forKey: .anchor)
    let anchor: Anchor
    switch try theCase(of: a) {
    case .canvas:
      let p = try a.decode(Canvas.self, forKey: .canvas)
      anchor = .canvas(x: p.x, y: p.y, size: p.size)
    case .card:
      let p = try a.decode(OnCard.self, forKey: .card)
      anchor = .card(p.card, x: p.x, y: p.y, size: p.size)
    case .line:
      let p = try a.decode(Line.self, forKey: .line)
      anchor = .line(p.card, segment: p.segment, line: p.line)
    }
    self.init(
      id: try c.decode(StickerID.self, forKey: .id), glyph: glyph,
      color: try c.decodeIfPresent(String.self, forKey: .color), anchor: anchor)
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: Keys.self)
    try c.encode(id, forKey: .id)
    var g = c.nestedContainer(keyedBy: GlyphKeys.self, forKey: .glyph)
    switch glyph {
    case .builtin(let b): try g.encode(b, forKey: .builtin)
    case .emoji(let e): try g.encode(e, forKey: .emoji)
    }
    try c.encodeIfPresent(color, forKey: .color)
    var a = c.nestedContainer(keyedBy: AnchorKeys.self, forKey: .anchor)
    switch anchor {
    case .canvas(let x, let y, let size): try a.encode(Canvas(x: x, y: y, size: size), forKey: .canvas)
    case .card(let card, let x, let y, let size):
      try a.encode(OnCard(card: card, x: x, y: y, size: size), forKey: .card)
    case .line(let card, let segment, let line):
      try a.encode(Line(card: card, segment: segment, line: line), forKey: .line)
    }
  }
}

extension CodeSource: Codable {
  private enum Keys: String, CodingKey {
    case git, package, file
  }
  private struct Git: Codable {
    var repository: String?
    var commit: String
    var path: String
    var uncommitted: Bool
    var checkout: String?
  }
  private struct Package: Codable {
    var name: String
    var version: String
    var path: String
  }
  private struct File: Codable {
    var path: String
    var hash: String?
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    switch try theCase(of: c) {
    case .git:
      let g = try c.decode(Git.self, forKey: .git)
      self = .git(
        repository: g.repository, commit: g.commit, path: g.path, uncommitted: g.uncommitted, checkout: g.checkout)
    case .package:
      let p = try c.decode(Package.self, forKey: .package)
      self = .package(name: p.name, version: p.version, path: p.path)
    case .file:
      let f = try c.decode(File.self, forKey: .file)
      self = .file(path: f.path, hash: f.hash)
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: Keys.self)
    switch self {
    case .git(let repository, let commit, let path, let uncommitted, let checkout):
      try c.encode(
        Git(repository: repository, commit: commit, path: path, uncommitted: uncommitted, checkout: checkout),
        forKey: .git)
    case .package(let name, let version, let path):
      try c.encode(Package(name: name, version: version, path: path), forKey: .package)
    case .file(let path, let hash):
      try c.encode(File(path: path, hash: hash), forKey: .file)
    }
  }
}

extension ImageSource: Codable {
  private enum Keys: String, CodingKey {
    case file, url
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    switch try theCase(of: c) {
    case .file:
      let name = try c.decode(String.self, forKey: .file)
      guard Vault.isFileName(name) else {
        throw DecodingError.dataCorruptedError(forKey: .file, in: c, debugDescription: "\(name) is not a file name")
      }
      self = .file(name)
    case .url: self = .url(try c.decode(String.self, forKey: .url))
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: Keys.self)
    switch self {
    case .file(let name): try c.encode(name, forKey: .file)
    case .url(let url): try c.encode(url, forKey: .url)
    }
  }
}
