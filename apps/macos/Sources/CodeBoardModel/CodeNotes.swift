import Foundation

// Highlights and sidenotes on a repository's code, shared by every card and board of the vault that shows those lines
// and by the reading pane's code tab (FORMAT.md, Code annotations): one file per repository in `.codeboard/code/`, read
// leniently (an entry that does not hold is dropped and said), written whole and atomically. Every read-modify-write of
// those files in the process takes `CodeFiles.lock`, so the app and an import running beside it never write over each
// other's entries.

/// Lines of a file of a repository at a commit (nil: the working tree as it was), with their text then
public struct CodePlace: Equatable, Hashable, Sendable {
  public var commit: String?
  public var lines: ClosedRange<Int>
  /// Exactly one string per line
  public var text: [String]

  public init(commit: String?, lines: ClosedRange<Int>, text: [String]) {
    self.commit = commit
    self.lines = lines
    self.text = text
  }

  /// The lines `r` of a segment, with its version; nil when they are not all in it
  public init?(_ s: Segment, _ r: ClosedRange<Int>) {
    guard r.lowerBound >= s.firstLine, r.upperBound <= s.lastLine else { return nil }
    var commit: String?
    if case .git(_, let c, _, false, _)? = s.source { commit = c }
    self.init(
      commit: commit, lines: r, text: Array(s.lines[(r.lowerBound - s.firstLine)...(r.upperBound - s.firstLine)]))
  }

  /// Shown on a segment: its lines are there, as they were
  public func isOn(_ s: Segment) -> Bool {
    lines.lowerBound >= s.firstLine && lines.upperBound <= s.lastLine
      && s.lines[(lines.lowerBound - s.firstLine)...(lines.upperBound - s.firstLine)].elementsEqual(text)
  }
}

public struct CodeHighlight: Codable, Equatable, Sendable {
  public var id: String
  public var place: CodePlace
  /// When it was made (ms since 1970)
  public var at: Double

  public init(id: String, place: CodePlace, at: Double) {
    self.id = id
    self.place = place
    self.at = at
  }
}

public struct CodeSidenote: Codable, Equatable, Sendable {
  public var id: SidenoteID
  public var place: CodePlace
  /// Markdown, [[refs]] included
  public var text: String
  public var alwaysShow: Bool
  public var question: Question?

  public init(id: SidenoteID, place: CodePlace, text: String, alwaysShow: Bool = false, question: Question? = nil) {
    self.id = id
    self.place = place
    self.text = text
    self.alwaysShow = alwaysShow
    self.question = question
  }

  /// What a text sidenote on its lines says
  public var note: TextNote { TextNote(text: text, alwaysShow: alwaysShow, question: question) }
}

/// One file's highlights and sidenotes
public struct CodeFileNotes: Codable, Equatable, Sendable {
  public var highlights: [CodeHighlight] = []
  public var sidenotes: [CodeSidenote] = []

  public init(highlights: [CodeHighlight] = [], sidenotes: [CodeSidenote] = []) {
    self.highlights = highlights
    self.sidenotes = sidenotes
  }

  public var isEmpty: Bool { highlights.isEmpty && sidenotes.isEmpty }
}

/// `.codeboard/code/<random id>.json`: a repository's annotations by file, its path from the repository's root
public struct RepositoryNotes: Equatable, Sendable {
  public static let version = 1

  /// The repository's key (`CodeNotes.key`): its normalized remote, or `root:<its first commit>`
  public var repository: String
  public var files: [String: CodeFileNotes]

  public init(repository: String, files: [String: CodeFileNotes] = [:]) {
    self.repository = repository
    self.files = files
  }

  public var isEmpty: Bool { files.values.allSatisfy(\.isEmpty) }

  func has(highlight id: String) -> Bool { files.values.contains { $0.highlights.contains { $0.id == id } } }
  func has(sidenote id: SidenoteID) -> Bool { files.values.contains { $0.sidenotes.contains { $0.id == id } } }

  /// Empty files left out
  func encoded() throws -> Data {
    var out = self
    out.files = files.filter { !$0.value.isEmpty }
    return try canonicalJSON(out)
  }

  /// Read leniently: an entry that does not hold (another shape, a text that is not one string per line, an id there
  /// before) is left out and said in `dropped`; a newer version or another shape at the top is thrown
  init(decoding data: Data, file: URL, dropped: inout [String]) throws {
    guard let raw = try? JSONSerialization.jsonObject(with: data), let o = raw as? [String: Any] else {
      throw VaultError.malformed(file, "not a JSON object")
    }
    guard let v = o["version"] as? Int else { throw VaultError.malformed(file, "no format version") }
    guard v <= Self.version else { throw VaultError.newerFormat(file, v, reads: Self.version) }
    guard v == Self.version else { throw VaultError.olderFormat(file, v) }
    guard let key = o["repository"] as? String, !key.isEmpty, let files = o["files"] as? [String: Any] else {
      throw VaultError.malformed(file, "a repository's key and its files")
    }
    self.init(repository: key)
    var hs = Set<String>()
    var ns = Set<SidenoteID>()
    func entries<T: Decodable>(_ any: Any?, _ what: String, _ path: String, unique: (T) -> Bool) -> [T] {
      (any as? [Any] ?? []).enumerated().compactMap { i, e in
        guard let d = try? JSONSerialization.data(withJSONObject: e),
          let t = try? JSONDecoder().decode(T.self, from: d),
          unique(t)
        else {
          dropped.append("\(file.lastPathComponent): files[\(path)].\(what)[\(i)] does not hold; left out")
          return nil
        }
        return t
      }
    }
    for (path, f) in files {
      let f = f as? [String: Any] ?? [:]
      let h: [CodeHighlight] = entries(f["highlights"], "highlights", path) { hs.insert($0.id).inserted }
      let n: [CodeSidenote] = entries(f["sidenotes"], "sidenotes", path) { ns.insert($0.id).inserted }
      if !h.isEmpty || !n.isEmpty { self.files[path] = CodeFileNotes(highlights: h, sidenotes: n) }
    }
  }

  /// `other` (a later file of the same key) taken in: an entry already here with the same content is one; another
  /// one under the id of one here comes under a new id made from `name` (its file) and its id; a highlight on the same
  /// lines with the same text as one here is one, the earlier kept
  mutating func take(_ other: RepositoryNotes, from name: String) {
    for (path, f) in other.files.sorted(by: { $0.key < $1.key }) {
      for var h in f.highlights {
        if let i = files[path]?.highlights.firstIndex(where: {
          $0.place.lines == h.place.lines && $0.place.text == h.place.text
        }) {
          if h.at < files[path]!.highlights[i].at { files[path]!.highlights[i].at = h.at }
          continue
        }
        if has(highlight: h.id) { h.id = "\(h.id)-\(codeHash(name + "\0" + h.id))" }
        files[path, default: CodeFileNotes()].highlights.append(h)
      }
      for var n in f.sidenotes {
        if files[path]?.sidenotes.contains(n) == true { continue }
        if has(sidenote: n.id) {
          n.id = SidenoteID(rawValue: "\(n.id.rawValue)-\(codeHash(name + "\0" + n.id.rawValue))")
        }
        files[path, default: CodeFileNotes()].sidenotes.append(n)
      }
    }
  }
}

/// FNV-1a 64 of the UTF-8, base 36: what deterministic ids are made of
func codeHash(_ s: String) -> String {
  var h: UInt64 = 0xcbf2_9ce4_8422_2325
  for b in s.utf8 { h = (h ^ UInt64(b)) &* 0x100_0000_01b3 }
  return String(h, radix: 36)
}

extension CodePlace: Codable {
  private enum Keys: String, CodingKey {
    case commit, lines, text
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    let lines = try c.decode(ClosedRange<Int>.self, forKey: .lines)
    let text = try c.decode([String].self, forKey: .text)
    guard lines.lowerBound >= 1, text.count == lines.count else {
      throw DecodingError.dataCorruptedError(
        forKey: .text, in: c, debugDescription: "\(text.count) lines of text for lines \(lines)")
    }
    self.init(commit: try c.decodeIfPresent(String.self, forKey: .commit), lines: lines, text: text)
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: Keys.self)
    try c.encodeIfPresent(commit, forKey: .commit)
    try c.encode(lines, forKey: .lines)
    try c.encode(text, forKey: .text)
  }
}

extension RepositoryNotes: Encodable {
  private enum Keys: String, CodingKey {
    case version, repository, files
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: Keys.self)
    try c.encode(Self.version, forKey: .version)
    try c.encode(repository, forKey: .repository)
    try c.encode(files, forKey: .files)
  }
}

/// The files of `.codeboard/code/`, read and written under one lock for the whole process
public enum CodeFiles {
  public static let folderName = "code"
  /// What a file taken into the one that sorts first (another of the same key) is renamed to, beside it
  public static let mergedSuffix = ".merged"
  static let lock = NSLock()

  public static func folder(_ vault: Vault) -> URL {
    vault.root.appending(path: Vault.appDataFolder).appending(path: folderName)
  }

  /// One file as read: its name, its bytes, what it holds (nil: a file this build does not write: a newer version, or
  /// one that is not a repository's)
  struct File {
    var name: String
    var data: Data
    var notes: RepositoryNotes?
    /// The key it is for, when even a file that cannot be read says it
    var key: String?
  }

  /// Every `*.json` of the folder by name, not hidden ones; what could not be read in `problems`
  static func read(_ folder: URL, problems: inout [String]) -> [File] {
    let names =
      ((try? FileManager.default.contentsOfDirectory(atPath: folder.path(percentEncoded: false))) ?? [])
      .filter { $0.hasSuffix(".json") && !$0.hasPrefix(".") }.sorted()
    return names.compactMap { name in
      let url = folder.appending(path: name)
      guard let data = try? Data(contentsOf: url) else { return nil }
      var dropped: [String] = []
      do {
        let n = try RepositoryNotes(decoding: data, file: url, dropped: &dropped)
        problems += dropped
        return File(name: name, data: data, notes: n, key: n.repository)
      } catch {
        problems.append("\(error)")
        let key = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["repository"] as? String
        return File(name: name, data: data, notes: nil, key: key)
      }
    }
  }

  /// A repository's annotations written: into `into` (a new random name when nil), atomically; with no entries the file
  /// is deleted (not put in the Trash). `aside`: other files of the key, renamed to `<name>.merged` beside it
  static func write(_ n: RepositoryNotes, into: String?, aside: [String], folder: URL) throws -> (String, Data?) {
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let name = into ?? "\(Board.newID("r")).json"
    let url = folder.appending(path: name)
    var data: Data?
    if n.isEmpty {
      if FileManager.default.fileExists(atPath: url.path(percentEncoded: false)) {
        try FileManager.default.removeItem(at: url)
      }
    } else {
      let d = try n.encoded()
      try d.write(to: url, options: .atomic)
      data = d
    }
    for other in aside where other != name {
      let from = folder.appending(path: other)
      var to = folder.appending(path: other + mergedSuffix)
      var k = 2
      while FileManager.default.fileExists(atPath: to.path(percentEncoded: false)) {
        to = folder.appending(path: "\(other)\(mergedSuffix)-\(k)")
        k += 1
      }
      try FileManager.default.moveItem(at: from, to: to)
    }
    return (name, data)
  }

  /// What an import brings, added to the vault's files: by key, each entry not there yet (as `RepositoryNotes.take`)
  static func add(_ adds: [String: RepositoryNotes], folder: URL) throws {
    lock.lock()
    defer { lock.unlock() }
    var problems: [String] = []
    let files = read(folder, problems: &problems)
    for (key, n) in adds.sorted(by: { $0.key < $1.key }) where !n.isEmpty {
      let mine = files.filter { $0.key == key }
      // one this build cannot write keeps the import's entries out rather than be written over
      guard !mine.contains(where: { $0.notes == nil }) else { continue }
      var merged = RepositoryNotes(repository: key)
      for f in mine { merged.take(f.notes!, from: f.name) }
      merged.take(n, from: "import")
      _ = try write(merged, into: mine.first?.name, aside: mine.dropFirst().map(\.name), folder: folder)
    }
  }
}
