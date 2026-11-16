import CodeBoardModel
import Foundation

// A saved page's blocks as the reader cut them, in the entry's folder beside entry.json as `<version id>.blocks.json`,
// named by the page version's `blocks` (FORMAT.md), so that a place in the page is named without loading it. Written
// once, as entry.json is (deterministic, all at once), and read strictly: the file must be exactly what is written.

/// One block of a saved page, as the reader gives it
public struct PageBlock: Codable, Equatable, Sendable {
  public var id: String
  public var kind: String
  /// A heading's level
  public var level: Int?
  /// The reader's `textHash` of `text`
  public var hash: String
  public var text: String

  public init(id: String, kind: String, level: Int? = nil, hash: String, text: String) {
    self.id = id
    self.kind = kind
    self.level = level
    self.hash = hash
    self.text = text
  }

  /// The file's name in the entry's folder
  public static func fileName(of version: VersionID) -> String { "\(version.rawValue).blocks.json" }
}

extension Vault {
  /// The blocks in the file `name` of the entry in the folder at `entry`, in the page's order
  public func pageBlocks(_ name: String, in entry: String) throws -> [PageBlock] {
    let file = url(of: entry).appending(path: name)
    guard Vault.isFileName(name) else { throw VaultError.malformed(file, "not a file name") }
    let data: Data
    do {
      data = try Data(contentsOf: file)
    } catch {
      throw VaultError.unreadable(file, error.localizedDescription)
    }
    let blocks: [PageBlock]
    do {
      blocks = try JSONDecoder().decode([PageBlock].self, from: data)
    } catch let DecodingError.keyNotFound(key, c) {
      throw VaultError.malformed(file, "\(Self.path(c.codingPath + [key])): missing")
    } catch let DecodingError.typeMismatch(_, c), let DecodingError.valueNotFound(_, c),
      let DecodingError.dataCorrupted(c)
    {
      throw VaultError.malformed(file, "\(Self.path(c.codingPath)): \(c.debugDescription)")
    }
    let written = try canonicalJSON(blocks)
    guard written == data else {
      // an unknown field, a null or another layout: named by the first block that is not as written
      let read = (try? JSONSerialization.jsonObject(with: data)) as? [NSDictionary] ?? []
      let again = (try JSONSerialization.jsonObject(with: written)) as? [NSDictionary] ?? []
      let at = read.indices.first { $0 < again.count && read[$0] != again[$0] }.map { "[\($0)]" } ?? "(root)"
      throw VaultError.malformed(file, "\(at): not as CodeBoard writes it")
    }
    return blocks
  }

  private static func path(_ keys: [any CodingKey]) -> String {
    keys.map { $0.intValue.map { "[\($0)]" } ?? ".\($0.stringValue)" }.joined().trimmingPrefix(".").description
  }

  /// `blocks` written for the page version `version` of the entry in the folder at `entry` and named in it, once: a
  /// version naming a file already, or one that is not a saved page, is left as it is and nothing is written. The
  /// entry when it was written
  @discardableResult
  public func writePageBlocks(_ blocks: [PageBlock], of version: VersionID, in entry: String) throws -> Entry? {
    var e = try self.entry(at: entry)
    guard let i = e.versions.firstIndex(where: { $0.id == version }),
      case .page(let hash, let bytes, nil) = e.versions[i].content
    else { return nil }
    let name = PageBlock.fileName(of: version)
    let file = url(of: entry).appending(path: name)
    do {
      try canonicalJSON(blocks).write(to: file, options: .atomic)
    } catch {
      throw VaultError.unwritable(file, error.localizedDescription)
    }
    e.versions[i].content = .page(hash: hash, bytes: bytes, blocks: name)
    try write(e, at: entry)
    return e
  }
}
