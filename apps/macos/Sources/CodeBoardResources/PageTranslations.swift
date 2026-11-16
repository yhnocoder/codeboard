import CodeBoardModel
import Foundation

// A saved page's translation into one language, block by block, in the entry's folder beside entry.json as
// `<version id>.<language>.json`. FORMAT.md has no Version content for it yet, so no Version names the file: it is
// found by its name alone. Written and read as entry.json is (deterministic, strict).

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

  /// `translations` written all at once in the entry's folder at `entry`, over what was there
  public func write(
    _ translations: PageTranslations, of version: VersionID, language: String, in entry: String
  ) throws {
    let file = url(of: entry).appending(path: PageTranslations.fileName(of: version, language: language))
    do {
      try canonicalJSON(translations).write(to: file, options: .atomic)
    } catch {
      throw VaultError.unwritable(file, error.localizedDescription)
    }
  }
}
