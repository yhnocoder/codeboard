import CodeBoardModel
import Foundation

// A saved page's translation into one language, block by block, in the entry's folder beside entry.json as
// `<version id>.<language>.json`, listed in the entry as a Version of its own (`translation`, FORMAT.md). Written and
// read as entry.json is (deterministic, strict).

/// The translations of one saved page's blocks, by the ids its reader gives them; each kept with the hash of the text
/// it translates, so that a block whose text changed is translated again
public struct PageTranslations: Equatable, Sendable {
  public static let version = 1

  public struct Block: Codable, Equatable, Sendable {
    /// The reader's `textHash` of the block's text when it was translated
    public var hash: String
    public var text: String

    public init(hash: String, text: String) {
      self.hash = hash
      self.text = text
    }
  }

  /// The reader's block numbering the ids are in: another numbering's ids name other blocks
  public var scheme: Int
  public var blocks: [String: Block]

  public init(scheme: Int, blocks: [String: Block] = [:]) {
    self.scheme = scheme
    self.blocks = blocks
  }

  /// The file's name in the entry's folder
  public static func fileName(of version: VersionID, language: String) -> String {
    "\(version.rawValue).\(language).json"
  }
}

extension PageTranslations: Codable {
  private enum Keys: String, CodingKey {
    case version, scheme, blocks
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    _ = try c.decode(Int.self, forKey: .version)
    self.init(
      scheme: try c.decode(Int.self, forKey: .scheme), blocks: try c.decode([String: Block].self, forKey: .blocks))
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: Keys.self)
    try c.encode(PageTranslations.version, forKey: .version)
    try c.encode(scheme, forKey: .scheme)
    try c.encode(blocks, forKey: .blocks)
  }
}

extension Vault {
  /// The translations into `language` of `version` of the entry in the folder at `entry`; none when there is no file
  public func translations(of version: VersionID, language: String, in entry: String) throws -> PageTranslations? {
    let file = url(of: entry).appending(path: PageTranslations.fileName(of: version, language: language))
    guard FileManager.default.fileExists(atPath: file.path) else { return nil }
    let data: Data
    do {
      data = try Data(contentsOf: file)
    } catch {
      throw VaultError.unreadable(file, error.localizedDescription)
    }
    return try strictDecode(
      PageTranslations.self, from: data, file: file, version: PageTranslations.version, format: "translations format")
  }

  /// `translations` written all at once in the entry's folder at `entry`, over what was there, and listed in the
  /// entry (`listTranslations`); the entry when that added its Version
  @discardableResult
  public func write(
    _ translations: PageTranslations, of version: VersionID, language: String, in entry: String
  ) throws -> Entry? {
    let file = url(of: entry).appending(path: PageTranslations.fileName(of: version, language: language))
    do {
      try canonicalJSON(translations).write(to: file, options: .atomic)
    } catch {
      throw VaultError.unwritable(file, error.localizedDescription)
    }
    return try listTranslations(of: version, language: language, in: entry)
  }

  /// The Version naming the translations of the page version `version` into `language`, added to the entry at
  /// `entry` when it has none (one for each page version and language, found by `of` and `language`): labelled as the
  /// page version is (its id without a label), then the language, `v1 中文`. The entry when it was added
  @discardableResult
  public func listTranslations(of version: VersionID, language: String, in entry: String) throws -> Entry? {
    var e = try self.entry(at: entry)
    guard let page = e.versions.first(where: { $0.id == version }), case .page = page.content else {
      throw VaultError.unwritable(
        url(of: entry).appending(path: Vault.entryFileName), "no saved page \(version.rawValue) to translate")
    }
    let listed = e.versions.contains {
      guard case .translation = $0.content else { return false }
      return $0.of == version && $0.language == language
    }
    guard !listed else { return nil }
    var n = e.versions.count + 1
    while e.versions.contains(where: { $0.id.rawValue == "v\(n)" }) { n += 1 }
    let name = language == "zh" ? "中文" : language
    e.versions.append(
      Version(
        id: VersionID(rawValue: "v\(n)"), label: "\(page.label ?? page.id.rawValue) \(name)",
        added: (Date().timeIntervalSince1970 * 1000).rounded(), language: language, of: version,
        content: .translation(file: PageTranslations.fileName(of: version, language: language))))
    try write(e, at: entry)
    return e
  }
}
