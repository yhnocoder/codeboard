import CodeBoardModel
import Foundation

// A resource's two kinds of file (FORMAT.md, Resources): resource.json in its package, entry.json in each entry's folder.
// Written and read as board.json is (BoardFile.swift: deterministic, strict, the same rules for growing), each file with
// its own version.

/// resource.json: what the list is, and the columns the user added
public struct Resource: Equatable, Sendable {
  public static let version = 1

  /// A column the user added; an entry's value for it is in its entry file
  public struct Field: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable {
      case text, number, date, checkbox, select, board
    }

    /// One of a select field's labels; an entry's value is its id, so renaming it changes no entry
    public struct Option: Codable, Equatable, Sendable {
      public var id: String
      public var name: String
      /// Absent: the colour of its place in the list
      public var color: Highlight.Color?

      public init(id: String, name: String, color: Highlight.Color? = nil) {
        self.id = id
        self.name = name
        self.color = color
      }
    }

    public var id: String
    public var name: String
    public var type: Kind
    /// A select field's labels in the user's order (always there, maybe empty); no other kind has them
    public var options: [Option]?

    public init(id: String, name: String, type: Kind, options: [Option]? = nil) {
      self.id = id
      self.name = name
      self.type = type
      self.options = options ?? (type == .select ? [] : nil)
    }
  }

  public var id: ResourceID
  public var preset: ResourcePreset
  public var fields: [Field]

  public init(id: ResourceID, preset: ResourcePreset, fields: [Field] = []) {
    self.id = id
    self.preset = preset
    self.fields = fields
  }
}

/// entry.json: one entry of a resource, known by its id wherever its folder is
public struct Entry: Equatable, Sendable {
  public static let version = 1

  /// Where it came from
  public enum Origin: Equatable, Sendable {
    /// Without a version: `1706.03762`
    case arxiv(String)
    case doi(String)
    case web(String)
  }

  /// Its value for one of the resource's fields; a date's is a `YYYY-MM-DD` string
  public enum Value: Equatable, Sendable {
    case text(String)
    case number(Double)
    case bool(Bool)
  }

  public var id: EntryID
  public var title: String
  /// When it was added (ms since 1970)
  public var added: Double
  public var origin: Origin?
  public var authors: [String]?
  public var year: Int?
  /// Where it was published (`NeurIPS 2017`), as its metadata says it
  public var venue: String?
  /// What a page saved as a link keeps, as a Web card keeps it
  public var meta: WebMeta?
  /// Its readable forms, each kept: none for an entry saved as a link alone
  public var versions: [Version]
  public var highlights: [Highlight]
  public var sidenotes: [EntrySidenote]
  /// By field id; one the resource does not define is kept
  public var fields: [String: Value]

  public init(
    id: EntryID, title: String, added: Double, origin: Origin? = nil, authors: [String]? = nil, year: Int? = nil,
    venue: String? = nil, meta: WebMeta? = nil, versions: [Version] = [], highlights: [Highlight] = [],
    sidenotes: [EntrySidenote] = [], fields: [String: Value] = [:]
  ) {
    self.id = id
    self.title = title
    self.added = added
    self.origin = origin
    self.authors = authors
    self.year = year
    self.venue = venue
    self.meta = meta
    self.versions = versions
    self.highlights = highlights
    self.sidenotes = sidenotes
    self.fields = fields
  }
}

/// One readable form of an entry: a paper's v1, its v2, a translation of either, one saving of a web page
public struct Version: Equatable, Sendable {
  public enum Content: Equatable, Sendable {
    /// A PDF in the entry's folder, the file there listing its blocks (without it, text by page only), and the TeX
    /// file there that the list's line numbers are of (only with a block list)
    case pdf(file: String, blocks: String? = nil, source: String? = nil)
    /// A web page saved whole outside the vault, by its content fingerprint, and its size; the file in the entry's
    /// folder listing its blocks as the reader cut them, once it was opened (so that a place in it can be named
    /// without loading the page)
    case page(hash: String, bytes: Int, blocks: String? = nil)
    /// Any other file in the entry's folder, opened as the system opens it; no places in it
    case file(String)
    /// A saved page translated block by block: the file in the entry's folder with each block's text in the
    /// version's `language`, by the ids of the blocks of the page version it is `of`
    case translation(file: String)
  }

  public var id: VersionID
  /// What its tab says (`v2`, `v2 中文`)
  public var label: String?
  public var added: Double
  /// BCP 47 (`zh`, `en`)
  public var language: String?
  /// The version this one translates: their blocks correspond by order
  public var of: VersionID?
  public var content: Content

  public init(
    id: VersionID, label: String? = nil, added: Double, language: String? = nil, of: VersionID? = nil,
    content: Content
  ) {
    self.id = id
    self.label = label
    self.added = added
    self.language = language
    self.of = of
    self.content = content
  }
}

public struct Highlight: Codable, Equatable, Sendable {
  public enum Color: String, Codable, Sendable {
    case yellow, green, blue, pink, purple
  }

  public var id: String
  /// Never a region of a page
  public var place: Place
  public var color: Color
  public var at: Double

  public init(id: String, place: Place, color: Color, at: Double) {
    self.id = id
    self.place = place
    self.color = color
    self.at = at
  }
}

/// An annotation: a board's text sidenote (its Markdown, whether it shows open, its question) on a place of the entry
public struct EntrySidenote: Equatable, Sendable {
  public var id: SidenoteID
  public var place: Place
  public var note: TextNote

  public init(id: SidenoteID, place: Place, note: TextNote) {
    self.id = id
    self.place = place
    self.note = note
  }
}

extension Resource {
  public func encoded() throws -> Data { try canonicalJSON(self) }

  public init(decoding data: Data, file: URL) throws {
    self = try strictDecode(Resource.self, from: data, file: file, version: Resource.version, format: "resource format")
    var ids = Set<String>()
    for f in fields {
      guard ids.insert(f.id).inserted else { throw VaultError.malformed(file, "field \(f.id) is there twice") }
      if let problem = f.problem() { throw VaultError.malformed(file, "field \(f.id): \(problem)") }
    }
  }
}

extension Resource.Field {
  /// Options where its kind does not have them, or one without its id or name, or with another's
  func problem() -> String? {
    guard let options else { return type == .select ? "a select field without its options" : nil }
    guard type == .select else { return "options on a \(type.rawValue) field" }
    var ids = Set<String>()
    var names = Set<String>()
    for o in options {
      guard !o.id.isEmpty, !o.name.isEmpty else { return "an option without its id or name" }
      guard ids.insert(o.id).inserted else { return "option \(o.id) is there twice" }
      guard names.insert(o.name).inserted else { return "option name \(o.name) is there twice" }
    }
    return nil
  }
}

extension Entry {
  public func encoded() throws -> Data { try canonicalJSON(self) }

  public init(decoding data: Data, file: URL) throws {
    self = try strictDecode(Entry.self, from: data, file: file, version: Entry.version, format: "entry format")
    if let problem = problem() { throw VaultError.malformed(file, problem) }
  }

  /// The first id twice or reference that does not hold, as a message
  func problem() -> String? {
    if meta?.fromResource == true { return "its page's picture is not a resource's" }
    var versionIDs = Set<VersionID>()
    for v in versions where !versionIDs.insert(v.id).inserted { return "version \(v.id.rawValue) is there twice" }
    for v in versions {
      if let of = v.of, of == v.id || !versionIDs.contains(of) {
        return "version \(v.id.rawValue): no other version \(of.rawValue) to translate"
      }
      if case .translation = v.content {
        let page = versions.first { $0.id == v.of }.map { if case .page = $0.content { true } else { false } }
        guard page == true else { return "version \(v.id.rawValue): a translation is of a saved page" }
        guard v.language != nil else { return "version \(v.id.rawValue): a translation without its language" }
      }
    }
    var ids = Set<String>()
    for h in highlights {
      guard ids.insert(h.id).inserted else { return "highlight \(h.id) is there twice" }
      guard versionIDs.contains(h.place.version) else {
        return "highlight \(h.id): no version \(h.place.version.rawValue)"
      }
      if case .page(_, _?) = h.place.block { return "highlight \(h.id): on a region of a page" }
    }
    var noteIDs = Set<SidenoteID>()
    for n in sidenotes {
      guard noteIDs.insert(n.id).inserted else { return "sidenote \(n.id.rawValue) is there twice" }
      guard versionIDs.contains(n.place.version) else {
        return "sidenote \(n.id.rawValue): no version \(n.place.version.rawValue)"
      }
    }
    return nil
  }
}

// MARK: Coding where the JSON shape is not the synthesized one

extension Resource: Codable {
  private enum Keys: String, CodingKey {
    case version, id, preset, fields
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    _ = try c.decode(Int.self, forKey: .version)
    self.init(
      id: try c.decode(ResourceID.self, forKey: .id), preset: try c.decode(ResourcePreset.self, forKey: .preset),
      fields: try c.decode([Field].self, forKey: .fields))
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: Keys.self)
    try c.encode(Resource.version, forKey: .version)
    try c.encode(id, forKey: .id)
    try c.encode(preset, forKey: .preset)
    try c.encode(fields, forKey: .fields)
  }
}

extension Entry: Codable {
  private enum Keys: String, CodingKey {
    case version, id, title, added, origin, authors, year, venue, meta, versions, highlights, sidenotes, fields
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    _ = try c.decode(Int.self, forKey: .version)
    self.init(
      id: try c.decode(EntryID.self, forKey: .id), title: try c.decode(String.self, forKey: .title),
      added: try c.decode(Double.self, forKey: .added), origin: try c.decodeIfPresent(Origin.self, forKey: .origin),
      authors: try c.decodeIfPresent([String].self, forKey: .authors),
      year: try c.decodeIfPresent(Int.self, forKey: .year), venue: try c.decodeIfPresent(String.self, forKey: .venue),
      meta: try c.decodeIfPresent(WebMeta.self, forKey: .meta),
      versions: try c.decode([Version].self, forKey: .versions),
      highlights: try c.decode([Highlight].self, forKey: .highlights),
      sidenotes: try c.decode([EntrySidenote].self, forKey: .sidenotes),
      fields: try c.decode([String: Value].self, forKey: .fields))
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: Keys.self)
    try c.encode(Entry.version, forKey: .version)
    try c.encode(id, forKey: .id)
    try c.encode(title, forKey: .title)
    try c.encode(added, forKey: .added)
    try c.encodeIfPresent(origin, forKey: .origin)
    try c.encodeIfPresent(authors, forKey: .authors)
    try c.encodeIfPresent(year, forKey: .year)
    try c.encodeIfPresent(venue, forKey: .venue)
    try c.encodeIfPresent(meta, forKey: .meta)
    try c.encode(versions, forKey: .versions)
    try c.encode(highlights, forKey: .highlights)
    try c.encode(sidenotes, forKey: .sidenotes)
    try c.encode(fields, forKey: .fields)
  }
}

extension Entry.Origin: Codable {
  private enum Keys: String, CodingKey {
    case arxiv, doi, web
  }
  private struct Arxiv: Codable {
    var id: String
  }
  private struct DOI: Codable {
    var doi: String
  }
  private struct Web: Codable {
    var url: String
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    switch try theCase(of: c) {
    case .arxiv:
      let id = try c.decode(Arxiv.self, forKey: .arxiv).id
      if id.contains(/v[0-9]+$/) {
        throw DecodingError.dataCorruptedError(
          forKey: .arxiv, in: c, debugDescription: "\(id): an id without a version")
      }
      self = .arxiv(id)
    case .doi: self = .doi(try c.decode(DOI.self, forKey: .doi).doi)
    case .web: self = .web(try c.decode(Web.self, forKey: .web).url)
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: Keys.self)
    switch self {
    case .arxiv(let id): try c.encode(Arxiv(id: id), forKey: .arxiv)
    case .doi(let doi): try c.encode(DOI(doi: doi), forKey: .doi)
    case .web(let url): try c.encode(Web(url: url), forKey: .web)
    }
  }
}

/// A bare JSON string, number or true / false
extension Entry.Value: Codable {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.singleValueContainer()
    if let b = try? c.decode(Bool.self) {
      self = .bool(b)
    } else if let n = try? c.decode(Double.self) {
      self = .number(n)
    } else {
      self = .text(try c.decode(String.self))
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .text(let s): try c.encode(s)
    case .number(let n): try c.encode(n)
    case .bool(let b): try c.encode(b)
    }
  }
}

extension Version: Codable {
  private enum Keys: String, CodingKey {
    case id, label, added, language, of, content
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    self.init(
      id: try c.decode(VersionID.self, forKey: .id), label: try c.decodeIfPresent(String.self, forKey: .label),
      added: try c.decode(Double.self, forKey: .added), language: try c.decodeIfPresent(String.self, forKey: .language),
      of: try c.decodeIfPresent(VersionID.self, forKey: .of), content: try c.decode(Content.self, forKey: .content))
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: Keys.self)
    try c.encode(id, forKey: .id)
    try c.encodeIfPresent(label, forKey: .label)
    try c.encode(added, forKey: .added)
    try c.encodeIfPresent(language, forKey: .language)
    try c.encodeIfPresent(of, forKey: .of)
    try c.encode(content, forKey: .content)
  }
}

extension Version.Content: Codable {
  private enum Keys: String, CodingKey {
    case pdf, page, file, translation
  }
  private struct PDF: Codable {
    var file: String
    var blocks: String?
    var source: String?
  }
  private struct Page: Codable {
    var hash: String
    var bytes: Int
    var blocks: String?
  }
  private struct File: Codable {
    var file: String
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    switch try theCase(of: c) {
    case .pdf:
      let p = try c.decode(PDF.self, forKey: .pdf)
      for name in [p.file] + [p.blocks, p.source].compactMap({ $0 }) where !Vault.isFileName(name) {
        throw DecodingError.dataCorruptedError(forKey: .pdf, in: c, debugDescription: "\(name) is not a file name")
      }
      if p.source != nil, p.blocks == nil {
        throw DecodingError.dataCorruptedError(forKey: .pdf, in: c, debugDescription: "a source without a block list")
      }
      self = .pdf(file: p.file, blocks: p.blocks, source: p.source)
    case .page:
      let p = try c.decode(Page.self, forKey: .page)
      if let name = p.blocks, !Vault.isFileName(name) {
        throw DecodingError.dataCorruptedError(forKey: .page, in: c, debugDescription: "\(name) is not a file name")
      }
      self = .page(hash: p.hash, bytes: p.bytes, blocks: p.blocks)
    case .file:
      let name = try c.decode(File.self, forKey: .file).file
      guard Vault.isFileName(name) else {
        throw DecodingError.dataCorruptedError(forKey: .file, in: c, debugDescription: "\(name) is not a file name")
      }
      self = .file(name)
    case .translation:
      let name = try c.decode(File.self, forKey: .translation).file
      guard Vault.isFileName(name) else {
        throw DecodingError.dataCorruptedError(
          forKey: .translation, in: c, debugDescription: "\(name) is not a file name")
      }
      self = .translation(file: name)
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: Keys.self)
    switch self {
    case .pdf(let file, let blocks, let source):
      try c.encode(PDF(file: file, blocks: blocks, source: source), forKey: .pdf)
    case .page(let hash, let bytes, let blocks):
      try c.encode(Page(hash: hash, bytes: bytes, blocks: blocks), forKey: .page)
    case .file(let name): try c.encode(File(file: name), forKey: .file)
    case .translation(let name): try c.encode(File(file: name), forKey: .translation)
    }
  }
}

/// Its id and place, then the text sidenote's own fields beside them in one object
extension EntrySidenote: Codable {
  private enum Keys: String, CodingKey {
    case id, place
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    self.init(
      id: try c.decode(SidenoteID.self, forKey: .id), place: try c.decode(Place.self, forKey: .place),
      note: try TextNote(from: decoder))
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: Keys.self)
    try c.encode(id, forKey: .id)
    try c.encode(place, forKey: .place)
    try note.encode(to: encoder)
  }
}
