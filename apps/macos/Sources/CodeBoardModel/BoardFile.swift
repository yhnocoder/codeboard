import Foundation

// Reading and writing board.json and shared card files. Writing is deterministic (sorted keys, pretty-printed, trailing
// newline) so git diffs stay small. Reading is strict: a file must be exactly what the writer would write for the value it
// decodes to (no unknown fields, no nulls, no left-out fields), and its references must hold.

public enum VaultError: Error, Equatable, CustomStringConvertible {
  case unreadable(URL, String)
  case malformed(URL, String)
  case unsupportedVersion(URL, Int)
  case duplicateBoardID(BoardID, [URL])
  case badSharedCardID(String)

  public var description: String {
    switch self {
    case .unreadable(let file, let why): "\(file.path): cannot be read: \(why)"
    case .malformed(let file, let why): "\(file.path): \(why)"
    case .unsupportedVersion(let file, let v):
      "\(file.path): format version \(v) is not \(Board.version), the one this app reads"
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
    var cardIDs = Set<CardID>()
    var codeCards: [CardID: CodeCard] = [:]
    for card in cards {
      guard cardIDs.insert(card.id).inserted else { return "card \(card.id.rawValue) is there twice" }
      if case .own(let content) = card.content {
        if let p = content.problem() { return "card \(card.id.rawValue): \(p)" }
        if case .code(let code) = content.body { codeCards[card.id] = code }
      }
    }
    var parents: [SectionID: SectionID?] = [:]
    for s in sections {
      guard parents.updateValue(s.parent, forKey: s.id) == nil else { return "section \(s.id.rawValue) is there twice" }
    }
    for s in sections {
      var seen: Set<SectionID> = [s.id]
      var at = s.parent
      while let p = at {
        guard let up = parents[p] else { return "section \(s.id.rawValue): no parent section \(p.rawValue)" }
        guard seen.insert(p).inserted else { return "section \(s.id.rawValue) is inside itself" }
        at = up
      }
    }
    for card in cards {
      if let s = card.section, parents[s] == nil { return "card \(card.id.rawValue): no section \(s.rawValue)" }
    }
    var arrowIDs = Set<ArrowID>()
    for a in arrows {
      guard arrowIDs.insert(a.id).inserted else { return "arrow \(a.id.rawValue) is there twice" }
      guard (1...3).contains(a.width) else { return "arrow \(a.id.rawValue): width \(a.width) is not 1, 2 or 3" }
      if let t = a.labelPosition, !(0...1).contains(t) { return "arrow \(a.id.rawValue): label position \(t)" }
      for end in [a.from, a.to] {
        guard cardIDs.contains(end.card) else { return "arrow \(a.id.rawValue): no card \(end.card.rawValue)" }
        if let seg = end.segment, let code = codeCards[end.card], !code.segments.contains(where: { $0.id == seg }) {
          return "arrow \(a.id.rawValue): card \(end.card.rawValue) has no segment \(seg.rawValue)"
        }
      }
    }
    return nil
  }
}

extension SharedCard {
  public func encoded() throws -> Data { try canonicalJSON(self) }

  public init(decoding data: Data, file: URL) throws {
    self = try strictDecode(SharedCard.self, from: data, file: file, version: SharedCard.version)
    if let problem = content.problem() { throw VaultError.malformed(file, problem) }
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
    case .note(let note):
      switch note.style {
      case .mark(_, _, let size?), .freeText(_, _, let size?):
        if !(10...240).contains(size) { return "font size \(size) is outside 10…240" }
      default: break
      }
      if case .freeText(let level, _, _) = note.style, !(0...3).contains(level) { return "free text level \(level)" }
    case .image(let image):
      if let f = image.stillFrame, f < 1 { return "still frame \(f)" }
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
  guard v == version else { throw VaultError.unsupportedVersion(file, v) }
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
  if let path = firstDifference(raw, again, at: "") {
    throw VaultError.malformed(
      file, "\(path.isEmpty ? "(root)" : path): not part of the format (unknown field or null)")
  }
  return value
}

private func pathText(_ path: [any CodingKey]) -> String {
  path.map { $0.intValue.map { "[\($0)]" } ?? ".\($0.stringValue)" }.joined().trimmingPrefix(".").description
}

/// The path of the first place where what was read differs from what the writer writes for it
private func firstDifference(_ a: Any, _ b: Any, at path: String) -> String? {
  if let x = a as? [String: Any], let y = b as? [String: Any] {
    for key in Set(x.keys).union(y.keys).sorted() {
      let here = path.isEmpty ? key : "\(path).\(key)"
      guard let xv = x[key], let yv = y[key] else { return here }
      if let d = firstDifference(xv, yv, at: here) { return d }
    }
    return nil
  }
  if let x = a as? [Any], let y = b as? [Any] {
    guard x.count == y.count else { return path }
    for (i, (xv, yv)) in zip(x, y).enumerated() {
      if let d = firstDifference(xv, yv, at: "\(path)[\(i)]") { return d }
    }
    return nil
  }
  return (a as? NSObject)?.isEqual(b) == true ? nil : path
}

// MARK: Coding where the JSON shape is not the synthesized one

/// An enum is one object with exactly one key, naming the case
private func theCase<K: CodingKey>(of c: KeyedDecodingContainer<K>) throws -> K {
  guard c.allKeys.count == 1, let key = c.allKeys.first else {
    throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "expected exactly one kind"))
  }
  return key
}

private struct Empty: Codable {}

extension Board: Codable {
  private enum Keys: String, CodingKey {
    case version, id, cards, arrows, sections, hideComments, hideLineNumbers
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    _ = try c.decode(Int.self, forKey: .version)
    self.init(
      id: try c.decode(BoardID.self, forKey: .id), cards: try c.decode([Card].self, forKey: .cards),
      arrows: try c.decode([Arrow].self, forKey: .arrows), sections: try c.decode([Section].self, forKey: .sections),
      hideComments: try c.decode(Bool.self, forKey: .hideComments),
      hideLineNumbers: try c.decode(Bool.self, forKey: .hideLineNumbers))
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: Keys.self)
    try c.encode(Board.version, forKey: .version)
    try c.encode(id, forKey: .id)
    try c.encode(cards, forKey: .cards)
    try c.encode(arrows, forKey: .arrows)
    try c.encode(sections, forKey: .sections)
    try c.encode(hideComments, forKey: .hideComments)
    try c.encode(hideLineNumbers, forKey: .hideLineNumbers)
  }
}

extension SharedCard: Codable {
  private enum Keys: String, CodingKey {
    case version, id, content
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    _ = try c.decode(Int.self, forKey: .version)
    self.init(id: try c.decode(CardID.self, forKey: .id), content: try c.decode(CardContent.self, forKey: .content))
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: Keys.self)
    try c.encode(SharedCard.version, forKey: .version)
    try c.encode(id, forKey: .id)
    try c.encode(content, forKey: .content)
  }
}

extension Card: Codable {
  private enum Keys: String, CodingKey {
    case id, x, y, width, height, section, locked, tilted, content, shared
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
      section: try c.decodeIfPresent(SectionID.self, forKey: .section),
      locked: try c.decode(Bool.self, forKey: .locked),
      tilted: try c.decode(Bool.self, forKey: .tilted), content: content)
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: Keys.self)
    try c.encode(id, forKey: .id)
    try c.encode(x, forKey: .x)
    try c.encode(y, forKey: .y)
    try c.encode(width, forKey: .width)
    try c.encodeIfPresent(height, forKey: .height)
    try c.encodeIfPresent(section, forKey: .section)
    try c.encode(locked, forKey: .locked)
    try c.encode(tilted, forKey: .tilted)
    switch content {
    case .own(let own): try c.encode(own, forKey: .content)
    case .shared: try c.encode(true, forKey: .shared)
    }
  }
}

extension CardContent: Codable {
  private enum Keys: String, CodingKey {
    case title, description, processes, code, note, image
  }
  private enum Kind: String, CodingKey {
    case code, note, image
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    let body: Body =
      switch try theCase(of: decoder.container(keyedBy: Kind.self)) {
      case .code: .code(try c.decode(CodeCard.self, forKey: .code))
      case .note: .note(try c.decode(Note.self, forKey: .note))
      case .image: .image(try c.decode(ImageCard.self, forKey: .image))
      }
    self.init(
      title: try c.decodeIfPresent(String.self, forKey: .title),
      description: try c.decodeIfPresent(String.self, forKey: .description),
      processes: try c.decode([ProcessTag].self, forKey: .processes), body: body)
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: Keys.self)
    try c.encodeIfPresent(title, forKey: .title)
    try c.encodeIfPresent(description, forKey: .description)
    try c.encode(processes, forKey: .processes)
    switch body {
    case .code(let code): try c.encode(code, forKey: .code)
    case .note(let note): try c.encode(note, forKey: .note)
    case .image(let image): try c.encode(image, forKey: .image)
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

extension NoteStyle: Codable {
  private enum Keys: String, CodingKey {
    case note, text, box, mark, freeText
  }
  private struct Text: Codable {
    var size: TextSize
    var bold: Bool
  }
  private struct Box: Codable {
    var fill: BoxFill
  }
  private struct Mark: Codable {
    var color: HandColor
    var weight: HandWeight
    var fontSize: Double?
  }
  private struct FreeText: Codable {
    var level: Int
    var bold: Bool
    var fontSize: Double?
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    switch try theCase(of: c) {
    case .note:
      _ = try c.decode(Empty.self, forKey: .note)
      self = .note
    case .text:
      let t = try c.decode(Text.self, forKey: .text)
      self = .text(size: t.size, bold: t.bold)
    case .box:
      self = .box(fill: try c.decode(Box.self, forKey: .box).fill)
    case .mark:
      let m = try c.decode(Mark.self, forKey: .mark)
      self = .mark(color: m.color, weight: m.weight, fontSize: m.fontSize)
    case .freeText:
      let f = try c.decode(FreeText.self, forKey: .freeText)
      self = .freeText(level: f.level, bold: f.bold, fontSize: f.fontSize)
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: Keys.self)
    switch self {
    case .note: try c.encode(Empty(), forKey: .note)
    case .text(let size, let bold): try c.encode(Text(size: size, bold: bold), forKey: .text)
    case .box(let fill): try c.encode(Box(fill: fill), forKey: .box)
    case .mark(let color, let weight, let fontSize):
      try c.encode(Mark(color: color, weight: weight, fontSize: fontSize), forKey: .mark)
    case .freeText(let level, let bold, let fontSize):
      try c.encode(FreeText(level: level, bold: bold, fontSize: fontSize), forKey: .freeText)
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
